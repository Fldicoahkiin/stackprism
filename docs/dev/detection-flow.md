# 检测流程

## 三条数据源管道

StackPrism 同时跑三条管道并把结果合并：

```text
┌──────────────────────────────────────────────────────────┐
│ 管道 A：响应头 (chrome.webRequest)                        │
│   - background webRequest.onHeadersReceived              │
│   - 主文档 / API / iframe 的 server / x-powered-by 等    │
│   - 写入 chrome.storage.session 的 tab:{id}.main /       │
│     tab:{id}.apis[] / tab:{id}.frames[]                  │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ 管道 B：页面主动检测 (chrome.scripting + injected)        │
│   - 用户点弹窗刷新按钮触发 START_BACKGROUND_DETECTION    │
│   - bg 调 scripting.executeScript 注入 page-detector     │
│   - page-detector 在页面 MAIN world 跑完返回结果         │
│   - 结果写入 tab:{id}.page                              │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ 管道 C：动态采集 (content script + MutationObserver)      │
│   - bg 在页面 load 时注入 content-observer.ts            │
│   - MutationObserver / PerformanceObserver 持续累积      │
│   - 800ms 节流后 sendMessage DYNAMIC_PAGE_SNAPSHOT       │
│   - bg 防抖 800ms 后跑 detectFromDynamicSnapshot         │
│   - 结果写入 tab:{id}.dynamic                           │
└──────────────────────────────────────────────────────────┘
```

三个 tab key 都存在 `chrome.storage.session`，service worker 重启后从 storage 恢复状态，不依赖 SW 内存。

## 数据流：从触发到弹窗显示

```text
用户点击扩展图标
  ↓
弹窗 mount
  ↓
loadCachedDetection()
  ↓
chrome.runtime.sendMessage({ type: 'GET_POPUP_RESULT', tabId })
  ↓
bg.message-router 路由到 getPopupResultResponse(tabId)
  ↓
检查 chrome.storage.session 里是否有 popup:{tabId} 缓存
  ├─ 命中且 settingsKey 一致 → 直接返还
  └─ 未命中 → 现场跑 buildPopupCacheRecord:
       1. 从 tab:{id} 读 page / main / apis / frames / dynamic
       2. addStoredCustomHeaderRules（应用用户自定义响应头规则）
       3. buildDisplayTechnologies：
          - 把 5 路结果合并到一个数组
          - mergeDisplayTechnologyRecords 去重 + sources Set 收集
          - filterTechnologiesBySettings（按设置页过滤）
       4. mergeResourceSummary（合并资源统计）
       5. cleanPopupTechnology + 排序输出
       6. 写入 popup:{tabId} 缓存
  ↓
bg 返回 PopupResult
  ↓
弹窗 setState.result，展示

注意：后续 background 还会持续接收 webRequest 响应头、动态快照等增量更新，
每次更新都重新写 popup:{tabId} 缓存
  ↓
chrome.storage.onChanged 触发 popup 端 onStorageChange
  ↓
比对 popupCacheSignature 多字段签名，确认有真实变化才替换 state.result
```

## 主动检测时机

弹窗里点「刷新」会触发 `START_BACKGROUND_DETECTION` 消息：

```ts
// background/detection.ts
const runActivePageDetection = async tabId => {
  const pageRules = await buildEffectivePageRules()

  // 1. 把规则写到页面临时全局
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: rules => {
      window.__SP_RULES__ = rules
    },
    args: [pageRules]
  })

  // 2. 注入 IIFE，IIFE 内部 return 结果
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['injected/page-detector.iife.js']
  })

  // 3. 存到 tab:{id}.page，触发 saveTabDataAndBadge 重建 popup 缓存
  data.page = cleanPageDetectionRecord(result)
  await saveTabDataAndBadge(tabId, data)
}
```

## 动态采集节流

content-observer 端：

- 每次 MutationObserver / PerformanceObserver 触发，把变化累加到 state
- `scheduleSend()` 设置 900ms 定时，定时到了发 `DYNAMIC_PAGE_SNAPSHOT`
- 中途如果还有变化继续累积，定时器重置——总之每 ~900ms 最多发一次

background 端 `dynamic-snapshot.ts`：

- 收到消息后 800ms 防抖
- 防抖到点跑 `detectFromDynamicSnapshot(snapshot, pageRules)`
- 写入 `tab:{id}.dynamic`，再走 `saveTabDataAndBadge`

## 规则匹配层（rule-matcher.ts）

每条 rule 在三个层面被使用：

```text
detectFromXxx(snapshot, rules)
  scanner.scan(lowerText)                       ─ 所有规则的 hint 建一个索引，文本只扫一遍
  for (const rule of rules):
    1. passesResourceHintLookup(rule, lookup)   ─ 业务侧 resourceHints 门槛
    2. passesHintLookup(rule, lookup)           ─ 必需字面量预筛（只跳过不可能命中的规则）
       passesLegacyHintLookup(rule, lookup)     ─ 旧版门槛（__legacyHints，保证结果不变）
    3. matchesCompiledRulePatterns(rule, text)  ─ 跑实际正则 / keyword 合并正则
       ├─ keyword 走 getCompiledCombinedPattern：缓存的合并正则一次匹配
       └─ regex 走 getCompiledRulePatterns.some：缓存的 RegExp[] 逐个 test
    4. 命中：add(category, name, confidence, evidence)
```

WeakMap 缓存使每条 rule 的正则 + hints 编译只跑一次；hint 索引按规则列表缓存，规则不变就复用。

## badge 数字

每次 `saveTabDataAndBadge` 写完 popup 缓存后会取 `popupResult.counts.high`（高置信度技术数），调用 `chrome.action.setBadgeText` 显示在扩展图标上。打开弹窗看到的数字 ≈ badge 数字。

## 设置变更如何让缓存失效

`buildSettingsCacheKey(settings)` 把 settings 关键字段（disabledCategories / disabledTechnologies / customRules）序列化成一个 string。`getCachedPopupResult(popup, settings)` 命中条件之一就是 `popup.settingsKey === buildSettingsCacheKey(settings)`。

设置一变，settingsKey 变，老缓存自动失效，下次 `GET_POPUP_RESULT` 会现场重新构建。

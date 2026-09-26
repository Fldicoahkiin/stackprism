# 规则文件格式

`public/rules/` 下的 JSON 文件按识别方向拆分。`public/rules/index.json` 是清单，列出了构建和运行时需要加载的规则文件。

## 顶层结构

每个规则 JSON 大致长这样（节选）：

```json
{
  "page": {
    "frontendFrameworks": {
      "defaults": { "category": "前端框架" },
      "rules": [
        {
          "defaults": { "confidence": "高" },
          "rules": [
            {
              "name": "React",
              "patterns": ["react(?:\\.production|\\.development)?(?:\\.min)?\\.js"],
              "globals": ["React"]
            },
            {
              "name": "Vue",
              "patterns": ["vue(?:\\.runtime)?(?:\\.global)?(?:\\.prod)?(?:\\.min)?\\.js"],
              "globals": ["Vue"],
              "selectors": ["[data-v-app]"]
            }
          ]
        }
      ]
    }
  }
}
```

- 顶层 key（如 `page` / `headers`）对应 background 各检测模块按名拉取
- 二级 key（如 `frontendFrameworks` / `cdnProviders`）也是按名读取
- 里面 `{ defaults, rules }` 这种对象表示一个**规则组**（rule group）
- group 嵌套 group，最里层是「叶规则」（leaf rule，不再有 `rules` 字段）

## 规则组的 defaults 继承

`defaults`（也可写 `$defaults`，两者等价）会下沉到该组所有 leaf rule。多层嵌套时，外层的会被内层 override。最终展开时，每条 leaf rule 拿到 `{ ...outerDefaults, ...innerDefaults, ...leafFields }` 的合并结果。

例子：

```json
{
  "defaults": { "category": "前端框架" },
  "rules": [
    {
      "defaults": { "confidence": "高" },
      "rules": [{ "name": "React", "patterns": ["react.js"] }]
    }
  ]
}
```

展开后 React 规则等价于：

```json
{
  "category": "前端框架",
  "confidence": "高",
  "name": "React",
  "patterns": ["react.js"]
}
```

## 叶规则字段

| 字段                    | 类型                     | 说明                                                                                                             |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`                  | string                   | 弹窗显示名                                                                                                       |
| `category`              | string                   | 分类，会被 `CATEGORY_ORDER` 排序                                                                                 |
| `kind`                  | string                   | 类型说明，可空。会显示在 evidence 前缀                                                                           |
| `confidence`            | `"高"` / `"中"` / `"低"` | 默认 `"中"`                                                                                                      |
| `matchType`             | `"keyword"` / `"regex"`  | 默认 `"regex"`（直接 `new RegExp(p, 'i')`）                                                                      |
| `patterns`              | string[]                 | 匹配规则。keyword 类型走 `escapeRegExp + RegExp`                                                                 |
| `selectors`             | string[]                 | CSS 选择器，命中即高置信度                                                                                       |
| `globals`               | string[]                 | 全局变量名（支持点分隔嵌套），命中即高置信度                                                                     |
| `classNames`            | string[]                 | 命中 DOM 上某个 class（精确匹配）即高置信度                                                                      |
| `classPrefixes`         | string[]                 | 命中 DOM 上某个 class 以此为前缀即高置信度                                                                       |
| `cssVariables`          | string[]                 | 页面 CSS 自定义属性命中其中 N 个则触发，配合 `minCssVariableMatches`                                             |
| `minCssVariableMatches` | number                   | 默认 1                                                                                                           |
| `matchIn`               | string[]                 | 限制 patterns 在哪些数据源匹配，可选 `url` / `resources` / `html` / `headers` / `dynamic`。空数组 / 缺省视为全部 |
| `resourceOnly`          | boolean                  | 只走资源 URL 匹配，跳过 DOM / globals / selectors                                                                |
| `resourceHints`         | string[]                 | 业务侧手动指定的预过滤指纹。命中文本里有 hint 才会进 patterns 全量匹配                                           |
| `evidence`              | string                   | 命中时的固定 evidence 文案，覆盖默认的「资源 URL 匹配 / DOM 匹配」                                               |
| `url`                   | string                   | 技术官网或仓库 URL                                                                                               |

## 自动注入字段（buildtime）

build 阶段 `vite.config.ts` 里的 `precompileRulesPlugin` 给每条 leaf rule 注入：

| 字段                | 来自                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `__hints`           | 正则的必需字面量集合（`src/utils/rule-hints.ts`）：pattern 能命中的文本一定含其中一个，只用来跳过不可能命中的规则，不改变结果 |
| `__legacyHints`     | 1.3.79 及以前的预筛门槛（最长的 3 段字面量），只写给比 `__hints` 更严、且没有 `resourceHints` 的规则，保证识别结果不变        |
| `__keywordCombined` | matchType 为 keyword 时把所有 patterns escape 后用 `\|` 拼成的合并正则源码                                                    |

规则文件里手写的 `__hints` 会被当作这条规则的旧门槛。运行时 `getRuleAutoHints(rule)` 与 `getCompiledCombinedPattern(rule)` 优先读这些字段，缺失才回退到运行时计算（自定义规则只算必需字面量，没有旧门槛）。

## 规则文件清单

`rules/index.json`：

```json
{
  "schemaVersion": 1,
  "files": [
    "page/feeds.json",
    "page/frontend-frameworks.json",
    "page/ui-frameworks.json",
    "page/build-runtime.json",
    "page/frontend-extra.json",
    "page/frontend-local-libraries.json",
    "page/frontend-cdn-libraries.json",
    "page/frontend-package-cdn-libraries.json",
    "page/frontend-regional-cdn-libraries.json",
    "page/wordpress-themes.json",
    "page/drupal-themes.json",
    "page/wordpress-plugins.json",
    "page/drupal-modules.json",
    "...",
    "headers/server-products.json",
    "headers/header-patterns.json",
    "headers/cdn-providers.json"
  ]
}
```

`page/*.json` 服务于页面检测路径（page-detector + dynamic-snapshot 用），`headers/*.json` 服务于响应头检测路径（headers.ts 用）。两个路径独立，但 leaf rule 的字段格式完全一致。

## 加载流程

`src/background/rule-loader.ts`：

1. fetch `rules/index.json`
2. 并行 fetch `files[]` 里所有 JSON
3. 每份 JSON 走 `normalizeRuleValue` 递归展开 group
4. `mergeRulePartial` 把每份的所有 key 合并到一个大对象
5. 返回 `RuleConfig`，供各 detection 模块按 key 取数组

## 在哪改

- 改一个具体技术的识别规则：找对应分类的 JSON 文件直接编辑
- 加新分类：在 `rules/index.json` 加文件，并确保 background 对应模块按 key 读取（`detector-settings.ts` 的 `loadTechRules`）
- 大批量批改：写脚本生成 JSON，覆盖原文件

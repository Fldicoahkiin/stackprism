// 页面检测只注入可能命中的规则：带 resourceHints 的规则先按页面资源 URL 预筛，其余规则原样保留。
// 探测不到资源时不裁剪，与 page-detector 在资源为空时退回整页文本判断的逻辑保持一致。

type PageRules = Record<string, unknown>

// 只在 Service Worker 里使用的规则分组，不需要注入页面
const SERVICE_WORKER_ONLY_KEYS = new Set(['bundleLicenseLibraries', 'dynamicTechnologies'])
const resourceHintCache = new WeakMap<object, string[]>()

const lowerResourceHints = (rule: any): string[] =>
  Array.isArray(rule?.resourceHints) ? rule.resourceHints.map((hint: unknown) => String(hint || '').toLowerCase()) : []

export const collectResourceHints = (pageRules: PageRules): string[] => {
  const cached = resourceHintCache.get(pageRules)
  if (cached) return cached
  const hints = new Set<string>()
  for (const [key, list] of Object.entries(pageRules || {})) {
    if (SERVICE_WORKER_ONLY_KEYS.has(key) || !Array.isArray(list)) continue
    for (const rule of list) {
      for (const hint of lowerResourceHints(rule)) hints.add(hint)
    }
  }
  const result = [...hints]
  resourceHintCache.set(pageRules, result)
  return result
}

export const selectPageDetectorRules = (pageRules: PageRules, hintHits: string[] | null): PageRules => {
  const hits = hintHits ? new Set(hintHits) : null
  const selected: PageRules = {}
  for (const [key, value] of Object.entries(pageRules || {})) {
    if (SERVICE_WORKER_ONLY_KEYS.has(key)) continue
    if (!hits || key === 'customRules' || !Array.isArray(value)) {
      selected[key] = value
      continue
    }
    selected[key] = value.filter(rule => {
      const hints = lowerResourceHints(rule)
      return !hints.length || hints.some(hint => hits.has(hint))
    })
  }
  return selected
}

// 注入页面执行（必须自包含）：资源收集方式与 page-detector 的 collectResources 一致，返回出现过的 hint；没有资源时返回 null
export const probeResourceHintHits = (hints: string[]): string[] | null => {
  const inspectable = (value: unknown) => {
    const url = String(value || '').trim()
    return Boolean(url) && !/^(?:data|blob|javascript|about):/i.test(url)
  }
  const scripts = [...document.scripts].map(script => script.src).filter(inspectable)
  const stylesheets = [...document.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'], link[as='style']")]
    .map(link => link.href)
    .filter(inspectable)
  const resourceTiming = performance
    .getEntriesByType('resource')
    .map(entry => entry.name)
    .filter(inspectable)
  const images = [...document.images]
    .map(image => image.currentSrc || image.src)
    .filter(inspectable)
    .slice(0, 200)
  const text = [...new Set([...scripts, ...stylesheets, ...resourceTiming, ...images])].join('\n').toLowerCase()
  if (!text) return null
  return hints.filter(hint => text.includes(hint))
}

export const probePageResourceHints = async (tabId: number, hints: string[]): Promise<string[] | null> => {
  if (!hints.length) return null
  try {
    const [probe] = await chrome.scripting.executeScript({ target: { tabId }, func: probeResourceHintHits, args: [hints] })
    return Array.isArray(probe?.result) ? probe.result : null
  } catch {
    return null
  }
}

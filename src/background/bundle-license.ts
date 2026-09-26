import { buildPopupCacheRecord } from './popup-cache'
import { buildEffectivePageRules, loadDetectorSettings, loadTechRules } from './detector-settings'
import { mergeTechnologyRecords, shortHeaderUrl } from './merge'
import { getTabData, getTabSnapshot, updateBadgeForTab, writeTabData } from './tab-store'
import {
  createRuleListsScannerCache,
  extractVersionFromBundleText,
  matchesCompiledRulePatterns,
  passesHintLookup,
  passesResourceHintLookup
} from './rule-matcher'
import { withTabWriteLock } from './tab-write-lock'
import { isDetectablePageUrl } from '@/utils/page-support'
import { cleanTechnologyUrl } from '@/utils/url'

const BUNDLE_LICENSE_SCHEMA_VERSION = 7
const BUNDLE_LICENSE_SOURCE = 'JS 版权注释'
const MAX_CANDIDATE_SCRIPTS = 5
const MAX_FETCH_BYTES = 384 * 1024
const MAX_RANGE_SAMPLE_BYTES = 160 * 1024
// 5 个候选 × 384KB head = 1.92MB,再加 index 类大文件的 range 采样,budget 设到 4MB 才够
const MAX_TOTAL_SAMPLE_BYTES = 4 * 1024 * 1024
const MIN_SAMPLE_BYTES = 24 * 1024
// 减到 3:对 OAuth URL / 内嵌 license 来说,首段 384KB 加 3 个尾段采样足够,留预算给其他候选
const MAX_RANGE_SAMPLES_PER_SCRIPT = 3
const MAX_RANGE_SAMPLES_PER_SCAN = 8
const MAX_SIDECAR_BYTES = 160 * 1024
const MAX_LICENSE_TEXT_CHARS = 180_000
const FETCH_TIMEOUT_MS = 6000
const MAX_SCAN_MS = 12000
const SCAN_DELAY_MS = 600
const RANGE_SAMPLE_RATIOS = [0.25, 0.5, 1] as const

const bundleLicenseTimers = new Map<number, ReturnType<typeof setTimeout>>()

type ScriptCandidate = {
  url: string
  score: number
}

type ScriptLicenseObservation = {
  url: string
  commentCount: number
  text: string
  sidecarUrl?: string
  // JS 包体里嵌入的 OAuth / SSO / 登录端点 URL：SPA 把这种 URL 写在 bundle 里，
  // HTML / 资源列表 / 响应头里看不到，需要单独走第三方登录规则匹配
  embeddedAuthUrls?: string[]
  // 实际拉到的字节数：用来在 popup 原始线索里诊断脚本是否真的被 fetch 到了
  sourceLength?: number
}

type RangeFetchResult = {
  rangeSupported: boolean
  text: string
  totalBytes?: number
}

type ScanBudget = {
  deadline: number
  remainingBytes: number
  remainingRangeSamples: number
}

const unique = (items: string[]) => [...new Set(items.filter(Boolean))]

const createScanBudget = (): ScanBudget => ({
  deadline: Date.now() + MAX_SCAN_MS,
  remainingBytes: MAX_TOTAL_SAMPLE_BYTES,
  remainingRangeSamples: MAX_RANGE_SAMPLES_PER_SCAN
})

const hasScanBudget = (budget: ScanBudget): boolean => budget.remainingBytes >= MIN_SAMPLE_BYTES && Date.now() < budget.deadline

const claimFetchBytes = (budget: ScanBudget, maxBytes: number): number => {
  if (!hasScanBudget(budget)) return 0
  const bytes = Math.min(Math.max(1, Math.floor(maxBytes)), budget.remainingBytes)
  if (bytes < MIN_SAMPLE_BYTES) return 0
  budget.remainingBytes -= bytes
  return bytes
}

const remainingTimeoutMs = (budget: ScanBudget): number => Math.max(1, Math.min(FETCH_TIMEOUT_MS, budget.deadline - Date.now()))

const yieldToEventLoop = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

const toAbsoluteHttpUrl = (value: unknown, baseUrl: string): string => {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text, baseUrl)
    return /^https?:$/i.test(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

const isScriptAsset = (url: URL): boolean => {
  const path = url.pathname.toLowerCase()
  if (path.endsWith('.map')) return false
  return /\.(?:mjs|js)$/i.test(path)
}

const scoreScriptCandidate = (url: URL, baseUrl: URL): number => {
  if (!isScriptAsset(url)) return -1

  const path = url.pathname.toLowerCase()
  const file = path.split('/').pop() || ''
  let score = url.origin === baseUrl.origin ? 5 : 1

  if (/\/(?:assets|static|js|dist|build|_next|_nuxt)\//i.test(path)) score += 2
  if (/(?:^|[._-])(?:index|main|app|bundle|vendor|vendors|chunk|runtime|polyfills?)(?:[._-]|$)/i.test(file)) score += 4
  if (/[._-][a-f0-9]{6,}\.(?:mjs|js)$/i.test(file)) score += 2
  if (/\/node_modules\/|\/npm\//i.test(path)) score -= 2
  if (/(?:gtag|analytics|adsbygoogle|clarity|beacon|captcha|recaptcha)[._-]/i.test(file)) score -= 3

  return score
}

const collectCandidateScripts = (data: any, tabUrl: string): string[] => {
  let baseUrl: URL
  try {
    baseUrl = new URL(tabUrl)
  } catch {
    return []
  }

  const scriptUrls = unique([
    ...(data?.page?.resources?.scripts || []),
    ...(data?.page?.resources?.resourceTiming || []),
    ...(data?.page?.resources?.all || []),
    ...(data?.dynamic?.scripts || []),
    ...(data?.dynamic?.resources || [])
  ])
  const candidates: ScriptCandidate[] = []

  for (const item of scriptUrls) {
    const absolute = toAbsoluteHttpUrl(item, tabUrl)
    if (!absolute) continue
    try {
      const url = new URL(absolute)
      const score = scoreScriptCandidate(url, baseUrl)
      if (score < 1) continue
      candidates.push({ url: url.href, score })
    } catch {
      continue
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, MAX_CANDIDATE_SCRIPTS)
    .map(candidate => candidate.url)
}

const buildBundleSignature = (scripts: string[]): string => scripts.join('\n')

const comparablePageUrl = (value: unknown): string => {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

const getBundlePageIdentity = (data: any, tab: any): { url: string; title: string } => {
  const tabUrl = String(tab?.url || '')
  const pageUrl = String(data?.page?.url || '')
  const pageMatchesTab = pageUrl && comparablePageUrl(pageUrl) === comparablePageUrl(tabUrl)
  if (pageMatchesTab) {
    return {
      url: pageUrl,
      title: String(data?.page?.title || tab?.title || '')
    }
  }
  return {
    url: tabUrl,
    title: String(tab?.title || '')
  }
}

const readLimitedResponseText = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) {
    return (await response.text()).slice(0, maxBytes)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0

  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      chunks.push(decoder.decode(value, { stream: true }))
      if (bytes >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
    chunks.push(decoder.decode())
  } finally {
    reader.releaseLock()
  }

  return chunks.join('')
}

const isTextLikeResponse = (url: string, response: Response): boolean => {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType) return true
  if (/\.(?:mjs|js|txt)(?:[?#]|$)/i.test(url)) return true
  return /javascript|ecmascript|text|plain|octet-stream/i.test(contentType)
}

const parseContentRangeTotal = (value: string | null): number | undefined => {
  const match = value?.match(/\/(\d+)\s*$/)
  if (!match) return undefined
  const total = Number(match[1])
  return Number.isFinite(total) && total > 0 ? total : undefined
}

const fetchTextRange = async (url: string, start: number, maxBytes: number, budget: ScanBudget): Promise<RangeFetchResult> => {
  const claimedBytes = claimFetchBytes(budget, maxBytes)
  if (!claimedBytes) return { rangeSupported: false, text: '' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), remainingTimeoutMs(budget))
  const safeStart = Math.max(0, Math.floor(start))
  const safeMaxBytes = Math.max(1, Math.floor(claimedBytes))
  const end = safeStart + safeMaxBytes - 1

  try {
    const response = await fetch(url, {
      cache: 'force-cache',
      credentials: 'omit',
      headers: { Range: `bytes=${safeStart}-${end}` },
      signal: controller.signal,
      // 让 Chrome 把 bundle 扫描的请求排到页面资源后面，不抢用户的关键带宽
      priority: 'low'
    } as RequestInit)
    if (!response.ok) return { rangeSupported: false, text: '' }
    if (!isTextLikeResponse(url, response)) return { rangeSupported: false, text: '' }

    const rangeSupported = response.status === 206
    const totalBytes = parseContentRangeTotal(response.headers.get('content-range'))
    return {
      rangeSupported,
      text: await readLimitedResponseText(response, safeMaxBytes),
      totalBytes
    }
  } catch {
    return { rangeSupported: false, text: '' }
  } finally {
    clearTimeout(timeout)
  }
}

const fetchLimitedText = async (url: string, maxBytes: number, budget: ScanBudget): Promise<string> =>
  (await fetchTextRange(url, 0, maxBytes, budget)).text

const buildRangeSampleStarts = (totalBytes: number): number[] => {
  if (!Number.isFinite(totalBytes) || totalBytes <= MAX_FETCH_BYTES + MAX_RANGE_SAMPLE_BYTES) return []

  const maxStart = Math.max(0, totalBytes - MAX_RANGE_SAMPLE_BYTES)
  const starts: number[] = []
  for (const ratio of RANGE_SAMPLE_RATIOS) {
    const start = ratio >= 1 ? maxStart : Math.floor(maxStart * ratio)
    if (start <= MAX_FETCH_BYTES) continue
    if (starts.some(item => Math.abs(item - start) < MAX_RANGE_SAMPLE_BYTES / 2)) continue
    starts.push(start)
  }

  return starts.sort((a, b) => a - b).slice(0, MAX_RANGE_SAMPLES_PER_SCRIPT)
}

const fetchSampledScriptText = async (url: string, budget: ScanBudget): Promise<string> => {
  const head = await fetchTextRange(url, 0, MAX_FETCH_BYTES, budget)
  const chunks = [head.text]
  if (!head.rangeSupported || !head.totalBytes) return chunks.join('\n')

  for (const start of buildRangeSampleStarts(head.totalBytes)) {
    if (!hasScanBudget(budget) || budget.remainingRangeSamples <= 0) break
    budget.remainingRangeSamples -= 1
    await yieldToEventLoop()
    const result = await fetchTextRange(url, start, MAX_RANGE_SAMPLE_BYTES, budget)
    if (result.text) chunks.push(result.text)
  }

  return chunks.join('\n')
}

const isLicenseComment = (comment: string): boolean =>
  /^\/\*!/.test(comment) || /@(?:license|preserve)|copyright|licensed under|license information/i.test(comment)

const trimLicenseText = (text: string): string => {
  if (text.length <= MAX_LICENSE_TEXT_CHARS) return text
  return text.slice(0, MAX_LICENSE_TEXT_CHARS)
}

const looksLikeHtmlDocument = (text: string): boolean => /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)

// 匹配 JS 包体里嵌入的 OAuth / SSO 形态 URL，常见于 SPA 里的「使用 X 登录」按钮回调
// 抓到的 URL 会跑一遍第三方登录规则匹配，覆盖 HTML / 资源列表 / 响应头都拿不到的盲区
const EMBEDDED_AUTH_URL_PATTERN =
  /https?:\/\/[a-z0-9][a-z0-9.-]{2,}\.[a-z]{2,}\/(?:[^\s'"`<>]*?\/)?(?:oauth2?|authorize|connect|sso|openid[-_/]?connect|saml|signin|sign-in|login\/oauth)\b[^\s'"`<>)\]}]{0,200}/gi

const extractEmbeddedAuthUrls = (source: string): string[] => {
  if (!source) return []
  const seen = new Set<string>()
  for (const match of source.matchAll(EMBEDDED_AUTH_URL_PATTERN)) {
    const url = match[0].replace(/[)\];,.}'`"]+$/, '').trim()
    if (url.length < 14 || url.length > 240) continue
    seen.add(url)
    if (seen.size >= 60) break
  }
  return [...seen]
}

const extractLicenseComments = (source: string): string[] => {
  const comments: string[] = []
  let commentChars = 0
  const blockCommentPattern = /\/\*[\s\S]*?\*\//g
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = blockCommentPattern.exec(source))) {
    const comment = blockMatch[0]
    if (isLicenseComment(comment)) {
      comments.push(comment)
      commentChars += comment.length + 1
    }
    if (commentChars >= MAX_LICENSE_TEXT_CHARS) break
  }

  const lineCommentPattern = /^\s*\/\/[^\n]*(?:@license|@preserve|copyright|license)[^\n]*(?:\n\s*\/\/[^\n]*){0,8}/gim
  let lineMatch: RegExpExecArray | null
  while ((lineMatch = lineCommentPattern.exec(source))) {
    comments.push(lineMatch[0])
    commentChars += lineMatch[0].length + 1
    if (commentChars >= MAX_LICENSE_TEXT_CHARS) break
  }

  return comments
}

const buildSidecarLicenseUrl = (scriptUrl: string): string => {
  try {
    const url = new URL(scriptUrl)
    url.pathname = `${url.pathname}.LICENSE.txt`
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

const fetchSidecarLicenseText = async (sidecarUrl: string, budget: ScanBudget): Promise<string> => {
  const text = await fetchLimitedText(sidecarUrl, MAX_SIDECAR_BYTES, budget)
  if (!text || looksLikeHtmlDocument(text)) return ''
  return text
}

const scanScriptLicense = async (scriptUrl: string, budget: ScanBudget): Promise<ScriptLicenseObservation | null> => {
  const source = await fetchSampledScriptText(scriptUrl, budget)
  const sourceLength = source?.length || 0
  const comments = unique(source ? extractLicenseComments(source) : [])
  const embeddedAuthUrls = source ? extractEmbeddedAuthUrls(source) : []
  const sidecarUrl = buildSidecarLicenseUrl(scriptUrl)
  const sidecarText = sidecarUrl && comments.length < 12 && hasScanBudget(budget) ? await fetchSidecarLicenseText(sidecarUrl, budget) : ''
  const text = trimLicenseText([...comments, sidecarText].filter(Boolean).join('\n\n'))

  // 没拿到任何字节也保留 observation，方便用户在原始线索里看到「fetch 失败」而不是悄无声息
  if (!sourceLength && !text && !embeddedAuthUrls.length) return null
  return {
    url: scriptUrl,
    commentCount: comments.length + (sidecarText ? 1 : 0),
    text,
    sidecarUrl: sidecarText ? sidecarUrl : undefined,
    embeddedAuthUrls: embeddedAuthUrls.length ? embeddedAuthUrls : undefined,
    sourceLength: sourceLength || undefined
  }
}

const getLicenseHintScanner = createRuleListsScannerCache()

const detectTechnologiesFromLicenseText = (observations: ScriptLicenseObservation[], rules: any[]): any[] => {
  if (!Array.isArray(rules) || !rules.length || !observations.length) return []

  const technologies: any[] = []
  const scanner = getLicenseHintScanner([rules])
  for (const observation of observations) {
    // 版权注释文本最长 18 万字符，先一次扫出出现过的 hint，没有 hint 的规则不再跑正则
    const lookup = scanner.scan(observation.text.toLowerCase())
    for (const rule of rules) {
      if (!rule?.name || !passesResourceHintLookup(rule, lookup) || !passesHintLookup(rule, lookup)) continue
      if (!matchesCompiledRulePatterns(rule, observation.text)) continue
      const version = extractVersionFromBundleText(rule, observation.text)
      const tech: any = {
        category: rule.category || '前端库',
        name: rule.name,
        confidence: rule.confidence || '中',
        evidence: [`JS 版权注释匹配 ${shortHeaderUrl(observation.url)}`],
        source: BUNDLE_LICENSE_SOURCE,
        url: cleanTechnologyUrl(rule.url)
      }
      if (version) tech.version = version
      technologies.push(tech)
    }
  }

  return mergeTechnologyRecords(technologies).slice(0, 80)
}

// 用第三方登录规则跑一遍 bundle 里抓出的 OAuth URL：
// SPA 把「使用 linux.do / GitHub / Google 登录」的回调 URL 写在 bundle 里时
// HTML / 资源 URL / 响应头都看不到，只能扫包体抓 URL 后再走规则匹配
const detectAuthProvidersFromBundles = (observations: ScriptLicenseObservation[], rules: any[]): any[] => {
  if (!Array.isArray(rules) || !rules.length || !observations.length) return []

  const technologies: any[] = []
  for (const observation of observations) {
    if (!observation.embeddedAuthUrls?.length) continue
    const urlBlob = observation.embeddedAuthUrls.join('\n')
    for (const rule of rules) {
      if (!rule?.name) continue
      if (!matchesCompiledRulePatterns(rule, urlBlob)) continue
      const matched = observation.embeddedAuthUrls.find(u => matchesCompiledRulePatterns(rule, u)) || observation.embeddedAuthUrls[0]
      const kindPrefix = rule.kind ? `${rule.kind}：` : ''
      technologies.push({
        category: rule.category || '第三方登录 / OAuth',
        name: rule.name,
        confidence: rule.confidence || '高',
        evidence: [`${kindPrefix}JS 包体内嵌 OAuth 入口 ${shortHeaderUrl(matched)}`],
        source: BUNDLE_LICENSE_SOURCE,
        url: cleanTechnologyUrl(rule.url)
      })
    }
  }

  return mergeTechnologyRecords(technologies).slice(0, 40)
}

const saveBundleLicenseDataAndBadge = async (tabId: number, data: any, settings: any, tab: any) => {
  if (!isDetectablePageUrl(tab?.url)) return
  // 走 per-tab 写锁:bundle 扫描跑 1-2s,期间 detection / dynamic / headers 都可能在并发写;
  // 进入锁后再 re-read 最新 storage,只覆盖自己的 bundle 字段,其他字段保留最新
  await withTabWriteLock(tabId, async () => {
    const latest = (await getTabData(tabId)) || {}
    latest.bundle = data.bundle
    latest.updatedAt = data.updatedAt || Date.now()
    const popup = await buildPopupCacheRecord(latest, settings, tab)
    const { popup: _legacyPopup, ...tabData } = latest
    await writeTabData(tabId, tabData, popup)
    await updateBadgeForTab(tabId, popup)
  })
}

export const runBundleLicenseDetection = async (tabId: number): Promise<void> => {
  if (typeof tabId !== 'number' || tabId < 0) return

  const tab = await getTabSnapshot(tabId)
  if (!isDetectablePageUrl(tab.url)) return

  const [data, rules, settings] = await Promise.all([getTabData(tabId), loadTechRules(), loadDetectorSettings()])
  const pageRules = buildEffectivePageRules(rules.page || {}, settings)
  const scripts = collectCandidateScripts(data, tab.url)
  const signature = buildBundleSignature(scripts)
  if (!signature) return
  if (data.bundle?.schemaVersion === BUNDLE_LICENSE_SCHEMA_VERSION && data.bundle?.signature === signature) return

  const budget = createScanBudget()
  // 并发扫候选脚本，但限制同时 fetch 数为 3：完全并行会一次性占 5 条网络连接，
  // 跟页面自身资源抢带宽；3 个一组既能压住扫描总耗时,又不挤占用户的页面加载。
  const SCRIPT_SCAN_CONCURRENCY = 3
  const observations: ScriptLicenseObservation[] = []
  for (let i = 0; i < scripts.length; i += SCRIPT_SCAN_CONCURRENCY) {
    if (!hasScanBudget(budget)) break
    const batch = scripts.slice(i, i + SCRIPT_SCAN_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map(script => (hasScanBudget(budget) ? scanScriptLicense(script, budget) : Promise.resolve(null)))
    )
    for (const observation of batchResults) {
      if (observation) observations.push(observation)
    }
    await yieldToEventLoop()
  }

  const technologies = mergeTechnologyRecords([
    ...detectTechnologiesFromLicenseText(observations, pageRules.bundleLicenseLibraries || []),
    ...detectAuthProvidersFromBundles(observations, pageRules.thirdPartyLogins || [])
  ])
  const pageIdentity = getBundlePageIdentity(data, tab)

  data.bundle = {
    schemaVersion: BUNDLE_LICENSE_SCHEMA_VERSION,
    signature,
    url: pageIdentity.url,
    title: pageIdentity.title,
    updatedAt: Date.now(),
    scripts: observations.map(observation => ({
      url: observation.url,
      sidecarUrl: observation.sidecarUrl || '',
      commentCount: observation.commentCount,
      sourceLength: observation.sourceLength || 0,
      embeddedAuthUrls: observation.embeddedAuthUrls || []
    })),
    technologies
  }
  data.updatedAt = Date.now()

  await saveBundleLicenseDataAndBadge(tabId, data, settings, tab)
}

export const clearBundleLicenseTimer = (tabId: number): void => {
  const timer = bundleLicenseTimers.get(tabId)
  if (!timer) return
  clearTimeout(timer)
  bundleLicenseTimers.delete(tabId)
}

export const scheduleBundleLicenseDetection = (tabId: number, delay = SCAN_DELAY_MS): void => {
  if (typeof tabId !== 'number' || tabId < 0) return
  clearBundleLicenseTimer(tabId)
  const timer = setTimeout(() => {
    bundleLicenseTimers.delete(tabId)
    runBundleLicenseDetection(tabId).catch(() => {})
  }, delay)
  bundleLicenseTimers.set(tabId, timer)
}

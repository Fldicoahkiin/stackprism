import { dedupeApiRecords, hasEquivalentHeaderRecord } from './headers'
import { saveTabDataAndBadge } from './detection'
import { loadDetectorSettings } from './detector-settings'
import { getTabData, getTabSnapshot } from './tab-store'
import { withTabWriteLock } from './tab-write-lock'

export const API_REQUEST_TYPES = new Set(['xmlhttprequest', 'fetch', 'websocket'])

// 只有主文档、iframe 和接口请求会进入记录；图片、媒体、脚本等请求直接跳过，避免每个请求都整份读写存储
export const isRecordedRequestType = (type: string): boolean => type === 'main_frame' || type === 'sub_frame' || API_REQUEST_TYPES.has(type)

// 标签页当前地址：接口请求要据此判断页面能否检测，缓存下来免得每个请求都调一次 chrome.tabs.get
const tabUrls = new Map<number, string>()

export const rememberTabUrl = (tabId: number, url: string): void => {
  if (url) tabUrls.set(tabId, url)
}

export const resolveTabUrl = async (tabId: number): Promise<string> => {
  const cached = tabUrls.get(tabId)
  if (cached) return cached
  const { url } = await getTabSnapshot(tabId)
  rememberTabUrl(tabId, url)
  return url
}

// 接口和 iframe 的响应头记录攒一小段再合并写入：B 站这类页面每秒几十个接口请求，
// 逐个读写整份标签页数据、重建弹窗缓存会让后台一直忙着序列化
const HEADER_RECORD_FLUSH_DELAY_MS = 300
const pendingHeaderRecords = new Map<number, Array<{ type: string; record: any }>>()
const headerFlushTimers = new Map<number, ReturnType<typeof setTimeout>>()

const applyHeaderRecord = (data: any, type: string, record: any): boolean => {
  if (API_REQUEST_TYPES.has(type)) {
    if (hasEquivalentHeaderRecord(data.apis, record)) return false
    data.apis = dedupeApiRecords([record, ...(data.apis || [])])
    return true
  }
  if (hasEquivalentHeaderRecord(data.frames, record)) return false
  data.frames = dedupeApiRecords([record, ...(data.frames || [])]).slice(0, 10)
  return true
}

const flushHeaderRecords = async (tabId: number): Promise<void> => {
  headerFlushTimers.delete(tabId)
  const pending = pendingHeaderRecords.get(tabId)
  pendingHeaderRecords.delete(tabId)
  if (!pending?.length) return
  const settings = await loadDetectorSettings()
  await withTabWriteLock(tabId, async () => {
    const latest = (await getTabData(tabId)) || {}
    let changed = false
    for (const { type, record } of pending) {
      changed = applyHeaderRecord(latest, type, record) || changed
    }
    if (!changed) return
    latest.updatedAt = Date.now()
    await saveTabDataAndBadge(tabId, latest, settings)
  })
}

export const queueHeaderRecord = (tabId: number, type: string, record: any): void => {
  const pending = pendingHeaderRecords.get(tabId)
  if (pending) pending.push({ type, record })
  else pendingHeaderRecords.set(tabId, [{ type, record }])
  if (headerFlushTimers.has(tabId)) return
  headerFlushTimers.set(
    tabId,
    setTimeout(() => {
      flushHeaderRecords(tabId).catch(() => {})
    }, HEADER_RECORD_FLUSH_DELAY_MS)
  )
}

export const clearPendingHeaderRecords = (tabId: number): void => {
  pendingHeaderRecords.delete(tabId)
  const timer = headerFlushTimers.get(tabId)
  if (timer) clearTimeout(timer)
  headerFlushTimers.delete(tabId)
}

export const forgetTabHeaderState = (tabId: number): void => {
  clearPendingHeaderRecords(tabId)
  tabUrls.delete(tabId)
}

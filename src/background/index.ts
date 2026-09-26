import { injectContentObserverIntoOpenTabs } from './content-injector'
import { clearBadge, clearTabSession, forgetBadgeState } from './tab-store'
import { clearDynamicSnapshotTimer, clearPendingDynamicSnapshot } from './dynamic-snapshot'
import { buildHeaderRecord, mergeHeaderRecords, shouldMergeHeaderRecords } from './headers'
import {
  clearPendingHeaderRecords,
  forgetTabHeaderState,
  isRecordedRequestType,
  queueHeaderRecord,
  rememberTabUrl,
  resolveTabUrl
} from './header-records'
import {
  clearActiveDetectionTimer,
  clearDetectionThrottle,
  refreshAllBadges,
  saveTabDataAndBadge,
  scheduleActivePageDetection
} from './detection'
import { getTabData } from './tab-store'
import { SETTINGS_STORAGE_KEY, applyDetectorSettingsUpdate, loadDetectorSettings, loadTechRules } from './detector-settings'
import { registerMessageRouter } from './message-router'
import { clearBundleLicenseTimer } from './bundle-license'
import { clearTabWriteLock, withTabWriteLock } from './tab-write-lock'
import { isDetectablePageUrl, isObservableRequestUrl } from '@/utils/page-support'
import { clearLegacySessionKeys } from '@/utils/browser-compat'

registerMessageRouter()

chrome.runtime.onInstalled.addListener(() => {
  clearLegacySessionKeys().catch(() => {})
  injectContentObserverIntoOpenTabs()
})

chrome.runtime.onStartup.addListener(() => {
  clearLegacySessionKeys().catch(() => {})
  injectContentObserverIntoOpenTabs()
})

chrome.tabs.onRemoved.addListener(tabId => {
  clearActiveDetectionTimer(tabId)
  clearDetectionThrottle(tabId)
  clearBundleLicenseTimer(tabId)
  clearDynamicSnapshotTimer(tabId)
  clearPendingDynamicSnapshot(tabId)
  clearTabSession(tabId)
  forgetBadgeState(tabId)
  forgetTabHeaderState(tabId)
})

const clearTabDetectionState = (tabId: number) => {
  clearActiveDetectionTimer(tabId)
  clearDetectionThrottle(tabId)
  clearBundleLicenseTimer(tabId)
  clearDynamicSnapshotTimer(tabId)
  clearPendingDynamicSnapshot(tabId)
  clearTabWriteLock(tabId)
  clearPendingHeaderRecords(tabId)
  clearBadge(tabId)
  clearTabSession(tabId).catch(() => {})
}

const getUrlOrigin = (value: unknown): string => {
  try {
    return new URL(String(value || '')).origin
  } catch {
    return ''
  }
}

const clearCrossOriginDynamicSnapshot = (data: any, nextUrl: string) => {
  const dynamicOrigin = getUrlOrigin(data?.dynamic?.url)
  const nextOrigin = getUrlOrigin(nextUrl)
  if (dynamicOrigin && nextOrigin && dynamicOrigin !== nextOrigin) {
    delete data.dynamic
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || ''
  rememberTabUrl(tabId, url)
  if (url && !isDetectablePageUrl(url)) {
    clearTabDetectionState(tabId)
    return
  }

  if (changeInfo.status === 'loading') {
    clearActiveDetectionTimer(tabId)
    clearDynamicSnapshotTimer(tabId)
    clearPendingDynamicSnapshot(tabId)
    clearBadge(tabId)
    return
  }

  if (changeInfo.status === 'complete') {
    if (isDetectablePageUrl(url)) {
      scheduleActivePageDetection(tabId, 600)
    } else {
      clearTabDetectionState(tabId)
    }
  }
})

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return
  clearDetectionThrottle(details.tabId)
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes[SETTINGS_STORAGE_KEY]) {
    applyDetectorSettingsUpdate(changes[SETTINGS_STORAGE_KEY].newValue)
    refreshAllBadges()
  }
})

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || !details.responseHeaders) return
    if (!isObservableRequestUrl(details.url)) return
    if (!isRecordedRequestType(details.type as string)) return

    const tabId = details.tabId
    const type = details.type as string
    if (type === 'main_frame') rememberTabUrl(tabId, details.url)
    Promise.all([loadTechRules(), loadDetectorSettings(), type === 'main_frame' ? details.url : resolveTabUrl(tabId)])
      .then(async ([rules, settings, tabUrl]) => {
        if (!isDetectablePageUrl(tabUrl)) {
          clearTabDetectionState(tabId)
          return
        }
        const record = buildHeaderRecord(details, rules.headers || {}, settings)
        if (type !== 'main_frame') {
          queueHeaderRecord(tabId, type, record)
          return
        }
        // 新的主文档到了，上一页还没写入的接口记录作废
        clearPendingHeaderRecords(tabId)
        // 进 per-tab 锁:concurrent webRequest 事件不能并发 read-modify-write,否则会互相覆盖彼此的 apis / frames / main
        await withTabWriteLock(tabId, async () => {
          const latest = (await getTabData(tabId)) || {}
          clearCrossOriginDynamicSnapshot(latest, details.url)
          latest.main = shouldMergeHeaderRecords(latest.main, record) ? mergeHeaderRecords(latest.main, record) : record
          latest.apis = []
          latest.frames = []
          latest.updatedAt = Date.now()
          await saveTabDataAndBadge(tabId, latest, settings)
        })
      })
      .catch(() => {})
  },
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  ['responseHeaders', 'extraHeaders']
)

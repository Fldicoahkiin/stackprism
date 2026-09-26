import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const loadModule = async () => {
  const source = await readFile(new URL('../src/background/page-rule-filter.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText, 'utf8').toString('base64')}`)
}

const cdnRule = { name: 'Vue', resourceHints: ['CDN.jsdelivr.net/npm/', 'unpkg.com/'] }
const wordpressRule = { name: 'WordPress', resourceHints: ['/wp-content/'] }
const htmlRule = { name: 'Hugo', patterns: ['hugo'] }
const pageRules = {
  frontendExtra: [cdnRule, htmlRule],
  websitePrograms: [wordpressRule],
  bundleLicenseLibraries: [{ name: 'React' }],
  dynamicTechnologies: [{ name: 'Turbo' }],
  customRules: [{ name: '自定义', resourceHints: ['never-present'] }]
}

test('按命中的 resourceHints 裁剪注入页面的规则', async () => {
  const { collectResourceHints, selectPageDetectorRules } = await loadModule()
  assert.deepEqual(collectResourceHints(pageRules).sort(), ['/wp-content/', 'cdn.jsdelivr.net/npm/', 'never-present', 'unpkg.com/'])

  const selected = selectPageDetectorRules(pageRules, ['unpkg.com/'])
  assert.deepEqual(
    selected.frontendExtra.map(rule => rule.name),
    ['Vue', 'Hugo']
  )
  assert.deepEqual(selected.websitePrograms, [])
  assert.deepEqual(selected.customRules, pageRules.customRules)
  assert.equal('bundleLicenseLibraries' in selected, false)
  assert.equal('dynamicTechnologies' in selected, false)
})

test('探测不到资源时不裁剪规则', async () => {
  const { selectPageDetectorRules } = await loadModule()
  const selected = selectPageDetectorRules(pageRules, null)
  assert.deepEqual(selected.frontendExtra, pageRules.frontendExtra)
  assert.deepEqual(selected.websitePrograms, pageRules.websitePrograms)
})

test('页面探针按 page-detector 的资源收集方式返回命中的 hint', async () => {
  const { probeResourceHintHits } = await loadModule()
  const previousDocument = globalThis.document
  globalThis.document = {
    scripts: [{ src: 'https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js' }, { src: '' }],
    images: [{ currentSrc: 'data:image/png;base64,AAAA' }],
    querySelectorAll: () => [{ href: 'https://example.com/wp-content/themes/a/style.css' }]
  }
  try {
    assert.deepEqual(probeResourceHintHits(['cdn.jsdelivr.net/npm/', '/wp-content/', 'unpkg.com/']), [
      'cdn.jsdelivr.net/npm/',
      '/wp-content/'
    ])
    globalThis.document = { scripts: [], images: [], querySelectorAll: () => [] }
    assert.equal(probeResourceHintHits(['unpkg.com/']), null)
  } finally {
    globalThis.document = previousDocument
  }
})

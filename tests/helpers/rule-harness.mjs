// 规则测试共用的装载与运行工具：按构建期方式预编译 hint，打包 headers.ts，在 vm 里跑 page-detector.ts
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { build, transformSync } from 'esbuild'

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// 与 vite.config.ts 的 precompileRulesPlugin 一致：运行时预筛只用构建期写入的 __hints
const viteConfig = readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8')
const HINT_MIN_LEN = Number(/const HINT_MIN_LEN = (\d+)/.exec(viteConfig)[1])
const HINT_MAX_COUNT = Number(/const HINT_MAX_COUNT = (\d+)/.exec(viteConfig)[1])

export const extractBuildHints = (patterns, isKeyword) => {
  const candidates = []
  for (const pattern of patterns) {
    const text = String(pattern || '')
    if (isKeyword) {
      const lower = text.toLowerCase().trim()
      if (lower.length >= HINT_MIN_LEN) candidates.push(lower)
      continue
    }
    for (const segment of text.replace(/\\[bBdDsSwW]/g, ' ').split(/[\\^$.|?*+()[\]{}]/)) {
      const lower = segment.toLowerCase().replace(/\s+/g, ' ').trim()
      if (lower.length >= HINT_MIN_LEN) candidates.push(lower)
    }
  }
  return [...new Set(candidates)].sort((a, b) => b.length - a.length).slice(0, HINT_MAX_COUNT)
}

const isPlainObject = value => Object.prototype.toString.call(value) === '[object Object]'

export const expandRules = (value, inherited = {}) => {
  if (Array.isArray(value)) return value.flatMap(item => expandRules(item, inherited))
  if (isPlainObject(value) && Array.isArray(value.rules)) {
    return value.rules.flatMap(item => expandRules(item, { ...inherited, ...(value.defaults || {}) }))
  }
  if (!isPlainObject(value)) return [value]
  const rule = { ...inherited, ...value }
  return [Array.isArray(rule.patterns) ? { ...rule, __hints: extractBuildHints(rule.patterns, rule.matchType === 'keyword') } : rule]
}

export const readRuleFile = file => JSON.parse(readFileSync(path.join(repoRoot, 'public/rules', file), 'utf8'))

// 把若干规则文件的 page 段合并成 page-detector 需要的规则表
export const loadPageRules = files => {
  const merged = {}
  for (const file of files) {
    for (const [key, value] of Object.entries(readRuleFile(file).page || {})) {
      merged[key] = [...(merged[key] || []), ...expandRules(value)]
    }
  }
  return merged
}

export const loadHeaderRules = () => {
  const merged = {}
  for (const file of readdirSync(path.join(repoRoot, 'public/rules/headers'))) {
    for (const [key, value] of Object.entries(readRuleFile(`headers/${file}`).headers || {})) {
      merged[key] = [...(merged[key] || []), ...(key === 'interestingHeaders' ? value : expandRules(value))]
    }
  }
  return merged
}

export const loadHeadersModule = async () => {
  const result = await build({
    entryPoints: [path.join(repoRoot, 'src/background/headers.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'src-alias',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^@\// }, args => ({ path: path.join(repoRoot, 'src', `${args.path.slice(2)}.ts`) }))
        }
      }
    ]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')}`)
}

export const detectHeaders = (headersModule, headerRules, headers, url = 'https://example.com/') =>
  headersModule.buildHeaderRecord(
    {
      url,
      type: 'main_frame',
      method: 'GET',
      statusCode: 200,
      responseHeaders: Object.entries(headers).flatMap(([name, value]) => [value].flat().map(item => ({ name, value: item })))
    },
    headerRules,
    {}
  ).technologies

// 规则命中需同时满足：构建期 hint 至少有一个出现在文本里，且某条正则匹配
export const pageRuleMatches = (rule, text) =>
  (!rule.__hints?.length || rule.__hints.some(hint => text.toLowerCase().includes(hint))) &&
  (rule.patterns || []).some(pattern => new RegExp(pattern, rule.caseSensitive ? '' : 'i').test(text))

let detectorSource = null
const loadDetectorSource = () => {
  if (detectorSource) return detectorSource
  const source = readFileSync(path.join(repoRoot, 'src/injected/page-detector.ts'), 'utf8').replace(
    'export default __spResult',
    'globalThis.__spDone = __spResult'
  )
  detectorSource = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  return detectorSource
}

// 在 vm 里跑真实的 page-detector：fixture 提供页面地址、HTML、资源 URL、全局变量名、类名和能命中的选择器
export const runPageDetector = async (pageRules, fixture) => {
  const {
    href = 'https://example.com/',
    html = '<html><head></head><body></body></html>',
    resources = [],
    globals = [],
    classes = []
  } = fixture
  const selectors = new Set(fixture.selectors || [])
  const classNodes = classes.map(token => ({ classList: [token], className: token }))
  const document = {
    scripts: resources.filter(url => /\.js(?:[?#]|$)/i.test(url)).map(src => ({ src })),
    images: [],
    title: fixture.title || '',
    documentElement: { outerHTML: html },
    body: { innerText: html.replace(/<[^>]+>/g, ' ') },
    styleSheets: [],
    querySelectorAll: selector => {
      if (selector.includes('stylesheet')) return resources.filter(url => /\.css(?:[?#]|$)/i.test(url)).map(url => ({ href: url }))
      if (selector === '[class]') return classNodes
      return []
    },
    querySelector: selector => (selectors.has(selector) ? {} : null),
    getElementById: () => null
  }
  const windowObject = { document, CSS: { escape: value => value }, __SP_RULES__: pageRules }
  for (const name of globals) windowObject[name] = {}
  const context = {
    window: windowObject,
    document,
    location: new URL(href),
    navigator: {},
    performance: {
      now: () => performance.now(),
      getEntriesByType: () => resources.map(name => ({ name, nextHopProtocol: '' })),
      mark() {},
      measure() {}
    },
    getComputedStyle: () => ({ length: 0, item: () => '', getPropertyValue: () => '' }),
    localStorage: { getItem: () => null },
    CSS: { escape: value => value },
    Element: class {},
    HTMLCollection: class {},
    NodeList: class {},
    setTimeout,
    console,
    URL
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(loadDetectorSource(), context)
  const result = await context.__spDone
  return result.technologies
}

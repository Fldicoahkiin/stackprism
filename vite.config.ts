import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { crx } from '@crxjs/vite-plugin'
import tsconfigPaths from 'vite-tsconfig-paths'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import manifest from './src/manifest.config'
import { buildRuleHintFields } from './src/utils/rule-hints'

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g

const escapeForRegex = (value: string) => value.replace(REGEX_ESCAPE, '\\$&')

const buildKeywordCombinedSource = (patterns: unknown): string => {
  if (!Array.isArray(patterns) || !patterns.length) return ''
  const segments = patterns
    .map(pattern => String(pattern || '').trim())
    .filter(Boolean)
    .map(escapeForRegex)
  return segments.length ? segments.join('|') : ''
}

const isPlainNode = (node: any): boolean => Boolean(node) && typeof node === 'object' && !Array.isArray(node)
const isLeafRule = (node: any): boolean => isPlainNode(node) && Array.isArray(node.patterns)
const isRuleGroup = (node: any): boolean => isPlainNode(node) && Array.isArray(node.rules)

// 规则组的 defaults 会被展开到每条规则上（matchType、resourceHints 常写在 defaults 里），预编译时按展开后的字段判断
const precompileRuleTree = (node: any, inherited: Record<string, unknown> = {}): void => {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) precompileRuleTree(item, inherited)
    return
  }
  if (!isPlainNode(node)) return
  if (isRuleGroup(node)) {
    const defaults = {
      ...inherited,
      ...(isPlainNode(node.defaults) ? node.defaults : {}),
      ...(isPlainNode(node.$defaults) ? node.$defaults : {})
    }
    for (const item of node.rules) precompileRuleTree(item, defaults)
    return
  }
  if (isLeafRule(node)) {
    const rule = { ...inherited, ...node }
    const isKeyword = rule.matchType === 'keyword'
    const { hints, legacyHints } = buildRuleHintFields(node.patterns, isKeyword, node.matchType === 'keyword', node.__hints)
    if (hints.length) node.__hints = hints
    else delete node.__hints
    // 旧版带 resourceHints 的规则不看自动 hint，旧门槛只留给没有 resourceHints 的规则
    if (legacyHints.length && !(Array.isArray(rule.resourceHints) && rule.resourceHints.length)) node.__legacyHints = legacyHints
    if (node.matchType === 'keyword') {
      const combined = buildKeywordCombinedSource(node.patterns)
      if (combined) node.__keywordCombined = combined
    }
    return
  }
  for (const key in node) precompileRuleTree(node[key])
}

const precompileRulesPlugin = (): Plugin => ({
  name: 'stackprism:precompile-rules',
  apply: 'build',
  closeBundle() {
    const rulesDir = path.resolve(__dirname, 'dist/rules')
    let dirStat
    try {
      dirStat = statSync(rulesDir)
    } catch {
      return
    }
    if (!dirStat.isDirectory()) return

    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        const stat = statSync(full)
        if (stat.isDirectory()) out.push(...walk(full))
        else if (name.endsWith('.json') && name !== 'index.json') out.push(full)
      }
      return out
    }

    for (const file of walk(rulesDir)) {
      const original = readFileSync(file, 'utf8')
      let parsed
      try {
        parsed = JSON.parse(original)
      } catch {
        continue
      }
      precompileRuleTree(parsed)
      writeFileSync(file, JSON.stringify(parsed), 'utf8')
    }
  }
})

const minifyJsonAssets = (): Plugin => ({
  name: 'stackprism:minify-json-assets',
  apply: 'build',
  closeBundle() {
    const distDir = path.resolve(__dirname, 'dist')
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        const stat = statSync(full)
        if (stat.isDirectory()) out.push(...walk(full))
        else if (name.endsWith('.json')) out.push(full)
      }
      return out
    }

    for (const file of walk(distDir)) {
      const original = readFileSync(file, 'utf8')
      let parsed
      try {
        parsed = JSON.parse(original)
      } catch {
        continue
      }
      const minified = JSON.stringify(parsed)
      if (minified.length < original.length) {
        writeFileSync(file, minified, 'utf8')
      }
    }
  }
})

export default defineConfig({
  plugins: [vue(), crx({ manifest }), tsconfigPaths(), precompileRulesPlugin(), minifyJsonAssets()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      vue: 'vue/dist/vue.runtime.esm-bundler.js'
    }
  },
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        help: path.resolve(__dirname, 'src/ui/help/index.html')
      }
    }
  }
})

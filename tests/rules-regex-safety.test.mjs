import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const RULES_DIR = new URL('../public/rules/', import.meta.url)

const collectRuleFiles = async dir => {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) files.push(...(await collectRuleFiles(url)))
    else if (entry.name.endsWith('.json')) files.push(url)
  }
  return files
}

const collectRegexPatterns = async () => {
  const patterns = []
  const walk = (node, file) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, file)
      return
    }
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.patterns) && node.matchType !== 'keyword') {
      for (const pattern of node.patterns) {
        if (typeof pattern === 'string') patterns.push({ file, name: node.name, pattern })
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'patterns') walk(value, file)
    }
  }
  for (const file of await collectRuleFiles(RULES_DIR)) {
    walk(JSON.parse(await readFile(file, 'utf8')), file.pathname.split('/rules/')[1])
  }
  return patterns
}

// 以「任意长度前瞻」开头又不锚定的正则，匹配失败时会在每个起点重扫全文，复杂度 O(n²)
const UNANCHORED_GREEDY_LOOKAHEAD = /^\(\?[=!](?:\[\\s\\S\]|\[\\S\\s\]|\[\\w\\W\]|\[\\d\\D\]|\.)[*+]/

test('规则里没有未锚定的任意长度前瞻正则', async () => {
  const offenders = (await collectRegexPatterns())
    .filter(({ pattern }) => UNANCHORED_GREEDY_LOOKAHEAD.test(pattern))
    .map(({ file, name, pattern }) => `${file} | ${name} | ${pattern.slice(0, 80)}`)
  assert.deepEqual(offenders, [])
})

test('同时包含多个特征的组合正则在大文本上线性完成', async () => {
  const patterns = (await collectRegexPatterns()).filter(({ pattern }) => pattern.startsWith('^(?='))
  assert.ok(patterns.length >= 3, '应覆盖已知的组合正则')
  // 含全部 hint 但不满足组合条件的 300KB 文本：修复前单条正则需要数十秒
  const text = 'x /static/common/ element-ui submitlogin alipayment /index/index/demo '.repeat(4300)
  for (const { name, pattern } of patterns) {
    const regex = new RegExp(pattern, 'i')
    const started = performance.now()
    regex.test(text)
    const elapsed = performance.now() - started
    assert.ok(elapsed < 200, `${name} 耗时 ${elapsed.toFixed(1)}ms`)
  }
})

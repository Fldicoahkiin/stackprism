import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ruleHints } from './helpers/rule-harness.mjs'

const { buildRuleHintFields, createHintScanner, extractRegexHints, extractRuleHints } = ruleHints

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 样例必须能被规则命中；只要提取出了 hint，样例转小写后就必须含其中一个
const assertSound = (patterns, samples, { keyword = false } = {}) => {
  const hints = extractRuleHints(patterns, keyword)
  for (const sample of samples) {
    const matched = patterns.some(pattern => new RegExp(keyword ? escapeRegExp(pattern.trim()) : pattern, 'i').test(sample))
    assert.ok(matched, `样例没被规则命中：${JSON.stringify(sample)}`)
    if (!hints.length) continue
    const lower = sample.toLowerCase()
    assert.ok(
      hints.some(hint => lower.includes(hint)),
      `hint ${JSON.stringify(hints)} 漏掉 ${JSON.stringify(sample)}`
    )
  }
  return hints
}

test('字面量、分组、可选段和重复都只取必然出现的片段', () => {
  const wordpress = assertSound(['/wp-content/(?:themes|plugins)/'], ['https://a.com/wp-content/themes/x.css', '/WP-CONTENT/PLUGINS/'])
  assert.ok(wordpress.length && wordpress.every(hint => hint.includes('/wp-content/')), JSON.stringify(wordpress))
  assertSound(['(?:foo|bar)bazqux'], ['foobazqux', 'BARBAZQUX'])
  assertSound(['abc(?:def)?ghi'], ['abcghi', 'abcdefghi'])
  assertSound(['x(?:abc)+yz'], ['xabcabcyz'])
  assertSound(['[Tt]ypecho'], ['Typecho', 'typecho'])
  assertSound(['typecho(?=\\.js)'], ['typecho.js'])
  assertSound(['(?<!x)discuz'], ['discuz', 'Discuz!'])
})

test('多个 pattern 取并集，有一个提取不到就不预筛', () => {
  const hints = assertSound(['typecho', 'halo-theme'], ['/usr/themes/typecho', '/themes/halo-theme/a.js'])
  assert.deepEqual([...hints].sort(), ['halo-theme', 'typecho'])
  assert.deepEqual(extractRuleHints(['typecho', '\\d+\\.\\d+']), [])
  assert.deepEqual(extractRuleHints(['typecho', '']), [])
  assert.deepEqual(extractRuleHints([]), [])
})

test('转义按正则语义解码，不把语法字符当成字面量', () => {
  assertSound(['\\x41bcd'], ['Abcd'])
  // 旧式八进制与反向引用
  assertSound(['a\\012bcd'], ['a\nbcd'])
  assertSound(['(ab)\\1cdef'], ['ababcdef'])
  // 控制字符 \cJ 就是换行
  assertSound(['\\cJfooz'], ['\nfooz'])
  // 命名反向引用不会产生 <q> 这样的 hint
  const named = assertSound(['(?<q>[\'"])hello\\k<q>world'], ["'hello'world"])
  assert.ok(named.every(hint => !hint.includes('<q>')))
  assertSound(['\\u0041pollo'], ['Apollo'])
})

test('可以出现零次的环视不算必需', () => {
  assertSound(['abcd(?=efgh)?'], ['abcd'])
})

test('i 模式下会和别的字符互相匹配的非 ASCII 字母不进 hint', () => {
  // /µs/i 能匹配希腊字母 μ
  assertSound(['µsecond'], ['μsecond'])
  assertSound(['Войти через ВКонтакте'], ['войти через вконтакте'])
  // 中文没有大小写，照常可用
  assert.deepEqual(extractRuleHints(['使用微信登录']), ['使用微信登录'])
})

test('关键词规则按去掉首尾空白后的整段匹配', () => {
  assert.deepEqual(assertSound([' Shopify '], ['cdn.shopify.com'], { keyword: true }), ['shopify'])
  assert.deepEqual(extractRuleHints(['ab'], true), [])
  assert.deepEqual(extractRuleHints(['shopify', '  '], true), [])
})

test('通用词拼出的 hint 让位给更有区分度的片段', () => {
  const hints = extractRuleHints(['<meta name="generator" content="WordPress'])
  assert.ok(
    hints.every(hint => hint.includes('wordpress')),
    JSON.stringify(hints)
  )
})

test('无法解析的正则返回 null', () => {
  assert.equal(extractRegexHints('(?i:abc)'), null)
  assert.equal(extractRegexHints('[abc'), null)
  assert.equal(extractRegexHints('abc)'), null)
})

test('旧版门槛只在比健全 hint 更严时保留', () => {
  // 每个健全 hint 都含旧 hint，旧门槛多余
  assert.deepEqual(buildRuleHintFields(['alpha(?:-beta)?-gamma'], false, false).legacyHints, [])
  // fooqux 分支不含任何旧 hint，旧版构建下这条分支从不生效，保留门槛让结果不变
  assert.deepEqual(buildRuleHintFields(['(?:foo|barbaz)qux'], false, false).legacyHints, ['barbaz', ':foo'])
  // 手写 __hints 就是旧门槛
  assert.deepEqual(buildRuleHintFields(['x-amz-(?:aaa|bbb):'], false, false, ['X-AMZ-']).legacyHints, [])
  assert.deepEqual(buildRuleHintFields(['x-amz-(?:aaa|bbb):'], false, false, ['cloudfront']).legacyHints, ['cloudfront'])
  // 旧版只看规则自身的 matchType：继承来的关键词仍按正则拆段
  assert.deepEqual(buildRuleHintFields(['vue.js'], true, false), { hints: ['vue.js'], legacyHints: [] })
  // 提取不到健全 hint 时旧门槛照旧生效
  assert.deepEqual(buildRuleHintFields(['typecho', '\\d+\\.\\d+'], false, false).legacyHints, ['typecho'])
})

test('扫描器查得到长 hint、短 hint 和含换行的 hint', () => {
  const scanner = createHintScanner(['typecho', 'wp-json', 'abc', 'x\ny'])
  const lookup = scanner.scan('head x\ny tail /wp-json/ abc'.toLowerCase())
  assert.equal(lookup('wp-json'), true)
  assert.equal(lookup('abc'), true)
  assert.equal(lookup('x\ny'), true)
  assert.equal(lookup('typecho'), false)
  // 没进索引的 hint 直接在文本里找
  assert.equal(lookup('tail'), true)
  assert.equal(lookup('missing'), false)
  // 文本末尾的 hint 也要扫到
  assert.equal(scanner.scan('xx typecho').call(null, 'typecho'), true)
  assert.equal(scanner.scan('').call(null, 'typecho'), false)
})

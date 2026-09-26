// 规则预筛用的 hint：从正则里提取“必需字面量集合”——正则能命中的文本（转小写后）一定包含集合里至少一个字符串。
// 构建脚本、Service Worker、注入页面的检测脚本共用这份实现，保证预筛不会挡掉真正能命中的规则。

const MIN_HINT_LENGTH = 3
const MAX_SET_SIZE = 24
const MAX_STRING_LENGTH = 48
const MAX_CLASS_CHARS = 4

// 页面 / 响应头里几乎总会出现的词：由它们拼成的 hint 基本筛不掉规则，挑选时排在后面
const GENERIC_TOKENS = new Set([
  'http',
  'https',
  'www',
  'com',
  'net',
  'org',
  'cdn',
  'static',
  'assets',
  'asset',
  'script',
  'scripts',
  'style',
  'styles',
  'generator',
  'content',
  'meta',
  'title',
  'link',
  'href',
  'src',
  'name',
  'class',
  'rel',
  'type',
  'js',
  'css',
  'min',
  'index',
  'api',
  'set',
  'cookie',
  'server',
  'powered',
  'cache',
  'via',
  'expires',
  'control',
  'encoding',
  'length',
  'date',
  'vary',
  'accept',
  'url',
  'image',
  'images',
  'img',
  'theme',
  'themes',
  'plugin',
  'plugins',
  'common',
  'main',
  'app',
  'data',
  'version',
  'config',
  'application',
  'text',
  'javascript',
  'window',
  'document',
  'function',
  'return',
  'json',
  'html',
  'body',
  'head',
  'div',
  'span',
  'true',
  'false',
  'null',
  'user',
  'login',
  'page',
  'home',
  'public',
  'files',
  'file',
  'upload',
  'uploads',
  'media',
  'vendor',
  'dist',
  'build',
  'lib',
  'libs',
  'modules',
  'module',
  'default',
  'template',
  'templates'
])

const isGenericHint = (value: string): boolean =>
  value
    .split(/[^a-z0-9一-龥]+/)
    .filter(Boolean)
    .every(token => token.length <= 2 || GENERIC_TOKENS.has(token))

// ---------- 解析：只关心字面量，其余一律当作“任意字符” ----------

type RegexNode =
  | { type: 'lit'; value: string }
  | { type: 'set'; chars: string[] }
  | { type: 'any' }
  | { type: 'anchor' }
  | { type: 'look'; node: RegexNode; negative: boolean }
  | { type: 'group'; node: RegexNode }
  | { type: 'rep'; node: RegexNode; min: number; max: number }
  | { type: 'alt'; options: RegexNode[] }
  | { type: 'seq'; items: RegexNode[] }

class UnsupportedPattern extends Error {}

// i 模式下非 ASCII 字母可能和别的字符互相匹配（如 µ 与 μ、σ 与 ς），转小写后未必是同一个字符，只当作任意字符
const isCaseUnstable = (char: string): boolean => char.charCodeAt(0) > 127 && char.toLowerCase() !== char.toUpperCase()

const literalNode = (char: string): RegexNode => (isCaseUnstable(char) ? { type: 'any' } : { type: 'lit', value: char.toLowerCase() })

const parseRegex = (source: string): RegexNode => {
  let index = 0
  const peek = () => source[index]
  const eat = () => source[index++]

  const decodeEscape = (escaped: string | undefined): string | null => {
    if (escaped === undefined) throw new UnsupportedPattern('结尾的反斜杠')
    if (escaped === 'n') return '\n'
    if (escaped === 'r') return '\r'
    if (escaped === 't') return '\t'
    if (escaped === 'f') return '\f'
    if (escaped === 'v') return '\v'
    if (/[0-9]/.test(escaped)) {
      // \0 是空字符；其余数字转义是反向引用或旧式八进制，连同后面的数字一起当作任意字符
      if (escaped === '0' && !/[0-9]/.test(peek() ?? '')) return '\0'
      while (/[0-9]/.test(peek() ?? '')) eat()
      return null
    }
    if (escaped === 'x' || escaped === 'u') {
      const size = escaped === 'x' ? 2 : 4
      const hex = source.slice(index, index + size)
      if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) return escaped
      index += size
      return String.fromCharCode(parseInt(hex, 16))
    }
    if (escaped === 'c') {
      // \cX 是控制字符，字母一起跳过
      if (/[a-zA-Z]/.test(peek() ?? '')) eat()
      return null
    }
    return escaped
  }

  const parseClass = (): RegexNode => {
    let wide = false
    if (peek() === '^') {
      eat()
      wide = true
    }
    const chars = new Set<string>()
    let first = true
    while (index < source.length) {
      const char = eat()
      if (char === ']' && !first) {
        return wide || chars.size > MAX_CLASS_CHARS ? { type: 'any' } : { type: 'set', chars: [...chars] }
      }
      first = false
      let value: string | null = char
      if (char === '\\') {
        const escaped = eat()
        if (escaped !== undefined && 'dDwWsSbB'.includes(escaped)) {
          wide = true
          continue
        }
        value = decodeEscape(escaped)
        if (value === null) {
          wide = true
          continue
        }
      }
      if (peek() === '-' && source[index + 1] !== undefined && source[index + 1] !== ']') {
        eat()
        if (eat() === '\\') eat()
        wide = true
        continue
      }
      if (isCaseUnstable(value)) {
        wide = true
        continue
      }
      chars.add(value.toLowerCase())
    }
    throw new UnsupportedPattern('未闭合的字符类')
  }

  const parseAtom = (): RegexNode => {
    const char = eat()
    if (char === '(') {
      let look = false
      let negative = false
      if (peek() === '?') {
        eat()
        const next = eat()
        if (next === '=' || next === '!') {
          look = true
          negative = next === '!'
        } else if (next === '<') {
          const after = eat()
          if (after === '=' || after === '!') {
            look = true
            negative = after === '!'
          } else {
            while (index < source.length && peek() !== '>') eat()
            eat()
          }
        } else if (next !== ':') {
          throw new UnsupportedPattern('不支持的分组')
        }
      }
      const node = parseAlternation()
      if (eat() !== ')') throw new UnsupportedPattern('未闭合的分组')
      return look ? { type: 'look', node, negative } : { type: 'group', node }
    }
    if (char === ')' || char === '*' || char === '+' || char === '?') throw new UnsupportedPattern('位置不对的元字符')
    if (char === '[') return parseClass()
    if (char === '.') return { type: 'any' }
    if (char === '^' || char === '$') return { type: 'anchor' }
    if (char === '\\') {
      const escaped = eat()
      if (escaped === 'b' || escaped === 'B') return { type: 'anchor' }
      if (escaped === 'k' && peek() === '<') {
        // 命名反向引用 \k<name>
        const close = source.indexOf('>', index)
        index = close < 0 ? source.length : close + 1
        return { type: 'any' }
      }
      if (escaped !== undefined && 'dDwWsSk'.includes(escaped)) return { type: 'any' }
      const value = decodeEscape(escaped)
      return value === null ? { type: 'any' } : literalNode(value)
    }
    return literalNode(char)
  }

  const parseQuantified = (): RegexNode => {
    const atom = parseAtom()
    let min = 1
    let max = 1
    const char = peek()
    if (char === '*') {
      eat()
      min = 0
      max = Infinity
    } else if (char === '+') {
      eat()
      max = Infinity
    } else if (char === '?') {
      eat()
      min = 0
    } else if (char === '{') {
      const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(index))
      if (!match) return atom
      index += match[0].length
      min = Number(match[1])
      max = match[2] ? (match[3] ? Number(match[3]) : Infinity) : min
    } else {
      return atom
    }
    if (peek() === '?') eat()
    if (atom.type === 'anchor') return atom
    // 可以出现零次的环视不起约束作用
    if (atom.type === 'look') return min === 0 ? { type: 'anchor' } : atom
    return { type: 'rep', node: atom, min, max }
  }

  const parseSequence = (): RegexNode => {
    const items: RegexNode[] = []
    while (index < source.length && peek() !== '|' && peek() !== ')') items.push(parseQuantified())
    return { type: 'seq', items }
  }

  const parseAlternation = (): RegexNode => {
    const options = [parseSequence()]
    while (peek() === '|') {
      eat()
      options.push(parseSequence())
    }
    return options.length === 1 ? options[0] : { type: 'alt', options }
  }

  const tree = parseAlternation()
  if (index !== source.length) throw new UnsupportedPattern('多余的右括号')
  return tree
}

// ---------- 分析 ----------

// 集合里一个字符串包含另一个时，只留短的：文本含长的必然含短的
const reduceSet = (strings: string[]): string[] => {
  const kept: string[] = []
  for (const value of [...new Set(strings)].sort((a, b) => a.length - b.length)) {
    if (!kept.some(shorter => value.includes(shorter))) kept.push(value)
  }
  return kept
}

const longestCommonSubstring = (strings: string[]): string => {
  const [shortest, ...rest] = [...strings].sort((a, b) => a.length - b.length)
  for (let size = shortest.length; size >= MIN_HINT_LENGTH; size--) {
    for (let start = 0; start + size <= shortest.length; start++) {
      const candidate = shortest.slice(start, start + size)
      if (rest.every(value => value.includes(candidate))) return candidate
    }
  }
  return ''
}

const isUsefulSet = (set: string[] | null): set is string[] =>
  Boolean(set && set.length && set.every(value => value.length >= MIN_HINT_LENGTH))

// 成员越多扣分越多：索引和规则文件都跟着变大，而多出来的选择性很少用得上
const scoreSet = (set: string[]): number => {
  const minLength = Math.min(...set.map(value => value.length))
  return Math.min(minLength, 14) * 10 - (set.length - 1) * 10 - (set.some(isGenericHint) ? 200 : 0)
}

// 选项很多时（如 cdn|fastly|gcore × 各种后缀、同一个包在七八个 CDN 上的地址），所有选项共有的一段也是必需的，写出来更短
const compactSet = (set: string[]): string[] => {
  if (set.length <= 4) return set
  const common = longestCommonSubstring(set)
  return common && scoreSet([common]) >= scoreSet(set) ? [common] : set
}

const pickBetter = (current: string[] | null, candidate: string[] | null): string[] | null => {
  if (!isUsefulSet(candidate)) return current
  const reduced = compactSet(reduceSet(candidate))
  if (!current) return reduced
  const better = scoreSet(reduced) - scoreSet(current)
  return better > 0 || (better === 0 && reduced.length < current.length) ? reduced : current
}

const crossProduct = (left: string[], right: string[]): string[] | null => {
  if (left.length * right.length > MAX_SET_SIZE) return null
  const out = new Set<string>()
  for (const a of left) {
    for (const b of right) {
      const value = a + b
      if (value.length > MAX_STRING_LENGTH) return null
      out.add(value)
    }
  }
  return [...out]
}

type Analysis = { exact: string[] | null; best: string[] | null }

// exact：节点能匹配到的全部完整字符串（有限且不多时）；best：节点自身最好的必需集合
const analyze = (node: RegexNode): Analysis => {
  switch (node.type) {
    case 'lit':
      return { exact: [node.value], best: null }
    case 'set':
      return { exact: node.chars, best: null }
    case 'any':
      return { exact: null, best: null }
    case 'anchor':
      return { exact: [''], best: null }
    case 'look': {
      if (node.negative) return { exact: [''], best: null }
      const inner = analyze(node.node)
      return { exact: [''], best: pickBetter(inner.best, inner.exact) }
    }
    case 'group':
      return analyze(node.node)
    case 'rep': {
      const inner = analyze(node.node)
      if (node.min === 0) {
        return node.max === 1 && inner.exact ? { exact: [...new Set(['', ...inner.exact])], best: null } : { exact: null, best: null }
      }
      if (node.min === 1 && node.max === 1) return inner
      return { exact: null, best: pickBetter(inner.best, inner.exact) }
    }
    case 'alt': {
      const parts = node.options.map(analyze)
      let exact: string[] | null = []
      for (const part of parts) {
        if (!part.exact || !exact) {
          exact = null
          break
        }
        exact.push(...part.exact)
        if (exact.length > MAX_SET_SIZE) exact = null
      }
      let best: string[] | null = []
      for (const part of parts) {
        const necessary = pickBetter(part.best, part.exact)
        if (!necessary) {
          best = null
          break
        }
        best.push(...necessary)
      }
      return { exact: exact ? [...new Set(exact)] : null, best: best && best.length ? reduceSet(best) : null }
    }
    case 'seq': {
      let run = ['']
      let allExact = true
      let best: string[] | null = null
      for (const item of node.items) {
        const info = analyze(item)
        if (info.best) best = pickBetter(best, info.best)
        if (info.exact) {
          const next = crossProduct(run, info.exact)
          if (next) {
            run = next
            continue
          }
          best = pickBetter(best, run)
          run = info.exact.length <= MAX_SET_SIZE ? info.exact : ['']
        } else {
          best = pickBetter(best, run)
          run = ['']
        }
        allExact = false
      }
      return { exact: allExact ? run : null, best: pickBetter(best, run) }
    }
  }
}

// 单个正则的必需字面量集合；null 表示提取不到，只能直接跑正则
export const extractRegexHints = (source: string): string[] | null => {
  try {
    const info = analyze(parseRegex(String(source)))
    return pickBetter(info.best, info.exact)
  } catch {
    return null
  }
}

// 关键词里大小写稳定的最长一段（转小写）
const longestStableRun = (keyword: string): string => {
  let best = ''
  let run = ''
  for (const char of keyword) {
    if (isCaseUnstable(char)) {
      run = ''
      continue
    }
    run += char.toLowerCase()
    if (run.length > best.length) best = run
  }
  return best
}

// 整条规则：任一 pattern 命中规则就命中，所以取各 pattern 集合的并集；有一个 pattern 提取不到就放弃预筛
export const extractRuleHints = (patterns: unknown, isKeyword = false): string[] => {
  if (!Array.isArray(patterns) || !patterns.length) return []
  const all: string[] = []
  for (const pattern of patterns) {
    const text = String(pattern ?? '')
    if (isKeyword) {
      // 合并匹配时关键词去掉首尾空白；空关键词在逐条匹配时能命中任何文本
      const keyword = text.trim()
      if (!keyword) return []
      const hint = longestStableRun(keyword)
      if (hint.length < MIN_HINT_LENGTH) return []
      all.push(hint)
      continue
    }
    // 空正则能匹配任何文本
    const set = text ? extractRegexHints(text) : null
    if (!set) return []
    all.push(...set)
  }
  return compactSet(reduceSet(all))
}

// ---------- 旧版预筛门槛 ----------
// 1.3.79 及以前按“最长的 3 段字面量”预筛：字面量可能来自可选分支，文本里没有这几段时整条规则都不跑，
// 约 1300 条规则的部分 pattern 实际从未生效。直接放开会冒出不少误报，先原样保留旧门槛，识别结果不变；
// 规则逐条审查后再去掉
const LEGACY_HINT_MIN_LENGTH = 4
const LEGACY_HINT_MAX_COUNT = 3

export const extractLegacyRuleHints = (patterns: unknown, isKeyword = false): string[] => {
  if (!Array.isArray(patterns) || !patterns.length) return []
  const candidates: string[] = []
  for (const pattern of patterns) {
    const text = String(pattern || '')
    if (!text) continue
    if (isKeyword) {
      const lower = text.toLowerCase().trim()
      if (lower.length >= LEGACY_HINT_MIN_LENGTH) candidates.push(lower)
      continue
    }
    for (const segment of text.replace(/\\[bBdDsSwW]/g, ' ').split(/[\\^$.|?*+()[\]{}]/)) {
      const lower = segment.toLowerCase().replace(/\s+/g, ' ').trim()
      if (lower.length >= LEGACY_HINT_MIN_LENGTH) candidates.push(lower)
    }
  }
  return [...new Set(candidates)].sort((a, b) => b.length - a.length).slice(0, LEGACY_HINT_MAX_COUNT)
}

export interface RuleHintFields {
  hints: string[]
  legacyHints: string[]
}

// 构建期写进规则的两组 hint。handwritten 是规则文件里手写的 __hints，旧版构建直接拿它当门槛；
// legacyKeyword 沿用旧版只看规则自身 matchType 的判断（不看规则组 defaults）
export const buildRuleHintFields = (
  patterns: unknown,
  isKeyword: boolean,
  legacyKeyword: boolean,
  handwritten?: unknown
): RuleHintFields => {
  const hints = extractRuleHints(patterns, isKeyword)
  const legacy =
    Array.isArray(handwritten) && handwritten.length
      ? handwritten.map(hint => String(hint).toLowerCase())
      : extractLegacyRuleHints(patterns, legacyKeyword)
  // 每个健全 hint 都含某个旧 hint 时，过了健全预筛必然过旧门槛，旧门槛不用再写
  const redundant = !legacy.length || (hints.length > 0 && hints.every(hint => legacy.some(old => hint.includes(old))))
  return { hints, legacyHints: redundant ? [] : legacy }
}

// ---------- 扫描：一次遍历文本，查出哪些 hint 出现过 ----------

const INDEX_KEY_LENGTH = 4

const keyAt = (text: string, index: number): number =>
  ((text.charCodeAt(index) << 21) ^ (text.charCodeAt(index + 1) << 14) ^ (text.charCodeAt(index + 2) << 7) ^ text.charCodeAt(index + 3)) &
  0x3fffffff

export type HintLookup = (hint: string) => boolean

export interface HintScanner {
  scan: (lowerText: string) => HintLookup
}

// 同一批规则的 hint 建一个索引：每个 hint 在开头、中间、结尾三处 4 个字符里挑当前桶最小的一处做键，
// 避免 cdn.jsdelivr.net/npm/… 这类同前缀的 hint 全挤进一个桶；扫描时逐位置查桶再核对，文本只走一遍。
// 不足 4 个字符或含换行的 hint 不进索引，查询时直接在文本里找并缓存结果
export const createHintScanner = (hints: Iterable<string>): HintScanner => {
  const buckets = new Map<number, Array<{ hint: string; offset: number }>>()
  const indexed = new Set<string>()
  for (const raw of hints) {
    const hint = String(raw || '').toLowerCase()
    if (hint.length < INDEX_KEY_LENGTH || hint.includes('\n') || indexed.has(hint)) continue
    indexed.add(hint)
    const last = hint.length - INDEX_KEY_LENGTH
    let offset = 0
    let key = keyAt(hint, 0)
    let size = buckets.get(key)?.length ?? 0
    for (const candidate of [last, last >> 1]) {
      if (!size) break
      const candidateKey = keyAt(hint, candidate)
      const candidateSize = buckets.get(candidateKey)?.length ?? 0
      if (candidateSize < size) {
        offset = candidate
        key = candidateKey
        size = candidateSize
      }
    }
    const bucket = buckets.get(key)
    if (bucket) bucket.push({ hint, offset })
    else buckets.set(key, [{ hint, offset }])
  }
  return {
    scan(lowerText) {
      const present = new Set<string>()
      for (let index = 0, end = lowerText.length - INDEX_KEY_LENGTH + 1; index < end; index++) {
        const bucket = buckets.get(keyAt(lowerText, index))
        if (!bucket) continue
        for (const { hint, offset } of bucket) {
          const start = index - offset
          if (start >= 0 && !present.has(hint) && lowerText.startsWith(hint, start)) present.add(hint)
        }
      }
      const direct = new Map<string, boolean>()
      return hint => {
        if (indexed.has(hint)) return present.has(hint)
        let hit = direct.get(hint)
        if (hit === undefined) {
          hit = lowerText.includes(hint)
          direct.set(hint, hit)
        }
        return hit
      }
    }
  }
}

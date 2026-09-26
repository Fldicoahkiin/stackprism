import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectHeaders, expandRules, loadHeaderRules, loadHeadersModule, pageRuleMatches, readRuleFile } from './helpers/rule-harness.mjs'

const WAF = 'WAF / 防火墙'

const headerCases = [
  [
    '雷池挑战页',
    'SafeLine / 雷池 WAF',
    { Server: 'Tengine', 'Set-Cookie': 'sl-session=tFH5Up20uGp0L2I/3q30TQ==; SameSite=None; Secure; Path=/' }
  ],
  [
    '雷池放行后的页面',
    'SafeLine / 雷池 WAF',
    { server: 'Tengine', 'set-cookie': 'sl_jwt_sign=fv2fe/Ig0rqC8uLK3VcM;SameSite=None; Secure; Path=/' }
  ],
  ['雷池 Cookie 排在后面', 'SafeLine / 雷池 WAF', { 'set-cookie': ['a=1; Path=/', 'sl_jwt_session=abc; Path=/'] }],
  ['雷池 challenge-server', 'SafeLine / 雷池 WAF', { 'set-cookie': 'sl-challenge-server=cloud; Path=/' }],
  ['雷池官网', null, { server: 'Tengine', eagleid: '7ac1831817904048095191236e', via: 'kunlun4.cn9530[122,0]' }],
  ['相似 Cookie 名', null, { 'set-cookie': ['xsl-session=1', 'my_sl_jwt_signature=2', 'sl-sessions=3'] }],
  ['安全狗 Cookie', 'Safedog / 安全狗', { 'set-cookie': 'safedog-flow-item=B997255C2337E9B4E56A9ECAB186C267; path=/' }],
  ['安全狗 Server', 'Safedog / 安全狗', { server: 'Safedog' }],
  ['云锁', 'Yunsuo / 云锁', { 'set-cookie': 'yunsuo_session_verify=1a3375389647fba22b7902b9fb4ace23; path=/' }],
  ['加速乐 X-Via-JSL', 'Jiasule / 知道创宇加速乐', { 'x-via-jsl': 'd8c5e31,-' }],
  ['加速乐 Server', 'Jiasule / 知道创宇加速乐', { server: 'jiasule-WAF' }],
  ['加速乐 Cookie', 'Jiasule / 知道创宇加速乐', { 'set-cookie': '__jsluid_s=59576d8aec12dcd0b8d7ace276153a5c; path=/' }],
  ['网站卫士 WZWS-Ray', '360 网站卫士 / 奇安信网站卫士', { 'WZWS-Ray': '1234-1690000000.123' }],
  ['网站卫士 Cookie', '360 网站卫士 / 奇安信网站卫士', { 'set-cookie': 'wzws_cid=0e8a3a4fc1ee26c938be62c387030beb6; path=/' }],
  ['360 磐云', '360 PanYun / 360 磐云', { server: 'panyun/2.4.1' }],
  ['YUNDUN', 'YUNDUN / 云盾 WAF', { 'x-cache': 'HIT from YUNDUN' }],
  ['阿里云 WAF', 'Alibaba Cloud WAF / 阿里云 WAF', { 'set-cookie': 'acw_tc=2760827c17904048095191236e;path=/;HttpOnly' }],
  ['华为云 WAF Server', 'Huawei Cloud WAF / 华为云 WAF', { server: 'HuaweiCloudWAF' }],
  ['绿盟', 'NSFOCUS WAF / 绿盟 WAF', { server: 'NSFocus' }],
  ['蓝盾', 'Bluedon WAF / 蓝盾 WAF', { server: 'BDWAF/2.0' }],
  ['AWS WAF', 'AWS WAF', { 'x-amzn-waf-action': 'challenge' }],
  ['F5 ASM', 'F5 BIG-IP ASM', { 'set-cookie': 'TS01a2b3c4=01e6d3f9a8b7; Path=/' }],
  ['小写 ts Cookie', null, { 'set-cookie': 'ts20240101=1; Path=/' }],
  ['Barracuda', 'Barracuda WAF', { 'set-cookie': 'barra_counter_session=123; path=/' }],
  ['Barracuda BNI', 'Barracuda WAF', { 'set-cookie': 'BNI_persistence=abc; path=/' }],
  ['FortiWeb', 'FortiWeb', { 'set-cookie': 'FORTIWAFSID=abc; path=/' }],
  ['NetScaler', 'NetScaler AppFirewall', { cneonction: 'close' }],
  ['Radware', 'Radware AppWall', { 'x-sl-compstate': '1' }],
  ['Reblaze', 'Reblaze', { 'set-cookie': 'rbzid=abc; path=/' }],
  ['Wallarm', 'Wallarm', { server: 'nginx-wallarm' }],
  ['ModSecurity', 'ModSecurity', { server: 'Apache/2.4.41 (Unix) Mod_Security/2.9' }],
  ['NAXSI', 'NAXSI', { 'x-data-origin': 'naxsi-waf' }],
  ['Imunify360', 'Imunify360', { server: 'imunify360-webshield/1.21' }],
  ['DDoS-Guard', 'DDoS-Guard', { 'set-cookie': ['__ddg1_=Ugw1h8FzFgIdsoFRF8oF; Path=/', '__ddg9_=1.2.3.4; Path=/'] }],
  ['Qrator', 'Qrator', { server: 'QRATOR' }],
  ['Comodo', 'Comodo cWatch WAF', { server: 'Protected by COMODO WAF' }],
  ['Shieldon', 'Shieldon', { 'x-protected-by': 'shieldon.io' }],
  ['普通站点', null, { server: 'nginx/1.25.3', 'set-cookie': 'PHPSESSID=abc; path=/', 'x-cache': 'HIT' }],
  ['Cloudflare', null, { server: 'cloudflare', 'cf-ray': '8a1b2c3d4e5f-HKG', 'set-cookie': '__cf_bm=abc; path=/' }]
]

test('WAF 响应头规则经过构建期 hint 预筛后按单个特征命中', async () => {
  const headersModule = await loadHeadersModule()
  const headerRules = loadHeaderRules()
  for (const [label, expected, headers] of headerCases) {
    const technologies = detectHeaders(headersModule, headerRules, headers)
    const wafNames = technologies.filter(tech => tech.category === WAF).map(tech => tech.name)
    if (expected === null) assert.deepEqual(wafNames, [], label)
    else assert.ok(wafNames.includes(expected), `${label}: ${JSON.stringify(technologies.map(tech => tech.name))}`)
  }
})

test('华为云 WAF 的 Server 头不再归到华为云 CDN', async () => {
  const technologies = detectHeaders(await loadHeadersModule(), loadHeaderRules(), { server: 'HuaweiCloudWAF' })
  assert.deepEqual(
    technologies.map(tech => `${tech.category}::${tech.name}`),
    [`${WAF}::Huawei Cloud WAF / 华为云 WAF`]
  )
})

const pageRules = expandRules(readRuleFile('page/waf-page.json').page.saasServices)
const matchedPageRuleNames = text => [...new Set(pageRules.filter(rule => pageRuleMatches(rule, text)).map(rule => rule.name))]

test('WAF 页面规则只认验证页 / 拦截页的专属资源和结构', () => {
  assert.equal(
    pageRules.every(rule => rule.category === WAF),
    true
  )
  const positives = [
    ['https://challenge.rivers.chaitin.cn/challenge/v2/challenge.js', 'SafeLine / 雷池 WAF'],
    ['https://bt.sb/.safeline/challenge/v2/challenge.js', 'SafeLine / 雷池 WAF'],
    ['https://example.com/renji_296d626f_0cc175b9c0f1b6a831c399e269772661.js?id=1', 'BT WAF / 宝塔网站防火墙'],
    ['https://example.com/huadong_296d626f_0cc175b9c0f1b6a831c399e269772661.js?id=1', 'BT WAF / 宝塔网站防火墙'],
    ['https://example.com/Rxizm32rm3CPpyyW_fingerprint2daasdsaaa.js?id=1', 'BT WAF / 宝塔网站防火墙'],
    ['https://example.com/btwaf_aes_forge_6d7584ebbc8099962ec31133b1a1bdde.js', 'BT WAF / 宝塔网站防火墙'],
    ['https://41bcdd4fb3cb.610cd090.us-east-1.token.awswaf.com/41bcdd4fb3cb/0d21de737ccb/challenge.js', 'AWS WAF'],
    ['https://example.com/.well-known/ddos-guard/check?context=free_splash', 'DDoS-Guard'],
    ['http://404.safedog.cn/images/safedogsite/head.png', 'Safedog / 安全狗'],
    ['https://g.alicdn.com/sd-base/static/1.0.5/image/405.png', 'Alibaba Cloud WAF / 阿里云 WAF'],
    ['https://waf.tencent-cloud.com/501page.html', 'Tencent Cloud WAF / 腾讯云 WAF'],
    [
      '<html><head><title>网站防火墙</title></head><body><p class="t1">您的请求带有不合法参数，已被网站管理员设置拦截！</p></body></html>',
      'BT WAF / 宝塔网站防火墙'
    ],
    ['<a href="https://help.365cyd.com/cyd-error-help.html?code=403">', 'Chuangyu Shield / 创宇盾'],
    ['<form action="/wzws-waf-cgi/" method="post">', '360 网站卫士 / 奇安信网站卫士']
  ]
  for (const [text, expected] of positives) assert.deepEqual(matchedPageRuleNames(text), [expected], text)

  const negatives = [
    'https://waf-ce.chaitin.cn/api/safeline/count',
    'https://rivers.chaitin.cn/discussion?from=waf-ce.chaitin.cn',
    '<p>把 /.safeline 目录放行即可</p>',
    '<title>宝塔网站防火墙使用教程</title><p>已被网站管理员设置拦截的请求怎么排查</p>',
    '<p>help.365cyd.com/cyd-error-help 是创宇盾的报错说明</p>'
  ]
  for (const text of negatives) assert.deepEqual(matchedPageRuleNames(text), [], text)

  // 雷池验证页自带 sl-loader-dot / sl-dot 类名，Shoelace 只认主题类
  const shoelace = expandRules(readRuleFile('page/frontend-extra.json').page.frontendExtra).find(rule => rule.name === 'Shoelace')
  assert.equal(
    shoelace.classPrefixes.some(prefix => ['sl-loader-dot', 'sl-dot'].some(name => name.startsWith(prefix))),
    false
  )
  assert.equal(
    shoelace.classPrefixes.some(prefix => 'sl-theme-dark'.startsWith(prefix)),
    true
  )
})

const findRule = (file, key, name) => expandRules(readRuleFile(file).page[key]).find(rule => rule.name === name)

test('bt.sb 的 Rhex 论坛程序可识别，随机 ID 和 sonner 样式不再误判', () => {
  const rhex = findRule('page/website-programs-extra.json', 'websitePrograms', 'Rhex')
  assert.deepEqual(rhex.globals, ['_rhex', '__RHEX_PRELOADED_READING_HISTORY__'])
  assert.equal(pageRuleMatches(rhex, '(function(){})("class","rhex-theme","light",null,["light","dark"],null,true,true)'), true)
  assert.equal(pageRuleMatches(rhex, 'https://bt.sb/api/addons/global-layout-slots?pathname=%2F'), true)
  assert.equal(pageRuleMatches(rhex, 'https://example.com/rhexagon-theme.css'), false)

  const hexo = findRule('page/website-programs.json', 'websitePrograms', 'Hexo')
  assert.equal(pageRuleMatches(hexo, 'highlight=cmuh33bk03hthny0uhexo9lcz#comment-cmuh33bk03hthny0uhexo9lcz'), false)
  assert.equal(pageRuleMatches(hexo, '<meta name="generator" content="Hexo 7.3.0">'), true)
  assert.equal(pageRuleMatches(hexo, 'https://cdn.jsdelivr.net/npm/hexo-theme-fluid@1.9.8/source/js/boot.js'), true)

  const styled = findRule('page/ui-frameworks.json', 'uiFrameworks', 'styled-components')
  assert.equal(pageRuleMatches(styled, '<style>[data-sonner-toast][data-styled=true]{padding:16px}</style>'), false)
  assert.equal(pageRuleMatches(styled, '<style data-styled="active" data-styled-version="6.1.8">'), true)
})

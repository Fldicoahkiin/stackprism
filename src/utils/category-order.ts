export const CATEGORY_ORDER: readonly string[] = [
  '前端框架',
  'UI / CSS 框架',
  '前端库',
  '构建与运行时',
  'CDN / 托管',
  'WAF / 防火墙',
  'Web 服务器',
  '后端 / 服务器框架',
  '开发语言 / 运行时',
  '网站程序',
  '主题 / 模板',
  '网站源码线索',
  '探针 / 监控',
  'CMS / 电商平台',
  'RSS / 订阅',
  'SaaS / 第三方服务',
  'AI / 大模型',
  '第三方登录 / OAuth',
  '支付系统',
  '广告 / 营销',
  '统计 / 分析',
  '分析与标签',
  '安全与协议',
  '其他库'
]

export const categoryIndex = (category: string): number => {
  const index = CATEGORY_ORDER.indexOf(category)
  return index === -1 ? CATEGORY_ORDER.length : index
}

export const confidenceRank = (value: string): number => {
  if (value === '高') return 0
  if (value === '中') return 1
  return 2
}

export const confidenceClass = (value: string): 'high' | 'medium' | 'low' => {
  if (value === '高') return 'high'
  if (value === '中') return 'medium'
  return 'low'
}

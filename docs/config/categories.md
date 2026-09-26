# 识别开关

设置页第一块是分类开关。每个 checkbox 对应一个分类，关掉后弹窗里不再显示该分类下的技术，包括内置规则和自定义规则。

## 全部分类

| 分类              | 包含示例                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| 前端框架          | React、Vue、Angular、Next.js、Nuxt、Gatsby、Remix、SvelteKit、Astro       |
| UI / CSS 框架     | Tailwind CSS、Bootstrap、Material UI、Ant Design、Element Plus、Chakra UI |
| 构建运行时        | Webpack、Vite、Rollup、Parcel、esbuild、SWC、Turbopack、Bun               |
| CDN / 托管        | Cloudflare、Akamai、Fastly、AWS CloudFront、Vercel、Netlify、jsDelivr     |
| WAF / 防火墙      | 雷池 SafeLine、宝塔网站防火墙、安全狗、云锁、阿里云 WAF、AWS WAF          |
| 后端框架          | Django、Flask、Rails、Laravel、Express、Koa、Spring、ASP.NET              |
| 网站程序          | WordPress、Drupal、Discuz!、Typecho、ZBlog、phpBB、MediaWiki              |
| 主题 / 模板       | WordPress 主题、Drupal 主题、CMS 模板路径反推                             |
| 开发语言 / 运行时 | PHP、Node.js、Python、Ruby、Java、Go、Rust                                |
| 统计 / 分析       | Google Analytics、百度统计、友盟、Plausible、Umami                        |
| 第三方登录        | Google 登录、GitHub OAuth、微信登录、Auth0、Clerk                         |
| 支付系统          | Stripe、PayPal、支付宝、微信支付、银联                                    |
| 广告营销          | Google Ads、Facebook Pixel、TikTok Pixel                                  |
| SaaS 服务         | Sentry、Mixpanel、Intercom、Crisp、HubSpot                                |
| AI / 大模型       | Open WebUI、Dify、Flowise、Gradio、ComfyUI                                |
| 探针 / 监控       | New Relic、Datadog、Pingdom、Hotjar                                       |
| RSS / 订阅        | RSS、Atom、JSON Feed                                                      |
| WordPress 插件    | 4500+ 个具名插件                                                          |
| Drupal 模块       | 4000+ 个具名模块                                                          |
| 安全与协议        | HTTPS、CSP、Service Worker                                                |
| 其他库            | 自定义规则默认归类、未明确分类的兜底                                      |
| ... 等共 24 类    |

完整列表：`src/utils/category-order.ts` 的 `CATEGORY_ORDER` 数组。

## 全开 / 全关

右上角有「全开」「全关」两个按钮，用来批量勾选或取消所有分类。

## 关闭分类的常见用途

- **只看技术栈，不看插件**：关「WordPress 插件」「Drupal 模块」，避免插件名把列表撑得太长
- **只看后端不看前端**：关掉前端框架 / UI 框架 / 构建运行时
- **过滤通用 SaaS**：关「广告营销」「统计 / 分析」聚焦核心技术栈

## 实现细节

被关闭的分类不会从 raw JSON 里删除。`原始线索` 面板仍能看到完整识别结果。识别开关只影响弹窗主列表的显示。

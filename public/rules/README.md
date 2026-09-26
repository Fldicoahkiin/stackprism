# 规则目录

`rules/index.json` 是规则加载清单。插件会按清单里的顺序读取每个 JSON 文件，并合并成运行时使用的完整规则。

- `page/`：页面源码、DOM、资源 URL、动态新增资源、前端框架、UI 框架、构建运行时、第三方脚本、支付登录、广告统计、CMS 主题等规则。
- `headers/`：响应头、Server、X-Powered-By、Cookie、CDN 头、后端语言和网站程序等规则。

新增规则时优先改已有分类文件。只有确实需要新分类文件时，才新建 JSON，并把相对路径写入 `index.json` 的 `files` 数组。

页面规则可使用 `patterns`、`globals`、`selectors`、`classPrefixes`、`classNames`、`cssVariables` 等字段。像 shadcn/ui 这类依赖全局 CSS 变量的技术，可以用 `cssVariables` 配合 `minCssVariableMatches` 做成组变量匹配，减少误报。

当同一个规则文件里的 `category`、`kind`、`confidence`、`matchType`、`resourceOnly`、`resourceHints` 等字段高度重复时，可以使用规则组写法，把公共字段放到 `defaults`，具体规则放到 `rules`。加载器会在运行时把默认值展开成完整规则，检测逻辑仍然按普通规则数组处理。

规则组可以嵌套使用：外层放整个分类都相同的字段，例如 `matchType`、`resourceOnly`；内层再按连续规则段放相同的 `category`、`kind` 或 `confidence`。这样能减少人工维护时的重复字段，同时保持展开后的规则对象不变。

```json
{
  "page": {
    "frontendExtra": {
      "defaults": {
        "category": "前端库",
        "confidence": "中",
        "matchType": "keyword",
        "resourceOnly": true,
        "resourceHints": ["cdnjs.cloudflare.com/ajax/libs/"]
      },
      "rules": [
        {
          "name": "example",
          "patterns": ["cdnjs.cloudflare.com/ajax/libs/example/"]
        }
      ]
    }
  }
}
```

`page/frontend-cdn-libraries.json` 是根据 cdnjs 公开 API 生成的前端库规则，尽量覆盖当前可枚举且适合路径匹配的库名。生成规则默认使用 `resourceOnly: true`，只匹配页面加载过的资源 URL，不扫描整页源码。刷新这类规则时请用本地维护脚本重新生成，不要手工逐条改生成文件；本地工具脚本默认不提交到仓库。

`page/frontend-package-cdn-libraries.json` 是基于同一批前端库名称扩展出的公共 npm 包 CDN 规则，覆盖 jsDelivr、UNPKG、esm.sh、Skypack、JSPM 等常见资源 URL。它同样只匹配资源 URL，用于识别不通过 cdnjs 加载的同名库。

公共包 CDN 规则使用带包名边界的正则匹配，避免 `d3` 命中 `d3-array`、`react` 命中 `react-dom` 这类包名前缀误报。

`page/frontend-regional-cdn-libraries.json` 是基于同一批前端库名称扩展出的区域公共静态库 CDN 规则，覆盖 BootCDN、Staticfile、Baomitu、Microsoft Ajax CDN、Google Hosted Libraries 等资源 URL。它只匹配资源 URL，并使用路径边界减少包名前缀误报。

`page/frontend-github-cdn-libraries.json` 是根据 cdnjs 元数据中的 GitHub 仓库地址扩展出的仓库型 CDN 规则，覆盖 jsDelivr GitHub、RawGit、GitHack、GitCDN 等历史或常见资源 URL。它只匹配资源 URL，只保留一个仓库对应一个库名的规则，并使用 `owner/repo` 边界减少误报。

`page/frontend-npm-cdn-libraries.json` 是根据公开 npm 搜索数据补充的前端相关包 CDN 规则，重点覆盖 cdnjs 未收录的 npm 包和 scoped 包。它覆盖 jsDelivr、UNPKG、esm.sh、esm.run、Skypack、JSPM 等资源 URL，并使用包名边界减少误报。

`page/frontend-npm-alt-cdn-libraries.json` 是同一批 npm 包的补充 CDN 变体规则，覆盖 bundle.run、cdn.pika.dev、jsDelivr combine、esm.sh 版本化路径和 JSPM npm 前缀等资源 URL。这类规则带 `resourceHints`，页面或动态资源里没有对应 CDN 线索时会被快速跳过。

`page/wordpress-plugins.json` 是根据 WordPress.org 公开插件目录补充的热门插件规则，识别 `/wp-content/plugins/{slug}/` 资源路径。规则分类为“网站源码线索”，只匹配资源 URL，并使用 `resourceHints` 快速跳过非 WordPress 插件资源。

`page/wordpress-themes.json` 是根据 WordPress.org 公开主题目录补充的热门主题规则，识别 `/wp-content/themes/{slug}/` 资源路径。规则分类为“主题 / 模板”，只匹配资源 URL，并使用 `resourceHints` 快速跳过非 WordPress 主题资源。

除了枚举规则，后台还会从页面资源里发现的 `/wp-content/themes/{slug}/` 目录反推 `style.css`，读取 WordPress 标准主题头字段，例如 `Theme Name`、`Theme URI`、`Author`、`Version`、`Template` 和 `Text Domain`。这类结果属于运行时探测，不放进 JSON 规则列表。

`page/drupal-modules.json` 和 `page/drupal-themes.json` 是根据 Drupal.org 公开项目接口补充的模块和主题规则，识别 `/modules/contrib/{machine}/`、`/modules/custom/{machine}/`、`/themes/contrib/{machine}/`、`/themes/custom/{machine}/` 等资源路径。规则只匹配资源 URL，并使用 `resourceHints` 快速跳过无关资源。

`page/php-ecosystem-assets.json` 是人工维护的 PHP 生态资源路径规则，覆盖 Laravel 生态包、Symfony Bundle、PHP CMS、电商、后台、网盘、Webmail、数据库管理等常见系统。该文件里的批量规则默认使用 `resourceOnly: true` 和 `resourceHints`，只根据页面实际加载过的资源 URL 判断，不把整页源码当作大范围关键词池。

`page/backend-enterprise-assets.json` 是人工维护的后端与企业系统资源路径规则，覆盖 Java/.NET/Python/Ruby 生态框架、企业 CMS、SSO、DevOps、代码托管、制品仓库、数据平台和监控面板。该文件同样优先使用产品专属资源路径、`resourceOnly: true` 和 `resourceHints`，减少通用目录名造成的误报。

`page/selfhosted-saas-assets.json` 是人工维护的自托管 SaaS、协作和数据产品资源路径规则，覆盖错误监控、会话回放、功能开关、客服工单、低代码、知识库、项目管理、团队通讯、联邦社交、文件协作和监控组件。规则优先匹配产品名静态资源或专属入口，避免只靠通用构建目录判断。

`page/ai-platforms-assets.json` 是人工维护的 AI / 大模型应用规则，覆盖 LLM 聊天界面、AI 工作流、数据科学 Demo、图像生成和推理面板。规则优先使用页面标题、产品名资源和云端 widget 域名，避免用通用 `/api/chat`、`/assets/index.js` 这类路径判断具体产品。

`page/security-devops-assets.json` 是人工维护的身份认证、安全平台、Kubernetes/DevOps 面板、网络设备和家庭服务器资源路径规则。规则优先使用产品名资源、控制台专属路径和 `resourceHints`，避免把通用运维目录误判成具体产品。

`page/data-infra-assets.json` 是人工维护的数据基础设施资源路径规则，覆盖搜索引擎、向量数据库、数据库管理面板、消息队列、数据管道、大数据任务面板和存储管理面板。规则优先使用产品名资源或控制台专属路径，并通过 `resourceOnly` 和 `resourceHints` 降低页面源码大范围扫描带来的误报。

`headers/waf.json` 和 `page/waf-page.json` 是人工维护的 WAF / 防火墙规则。响应头规则识别 WAF 下发的 Cookie、Server 和专属响应头；页面规则只识别 WAF 的验证页、拦截页和前端 SDK，使用专属资源路径、全局变量、元素 ID 或带属性结构的链接，不匹配正文里的产品名和报错文案。响应头规则按单个响应头或 Cookie 拆条：构建期的旧版预筛门槛（`__legacyHints`）只看每条规则最长的 3 个字面量片段，多个特征合在一条里可能被挡住，新增规则后用 `tests/waf-rules.test.mjs` 覆盖。

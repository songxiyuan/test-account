# @dsh-test-account/browser-use-playwright-mcp-storage

带 upstream `storage` 能力的 Playwright MCP browser provider。

## 为什么需要它

`@playwright/mcp@0.0.80` 里 `browser_storage_state` / `browser_set_storage_state` /
`browser_cookie_*` / `browser_localstorage_*` 等工具的 `capability` 都是 `storage`，而
`filteredTools(config)` 只保留：

```js
tool.capability.startsWith('core') || config.capabilities?.includes(tool.capability)
```

`config.capabilities` 来自 CLI 的 `--caps`。而官方 provider
（`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`）把参数写死为
`--browser chromium --isolated`（attach 模式再加 `--cdp-endpoint`），配置 schema 里没有
capabilities / 透传参数的口子，所以官方 provider 下这两个工具**根本不会出现在工具目录里**。

本包复用官方同一个 session 生命周期（`@deepseek-ai/dsh-experimental-browser-use-runtime/mcp`
的 `mountSessionMcp`），只改进程参数。

## 参数拼装

```text
<@playwright/mcp>/cli.js --browser chromium
  launch: --isolated [--headless] [--executable-path <p>] [--allow-unrestricted-file-access]
  attach: --cdp-endpoint <endpoint>
  --caps=<逗号分隔>          # 默认 storage
  <extraArgs...>
```

同时它沿用官方 provider 的做法，把继承来的 `PLAYWRIGHT_MCP_*` 环境变量清空，保证 profile 是浏览器
配置的唯一来源。

## 配置

```ts
interface Config {
  mode?: 'launch' | 'attach'   // 默认 'launch'
  headless?: boolean           // 默认 true；保存登录态建议 false
  executablePath?: string      // 显式指定浏览器，优先于自动探测
  autoExecutablePath?: boolean // 默认 true：探测本机已装的 Chrome/Chromium/Edge
  endpoint?: string            // attach 模式必填
  toolCallTimeoutMs?: number
  caps?: string[]              // 默认 ['storage']
  allowUnrestrictedFileAccess?: boolean  // 默认 true
  extraArgs?: string[]
}
```

`attach` 不能带 `endpoint` 以外的 launch 参数，`launch` 不能带 `endpoint`；不合法组合在占用任何浏览器
资源之前就会抛错。这些规则有单元测试。

## 浏览器本体

钉住的 `@playwright/mcp@0.0.80` 默认要 `chrome-for-testing`（Playwright 自己那份 Chromium），
全新机器上没有，第一次调用 storage 工具会直接失败：

```text
Browser "chrome-for-testing" is not installed; ...
Run `npx @playwright/mcp install-browser chrome-for-testing` to install
```

`test-account` 会在这条错误后面追加一段中文提示，告诉用户可以走哪两条路。provider 自己则默认
`autoExecutablePath: true`：按平台探测常见安装位置，命中就传 `--executable-path`，避免为了保存一个
登录态再下 100+ MB 的 Chromium。

| 平台 | 探测顺序 |
| --- | --- |
| macOS | `/Applications/Google Chrome.app/…` → Chromium → Microsoft Edge → Brave |
| Windows | `%PROGRAMFILES%` / `%PROGRAMFILES(X86)%` / `%LOCALAPPDATA%` 下的 Chrome，然后 Edge |
| Linux | `/usr/bin/google-chrome{,-stable}` → `/usr/bin/chromium{,-browser}` → microsoft-edge → `/snap/bin/chromium` |

探测不到（例如干净的 CI）就回退到 Playwright 自带浏览器，并打一条 warn 提示两条出路。想强制用自带
Chromium：`autoExecutablePath: false` + `npx @playwright/mcp install-browser chrome-for-testing`。

## 一个部署只能挂一个 browser provider

`ctx.browserUse` 是「具名独占槽位」：重复注册会拿已注册的名字报错。所以要用本包，就**不要**再挂
`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`。

## 测试

```bash
pnpm --filter @dsh-test-account/browser-use-playwright-mcp-storage test
```

`test/args.test.ts` 覆盖默认参数、`--headless` 省略、权限开关、`--caps` 拼接与省略、
attach/launch 互斥校验、`extraArgs` 追加顺序。

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
  executablePath?: string      // 复用本机 Chrome
  endpoint?: string            // attach 模式必填
  toolCallTimeoutMs?: number
  caps?: string[]              // 默认 ['storage']
  allowUnrestrictedFileAccess?: boolean  // 默认 true
  extraArgs?: string[]
}
```

`attach` 不能带 `endpoint` 以外的 launch 参数，`launch` 不能带 `endpoint`；不合法组合在占用任何浏览器
资源之前就会抛错。这些规则有单元测试。

## 一个部署只能挂一个 browser provider

`ctx.browserUse` 是「具名独占槽位」：重复注册会拿已注册的名字报错。所以要用本包，就**不要**再挂
`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`。

## 测试

```bash
pnpm --filter @dsh-test-account/browser-use-playwright-mcp-storage test
```

`test/args.test.ts` 覆盖默认参数、`--headless` 省略、权限开关、`--caps` 拼接与省略、
attach/launch 互斥校验、`extraArgs` 追加顺序。

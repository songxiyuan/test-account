# @songxiyuan/playwright-mcp-storage

带 upstream `storage` 能力的 Playwright MCP browser provider，按 Session 直接挂载
`@playwright/mcp`，不依赖 DSH Browser Use。

## 为什么需要它

两个独立的问题合在一起，逼出了这个包：

1. **storage 能力默认关闭。** `@playwright/mcp@0.0.80` 里 `browser_storage_state` /
   `browser_set_storage_state` / `browser_cookie_*` / `browser_localstorage_*` 等工具的
   `capability` 都是 `storage`，而 `filteredTools(config)` 只保留：

   ```js
   tool.capability.startsWith('core') || config.capabilities?.includes(tool.capability)
   ```

   `config.capabilities` 来自 CLI 的 `--caps`。

2. **DSH 官方 browser-use 栈不在 0.1.5 线上。** `@deepseek-ai/dsh-browser-use` /
   `@deepseek-ai/dsh-experimental-browser-use-runtime` npm 上最低只有 `0.1.6-alpha.1`，
   而且官方 Playwright provider（`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`）
   把参数写死成 `--browser chromium --isolated`（attach 再加 `--cdp-endpoint`），没有透传口子。

本包因此**不注册 `ctx.browserUse`**，而是用 0.1.5 线自带的 `@deepseek-ai/dsh-mcp-client`
在**每个 live Agent 的 scope 里**各挂一个 `@playwright/mcp` 进程：每个 Session 一套浏览器、
一套 `mcp__playwright-mcp__*` 工具名，天然隔离。

## 安装

不要单独装本包：它必须和 `@songxiyuan/test-account` 一起进同一个 profile。有源码的开发机用仓库根的
`install.sh`：

```bash
./install.sh test-account        # 默认 profile；详见根 README「一、安装」
```

没有源码的机器从公共 npm 装（`@playwright/mcp` 也在公共 npm 上，传递依赖自动解析；不需要 token）：

```bash
dsh plugin --profile test-account add \
  @songxiyuan/test-account \
  @songxiyuan/playwright-mcp-storage
```

升级用 `dsh plugin --profile test-account update @songxiyuan/test-account @songxiyuan/playwright-mcp-storage`
后重启该 profile。

`cordis.patch.yml` 按包名解析本 provider，所以 profile 的顶层依赖里必须有它；细节见根 README §1.3。

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

## 挂载模型

- 监听 `agent/created`，为每个 live Agent 用 `createScope(ctx, agent)` 起一个作用域，在作用域里
  `ctx.plugin(McpClient, …)`，stdio 传输、`failOnStartupError: true`、不自动重连。
- Agent 结束或插件卸载时 dispose 该作用域，stdio 子进程随之关闭。
- `tools/execute` 上有一道守卫：`mcp__playwright-mcp__*`（以及指向本 server 的 MCP resource 工具）
  只有该 Agent 自己能调，别的 Session 调用会报
  `playwright-mcp-storage: browser tool belongs to another Session`。
- `attach` 模式是独占的：同一时刻只让一个 live Session 拿到外部浏览器，其余 Session 正常启动但没有
  浏览器工具。

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

## 测试

```bash
pnpm --filter @songxiyuan/playwright-mcp-storage test
```

`test/args.test.ts` 覆盖默认参数、`--headless` 省略、权限开关、`--caps` 拼接与省略、
attach/launch 互斥校验、`extraArgs` 追加顺序。

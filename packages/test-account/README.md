# @songxiyuan/test-account

账号元数据注册表 + 右侧栏面板 + 当前 Session 的 Playwright `storageState` 桥。

- **Host 半**（`lib/index.js`）：`accounts.json` / `states/*.json` 的读写、Session→账号记忆、
  `/api/test-account` 这条已鉴权的 Fetch 路由。
- **Client 半**（`lib/client.js`）：右侧栏「测试账号」页面类型、面板 UI、对话头部快捷入口。
- **bundle 补丁**（`cordis.patch.yml`）：挂载本仓库的 storage provider，以及本插件自身。

它不启动浏览器、不存密码、不做自动登录；浏览器操作全部转发给当前 Session 已经持有的
Playwright MCP 工具（由 `@songxiyuan/playwright-mcp-storage` 按 Session 挂载）。

## 安装

本包不是独立安装的：它是 `dsh.bundle.patch` 的载体，必须和 storage provider 一起装进同一个
DSH profile，否则面板、路由和浏览器工具都不完整。

有源码的开发机，在仓库根按根 README §1.2 装（先 build，再用本地路径 `dsh plugin add`）：

```bash
pnpm install && pnpm run build
dsh plugin --profile test-account add ./packages/test-account ./packages/playwright-mcp-storage
```

本地装的是 `link:`，运行时直读仓库里的 `lib/`；profile 不存在时还要先按 `web` 模板初始化，
完整的三条命令见根 README §1.2。

没有源码的机器，从公共 npm 装（公开包，不需要 token / `.npmrc`）：

```bash
dsh plugin --profile test-account add \
  @songxiyuan/test-account \
  @songxiyuan/playwright-mcp-storage
```

升级：`dsh plugin --profile test-account update @songxiyuan/test-account @songxiyuan/playwright-mcp-storage`，
然后重启该 profile。0.1.0 曾只发在 GitHub Packages，从那个源迁过来的 profile 要按根 README §1.3 强制
重解析到 0.1.1，并清掉 `~/.npmrc` 里旧的 `@songxiyuan:registry=…` 映射。

安装后 profile 的 `dsh.profile.bundles` 会自动包含 `@songxiyuan/test-account`（来自本包的
`cordis.patch.yml`），无需手工改 `cordis.yml`。

## 路由与端点

路由 `POST /api/test-account`，请求体 `{ endpoint, payload }`，返回
`{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。
路由挂在 Connection 的 `/api` 前缀下，因此 Host/Origin 校验与浏览器 token 鉴权由框架完成。

| 端点 | 载荷 | 结果 |
| --- | --- | --- |
| `accounts/list` | `{ sessionId? }` | `AccountsSnapshot`（含 `hasState` / `stateBytes` / `stateUpdatedAt`） |
| `accounts/create` | `{ input: { id, name, site?, tags? } }` | `AccountView` |
| `accounts/update` | `{ id, patch: { name?, site?, tags? } }` | `AccountView` |
| `accounts/delete` | `{ id }` | `{ id }` |
| `accounts/saveState` | `{ sessionId, id }` | `AccountView`（`browser_storage_state`） |
| `accounts/use` | `{ sessionId, id }` | `{ account, currentAccountId }`（`browser_set_storage_state`） |
| `accounts/current` | `{ sessionId }` | `{ currentAccountId? }` |

错误码：`invalid-id`、`invalid-name`、`duplicate-id`、`unknown-account`、`invalid-payload`、
`invalid-file`、`invalid-json`、`state-missing`、`session-not-live`、`browser-tool-unavailable`、
`browser-tool-failed`、`browser-tool-timeout`、`no-workspace`、`unknown-endpoint`、`internal`。

## 配置

```ts
interface Config {
  root?: string                 // 默认 <DSH_HOME>/test-accounts
  mcpProvider?: string          // 默认 'playwright-mcp'
  stateAccess?: 'direct' | 'staged'  // 默认 'direct'
  stagePrefix?: string          // 默认 '.dsh-test-account-storage-'
  toolTimeoutMs?: number        // 默认 120000
  agentTools?: boolean          // 默认 true：向 Agent 暴露下面三个工具
}
```

## Agent 工具（设计文档 Phase 5）

`agentTools` 打开时，插件会注册三个模型可见的工具。它们和面板走同一个 `AccountService`，
所以校验、错误码、Session 记账完全一致；工具操作的是**调用方 Session 自己的浏览器**
（`exec.agent.id`），不需要也不接受 `sessionId` 参数。

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `account_list` | — | 列出账号（id / 名称 / 站点 / 标签 / 登录态是否已保存）与本 Session 当前账号。只读 |
| `account_use` | `id` | 把该账号的 `storageState` 恢复到本 Session 的浏览器，并把本 Session 的当前账号标为它 |
| `account_current` | — | 查询本 Session 当前使用哪个账号 |

这样「当前 Session 正在用哪个账号」对人和对 Agent 是同一份事实，Agent 也能按指定身份继续
浏览器操作 / E2E / 排障，而不是要人在对话里额外说明。

安全性：`account_use` 只恢复已经由人手动登录并保存过的 `storageState`，插件本身既不接收也不
存储任何凭据；工具描述也明确要求调用后重新导航确认身份，不假设当前页面已刷新。

## 日志

Host 半用 `test-account` 作为 logger 名，记录创建/删除账号、保存登录态、切换账号，以及每次端点失败。

## 测试

```bash
pnpm --filter @songxiyuan/test-account test
```

`test/account-store.test.ts` 覆盖文件读写、id 校验、去重、清空可选字段、路径越界、脏 JSON；
`test/accounts.test.ts` 用假的 browser bridge / Agent 注册表覆盖保存、恢复、错误码、
删除时清理 Session 记账，以及**两个 Session 各持一个账号互不覆盖**（设计文档 §11.5）；
`test/browser-storage.test.ts` 用一个模拟工作区文件栅栏的假 tool runtime，覆盖 `direct`、工作区被拒后
自动降级到 `staged`、`staged` 直连、工具缺失与工具失败的错误码。

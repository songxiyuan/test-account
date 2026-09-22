# @dsh-test-account/test-account

账号元数据注册表 + 右侧栏面板 + 当前 Session 的 Playwright `storageState` 桥。

- **Host 半**（`lib/index.js`）：`accounts.json` / `states/*.json` 的读写、Session→账号记忆、
  `/api/test-account` 这条已鉴权的 Fetch 路由。
- **Client 半**（`lib/client.js`）：右侧栏「测试账号」页面类型、面板 UI、对话头部快捷入口。
- **bundle 补丁**（`cordis.patch.yml`）：挂载 `@deepseek-ai/dsh-browser-use`、本仓库的 storage
  provider，以及本插件自身。

它不启动浏览器、不存密码、不做自动登录；浏览器操作全部转发给当前 Session 已经持有的
Playwright MCP 工具。

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
}
```

## 日志

Host 半用 `test-account` 作为 logger 名，记录创建/删除账号、保存登录态、切换账号，以及每次端点失败。

## 测试

```bash
pnpm --filter @dsh-test-account/test-account test
```

`test/account-store.test.ts` 覆盖文件读写、id 校验、去重、清空可选字段、路径越界、脏 JSON；
`test/browser-storage.test.ts` 用一个模拟工作区文件栅栏的假 tool runtime，覆盖 `direct`、工作区被拒后
自动降级到 `staged`、`staged` 直连、工具缺失与工具失败的错误码。

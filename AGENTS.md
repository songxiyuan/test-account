# 项目约束

## 项目定位

`dsh-test-account` 是 DSH 的「测试账号登录态管理」插件：账号元数据注册表 + 右侧栏面板 +
当前 Session 的 Playwright `storageState` 桥。

**硬性原则（不要在实现里绕过）：**

- 不内嵌 Playwright，不启动第二套浏览器；浏览器生命周期与网页操作全部复用 DSH Browser Use。
- 不保存用户名/密码/验证码，不实现自动登录、OAuth、登录态续期。
- 不引入数据库；账号元数据是 `accounts.json`，登录态是 Playwright 原生 `storageState` 文件。
- 不改 DSH 官方包。需要 provider 行为变化时，在本仓库自带一个薄 provider 替换它。

## 目录结构

```text
packages/test-account/                         # 账号插件（Host + Client）
  src/
    index.ts                                   # Host：Config、接线、鉴权 Fetch 路由
    accounts.ts                                # Host：AccountService（路由与 Agent 工具共用）
    account-store.ts                           # accounts.json / states/*.json 的纯文件读写
    browser-storage.ts                         # 调当前 Session 的 MCP storage 工具
    agent-tools.ts                             # account_list / account_use / account_current
    types.ts                                   # 共享类型、路由与端点名
  client/                                      # Client 半：React 面板，esbuild 打成 lib/client.js
  cordis.patch.yml                             # bundle 补丁，声明该插件依赖的运行时组成
packages/browser-use-playwright-mcp-storage/   # 带 --caps=storage 的 Playwright MCP provider
scripts/build-client.mjs                       # 客户端 bundle 打包（复刻 DSH 的懒加载 CJS 契约）
scripts/check-bundle.mjs                       # 客户端 bundle 结构检查
scripts/smoke-ui.mjs                           # 真机 Chrome 的 UI 冒烟（需要一个已启动实例）
doc/dsh-test-account-plugin-design.md          # 原始设计方案（只读参考）
```

## 版本线

- 目标 DSH：`0.1.7-alpha.1`（Browser Use 系列 npm 上最低 `0.1.6-alpha.1`，peer 要求 `0.1.7`）。
- `@playwright/mcp` 固定 `0.0.80`，与官方 provider 一致，**不要**单独升级。
- 所有 `@deepseek-ai/*` 依赖锁在 `0.1.7-alpha.1`，不要用 `latest`。
- 本机可能同时存在别的 DSH 版本（例如 GUI 跑的 `0.1.5-rc.1`）。开发与验证用独立 profile，
  **不要**升级或重启别人正在用的 profile / GUI 进程。

## 关键技术约束（改代码前先读）

- DSH 客户端插件运行时是 **React 18**，不是 Vue；不要引入 `.vue` 单文件组件。
- 客户端 bundle 必须是 `window.__ModuleLoader__.load({ id, factory })` 形式的**经典脚本 + CJS**，
  由 `scripts/build-client.mjs` 生成。运行时只能 `require` 平台静态表里的模块
  （`react` / `react/jsx-runtime` / `react-dom` / `@deepseek-ai/cordis` / `dsh-client-store` /
  `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`），其余必须打包进去。
- `browser_storage_state` / `browser_set_storage_state` 需要 `--caps=storage`；官方 provider 没有
  透传口子，这就是 `packages/browser-use-playwright-mcp-storage` 存在的唯一原因。
- 浏览器本体：`@playwright/mcp` 默认要它自己那份 `chrome-for-testing`，全新机器没有。provider 的
  `autoExecutablePath`（默认开）按平台探测本机 Chrome/Chromium/Edge 并传 `--executable-path`，
  探测不到才回退。改这块时要同时改 `SYSTEM_BROWSER_CANDIDATES` 与 README 的探测顺序表。
- Host→Client 通信用 `ctx.connection.fetch.register({ path: '/api/test-account', methods: ['POST'], … })`
  + 客户端同源 `fetch`。**不要**用 `ctx.connection.rpc.handle`：这版里它内部依赖
  `owner.webServer`，而 Cordis context tracing 会把 owner 解析回 connection 服务自己的 scope，
  任何插件调用都会抛 `cannot get property "webServer" without inject`。
  `ctx.connection.rpc.intercept('/api', …)` 被 Typert gateway 独占，也不能用。
- 浏览器操作走 `ctx.tools.execute({ name: 'mcp__<provider>__browser_storage_state', agent, ... })`，
  `agent` 来自 `ctx.agents.get(sessionId)`。`ctx.browserUse` 只是 provider 注册表，没有浏览器 API。
- MCP 文件访问默认限制在 Session 工作区内；账号目录在工作区外，所以 provider 默认带
  `--allow-unrestricted-file-access`，同时 `browser-storage.ts` 保留 staged 降级路径（有测试覆盖）。
- 面板（Fetch 路由）与 Agent 工具必须共用 `AccountService`，不要在 `index.ts` / `agent-tools.ts`
  里重复 id 校验、状态测量、Session 记账或错误码。
- Agent 工具用 `exec.agent.id` 定位浏览器，不要新增 `sessionId` 参数，也不要让工具接收任何凭据。
- `Agent` 的身份字段是 `id`（不是 `sessionId`）。`@deepseek-ai/dsh-tools` 等按需运行时导入由
  profile 的 module fallback 解析，**不要**把它们打进客户端 bundle。

## 构建与验证

```bash
pnpm install
pnpm run typecheck     # host + client 类型检查
pnpm run build         # tsc → lib/index.js，esbuild → lib/client.js
pnpm run test          # node:test（无额外测试框架依赖）
pnpm run verify        # 全量：typecheck + build + test + bundle 结构检查
```

- 测试用 Node 内置 `node --test` + 原生 TS type stripping，不要引入 jest/vitest。
- `lib/` 是构建产物，已在 `.gitignore` 中，不要提交。
- 修改账号存储或浏览器桥后，必须补/改 `packages/test-account/test/*.test.ts`。
- 改动跨层链路（路由 / 工具执行 / provider 参数）后，除了单测还应跑一次真机冒烟：
  起一个 profile，然后 `node scripts/smoke-ui.mjs "<带 token URL>" --home <DSH_HOME>`，
  它覆盖「面板 → 路由 → ctx.tools.execute → MCP → 真 Chrome → 落盘 → 恢复」整条链路。

## 安装约定

- `./install.sh [profile]` 是唯一推荐安装入口；默认 profile 为 `test-account`，从 DSH 自带 `web`
  模板初始化。
- 插件通过 `dsh plugin --profile <p> add <本地路径>` 安装；`@dsh-test-account/test-account` 声明了
  `dsh.bundle.patch`，安装后会被自动加进该 profile 的 `dsh.profile.bundles`。
- 不要写 `postinstall` 去改用户的 DSH profile。

## 文档要求

- 用户可见行为、配置字段、安装步骤变化时，同步更新根 `README.md` 与对应包 `README.md`。
- 实现与 `doc/dsh-test-account-plugin-design.md` 不一致时，必须在根 README 的
  「几个来自真实代码的结论」一节留下原因，不要静默偏离。

## Git 与自动提交

- 每次开发任务完成且验证通过后，Agent 必须自动创建一次 Git commit，无需再次询问。
- 自动按需求更新 AGENTS.md 和 README.md。

# 项目约束

## 项目定位

`dsh-test-account` 是 DSH 的「测试账号登录态管理」插件：账号元数据注册表 + 右侧栏面板 +
当前 Session 的 Playwright `storageState` 桥。

**硬性原则（不要在实现里绕过）：**

- 不把 Playwright 内嵌进账号插件，不另起一套旁路浏览器；浏览器仍是「这个 Session 的浏览器」，
  由自带的 `playwright-mcp-storage` provider 在每个 live Agent 的 scope 里挂载 `@playwright/mcp` 提供，
  账号插件只转发 storage 工具调用。
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
packages/playwright-mcp-storage/               # 按 Session 挂 @playwright/mcp 的薄 provider（--caps=storage）
  src/args.ts                                  # 参数/配置拼装（可单测）
  src/session-mcp.ts                           # 每个 live Agent 一个 scoped dsh-mcp-client
scripts/build-client.mjs                       # 客户端 bundle 打包（复刻 DSH 的懒加载 CJS 契约）
scripts/check-bundle.mjs                       # 客户端 bundle 结构检查
scripts/check-pack.mjs                         # 发布包完整性检查（npm pack 清单 vs 相对导入）
scripts/smoke-ui.mjs                           # 真机 Chrome 的 UI 冒烟（需要一个已启动实例）
doc/dsh-test-account-plugin-design.md          # 原始设计方案（只读参考）
```

## 版本线

- 目标 DSH：`0.1.5-rc.3`。所有 `@deepseek-ai/*` 依赖锁在 `0.1.5-rc.3`；`@deepseek-ai/cordis` 锁 `4.0.2`、
  `@deepseek-ai/schemastery` 锁 `3.18.2`（0.1.5 包的精确 peer），不要用 `latest`。
  依赖图里**不允许**出现 `0.1.6-alpha` / `0.1.7-alpha` 包：
  `grep -E '0\.1\.7-alpha|0\.1\.6-alpha' pnpm-lock.yaml` 必须为空。
- `@playwright/mcp` 固定 `0.0.80`，**不要**单独升级。
- **不依赖 DSH Browser Use。** `@deepseek-ai/dsh-browser-use` /
  `@deepseek-ai/dsh-experimental-browser-use-runtime` 0.1.5 线没有（npm 最低 `0.1.6-alpha.1`），
  而且会把 Playwright 参数写死、又不透传 `--caps`。provider 改为用 0.1.5 线自带的
  `@deepseek-ai/dsh-mcp-client`，在每个 live Agent 的 scope 里挂一个 `@playwright/mcp` 子进程。
- 本机 GUI（`dsh web --port 3080`，launchd 标签 `com.nomis.dsh-web`）跑的是**全局 0.1.5-rc.3** + profile `web`；
  本插件已经装进该 profile，但 `dsh.profile.bundles` 只在启动时合成，改完要重启 GUI 才生效。
- 开发与验证一律用独立 profile（或独立 `DSH_HOME`）；**不要**在没被要求时重启别人正在用的 profile / GUI 进程。
- 启动任意 profile 用 `dsh --profile <name> --port <port>`（0.1.5 的 `web` 子命令写死 `--profile web`、
  不接受 `--profile`；`dsh --profile <name> web` 是 0.1.7 才有的语法）。没有 `dsh` 时把它换成
  `npx -y @deepseek-ai/dsh@0.1.5-rc.3`。

## 关键技术约束（改代码前先读）

- DSH 客户端插件运行时是 **React 18**，不是 Vue；不要引入 `.vue` 单文件组件。
- 客户端 bundle 必须是 `window.__ModuleLoader__.load({ id, factory })` 形式的**经典脚本 + CJS**，
  由 `scripts/build-client.mjs` 生成。运行时只能 `require` 平台静态表里的模块
  （`react` / `react/jsx-runtime` / `react-dom` / `@deepseek-ai/cordis` / `dsh-client-store` /
  `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`），其余必须打包进去。
- `browser_storage_state` / `browser_set_storage_state` 需要 `--caps=storage`；官方 provider 没有
  透传口子，这就是 `packages/playwright-mcp-storage` 存在的唯一原因。
- provider 不用 `ctx.browserUse`（那是 0.1.6+ 的服务）：它 `ctx.on('agent/created')` +
  `createScope(ctx, agent)` + `scope.ctx.plugin(McpClient, …)`，为每个 live Agent 起一个
  `@playwright/mcp` 子进程；`agent.ctx.effect` 或插件卸载时 dispose 作用域关掉进程。
  `tools/execute` 上有一道守卫，只有该 Agent 能调自己那套 `mcp__playwright-mcp__*` 工具。
  `attach` 模式独占：同一时刻只服务一个 live Session。
- 浏览器本体：`@playwright/mcp` 默认要它自己那份 `chrome-for-testing`，全新机器没有。provider 的
  `autoExecutablePath`（默认开）按平台探测本机 Chrome/Chromium/Edge 并传 `--executable-path`，
  探测不到才回退。改这块时要同时改 `SYSTEM_BROWSER_CANDIDATES` 与 README 的探测顺序表。
- Host→Client 通信用 `ctx.connection.fetch.register({ path: '/api/test-account', methods: ['POST'], … })`
  + 客户端同源 `fetch`。**不要**用 `ctx.connection.rpc.handle`：这版里它内部依赖
  `owner.webServer`，而 Cordis context tracing 会把 owner 解析回 connection 服务自己的 scope，
  任何插件调用都会抛 `cannot get property "webServer" without inject`。
  `ctx.connection.rpc.intercept('/api', …)` 被 Typert gateway 独占，也不能用。
- 浏览器操作走 `ctx.tools.execute({ name: 'mcp__playwright-mcp__browser_storage_state', agent, ... })`，
  `agent` 来自 `ctx.agents.get(sessionId)`。provider 不对外暴露浏览器 API，账号插件只转发这一个调用。
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
pnpm run verify        # 全量：typecheck + build + test + bundle 结构检查 + 发布包完整性（check:pack）
```

- 测试用 Node 内置 `node --test` + 原生 TS type stripping，不要引入 jest/vitest。
- `lib/` 是构建产物，已在 `.gitignore` 中，不要提交。
- `scripts/check-pack.mjs` 读真正的 `npm pack` 清单，断言每个 `lib/*.js` 的相对导入也在包里。
  两个包的 `files` **只能写目录**（`lib` / `cordis.patch.yml`）：写成具体文件名会让发布包缺兄弟模块，
  本地永远复现不了（checkout 里文件齐全），装到别的机器才炸。改 `files` 后必须跑 `pnpm run check:pack`。
- 修改账号存储或浏览器桥后，必须补/改 `packages/test-account/test/*.test.ts`。
- 改动跨层链路（路由 / 工具执行 / provider 参数）后，除了单测还应跑一次真机冒烟：
  起一个 profile，然后 `node scripts/smoke-ui.mjs "<带 token URL>" --home <DSH_HOME>`，
  它覆盖「面板 → 路由 → ctx.tools.execute → MCP → 真 Chrome → 落盘 → 恢复」整条链路。
- `smoke-ui.mjs` 的 `--home` 段靠「最新 session 目录」定位 Session：同一个 `DSH_HOME` 里还有别的
  实例在写 sessions 时会挑错，报 `session-not-live`。要么用一个全新 `DSH_HOME`（记住它需要先选工作区
  才能建 Session），要么先只跑面板段、再用 `comm` 差出新建的 session id 手工调 `accounts/saveState`。

## 安装约定

分发只保留两条路线（README 已按此精简），**同一个 profile 只走一条**：

- **路线 A（开发机、有源码）**：三条命令，默认 profile 为 `test-account`，从 DSH 自带 `web` 模板初始化。
  仓库**不提供** `install.sh`：它只是这几条命令的包装，去掉后两条路线才对称。

  ```bash
  pnpm install && pnpm run build
  test -f "${DSH_HOME:-$HOME/.dsh}/profiles/test-account/package.json" ||
  dsh --profile test-account --from-default-profile web --dump-config >/dev/null
  dsh plugin --profile test-account add ./packages/test-account ./packages/playwright-mcp-storage
  ```

  第 1 条不能省：`dsh plugin add <本地目录>` 在 profile 里写的是 `link:`（`node_modules` 直接软链回
  仓库），运行时读的 `lib/` 是 gitignore 的构建产物；`link:` 不触发 `build` / `prepack`，所以漏掉 build
  会"装成功但没面板"。第 2 条也不能省：profile 不存在时 `dsh plugin` 会自己建一个，但用的是
  `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`，没有 `@deepseek-ai/dsh-web-app` 就没有
  webserver / connection / 右侧栏 slot；而 `--from-default-profile` 对已存在的 profile 会拒绝，所以先判断。
  `dsh plugin` 把相对路径锚到当前目录，因此在仓库根执行；没有 `dsh` 就换成
  `npx -y @deepseek-ai/dsh@0.1.5-rc.3`。`link:` 是活挂，改完源码 `pnpm run build` + 重启该 profile 即生效，
  不必重跑第 3 条。0.1.1 之前装过 0.1.7 browser-use 栈或 `@dsh-test-account/*` 旧 scope 的 profile 需手工
  `dsh plugin --profile <p> remove` 清掉（根 README §1.6）。
- **路线 B（没有源码的机器）**：从公共 npm（`https://registry.npmjs.org`）装 `@songxiyuan/*`，**匿名可装、
  不需要 token 或 `.npmrc` 映射**。scope 是 npm 侧的事实：只有 npm 用户 `songxiyuan` 能发这两个名字，
  与仓库 owner 同名只是巧合。安装/升级都是普通 registry 名字：

  ```bash
  dsh plugin --profile <p> add @songxiyuan/test-account @songxiyuan/playwright-mcp-storage
  dsh plugin --profile <p> update @songxiyuan/test-account @songxiyuan/playwright-mcp-storage  # + 重启该 profile
  ```

  两个包都要显式给出（`cordis.patch.yml` 按包名解析 provider）。0.1.0 曾只发在 GitHub Packages：
  旧 profile 的 lockfile 指向 `npm.pkg.github.com` 时，按根 README §1.3 的迁移步骤强制重解析到 0.1.1，
  并删掉 `~/.npmrc` 里旧的 `@songxiyuan:registry=…` 映射。
- 发布：CI（`publish.yml`，用仓库 secret `NPM_TOKEN`）或本地 `pnpm run publish:npm`。两个包的
  `publishConfig` **只留 `access: public`、不写 `registry`**（写回 GitHub Packages 会重新变成需要 token
  的一条路线）；发布前必须 `pnpm run check:pack` 全绿。**不要把 npm token 写进仓库任何文件**，
  只写 CI secret 或目标机器的 `~/.npmrc`。
- 根 README 的「一、安装」是给人和 AI Agent 共用的自包含安装规程（两条路线、前置检查、逐条命令、
  安装后自检、故障→处理、硬性约束、机器可读摘要）。改动安装入口、包清单、版本线或自检方式时，
  必须同步更新该节，保持命令可直接复制执行。
- 插件通过 `dsh plugin --profile <p> add <本地路径或 registry 包名>` 安装；`@songxiyuan/test-account`
  声明了 `dsh.bundle.patch`，安装后会被自动加进该 profile 的 `dsh.profile.bundles`。
- 不要写 `postinstall` 去改用户的 DSH profile。

## 文档要求

- 用户可见行为、配置字段、安装步骤变化时，同步更新根 `README.md` 与对应包 `README.md`。
- 实现与 `doc/dsh-test-account-plugin-design.md` 不一致时，必须在根 README 的
  「几个来自真实代码的结论」一节留下原因，不要静默偏离。

## Git 与自动提交

- 每次开发任务完成且验证通过后，Agent 必须自动创建一次 Git commit，无需再次询问。
- 自动按需求更新 AGENTS.md 和 README.md。

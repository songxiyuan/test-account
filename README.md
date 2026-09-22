# dsh-test-account

在 DSH 里管理测试账号登录态：一个账号列表 UI，加「保存当前浏览器登录态 / 一键切换账号 / 标记当前
Session 在用哪个账号」三件事。

核心原则（与设计方案一致）：**不内嵌 Playwright、不保存密码、不实现自动登录、不引入数据库。**

```text
DSH Web 右侧栏「测试账号」面板
        │  POST /api/test-account（Connection 的鉴权 /api 前缀）
        ▼
@dsh-test-account/test-account          ← 账号元数据 + states/*.json + Session→账号
        │  ctx.tools.execute
        ▼
mcp__playwright-mcp__browser_storage_state / browser_set_storage_state
        ▼
@dsh-test-account/browser-use-playwright-mcp-storage   ← 官方 provider + --caps=storage
        ▼
当前 Session 的 Chromium
```

## 一、安装（一条命令）

```bash
./install.sh              # 装进 "test-account" profile（不存在则用 web 模板初始化）
./install.sh web          # 装进已有的 web profile
DSH_VERSION=0.1.7-alpha.1 ./install.sh ta
```

`install.sh` 做四件事：

1. 在仓库里 `pnpm install && pnpm build`；
2. 从 DSH 自带的 `web` 模板初始化目标 profile（已存在则跳过）；
3. 把三个包装进该 profile：

   ```bash
   dsh plugin --profile <name> add \
     packages/test-account \
     packages/browser-use-playwright-mcp-storage \
     @deepseek-ai/dsh-browser-use@0.1.7-alpha.1 \
     @deepseek-ai/dsh-experimental-browser-use-runtime@0.1.7-alpha.1
   ```

4. `@dsh-test-account/test-account` 声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它加进
   profile 的 `dsh.profile.bundles`，因此无需手工改 `cordis.patch.yml`。

启动：

```bash
npx -y @deepseek-ai/dsh@0.1.7-alpha.1 --profile test-account web --port 3081
```

> **浏览器本体**：provider 默认自动探测本机 Chrome / Chromium / Edge 并复用，所以装了 Chrome 的
> 机器开箱即用。如果一台机器两者都没有，第一次保存登录态会提示两条出路：跑
> `npx @playwright/mcp install-browser chrome-for-testing`，或在 profile 里显式配
> `executablePath`。详见 [`packages/browser-use-playwright-mcp-storage/README.md`](packages/browser-use-playwright-mcp-storage/README.md#浏览器本体)。

## 二、用起来

1. 打开一个 Session，在右侧栏点「测试账号」（对话头部的快捷按钮，或右侧栏 `+` → 向导里的
   「测试账号」）。

   > 头部按钮挂在对话头上，所以**刚新建、还没发过消息的空 Session**看不到它；发一条消息或打开
   > 已有对话就会出现。右侧栏本身也是 Session 级的，没有 Session 时不存在。
2. 「+ 添加」建账号：只需要名称 / ID / 站点 / 标签，**不填用户名密码**。
3. 在浏览器里手动登录某个测试账号，回到面板点「保存当前登录态」。
4. 换账号时点「使用账号」，插件把对应 `storageState` 灌回当前 Session 的浏览器。
5. 登录过期后重新登录，点「更新登录态」覆盖即可。

面板会显示每个 Session 当前用的是哪个账号；不同 Session 的记录互不覆盖。

## 三、数据布局

```text
${DSH_HOME:-~/.dsh}/test-accounts/
├── accounts.json          # 账号元数据（无凭据）
└── states/
    ├── vip-us.json        # Playwright storageState（cookies + localStorage）
    └── free-us.json
```

`accounts.json`：

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "vip-us",
      "name": "VIP 美国测试账号",
      "site": "TeraBox",
      "tags": ["vip", "us"],
      "stateFile": "states/vip-us.json",
      "updatedAt": "2026-09-22T18:30:00.000Z"
    }
  ]
}
```

## 四、包结构

```text
packages/
├── test-account/                            # 账号插件（Host + Client 双半）
│   ├── src/
│   │   ├── index.ts                         # Host：Config、Remote 端点、Session→账号
│   │   ├── account-store.ts                 # accounts.json 与 states/*.json 的纯文件读写
│   │   ├── browser-storage.ts               # 调当前 Session 的 MCP storage 工具
│   │   └── types.ts                         # 共享类型与端点名
│   ├── client/
│   │   ├── index.tsx                        # 注册右侧栏页面类型 + 面板主体 + 头部快捷入口
│   │   ├── AccountPanel.tsx                 # 账号列表 / 当前账号 / 各操作
│   │   ├── AccountForm.tsx                  # 添加 / 编辑表单
│   │   └── contract.ts                      # 本地声明的 DSH 客户端契约 + RPC 调用
│   ├── test/                                # node:test 单元测试
│   └── cordis.patch.yml                     # bundle 补丁：挂载 browser-use + provider + 本插件
└── browser-use-playwright-mcp-storage/       # 薄 provider
    └── src/args.ts                          # 参数拼装（--caps=storage 等），可单测
```

## 五、配置

`packages/test-account/cordis.patch.yml` 里的默认值：

```yaml
- insert:
    - id: test-account-browser-use
      name: '@deepseek-ai/dsh-browser-use'

    - id: test-account-playwright-mcp
      name: '@dsh-test-account/browser-use-playwright-mcp-storage'
      config:
        mode: launch          # launch | attach
        headless: false       # 手工登录需要看得见浏览器
        allowUnrestrictedFileAccess: true

    - id: test-account
      name: '@dsh-test-account/test-account'
      config:
        # root: ~/.dsh/test-accounts
        mcpProvider: playwright-mcp
        stateAccess: direct   # direct | staged
        # stagePrefix: .dsh-test-account-storage-
        # toolTimeoutMs: 120000
        agentTools: true      # 关闭则不给 Agent 暴露 account_* 工具
```

| 字段 | 作用 |
| --- | --- |
| `test-account.root` | 账号目录，默认 `${DSH_HOME:-~/.dsh}/test-accounts` |
| `test-account.mcpProvider` | 浏览器工具命名空间 `mcp__<provider>__`，默认 `playwright-mcp` |
| `test-account.stateAccess` | `direct` 直接把账号路径交给浏览器工具；`staged` 先在工作区落一个临时文件再搬运 |
| `test-account.agentTools` | 是否向 Agent 暴露 `account_list` / `account_use` / `account_current`，默认 `true` |
| `provider.caps` | 传给 `@playwright/mcp` 的能力，默认 `['storage']` |
| `provider.allowUnrestrictedFileAccess` | 允许 storage 工具读写 Session 工作区之外的路径（账号目录需要），默认开 |
| `provider.headless` | 是否无窗口；保存登录态必须人工登录，所以默认 `false` |
| `provider.executablePath` | 显式指定浏览器（复用本机 Chrome），优先于自动探测 |
| `provider.autoExecutablePath` | 默认 `true`：按平台探测本机已装的 Chrome / Chromium / Edge |

## 六、几个来自真实代码的结论（与设计文档的差异）

设计文档 `doc/dsh-test-account-plugin-design.md` 有几处和实际 DSH 代码不一致，实现按代码来：

1. **客户端 UI 是 React，不是 Vue。** DSH 0.1.5/0.1.7 的客户端插件运行时是 React 18 + slot 注册 +
   `window.__ModuleLoader__.load` 懒加载 CJS 包，没有 Vue 入口，所以 `AccountPanel.vue` 换成了
   `AccountPanel.tsx`。
2. **storage 工具确实需要 `--caps=storage`。** `@playwright/mcp@0.0.80` 里 `browser_storage_state` /
   `browser_set_storage_state` 的 capability 是 `storage`，而 `filteredTools()` 只保留
   `core*` 或 `config.capabilities` 里列出的工具。官方
   `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 把参数写死成
   `--browser chromium --isolated`，**没有任何透传口子**（0.1.7-alpha.1 也一样），所以本仓库自带
   `packages/browser-use-playwright-mcp-storage`：复用官方 `mountSessionMcp`，只多传
   `--caps=storage`。
3. **别的官方 provider 都拿不到登录态。** 也查了
   `dsh-experimental-browser-use-chrome-devtools-mcp` 和 `stagehand-native`：前者是调试/快照类工具，
   后者只有 `navigate / tabs / screenshot / act / observe / extract`，都没有 storageState 能力。所以
   Playwright MCP 是唯一可行路线。
4. **Host↔Client 通信用自定义 Fetch 路由，不用 Typert，也不用 `rpc.handle`。** Typert Remote 的代码生成器
   （`@deepseek-ai/dsh-typert-generator`）并不随 npm 包发布，所以走不了。而
   `ctx.connection.rpc.handle(channel, handler)` 在这版里对插件不可用：它内部会
   `owner.webServer.register(route)`，而 Cordis 的 context tracing 会把被追踪的 `owner` 解析回
   **connection 服务自己的 scope**，于是任何插件调用它都会得到
   `cannot get property "webServer" without inject`（即使把 `webServer` 写进 `inject`、
   或用 `ctx.inject(['connection','webServer'], …)` 也一样）。`ctx.connection.rpc.intercept('/api', …)`
   又被 Typert gateway 独占（重复注册会抛错）。最终采用
   `ctx.connection.fetch.register({ path: '/api/test-account', methods: ['POST'], … })`：它是官方文档里
   给「JSON Remote gateway 不拥有的路由」准备的扩展点，天然走 `/api` 的 Host/Origin 校验与浏览器
   token 鉴权，客户端一个同源 `fetch` 就够了。
5. **`ctx.browserUse` 仍然只是 provider 注册表**（设计文档 §8.1 正确）：它只有 `register` /
   `providerName`，没有 `click()` / `setStorageState()`。所以真正调用走
   `ctx.tools.execute({ name: 'mcp__playwright-mcp__browser_storage_state', agent, ... })`，
   `agent` 由 `ctx.agents.get(sessionId)` 取得——这就是「复用当前 Session 的浏览器」的落点。
6. **浏览器版本线。** Browser Use 系列包 npm 上最低 `0.1.6-alpha.1`，peer 依赖要求 `0.1.7-alpha.1`；
   当前机器上正在跑的 GUI 是 `0.1.5-rc.1`，**装不上 Browser Use**。因此插件按 `0.1.7-alpha.1` 开发，
   并建议用独立 profile（见 `install.sh`），不要动正在用的 `web` profile。

### 文件访问权限的取舍

MCP storage 工具默认只能读写 Session 工作区，`~/.dsh/test-accounts/` 在工作区外会被拒绝。所以：

- provider 默认带 `--allow-unrestricted-file-access`，`stateAccess: direct` 直接读写账号目录；
- 如果换回官方 provider（或把该开关关掉），插件会自动**降级**：在工作区写一个
  `.dsh-test-account-storage-<uuid>.json` 临时文件，调完工具立刻删除。降级路径有单元测试覆盖。

## 七、开发与验证

```bash
pnpm install
pnpm run typecheck     # 两个包的 host/client 类型检查
pnpm run build         # tsc 出 host 半 + esbuild 出 lib/client.js
pnpm run test          # node:test 单元测试（store + provider 参数 + 浏览器桥降级）
pnpm run verify        # 以上全跑，并做 client bundle 结构检查
```

`node scripts/check-bundle.mjs packages/test-account` 会直接在一个 vm 里执行
`lib/client.js`，断言它真的走 `window.__ModuleLoader__.load({ id, factory })`，并且导出
`apply` / `inject` —— 这是客户端插件最容易出错、又最不容易在文件层面看出来的地方。

### 已验证到什么程度

| 层级 | 内容 | 结论 |
| --- | --- | --- |
| 单元 | `account-store`：读写、id 校验、去重、清空可选字段、路径越界、脏 JSON | ✅ 12 项 |
| 单元 | provider 参数拼装、launch/attach 校验、系统浏览器探测与 `--executable-path` | ✅ 15 项 |
| 单元 | `AccountService`：保存/恢复、`session-not-live`、`state-missing`、删除清理记账、**两个 Session 各持一个账号互不覆盖**（§11.5） | ✅ 8 项（假 bridge + 假 Agent 注册表） |
| 单元 | 浏览器桥：direct、工作区被拒后自动降级 staged、工具缺失/失败错误码、缺浏览器的提示 | ✅ 11 项，用模拟的工作区文件栅栏 |
| 单元 | 插件接线：路由注册、三个 Agent 工具注册、`agentTools: false` 不注册、路由增删查与错误码 | ✅ 5 项（假 Cordis ctx） |
| 构建 | `lib/client.js` 真的是 `window.__ModuleLoader__.load` 懒加载包 | ✅ `scripts/check-bundle.mjs` |
| 集成 | `./install.sh <profile>` 在全新 `DSH_HOME` 上从零跑通：构建 → 初始化 profile → 装 4 个包 → 自动加入 `dsh.profile.bundles` → 能启动 | ✅ 脚本本身已实测 |
| 集成 | 0.1.7-alpha.1 profile 装载三个插件，无未激活项；boot manifest 含本插件与四个 client 依赖；`/plugins/??…/client.js` 返回 200 | ✅ 独立 `DSH_HOME` |
| 集成 | `POST /api/test-account` 真实 HTTP + 鉴权：增删改查、持久化、全部错误码、`session-not-live` 守卫 | ✅ curl 走完整流程 |
| 集成 | `@playwright/mcp` 带 `--caps=storage` 时工具数为 41 且包含两个 storage 工具；不带时 24 且没有 | ✅ 直接起 MCP server 列工具 |
| 集成 | 真实 Chrome：`browser_storage_state` 把登录态写到工作区外的账号目录（含 `cookies` / `origins`），`browser_set_storage_state` 再读回；去掉 `--allow-unrestricted-file-access` 时同路径被 `File access denied … outside allowed roots` 拒绝 | ✅ 正是降级路径存在的理由 |
| 集成 | **整条链路**：真实浏览器里打开面板 → 路由 `accounts/saveState` → DSH `ctx.tools.execute('mcp__playwright-mcp__browser_storage_state')` → Playwright MCP → 真实 Chrome → 账号目录落盘；再 `accounts/use` 恢复并更新当前账号 | ✅ `pnpm run smoke:ui <url> --home <DSH_HOME>` 17/17 通过，无 page error |
| 集成 | 上面这套在三种装法下都跑过：`install.sh` 新建的 profile、已初始化过的 profile、以及不配 `executablePath`（靠自动探测本机 Chrome） | ✅ |
| 手工 | 图形浏览器里「登录 → 保存登录态 → 换账号 → 恢复」；以及设计文档 §14 的风险项：两个 Session 同时各起一个浏览器、各自切账号互不干扰 | ⏳ 需要人手动登录；浏览器资源是 DSH provider 的职责，不该在本插件里绕过 |

`scripts/smoke-ui.mjs` 需要一个已经跑起来的实例：

```bash
./install.sh test-account
npx -y @deepseek-ai/dsh@0.1.7-alpha.1 --profile test-account web --port 3081   # 记下打印的带 token URL

# 只验面板（不需要浏览器本体）
pnpm run smoke:ui "http://127.0.0.1:3081/?token=..."

# 连浏览器登录态一起验（会真的启动一个 Chrome、跑 MCP 的 storage 工具）
pnpm run smoke:ui "http://127.0.0.1:3081/?token=..." -- --home ~/.dsh
```

它会用本机 Chrome（`CHROME_PATH` 可覆盖）真的开一个页面，建 Session、发一条消息让对话头挂载
（首次运行会点掉「稍后配置」的 API Key 弹窗），然后断言面板的注册、读取、写入、删除全链路；
带 `--home` 时再补上「saveState → DSH 工具运行时 → Playwright MCP → 真实 Chrome → 落盘 → use 恢复」
这一段。它用的是无窗口 Chrome，但**被测 provider 自己会按 profile 配置起浏览器**，所以做这一段时
建议先按上面的 `--patch` 例子把 provider 改成 `headless: true`，否则屏幕上会弹出一个 Chrome。

端到端验证（手工，需要能跑图形浏览器；`cordis.patch.yml` 默认 `headless: false`）：

```bash
./install.sh test-account
npx -y @deepseek-ai/dsh@0.1.7-alpha.1 --profile test-account web --port 3081
# 新开 Session → 右侧栏「测试账号」→ 添加账号 → 浏览器登录 → 保存当前登录态
# 再点「使用账号」→ 刷新业务页面应仍是登录态
```

> 保存登录态必须人工登录，所以这一步不会出现在自动化测试里；其余链路都已脚本化验证。
> 如果 CI 想跑，用 `mode: launch` + `--headless`，或 `mode: attach` 接一个已经登录的 CDP 端点
> （attach 模式是独占的，一个 Session 占一个浏览器）。

## 八、Agent 集成

除了面板，插件还向 Agent 暴露三个工具（设计文档 §15 Phase 5），让「当前用哪个账号」对人和对
Agent 是同一份事实：

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `account_list` | — | 列账号与登录态状态，并指出本 Session 当前账号。只读 |
| `account_use` | `id` | 把该账号的 `storageState` 恢复到**调用方 Session 自己的浏览器**，并标记当前账号 |
| `account_current` | — | 查询本 Session 当前账号 |

它们与面板共用同一个 `AccountService`，所以校验、错误码、Session 记账完全一致；浏览器目标由
`exec.agent.id` 决定，工具既不接收 `sessionId`，也不接收任何凭据。配置 `agentTools: false` 可整体关掉。

于是 Agent 排查问题可以直接：

```text
account_list    → 看到 vip-us / free-us 以及谁已经保存过登录态
account_use     → 切到 free-us（该账号的 cookies + localStorage 灌进当前浏览器）
                → 自己重新 browser_navigate 到目标页面确认身份，再继续 E2E / 排障
```

## 九、当前范围与后续

已完成：账号 CRUD、保存/更新/恢复登录态、当前账号展示、Session 隔离、Agent 工具。

暂不包含（与设计文档 §1 一致）：用户名密码自动登录、OAuth/SSO/验证码、登录态自动续期、Cookie 手工
编辑、账号过期自动检测。

后续可加：登录态过期探活（`verifyUrl`）、账号分组/搜索、把登录态导出给 CI 的 `mode: attach` 流程。

## 参考

- 设计文档：[`doc/dsh-test-account-plugin-design.md`](doc/dsh-test-account-plugin-design.md)
- DSH 插件发布/安装：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- DSH Browser Use：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/browser-use.md>
- Playwright Browsers：<https://playwright.dev/docs/browsers>

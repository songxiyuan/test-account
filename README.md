# dsh-test-account

在 DSH 里管理测试账号登录态：一个账号列表 UI，加「保存当前浏览器登录态 / 一键切换账号 / 标记当前
Session 在用哪个账号」三件事。

核心原则（与设计方案一致）：**不内嵌 Playwright、不保存密码、不实现自动登录、不引入数据库。**

> **AI Agent**：安装请直接跳到[§零、AI 安装引导（Agent 执行清单）](#零ai-安装引导agent-执行清单)。
> 那一节自包含，含前置检查、逐条命令、成功信号、安装后自检、故障→处理与硬性约束，不需要先读完全文。

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

## 零、AI 安装引导（Agent 执行清单）

> **给 AI Agent**：本节自包含，按顺序执行即可完成安装，不必先读后面章节。规则：命令都在**仓库根目录**
> 执行；逐条检查退出码，非 0 就停下按 [§0.6](#06-故障--处理) 处理；不要改 DSH 官方包、不要动别人正在用的
> profile / GUI 进程、不要写 `postinstall`。所有步骤幂等，可重复执行。

### 0.1 前置条件（先验证，缺什么先补什么）

| # | 检查 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| 1 | Node.js | `node -v` | ≥ `v22.18`（测试直接跑 `.ts`，依赖原生 type stripping；建议 24 LTS） |
| 2 | pnpm | `pnpm -v` | 有版本号（本项目 `pnpm@11.9.0`）；缺失见 §0.6 |
| 3 | bash | `bash --version` | 能跑 `install.sh`；Windows 用 Git Bash / WSL，或走 §0.3 |
| 4 | 网络 | `npm ping` | `PONG`（要能拉 npm 上的 `@deepseek-ai/*`） |
| 5 | 浏览器（可选） | macOS `ls "/Applications/Google Chrome.app"` | 有 Chrome / Chromium / Edge 则登录态功能开箱即用；没有也能装完，见 §0.6 |

### 0.2 一键安装（唯一推荐入口）

```bash
./install.sh test-account                                   # 默认 profile：test-account
./install.sh web                                            # 装进已有 profile（示例）
DSH_VERSION=0.1.7-alpha.1 ./install.sh test-account         # 钉住 DSH 版本
DSH_BIN="dsh" ./install.sh test-account                     # 用 PATH 上已有的 dsh，跳过 npx
```

`install.sh` 依次做四件事：

| 步 | 动作 | 成功信号 |
| --- | --- | --- |
| 1 | 仓库内 `pnpm install && pnpm run build` | 生成 `packages/test-account/lib/{index.js,client.js}` 与 provider 的 `lib/index.js` |
| 2 | 从 DSH 自带 `web` 模板初始化目标 profile | 不存在则创建；已存在则跳过（不会重置） |
| 3 | `dsh plugin add` 4 个包 | 打印安装结果，结尾无 `error` |
| 4 | 把本插件写进 `dsh.profile.bundles` | 由 `dsh.bundle.patch` 自动完成，见 §0.4-B |

### 0.3 手工分步（`install.sh` 不可用时，与 §0.2 等价）

```bash
# 1) 构建（在仓库根目录）
pnpm install
pnpm run build

# 2) 初始化 profile（已存在时 --dump-config 直接退出，不会重置）
npx -y @deepseek-ai/dsh@0.1.7-alpha.1 --profile test-account \
  --from-default-profile web --dump-config >/dev/null

# 3) 安装 4 个包（两个本地路径 + 两个官方 browser-use 包）
npx -y @deepseek-ai/dsh@0.1.7-alpha.1 plugin --profile test-account add \
  "$PWD/packages/test-account" \
  "$PWD/packages/browser-use-playwright-mcp-storage" \
  "@deepseek-ai/dsh-browser-use@0.1.7-alpha.1" \
  "@deepseek-ai/dsh-experimental-browser-use-runtime@0.1.7-alpha.1"
```

### 0.4 安装后自检（必须全绿再继续）

```bash
PROFILE=test-account

# A. 构建产物存在
test -f packages/test-account/lib/index.js &&
test -f packages/test-account/lib/client.js &&
test -f packages/browser-use-playwright-mcp-storage/lib/index.js &&
echo "OK: build artifacts"

# B. profile 依赖齐全 + bundle patch 已挂载（纯读，无副作用）
DSH_HOME="${DSH_HOME:-$HOME/.dsh}" node -e '
const fs=require("fs"),path=require("path");
const home=process.env.DSH_HOME,name=process.argv[1];
const p=JSON.parse(fs.readFileSync(path.join(home,"profiles",name,"package.json"),"utf8"));
const need=["@dsh-test-account/test-account","@dsh-test-account/browser-use-playwright-mcp-storage","@deepseek-ai/dsh-browser-use","@deepseek-ai/dsh-experimental-browser-use-runtime"];
const missing=need.filter(n=>!p.dependencies||!p.dependencies[n]);
const bundles=(p.dsh&&p.dsh.profile&&p.dsh.profile.bundles)||[];
if(missing.length||!bundles.includes("@dsh-test-account/test-account")){console.error("FAIL",{missing,bundles});process.exit(1);}
console.log("OK: profile",name,"deps=4 bundle-patch=yes");
' "$PROFILE"

# C. 类型 + 构建 + 单测 + client bundle 结构（推荐）
pnpm run verify
```

任一项 FAIL 都不要继续，按 §0.6 处理。

### 0.5 启动与验收

```bash
npx -y @deepseek-ai/dsh@0.1.7-alpha.1 --profile test-account web --port 3081
# 终端打印带 token 的 URL，形如 http://127.0.0.1:3081/?token=...
```

验收路径（人 / AI 都适用）：

1. 打开该 URL；
2. **在这个 Session 发一条消息**（对话头快捷入口只在有 turn 的 Session 上出现）；
3. 右侧栏 `+` → 「测试账号」，或对话头部快捷按钮，能看到账号列表即 Host 路由已通；
4. 添加账号（只填名称 / ID / 站点 / 标签，**不填密码**）→ 浏览器里手动登录 → 面板点「保存当前登录态」。

自动化冒烟（可选，需要已启动实例；`--home` 段会真起一个 Chrome 跑 storage 工具）：

```bash
pnpm run smoke:ui "http://127.0.0.1:3081/?token=<token>" -- --home "${DSH_HOME:-$HOME/.dsh}"
```

### 0.6 故障 → 处理

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `pnpm: command not found` | 未装 pnpm | `corepack enable && corepack prepare pnpm@11.9.0 --activate` |
| `npm error ENOENT ... _npx/<hash>/package.json` | npx 缓存损坏 | `rm -rf ~/.npm/_npx` 后重跑，或 `DSH_BIN="dsh" ./install.sh test-account` |
| 装 `@deepseek-ai/dsh-browser-use` 失败 | DSH 版本低于 0.1.7 | 用 `DSH_VERSION=0.1.7-alpha.1` 且换一个新的 profile 名，别动正在用的 profile |
| `Browser "chrome-for-testing" is not installed` | provider 没探测到本机浏览器 | ① 装本机 Chrome / Chromium / Edge（`autoExecutablePath` 默认复用）；或 ② `npx @playwright/mcp install-browser chrome-for-testing`；或 ③ 在 profile 配 `provider.executablePath` |
| `File access denied ... outside allowed roots` | provider 缺 `--allow-unrestricted-file-access` | 用本仓库的 storage provider；插件会降级 staged，但默认 provider 更稳 |
| 面板里找不到「测试账号」 | Session 还没有 turn，或插件没进 `dsh.profile.bundles` | 先发一条消息；再跑 §0.4-B |
| 报 `session-not-live` | 拿别的 Session 的 id 调浏览器 | 在同一个 Session 内操作 |

### 0.7 硬性约束（AI 不要做）

- ❌ 不装 / 不升 `@playwright/mcp`（固定 `0.0.80`），不把 `@deepseek-ai/*` 换成 `latest`（锁 `0.1.7-alpha.1`）；
- ❌ 不改 DSH 官方包；provider 行为要变就在本仓库 `packages/browser-use-playwright-mcp-storage` 里改；
- ❌ 不动别人正在用的 profile / GUI 进程，验证一律用独立 profile 名；
- ❌ 不写 `postinstall` 去改用户 profile；
- ❌ 不采集、不存储用户名 / 密码 / 验证码，不做自动登录。

### 0.8 机器可读摘要（给 Agent 解析用）

```yaml
plugin: "@dsh-test-account/test-account"
entry: ./install.sh                 # 唯一推荐入口，幂等
default_profile: test-account
dsh_version: 0.1.7-alpha.1
pnpm_version: 11.9.0
node_min: "22.18"                   # node --test 直跑 .ts 需要原生 type stripping
env:
  DSH_VERSION: "覆盖 DSH 版本"
  DSH_BIN: "复用已有 dsh 命令，跳过 npx"
  DSH_HOME: "profile 与账号目录的根，默认 ~/.dsh"
local_packages:
  - path: packages/test-account
    name: "@dsh-test-account/test-account"
    bundle_patch: cordis.patch.yml  # 安装后自动加入 dsh.profile.bundles
  - path: packages/browser-use-playwright-mcp-storage
    name: "@dsh-test-account/browser-use-playwright-mcp-storage"
extra_packages:
  - "@deepseek-ai/dsh-browser-use@0.1.7-alpha.1"
  - "@deepseek-ai/dsh-experimental-browser-use-runtime@0.1.7-alpha.1"
artifacts:
  - packages/test-account/lib/index.js
  - packages/test-account/lib/client.js
  - packages/browser-use-playwright-mcp-storage/lib/index.js
profile_checks:
  dependencies_present: 4           # 上面 4 个包
  bundles_contains: "@dsh-test-account/test-account"
start: "npx -y @deepseek-ai/dsh@0.1.7-alpha.1 --profile test-account web --port 3081"
verify: "pnpm run verify"
account_store: "${DSH_HOME:-~/.dsh}/test-accounts"
```

## 一、安装（一条命令）

```bash
./install.sh              # 装进 "test-account" profile（不存在则用 web 模板初始化）
./install.sh web          # 装进已有的 web profile
DSH_VERSION=0.1.7-alpha.1 ./install.sh ta
```

`install.sh` 做四件事：

1. 在仓库里 `pnpm install && pnpm run build`；
2. 从 DSH 自带的 `web` 模板初始化目标 profile（已存在则跳过）；
3. 把四个包装进该 profile：

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

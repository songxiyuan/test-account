# dsh-test-account

在 DSH 里管理测试账号登录态：**Agent 在对话中登录，插件保存登录态，面板负责查看与切换。**

核心原则：**不内嵌 Playwright、不保存密码、不实现自动登录、不引入数据库。** 凭据只出现在对话与页面
输入框里；插件只落盘登录后的 cookies / localStorage（Playwright `storageState`）。

```text
用户：把「网址 + 账号 + 密码」发给 Agent
        ▼
Agent：用当前 Session 的浏览器工具打开页面、填入并登录
        ▼  account_save
@songxiyuan/test-account                ← accounts.json + states/*.json + Session→账号
        │  ctx.tools.execute
        ▼
mcp__playwright-mcp__browser_storage_state / browser_set_storage_state
        ▼
@songxiyuan/playwright-mcp-storage      ← 每个 live Session 一个 @playwright/mcp 进程
        ▼                                 （--caps=storage），挂在 Agent scope 上
当前 Session 的 Chromium
        ▲
DSH Web 右侧栏「测试账号」面板 ── POST /api/test-account ──┘（只读列表 + 切换 / 编辑 / 删除）
```

## 一、安装

两条路线都能装出同样的功能，**同一个 profile 只走一条**：

| 机器 | 路线 |
| --- | --- |
| 有本仓库 checkout | **A** 本地源码：[三条命令](#12-路线-a本地源码) |
| 只有 DSH、没有源码 | **B** 公共 npm：[`dsh plugin … add @songxiyuan/…`](#13-路线-b公共-npm) |

> **给 AI Agent**：以下步骤自包含，命令都在**仓库根目录**执行；逐条检查退出码，非 0 就停下查
> [§1.6](#16-故障--处理)；不要改 DSH 官方包、不要动别人正在用的 profile / GUI 进程、不要写 `postinstall`。
> 所有步骤幂等，可重复执行。

### 1.1 前置条件

| 检查 | 命令 | 通过标准 |
| --- | --- | --- |
| Node.js | `node -v` | ≥ `v22.18`（测试直接跑 `.ts`，依赖原生 type stripping） |
| pnpm | `pnpm -v` | 有版本号（本项目 `pnpm@11.9.0`） |
| 网络 | `npm ping` | `PONG`（要能拉 npm 上的 `@deepseek-ai/*`） |
| 浏览器（可选） | macOS `ls "/Applications/Google Chrome.app"` | 有 Chrome / Chromium / Edge 则登录态功能开箱即用 |
| 路线 B 额外 | `npm config get registry` | `https://registry.npmjs.org/`（公共 npm 安装**不需要任何 token**） |

### 1.2 路线 A：本地源码

```bash
# 1) 构建：本地装进 profile 的是 link:，运行时直读仓库里的 lib/，而 lib/ 是构建产物（已 gitignore）
pnpm install && pnpm run build

# 2) profile 不存在时先按 web 模板初始化 —— 别跳过：
#    `dsh plugin` 自己建的 profile 只带 @deepseek-ai/dsh-base，没有 web app，也就没有面板；
#    已存在的 profile 不能再用 --from-default-profile（会报 already exists），所以先判断再初始化
test -f "${DSH_HOME:-$HOME/.dsh}/profiles/test-account/package.json" ||
dsh --profile test-account --from-default-profile web --dump-config >/dev/null

# 3) 装进目标 profile（两个包都要显式给出：cordis.patch.yml 按包名解析 provider）
dsh plugin --profile test-account add ./packages/test-account ./packages/playwright-mcp-storage
```

三条命令都在**仓库根目录**执行（`dsh plugin` 会把相对路径锚到当前目录）、都幂等。没有 `dsh`
时把命令里的 `dsh` 换成 `npx -y @deepseek-ai/dsh@0.1.5-rc.3`。

- **第 1 条不能省**：`dsh plugin add <本地目录>` 只建 `link:`，不跑 `build`（`prepack` 只在
  `npm pack` / `publish` 时执行）。漏掉就是"装成功但没面板"。
- **第 2 条不能省**：`dsh plugin` 自己建的 profile 用 `DEFAULT_PROFILE_BUNDLES =
  ["@deepseek-ai/dsh-base"]`，没有 `@deepseek-ai/dsh-web-app` 就没有 webserver / connection /
  右侧栏 slot，`/api` 也不存在；而 `--from-default-profile` 对已存在或内置模板名的 profile 一律拒绝。
- `link:` 是活挂：改完源码 `pnpm run build` + 重启该 profile 即生效，不必重跑第 3 条。0.1.1 之前装过
  0.1.7 browser-use 栈或 `@dsh-test-account/*` 旧 scope 的 profile，按 §1.6 对应行清掉。

### 1.3 路线 B：公共 npm

两个包都发在公共 npm（scope `@songxiyuan`），**装的时候不需要 token、不需要 `.npmrc`**：

```bash
# 0) profile 不存在时先按 web 模板初始化（同 §1.2 第 2 条，理由相同）
test -f "${DSH_HOME:-$HOME/.dsh}/profiles/test-account/package.json" ||
dsh --profile test-account --from-default-profile web --dump-config >/dev/null

# 1) 装进目标 profile（两个包都要显式给出：cordis.patch.yml 按包名解析 provider）
dsh plugin --profile test-account add \
  @songxiyuan/test-account \
  @songxiyuan/playwright-mcp-storage
```

| 场景 | 命令 |
| --- | --- |
| 首次安装 | 上面两条（初始化 + `add`） |
| 升级到最新版 | `dsh plugin --profile <p> update @songxiyuan/test-account @songxiyuan/playwright-mcp-storage`，再重启该 profile |
| 装指定版本 | `dsh plugin --profile <p> add @songxiyuan/test-account@0.1.1 @songxiyuan/playwright-mcp-storage@0.1.1` |

> **从 GitHub Packages 迁过来**：0.1.0 只在 GitHub Packages 上。公共 npm 的 0.1.1 与它同 scope 同名，
> 直接 `update` 到 `^0.1.0` 范围外即可换源；若 lockfile 仍指向 `npm.pkg.github.com`（报 `401` / `404`），
> 强制重解析：`dsh plugin --profile <p> add @songxiyuan/test-account@0.1.1 @songxiyuan/playwright-mcp-storage@0.1.1`。
> 装完把 `~/.npmrc` 里为 GitHub Packages 加的 `@songxiyuan:registry=…` 与
> `//npm.pkg.github.com/:_authToken=…` 两行删掉。

### 1.4 安装后自检（必须全绿再继续）

```bash
# A. 构建产物
test -f packages/test-account/lib/index.js &&
test -f packages/test-account/lib/client.js &&
test -f packages/playwright-mcp-storage/lib/index.js &&
echo "OK: build artifacts"

# B. profile 依赖齐全 + bundle patch 已挂载（纯读，无副作用）
DSH_HOME="${DSH_HOME:-$HOME/.dsh}" node -e '
const fs=require("fs"),path=require("path");
const home=process.env.DSH_HOME,name=process.argv[1];
const p=JSON.parse(fs.readFileSync(path.join(home,"profiles",name,"package.json"),"utf8"));
const need=["@songxiyuan/test-account","@songxiyuan/playwright-mcp-storage"];
const missing=need.filter(n=>!p.dependencies||!p.dependencies[n]);
const bundles=(p.dsh&&p.dsh.profile&&p.dsh.profile.bundles)||[];
if(missing.length||!bundles.includes("@songxiyuan/test-account")){console.error("FAIL",{missing,bundles});process.exit(1);}
console.log("OK: profile",name,"deps=2 bundle-patch=yes");' test-account

# C. 类型 + 构建 + 单测 + client bundle 结构 + 发布包完整性
pnpm run verify
```

### 1.5 启动与验收

```bash
# 0.1.5 线用根命令启动任意 profile（`web` 子命令写死 --profile web）
dsh --profile test-account --port 3081
# 没有 dsh 就用：npx -y @deepseek-ai/dsh@0.1.5-rc.3 --profile test-account --port 3081
```

打开终端打印的带 token URL → **先在这个 Session 发一条消息**（对话头快捷入口只在有 turn 的 Session 上
出现）→ 右侧栏 `+` →「测试账号」，能看到账号列表即 Host 路由已通。

> **装进正在使用的 profile**（例如 GUI 的 `web`）：`dsh plugin add` 会立刻改 profile 的 `package.json`
> / lockfile，但 `dsh.profile.bundles` 只在进程启动时合成，所以**必须重启那个 DSH 进程**面板才会出现；
> launchd 托管的 GUI 用 `launchctl kickstart -k gui/$(id -u)/com.nomis.dsh-web`。回滚：恢复
> `~/.dsh/profiles/<name>/{package.json,pnpm-lock.yaml}` 后重跑 `dsh plugin --profile <name> install`。

> **浏览器本体**：provider 默认自动探测本机 Chrome / Chromium / Edge 并复用。都没有时第一次保存登录态
> 会提示两条出路：`npx @playwright/mcp install-browser chrome-for-testing`，或显式配 `executablePath`。
> 详见 [`packages/playwright-mcp-storage/README.md`](packages/playwright-mcp-storage/README.md#浏览器本体)。

### 1.6 故障 → 处理

| 症状 | 处理 |
| --- | --- |
| `pnpm: command not found` | `corepack enable && corepack prepare pnpm@11.9.0 --activate` |
| `npm error ENOENT ... _npx/<hash>/package.json` | npx 缓存损坏：`rm -rf ~/.npm/_npx` 后重跑，或改用 PATH 上的 `dsh` |
| `profile "web" is shipped and cannot be a custom profile target` | 对**已存在**或叫内置模板名的 profile 跑了 `--from-default-profile`；§1.2 第 2 条的 `test -f … \|\|` 就是为挡住它 |
| profile 里残留 0.1.7 browser-use 栈或 `@dsh-test-account/*` 旧 scope | 先 `grep -E 'browser-use\|@dsh-test-account/' "${DSH_HOME:-$HOME/.dsh}/profiles/<p>/package.json"`，有输出再 `dsh plugin --profile <p> remove @deepseek-ai/dsh-browser-use @deepseek-ai/dsh-experimental-browser-use-runtime @songxiyuan/browser-use-playwright-mcp-storage @dsh-test-account/test-account @dsh-test-account/playwright-mcp-storage` |
| `error: web takes none of parent --profile …` | 0.1.5 的 `web` 子命令写死 `--profile web`；改跑 `dsh --profile <name> --port 3081` |
| `ERR_PNPM_FETCH_401` / `404 … npm.pkg.github.com` | lockfile 还停在旧的 GitHub Packages 源；按 [§1.3](#13-路线-b公共-npm) 强制重解析 |
| `ERR_PNPM_FETCH_401 … registry.npmjs.org` | 公开包匿名可装；报 401 说明 `~/.npmrc` 有失效的 `_authToken`/scope 映射，临时用 `npm_config_userconfig=/dev/null` 复跑定位 |
| 装上了，但右侧栏/对话头没有「测试账号」 | profile 是 `dsh plugin` 顺手建的、没有 web app；或 Session 还没有 turn；或装进运行中的 profile 后没重启 |
| `Browser "chrome-for-testing" is not installed` | 装本机 Chrome / Chromium / Edge；或 `npx @playwright/mcp install-browser chrome-for-testing`；或配 `provider.executablePath` |
| `MODULE_NOT_FOUND … /profiles/<p>/node_modules/@playwright/mcp/cli.js`（早期版本只在子进程里炸） | profile 里剩着一份从 registry 时代剪枝下来的 `@playwright/mcp`；provider 现在加载时就会拦住并报 `@playwright/mcp CLI is missing`。按提示重装依赖：`link:` 路线在插件仓库 `pnpm install` 再重启 profile；registry 路线 `dsh plugin --profile <p> update @songxiyuan/playwright-mcp-storage`。**别**把 `@playwright/mcp` 单独装进 profile |
| `File access denied ... outside allowed roots` | 用本仓库的 storage provider（默认带 `--allow-unrestricted-file-access`） |
| 报 `session-not-live` | 拿别的 Session 的 id 调浏览器了，在同一个 Session 内操作 |
| 装依赖拉到 `0.1.6-alpha` / `0.1.7-alpha` | npm 缓存或旧 lockfile 残留：删掉 `node_modules` 与 `pnpm-lock.yaml` 重装 |

**硬性约束**：不装 / 不升 `@playwright/mcp`（固定 `0.0.80`），`@deepseek-ai/*` 不用 `latest`（锁
`0.1.5-rc.3` + cordis `4.0.2`）；不改 DSH 官方包；不动别人正在用的 profile / GUI；不把 npm token 写进
仓库文件；不写 `postinstall` 改用户 profile；不采集用户名 / 密码 / 验证码。

### 1.7 机器可读摘要

```yaml
plugin: "@songxiyuan/test-account"
default_profile: test-account
dsh_version: 0.1.5-rc.3
cordis_version: 4.0.2
pnpm_version: 11.9.0
node_min: "22.18"
local_source:
  build: "pnpm install && pnpm run build"
  init_profile: "test -f \"${DSH_HOME:-$HOME/.dsh}/profiles/test-account/package.json\" || dsh --profile test-account --from-default-profile web --dump-config >/dev/null"
  add: "dsh plugin --profile test-account add ./packages/test-account ./packages/playwright-mcp-storage"
  linked: true  # link: 安装：改完源码 rebuild + 重启即可，不必重装
registry_entry:
  registry: "https://registry.npmjs.org"
  scope: "@songxiyuan"
  auth: "none (public packages)"
  add: "dsh plugin --profile <p> add @songxiyuan/test-account @songxiyuan/playwright-mcp-storage"
  update: "dsh plugin --profile <p> update @songxiyuan/test-account @songxiyuan/playwright-mcp-storage  # 然后重启该 profile"
local_packages: [packages/test-account, packages/playwright-mcp-storage]
profile_checks: { dependencies_present: 2, bundles_contains: "@songxiyuan/test-account" }
start: "dsh --profile test-account --port 3081"
verify: "pnpm run verify"
account_store: "${DSH_HOME:-~/.dsh}/test-accounts"
agent_tools: [account_list, account_save, account_use, account_current]
```

## 二、用起来

1. 打开一个 Session：右侧栏 `+` →「测试账号」，或点对话头部的「测试账号」。

   > 头部按钮挂在对话头上，所以**刚新建、还没发过消息的空 Session**看不到它；右侧栏本身也是 Session
   > 级的，没有 Session 时不存在。

2. 在对话里把站点和凭据告诉 Agent，例如：

   > 打开 `https://example.com/login`，用 `test@example.com` / `hunter2` 登录，成功后保存成账号 `vip-us`。

3. Agent 用当前 Session 的浏览器打开页面、填入账号密码并提交登录；**确认已登录后**调用
   `account_save`（`id` / `name`，可选 `site` / `tags`）。插件把这次登录的 `storageState` 落盘，并把
   本 Session 的当前账号标为该账号。
4. 换账号：面板点「使用账号」，或让 Agent 调用 `account_use`，插件把对应 `storageState` 灌回浏览器。
5. 登录过期：让 Agent 重新登录并再 `account_save` 覆盖，或在浏览器里手工登录后点「更新登录态」。

面板里还能编辑账号元数据（名称 / 站点 / 标签）和删除账号；**添加账号只能由 Agent 完成，面板不再提供
「+ 添加」**。凭据不会进入插件：它只出现在对话和页面输入框里。

Session→账号的记录按 Session 分开：A Session 切账号不影响 B，两个 Session 可以同时各用一个账号。

## 三、数据布局

```text
${DSH_HOME:-~/.dsh}/test-accounts/
├── accounts.json          # 账号元数据（无凭据）
└── states/
    ├── vip-us.json        # Playwright storageState（cookies + localStorage）
    └── free-us.json
```

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

## 四、配置

`packages/test-account/cordis.patch.yml` 里的默认值：

```yaml
- insert:
    - id: test-account-playwright-mcp
      name: '@songxiyuan/playwright-mcp-storage'
      config:
        mode: launch          # launch | attach
        headless: false       # 手工登录 / 看得见页面
        allowUnrestrictedFileAccess: true

    - id: test-account
      name: '@songxiyuan/test-account'
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
| `test-account.stateAccess` | `direct` 直接把账号路径交给浏览器工具；`staged` 先在工作区落临时文件再搬运 |
| `test-account.agentTools` | 是否向 Agent 暴露 `account_*` 工具，默认 `true` |
| `provider.caps` | 传给 `@playwright/mcp` 的能力，默认 `['storage']`（核心浏览器工具始终可用） |
| `provider.allowUnrestrictedFileAccess` | 允许 storage 工具读写 Session 工作区之外的路径（账号目录需要），默认开 |
| `provider.headless` | 是否无窗口，默认 `false` |
| `provider.executablePath` | 显式指定浏览器（复用本机 Chrome），优先于自动探测 |
| `provider.autoExecutablePath` | 默认 `true`：按平台探测本机已装的 Chrome / Chromium / Edge |

## 五、Agent 工具

`agentTools` 打开时，插件注册四个模型可见的工具。它们和面板走同一个 `AccountService`，所以校验、
错误码、Session 记账完全一致；工具操作的是**调用方 Session 自己的浏览器**（`exec.agent.id`），
既不接收 `sessionId`，也不接收任何凭据。

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `account_list` | — | 列账号与登录态状态，并指出本 Session 当前账号。只读 |
| `account_save` | `id`, `name`, `site?`, `tags?` | 把当前浏览器的登录态登记为账号（同 id 则更新并覆盖），并把本 Session 标为它 |
| `account_use` | `id` | 把该账号的 `storageState` 恢复到本 Session 的浏览器，并标为当前账号 |
| `account_current` | — | 查询本 Session 当前账号 |

登录动作本身由 Agent 用通用浏览器工具（`browser_navigate` / `browser_type` / `browser_fill_form` /
`browser_click`）完成，插件只负责在登录之后抓取 `storageState`。这样「正在用哪个账号」对人和对 Agent
是同一份事实，Agent 也能按指定身份继续浏览器操作 / E2E / 排障。

## 六、开发与验证

```bash
pnpm install
pnpm run typecheck     # 两个包的 host/client 类型检查
pnpm run build         # tsc 出 host 半 + esbuild 出 lib/client.js
pnpm run test          # node:test 单元测试（store + provider 参数 + 浏览器桥降级）
pnpm run verify        # 以上全跑，并做 client bundle 结构检查 + 发布包完整性检查
pnpm run check:pack    # 只跑发布包完整性：npm pack 清单 vs lib/*.js 的相对导入
pnpm run publish:npm   # 维护者发版：verify + 发布到公共 npm（registry.npmjs.org）
```

`lib/` 是构建产物（已在 `.gitignore`），不要提交。`pnpm run verify` 里两项检查值得知道：

- `scripts/check-pack.mjs` 读真正的 `npm pack` 清单，断言每个 `lib/*.js` 的相对导入也在包里。两个包的
  `files` **只能写目录**：写成具体文件名会让发布包缺兄弟模块，本地完全复现不了，装到别的机器才炸。
- `scripts/check-bundle.mjs` 在 vm 里执行 `lib/client.js`，断言它走 `window.__ModuleLoader__.load({ id,
  factory })` 并导出 `apply` / `inject`。

真机冒烟（改动路由 / 工具执行 / provider 参数后跑，需要已有实例）：

```bash
dsh --profile test-account --port 3081          # 记下打印的带 token URL
pnpm run smoke:ui "http://127.0.0.1:3081/?token=..."                        # 只验面板
pnpm run smoke:ui "http://127.0.0.1:3081/?token=..." -- --home ~/.dsh       # 连浏览器登录态一起验
```

带 `--home` 时覆盖「面板 → 路由 → `ctx.tools.execute` → MCP → 真 Chrome → 落盘 → 恢复」整条链路。
`--home` 段靠「最新 session 目录」定位 Session，同一个 `DSH_HOME` 里有别的实例在写 sessions 时会挑错
（报 `session-not-live`），此时用全新 `DSH_HOME` 或先只跑面板段。

## 七、几个来自真实代码的结论（与设计文档的差异）

设计文档 `doc/dsh-test-account-plugin-design.md` 有几处和实际 DSH 代码不一致，实现按代码来：

1. **客户端 UI 是 React 18，不是 Vue**：DSH 0.1.5 的客户端插件运行时是 React + slot 注册 +
   `window.__ModuleLoader__.load` 懒加载 CJS，所以是 `AccountPanel.tsx`。
2. **storage 工具需要 `--caps=storage`**：`@playwright/mcp@0.0.80` 里 `browser_storage_state` /
   `browser_set_storage_state` 的 capability 是 `storage`，而官方 Playwright provider 把参数写死成
   `--browser chromium --isolated`、没有透传口子——这就是自带 `playwright-mcp-storage` 的唯一原因。
3. **Host↔Client 用自定义 Fetch 路由**：`ctx.connection.rpc.handle` 对插件不可用（内部 `owner.webServer`
   会被 Cordis context tracing 解析回 connection 自己的 scope），`rpc.intercept('/api', …)` 被 Typert
   gateway 独占。最终用 `ctx.connection.fetch.register({ path: '/api/test-account', methods: ['POST'] })`，
   天然走 `/api` 的 Origin 校验与浏览器 token 鉴权。
4. **浏览器操作走 `ctx.tools.execute`**：工具名 `mcp__playwright-mcp__browser_storage_state` /
   `browser_set_storage_state`，`agent` 由 `ctx.agents.get(sessionId)` 取得。插件不碰浏览器 API，只转发
   这一个调用。
5. **不依赖 DSH Browser Use**：`@deepseek-ai/dsh-browser-use` 与
   `dsh-experimental-browser-use-runtime` 在 0.1.5 线不存在（npm 最低 `0.1.6-alpha.1`）。provider 改用
   0.1.5 自带的 `@deepseek-ai/dsh-mcp-client`：监听 `agent/created` + `createScope(ctx, agent)`，给每个
   live Agent 挂一个 `@playwright/mcp` 子进程，Agent 结束或插件卸载时 dispose 作用域关掉进程；
   `tools/execute` 上还有一道守卫，别的 Session 调不到这套工具。`attach` 模式独占。
6. **上游 storage 工具只写文件、不建目录**：`browser_storage_state` 直接 `open(...,'w')`，而 `<store>/states/`
   首次保存时还不存在，所以 `browser-storage.ts` 在 direct 直连前先 `mkdir(..., { recursive: true })`，
   否则「新账号第一次保存登录态」必然 `ENOENT`（有单测覆盖）。
7. **文件访问权限的取舍**：MCP storage 工具默认只能读写 Session 工作区，账号目录在工作区外。provider
   默认带 `--allow-unrestricted-file-access`；换回官方 provider 时插件自动**降级**——在工作区写
   `.dsh-test-account-storage-<uuid>.json` 临时文件、调完即删，这条路径也有单测覆盖。
8. **分发用公共 npm**：包名 `@songxiyuan/*`，`publishConfig` 只声明 `access: public`、不覆盖 registry，
   所以 `npm publish` 默认落到 `registry.npmjs.org`，目标机器匿名可装。发布物完整性由 `check-pack` 守。
9. **DSH profile 的 pnpm 配置是 `nodeLinker: hoisted` + `autoInstallPeers: false`**：① provider 必须在
   profile 顶层依赖里，所以 `dsh plugin add` 时两个包都要显式给出；② peer 依赖不会自动装，
   `@deepseek-ai/*` 一律由 profile 的 module fallback 提供，不会意外拉到 `0.1.6-alpha` / `0.1.7-alpha`。
10. **账号创建只经过 Agent 工具**：设计文档里的面板「+ 添加」已移除。`account_save` 是唯一的创建入口，
    它先 upsert 元数据、再用同一 `AccountService` 抓取 storageState 并把 Session 标为当前账号；
    `accounts/create` 路由端点保留给测试与脚本，但面板不再调用它。

## 八、范围

已完成：Agent 驱动的账号登记（`account_save`）、登录态保存 / 更新 / 恢复、当前账号展示、Session 隔离、
元数据编辑 / 删除、面板。

暂不包含：插件自身不接收 / 不保存用户名密码验证码、不做验证码识别、不做 OAuth/SSO、不做登录态自动
续期、不手工编辑 Cookie、不做过期自动检测。（登录表单由 Agent 用通用浏览器工具填写，是 Agent 行为，
不是插件能力。）

后续可加：登录态过期探活（`verifyUrl`）、账号分组 / 搜索、导出登录态给 CI 的 `mode: attach` 流程。

## 九、发布到公共 npm（维护者）

`@songxiyuan` scope 只有 npm 用户 `songxiyuan` 能发；scope 与 GitHub 仓库 owner 同名只是巧合，公共 npm
**不校验**这一点。

```bash
# 0) 一次性：登录并确认身份（2FA 账号走 web 登录最省事）
npm login                                  # 无头机器用 npm login --auth-type=legacy + OTP
npm whoami                                 # 必须打印 songxiyuan

# 1) 本地发布（先跑满 verify，再由 pnpm 逐包 publish）
pnpm run publish:npm
```

**CI 发布**：`.github/workflows/publish.yml` 用仓库 secret `NPM_TOKEN`（npm granular token，`@songxiyuan`
scope 的 read+write）；`GITHUB_TOKEN` 只用来挂 Release tarball。开了 2FA 的账号必须勾 granular token 的
**Bypass 2FA**，否则报 `E403 … bypass 2fa enabled is required`。

```bash
git tag v0.1.1 && git push origin v0.1.1   # 或 Actions → publish → Run workflow
```

- 本地 `npm whoami` 通过不等于能发布：`E403` 大多是 2FA。发多个包用
  `pnpm -r --filter './packages/*' publish --otp=<6 位码> --registry https://registry.npmjs.org`。
- `prepack` 负责构建；`files` 只写目录，绝不列具体文件名（否则发布包缺兄弟模块）。
- `publishConfig` 只留 `access: public`：**不要**再写 `registry`，否则又会发到别的源。
- 改 scope 要一起改：两个 `package.json`、`cordis.patch.yml`、`client/index.tsx` 的 `PANEL_ID`、
  `scripts/build-client.mjs` 写入的 bundle id（= 包名，必须重新 `build`）与文档。
- 版本号一旦发布就永久占位，撤回要 `npm unpublish` 后发更高的号（已发布版本 24h 后不可 unpublish）。

## 参考

- 设计文档：[`doc/dsh-test-account-plugin-design.md`](doc/dsh-test-account-plugin-design.md)
- DSH 插件发布 / 安装：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- Playwright Browsers：<https://playwright.dev/docs/browsers>

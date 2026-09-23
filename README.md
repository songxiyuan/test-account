# dsh-test-account

在 DSH 里管理测试账号登录态：一个账号列表面板，加「保存当前浏览器登录态 / 一键切换账号 /
标记当前 Session 在用哪个账号」三件事。

核心原则：**不内嵌 Playwright、不保存密码、不实现自动登录、不引入数据库。**

```text
DSH Web 右侧栏「测试账号」面板
        │  POST /api/test-account（Connection 的鉴权 /api 前缀）
        ▼
@songxiyuan/test-account                ← 账号元数据 + states/*.json + Session→账号
        │  ctx.tools.execute
        ▼
mcp__playwright-mcp__browser_storage_state / browser_set_storage_state
        ▼
@songxiyuan/playwright-mcp-storage      ← 每个 live Session 一个 @playwright/mcp 进程
        ▼                                 （--caps=storage），挂在 Agent scope 上
当前 Session 的 Chromium
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

三条命令都在**仓库根目录**执行（`dsh plugin` 会把相对路径锚到当前目录）、都幂等，可重复跑。没有 `dsh`
时把命令里的 `dsh` 换成 `npx -y @deepseek-ai/dsh@0.1.5-rc.3`。

装进去的是 `link:`（profile 的 `node_modules` 软链回仓库），所以改完源码只要 `pnpm run build` +
重启该 profile 就生效，**不必重跑第 3 条**。0.1.1 之前装过 0.1.7 browser-use 栈或 `@dsh-test-account/*`
旧 scope 的 profile，按 §1.6 的对应行手工清掉。

> **第 1 条不能省**：`dsh plugin add <本地目录>` 只建一个 `link:`，不会替你 `build`（`prepack` 只在
> `npm pack` / `publish` 时跑，那是路线 B 的 tarball 才有的）。漏掉就是"装成功但没面板"。
>
> **第 2 条不能省**：profile 不存在时 `dsh plugin` 会自己建，但用的是 `DEFAULT_PROFILE_BUNDLES =
> ["@deepseek-ai/dsh-base"]`——没有 `@deepseek-ai/dsh-web-app` 就没有 webserver / connection /
> 右侧栏 slot，`/api` 也不存在。而 `--from-default-profile` 对已存在的 profile 一律拒绝，对 `web` /
> `acp` / `headless` / `sdk` 这类内置模板名更是只看名字就拒绝（`./… web` 会报 `is shipped`），
> 所以必须先判断再初始化。

### 1.3 路线 B：公共 npm

两个包都发在公共 npm（scope `@songxiyuan`），**装的时候不需要 token、不需要 `.npmrc`**：

```bash
# 0) profile 不存在时先按 web 模板初始化 —— 别跳过：
#    `dsh plugin` 自己建的 profile 只带 `@deepseek-ai/dsh-base`，没有 web app，也就没有面板
test -f "${DSH_HOME:-$HOME/.dsh}/profiles/test-account/package.json" ||
dsh --profile test-account --from-default-profile web --dump-config >/dev/null

# 1) 装进目标 profile（两个包都要显式给出：cordis.patch.yml 按包名解析 provider）
dsh plugin --profile test-account add \
  @songxiyuan/test-account \
  @songxiyuan/playwright-mcp-storage
```

升级：`dsh plugin --profile test-account update`，然后重启该 profile 的 DSH 进程。

```bash
# 把最新版本拉进 profile 的 package.json / lockfile（不改 profile 的 profile/bundles 结构）
dsh plugin --profile test-account update @songxiyuan/test-account @songxiyuan/playwright-mcp-storage
```

| 场景 | 命令 |
| --- | --- |
| 首次安装 | 上面两条（初始化 + `add`） |
| 日常升级到已发布的最新版 | `dsh plugin --profile <p> update @songxiyuan/test-account @songxiyuan/playwright-mcp-storage`（或整表 `update`），再重启该 profile |
| 装指定版本 | `dsh plugin --profile <p> add @songxiyuan/test-account@0.1.1 @songxiyuan/playwright-mcp-storage@0.1.1` |

> **从 GitHub Packages 迁过来**：0.1.0 只在 GitHub Packages 上，profile 的 lockfile 里记的是
> `npm.pkg.github.com`。公共 npm 的 0.1.1 与它同 scope 同名，直接 `update` 到 `^0.1.0` 范围外即可换源；
> 若 lockfile 仍指向 `npm.pkg.github.com`（报 `401` / `404`），在 profile 目录里强制重解析：
> `dsh plugin --profile <p> add @songxiyuan/test-account@0.1.1 @songxiyuan/playwright-mcp-storage@0.1.1`。
> 装完把 `~/.npmrc` 里为 GitHub Packages 加的 `@songxiyuan:registry=…` 与
> `//npm.pkg.github.com/:_authToken=…` 两行删掉，避免以后又走回旧源。

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

> **浏览器本体**：provider 默认自动探测本机 Chrome / Chromium / Edge 并复用，装了 Chrome 的机器开箱
> 即用。都没有时第一次保存登录态会提示两条出路：`npx @playwright/mcp install-browser chrome-for-testing`，
> 或显式配 `executablePath`。详见 [`packages/playwright-mcp-storage/README.md`](packages/playwright-mcp-storage/README.md#浏览器本体)。

### 1.6 故障 → 处理

| 症状 | 处理 |
| --- | --- |
| `pnpm: command not found` | `corepack enable && corepack prepare pnpm@11.9.0 --activate` |
| `npm error ENOENT ... _npx/<hash>/package.json` | npx 缓存损坏：`rm -rf ~/.npm/_npx` 后重跑，或改用 PATH 上的 `dsh`（§1.2 里 `dsh` 的替换反过来） |
| `profile "web" is shipped and cannot be a custom profile target` | 对**已存在**或**叫内置模板名**的 profile 跑了 `--from-default-profile`；§1.2 第 2 条的 `test -f … \|\|` 就是为挡住它 |
| profile 里残留 0.1.7 browser-use 栈或 `@dsh-test-account/*` 旧 scope | 0.1.1 之前的旧 profile 才会命中：先 `grep -E 'browser-use\|@dsh-test-account/' "${DSH_HOME:-$HOME/.dsh}/profiles/<p>/package.json"`，有输出再 `dsh plugin --profile <p> remove @deepseek-ai/dsh-browser-use @deepseek-ai/dsh-experimental-browser-use-runtime @songxiyuan/browser-use-playwright-mcp-storage @dsh-test-account/test-account @dsh-test-account/playwright-mcp-storage` |
| `error: web takes none of parent --profile …` | 0.1.5 的 `web` 子命令写死 `--profile web`；改跑 `dsh --profile <name> --port 3081` |
| `ERR_PNPM_FETCH_401` / `404 … npm.pkg.github.com` | profile 的 lockfile 还停在旧的 GitHub Packages 源；按 [§1.3](#13-路线-b公共-npm) 的迁移步骤强制重解析到公共 npm |
| `ERR_PNPM_FETCH_401 … registry.npmjs.org` | 公共 npm 的公开包匿名可装；报 401 说明 `~/.npmrc` 里有失效的 `_authToken`/scope 映射，临时用 `npm_config_userconfig=/dev/null` 复跑定位 |
| 装上了，但右侧栏/对话头没有「测试账号」 | profile 是 `dsh plugin` 顺手建的、没有 web app；或 Session 还没有 turn；或装进运行中的 profile 后没重启 |
| `Browser "chrome-for-testing" is not installed` | 装本机 Chrome / Chromium / Edge；或 `npx @playwright/mcp install-browser chrome-for-testing`；或配 `provider.executablePath` |
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
```

## 二、用起来

1. 打开一个 Session，在右侧栏点「测试账号」（对话头快捷按钮，或右侧栏 `+` →「测试账号」）。

   > 头部按钮挂在对话头上，所以**刚新建、还没发过消息的空 Session**看不到它；右侧栏本身也是 Session
   > 级的，没有 Session 时不存在。
2. 「+ 添加」建账号：只需要名称 / ID / 站点 / 标签，**不填用户名密码**。
3. 在浏览器里手动登录某个测试账号，回到面板点「保存当前登录态」。
4. 换账号时点「使用账号」，插件把对应 `storageState` 灌回当前 Session 的浏览器。
5. 登录过期后重新登录，点「更新登录态」覆盖即可。

面板显示每个 Session 当前用的是哪个账号；不同 Session 的记录互不覆盖。

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
        headless: false       # 手工登录需要看得见浏览器
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
| `test-account.agentTools` | 是否向 Agent 暴露 `account_list` / `account_use` / `account_current`，默认 `true` |
| `provider.caps` | 传给 `@playwright/mcp` 的能力，默认 `['storage']` |
| `provider.allowUnrestrictedFileAccess` | 允许 storage 工具读写 Session 工作区之外的路径（账号目录需要），默认开 |
| `provider.headless` | 是否无窗口；保存登录态必须人工登录，所以默认 `false` |
| `provider.executablePath` | 显式指定浏览器（复用本机 Chrome），优先于自动探测 |
| `provider.autoExecutablePath` | 默认 `true`：按平台探测本机已装的 Chrome / Chromium / Edge |

## 五、Agent 工具

除了面板，插件还向 Agent 暴露三个工具，让「当前用哪个账号」对人和对 Agent 是同一份事实：

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `account_list` | — | 列账号与登录态状态，并指出本 Session 当前账号。只读 |
| `account_use` | `id` | 把该账号的 `storageState` 恢复到**调用方 Session 自己的浏览器**，并标记当前账号 |
| `account_current` | — | 查询本 Session 当前账号 |

它们与面板共用同一个 `AccountService`，所以校验、错误码、Session 记账完全一致；浏览器目标由
`exec.agent.id` 决定，工具既不接收 `sessionId`，也不接收任何凭据。配置 `agentTools: false` 可整体关掉。

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
# 首次先按 §1.2 的三条命令装好 profile；之后改完源码只需 pnpm run build + 重启（link: 活挂）
dsh --profile test-account --port 3081          # 记下打印的带 token URL

pnpm run smoke:ui "http://127.0.0.1:3081/?token=..."                        # 只验面板
pnpm run smoke:ui "http://127.0.0.1:3081/?token=..." -- --home ~/.dsh       # 连浏览器登录态一起验
```

带 `--home` 时覆盖「面板 → 路由 → `ctx.tools.execute` → MCP → 真 Chrome → 落盘 → 恢复」整条链路。
`--home` 段靠「最新 session 目录」定位 Session，同一个 `DSH_HOME` 里有别的实例在写 sessions 时会挑错
（报 `session-not-live`），此时用全新 `DSH_HOME` 或先只跑面板段。保存登录态必须人工登录，所以
「登录 → 保存 → 换账号 → 恢复」这一步不在自动化里。

## 七、几个来自真实代码的结论（与设计文档的差异）

设计文档 `doc/dsh-test-account-plugin-design.md` 有几处和实际 DSH 代码不一致，实现按代码来：

1. **客户端 UI 是 React 18，不是 Vue**：DSH 0.1.5 的客户端插件运行时是 React + slot 注册 +
   `window.__ModuleLoader__.load` 懒加载 CJS，没有 Vue 入口，所以是 `AccountPanel.tsx`。
2. **storage 工具需要 `--caps=storage`**：`@playwright/mcp@0.0.80` 里 `browser_storage_state` /
   `browser_set_storage_state` 的 capability 是 `storage`，而官方 Playwright provider 把参数写死成
   `--browser chromium --isolated`、没有透传口子——这就是本仓库自带 `playwright-mcp-storage` 的唯一原因。
   其余官方 provider（`chrome-devtools-mcp` / `stagehand-native`）都没有 storageState 能力。
3. **Host↔Client 用自定义 Fetch 路由**：Typert Remote 的代码生成器不随 npm 发布；`ctx.connection.rpc.handle`
   对插件不可用（内部 `owner.webServer` 会被 Cordis context tracing 解析回 connection 自己的 scope，
   抛 `cannot get property "webServer" without inject`）；`rpc.intercept('/api', …)` 被 Typert gateway 独占。
   最终用 `ctx.connection.fetch.register({ path: '/api/test-account', methods: ['POST'] })`，天然走 `/api`
   的 Origin 校验与浏览器 token 鉴权。
4. **浏览器操作走 `ctx.tools.execute`**：工具名 `mcp__playwright-mcp__browser_storage_state` /
   `browser_set_storage_state`，`agent` 由 `ctx.agents.get(sessionId)` 取得——这就是「复用当前 Session 的
   浏览器」的落点。插件不碰任何浏览器 API，只转发这一个调用。
5. **不依赖 DSH Browser Use**：`@deepseek-ai/dsh-browser-use` 与
   `dsh-experimental-browser-use-runtime` npm 上最低只有 `0.1.6-alpha.1`（0.1.5 线没有）。provider 改用
   0.1.5 自带的 `@deepseek-ai/dsh-mcp-client`：监听 `agent/created` + `createScope(ctx, agent)`，给每个 live
   Agent 挂一个 `@playwright/mcp` 子进程；Agent 结束或插件卸载时 dispose 作用域关掉进程，`tools/execute`
   上还有一道守卫，别的 Session 调不到这套工具。`attach` 模式独占（同一时刻只服务一个 live Session）。
6. **上游 storage 工具只写文件、不建目录**：`browser_storage_state` 直接 `open(...,'w')`，而 `<store>/states/`
   首次保存时还不存在，所以 `browser-storage.ts` 在 direct 直连前先 `mkdir(..., { recursive: true })`，
   否则「新账号第一次保存登录态」必然 `ENOENT`（有单测覆盖）。
7. **文件访问权限的取舍**：MCP storage 工具默认只能读写 Session 工作区，账号目录在工作区外。provider 默认带
   `--allow-unrestricted-file-access`；换回官方 provider 时插件自动**降级**——在工作区写
   `.dsh-test-account-storage-<uuid>.json` 临时文件、调完即删，这条路径也有单测覆盖。
8. **分发用公共 npm**：包名 `@songxiyuan/*`，`publishConfig` 只声明 `access: public`、不再覆盖 registry，
   所以 `npm publish` 默认落到 `registry.npmjs.org`，目标机器匿名可装（不需要 token / `.npmrc`）。
   唯一非 peer 依赖 `@playwright/mcp` 也在公共 npm 上，传递依赖能正常解析。发布物完整性由 `check-pack`
   守（见 §六）。
9. **DSH profile 的 pnpm 配置是 `nodeLinker: hoisted` + `autoInstallPeers: false`**：① provider 必须在 profile
   顶层依赖里，所以 `dsh plugin add` 时两个包都要显式给出；② peer 依赖不会自动装，`@deepseek-ai/*` 一律由
   profile 的 module fallback 提供，不会意外拉到 `0.1.6-alpha` / `0.1.7-alpha`。

## 八、范围

已完成：账号 CRUD、保存 / 更新 / 恢复登录态、当前账号展示、Session 隔离、Agent 工具。

暂不包含：用户名密码自动登录、OAuth/SSO/验证码、登录态自动续期、Cookie 手工编辑、账号过期自动检测。
后续可加：登录态过期探活（`verifyUrl`）、账号分组 / 搜索、导出登录态给 CI 的 `mode: attach` 流程。

## 九、发布到公共 npm（维护者）

发布的前提是 npm 侧的身份：`@songxiyuan` 这个 scope 只有 npm 用户（或组织）`songxiyuan` 能发。scope
与 GitHub 仓库 owner 同名只是巧合，公共 npm **不校验**这一点。

```bash
# 0) 一次性：在本机登录并确认身份（2FA 开着的账号走 web 登录最省事）
npm login                                  # 浏览器授权；无头机器用 npm login --auth-type=legacy + OTP
npm whoami                                 # 必须打印 songxiyuan
npm view @songxiyuan/test-account version  # 已发布则打印版本号，404 说明还没占位

# 1) 本地发布（先跑满 verify，再由 pnpm 逐包 publish）
pnpm run publish:npm
```

**CI 发布**：`.github/workflows/publish.yml` 用仓库 secret `NPM_TOKEN`（npm automation 或 granular
token，`@songxiyuan` scope 的 read+write）；runner 自带的 `GITHUB_TOKEN` 只用来挂 Release tarball。
开了 2FA 的账号必须勾 granular token 的 **Bypass 2FA**，否则 CI 也会拿到同一个 403。

```bash
git tag v0.1.1 && git push origin v0.1.1   # 或 Actions → publish → Run workflow
```

- 不推荐用仓库 secret 的 `NODE_AUTH_TOKEN` 名字以外的写法：workflow 里写的是 `NPM_TOKEN`，改名要同步。
- **账号开了 2FA 时**：`npm login` 只解决身份，每次 `npm publish` 仍要一个 OTP，否则报
  `E403 … Two-factor authentication or granular access token with bypass 2fa enabled is required`。
  本地发用 `pnpm -r --filter './packages/*' publish --otp=<6 位码> --registry https://registry.npmjs.org`
  （OTP 约 30 秒过期；npm 校验通过后会缓存几分钟，两个包一次命令就能发完），或者按下面用 bypass-2FA 的
  granular token。
- 本地 `npm whoami` 通过不等于能发布：`E403` 大多是 2FA（见上一条），不是 token 写错。
- `prepack` 负责构建；`files` 只写目录，绝不列具体文件名（否则发布包缺兄弟模块）。
- `publishConfig` 只留 `access: public`：**不要**再写 `registry`，否则又会发到别的源。
- 改 scope 要一起改：两个 `package.json`、`cordis.patch.yml`、`client/index.tsx` 的 `PANEL_ID`、
  `scripts/build-client.mjs` 写入的 bundle id（= 包名，必须重新 `build`）与文档。
- 版本号一旦发布就永久占位，撤回要 `npm unpublish` 后发更高的号（已发布版本 24h 后不可 unpublish）。

## 参考

- 设计文档：[`doc/dsh-test-account-plugin-design.md`](doc/dsh-test-account-plugin-design.md)
- DSH 插件发布 / 安装：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- Playwright Browsers：<https://playwright.dev/docs/browsers>

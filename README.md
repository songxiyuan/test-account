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
@songxiyuan/test-account                ← 账号元数据 + states/*.json + Session→账号
        │  ctx.tools.execute
        ▼
mcp__playwright-mcp__browser_storage_state / browser_set_storage_state
        ▼
@songxiyuan/playwright-mcp-storage      ← 每个 live Session 一个 @playwright/mcp
        ▼                                     进程（--caps=storage），由 dsh-mcp-client
当前 Session 的 Chromium                      挂在 Agent scope 上；不依赖 browser-use
```

## 零、AI 安装引导（Agent 执行清单）

> **给 AI Agent**：本节自包含，按顺序执行即可完成安装，不必先读后面章节。规则：命令都在**仓库根目录**
> 执行；逐条检查退出码，非 0 就停下按 [§0.6](#06-故障--处理) 处理；不要改 DSH 官方包、不要动别人正在用的
> profile / GUI 进程、不要写 `postinstall`。所有步骤幂等，可重复执行。

先选路线：两条路线都能装出同样的功能，但**同一个 profile 只走一条**。

| 机器 | 路线 | 入口 |
| --- | --- | --- |
| 有本仓库 checkout 的开发机 | A：本地源码安装 | `./install.sh <profile>`（[§0.2](#02-路线-a本地源码一键安装开发机)） |
| 只有 DSH、没有源码的机器 | B：从 GitHub Packages 装 `@songxiyuan/*` | 配一次 `~/.npmrc`，再 `dsh plugin --profile <p> add …`（[§0.2B](#02b-路线-b从-github-packages-安装其他机器)） |
| 不想在目标机器配 token | C：GitHub Release 的 tarball | `dsh plugin --profile <p> add <release 资产 URL>`（[§0.2C](#02c-路线-cgithub-release-的-tarball目标机器零凭据)） |

### 0.1 前置条件（先验证，缺什么先补什么）

| # | 检查 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| 1 | Node.js | `node -v` | ≥ `v22.18`（测试直接跑 `.ts`，依赖原生 type stripping；建议 24 LTS） |
| 2 | pnpm | `pnpm -v` | 有版本号（本项目 `pnpm@11.9.0`）；缺失见 §0.6 |
| 3 | bash | `bash --version` | 能跑 `install.sh`；Windows 用 Git Bash / WSL，或走 §0.3 |
| 4 | 网络 | `npm ping` | `PONG`（要能拉 npm 上的 `@deepseek-ai/*`） |
| 5 | 浏览器（可选） | macOS `ls "/Applications/Google Chrome.app"` | 有 Chrome / Chromium / Edge 则登录态功能开箱即用；没有也能装完，见 §0.6 |
| 6 | 路线 B 额外项 | `npm config get //npm.pkg.github.com/:_authToken` | 有值（classic PAT）；GitHub Packages 连 public 包都不允许匿名安装，见 §0.2B。走路线 C（Release tarball）则不需要 |

### 0.2 路线 A：本地源码一键安装（开发机）

```bash
./install.sh test-account                                   # 默认 profile：test-account
./install.sh web                                            # 装进已有 profile（示例）
DSH_VERSION=0.1.5-rc.3 ./install.sh test-account             # 钉住 npx 回退用的 DSH 版本
DSH_BIN="dsh" ./install.sh web                              # 用 PATH 上已有的 dsh（默认就会优先用它）
```

`install.sh` 依次做四件事：

| 步 | 动作 | 成功信号 |
| --- | --- | --- |
| 1 | 仓库内 `pnpm install && pnpm run build` | 生成 `packages/test-account/lib/{index.js,client.js}` 与 provider 的 `lib/index.js` |
| 2 | 目标 profile **不存在时**才从 DSH 自带 `web` 模板初始化 | 已存在则打印 `already exists; leaving it untouched`（不会重置） |
| 3 | `dsh plugin add` 2 个本地包（已有 profile 若残留旧的 browser-use 栈或 `@dsh-test-account/*` 旧 scope 会先移除） | 打印安装结果，结尾无 `error` |
| 4 | 把本插件写进 `dsh.profile.bundles` | 由 `dsh.bundle.patch` 自动完成，见 §0.4-B |

> 第 2 步必须按目录存在与否判断：`--from-default-profile` 连已存在的 profile 也会拒绝内置模板名
> （`web` / `acp` / `headless` / `sdk`），所以无条件执行会让 `./install.sh web` 直接失败。

### 0.2B 路线 B：从 GitHub Packages 安装（其他机器）

包发布在 GitHub Packages：scope `@songxiyuan`，registry `https://npm.pkg.github.com`。两个包在**公开 npm 上不存在**，
而且 GitHub Packages **对 public 包也要求认证**（[GitHub 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)），
所以每台机器先做一次认证与 scope 映射：

```bash
# 0) 目标 profile 还不存在时先按 web 模板初始化 —— 别跳过这步：
#    `dsh plugin` 自己建的 profile 只带 `@deepseek-ai/dsh-base`，没有 web app，也就没有面板
test -f "${DSH_HOME:-$HOME/.dsh}/profiles/test-account/package.json" ||
dsh --profile test-account --from-default-profile web --dump-config >/dev/null

# 1) 一次性配置：classic PAT（只装不发布 → 只要 read:packages；要发布 → 再加 write:packages）
cat >> ~/.npmrc <<'EOF'
@songxiyuan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<你的 classic PAT>
EOF

# 2) 装进目标 profile（dsh 把参数原样转给 pnpm，pnpm 读 ~/.npmrc）
dsh plugin --profile test-account add \
  @songxiyuan/test-account \
  @songxiyuan/playwright-mcp-storage

# 3) 自检：两个包应是 registry 版本（不是 link:），bundle 已挂上
dsh plugin --profile test-account list --depth 0
DSH_HOME="${DSH_HOME:-$HOME/.dsh}" node -e '
const fs=require("fs"),path=require("path");
const p=JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME,"profiles","test-account","package.json"),"utf8"));
console.log("bundles:",(p.dsh&&p.dsh.profile&&p.dsh.profile.bundles||[]).filter(n=>n.startsWith("@songxiyuan/")))'

# 4) 启动（装进正在运行的 profile 时，要重启那个 DSH 进程才生效）
dsh --profile test-account --port 3081
```

- token 必须是 **classic PAT**：GitHub Packages 不接受 fine-grained token；只读机器不需要 `write:packages`。
- 两个包**都要** add：`cordis.patch.yml` 按包名解析 provider，profile 里必须有它。DSH 生成的 profile 用
  `nodeLinker: hoisted`，所以顶层依赖最稳（不要只靠传递依赖）。
- 升级：`dsh plugin --profile test-account update`，然后重启该 profile 的 DSH 进程。
- 不想在目标机器配 token：走 §0.2C。

### 0.2C 路线 C：GitHub Release 的 tarball（目标机器零凭据）

GitHub Packages 连 public 包都要求 token，这是它的硬限制。所以每条 `v*` tag 的 CI 会把两个构建好的
`.tgz` 一并挂到 Release 上（[§十](#十发布到-github-packages维护者)），Release 资产**匿名可下载**：

```bash
V=0.1.0
BASE="https://github.com/songxiyuan/test-account/releases/download/v$V"

# 目标 profile 不存在时先按 web 模板初始化（`dsh plugin` 自建的 profile 没有 web app）
test -f "${DSH_HOME:-$HOME/.dsh}/profiles/test-account/package.json" ||
dsh --profile test-account --from-default-profile web --dump-config >/dev/null

dsh plugin --profile test-account add \
  "$BASE/songxiyuan-test-account-$V.tgz" \
  "$BASE/songxiyuan-playwright-mcp-storage-$V.tgz"
```

- tarball 里已经是构建好的 `lib/`：安装时不跑 `prepare`、不过 `allowBuilds`、**不需要 `~/.npmrc`**
  （本地实测：tarball 安装 exit 0，不触发任何构建脚本）。
- 升级要指向新版本的 URL 重新 add（profile 里记的是那一条 URL，`update` 只会重拉同一个资产）。
- 先确认资产在不在：`curl -I "$BASE/songxiyuan-test-account-$V.tgz"` 应为 302/200。

### 0.3 手工分步（`install.sh` 不可用时，与 §0.2 等价）

```bash
# 1) 构建（在仓库根目录）
pnpm install
pnpm run build

# 2) 仅当目标 profile 还不存在时初始化（已存在就跳过这一步，别对 web 这类内置模板名执行）
#    下面用 PATH 上的 dsh（0.1.5 线）；没有就换成
#    npx -y @deepseek-ai/dsh@0.1.5-rc.3
test -f "${DSH_HOME:-$HOME/.dsh}/profiles/test-account/package.json" ||
dsh --profile test-account --from-default-profile web --dump-config >/dev/null

# 3) 安装 2 个本地包
dsh plugin --profile test-account add \
  "$PWD/packages/test-account" \
  "$PWD/packages/playwright-mcp-storage"
```

### 0.4 安装后自检（必须全绿再继续）

```bash
PROFILE=test-account

# A. 构建产物存在
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
console.log("OK: profile",name,"deps=2 bundle-patch=yes");
' "$PROFILE"

# C. 类型 + 构建 + 单测 + client bundle 结构 + 发布包完整性（推荐）
#    check-pack 会打断言：npm pack 出来的 tarball 里，每个 lib/*.js 的相对导入都必须也在包里
#    （历史上 files 只列了 3 个文件，发布包缺兄弟模块，只有这一项能拦住）
pnpm run verify
```

任一项 FAIL 都不要继续，按 §0.6 处理。

### 0.5 启动与验收

```bash
# 0.1.5 线：根命令启动任意 profile（`web` 子命令写死 --profile web）
dsh --profile test-account --port 3081
# 没有 dsh 就用 npx -y @deepseek-ai/dsh@0.1.5-rc.3 --profile test-account --port 3081
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
| `profile "web" is shipped and cannot be a custom profile target` | 对**已存在**的 profile（尤其 `web` / `acp` / `headless` / `sdk` 这类内置模板名）跑了 `--from-default-profile` | 删掉初始化那一步（`install.sh` 会先判断目录是否存在）；已存在的 profile 直接 `dsh plugin --profile web add …` |
| `error: web takes none of parent --profile …` | 在 0.1.5 线用 0.1.7 的启动语法 | 0.1.5 的 `web` 子命令写死 `--profile web`；改跑 `dsh --profile <name> --port 3081`（0.1.7 才支持 `<name> web`） |
| profile 里还残留 0.1.7 的 browser-use 栈 | 早期 `install.sh` 装进去的依赖 | 重跑 `./install.sh <profile>`：它会先 `dsh plugin remove` 掉 `@deepseek-ai/dsh-browser-use` / `@deepseek-ai/dsh-experimental-browser-use-runtime` / 旧 provider，再装 0.1.5 线的两个包 |
| profile 里还残留 `@dsh-test-account/*` 旧 scope | 本插件改名前的安装 | 重跑 `./install.sh <profile>`（它会先 `dsh plugin remove` 旧 scope 的两个包）；或手工 `dsh plugin --profile <p> remove @dsh-test-account/test-account @dsh-test-account/playwright-mcp-storage` |
| `ERR_PNPM_FETCH_401` / `404 Not Found - GET https://npm.pkg.github.com/@songxiyuan%2f…` | 目标机器没配 GitHub Packages 的 token 或 scope 映射（**public 包也不允许匿名装**） | 按 §0.2B 第 1 步写 `~/.npmrc`：`@songxiyuan:registry=https://npm.pkg.github.com` + `//npm.pkg.github.com/:_authToken=<classic PAT>`（勾 `read:packages`） |
| 在公开 npm 上找不到 `@songxiyuan/…`（404） | 包只发在 GitHub Packages，没发 npmjs | 用 §0.2B 的安装命令；不要用 `npm view` 去 npmjs 验证，改用 `npm view @songxiyuan/test-account --registry https://npm.pkg.github.com` |
| 包装上了，但右侧栏/对话头里根本没有「测试账号」 | profile 是被 `dsh plugin` 顺手建出来的，`dsh.profile.bundles` 里只有 `@deepseek-ai/dsh-base`，没有 web app | 用 `web` 模板重建该 profile，或换一个已有 web profile：`dsh --profile <new> --from-default-profile web --dump-config >/dev/null` 然后重新 add（见 §0.2B 第 0 步） |
| `pnpm add` 拉 Release tarball 时超时 / `HEAD https://github.com/…` 失败 | 目标机器到 github.com 的网络不稳定（release 资产会 302 到 `objects.githubusercontent.com`） | 重试；或先把两个 `.tgz` 下载下来再 `dsh plugin add ./xxx.tgz`（等价，装的是同一份产物） |
| 装依赖时拉到 `0.1.6-alpha` / `0.1.7-alpha` 包 | npm 缓存或旧 lockfile 残留 | 删掉 `node_modules` 与 `pnpm-lock.yaml` 重新 `pnpm install`；本仓库全部锁在 `0.1.5-rc.3` + `cordis 4.0.2` |
| `Browser "chrome-for-testing" is not installed` | provider 没探测到本机浏览器 | ① 装本机 Chrome / Chromium / Edge（`autoExecutablePath` 默认复用）；或 ② `npx @playwright/mcp install-browser chrome-for-testing`；或 ③ 在 profile 配 `provider.executablePath` |
| `File access denied ... outside allowed roots` | provider 缺 `--allow-unrestricted-file-access` | 用本仓库的 storage provider；插件会降级 staged，但默认 provider 更稳 |
| `browser_storage_state 执行失败：ENOENT …/states/xxx.json` | 上游 MCP 只写文件、不建目录（`<store>/states/` 首次保存时还不存在） | 已在插件侧修掉（`browser-storage.ts` 直连前先 `mkdir`）；升级到含该修复的版本 |
| 面板里找不到「测试账号」 | Session 还没有 turn，或插件没进 `dsh.profile.bundles` | 先发一条消息；再跑 §0.4-B。装进**正在运行**的 profile 后必须重启该 DSH 进程才生效 |
| 报 `session-not-live` | 拿别的 Session 的 id 调浏览器 | 在同一个 Session 内操作 |

### 0.7 硬性约束（AI 不要做）

- ❌ 不装 / 不升 `@playwright/mcp`（固定 `0.0.80`），不把 `@deepseek-ai/*` 换成 `latest`（锁 `0.1.5-rc.3`，cordis `4.0.2`）；
- ❌ 不改 DSH 官方包；provider 行为要变就在本仓库 `packages/playwright-mcp-storage` 里改；
- ❌ 不动别人正在用的 profile / GUI 进程，验证一律用独立 profile 名；
- ❌ 不把 GitHub Packages 的 PAT 写进仓库内任何文件（只写目标机器的 `~/.npmrc`；CI 用 secret）；
- ❌ 不写 `postinstall` 去改用户 profile；
- ❌ 不采集、不存储用户名 / 密码 / 验证码，不做自动登录。

### 0.8 机器可读摘要（给 Agent 解析用）

```yaml
plugin: "@songxiyuan/test-account"
entry: ./install.sh                 # 路线 A（开发机、本地源码），幂等
registry_entry:                     # 路线 B（其他机器，GitHub Packages）
  registry: "https://npm.pkg.github.com"
  scope: "@songxiyuan"
  auth: "~/.npmrc: @songxiyuan:registry=… + //npm.pkg.github.com/:_authToken=<classic PAT, read:packages>"
  add: "dsh plugin --profile <p> add @songxiyuan/test-account @songxiyuan/playwright-mcp-storage"
  update: "dsh plugin --profile <p> update  # 然后重启该 profile 的 DSH 进程"
tarball_entry:                      # 路线 C（目标机器零凭据，CI 挂到 Release 的资产）
  url_pattern: "https://github.com/songxiyuan/test-account/releases/download/v<VERSION>/songxiyuan-<pkg>-<VERSION>.tgz"
  add: "dsh plugin --profile <p> add <两个 tarball URL>"
ci_publish:                         # 发布（不需要本地 PAT）
  workflow: .github/workflows/publish.yml
  trigger: "git tag v<VERSION> && git push origin v<VERSION>  # 或 Actions → publish → Run workflow"
  token: "runner 自带的 GITHUB_TOKEN（packages: write / contents: write）"
default_profile: test-account
dsh_version: 0.1.5-rc.3
cordis_version: 4.0.2
pnpm_version: 11.9.0
node_min: "22.18"                   # node --test 直跑 .ts 需要原生 type stripping
env:
  DSH_VERSION: "npx 回退用的 DSH 版本，默认 0.1.5-rc.3"
  DSH_BIN: "复用已有 dsh 命令；默认已优先使用 PATH 上的 dsh"
  DSH_HOME: "profile 与账号目录的根，默认 ~/.dsh"
local_packages:
  - path: packages/test-account
    name: "@songxiyuan/test-account"
    bundle_patch: cordis.patch.yml  # 安装后自动加入 dsh.profile.bundles
  - path: packages/playwright-mcp-storage
    name: "@songxiyuan/playwright-mcp-storage"
extra_packages: []                  # 不再依赖 browser-use；provider 直接带 @playwright/mcp
artifacts:
  - packages/test-account/lib/index.js
  - packages/test-account/lib/client.js
  - packages/playwright-mcp-storage/lib/index.js
publish:
  script: "pnpm run publish:gh"     # verify + pnpm -r publish（publishConfig 指向 GitHub Packages）
  registry: "https://npm.pkg.github.com"
  scope_must_equal: "GitHub 仓库 owner（songxiyuan）"
  needs: "classic PAT（write:packages）；细粒度 token 不被 GitHub Packages 支持"
profile_checks:
  dependencies_present: 2           # 上面 2 个包
  bundles_contains: "@songxiyuan/test-account"
start: "dsh --profile test-account --port 3081"
start_npx_fallback: "npx -y @deepseek-ai/dsh@0.1.5-rc.3 --profile test-account --port 3081"
note: "已存在的 profile 不会执行 --from-default-profile；残留的 0.1.7 browser-use 栈与 @dsh-test-account/* 旧 scope 会先被移除"
verify: "pnpm run verify"
account_store: "${DSH_HOME:-~/.dsh}/test-accounts"
```

## 一、安装

### A. 开发机 / 有源码：一条命令（本地源码）

```bash
./install.sh              # 装进 "test-account" profile（不存在则用 web 模板初始化）
./install.sh web          # 装进已有的 web profile（例如正在跑 GUI 的那个）
DSH_VERSION=0.1.5-rc.3 ./install.sh ta
```

`install.sh` 做四件事：

1. 在仓库里 `pnpm install && pnpm run build`；
2. **仅在目标 profile 还不存在时**从 DSH 自带的 `web` 模板初始化它（已存在则原样保留：`--from-default-profile`
   对 `web` / `acp` / `headless` 这些内置模板名连已存在的 profile 也会拒绝）；
3. 把两个本地包装进该 profile（如果 profile 里还有旧的 0.1.7 browser-use 栈或 `@dsh-test-account/*`
   旧 scope 的两个包，会先 `dsh plugin remove` 掉）：

   ```bash
   dsh plugin --profile <name> add \
     packages/test-account \
     packages/playwright-mcp-storage
   ```

4. `@songxiyuan/test-account` 声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它加进
   profile 的 `dsh.profile.bundles`，因此无需手工改 `cordis.patch.yml`。

### B. 没有源码的机器：从 GitHub Packages 装

两个包发布在 GitHub Packages（scope `@songxiyuan`），**公开 npm 上没有**；GitHub Packages 连 public 包
也要求认证，所以先写一次 `~/.npmrc`：

```bash
cat >> ~/.npmrc <<'EOF'
@songxiyuan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<classic PAT，勾 read:packages>
EOF

dsh plugin --profile test-account add \
  @songxiyuan/test-account \
  @songxiyuan/playwright-mcp-storage
```

升级用 `dsh plugin --profile test-account update`，然后重启该 profile 的 DSH 进程。完整步骤与故障排查见
[§0.2B](#02b-路线-b从-github-packages-安装其他机器) 与 [§0.6](#06-故障--处理)。

启动（整个仓库锁在 DSH `0.1.5-rc.3`；0.1.5 的 `web` 子命令写死 `--profile web`，所以用根命令启动任意
profile）：

```bash
dsh --profile test-account --port 3081
# 没有 dsh 时：
npx -y @deepseek-ai/dsh@0.1.5-rc.3 --profile test-account --port 3081
```

> **装进正在使用的 profile**（例如 GUI 的 `web`）：`dsh plugin add` 会立刻改 profile 的
> `package.json` / lockfile，但 `dsh.profile.bundles` 只在进程启动时合成，所以**必须重启那个 DSH
> 进程**面板才会出现；launchd 托管的 GUI 用 `launchctl kickstart -k gui/$(id -u)/com.nomis.dsh-web`。
> 回滚：恢复 `~/.dsh/profiles/<name>/{package.json,pnpm-lock.yaml}` 后重跑 `dsh plugin --profile <name> install`。

> **浏览器本体**：provider 默认自动探测本机 Chrome / Chromium / Edge 并复用，所以装了 Chrome 的
> 机器开箱即用。如果一台机器两者都没有，第一次保存登录态会提示两条出路：跑
> `npx @playwright/mcp install-browser chrome-for-testing`，或在 profile 里显式配
> `executablePath`。详见 [`packages/playwright-mcp-storage/README.md`](packages/playwright-mcp-storage/README.md#浏览器本体)。

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
│   └── cordis.patch.yml                     # bundle 补丁：挂载 provider + 本插件
└── playwright-mcp-storage/                  # 薄 provider（按 Session 挂 @playwright/mcp）
    └── src/
        ├── args.ts                          # 参数拼装（--caps=storage 等），可单测
        └── session-mcp.ts                   # 每个 live Agent 一个 scoped dsh-mcp-client
```

## 五、配置

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
| `test-account.stateAccess` | `direct` 直接把账号路径交给浏览器工具；`staged` 先在工作区落一个临时文件再搬运 |
| `test-account.agentTools` | 是否向 Agent 暴露 `account_list` / `account_use` / `account_current`，默认 `true` |
| `provider.caps` | 传给 `@playwright/mcp` 的能力，默认 `['storage']` |
| `provider.allowUnrestrictedFileAccess` | 允许 storage 工具读写 Session 工作区之外的路径（账号目录需要），默认开 |
| `provider.headless` | 是否无窗口；保存登录态必须人工登录，所以默认 `false` |
| `provider.executablePath` | 显式指定浏览器（复用本机 Chrome），优先于自动探测 |
| `provider.autoExecutablePath` | 默认 `true`：按平台探测本机已装的 Chrome / Chromium / Edge |

## 六、几个来自真实代码的结论（与设计文档的差异）

设计文档 `doc/dsh-test-account-plugin-design.md` 有几处和实际 DSH 代码不一致，实现按代码来：

1. **客户端 UI 是 React，不是 Vue。** DSH 0.1.5 的客户端插件运行时是 React 18 + slot 注册 +
   `window.__ModuleLoader__.load` 懒加载 CJS 包，没有 Vue 入口，所以 `AccountPanel.vue` 换成了
   `AccountPanel.tsx`。
2. **storage 工具确实需要 `--caps=storage`。** `@playwright/mcp@0.0.80` 里 `browser_storage_state` /
   `browser_set_storage_state` 的 capability 是 `storage`，而 `filteredTools()` 只保留
   `core*` 或 `config.capabilities` 里列出的工具。官方
   `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 把参数写死成
   `--browser chromium --isolated`，**没有任何透传口子**，所以本仓库自带
   `packages/playwright-mcp-storage`：自己拼 `@playwright/mcp` 参数，只多传 `--caps=storage`。
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
5. **真正调用走 `ctx.tools.execute`。** 浏览器工具名是 `mcp__playwright-mcp__browser_storage_state` /
   `mcp__playwright-mcp__browser_set_storage_state`，`agent` 由 `ctx.agents.get(sessionId)` 取得——
   这就是「复用当前 Session 的浏览器」的落点。插件不碰任何浏览器 API，只把这一个工具调用转发出去。
6. **不再依赖 DSH Browser Use，`@playwright/mcp` 直挂。** `@deepseek-ai/dsh-browser-use` 与
   `@deepseek-ai/dsh-experimental-browser-use-runtime` npm 上最低只有 `0.1.6-alpha.1`（0.1.5 线没有），
   且官方 Playwright provider 的参数写死。于是 provider 改用 0.1.5 线自带的
   `@deepseek-ai/dsh-mcp-client`：监听 `agent/created`，用 `createScope(ctx, agent)` 给每个 live Agent
   开一个作用域，在作用域里挂一个 `@playwright/mcp` 子进程（stdio）。每个 Session 因此各有一套浏览器和
   一套 `mcp__playwright-mcp__*` 工具名；Agent 结束或插件卸载时 dispose 作用域、关掉子进程；
   `tools/execute` 上还有一道守卫，别的 Session 调不到这套工具。`attach` 模式独占（同一时刻只服务一个
   live Session）。整套依赖因此只剩 `0.1.5-rc.3` + `cordis 4.0.2` + `schemastery 3.18.2`，图里没有任何
   0.1.6 / 0.1.7 包（`grep '0\.1\.7-alpha' pnpm-lock.yaml` 为空）。
7. **上游 storage 工具只写文件、不建目录。** `browser_storage_state` 拿到 `filename` 后直接
   `open(...,'w')`，父目录不存在就抛 `ENOENT`；而账号目录里的 `states/` 只有在写过一次登录态之后
   才有。所以 `browser-storage.ts` 在 `direct` 直连前先 `mkdir(dirname(access.path), {recursive:true})`，
   否则「新账号第一次保存登录态」必然失败（有单测 `direct save creates a missing destination directory` 覆盖）。
8. **跨机器分发选了 GitHub Packages，不是公开 npm。** 包名必须与仓库 owner 同 scope，所以是
   `@songxiyuan/*`。GitHub Packages 的 npm registry **对 public 包也要求 classic PAT**（见 §0.2B），
   这是它的已知限制；换来的是不用把包发到公开 npm。发布物的完整性由 `scripts/check-pack.mjs` 守：
   `files` 只能写目录——早期版本写的是 3 个具体 `lib/*.js`，`npm publish` 出来的包里没有
   `lib/accounts.js` 等同级模块，装上必然 `ERR_MODULE_NOT_FOUND`；这类问题本地永远复现不了，
   因为 checkout 里文件齐全。
9. **DSH profile 的 pnpm 配置是 `nodeLinker: hoisted` + `autoInstallPeers: false`**（`dsh-app-boot`
   生成 profile 时写死）。两个后果：① provider 必须在 profile 的顶层依赖里（`cordis.patch.yml` 按
   包名解析它），`dsh plugin add` 时两个包都要显式给出；② peer 依赖不会被自动安装，所以
   `@deepseek-ai/*` 一律由 profile 的 module fallback 提供，不会意外拉到 `0.1.6-alpha` / `0.1.7-alpha`。

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
pnpm run verify        # 以上全跑，并做 client bundle 结构检查 + 发布包完整性检查
pnpm run check:pack    # 只跑发布包完整性检查：npm pack 清单 vs lib/*.js 的相对导入
pnpm run publish:gh    # 维护者发版：verify + 发布到 GitHub Packages（见 §十）
```

`node scripts/check-pack.mjs` 读每个包真正的 `npm pack` 清单，断言 `lib/*.js` 里每个相对导入都能在
包里找到——`files` 一旦写成具体文件名（而不是目录），发布包就会缺同级模块，本地却完全看不出来。

`node scripts/check-bundle.mjs packages/test-account` 会直接在一个 vm 里执行
`lib/client.js`，断言它真的走 `window.__ModuleLoader__.load({ id, factory })`，并且导出
`apply` / `inject` —— 这是客户端插件最容易出错、又最不容易在文件层面看出来的地方。

### 已验证到什么程度

| 层级 | 内容 | 结论 |
| --- | --- | --- |
| 单元 | `account-store`：读写、id 校验、去重、清空可选字段、路径越界、脏 JSON | ✅ 11 项 |
| 单元 | provider 参数拼装、launch/attach 校验、系统浏览器探测与 `--executable-path` | ✅ 15 项 |
| 单元 | `AccountService`：保存/恢复、`session-not-live`、`state-missing`、删除清理记账、**两个 Session 各持一个账号互不覆盖**（§11.5） | ✅ 8 项（假 bridge + 假 Agent 注册表） |
| 单元 | 浏览器桥：direct、**缺失的落盘目录会被创建**、工作区被拒后自动降级 staged、工具缺失/失败错误码、缺浏览器的提示 | ✅ 13 项，用模拟的工作区文件栅栏 |
| 单元 | 插件接线：路由注册、三个 Agent 工具注册、`agentTools: false` 不注册、路由增删查与错误码 | ✅ 5 项（假 Cordis ctx） |
| 构建 | `lib/client.js` 真的是 `window.__ModuleLoader__.load` 懒加载包 | ✅ `scripts/check-bundle.mjs` |
| 集成 | `./install.sh <profile>` 在全新 `DSH_HOME` 上从零跑通：构建 → 初始化 profile → 装 2 个包 → 自动加入 `dsh.profile.bundles` → 能启动 | ✅ 脚本本身已实测 |
| 集成 | 0.1.5-rc.3 profile 装载两个插件，无未激活项；boot manifest 含本插件与四个 client 依赖；`/plugins/??…/client.js` 返回 200 | ✅ 独立 `DSH_HOME` |
| 集成 | `POST /api/test-account` 真实 HTTP + 鉴权：增删改查、持久化、全部错误码、`session-not-live` 守卫 | ✅ curl 走完整流程 |
| 集成 | `@playwright/mcp` 带 `--caps=storage` 时工具数为 41 且包含两个 storage 工具；不带时 24 且没有 | ✅ 直接起 MCP server 列工具 |
| 集成 | 真实 Chrome：`browser_storage_state` 把登录态写到工作区外的账号目录（含 `cookies` / `origins`），`browser_set_storage_state` 再读回；去掉 `--allow-unrestricted-file-access` 时同路径被 `File access denied … outside allowed roots` 拒绝 | ✅ 正是降级路径存在的理由 |
| 集成 | **整条链路**：真实浏览器里打开面板 → 路由 `accounts/saveState` → DSH `ctx.tools.execute('mcp__playwright-mcp__browser_storage_state')` → Playwright MCP → 真实 Chrome → 账号目录落盘；再 `accounts/use` 恢复并更新当前账号 | ✅ `pnpm run smoke:ui <url> --home <DSH_HOME>` 17/17 通过，无 page error |
| 集成 | 整套依赖锁在 0.1.5 线：`pnpm-lock.yaml` 里 `0.1.6-alpha` / `0.1.7-alpha` 出现 0 次，`cordis` 只有 4.0.2，provider 的 `node_modules` 只解析出 `0.1.5-rc.3` | ✅ `grep` + `node_modules` 实测 |
| 集成 | 上面这套在三种装法下都跑过：`install.sh` 新建的 profile、已初始化过的 profile、以及不配 `executablePath`（靠自动探测本机 Chrome） | ✅ |
| 集成 | scope 改名 `@dsh-test-account/*` → `@songxiyuan/*` 后：`install.sh` 自动迁移旧 profile 依赖，`pnpm run verify` 全绿（37 项单测 + bundle id `@songxiyuan/test-account`），面板冒烟通过 | ✅ 9/9 |
| 集成 | 发布物完整性：两个包 `npm pack` 出来的 tarball 含全部 `lib/*.js`（16 / 8 个文件），`scripts/check-pack.mjs` 在旧的逐文件名 `files` 配置下会红并逐条列出缺失的兄弟模块 | ✅ |
| 集成 | `.github/workflows/publish.yml` 在 `v0.1.0` tag 上全绿：install → verify → publish to GitHub Packages → 两个 `.tgz` 挂上 Release（run `35871964082`，10 个步骤全部 success）；两个资产可匿名下载（29.7 KB / 9.0 KB），内容与本地 pack 一致 | ✅ |
| 集成 | 「新机器」零凭据路线：全新 `DSH_HOME` + `web` 模板 profile → 从 Release URL 装两个包（exit 0）→ profile 依赖与 `dsh.profile.bundles` 正确 → 启动后 boot manifest 含 `{"id":"@songxiyuan/test-account","url":"/plugins/??@songxiyuan/test-account/client.js…"}`，该 URL 返回 200（26 KB，`id: "@songxiyuan/test-account"`） | ✅ |
| 手工 | 图形浏览器里「登录 → 保存登录态 → 换账号 → 恢复」；以及设计文档 §14 的风险项：两个 Session 同时各起一个浏览器、各自切账号互不干扰 | ⏳ 需要人手动登录；浏览器资源是 provider 的职责，不该在本插件里绕过 |

`scripts/smoke-ui.mjs` 需要一个已经跑起来的实例：

```bash
./install.sh test-account
dsh --profile test-account --port 3081   # 记下打印的带 token URL

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
dsh --profile test-account --port 3081
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

## 十、发布到 GitHub Packages（维护者）

两个包发到 GitHub Packages（scope 必须等于仓库 owner：`@songxiyuan` → `songxiyuan/test-account`）。
发布前先做一次性准备，之后每次发版都是 `pnpm run publish:gh`。

### 10.1 一次性准备（只做本地发布才需要）

> CI 发布（§10.2 上半）不需要这一步：workflow 用 runner 自带的 `GITHUB_TOKEN`。

```bash
# classic PAT（GitHub Packages 不支持 fine-grained token）：
#   发布要 write:packages（+ read:packages，仓库私有再加 repo）
npm login --scope=@songxiyuan --auth-type=legacy --registry=https://npm.pkg.github.com
#   Username: <GitHub 用户名>   Password: <classic PAT>
npm whoami --registry https://npm.pkg.github.com      # 应打印 songxiyuan
```

`package.json` 里已经写好（两个包都有）：`publishConfig.registry = https://npm.pkg.github.com`、
`publishConfig.access = public`、`repository.url = https://github.com/songxiyuan/test-account.git`
（GitHub 靠 `repository` 把包关联到仓库，关联后包继承仓库权限）。

### 10.2 每次发版

**CI 发布（推荐，不需要任何本地 token）**：`.github/workflows/publish.yml` 用 runner 自带的
`GITHUB_TOKEN`（`packages: write` + `contents: write`）跑 `install → verify → pnpm -r publish`，
并把两个 `.tgz` 挂到同名 Release 上。

```bash
git tag v0.1.0 && git push origin v0.1.0     # tag → 发布 + Release 资产
# 或者：Actions → publish → Run workflow（对当前 commit 跑一遍，不建 Release 资产只在 tag 时做）
```

**本地发布**（有 classic PAT 时）：

```bash
pnpm run verify          # typecheck + build + test + bundle 结构 + 发布包完整性（check-pack）
pnpm run publish:gh      # = verify && pnpm -r --filter './packages/*' publish

# 预发布版本（不占正式号）：版本写成 0.1.1-rc.1，装的时候指定版本
# dsh plugin --profile <p> add @songxiyuan/test-account@0.1.1-rc.1

# 只更新其中一个包：在包目录里 npm publish（prepack 会先构建）
```

排障要点：

- **`prepack` 负责构建**：`lib/` 在 `.gitignore` 里，`files` 只写 `lib` 目录；`files` 里绝对不要列具体
  文件名——最早那版列了 3 个 `lib/*.js`，发出去的包里没有兄弟模块，装上直接
  `ERR_MODULE_NOT_FOUND`。`scripts/check-pack.mjs` 现在把这件事变成红灯（`pnpm run verify` 会跑）。
- **首次发布的可见性是 private**：publish 完到 GitHub → 该仓库的 Packages 里把两个包设为 public（或保持
  private 并给机器授权），只影响别人能不能看到，不影响你自己的机器用 token 安装。
- **版本号一旦发布就永久占位**：要撤回就删包版本（Packages 页面 / REST API），然后发一个更高的版本号；
  GitHub Packages 没有 npmjs 那套 72 小时 unpublish 限制。
- **改 scope 要一起改**：包名在两处 `package.json`、`packages/test-account/cordis.patch.yml`（按包名解析
  provider）、`client/index.tsx` 的 `PANEL_ID`、以及 `scripts/build-client.mjs` 写入的 bundle id（= 包名，
  所以必须重新 `build`）、文档与 `install.sh`。
- 在 GitHub Actions 里发布可不配 PAT，用 `GITHUB_TOKEN`（`permissions: packages: write`），
  此时包会自动关联到 workflow 所在仓库。

## 参考

- 设计文档：[`doc/dsh-test-account-plugin-design.md`](doc/dsh-test-account-plugin-design.md)
- DSH 插件发布/安装：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- DSH Browser Use：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/browser-use.md>
- Playwright Browsers：<https://playwright.dev/docs/browsers>

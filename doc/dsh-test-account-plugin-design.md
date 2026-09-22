# DSH 测试账号登录态管理插件方案

> 插件暂定名：`test-account`  
> 目标：在 DSH 中提供一个轻量的测试账号列表 UI，并复用现有 Browser Use / Playwright MCP 保存、加载不同测试账号的浏览器登录态。  
> 核心原则：**不内嵌 Playwright、不保存密码、不实现自动登录、不引入数据库。**

---

## 1. 背景与需求

日常测试时需要频繁切换不同测试账号，例如：

- VIP / Free
- US / JP
- Admin / 普通用户
- 不同权限、实验组、地区账号

希望在 DSH Web 中可以直接看到测试账号列表，并完成：

1. 管理测试账号元数据；
2. 将当前浏览器已经登录好的状态保存到指定账号；
3. 一键将当前 DSH Browser 切换为另一个账号；
4. 当前 Session 能明确知道正在使用哪个测试账号；
5. 后续 Agent 可以基于指定身份继续 Browser Use、Explore、E2E、问题排查等流程。

第一阶段不解决：

- 用户名密码自动登录；
- OAuth / SSO / 验证码；
- 登录态自动续期；
- Cookie 手工编辑；
- 数据库账号中心；
- 独立 Playwright 实例。

---

## 2. 核心设计结论

插件本质上是：

> **Account Metadata Registry + Playwright storageState 管理 UI**

而不是一个完整 Auth Service。

整体链路：

```text
DSH Web
└── Test Account Panel
    ├── VIP US
    ├── Free US
    └── Admin
          │
          ▼
    test-account Host Plugin
    ├── accounts.json
    └── states/*.json
          │
          │ 调用当前 Session 的 Playwright MCP Tool
          ▼
    DSH Browser Use
          │
          ▼
    Playwright MCP
    ├── browser_storage_state
    └── browser_set_storage_state
          │
          ▼
      当前 Browser
```

### 职责边界

#### `test-account`

负责：

- 测试账号列表；
- 账号名称、标签、站点等元数据；
- storageState 文件路径；
- 保存当前浏览器登录态；
- 加载指定账号登录态；
- 记录当前 Session 对应哪个账号；
- 提供账号管理 UI。

#### DSH Browser Use / Playwright MCP

负责：

- 浏览器启动；
- 页面导航；
- click / type / snapshot；
- Cookie / localStorage 等浏览器状态读写；
- 当前 live Session 的 Browser 生命周期。

`test-account` **不再启动第二套 Playwright**。

---

## 3. 为什么使用 storageState

不要自己单独管理 Cookie。

Playwright 的 `storageState` 是标准浏览器认证状态载体，可以保存 Cookie、localStorage 等认证相关状态。

账号状态文件示例：

```text
~/.dsh/test-accounts/

├── accounts.json
└── states/
    ├── vip-us.json
    ├── free-us.json
    └── admin.json
```

每个测试账号可以抽象为：

```text
Account Metadata
        +
storageState.json
```

因此无需：

- Cookie 表；
- Session 表；
- SQLite；
- 自己解析 Set-Cookie；
- 自己维护 Cookie expiry。

---

## 4. 数据设计

### 4.1 accounts.json

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "vip-us",
      "name": "VIP 美国测试账号",
      "site": "terabox",
      "tags": ["vip", "us"],
      "stateFile": "states/vip-us.json",
      "updatedAt": "2026-09-22T18:30:00+08:00"
    },
    {
      "id": "free-us",
      "name": "Free 美国测试账号",
      "site": "terabox",
      "tags": ["free", "us"],
      "stateFile": "states/free-us.json",
      "updatedAt": "2026-09-21T11:20:00+08:00"
    }
  ]
}
```

### 4.2 Account 类型

```ts
export interface TestAccount {
  id: string
  name: string

  site?: string
  tags?: string[]

  stateFile: string
  updatedAt?: string
}
```

第一版保持字段极少。

未来如果确实需要，可以追加：

```ts
description?: string
verifyUrl?: string
usernameHint?: string
```

但不建议 MVP 就加入。

---

## 5. 当前账号状态

当前账号属于运行时信息，不需要长期持久化。

可以维护：

```ts
Map<sessionId, accountId>
```

例如：

```text
session-a → vip-us
session-b → free-us
```

用途：

- UI 显示当前账号；
- Agent/插件查询当前身份；
- 不同 DSH Session 可以使用不同账号。

浏览器真正的认证状态仍由当前 Session 的 Browser 持有。

---

## 6. UI 设计

建议挂载到 DSH Web 右侧栏。

```text
测试账号                         [+ 添加]

TeraBox
────────────────────────────────

● VIP 美国账号
  vip-us
  VIP · US

  登录态已保存
  更新：09-22 18:30

  [使用账号] [更新登录态] [···]


● Free 美国账号
  free-us
  FREE · US

  登录态已保存
  更新：09-21 11:20

  [使用账号] [更新登录态] [···]


○ Admin
  admin

  登录态未保存

  [保存当前登录态] [···]
```

### MVP 操作

只保留：

1. 添加账号；
2. 编辑账号；
3. 删除账号；
4. 保存当前登录态；
5. 更新登录态；
6. 使用账号；
7. 显示当前账号。

---

## 7. 核心操作流程

### 7.1 添加账号

用户填写：

```text
名称：VIP 美国测试账号
ID：vip-us
站点：TeraBox
标签：VIP, US
```

插件只创建 metadata。

不会要求：

```text
用户名
密码
验证码
```

状态显示：

```text
登录态：未保存
```

---

### 7.2 首次保存登录态

用户：

```text
打开目标网站
    ↓
手动登录测试账号
    ↓
确认当前 Browser 已登录
    ↓
点击「保存当前登录态」
```

插件调用当前 Session Playwright MCP：

```text
browser_storage_state
```

目标：

```text
~/.dsh/test-accounts/states/vip-us.json
```

保存完成后：

```text
vip-us
登录态：已保存
```

---

### 7.3 使用指定账号

用户点击：

```text
[使用账号]
```

插件：

```text
读取 account
    ↓
获得 states/vip-us.json
    ↓
调用 browser_set_storage_state
    ↓
记录 sessionId → vip-us
```

当前 Session 后续的：

```text
browser_navigate
browser_click
browser_snapshot
...
```

继续使用同一个 Browser。

---

### 7.4 更新登录态

如果发现登录状态已经过期：

```text
重新打开登录页
    ↓
用户手动登录
    ↓
点击「更新登录态」
    ↓
browser_storage_state
    ↓
覆盖原 state
```

MVP 不自动判断账号是否过期。

---

## 8. DSH 接入方式

### 8.1 不直接调用 `ctx.browserUse`

DSH 的 `ctx.browserUse` 本质是 Browser Provider Registry。

它负责 Provider 注册与生命周期，不提供统一的：

```text
click()
navigate()
setStorageState()
```

API。

因此 `test-account` 不应该写：

```ts
ctx.browserUse.setStorageState(...)
```

---

### 8.2 复用当前 Session 的 MCP Tool

Playwright MCP Tool 最终进入 DSH Tool Runtime。

因此目标调用链：

```text
Vue
 │
 │ 使用账号
 ▼
Host Remote API
 │
 │ sessionId
 ▼
找到对应 Agent / Session
 │
 ▼
通过当前 Agent scope 执行 Tool
 │
 ▼
mcp__playwright-mcp__browser_set_storage_state
 │
 ▼
当前 Session Browser
```

同理：

```text
保存登录态
    ↓
mcp__playwright-mcp__browser_storage_state
```

具体 Tool Runtime API 以当前 tera-dsh / DSH 版本实际接口为准，不要在业务层硬编码一套 Playwright Client。

---

## 9. Playwright MCP Storage Capability

这是实现前必须确认的一点。

截至 2026-09-22，DSH master 的官方：

```text
@deepseek-ai/dsh-experimental-browser-use-playwright-mcp
```

启动参数核心是：

```text
--browser chromium
--isolated
```

当前 provider 源码没有开放额外 Playwright MCP capability 参数。

而 storage tools 在 Playwright MCP 中需要对应 storage capability。

因此需要给 DSH Playwright provider 增加很小的配置支持，例如：

```ts
interface Config {
  ...
  capabilities?: string[]
}
```

配置：

```yaml
config:
  mode: launch
  headless: false
  capabilities:
    - storage
```

启动 MCP 时追加：

```text
--caps=storage
```

### 推荐处理方式

不要在 `test-account` 中 fork Playwright。

应当：

```text
test-account
      │
      └── 依赖 DSH Playwright Provider

DSH Playwright Provider
      │
      └── 增加 capabilities 配置
```

这是 Provider 层能力，不属于 Account 插件职责。

---

## 10. 插件代码结构

建议：

```text
platform/plugins/test-account/

├── src/
│   ├── index.ts
│   ├── account-store.ts
│   ├── remote.ts
│   └── types.ts
│
├── client/
│   ├── index.ts
│   ├── AccountPanel.vue
│   └── AccountDialog.vue
│
├── cordis.patch.yml
├── package.json
└── README.md
```

### account-store.ts

负责：

```text
loadAccounts
saveAccounts
createAccount
updateAccount
deleteAccount
resolveStatePath
```

不要放 Browser 逻辑。

### remote.ts

暴露 Host → Browser UI API。

建议：

```ts
listAccounts()
createAccount(input)
updateAccount(id, input)
deleteAccount(id)

saveCurrentState(sessionId, accountId)
useAccount(sessionId, accountId)

getCurrentAccount(sessionId)
```

### AccountPanel.vue

只负责：

- 展示账号；
- 当前账号标识；
- 调用 Remote API；
- loading / error 状态。

---

## 11. MVP 验收标准

### 11.1 账号管理

可以：

- 新增账号；
- 编辑账号；
- 删除账号；
- 页面刷新后账号仍存在。

### 11.2 保存登录态

前提：

```text
当前 DSH Browser 已人工登录账号 A
```

点击：

```text
保存当前登录态
```

结果：

```text
states/account-a.json
```

存在，并记录更新时间。

### 11.3 恢复登录态

新 Session 或 Browser 中：

```text
选择账号 A
    ↓
使用账号
    ↓
访问目标业务页面
```

无需重新输入账号密码，可以恢复登录状态。

### 11.4 切换账号

已有：

```text
Account A
Account B
```

执行：

```text
使用 A
→ 页面身份为 A

使用 B
→ 页面身份为 B
```

两个 state 相互独立。

### 11.5 Session 隔离

```text
Session A → VIP
Session B → Free
```

UI 中可以分别显示当前账号，不相互覆盖。

---

# 12. 安装与依赖分发设计

## 12.1 一个重要结论

`test-account` **不应该直接依赖 Playwright SDK**。

真正依赖关系是：

```text
test-account
      │
      │ 运行时依赖能力
      ▼
DSH Browser Use
      │
      ▼
DSH Playwright MCP Provider
      │
      ▼
@playwright/mcp
```

截至 2026-09-22，DSH master 的：

```text
@deepseek-ai/dsh-experimental-browser-use-playwright-mcp
```

自身已经声明：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-experimental-browser-use-runtime": "...",
    "@playwright/mcp": "0.0.80"
  }
}
```

因此只要正确安装官方 Playwright Provider：

```text
@playwright/mcp
```

会由 pnpm/npm 自动安装。

`test-account` 不需要再额外：

```bash
pnpm add playwright
```

---

## 12.2 推荐：一个命令批量安装

对于当前内部使用场景，最稳妥的方法不是搞复杂 postinstall，而是提供一个固定安装命令：

```bash
dsh plugin --profile web add \
  @your-org/dsh-test-account \
  @deepseek-ai/dsh-browser-use \
  @deepseek-ai/dsh-experimental-browser-use-playwright-mcp
```

DSH 的 `dsh plugin` 本质会在对应 profile 目录中调用 pnpm，因此可以一次安装多个 npm package。

优点：

- 简单；
- 显式；
- 出问题容易排查；
- 所有依赖都成为 profile 的直接依赖；
- 不依赖 pnpm hoist 行为；
- 同事复制一条命令即可完成安装。

建议把这个命令放到 README 第一屏。

---

## 12.3 更方便：提供 install.sh

内部团队可以直接提供：

```bash
./install.sh
```

脚本内容类似：

```bash
#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-web}"

dsh plugin --profile "$PROFILE" add \
  @your-org/dsh-test-account \
  @deepseek-ai/dsh-browser-use \
  @deepseek-ai/dsh-experimental-browser-use-playwright-mcp

echo "test-account installed into profile: $PROFILE"
```

同事使用：

```bash
./install.sh web
```

这已经足够完成“批量安装”。

Windows 团队如果需要，再补：

```text
install.ps1
```

---

## 12.4 可以做 bundle，但不要滥用 postinstall

DSH 支持 bundle：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

你的 `test-account` bundle 可以通过 `cordis.patch.yml` 挂载：

```yaml
- insert:
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'

    - id: browser-use-playwright
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
      config:
        mode: launch
        headless: false

    - id: test-account
      name: '@your-org/dsh-test-account'
```

但建议依赖包仍然通过明确的 profile install 安装。

原因：

- pnpm 的依赖隔离比 npm 严格；
- DSH provider 与 DSH core 之间有较多 peer dependency；
- Browser Use 当前仍处于 experimental；
- 显式 top-level 安装更方便保证版本一致。

---

## 12.5 不推荐 postinstall 自动执行安装

不要设计：

```json
{
  "scripts": {
    "postinstall": "dsh plugin add ..."
  }
}
```

原因：

1. npm/pnpm install 生命周期不适合修改用户 DSH Profile；
2. pnpm 新版本对 install scripts 权限更严格；
3. 插件安装时偷偷修改其它 profile 状态很难排查；
4. Git 安装时 DSH 本身对 build scripts 还有 allowBuilds 安全限制；
5. 安装失败后容易留下半成品。

推荐：

```text
安装脚本 / setup CLI
```

显式完成。

---

## 12.6 长期最好的安装体验

如果这个插件以后要推广给很多同事，可以再做：

```bash
npx @your-org/dsh-test-account setup
```

交互：

```text
Detected DSH profile: web

Will install:

✓ dsh-test-account
✓ dsh-browser-use
✓ dsh-playwright-mcp

Install? Y

✓ packages installed
✓ plugin config applied
✓ storage capability enabled
✓ ready
```

这只是安装器，不是插件 Runtime 的一部分。

当前 MVP 没必要先做。

---

## 12.7 浏览器本体怎么办

需要区分：

```text
npm package
```

和：

```text
Chromium / Chrome browser executable
```

Node package 可以由 pnpm 一次装完。

Browser 有两种策略：

### 方案 A：使用 Playwright 自带 Chromium

如果目标机器没有相应 Browser：

```bash
npx playwright install chromium
```

Linux CI 如果还需要系统依赖：

```bash
npx playwright install --with-deps chromium
```

### 方案 B：复用本机 Chrome

DSH Playwright Provider 已支持：

```yaml
config:
  mode: launch
  executablePath: /path/to/chrome
```

如果团队机器本来就有 Chrome，这通常可以避免再额外下载一份 Chromium。

建议内部 Mac/Windows 开发机优先考虑复用现有 Chrome；CI 环境再使用 Playwright Chromium。

---

## 13. 版本策略

Browser Use 目前仍是 experimental。

因此不要使用：

```text
latest
```

随机漂移。

建议统一锁版本，例如：

```json
{
  "peerDependencies": {
    "@deepseek-ai/dsh": "0.1.7-alpha.1"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-browser-use": "0.1.7-alpha.1",
    "@deepseek-ai/dsh-experimental-browser-use-playwright-mcp": "0.1.7-alpha.1"
  }
}
```

实际内部版本应跟 tera-dsh 当前基线统一。

特别注意：

- DSH master 当前 provider 版本已经进入 `0.1.7-alpha.1`；
- provider 当前固定依赖 `@playwright/mcp@0.0.80`；
- 即使 npm 上 Playwright MCP 有更新版本，也不要自行强制升级 provider 的 transitive dependency，除非已经验证兼容性。

---

## 14. 当前 DSH Browser Use 风险

2026 年 9 月近期 DSH experimental Browser Use 有用户报告过：

- 多 Session 下 provider/tool scope 冲突；
- Browser Provider 安装在 profile 后出现重复 DSH runtime package；
- Session create/resume 失败等问题。

因此实现前建议：

1. tera-dsh 固定一套已经验证的 DSH 版本；
2. Playwright provider 与 DSH core 使用同一版本线；
3. 先验证双 Session：
   - Session A 启动 Browser；
   - Session B 启动 Browser；
   - 两边 Browser Tool 都正常；
4. 再开发 test-account 上层逻辑。

如果底层 Browser Use 多 Session 有问题，不要在 `test-account` 内绕过；优先解决 Provider / Scope 层。

---

# 15. 推荐开发顺序

## Phase 1：确认底层能力

完成：

```text
DSH
 ↓
Playwright MCP
 ↓
browser_storage_state
browser_set_storage_state
```

手工验证两个 JSON 文件可以切换身份。

这是整个项目的前置验收。

---

## Phase 2：Account Store

实现：

```text
accounts.json
CRUD
state path
```

不做 UI。

通过单元测试验证。

---

## Phase 3：Host Remote API

实现：

```text
listAccounts
createAccount
updateAccount
deleteAccount

saveCurrentState
useAccount

getCurrentAccount
```

---

## Phase 4：Vue UI

完成右侧：

```text
Account Panel
```

支持：

```text
添加
删除
保存
使用
当前账号
```

---

## Phase 5：Agent 集成

后续再考虑给 Agent 暴露：

```text
account_list
account_use
account_current
```

这不是 MVP 必需项。

用户手工从 UI 切换账号已经能完成核心需求。

---

# 16. 最终架构

```text
┌─────────────────────────── DSH Web ───────────────────────────┐
│                                                              │
│ Chat                                      Test Account Panel │
│                                           │                  │
│                                           ├ VIP US           │
│                                           ├ Free US          │
│                                           └ Admin            │
└───────────────────────────────────────────┬──────────────────┘
                                            │
                                            ▼
                                 ┌─────────────────────┐
                                 │ test-account plugin │
                                 │                     │
                                 │ accounts.json       │
                                 │ states/*.json       │
                                 │ session→account     │
                                 └──────────┬──────────┘
                                            │
                                    Tool Runtime
                                            │
                                            ▼
                              ┌─────────────────────────┐
                              │ DSH Browser Use         │
                              │ Playwright MCP Provider │
                              └────────────┬────────────┘
                                           │
                       ┌───────────────────┴───────────────────┐
                       │                                       │
                       ▼                                       ▼
            browser_storage_state                   browser_set_storage_state
                       │                                       │
                       └───────────────────┬───────────────────┘
                                           ▼
                                      Browser
```

---

# 17. 一句话原则

> **test-account 只管理“测试身份”和“storageState”，浏览器生命周期与网页操作全部复用 DSH Browser Use。**

安装层面：

> **内部第一版直接用一条 `dsh plugin add` 命令批量安装三个包；不要为了“一键安装”在插件里再嵌 Playwright 或写复杂 postinstall。**

---

## 参考

- DeepSeek Harness — Package and install a plugin  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md

- DeepSeek Harness — Browser Use  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/browser-use.md

- DSH Playwright MCP Provider source  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/browser-use-playwright-mcp/src/index.ts

- DSH Playwright MCP Provider package.json  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/browser-use-playwright-mcp/package.json

- Playwright Browsers  
  https://playwright.dev/docs/browsers

#!/usr/bin/env node
/**
 * Browser smoke test for the client half.
 *
 * Boots a DSH instance with the test-account profile, opens the authenticated
 * Web URL in a real Chrome, creates a Session, and asserts that the panel
 * registers, reads the Host's account list, and round-trips one write through
 * `POST /api/test-account`.
 *
 * The DSH shell only mounts the conversation header once a Session has a turn,
 * and running a turn needs a model credential, so the script sends one message
 * and ignores the resulting provider failure. Everything else it asserts is
 * model-independent.
 *
 * Usage:
 *   node scripts/smoke-ui.mjs "http://127.0.0.1:3081/?token=..."
 *
 * The URL is the one `dsh --profile <name> web --port <port>` prints. The
 * script needs a Google Chrome install and the `playwright-core` that ships
 * inside this repository's `@playwright/mcp` dependency.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node scripts/smoke-ui.mjs "<authenticated DSH web URL>"')
  process.exit(2)
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'browser-use-playwright-mcp-storage')
const require = createRequire(join(packageDir, 'package.json'))
const mcpRequire = createRequire(require.resolve('@playwright/mcp/package.json'))
const { chromium } = mcpRequire('playwright-core')

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const checks = []

/**
 * Record and report one assertion.
 * @param label - what was asserted.
 * @param ok - the outcome.
 */
function check(label, ok) {
  checks.push([label, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

/**
 * Clear whatever first-run overlay is in the way.
 *
 * A fresh DSH home shows a model-API-key dialog ("稍后配置" defers it) and may
 * follow it with a welcome notice; that dialog can also appear a few seconds
 * after load, so this polls rather than checking once.
 * @param page - the page under test.
 */
async function dismissOverlays(page) {
  const labels = ['稍后配置', '继续', '知道了', '开始使用', '跳过', '关闭']
  let cleanRounds = 0
  for (let round = 0; round < 14; round += 1) {
    let clicked = false
    for (const label of labels) {
      const button = page.getByRole('button', { name: label })
      if ((await button.count()) > 0 && (await button.first().isVisible())) {
        await button.first().click({ force: true }).catch(() => {})
        clicked = true
        break
      }
    }
    const masked = (await page.locator('div[aria-hidden="true"][class*="_mask_"]').count()) > 0
    if (!clicked && !masked) {
      cleanRounds += 1
      // The dialog can render several seconds after load, so stay alert for a while.
      if (cleanRounds >= 3) return
    } else {
      cleanRounds = 0
      if (!clicked && masked) await page.keyboard.press('Escape').catch(() => {})
    }
    await page.waitForTimeout(1500)
  }
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)
  await dismissOverlays(page)

  await page.getByText('新会话', { exact: true }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(4000)
  const composer = page.locator('textarea, [contenteditable="true"]').first()
  await composer.click()
  await page.keyboard.type('smoke test')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(9000)

  const shortcut = page.getByText('测试账号', { exact: true })
  check('conversation header renders the 测试账号 shortcut', (await shortcut.count()) > 0)
  await shortcut.first().click()
  await page.waitForTimeout(3500)

  const panel = page.locator('[data-test-account-panel]')
  check('panel body mounts in the right Sidebar', (await panel.count()) > 0)
  const text = await panel.innerText()
  check('panel reports the current account for this Session', text.includes('当前账号：'))
  check('panel reports the account directory', text.includes('账号目录：'))
  check('panel renders either the empty hint or an account card', (await panel.locator('article').count()) > 0 || text.includes('还没有测试账号'))

  const id = `smoke-${Date.now().toString(36)}`
  await page.getByRole('button', { name: '+ 添加' }).first().click()
  await page.waitForTimeout(600)
  await page.getByPlaceholder('VIP 美国测试账号').fill('冒烟账号')
  await page.getByPlaceholder('vip-us').fill(id)
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.waitForTimeout(3000)
  const card = panel.locator('article').filter({ hasText: id })
  check('a write through the panel reaches the Host store', (await card.count()) === 1)
  check('a state-less account cannot be used yet', await card.getByRole('button', { name: '使用账号' }).isDisabled())

  await card.getByRole('button', { name: '删除' }).click()
  await page.waitForTimeout(300)
  await card.getByRole('button', { name: '确认删除' }).click()
  await page.waitForTimeout(2500)
  check('delete through the panel removes the account', !(await panel.innerText()).includes(id))

  check('no page errors', errors.length === 0)
} finally {
  await browser.close()
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (errors.length > 0) console.log('page errors:', errors.slice(0, 5))
process.exit(failed.length === 0 ? 0 : 1)

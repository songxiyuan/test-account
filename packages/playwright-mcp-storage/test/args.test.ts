import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildArgs,
  detectExecutablePath,
  playwrightCliPath,
  resolveConfig,
  resolveExecutablePath,
  SYSTEM_BROWSER_CANDIDATES,
  validate,
  type ResolvedConfig,
} from '../src/args.ts'

const CLI = '/opt/playwright-mcp/cli.js'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Resolve a configuration with browser auto-detection off, so an argument-list
 * assertion does not depend on which browsers the test machine happens to have.
 * @param input - overrides on top of the detection-off baseline.
 * @returns the resolved configuration.
 */
function resolved(input: Parameters<typeof resolveConfig>[0] = {}): ResolvedConfig {
  return resolveConfig({ autoExecutablePath: false, ...input })
}

test('launch defaults enable the storage capability', () => {
  const args = buildArgs(resolved(), CLI)
  assert.deepEqual(args, [CLI, '--browser', 'chromium', '--isolated', '--headless', '--allow-unrestricted-file-access', '--caps=storage'])
})

test('a visible browser keeps --headless off the command line', () => {
  const args = buildArgs(resolved({ headless: false }), CLI)
  assert.ok(!args.includes('--headless'))
  assert.ok(args.includes('--isolated'))
})

test('unrestricted file access can be withheld', () => {
  const args = buildArgs(resolved({ allowUnrestrictedFileAccess: false }), CLI)
  assert.ok(!args.includes('--allow-unrestricted-file-access'))
})

test('capabilities are comma-joined and may be extended', () => {
  const args = buildArgs(resolved({ caps: ['storage', 'pdf'] }), CLI)
  assert.ok(args.includes('--caps=storage,pdf'))
})

test('an empty capability list omits the switch entirely', () => {
  const args = buildArgs(resolved({ caps: [] }), CLI)
  assert.ok(!args.some((argument) => argument.startsWith('--caps')))
})

test('attach mode forwards the endpoint and drops launch-only switches', () => {
  const args = buildArgs(resolved({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }), CLI)
  assert.deepEqual(args, [CLI, '--browser', 'chromium', '--cdp-endpoint', 'http://127.0.0.1:9222', '--caps=storage'])
})

test('an executable path is forwarded only in launch mode', () => {
  const args = buildArgs(resolved({ executablePath: CHROME }), CLI)
  const at = args.indexOf('--executable-path')
  assert.ok(at > 0)
  assert.equal(args[at + 1], CHROME)
  const attached = buildArgs(resolved({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }), CLI, '/ignored')
  assert.ok(!attached.includes('--executable-path'))
})

test('extra raw arguments are appended last', () => {
  const args = buildArgs(resolved({ extraArgs: ['--save-session'] }), CLI)
  assert.equal(args.at(-1), '--save-session')
  assert.equal(args.at(-2), '--caps=storage')
})

test('a supplied executable reaches the command line', () => {
  const args = buildArgs(resolved(), CLI, '/usr/bin/google-chrome')
  const at = args.indexOf('--executable-path')
  assert.ok(at > 0)
  assert.equal(args[at + 1], '/usr/bin/google-chrome')
})

test('system browser detection walks the platform candidates in order', () => {
  const darwin = SYSTEM_BROWSER_CANDIDATES.darwin ?? []
  assert.ok(darwin.length >= 2)
  assert.equal(detectExecutablePath('darwin', (path) => path === darwin[0]), darwin[0])
  assert.equal(detectExecutablePath('darwin', (path) => path === darwin[1]), darwin[1])
  assert.equal(detectExecutablePath('darwin', () => false), undefined)
  assert.equal(detectExecutablePath('plan9', () => true), undefined)
  assert.ok((SYSTEM_BROWSER_CANDIDATES.linux ?? []).length > 0)
  assert.ok((SYSTEM_BROWSER_CANDIDATES.win32 ?? []).length > 0)
})

test('auto-detection is on by default and yields to an explicit path', () => {
  assert.equal(resolveConfig({}).autoExecutablePath, true)
  assert.equal(resolveExecutablePath(resolved({ executablePath: '/opt/chrome' }), '/detected'), '/opt/chrome')
  assert.equal(resolveExecutablePath(resolved(), '/detected'), '/detected')
  assert.equal(resolveExecutablePath(resolved({ autoExecutablePath: false }), undefined), undefined)
})

test('attach without an endpoint is rejected', () => {
  assert.throws(() => validate(resolved({ mode: 'attach' })), /requires a debugging endpoint/u)
})

test('a malformed endpoint is rejected', () => {
  assert.throws(() => validate(resolved({ mode: 'attach', endpoint: 'not-a-url' })), /valid HTTP\(S\) or WS\(S\) URL/u)
})

test('launch mode rejects an endpoint', () => {
  assert.throws(() => validate(resolved({ mode: 'launch', endpoint: 'http://127.0.0.1:9222' })), /requires attach mode/u)
})

test('attach mode rejects an executable path', () => {
  assert.throws(
    () => validate(resolved({ mode: 'attach', endpoint: 'http://127.0.0.1:9222', executablePath: '/usr/bin/chromium' })),
    /executablePath requires launch mode/u,
  )
})

test('the pinned CLI resolves to an existing file next to its manifest', () => {
  const cli = playwrightCliPath()
  assert.ok(cli.endsWith(join('@playwright', 'mcp', 'cli.js')), cli)
  assert.ok(existsSync(cli), cli)
})

test('a manifest whose cli.js is missing fails with reinstall guidance', () => {
  // Emulates the leftover this guard exists for: a stale @playwright/mcp copy
  // still resolvable from the profile, but pruned down to its manifest.
  const stale = join(tmpdir(), 'playwright-mcp-storage-stale', 'package.json')
  assert.throws(
    () => playwrightCliPath(() => stale),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /@playwright\/mcp CLI is missing/u)
      assert.match(error.message, /cli\.js/u)
      assert.match(error.message, /pnpm install/u)
      assert.match(error.message, /dsh plugin --profile/u)
      return true
    },
  )
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArgs, resolveConfig, validate, type ResolvedConfig } from '../src/args.ts'

const CLI = '/opt/playwright-mcp/cli.js'

function resolved(input: Parameters<typeof resolveConfig>[0] = {}): ResolvedConfig {
  return resolveConfig(input)
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
  const args = buildArgs(resolved({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }), CLI)
  assert.deepEqual(args.slice(-4), ['--executable-path', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--allow-unrestricted-file-access', '--caps=storage'])
})

test('extra raw arguments are appended last', () => {
  const args = buildArgs(resolved({ extraArgs: ['--save-session'] }), CLI)
  assert.equal(args.at(-1), '--save-session')
  assert.equal(args.at(-2), '--caps=storage')
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

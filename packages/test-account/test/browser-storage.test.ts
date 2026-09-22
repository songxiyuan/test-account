import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BrowserStorageBridge,
  BrowserStorageError,
  browserInstallHint,
  isFileAccessDenied,
  storageToolName,
  type StorageBridgeHost,
} from '../src/browser-storage.ts'

/** One recorded tool call. */
interface RecordedCall {
  name: string
  filename: string
}

/**
 * A tool runtime that mimics the upstream workspace file fence.
 * @param allowedRoots - roots outside which the fence rejects the call.
 * @param calls - sink for every call the bridge makes.
 * @returns the fake host.
 */
function fakeHost(allowedRoots: readonly string[], calls: RecordedCall[]): StorageBridgeHost {
  const host = {
    tools: {
      get: (name: string): unknown =>
        name === 'mcp__playwright-mcp__browser_storage_state' || name === 'mcp__playwright-mcp__browser_set_storage_state'
          ? { name }
          : undefined,
      execute: async (input: { name: string; arguments: unknown }): Promise<unknown> => {
        const filename = (input.arguments as { filename: string }).filename
        calls.push({ name: input.name, filename })
        if (!allowedRoots.some((root) => filename.startsWith(root))) {
          return {
            isError: true,
            content: [{ type: 'text', text: `File access denied: ${filename} is outside allowed roots.` }],
            error: { name: 'ToolError', code: 'TOOL_ERROR' },
          }
        }
        if (input.name.endsWith('browser_storage_state')) {
          await writeFile(filename, '{"cookies":[{"name":"sid"}]}', 'utf8')
        } else {
          await readFile(filename, 'utf8')
        }
        return { isError: false, value: null, content: [] }
      },
    },
  }
  return host as unknown as StorageBridgeHost
}

/** A host whose storage tools are absent from the scope. */
const emptyHost = {
  tools: { get: (): undefined => undefined, execute: async (): Promise<never> => { throw new Error('unreachable') } },
} as unknown as StorageBridgeHost

/**
 * Run one case against a fresh workspace and store directory.
 * @param run - case body.
 */
async function withDirs(run: (workspace: string, store: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-test-account-bridge-'))
  const workspace = join(base, 'workspace')
  const store = join(base, 'store')
  try {
    await (await import('node:fs/promises')).mkdir(workspace, { recursive: true })
    await (await import('node:fs/promises')).mkdir(store, { recursive: true })
    await run(workspace, store)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/**
 * Build a fake live Agent owning one workspace.
 * @param workspace - Session working directory.
 * @returns the fake Agent.
 */
function fakeAgent(workspace: string): Agent {
  return { session: { header: { cwd: workspace } } } as unknown as Agent
}

/**
 * Build a file access bound to one path.
 * @param path - store-side absolute path.
 * @returns read/write closures over that path.
 */
function access(path: string) {
  return {
    path,
    read: () => readFile(path, 'utf8'),
    write: (contents: string) => writeFile(path, contents, 'utf8'),
  }
}

test('tool names use the provider namespace', () => {
  assert.equal(storageToolName('playwright-mcp', 'browser_storage_state'), 'mcp__playwright-mcp__browser_storage_state')
})

test('the file fence is recognized from the upstream message', () => {
  assert.equal(isFileAccessDenied(new Error('File access denied: /x is outside allowed roots. Allowed roots: /y')), true)
  assert.equal(isFileAccessDenied(new Error('something else')), false)
})

test('a missing browser produces actionable guidance', () => {
  const upstream =
    'Error: Browser "chrome-for-testing" is not installed; expected executable at /x. Run `npx @playwright/mcp install-browser chrome-for-testing` to install'
  const hint = browserInstallHint(upstream)
  assert.match(hint, /install-browser chrome-for-testing/u)
  assert.match(hint, /executablePath/u)
  assert.equal(browserInstallHint('something unrelated'), '')
})

test('a missing browser failure reaches the caller with the hint attached', async () => {
  await withDirs(async (workspace, store) => {
    const host = {
      tools: {
        get: (): unknown => ({ name: 'x' }),
        execute: async (): Promise<unknown> => ({
          isError: true,
          content: [{ type: 'text', text: 'Browser "chrome-for-testing" is not installed' }],
          error: { name: 'ToolError', code: 'TOOL_ERROR' },
        }),
      },
    } as unknown as StorageBridgeHost
    const bridge = new BrowserStorageBridge(host, {
      provider: 'playwright-mcp',
      stateAccess: 'direct',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    await assert.rejects(
      bridge.save(fakeAgent(workspace), access(join(store, 'x.json')), new AbortController().signal),
      /install-browser chrome-for-testing/u,
    )
  })
})

test('direct mode saves straight into the account store', async () => {
  await withDirs(async (workspace, store) => {
    const calls: RecordedCall[] = []
    const target = join(store, 'vip-us.json')
    const bridge = new BrowserStorageBridge(fakeHost([workspace, store], calls), {
      provider: 'playwright-mcp',
      stateAccess: 'direct',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    await bridge.save(fakeAgent(workspace), access(target), new AbortController().signal)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.filename, target)
    assert.match(await readFile(target, 'utf8'), /sid/u)
    assert.deepEqual(await readdir(workspace), [])
  })
})

test('a fenced direct save falls back to a staged workspace copy', async () => {
  await withDirs(async (workspace, store) => {
    const calls: RecordedCall[] = []
    const target = join(store, 'vip-us.json')
    const bridge = new BrowserStorageBridge(fakeHost([workspace], calls), {
      provider: 'playwright-mcp',
      stateAccess: 'direct',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    await bridge.save(fakeAgent(workspace), access(target), new AbortController().signal)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.filename, target)
    assert.match(calls[1]?.filename ?? '', /workspace/u)
    assert.match(await readFile(target, 'utf8'), /sid/u)
    assert.deepEqual(await readdir(workspace), [], 'the staged copy must be cleaned up')
  })
})

test('staged mode restores through a temporary workspace file', async () => {
  await withDirs(async (workspace, store) => {
    const calls: RecordedCall[] = []
    const target = join(store, 'vip-us.json')
    await writeFile(target, '{"cookies":[]}', 'utf8')
    const bridge = new BrowserStorageBridge(fakeHost([workspace], calls), {
      provider: 'playwright-mcp',
      stateAccess: 'staged',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    await bridge.restore(fakeAgent(workspace), access(target), new AbortController().signal)
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.filename ?? '', /workspace/u)
    assert.deepEqual(await readdir(workspace), [])
  })
})

test('direct mode restores straight from the account store', async () => {
  await withDirs(async (workspace, store) => {
    const calls: RecordedCall[] = []
    const target = join(store, 'vip-us.json')
    await writeFile(target, '{"cookies":[]}', 'utf8')
    const bridge = new BrowserStorageBridge(fakeHost([workspace, store], calls), {
      provider: 'playwright-mcp',
      stateAccess: 'direct',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    await bridge.restore(fakeAgent(workspace), access(target), new AbortController().signal)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.filename, target)
  })
})

test('a missing storage tool is an actionable setup error', async () => {
  await withDirs(async (workspace, store) => {
    const bridge = new BrowserStorageBridge(emptyHost, {
      provider: 'playwright-mcp',
      stateAccess: 'direct',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    assert.deepEqual(bridge.availability(fakeAgent(workspace)), { save: false, restore: false })
    await assert.rejects(bridge.save(fakeAgent(workspace), access(join(store, 'x.json')), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof BrowserStorageError)
      assert.equal(error.code, 'browser-tool-unavailable')
      assert.match(error.message, /browser-use-playwright-mcp-storage/u)
      return true
    })
  })
})

test('the bridge reports tool visibility per Session', async () => {
  await withDirs(async (workspace, store) => {
    const bridge = new BrowserStorageBridge(fakeHost([workspace, store], []), {
      provider: 'playwright-mcp',
      stateAccess: 'direct',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    assert.deepEqual(bridge.availability(fakeAgent(workspace)), { save: true, restore: true })
    assert.equal(bridge.saveToolName, 'mcp__playwright-mcp__browser_storage_state')
    assert.equal(bridge.restoreToolName, 'mcp__playwright-mcp__browser_set_storage_state')
  })
})

test('staged mode without a workspace is rejected before any call', async () => {
  await withDirs(async (_workspace, store) => {
    const calls: RecordedCall[] = []
    const bridge = new BrowserStorageBridge(fakeHost([store], calls), {
      provider: 'playwright-mcp',
      stateAccess: 'staged',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    const agent = { session: { header: {} } } as unknown as Agent
    await assert.rejects(bridge.save(agent, access(join(store, 'x.json')), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof BrowserStorageError)
      assert.equal(error.code, 'no-workspace')
      return true
    })
    assert.deepEqual(calls, [])
  })
})

test('a tool failure surfaces as browser-tool-failed', async () => {
  await withDirs(async (workspace, store) => {
    const host = {
      tools: {
        get: (): unknown => ({ name: 'x' }),
        execute: async (): Promise<unknown> => ({
          isError: true,
          content: [{ type: 'text', text: 'browser not started' }],
          error: { name: 'ToolError', code: 'TOOL_ERROR' },
        }),
      },
    } as unknown as StorageBridgeHost
    const bridge = new BrowserStorageBridge(host, {
      provider: 'playwright-mcp',
      stateAccess: 'direct',
      stagePrefix: '.stage-',
      toolTimeoutMs: 5_000,
    })
    await assert.rejects(bridge.save(fakeAgent(workspace), access(join(dirname(store), 'x.json')), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof BrowserStorageError)
      assert.equal(error.code, 'browser-tool-failed')
      assert.match(error.message, /browser not started/u)
      return true
    })
  })
})

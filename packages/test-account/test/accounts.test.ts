import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AccountStore } from '../src/account-store.ts'
import { AccountService, type AgentLookup, type StorageBridge } from '../src/accounts.ts'
import { BrowserStorageError } from '../src/browser-storage.ts'
import type { StorageFileAccess } from '../src/browser-storage.ts'

/** Records what the service asked the browser half to do. */
interface BridgeRecorder {
  saved: { sessionId: string; contents: string }[]
  restored: { sessionId: string; contents: string }[]
}

/**
 * A browser bridge that persists to the account store instead of a browser.
 * @param recorder - sink for every operation.
 * @returns a bridge satisfying {@link StorageBridge}.
 */
function fakeBridge(recorder: BridgeRecorder): StorageBridge {
  return {
    async save(agent: Agent, access: StorageFileAccess): Promise<void> {
      const contents = JSON.stringify({ cookies: [{ name: 'sid', value: agent.id }] })
      recorder.saved.push({ sessionId: agent.id, contents })
      await access.write(contents)
    },
    async restore(agent: Agent, access: StorageFileAccess): Promise<void> {
      recorder.restored.push({ sessionId: agent.id, contents: await access.read() })
    },
    availability: () => ({ save: true, restore: true }),
  }
}

/**
 * A live-Session registry holding exactly the given ids.
 * @param sessionIds - Sessions that exist.
 * @returns the lookup.
 */
function fakeAgents(sessionIds: readonly string[]): AgentLookup {
  const agents = new Map(sessionIds.map((id) => [id, { id } as unknown as Agent]))
  return { get: (sessionId: string) => agents.get(sessionId) }
}

/**
 * Run one case against a fresh store and service.
 * @param run - case body.
 */
async function withService(
  options: { sessions?: readonly string[] } = {},
  run?: (context: {
    service: AccountService
    store: AccountStore
    recorder: BridgeRecorder
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-account-service-'))
  const store = new AccountStore(root)
  const recorder: BridgeRecorder = { saved: [], restored: [] }
  const service = new AccountService({ store, bridge: fakeBridge(recorder), agents: fakeAgents(options.sessions ?? []) })
  try {
    await run?.({ service, store, recorder })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('an empty store lists no accounts', async () => {
  await withService({}, async ({ service }) => {
    const snapshot = await service.list()
    assert.deepEqual(snapshot.accounts, [])
    assert.equal(snapshot.currentAccountId, undefined)
    assert.ok(snapshot.root.length > 0)
  })
})

test('saveState captures the Session browser and records the time', async () => {
  await withService({ sessions: ['session-a'] }, async ({ service, recorder }) => {
    await service.create({ id: 'VIP-US', name: '  VIP 美国  ', site: 'TeraBox', tags: ['vip'] })
    const before = await service.list('session-a')
    assert.equal((before.accounts[0] as { hasState: boolean }).hasState, false)

    const view = await service.saveState('session-a', 'vip-us', new AbortController().signal)
    assert.equal(view.hasState, true)
    assert.ok((view.stateBytes ?? 0) > 0)
    assert.ok(typeof view.stateUpdatedAt === 'string')
    assert.equal(recorder.saved.length, 1)
    assert.equal(recorder.saved[0]?.sessionId, 'session-a')
    assert.match(recorder.saved[0]?.contents ?? '', /"sid"/u)
  })
})

test('saveAccount registers an account, captures the browser, and marks it current', async () => {
  await withService({ sessions: ['session-a'] }, async ({ service, recorder }) => {
    const view = await service.saveAccount(
      'session-a',
      { id: 'VIP-US', name: '  VIP 美国  ', site: 'TeraBox', tags: ['vip', 'vip'] },
      new AbortController().signal,
    )
    assert.equal(view.id, 'vip-us')
    assert.equal(view.name, 'VIP 美国')
    assert.deepEqual(view.tags, ['vip'])
    assert.equal(view.hasState, true)
    assert.equal(recorder.saved.length, 1)
    assert.deepEqual(service.current('session-a'), { currentAccountId: 'vip-us' })
    assert.equal((await service.list()).accounts.length, 1)
  })
})

test('saveAccount upserts an existing id without duplicating it', async () => {
  await withService({ sessions: ['session-a'] }, async ({ service, recorder }) => {
    await service.saveAccount('session-a', { id: 'vip-us', name: '旧名', site: 'Old' }, new AbortController().signal)
    const updated = await service.saveAccount('session-a', { id: 'vip-us', name: '新名' }, new AbortController().signal)
    assert.equal(updated.name, '新名')
    assert.equal(updated.site, 'Old', 'an omitted optional field is left alone')
    assert.equal((await service.list()).accounts.length, 1)
    assert.equal(recorder.saved.length, 2)
  })
})

test('saveAccount refuses a Session that is not live before writing metadata', async () => {
  await withService({ sessions: [] }, async ({ service }) => {
    await assert.rejects(
      service.saveAccount('session-gone', { id: 'vip-us', name: 'VIP' }, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof BrowserStorageError)
        assert.equal(error.code, 'session-not-live')
        return true
      },
    )
    assert.deepEqual((await service.list()).accounts, [])
  })
})

test('use restores the saved bytes and marks the account current', async () => {
  await withService({ sessions: ['session-a'] }, async ({ service, recorder }) => {
    await service.create({ id: 'vip-us', name: 'VIP' })
    await service.saveState('session-a', 'vip-us', new AbortController().signal)
    const result = await service.use('session-a', 'vip-us', new AbortController().signal)
    assert.equal(result.currentAccountId, 'vip-us')
    assert.equal(result.account.id, 'vip-us')
    assert.equal(recorder.restored.length, 1)
    assert.deepEqual(JSON.parse(recorder.restored[0]?.contents ?? '{}'), JSON.parse(recorder.saved[0]?.contents ?? '{}'))
    assert.deepEqual(service.current('session-a'), { currentAccountId: 'vip-us' })
    assert.deepEqual(service.current('session-b'), {})
  })
})

test('two Sessions hold two different accounts without overwriting each other', async () => {
  await withService({ sessions: ['session-a', 'session-b'] }, async ({ service }) => {
    await service.create({ id: 'vip-us', name: 'VIP' })
    await service.create({ id: 'free-us', name: 'Free' })
    await service.saveState('session-a', 'vip-us', new AbortController().signal)
    await service.saveState('session-b', 'free-us', new AbortController().signal)

    await service.use('session-a', 'vip-us', new AbortController().signal)
    await service.use('session-b', 'free-us', new AbortController().signal)

    assert.deepEqual(service.current('session-a'), { currentAccountId: 'vip-us' })
    assert.deepEqual(service.current('session-b'), { currentAccountId: 'free-us' })
    assert.equal((await service.list('session-a')).currentAccountId, 'vip-us')
    assert.equal((await service.list('session-b')).currentAccountId, 'free-us')
    assert.equal((await service.list()).currentAccountId, undefined, 'no Session means no current account')
  })
})

test('a Session that is not live cannot touch a browser', async () => {
  await withService({ sessions: ['session-a'] }, async ({ service }) => {
    await service.create({ id: 'vip-us', name: 'VIP' })
    await service.saveState('session-a', 'vip-us', new AbortController().signal)
    for (const call of [
      () => service.saveState('session-gone', 'vip-us', new AbortController().signal),
      () => service.use('session-gone', 'vip-us', new AbortController().signal),
    ]) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof BrowserStorageError)
        assert.equal(error.code, 'session-not-live')
        return true
      })
    }
  })
})

test('using an account without saved state reports state-missing', async () => {
  await withService({ sessions: ['session-a'] }, async ({ service }) => {
    await service.create({ id: 'vip-us', name: 'VIP' })
    await assert.rejects(service.use('session-a', 'vip-us', new AbortController().signal), /还没有保存登录态/u)
  })
})

test('removing an account clears every Session claim on it', async () => {
  await withService({ sessions: ['session-a', 'session-b'] }, async ({ service }) => {
    await service.create({ id: 'vip-us', name: 'VIP' })
    await service.saveState('session-a', 'vip-us', new AbortController().signal)
    await service.saveState('session-b', 'vip-us', new AbortController().signal)
    await service.use('session-a', 'vip-us', new AbortController().signal)
    await service.use('session-b', 'vip-us', new AbortController().signal)

    assert.deepEqual(await service.remove('vip-us'), { id: 'vip-us' })
    assert.deepEqual(service.current('session-a'), {})
    assert.deepEqual(service.current('session-b'), {})
    assert.deepEqual((await service.list()).accounts, [])
  })
})

test('update can clear optional metadata', async () => {
  await withService({}, async ({ service }) => {
    await service.create({ id: 'vip-us', name: 'VIP', site: 'TeraBox', tags: ['vip'] })
    const updated = await service.update('vip-us', { name: 'VIP 美国', site: null, tags: null })
    assert.equal(updated.name, 'VIP 美国')
    assert.equal(updated.site, undefined)
    assert.equal(updated.tags, undefined)
  })
})

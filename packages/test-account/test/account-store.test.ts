import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, AccountStoreError, normalizeId } from '../src/account-store.ts'

/**
 * Run one case against a fresh temporary account store.
 * @param run - case body.
 */
async function withStore(run: (store: AccountStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-account-'))
  try {
    await run(new AccountStore(root), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('a missing registry reads as empty', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.read(), { version: 1, accounts: [] })
    assert.deepEqual(await store.list(), [])
  })
})

test('create persists metadata without any state file', async () => {
  await withStore(async (store, root) => {
    const account = await store.create({ id: 'VIP-US', name: '  VIP 美国测试账号  ', site: 'TeraBox', tags: ['vip', 'us', 'vip'] })
    assert.equal(account.id, 'vip-us')
    assert.equal(account.name, 'VIP 美国测试账号')
    assert.equal(account.site, 'TeraBox')
    assert.deepEqual(account.tags, ['vip', 'us'])
    assert.equal(account.stateFile, 'states/vip-us.json')

    const onDisk = JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.accounts.length, 1)
    assert.equal(onDisk.accounts[0].id, 'vip-us')

    assert.deepEqual(await store.stateInfo(account), { exists: false })
    assert.equal((await store.list()).length, 1)
  })
})

test('a duplicate id is rejected', async () => {
  await withStore(async (store) => {
    await store.create({ id: 'vip-us', name: 'VIP' })
    await assert.rejects(store.create({ id: 'vip-us', name: 'VIP again' }), (error: unknown) => {
      assert.ok(error instanceof AccountStoreError)
      assert.equal(error.code, 'duplicate-id')
      return true
    })
  })
})

test('invalid ids and blank names are rejected', async () => {
  await withStore(async (store) => {
    for (const id of ['', 'VIP US', '-lead', 'a/b', 'x'.repeat(65)]) {
      assert.throws(() => normalizeId(id), /不合法/u, `expected ${JSON.stringify(id)} to be rejected`)
    }
    await assert.rejects(store.create({ id: 'ok', name: '   ' }), /名称不能为空/u)
  })
})

test('update patches metadata and null clears optional fields', async () => {
  await withStore(async (store) => {
    await store.create({ id: 'vip-us', name: 'VIP', site: 'TeraBox', tags: ['vip'] })
    const renamed = await store.update('vip-us', { name: 'VIP 美国', tags: ['vip', 'us'] })
    assert.equal(renamed.name, 'VIP 美国')
    assert.deepEqual(renamed.tags, ['vip', 'us'])
    assert.equal(renamed.site, 'TeraBox')

    const cleared = await store.update('vip-us', { site: null, tags: null })
    assert.equal(cleared.site, undefined)
    assert.equal(cleared.tags, undefined)
    assert.equal('site' in cleared, false)
    assert.equal('tags' in cleared, false)

    await assert.rejects(store.update('missing', { name: 'x' }), /不存在/u)
  })
})

test('state round-trips through the states directory', async () => {
  await withStore(async (store) => {
    const account = await store.create({ id: 'vip-us', name: 'VIP' })
    await store.writeState(account, '{"cookies":[]}')
    assert.equal(await store.readState(account), '{"cookies":[]}')
    const info = await store.stateInfo(account)
    assert.equal(info.exists, true)
    assert.equal(info.bytes, 14)
    assert.ok(typeof info.updatedAt === 'string')
  })
})

test('touch records the last save time', async () => {
  await withStore(async (store) => {
    await store.create({ id: 'vip-us', name: 'VIP' })
    const touched = await store.touch('vip-us', '2026-09-22T10:30:00.000Z')
    assert.equal(touched.updatedAt, '2026-09-22T10:30:00.000Z')
    assert.equal((await store.get('vip-us'))?.updatedAt, '2026-09-22T10:30:00.000Z')
  })
})

test('remove drops both the row and the saved state', async () => {
  await withStore(async (store) => {
    const account = await store.create({ id: 'vip-us', name: 'VIP' })
    await store.writeState(account, '{"cookies":[]}')
    await store.remove('vip-us')
    assert.deepEqual(await store.list(), [])
    assert.deepEqual(await store.stateInfo(account), { exists: false })
    await assert.rejects(store.remove('vip-us'), /不存在/u)
  })
})

test('a malformed registry fails loudly', async () => {
  await withStore(async (store, root) => {
    await writeFile(join(root, 'accounts.json'), '{ not json', 'utf8')
    await assert.rejects(store.read(), (error: unknown) => {
      assert.ok(error instanceof AccountStoreError)
      assert.equal(error.code, 'invalid-json')
      return true
    })
  })
})

test('a state path outside states/ is refused', async () => {
  await withStore(async (store) => {
    assert.throws(() => store.statePath({ stateFile: '../escape.json' }), /越界/u)
    assert.throws(() => store.statePath({ stateFile: 'states/../../escape.json' }), /越界/u)
    assert.ok(store.statePath({ stateFile: 'states/ok.json' }).endsWith(join('states', 'ok.json')))
  })
})

test('reading state that was never saved reports state-missing', async () => {
  await withStore(async (store) => {
    const account = await store.create({ id: 'vip-us', name: 'VIP' })
    await assert.rejects(store.readState(account), (error: unknown) => {
      assert.ok(error instanceof AccountStoreError)
      assert.equal(error.code, 'state-missing')
      return true
    })
  })
})

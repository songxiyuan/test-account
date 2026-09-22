import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, resolveConfig } from '../src/index.ts'

/** What one fake Context observed while the plugin was applied. */
interface Harness {
  ctx: Context
  toolNames: string[]
  routes: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }[]
  effects: string[]
}

/**
 * Build a Context double good enough to apply the plugin against.
 * @returns the harness.
 */
function harness(): Harness {
  const toolNames: string[] = []
  const routes: Harness['routes'] = []
  const effects: string[] = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    effect: (execute: () => unknown, label?: string) => {
      if (label !== undefined) effects.push(label)
      const dispose = execute()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    connection: {
      fetch: {
        register: (route: Harness['routes'][number]) => {
          routes.push(route)
          return async () => {}
        },
      },
    },
    tools: {
      register: (definition: { name: string }) => {
        toolNames.push(definition.name)
        return () => {}
      },
    },
    agents: { get: () => undefined },
  }
  return { ctx: ctx as unknown as Context, toolNames, routes, effects }
}

/**
 * Run one case against a fresh account directory.
 * @param run - case body.
 */
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-account-wiring-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Post one endpoint to a registered route.
 * @param route - the route under test.
 * @param body - request body.
 * @returns the decoded response.
 */
async function post(route: Harness['routes'][number], body: unknown): Promise<Response> {
  return route.fetch(
    new Request('http://127.0.0.1/api/test-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('defaults enable the Agent tools and the account directory follows DSH_HOME', async () => {
  const config = resolveConfig()
  assert.equal(config.mcpProvider, 'playwright-mcp')
  assert.equal(config.stateAccess, 'direct')
  assert.equal(config.agentTools, true)
  assert.ok(config.root.endsWith('test-accounts'))
})

test('applying registers one route plus the three Agent tools', async () => {
  await withRoot(async (root) => {
    const { ctx, toolNames, routes, effects } = harness()
    apply(ctx, { root })
    assert.deepEqual(toolNames, ['account_list', 'account_use', 'account_current'])
    assert.equal(routes.length, 1)
    assert.equal(routes[0]?.path, '/api/test-account')
    assert.deepEqual(routes[0]?.methods, ['POST'])
    assert.ok(effects.some((label) => label.includes('remote route')))
  })
})

test('agentTools: false publishes no model-visible tools', async () => {
  await withRoot(async (root) => {
    const { ctx, toolNames, routes } = harness()
    apply(ctx, { root, agentTools: false })
    assert.deepEqual(toolNames, [])
    assert.equal(routes.length, 1, 'the panel route stays available')
  })
})

test('the route round-trips a create and a list', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = harness()
    apply(ctx, { root })
    const route = routes[0]
    assert.ok(route !== undefined)

    const created = await (await post(route, { endpoint: 'accounts/create', payload: { input: { id: 'VIP-US', name: 'VIP 美国', tags: ['vip'] } } })).json()
    assert.equal(created.ok, true)
    assert.equal(created.value.id, 'vip-us')
    assert.equal(created.value.hasState, false)

    const listed = await (await post(route, { endpoint: 'accounts/list', payload: {} })).json()
    assert.equal(listed.ok, true)
    assert.equal(listed.value.accounts.length, 1)
    assert.equal(listed.value.accounts[0].id, 'vip-us')
    assert.deepEqual(listed.value.accounts[0].tags, ['vip'])

    const bad = await post(route, { endpoint: '', payload: {} })
    assert.equal(bad.status, 400)
    const unknown = await (await post(route, { endpoint: 'accounts/nope', payload: {} })).json()
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown-endpoint')
  })
})

test('the route reports a browser failure as a coded error', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = harness()
    apply(ctx, { root })
    const route = routes[0]
    assert.ok(route !== undefined)
    await post(route, { endpoint: 'accounts/create', payload: { input: { id: 'vip-us', name: 'VIP' } } })
    const used = await (await post(route, { endpoint: 'accounts/use', payload: { sessionId: 'session-a', id: 'vip-us' } })).json()
    assert.equal(used.ok, false)
    assert.equal(used.error.code, 'session-not-live')
  })
})

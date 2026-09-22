#!/usr/bin/env node
/**
 * Structural smoke test for the built client bundle.
 *
 * The web shell loads `lib/client.js` as a classic script and requires the exact
 * `window.__ModuleLoader__.load({ id, factory })` envelope, with `apply` and
 * `inject` on the returned exports. A plain ESM build would look fine on disk and
 * still fail at runtime, so this checks the contract directly.
 *
 * Usage: node scripts/check-bundle.mjs packages/test-account
 */

import { readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const packageDir = resolve(process.argv[2] ?? 'packages/test-account')
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const bundlePath = join(packageDir, 'lib/client.js')
const hostPath = join(packageDir, 'lib/index.js')

await access(hostPath)
const entry = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).exports['./client']
if (entry?.default === undefined) throw new Error('package.json must export ./client with a default target')

const source = await readFile(bundlePath, 'utf8')
const firstStatement = source
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n')
  .trimStart()
if (!firstStatement.startsWith('window.__ModuleLoader__.load(')) {
  throw new Error('lib/client.js must open with window.__ModuleLoader__.load(')
}

/** Modules the fake loader hands back; only React is actually reached at build time. */
const provided = new Map([
  ['react', { useState: () => [], useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: () => ({}) }],
  ['react/jsx-runtime', { jsx: () => null, jsxs: () => null, Fragment: Symbol('fragment') }],
])

let loaded
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (definition) => {
        loaded = definition
      },
    },
  },
  Symbol,
  Object,
  console,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: bundlePath })

if (loaded === undefined) throw new Error('the bundle registered nothing with window.__ModuleLoader__')
if (loaded.id !== manifest.name) throw new Error(`bundle id ${loaded.id} != package name ${manifest.name}`)

const exports = loaded.factory((id) => {
  if (!provided.has(id)) throw new Error(`unexpected runtime module request: ${id}`)
  return provided.get(id)
})

if (typeof exports.apply !== 'function') throw new Error('client exports must expose apply()')
if (!Array.isArray(exports.inject)) throw new Error('client exports must expose an inject array')
for (const service of ['connection', 'slots', 'sidebarRight', 'sidebarRightTabs']) {
  if (!exports.inject.includes(service)) throw new Error(`client inject is missing ${service}`)
}

const host = await import(pathToFileURL(hostPath).href)
if (typeof host.apply !== 'function') throw new Error('host half must expose apply()')
if (!Array.isArray(host.inject)) throw new Error('host half must expose an inject array')
for (const service of ['connection', 'tools', 'agents', 'webServer']) {
  // webServer is load-bearing: `ctx.connection.rpc.handle()` mounts the channel
  // on the reading context's own Web server and Cordis refuses an undeclared read.
  if (!host.inject.includes(service)) throw new Error(`host inject is missing ${service}`)
}
if (host.name !== 'test-account') throw new Error(`unexpected host plugin name: ${host.name}`)

console.log(`OK ${manifest.name}: client id=${loaded.id} inject=[${exports.inject.join(', ')}]; host name=${host.name}`)

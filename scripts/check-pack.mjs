#!/usr/bin/env node
/**
 * Publish-integrity check for the two publishable packages.
 *
 * A package's `files` list (plus npm's always-included entries) decides what
 * actually reaches the registry. That list used to name individual
 * `lib/*.js` paths, so `lib/index.js` shipped without the sibling modules it
 * imports and the published package could not be loaded at all (`files` was
 * listing three files while `tsc` emits a dozen). The failure is invisible
 * locally because the checkout always has every file.
 *
 * This script reads the real `npm pack` file list and asserts that every
 * relative import/require inside the packed JavaScript resolves to a file that
 * is packed as well, so the bug shows up as a red build instead of a broken
 * install on another machine.
 *
 * Usage: node scripts/check-pack.mjs [packageDir ...]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** Relative specifier in `from '...'`, `import(...)`, `import '...'` or `require(...)`. */
const RELATIVE_SPECIFIER = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g

/**
 * The packlist npm would upload, as POSIX-style paths relative to the package.
 * @param raw - stdout of `npm pack --dry-run --json`.
 * @returns the packed file paths.
 */
function parsePacklist(raw) {
  // Lifecycle scripts (our `prepack` build) print to the same stdout, so the
  // JSON body starts after the first line that opens the array.
  const offset = raw.indexOf('\n[') + 1
  const text = offset > 0 ? raw.slice(offset) : raw
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0]?.files)) {
    throw new Error('unexpected `npm pack --dry-run --json` shape')
  }
  return parsed[0].files.map((entry) => entry.path)
}

/**
 * Every relative specifier mentioned by one packed JavaScript file.
 * @param source - file contents.
 * @returns the distinct specifiers.
 */
function relativeSpecifiers(source) {
  const found = new Set()
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) found.add(match[2])
  return found
}

const args = process.argv.slice(2)
const dirs = args.length > 0
  ? args
  : readdirSync('packages')
    .map((name) => join('packages', name))
    .filter((dir) => statSync(dir).isDirectory() && statSync(join(dir, 'package.json')).isFile())

let failed = false
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const packed = parsePacklist(execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }))
  const packedSet = new Set(packed)
  const problems = []

  if (!packedSet.has(manifest.main ?? 'index.js')) {
    problems.push(`main entry "${manifest.main}" is not in the packlist`)
  }
  for (const patch of [manifest.dsh?.bundle?.patch].filter(Boolean)) {
    if (!packedSet.has(patch.replace(/^\.\//, ''))) problems.push(`bundle patch "${patch}" is not in the packlist`)
  }
  for (const file of packed.filter((path) => path.endsWith('.js'))) {
    for (const specifier of relativeSpecifiers(readFileSync(join(dir, file), 'utf8'))) {
      const target = relative(dir, resolve(dirname(join(dir, file)), specifier))
      if (!packedSet.has(target)) problems.push(`${file} imports "${specifier}" but ${target} is not packed`)
    }
  }

  if (problems.length > 0) {
    failed = true
    console.error(`FAIL ${manifest.name}@${manifest.version} (${packed.length} files)`)
    for (const problem of problems) console.error(`  - ${problem}`)
  } else {
    console.log(`OK   ${manifest.name}@${manifest.version}: ${packed.length} files, every relative import packed`)
  }
}

if (failed) process.exit(1)

#!/usr/bin/env bun
/**
 * audit-harness-entries — the entry-hygiene guard for the one harness package (POD-4469).
 *
 * Everything about harnesses lives in `@podium/harness`, and the entries carry
 * the host/contract/browser splits. Four entries must never grow a host
 * import, or the POD-2176 failure repeats (a settings chunk bundling 42
 * harness sources plus sqlite because one import reached too far):
 *
 *   @podium/harness          (root — the daemon host barrel)
 *   @podium/harness/driver   (contract — the server may import it)
 *   @podium/harness/store    (transcript store — both sides)
 *   @podium/harness/browser  (descriptor facts — clients bundle it)
 *
 * An entry "imports" a forbidden module when the ENTRY FILE names it directly
 * (arm A) — and, for /driver, /store and /browser, when any module in the
 * entry's transitive source closure names it (arm B). `/browser` is already
 * held to no-Node by `manifest-browser-reach` and `audit-browser-reach`; this
 * script holds the same closure to the host/process/family bar, which those do
 * not check. The root is direct-only by design: it IS the host entry and
 * intentionally reaches process drivers — its hygiene is that the barrel file
 * itself names no host module, so a host import is always an edit on a
 * mechanism file, never a widening of the entry.
 *
 * Forbidden: `node:child_process`, `node:net`, `node:http`, `@podium/process`
 * (and `@podium/pty`, its real package name), and any driver-family module
 * (`packages/harness/src/driver/families/`).
 *
 * A third arm walks the SERVER closure from `apps/server/src/index.ts` and
 * refuses any reachable `driver/families/` module: the server bundle must
 * include no families. Before the dissolve this arm was red (the server
 * reached the agent-runtime barrel); the contract entry is what turns it
 * green.
 *
 * NON-VACUITY, same shape as audit-browser-reach: a resolver that followed
 * nothing would report zero findings for every entry and pass perfectly. So
 * each closure arm floors on modules visited, and `--probe` plants fixture
 * trees that MUST fail every arm:
 *
 *     bun scripts/audit-harness-entries.ts           # the gate
 *     bun scripts/audit-harness-entries.ts --probe   # plant fixtures that MUST fail it
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface EntryFinding {
  entry: string
  kind: 'direct' | 'transitive' | 'server-reaches-family' | 'vacuous'
  detail: string
}

const FORBIDDEN_BARE = new Set([
  'node:child_process',
  'node:net',
  'node:http',
  '@podium/process',
  '@podium/pty',
])

const FAMILY_PREFIX = 'packages/harness/src/driver/families/'

const ENTRIES: Readonly<Record<string, string>> = {
  '@podium/harness': 'packages/harness/src/index.ts',
  '@podium/harness/driver': 'packages/harness/src/driver.ts',
  '@podium/harness/store': 'packages/harness/src/store.ts',
  '@podium/harness/browser': 'packages/harness/src/browser.ts',
}

/** Entries whose transitive closure is held to the bar (root is direct-only). */
const CLOSURE_ENTRIES = ['@podium/harness/driver', '@podium/harness/store', '@podium/harness/browser']

const SERVER_ENTRY = 'apps/server/src/index.ts'

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')
}

export interface ImportRef {
  specifier: string
  typeOnly: boolean
}

export function extractImports(source: string): ImportRef[] {
  const out: ImportRef[] = []
  const stripped = stripComments(source)
  const re =
    /\b(?:import|export)\s+(type\s+)?(?:\{[^}]*\}|[A-Za-z_$][\w$]*|\*\s*(?:as\s+[A-Za-z_$][\w$]*)?)\s+from\s*['"]([^'"]+)['"]/g
  for (const m of stripped.matchAll(re)) {
    out.push({ specifier: m[2] ?? '', typeOnly: Boolean(m[1]) })
  }
  // Side-effect imports carry no binding but still pull the module in.
  for (const m of stripped.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) {
    out.push({ specifier: m[1] ?? '', typeOnly: false })
  }
  return out
}

export function isForbiddenSpecifier(spec: string): boolean {
  if (FORBIDDEN_BARE.has(spec)) return true
  if (spec.includes('driver/families')) return true
  return false
}

export function isForbiddenModule(repoRel: string): boolean {
  return repoRel.startsWith(FAMILY_PREFIX)
}

/**
 * Resolve an import specifier to a repo-relative source path, or null for
 * leaves the source walk cannot (and need not) follow: npm bare specifiers,
 * node:/bun: builtins, JSON data, and workspace subpaths with no source file.
 */
export function resolveToSource(
  root: string,
  fromFile: string,
  spec: string,
): string | null {
  if (spec.startsWith('node:') || spec.startsWith('bun:')) return null
  if (spec.startsWith('.')) {
    const base = spec.replace(/\.js$/, '')
    const dir = dirname(fromFile)
    for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      const abs = resolve(root, dir, cand)
      if (existsSync(abs)) return join(dir, cand).replace(/\\/g, '/')
    }
    // JSON fixtures and other data are leaves, not modules.
    return null
  }
  if (!spec.startsWith('@podium/')) return null
  const parts = spec.split('/')
  const pkg = `${parts[0]}/${parts[1]}`
  const sub = parts.slice(2).join('/')
  const wsDir = pkg === '@podium/process' ? 'packages/pty' : `packages/${parts[1]}`
  const table: Readonly<Record<string, string>> = {
    '@podium/harness': 'packages/harness/src/index.ts',
    '@podium/harness/metadata': 'packages/harness/src/metadata.ts',
    '@podium/harness/browser': 'packages/harness/src/browser.ts',
    '@podium/harness/driver': 'packages/harness/src/driver.ts',
    '@podium/harness/driver/host': 'packages/harness/src/driver/host.ts',
    '@podium/harness/driver/testing': 'packages/harness/src/driver/testing/index.ts',
    '@podium/harness/store': 'packages/harness/src/store.ts',
    '@podium/harness/inventory': 'packages/harness/src/inventory.ts',
  }
  if (pkg === '@podium/harness' && sub !== '' && !(spec in table)) {
    // Deep family (or future) subpath: map onto the source tree directly.
    const cand = `packages/harness/src/${sub}.ts`
    if (existsSync(join(root, cand))) return cand
    const idx = `packages/harness/src/${sub}/index.ts`
    if (existsSync(join(root, idx))) return idx
    return null
  }
  if (spec in table) return table[spec]!
  if (sub !== '') {
    const cand = `${wsDir}/src/${sub}.ts`
    if (existsSync(join(root, cand))) return cand
    const idx = `${wsDir}/src/${sub}/index.ts`
    if (existsSync(join(root, idx))) return idx
    return null
  }
  const idx = `${wsDir}/src/index.ts`
  return existsSync(join(root, idx)) ? idx : null
}

export function auditDirectAt(root: string, entry: string, file: string): EntryFinding[] {
  const findings: EntryFinding[] = []
  const source = readFileSync(join(root, file), 'utf8')
  for (const ref of extractImports(source)) {
    if (ref.typeOnly) continue
    if (isForbiddenSpecifier(ref.specifier)) {
      findings.push({
        entry,
        kind: 'direct',
        detail: `${file}: entry directly imports forbidden '${ref.specifier}' — a host import on an entry widens the surface for every consumer; put it on a mechanism file instead.`,
      })
    }
  }
  return findings
}

export function walkClosure(
  root: string,
  entryFile: string,
  visitor: (file: string, ref: ImportRef) => void,
): { visited: number } {
  const seen = new Set<string>()
  const stack = [entryFile]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    let source: string
    try {
      source = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const ref of extractImports(source)) {
      if (ref.typeOnly) continue
      visitor(file, ref)
      const next = resolveToSource(root, file, ref.specifier)
      if (next !== null && !seen.has(next)) stack.push(next)
    }
  }
  return { visited: seen.size }
}

export function auditClosureAt(root: string, entry: string, file: string): EntryFinding[] {
  const findings: EntryFinding[] = []
  const { visited } = walkClosure(root, file, (from, ref) => {
    if (isForbiddenSpecifier(ref.specifier)) {
      findings.push({
        entry,
        kind: 'transitive',
        detail: `${entry}: '${ref.specifier}' imported by ${from} — reachable from the entry closure; the contract/store/browser surface must not reach host code.`,
      })
      return
    }
    const next = resolveToSource(root, from, ref.specifier)
    if (next !== null && isForbiddenModule(next)) {
      findings.push({
        entry,
        kind: 'transitive',
        detail: `${entry}: driver-family module '${next}' imported by ${from} — families live behind /driver/host, never behind this entry.`,
      })
    }
  })
  // The floor is per-entry, measured from the entry's own imports: a barrel
  // that resolved nothing is a resolver failure, not a clean entry.
  const ownImports = extractImports(readFileSync(join(root, file), 'utf8')).filter(
    (r) => !r.typeOnly,
  ).length
  if (visited < ownImports + 1) {
    findings.push({
      entry,
      kind: 'vacuous',
      detail: `${entry}: closure walk visited ${visited} module(s) for ${ownImports} import(s) — the resolver followed nothing; failing rather than passing vacuous.`,
    })
  }
  return findings
}

export function auditServerClosureAt(root: string, serverEntry: string): EntryFinding[] {
  const findings: EntryFinding[] = []
  const { visited } = walkClosure(root, serverEntry, (from, ref) => {
    if (ref.specifier.includes('driver/families')) {
      findings.push({
        entry: '@podium/server',
        kind: 'server-reaches-family',
        detail: `server closure: '${ref.specifier}' imported by ${from} — the server bundle must include no driver families; take the contract entry instead.`,
      })
      return
    }
    const target = resolveToSource(root, from, ref.specifier)
    if (target !== null && isForbiddenModule(target)) {
      findings.push({
        entry: '@podium/server',
        kind: 'server-reaches-family',
        detail: `server closure: driver-family module '${target}' imported by ${from} — the server bundle must include no driver families; take the contract entry instead.`,
      })
    }
  })
  return { visited, findings }
}

export function auditServerClosure(): EntryFinding[] {
  const { visited, findings } = auditServerClosureAt(REPO, SERVER_ENTRY)
  if (visited < 50) {
    return [
      ...findings,
      {
        entry: '@podium/server',
        kind: 'vacuous',
        detail: `server closure walk visited ${visited} module(s) — the server graph is thousands; failing rather than passing vacuous.`,
      },
    ]
  }
  return findings
}

export function auditHarnessEntries(): EntryFinding[] {
  const findings: EntryFinding[] = []
  for (const [entry, file] of Object.entries(ENTRIES)) {
    findings.push(...auditDirectAt(REPO, entry, file))
  }
  for (const entry of CLOSURE_ENTRIES) {
    findings.push(...auditClosureAt(REPO, entry, ENTRIES[entry]!))
  }
  findings.push(...auditServerClosure())
  return findings
}

export function plant(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-entries-probe-'))
  for (const [rel, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), source)
  }
  return dir
}

/**
 * `--probe`: prove every arm can fail. Plants fixture trees that MUST be
 * refused and exits non-zero unless all three arms fire. A green from a check
 * that cannot go red proves nothing (POD-732), so the probe runs first in the
 * `audit:harness-entries` script, exactly like `audit:browser-reach --probe`.
 */
export function runProbe(): boolean {
  let ok = true
  const check = (name: string, findings: EntryFinding[], want: EntryFinding['kind']) => {
    const hit = findings.some((f) => f.kind === want)
    console.log(`${hit ? 'PASS' : 'FAIL'} probe ${name}${hit ? '' : `: no '${want}' finding`}`)
    if (!hit) ok = false
  }

  // Arm A (direct): an entry file naming a forbidden module.
  const directDir = plant({
    'entry.ts': `import { x } from 'node:child_process'\nexport const x = 1\n`,
  })
  check('direct-forbidden-import', auditDirectAt(directDir, 'probe', 'entry.ts'), 'direct')
  rmSync(directDir, { recursive: true, force: true })

  // Arm B (transitive): clean entry -> clean middle -> tainted leaf, plus a
  // family-path import. Uses the REAL closure walk on a fixture root.
  const transDir = plant({
    'entry.ts': `export * from './mid'\n`,
    'mid.ts': `export * from './leaf'\n`,
    'leaf.ts': `import { spawn } from 'node:child_process'\nexport const x = spawn\n`,
    'fam-entry.ts': `import { y } from './driver/families/x'\nexport const y2 = y\n`,
    'driver/families/x.ts': `export const y = 1\n`,
  })
  check('transitive-forbidden-import', auditClosureAt(transDir, 'probe', 'entry.ts'), 'transitive')
  check(
    'family-path-import',
    auditClosureAt(transDir, 'probe', 'fam-entry.ts'),
    'transitive',
  )
  rmSync(transDir, { recursive: true, force: true })

  // Arm C (server): a server entry reaching a family module, via the REAL walk.
  const srvDir = plant({
    'server.ts': `import { y } from './driver/families/x'\nexport const y2 = y\n`,
    'driver/families/x.ts': `export const y = 1\n`,
  })
  const { findings: srvFindings } = auditServerClosureAt(srvDir, 'server.ts')
  check('server-reaches-family', srvFindings, 'server-reaches-family')
  rmSync(srvDir, { recursive: true, force: true })

  return ok
}

const args = process.argv.slice(2)
if (args.includes('--probe')) {
  const ok = runProbe()
  if (!ok) {
    console.error('probe INCOMPLETE: an arm that cannot fail is no guard')
    process.exit(1)
  }
  console.log('probe complete: every arm can fail')
  process.exit(0)
}

const findings = auditHarnessEntries()
if (findings.length > 0) {
  for (const f of findings) console.error(`[${f.kind}] ${f.detail}`)
  console.error(
    `\nharness entry audit: ${findings.length} finding(s). Host/process/family code stays behind /driver/host; the contract/store/browser entries must not reach it.`,
  )
  process.exit(1)
}
console.log('harness entry audit: clean (4 entries direct, 3 closures, server closure)')

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE DURABLE DOOR (P2b).
 *
 * Production daemon code reaches a process ONLY through `DurableProcess`
 * (`createDurableProcess` / `durableProcessFor` from
 * `@podium/process/durable`) or through the screen door
 * (`@podium/process/screen`). The raw per-host functions stay exported for
 * tests and for the adapters themselves — this test forbids non-test daemon
 * files from importing them, so the door cannot be walked around.
 *
 * Allowed value imports from the durable door are the sole entry itself, the
 * availability probes `durable-backend.ts` reads through the door, and the
 * systemd scope argv/name helpers the server-family hosts wrap their children
 * in (they name no process and construct no backend or adapter). Type-only
 * imports are always allowed: they erase at runtime and construct nothing.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** Value imports production daemon code may take through the durable door. */
const ALLOWED_DURABLE_VALUES = new Set([
  // Sole entry.
  'createDurableProcess',
  'createDurable',
  'durableProcessFor',
  'durableFor',
  'abducoDurableAdapter',
  'hostDurableAdapter',
  'sweepStaleDurableBindTemps',
  // Availability probes (policy reads them through the door).
  'isHostAvailable',
  'isAbducoAvailable',
  // Systemd scope argv/name helpers (wrap a child, construct no backend).
  'canScopeMaster',
  'scopeUnitName',
  'scopeReclaimArgvs',
  'systemdScopeArgv',
  'applySessionsSliceBudget',
  'scopeEnv',
  'userRuntimeDir',
  'reclaimStaleScope',
  'reclaimTerminatedSession',
  'abducoAttachArgv',
  'abducoCreateArgv',
  'resolveAttachBin',
  'liveEnv',
  'parseAbducoList',
])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts')) yield full
  }
}

function isTestFile(path: string): boolean {
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.integration.test.ts') ||
    path.endsWith('.live.test.ts') ||
    path.endsWith('.smoke.test.ts')
  )
}

/** Split a `{ A, type B, C as D }` clause into `{ name, typeOnly }` specifiers. */
function specifiers(clause: string): Array<{ name: string; typeOnly: boolean }> {
  return clause
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const typeOnly = part.startsWith('type ')
      const bare = typeOnly ? part.slice(5).trim() : part
      const name = bare.split(/\s+as\s+/)[0]?.trim() ?? ''
      return { name, typeOnly }
    })
    .filter((spec) => spec.name && spec.name !== '*')
}

interface Violation {
  file: string
  symbol: string
  from: string
}

function lintFile(path: string): Violation[] {
  const text = readFileSync(path, 'utf8')
  const rel = relative(join(HERE, '..', '..'), path)
  const violations: Violation[] = []
  // import ... from '...' | export ... from '...' (multiline), type-only or not.
  // The clause excludes braces so one match can never span two statements.
  const statement =
    /(import|export)\s+(type\s+)?(?:\{([^{}]*?)\}\s*from\s*|([\w*$][\w*\s,]*?)\s+from\s*)(['"])(@podium\/process(?:\/[a-z]+)?)\5/g
  for (const match of text.matchAll(statement)) {
    const [, kind, typeKeyword, named, , , from] = match
    if (from !== '@podium/process/durable' && from !== '@podium/process/pty' && from !== '@podium/process')
      continue
    if (from === '@podium/process/pty' || from === '@podium/process') {
      violations.push({ file: rel, symbol: '(door import)', from })
      continue
    }
    // Durable door: a statement-level `type` makes every specifier type-only.
    if (typeKeyword) continue
    // Default/namespace imports (`import x from`, `import * as x from`) bind a
    // value — the durable door exports values, so those walk around the list.
    if (!named) {
      violations.push({ file: rel, symbol: kind === 'export' ? '(export *)' : '(default import)', from })
      continue
    }
    for (const spec of specifiers(named)) {
      if (spec.typeOnly) continue
      if (!ALLOWED_DURABLE_VALUES.has(spec.name)) {
        violations.push({ file: rel, symbol: spec.name, from })
      }
    }
  }
  return violations
}

describe('durable door', () => {
  it('no production daemon file imports a raw backend directly', () => {
    const violations: Violation[] = []
    for (const path of walk(HERE)) {
      if (isTestFile(path)) continue
      violations.push(...lintFile(path))
    }
    expect(
      violations.map((v) => `${v.file} imports ${v.symbol} from ${v.from}`),
    ).toEqual([])
  })
})

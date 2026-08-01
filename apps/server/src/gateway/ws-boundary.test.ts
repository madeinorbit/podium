/**
 * THE WS BOUNDARY (POD-389 AC 1, EXTENDED TO THE CLIENT PLANE BY POD-390 AC 2):
 * the gateway is the only module importing WS types, and the sessions service
 * owns no socket — on EITHER plane.
 *
 * Extended here rather than duplicated into a second parallel suite: the
 * property is one property, and two walkers over the same tree drift.
 *
 * A grep audit is necessary and never sufficient, so this checks the property
 * two ways that can disagree: the IMPORT text across the tree, and the sessions
 * service's own module graph. The first would miss a re-export chain; the second
 * would miss a socket reached through a type-only alias.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVER_SRC = join(import.meta.dirname, '..')

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc)
      continue
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

/** `from 'ws'`, `import('ws')`, `require('ws')` — every way the module is named. */
const IMPORTS_WS = /(from\s*['"]ws['"])|(import\(\s*['"]ws['"]\s*\))|(require\(\s*['"]ws['"]\s*\))/

/**
 * Every `.ts` file reachable from `entry` through RELATIVE imports, asserting as
 * it goes that none of them names `ws`. Shared by the two closure tests below so
 * the client plane and the session service are audited by the same walker.
 */
function closureOf(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    expect(IMPORTS_WS.test(src), `${relative(SERVER_SRC, file)} imports ws`).toBe(false)
    for (const m of src.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
      const base = join(file, '..', m[1] as string)
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        try {
          if (statSync(candidate).isFile()) queue.push(candidate)
        } catch {
          // A .js/.json/type-only path that does not resolve to a .ts source.
        }
      }
    }
  }
  return seen
}

describe('the WS boundary', () => {
  const files = sourceFiles(SERVER_SRC)

  it('finds the source tree it is auditing', () => {
    // The instrument must be able to say YES before its NO means anything: a
    // walker pointed at the wrong directory returns an empty list and every
    // assertion below passes vacuously.
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.endsWith('modules/sessions/lifecycle.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('modules/sessions/service.ts'))).toBe(false)
    expect(files.filter((f) => IMPORTS_WS.test(readFileSync(f, 'utf8'))).length).toBeGreaterThan(0)
  })

  it('confines every `ws` import to the gateway', () => {
    const importers = files
      .filter((f) => IMPORTS_WS.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SERVER_SRC, f))
      .sort()
    // POD-390 adds the client half. Both sockets sit at the gateway EDGE and
    // nothing behind them (mux, registry, routing table, ports) may name `ws`.
    expect(importers).toEqual([
      'gateway/client-socket.ts',
      'gateway/daemon-socket.ts',
      'gateway/ws-server.ts',
    ])
  })

  it('leaves no `ws` import anywhere under modules/', () => {
    // Stated separately from the whitelist above so the failure names the actual
    // regression — a feature module that grew a socket — rather than reading as
    // "the gateway file list changed".
    const inModules = files
      .filter((f) => relative(SERVER_SRC, f).startsWith('modules/'))
      .filter((f) => IMPORTS_WS.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SERVER_SRC, f))
    expect(inModules).toEqual([])
  })

  it('left no re-export shim behind at the old location', () => {
    // The extraction routes callers through the replacement seam rather than a
    // forwarding file: a shim would satisfy the import audit above while adding
    // exactly the debt `scripts/rearch-audit.ts` ratchets down (it caught one
    // here, 23 -> 24, and this pins the fix).
    expect(files.map((f) => relative(SERVER_SRC, f))).not.toContain('wsServer.ts')
    const reexporters = files
      .filter((f) =>
        /export\s*\{[^}]*\}\s*from\s*['"]\.\/gateway\/ws-(server|send)['"]/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => relative(SERVER_SRC, f))
    expect(reexporters).toEqual([])
  })

  it('keeps the client MUX socket-free, transitively', () => {
    // The client plane's own version of the walk below. If `ws` reached the mux
    // — directly or through the registry, the routing table or the ports — the
    // extraction would have moved the socket rather than confining it, and the
    // mux would stop being unit-testable against a plain function sink.
    const seen = closureOf(join(SERVER_SRC, 'gateway/client-mux.ts'))
    // POSITIVE CONTROL for this walk specifically: it must have reached the
    // registry and the routing table, or its NO is an empty walk.
    const reached = [...seen].map((f) => relative(SERVER_SRC, f))
    expect(reached).toContain('gateway/client-registry.ts')
    expect(reached).toContain('gateway/client-frame-routing.ts')
    expect(reached.length).toBeGreaterThan(3)
  })

  it('does not reach a socket from the sessions service, transitively', () => {
    // Walk the sessions service's own relative-import closure. `ws` reaching it
    // through five hops of re-export would defeat the text audit above.
    const seen = closureOf(join(SERVER_SRC, 'modules/sessions/lifecycle.ts'))
    // The closure must be real, not an empty walk that trivially passes.
    expect(seen.size).toBeGreaterThan(10)
  })
})

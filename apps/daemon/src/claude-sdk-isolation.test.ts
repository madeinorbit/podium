// apps/daemon/src/claude-sdk-isolation.test.ts
//
// THE TEST THAT ROTS IF YOU WRITE IT THE OBVIOUS WAY.
//
// The property under test is "the Claude Agent SDK is not loaded into the
// daemon's process". The tempting spelling is a grep for
// '@anthropic-ai/claude-agent-sdk' in apps/daemon/src — and that spelling is
// worthless, because it passes the moment anyone re-exports `query` from a
// module with a different name, which is a normal-looking refactor somebody does
// within the week. So this walks the actual IMPORT GRAPH, transitively, from the
// daemon's real entry points, through relative imports and through the workspace
// packages, following static imports, dynamic `import()`, `require()` and
// `export ... from` alike. A re-export is an edge like any other, so hiding
// behind one changes nothing.
//
// It is guarded against its own failure modes at the bottom of the file: a
// walker that silently resolved nothing would "prove" this property about every
// codebase on earth, so the graph is required to reach modules we know are in it,
// and the one file that DOES import the SDK is required to be found.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractImports } from '../../../scripts/architecture-manifest.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const SDK = '@anthropic-ai/claude-agent-sdk'

/**
 * Where the daemon's process actually starts, plus the four modules POD-2690's
 * conformance audit named as reaching the SDK. Listing the four explicitly is not
 * redundant with the entry points: it makes the failure message name the module a
 * future change re-tainted, instead of just saying "the daemon".
 */
const DAEMON_ROOTS = [
  'scripts/daemon.ts',
  'apps/daemon/src/index.ts',
  'apps/daemon/src/daemon.ts',
  'apps/daemon/src/headless-drivers.ts',
  'apps/daemon/src/host-runtime.ts',
  'apps/daemon/src/durable-headless.ts',
  'apps/daemon/src/control/headless.ts',
  'apps/daemon/src/control/context.ts',
]

/** Resolve `@podium/x` / `@podium/x/sub` to a source file via the package's own
 *  exports map, preferring the `@podium/source` condition the daemon runs under. */
function resolveWorkspace(specifier: string): string | null {
  const [, pkg, ...rest] = specifier.split('/')
  if (!pkg) return null
  const pkgJson = join(repoRoot, 'packages', pkg, 'package.json')
  if (!existsSync(pkgJson)) return null
  const manifest = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
    exports?: Record<string, unknown>
  }
  const key = rest.length > 0 ? `./${rest.join('/')}` : '.'
  const entry = manifest.exports?.[key]
  const target =
    typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object'
        ? ((entry as Record<string, string>)['@podium/source'] ??
          (entry as Record<string, string>).import ??
          (entry as Record<string, string>).types)
        : undefined
  if (!target) return null
  return existsFile(join(repoRoot, 'packages', pkg, target))
}

/** A specifier resolves to at most one file; `.js` in source means `.ts` on disk. */
function existsFile(abs: string): string | null {
  const bare = abs.replace(/\.js$/, '')
  for (const candidate of [abs, `${bare}.ts`, `${bare}.tsx`, join(bare, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        if (readFileSync(candidate, 'utf8') !== undefined) return candidate
      } catch {
        // a directory, or unreadable — keep looking
      }
    }
  }
  return null
}

interface Graph {
  /** Every workspace source file reached, repo-relative. */
  files: Set<string>
  /** External package name -> the repo-relative file that imported it. */
  externals: Map<string, string>
}

/**
 * Transitive module closure from `roots`.
 *
 * TYPE-ONLY EDGES ARE FOLLOWED TOO, deliberately. `import type { Options } from
 * '@anthropic-ai/claude-agent-sdk'` is erased at build and loads nothing, so a
 * looser rule could allow it — but the daemon has no need for the SDK's types
 * either, and a type-only import is one deleted keyword away from a value import.
 * Allowing the erased form would leave the loaded form one careless edit away
 * with no test between them.
 */
interface Edges {
  /** Repo-relative workspace files this module imports. */
  internal: string[]
  /** External package names this module imports. */
  external: string[]
}

/** Parse+resolve once per file. The per-root walks below re-traverse the same
 *  modules many times over, and without this the resolver dominates the suite. */
const edgeCache = new Map<string, Edges>()

function edgesOf(file: string): Edges {
  const cached = edgeCache.get(file)
  if (cached) return cached
  const edges: Edges = { internal: [], external: [] }
  const abs = join(repoRoot, file)
  if (existsSync(abs)) {
    for (const ref of extractImports(readFileSync(abs, 'utf8'))) {
      const spec = ref.specifier
      if (spec.startsWith('node:') || spec.startsWith('bun:')) continue
      let target: string | null = null
      if (spec.startsWith('.')) target = existsFile(resolve(dirname(abs), spec))
      else if (spec.startsWith('@podium/')) target = resolveWorkspace(spec)
      else {
        // Bare specifier: an external package. Scoped names keep both segments.
        const name = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]
        if (name) edges.external.push(name)
        continue
      }
      if (target) edges.internal.push(relative(repoRoot, target))
    }
  }
  edgeCache.set(file, edges)
  return edges
}

function closure(roots: string[]): Graph {
  const files = new Set<string>()
  const externals = new Map<string, string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    if (!existsSync(join(repoRoot, file))) continue
    files.add(file)
    const edges = edgesOf(file)
    for (const name of edges.external) if (!externals.has(name)) externals.set(name, file)
    for (const target of edges.internal) queue.push(target)
  }
  return { files, externals }
}

describe('the Claude Agent SDK does not run in the daemon process', () => {
  const graph = closure(DAEMON_ROOTS)

  it('is unreachable from every daemon entry point, by import edge and not by name', () => {
    const importer = graph.externals.get(SDK)
    expect(
      importer,
      importer
        ? `${importer} pulls ${SDK} back into the daemon's process. That package is ` +
            `third-party code driving a long-running agent: in-process, its crashes are ` +
            `the daemon's crashes and its memory is the daemon's memory, so one bad turn ` +
            `takes down every session on the machine. It belongs in the child process ` +
            `behind apps/daemon/src/claude-sdk-client.ts.`
        : '',
    ).toBeUndefined()
  })

  it('is reachable from each root individually, so no root hides behind another', () => {
    for (const root of DAEMON_ROOTS) {
      expect(closure([root]).externals.get(SDK), `${root} reaches ${SDK}`).toBeUndefined()
    }
  })

  // ---- guards on the walker itself ------------------------------------------
  // Everything above is a negative assertion, and a negative assertion is only
  // worth the reach of the thing making it. These pin that reach.

  it('walks far enough for the absence above to mean anything', () => {
    // Multi-hop, through a relative edge and through a workspace package, ending
    // at files no root imports directly.
    expect(graph.files.has('apps/daemon/src/claude-sdk-client.ts')).toBe(true)
    expect(graph.files.has('apps/daemon/src/claude-sdk-protocol.ts')).toBe(true)
    expect([...graph.files].some((f) => f.startsWith('packages/harness/src/'))).toBe(true)
    expect(graph.files.size).toBeGreaterThan(100)
    // And it does see third-party packages when they are really there.
    expect(graph.externals.size).toBeGreaterThan(0)
  })

  it('finds the SDK when it IS imported, so a clean result is a real result', () => {
    // The host is the one module that loads the SDK. If the walker cannot find it
    // HERE, it could not have found it anywhere, and every assertion above is
    // vacuous. This is the control.
    const host = closure(['apps/daemon/src/claude-sdk-host.ts'])
    expect(host.externals.get(SDK)).toBe('apps/daemon/src/claude-sdk-host.ts')
  })

  it('finds the SDK behind a re-export, which is how a name-based check dies', () => {
    // The exact defeat a grep suffers: a module that says nothing about the SDK,
    // importing one that does. Built from real files so it cannot drift from the
    // resolver the assertions above use.
    const viaReExport = closure(['apps/daemon/src/headless-drivers.test.ts'])
    expect(viaReExport.externals.get(SDK)).toBeTruthy()
  })

  it("keeps the compiled binary's dispatch dynamic, because all-in-one shares a process", () => {
    // ONE BINARY SHIPS, and `podium all-in-one` runs the daemon INSIDE the CLI's
    // own process. So scripts/cli-compiled.ts is a daemon entry point whenever
    // that mode is used, and a STATIC `import '../apps/daemon/src/claude-sdk-host.js'`
    // there would load the SDK into the very process this whole change exists to
    // keep it out of — while every assertion above still passed, because the
    // daemon's own modules would be clean.
    //
    // The dispatch must therefore be a dynamic import behind the sentinel: present
    // in the image, evaluated only in a process that was launched to be the host.
    const cli = readFileSync(join(repoRoot, 'scripts/cli-compiled.ts'), 'utf8')
    expect(cli).toContain('claude-sdk-host')
    const refs = extractImports(cli).filter((r) => r.specifier.includes('claude-sdk-host'))
    expect(refs.length, 'cli-compiled.ts must reference the host exactly once').toBe(1)
    // A static import statement would be `import ... from '...claude-sdk-host.js'`
    // or a bare `import '...'`; the dynamic form is `await import('...')`.
    expect(cli).toMatch(/await import\(\s*['"][^'"]*claude-sdk-host\.js['"]\s*\)/)
    expect(cli).not.toMatch(/^\s*import\s+(?:[^'"\n]*\s+from\s+)?['"][^'"]*claude-sdk-host/m)
  })

  it('never lets the daemon import the host module directly', () => {
    // The host is reached by SPAWNING it, never by importing it. An import would
    // put the SDK back in the process by the back door while every other
    // assertion here still passed.
    expect(graph.files.has('apps/daemon/src/claude-sdk-host.ts')).toBe(false)
  })
})

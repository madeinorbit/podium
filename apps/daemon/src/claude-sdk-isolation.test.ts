// apps/daemon/src/claude-sdk-isolation.test.ts
//
// THE TEST THAT ROTS IF YOU WRITE IT THE OBVIOUS WAY.
//
// The property is "the Claude Agent SDK is not loaded into any process that hosts
// the daemon". The tempting spelling is a grep for the package name, and it is
// worthless: it passes the moment anyone re-exports `query` from a module with a
// different name. So this walks the actual IMPORT GRAPH, transitively, following
// static imports, dynamic `import()`, `require()`, `export … from`, and — added
// after an adversarial review defeated the first version — calls through a
// `createRequire` alias.
//
// TWO THINGS THIS FILE LEARNED THE HARD WAY, both from guards that could not fail:
//
//   ROOTS ARE DERIVED, NOT LISTED. The first version carried a hand-written root
//   list, and a hand-written list is an inventory: `scripts/cli.ts` and
//   `scripts/host.ts` each run the daemon in-process and were in neither, so a
//   static import of the SDK in either left the suite green. Roots are now
//   computed from what a module DOES — calls `startDaemon`, imports the daemon
//   module, or reads `parentPort` — so a new daemon-hosting entry point is walked
//   the day it is written, by nobody's decision.
//
//   `createRequire` IS AN IMPORT EDGE. `const req = createRequire(import.meta.url)`
//   then `req('pkg')` loads a module into this process's heap and is invisible to a
//   regex looking for a literal after a `require`/`import` token. The idiom is
//   already at module scope in three files inside this graph, and node-pty — a
//   NATIVE addon in the daemon's address space — was visible to the walk only
//   because an unrelated `typeof import('node-pty')` type annotation happened to
//   sit next to it. Delete the annotation as a tidy-up and it vanished silently.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractImports, isTestFile } from '../../../scripts/architecture-manifest.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const SDK = '@anthropic-ai/claude-agent-sdk'

/** The one module allowed to load the SDK: the child-process host. */
const HOST = 'apps/daemon/src/claude-sdk-host.ts'
/** The compiled binary's entry, which dispatches to the host on a sentinel. */
const COMPILED_ENTRY = 'scripts/cli-compiled.ts'

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function existsFile(abs: string): string | null {
  const bare = abs.replace(/\.js$/, '')
  for (const c of [abs, `${bare}.ts`, `${bare}.tsx`, join(bare, 'index.ts')]) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch {}
  }
  return null
}

function resolveWorkspace(specifier: string, root = repoRoot): string | null {
  const [, pkg, ...rest] = specifier.split('/')
  if (!pkg) return null
  const pkgJson = join(root, 'packages', pkg, 'package.json')
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
  return target ? existsFile(join(root, 'packages', pkg, target)) : null
}

// ---------------------------------------------------------------------------
// createRequire — the fourth edge kind
// ---------------------------------------------------------------------------

const ALIAS_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/g

/**
 * Specifiers loaded through a `createRequire` result, plus any such call whose
 * specifier is NOT a literal.
 *
 * `req.resolve('x')` is deliberately NOT an edge: it returns a path and loads
 * nothing. Only `req('x')` puts a module in this process's heap.
 */
function createRequireEdges(source: string): {
  specifiers: string[]
  computed: string[]
} {
  const specifiers: string[] = []
  const computed: string[] = []
  const aliases = new Set<string>()
  for (const m of source.matchAll(ALIAS_DECL)) if (m[1]) aliases.add(m[1])
  // `createRequire(import.meta.url)('pkg')` with no intermediate binding.
  aliases.add('createRequire\\s*\\([^)]*\\)')
  for (const alias of aliases) {
    const call = new RegExp(`(?:^|[^.\\w$])${alias}\\s*\\(\\s*([^)]*?)\\s*\\)`, 'g')
    for (const m of source.matchAll(call)) {
      const arg = (m[1] ?? '').trim()
      if (!arg) continue
      const literal = arg.match(/^['"]([^'"]+)['"]$/)
      if (literal?.[1]) specifiers.push(literal[1])
      else if (!/^import\.meta\.url$/.test(arg)) computed.push(arg)
    }
  }
  return { specifiers, computed }
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

interface Edges {
  internal: string[]
  external: string[]
  /** createRequire calls whose specifier this walker cannot resolve. */
  computedRequires: string[]
}

const edgeCache = new Map<string, Edges>()

function externalName(spec: string): string {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec)
}

function edgesOf(file: string): Edges {
  const cached = edgeCache.get(file)
  if (cached) return cached
  const edges: Edges = { internal: [], external: [], computedRequires: [] }
  const abs = join(repoRoot, file)
  if (existsSync(abs)) {
    const source = readFileSync(abs, 'utf8')
    const requireEdges = createRequireEdges(source)
    edges.computedRequires = requireEdges.computed
    const specs = [...extractImports(source).map((r) => r.specifier), ...requireEdges.specifiers]
    for (const spec of specs) {
      if (spec.startsWith('node:') || spec.startsWith('bun:')) continue
      let target: string | null = null
      if (spec.startsWith('.')) target = existsFile(resolve(dirname(abs), spec))
      else if (spec.startsWith('@podium/')) target = resolveWorkspace(spec)
      else {
        edges.external.push(externalName(spec))
        continue
      }
      if (target) edges.internal.push(relative(repoRoot, target))
    }
  }
  edgeCache.set(file, edges)
  return edges
}

/**
 * The compiled binary's ONE allowed edge.
 *
 * `podium all-in-one` runs the daemon inside the CLI's process, so
 * cli-compiled.ts is a daemon-address-space entry point. It must reach the host
 * ONLY through the sentinel-guarded dynamic import: present in the image,
 * evaluated only in a process launched to be the host. The edge is dropped from
 * the walk exactly when it is spelled that way — a static import, or any
 * indirection through another module, is a normal edge and gets followed.
 */
function isGuardedHostDispatch(file: string): boolean {
  if (file !== COMPILED_ENTRY) return false
  const src = readFileSync(join(repoRoot, COMPILED_ENTRY), 'utf8')
  const dynamic = /await import\(\s*['"][^'"]*claude-sdk-host\.js['"]\s*\)/.test(src)
  const staticImport = /^\s*import\s+(?:[^'"\n]*\s+from\s+)?['"][^'"]*claude-sdk-host/m.test(src)
  return dynamic && !staticImport
}

interface Graph {
  files: Set<string>
  externals: Map<string, string>
  computedRequires: Map<string, string[]>
}

function closure(roots: string[]): Graph {
  const files = new Set<string>()
  const externals = new Map<string, string>()
  const computedRequires = new Map<string, string[]>()
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    if (!existsSync(join(repoRoot, file))) continue
    files.add(file)
    const edges = edgesOf(file)
    if (edges.computedRequires.length > 0) computedRequires.set(file, edges.computedRequires)
    for (const name of edges.external) if (!externals.has(name)) externals.set(name, file)
    const skipHost = isGuardedHostDispatch(file)
    for (const target of edges.internal) {
      if (skipHost && target === HOST) continue
      queue.push(target)
    }
  }
  return { files, externals, computedRequires }
}

// ---------------------------------------------------------------------------
// Derived roots
// ---------------------------------------------------------------------------

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === 'dist-bun' || e === '.git') continue
      const full = join(dir, e)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(e)) out.push(relative(repoRoot, full))
    }
  }
  for (const top of ['apps', 'packages', 'scripts']) walk(join(repoRoot, top))
  return out.filter((f) => !isTestFile(f))
}

/**
 * Every module that can end up executing in a process that hosts the daemon —
 * DERIVED from what modules do, never listed.
 *
 * A hand-written list is an inventory, and the review that broke the first
 * version of this test broke it exactly there: `scripts/cli.ts` and
 * `scripts/host.ts` both run the daemon in-process and were in nobody's list, so
 * a static SDK import in either was invisible. The three rules below are
 * properties, so the next entry point is covered on the day it is written.
 */
function daemonAddressSpaceRoots(): string[] {
  const roots = new Set<string>([
    'apps/daemon/src/index.ts',
    'apps/daemon/src/daemon.ts',
    // The compiled binary: `podium all-in-one` hosts the daemon in this process.
    COMPILED_ENTRY,
    // Named because POD-2690's conformance audit named them: a failure message
    // that says which of these re-tainted the daemon is worth the four lines.
    'apps/daemon/src/headless-drivers.ts',
    'apps/daemon/src/host-runtime.ts',
    'apps/daemon/src/durable-headless.ts',
    'apps/daemon/src/control/headless.ts',
    'apps/daemon/src/control/context.ts',
  ])
  for (const file of sourceFiles()) {
    const src = readFileSync(join(repoRoot, file), 'utf8')
    // 1. Boots a daemon in this process.
    if (/\bstartDaemon\s*\(/.test(src) && file !== 'apps/daemon/src/daemon.ts') roots.add(file)
    // 2. Pulls in the daemon module, statically or dynamically.
    if (/['"][^'"]*apps\/daemon\/src\/daemon(?:\.js)?['"]/.test(src)) roots.add(file)
    // 3. IS a worker entry. A worker_threads Worker shares this process's address
    //    space and RSS ceiling, so its graph is the daemon's graph. `parentPort`
    //    is the signature of being one — derived, so a new worker is covered.
    if (/parentPort/.test(src) && /node:worker_threads/.test(src)) roots.add(file)
  }
  return [...roots].sort()
}

// ---------------------------------------------------------------------------

describe('the Claude Agent SDK does not run in any process that hosts the daemon', () => {
  const roots = daemonAddressSpaceRoots()
  const graph = closure(roots)

  it('is unreachable from every daemon-hosting entry point, by import edge and not by name', () => {
    const importer = graph.externals.get(SDK)
    expect(
      importer,
      importer
        ? `${importer} pulls ${SDK} back into a process that hosts the daemon. That package ` +
            `is third-party code driving a long-running agent: in-process, its crashes are ` +
            `the daemon's crashes and its memory is the daemon's memory, so one bad turn ` +
            `takes down every session on the machine. It belongs in the child process ` +
            `behind apps/daemon/src/claude-sdk-client.ts.`
        : '',
    ).toBeUndefined()
  })

  it('is unreachable from each root individually, so no root hides behind another', () => {
    for (const root of roots) {
      expect(closure([root]).externals.get(SDK), `${root} reaches ${SDK}`).toBeUndefined()
    }
  })

  it('derives the daemon-hosting entry points instead of listing them', () => {
    // The specific ones an adversarial review used to defeat the hand-written
    // list. If a refactor moves them, the derivation should still find whatever
    // replaced them — hence the rule assertions below, not just these names.
    expect(roots).toContain('scripts/daemon.ts')
    expect(roots).toContain('scripts/cli.ts') // from-source `podium all-in-one`
    expect(roots).toContain('scripts/host.ts') // `bun run host`
    expect(roots).toContain(COMPILED_ENTRY) // the shipped binary
    expect(roots).toContain('apps/daemon/src/discovery-worker.ts') // worker thread
    // Every module that boots a daemon in-process is a root, by rule.
    for (const file of sourceFiles()) {
      const src = readFileSync(join(repoRoot, file), 'utf8')
      if (/\bstartDaemon\s*\(/.test(src) && file !== 'apps/daemon/src/daemon.ts') {
        expect(roots, `${file} boots a daemon but is not a root`).toContain(file)
      }
    }
  })

  it('follows a createRequire alias, which loads into this very heap', () => {
    // The idiom that defeated the previous version of this test:
    //   const req = createRequire(import.meta.url); req('pkg')
    // Proven against the real file rather than a fixture: node-pty is a NATIVE
    // addon running in the daemon's address space, and it must be visible as an
    // edge in its own right — not because a neighbouring type annotation happens
    // to mention it.
    const backend = readFileSync(
      join(repoRoot, 'packages/pty/src/backends/node-pty-backend.ts'),
      'utf8',
    )
    expect(createRequireEdges(backend).specifiers).toContain('node-pty')
    // And the walk sees it from the daemon's roots.
    expect(graph.externals.has('node-pty')).toBe(true)
  })

  it('refuses a createRequire call it cannot resolve, rather than ignoring it', () => {
    // A computed specifier through an alias is unfollowable. Silently skipping it
    // would be a hole shaped exactly like the one this test just closed, so it
    // fails loudly instead and whoever wrote it has to make it resolvable.
    const offenders = [...graph.computedRequires.entries()]
    expect(
      offenders,
      offenders.length > 0
        ? `these load modules through a createRequire alias with a non-literal specifier, ` +
            `which no import-graph walk can follow: ${offenders
              .map(([f, c]) => `${f} (${c.join(', ')})`)
              .join('; ')}`
        : '',
    ).toEqual([])
  })

  it('follows the compiled entry into any indirection, not just its own text', () => {
    // The all-in-one binary hosts the daemon in the CLI's process. A review
    // defeated the previous spelling check with one hop:
    //   scripts/sdk-preload.ts: export { … } from '…/claude-sdk-host.js'
    //   scripts/cli-compiled.ts: import './sdk-preload.js'
    // The text check saw nothing. The graph does: only the DIRECT, dynamic,
    // sentinel-guarded edge is dropped, so any other path is followed.
    expect(closure([COMPILED_ENTRY]).externals.get(SDK)).toBeUndefined()
    const src = readFileSync(join(repoRoot, COMPILED_ENTRY), 'utf8')
    expect(src).toContain('claude-sdk-host')
    expect(isGuardedHostDispatch(COMPILED_ENTRY), 'the dispatch must stay dynamic').toBe(true)
  })

  // ---- guards on the walker itself ------------------------------------------
  // Every assertion above is negative, and a negative assertion is worth only the
  // reach of the thing making it. These pin that reach. Each one has been broken
  // on purpose and confirmed to go red.

  it('walks far enough for the absence above to mean anything', () => {
    expect(graph.files.has('apps/daemon/src/claude-sdk-client.ts')).toBe(true)
    expect(graph.files.has('apps/daemon/src/claude-sdk-protocol.ts')).toBe(true)
    expect(graph.files.has('apps/daemon/src/discovery-jobs.ts')).toBe(true)
    expect([...graph.files].some((f) => f.startsWith('packages/harness/src/'))).toBe(true)
    expect(graph.files.size).toBeGreaterThan(100)
    expect(graph.externals.size).toBeGreaterThan(0)
  })

  it('finds the SDK when it IS imported, so a clean result is a real result', () => {
    const host = closure([HOST])
    expect(host.externals.get(SDK)).toBe(HOST)
  })

  it('follows `export … from`, on a chain that actually contains one', () => {
    // THIS CONTROL WAS WRONG AND A REVIEW CAUGHT IT. Its chain used to be a plain
    // two-hop IMPORT, so blinding re-export edges entirely left the suite green —
    // a vacuity control that was itself vacuous. The chain below really does hang
    // on an `export … from` edge, built on disk so it cannot drift into being an
    // import again.
    const dir = mkdtempSync(join(tmpdir(), 'podium-reexport-'))
    try {
      writeFileSync(join(dir, 'leaf.ts'), `export { query } from '${SDK}'\n`)
      writeFileSync(join(dir, 'middle.ts'), `export * from './leaf.js'\n`)
      writeFileSync(join(dir, 'root.ts'), `import { query } from './middle.js'\nquery\n`)
      const seen = new Set<string>()
      const found: string[] = []
      const walk = (abs: string): void => {
        if (seen.has(abs)) return
        seen.add(abs)
        for (const ref of extractImports(readFileSync(abs, 'utf8'))) {
          if (ref.specifier.startsWith('.')) {
            const next = existsFile(resolve(dirname(abs), ref.specifier))
            if (next) walk(next)
          } else found.push(externalName(ref.specifier))
        }
      }
      walk(join(dir, 'root.ts'))
      expect(seen.size, 'the chain must be three files, or it is not two hops').toBe(3)
      expect(found).toContain(SDK)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never lets a daemon-hosting module import the host directly', () => {
    // The host is reached by SPAWNING it, never by importing it — except the
    // compiled entry's guarded dynamic dispatch, which the walk drops by design.
    expect(graph.files.has(HOST)).toBe(false)
  })
})

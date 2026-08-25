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
import {
  extractImports,
  isTestFile,
  stripComments,
} from '../../../scripts/architecture-manifest.js'

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

/**
 * A specifier a static walker can actually resolve: a plain string literal in any
 * of JavaScript's three delimiters. THE BACKTICK IS THE POINT — `extractImports`
 * accepts only `'` and `"`, so ``await import(`@anthropic-ai/claude-agent-sdk`)``
 * was invisible to it: one character different from the shape it guards, needing
 * no indirection and no new idiom, and caught by nothing else in the repo. A
 * guard that catches `'x'` and misses `` `x` `` is pinned at one edge only.
 *
 * A template with `${` in it is NOT a literal and is deliberately excluded — it
 * cannot be resolved, and it is banned below rather than silently skipped.
 */
const LITERAL = String.raw`(?:'([^']+)'|"([^"]+)"|\`([^\`$]+)\`)`

/** `import(x)` / `require(x)` with a literal specifier, INCLUDING backticks. */
const LITERAL_CALL = new RegExp(String.raw`\b(?:import|require)\s*\(\s*${LITERAL}\s*\)`, 'g')
/** `import(x)` / `require(x)` where x is anything else — unresolvable by anyone. */
const UNRESOLVABLE_CALL = new RegExp(
  String.raw`\b(?:import|require)\s*\(\s*(?!\s*${LITERAL}\s*\))([^)]*)\)`,
  'g',
)

function literalOf(m: RegExpMatchArray, from: number): string | undefined {
  return m[from] ?? m[from + 1] ?? m[from + 2]
}

/**
 * WHY THIS IS A BAN AND NOT A CLEVERER PARSER.
 *
 * An independent review derived thirteen ways to load a module past an
 * import-graph walker. Three of them — `require(a + b)`, `await import(r.resolve(x))`,
 * a requirer exported across a module boundary — are not resolvable by ANY static
 * walker, and the rest differ only in where the requirer is parked: a const, an
 * alias of that const, an object property, a rebound builtin. Chasing them is an
 * arms race the walker loses, and the first version of this fix proved it by
 * following `const req = createRequire(…)` and being defeated by
 * `createRequire as cr` — the same defect one layer down, in the fix for it.
 *
 * So the daemon's graph may not hold the CAPABILITY at all. `createRequire`
 * returns a function that loads arbitrary modules into this process's heap;
 * banning the token bans every spelling of every shape above at once, whatever
 * the local name, because the capability has to be obtained before it can be
 * hidden. Files that genuinely need it are listed with what they may load, and
 * that list is checked — an allowance that does not pin its own specifiers is
 * just a hole with a comment.
 */
const REQUIRER_ALLOWANCE: Record<string, readonly string[]> = {
  // A native addon, loaded lazily so importing the module under Bun never pays
  // for it. Runs in the daemon's address space; see the note on native addons.
  'packages/pty/src/backends/node-pty-backend.ts': ['node-pty'],
  'packages/pty/src/backends/bun-node-pty-tty-polyfill.ts': ['tty'],
  // Node/Bun builtins chosen at runtime, which a static import cannot express.
  'packages/runtime/src/sqlite/bun.ts': ['bun:sqlite'],
  'packages/runtime/src/sqlite/node.ts': ['node:sqlite'],
  // Resolves the TypeScript loader for the SDK host CHILD. `.resolve()` returns a
  // path and loads nothing into this process.
  'apps/daemon/src/claude-sdk-protocol.ts': ['tsx'],
}

/** Every specifier this file loads through a requirer, plus unresolvable ones. */
function requirerLoads(source: string): { specifiers: string[]; unresolvable: string[] } {
  const specifiers: string[] = []
  const unresolvable: string[] = []
  const names = new Set<string>()
  // Any binding whose initialiser calls something named …createRequire (under any
  // import alias), plus aliases of those bindings.
  for (const m of source.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*[cC]reateRequire\w*\s*\(/g,
  )) {
    if (m[1]) names.add(m[1])
  }
  for (let i = 0; i < 3; i++) {
    for (const name of [...names]) {
      for (const m of source.matchAll(
        new RegExp(
          String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${name}\s*(?![(.])`,
          'g',
        ),
      )) {
        if (m[1]) names.add(m[1])
      }
    }
  }
  for (const name of names) {
    const call = new RegExp(String.raw`(?:^|[^.\w$])${name}\s*\(\s*([^)]*?)\s*\)`, 'g')
    for (const m of source.matchAll(call)) {
      const arg = (m[1] ?? '').trim()
      if (!arg || /^import\.meta\.url$/.test(arg)) continue
      const lit = arg.match(/^(?:'([^']+)'|"([^"]+)"|`([^`$]+)`)$/)
      const value = lit ? (lit[1] ?? lit[2] ?? lit[3]) : undefined
      if (value) specifiers.push(value)
      else unresolvable.push(arg)
    }
  }
  // `createRequire(import.meta.url)('spec')` with no intermediate binding.
  for (const m of source.matchAll(
    new RegExp(String.raw`[cC]reateRequire\w*\s*\([^)]*\)\s*\(\s*${LITERAL}\s*\)`, 'g'),
  )) {
    const v = literalOf(m, 1)
    if (v) specifiers.push(v)
  }
  return { specifiers, unresolvable }
}

/** Files that hold a module-loading capability without an allowance. */
function requirerViolations(file: string, source: string): string[] {
  const out: string[] = []
  const allowed = REQUIRER_ALLOWANCE[file]
  const holdsCapability = /\bcreateRequire\b/.test(source)
  if (holdsCapability && !allowed) {
    out.push(
      `${file} obtains a module loader (createRequire). That capability loads ` +
        `arbitrary modules into this process's heap and no import-graph walk can ` +
        `follow where it is later parked — an alias, a property, an export. If the ` +
        `file genuinely needs it, add it to REQUIRER_ALLOWANCE with the exact ` +
        `specifiers it may load.`,
    )
  }
  const loads = requirerLoads(source)
  if (allowed) {
    for (const spec of loads.specifiers) {
      if (!allowed.includes(spec)) {
        out.push(`${file} is allowed a module loader but loads '${spec}', which is not declared`)
      }
    }
  }
  for (const arg of loads.unresolvable) {
    out.push(`${file} loads through a module loader with an unresolvable specifier: ${arg}`)
  }
  for (const m of source.matchAll(UNRESOLVABLE_CALL)) {
    const arg = (m[1] ?? '').trim()
    // `import type … from` and bare re-exports never reach this form; what does is
    // `import(someExpression)`, which nothing can resolve.
    if (arg && !arg.startsWith('/*')) {
      out.push(`${file} calls import()/require() with a non-literal specifier: ${arg}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

interface Edges {
  internal: string[]
  external: string[]
  /** Module-loading capabilities held without a declared allowance. */
  violations: string[]
}

const edgeCache = new Map<string, Edges>()

function externalName(spec: string): string {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec)
}

function edgesOf(file: string): Edges {
  const cached = edgeCache.get(file)
  if (cached) return cached
  const edges: Edges = { internal: [], external: [], violations: [] }
  const abs = join(repoRoot, file)
  if (existsSync(abs)) {
    const source = readFileSync(abs, 'utf8')
    // Prose ABOUT a capability is not the capability. Two files in the harness
    // package explain in comments why `createRequire` at module scope breaks a
    // browser bundle, and a ban that reads those as uses would teach the next
    // person that this test cries wolf.
    edges.violations = requirerViolations(file, stripComments(source))
    const backtickCalls: string[] = []
    for (const m of source.matchAll(LITERAL_CALL)) {
      const v = literalOf(m, 1)
      if (v) backtickCalls.push(v)
    }
    const specs = [
      ...extractImports(source).map((r) => r.specifier),
      ...backtickCalls,
      ...requirerLoads(source).specifiers,
    ]
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
  violations: string[]
}

function closure(roots: string[]): Graph {
  const files = new Set<string>()
  const externals = new Map<string, string>()
  const violations: string[] = []
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    if (!existsSync(join(repoRoot, file))) continue
    files.add(file)
    const edges = edgesOf(file)
    for (const v of edges.violations) violations.push(v)
    for (const name of edges.external) if (!externals.has(name)) externals.set(name, file)
    const skipHost = isGuardedHostDispatch(file)
    for (const target of edges.internal) {
      if (skipHost && target === HOST) continue
      queue.push(target)
    }
  }
  return { files, externals, violations }
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

  it('still sees what an ALLOWED module loader loads', () => {
    // The ban has an allowance list, and an allowance that does not pin its own
    // specifiers is a hole with a comment on it. node-pty is a NATIVE addon
    // running in the daemon's address space; it must be an edge in its own
    // right, not because a neighbouring `typeof import('node-pty')` annotation
    // happens to mention it — that accident is what a review found here, and it
    // was one tidy-up from removing a native addon from the walk in silence.
    const backend = readFileSync(
      join(repoRoot, 'packages/pty/src/backends/node-pty-backend.ts'),
      'utf8',
    )
    expect(requirerLoads(backend).specifiers).toContain('node-pty')
    expect(graph.externals.has('node-pty')).toBe(true)
  })

  it('reads a backtick specifier as the literal it is', () => {
    // ONE CHARACTER defeated the previous walker: extractImports accepts only
    // ' and ", so `await import(`<sdk>`)` was invisible — no indirection, no new
    // idiom, and nothing else in the repo caught it.
    const sample = ['const a = await import(`some-pkg`)', 'const b = require(`other-pkg`)'].join(
      '\n',
    )
    const found: string[] = []
    for (const m of sample.matchAll(LITERAL_CALL)) {
      const v = literalOf(m, 1)
      if (v) found.push(v)
    }
    expect(found).toEqual(['some-pkg', 'other-pkg'])
  })

  // THE DEFEAT BATTERY, from an independent review that derived it BEFORE this fix
  // was written — thirteen ways to get a module into this process past an
  // import-graph walk. Measured against the walker at the time: three controls
  // red, ten defeats green. They live here as a table rather than in a shell
  // script so they run whenever anyone touches this file, and so a fix that
  // closes one shape and leaves its neighbours open fails immediately — which is
  // exactly what the FIRST attempt at this fix did, closing the house idiom and
  // falling to `createRequire as cr`.
  const SPEC = '@anthropic-ai/claude-agent-sdk'
  const BATTERY: readonly { id: string; what: string; code: string }[] = [
    { id: 'S0', what: 'quoted static import', code: `import { query } from '${SPEC}'` },
    { id: 'S0b', what: 'quoted await import()', code: `const m = await import('${SPEC}')` },
    { id: 'S0c', what: 'quoted require()', code: `const m = require('${SPEC}')` },
    { id: 'A0', what: 'template-literal import', code: 'const m = await import(`' + SPEC + '`)' },
    {
      id: 'A0b',
      what: 'template-literal through a requirer',
      code: `const req = createRequire(import.meta.url)\nconst m = req(\`${SPEC}\`)`,
    },
    {
      id: 'A1',
      what: 'direct createRequire call',
      code: `const m = createRequire(import.meta.url)('${SPEC}')`,
    },
    {
      id: 'A2',
      what: 'the house idiom',
      code: `const req = createRequire(import.meta.url)\nconst m = req('${SPEC}')`,
    },
    {
      id: 'A2b',
      what: 'the house idiom under an import alias',
      code: `import { createRequire as cr } from 'node:module'\nconst req = cr(import.meta.url)\nconst m = req('${SPEC}')`,
    },
    {
      id: 'A3',
      what: 'alias of the requirer',
      code: `const req = createRequire(import.meta.url)\nconst r = req\nconst m = r('${SPEC}')`,
    },
    {
      id: 'A4',
      what: 'requirer parked on a property',
      code: `const io = { req: createRequire(import.meta.url) }\nconst m = io.req('${SPEC}')`,
    },
    {
      id: 'A5',
      what: 'resolve then import',
      code: `const req = createRequire(import.meta.url)\nconst m = await import(req.resolve('${SPEC}'))`,
    },
    {
      id: 'A6',
      what: 'concatenated specifier',
      code: `const req = createRequire(import.meta.url)\nconst m = req('@anthropic-ai/' + 'claude-agent-sdk')`,
    },
    {
      id: 'A7',
      what: 'requirer exported across a module boundary',
      code: `export const req = createRequire(import.meta.url)`,
    },
    {
      id: 'A8',
      what: 'rebound requirer',
      code: `const load = createRequire(import.meta.url)\nconst g = load\nconst m = g('${SPEC}')`,
    },
  ]

  it.each(BATTERY)('catches $id — $what', ({ code }) => {
    // "Caught" means either: the capability is refused outright (the ban), or the
    // specifier is resolved and becomes a visible edge. Both end in a red suite
    // for a real module; what must never happen is neither.
    const banned = requirerViolations('apps/daemon/src/probe.ts', stripComments(code)).length > 0
    const resolved = [...code.matchAll(LITERAL_CALL)].some((m) => literalOf(m, 1) === SPEC)
    const imported = extractImports(code).some((r) => r.specifier === SPEC)
    expect(
      banned || resolved || imported,
      `this shape puts ${SPEC} in the daemon's heap and nothing here objects:\n${code}`,
    ).toBe(true)
  })

  it('does not object to the ordinary code around it', () => {
    // The other half of pinning a class: a ban that fires on everything is not a
    // guard, it is noise that gets deleted. These are shapes daemon modules
    // legitimately contain and must stay silent.
    for (const clean of [
      "import { join } from 'node:path'",
      "const mod = await import('./sibling.js')",
      'const x = someFn(import.meta.url)',
      "const y = { resolve: (s: string) => s }\ny.resolve('anything')",
    ]) {
      expect(
        requirerViolations('apps/daemon/src/probe.ts', stripComments(clean)),
        `false positive on: ${clean}`,
      ).toEqual([])
    }
  })

  it('refuses to let a daemon module hold a module loader at all', () => {
    // THE BAN. Not a parser: a review derived thirteen shapes that hide a load
    // from an import-graph walk, and three of them are unresolvable by anything.
    // The capability has to be obtained before it can be hidden, so the token is
    // what is banned — every spelling of every shape dies at once, whatever the
    // local name it is imported under.
    expect(
      graph.violations,
      graph.violations.length > 0 ? graph.violations.join('\n') : '',
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

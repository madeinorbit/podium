/**
 * POD-3262 — the await-preparation engine.
 *
 * ONE mechanism for both passes of the issue. A SEED set of declarations that
 * become asynchronous at the flip; every call to one of them, in a test file or a
 * test helper, gets an `await`; the function containing that call becomes `async`
 * and therefore joins the seed set; repeat to a fixpoint. The type checker
 * resolves call targets, so a helper module imported by forty test files
 * propagates correctly instead of being guessed at by name.
 *
 *   --pass=rename   seed = `new SessionStore(...)`; routes it through the helper
 *   --pass=awaits   seed = every repository method + SessionStore.transact
 *
 * These are the values the argument parser accepts. A name it does not know
 * silently seeds nothing and reports `awaited=0`, which reads exactly like a
 * clean idempotence result — POD-3262 nearly landed on that reading from a
 * stale header comment that named `constructions` and `store-calls`.
 *
 * Sites where `await` is ILLEGAL or would change what a test asserts are never
 * edited; they are reported so a human decides. See REFUSALS below.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The checkout this pass runs against. Derived from the file's own location so
 * a worktree does not have to be named — POD-3262 ran it from a scratch copy
 * with the path pasted in, which is a large part of why nothing it produced
 * could be re-derived by anyone else (POD-3371).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The twelve timing-sensitive suites: the helper, but never an `await`. */
export const EXCLUDED_SUITES = new Set([
  'apps/server/src/store-issues-frame-cache.test.ts',
  'apps/server/src/superagent-concierge.test.ts',
  'apps/server/src/superagent.test.ts',
  'apps/server/src/gateway/feed-serving.principal-wiring.test.ts',
  'apps/server/src/superagent-headless.test.ts',
  'apps/server/src/modules/daemon-request.test.ts',
  'apps/server/src/offer.test.ts',
  'apps/server/src/relay.test.ts',
  'apps/server/src/relay.outbox.test.ts',
  'apps/server/src/modules/messages/service.test.ts',
  'apps/server/src/modules/maintenance/service.test.ts',
  'apps/server/src/modules/shipping/service.test.ts',
  // Added by POD-3262 from the lane: it asserts WHEN a feed announcement leaves
  // a span, which is the property an await between two lines changes.
  'apps/server/src/store/executor/span-side-effects.test.ts',
  // Added by POD-3262 from the lane: the spec names the ISSUES frame cache; the
  // USERS one asserts the same "once per frame" property and fails the same way
  // (1 read becomes 3), which is rule 6.9's mechanism seen directly.
  'apps/server/src/store-users-frame-cache.test.ts',
])

/** The helper module itself constructs the store; it is not a caller to rewrite. */
const NEVER_EDIT = new Set(['apps/server/src/test-support/open-test-store.ts'])

interface Edit {
  start: number
  end: number
  text: string
  why: string
  /**
   * The width of the expression this edit belongs to. Two awaits can begin at
   * the SAME offset — `openTestStore(f).sessions.get(x)` is both a helper call
   * needing `(await …)` and a store call needing `await …`, and both start at
   * `openTestStore`. Applied in the wrong order the statement's await lands
   * INSIDE the parentheses, which awaits the helper twice and leaves the store
   * call un-awaited. The wider expression must end up outermost.
   */
  span?: number
}

export interface Refusal {
  file: string
  line: number
  reason: string
  snippet: string
}

/**
 * The four things a refusal can BE.
 *
 * A location alone is worthless to the flip: every one of these sites becomes a
 * decision when the store actually goes async, and "why was this skipped" is the
 * question asked at each. The category says which decision it is. It is derived
 * from the reason the pass recorded at the moment it refused, so it cannot drift
 * away from the refusal it labels.
 */
export type RefusalCategory =
  /** `await` is a syntax error here — a parameter default, an accessor, a constructor. */
  | 'illegal-await-context'
  /** Making the host async would change what the assertion around it sees. */
  | 'would-change-what-the-caller-reads'
  /** The compiler proved a caller cannot absorb the promise. These are the keep-sync entries. */
  | 'caller-type-cannot-absorb-a-promise'
  /**
   * Reachable only from something that must stay synchronous. The call itself is
   * fine today and becomes a promise at the flip, so the flip has to rewrite the
   * assertion around it. This is the flip's actual work list.
   */
  | 'assertion-must-change-at-the-flip'

export function categorize(reason: string): RefusalCategory {
  if (reason.startsWith('no await possible here')) return 'illegal-await-context'
  if (reason.startsWith('reached from a synchronous-only context')) {
    return 'assertion-must-change-at-the-flip'
  }
  if (reason.startsWith('a caller reads this synchronously')) {
    return 'caller-type-cannot-absorb-a-promise'
  }
  return 'would-change-what-the-caller-reads'
}

const rel = (f: string): string => relative(ROOT, f)

function isTestOrHelper(file: string): boolean {
  const r = rel(file)
  if (NEVER_EDIT.has(r)) return false
  if (r.endsWith('.test.ts')) return true
  if (r.includes('/test-support/')) return true
  return (
    r.endsWith('feed-test-plumbing.ts') ||
    r.endsWith('oracle-support.ts') ||
    r.endsWith('characterization-support.ts')
  )
}

type FnLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration

function isFnLike(n: ts.Node): n is FnLike {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  )
}

function isAsyncFn(fn: ts.Node): boolean {
  return (
    (fn as ts.HasModifiers).modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true
  )
}

/**
 * The nearest function boundary an `await` would belong to, and the reason it
 * cannot be one. Returns `undefined` at module scope (top-level await is fine).
 */
function enclosingFn(node: ts.Node): FnLike | undefined | 'illegal' {
  let n: ts.Node | undefined = node.parent
  while (n) {
    // A parameter's default value is evaluated outside its own function body:
    // `await` is a syntax error there.
    if (ts.isParameter(n)) return 'illegal'
    if (
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)
    ) {
      return 'illegal'
    }
    if (isFnLike(n)) return n
    if (ts.isClassStaticBlockDeclaration(n)) return 'illegal'
    n = n.parent
  }
  return undefined
}

/** Callback positions whose caller consumes the return value synchronously. */
const SYNC_CALLBACK_METHODS = new Set([
  'map',
  'filter',
  'find',
  'findIndex',
  'some',
  'every',
  'sort',
  'flatMap',
  'reduce',
  'forEach',
])

/**
 * Refuse to make `fn` async when doing so would change what its caller sees:
 * an `expect(() => …).toThrow()` arm, or a synchronous array callback.
 */
function refuseAsync(fn: FnLike, checker: ts.TypeChecker): string | undefined {
  const p = fn.parent
  if (ts.isCallExpression(p) && p.arguments.includes(fn as ts.Expression)) {
    const callee = p.expression
    if (ts.isIdentifier(callee) && callee.text === 'expect') {
      return 'argument of expect() — awaiting would turn .toThrow into a rejection assertion'
    }
    if (ts.isPropertyAccessExpression(callee) && SYNC_CALLBACK_METHODS.has(callee.name.text)) {
      return `argument of .${callee.name.text}() — the caller consumes the value synchronously`
    }
  }
  // The general form of both cases above: whatever this function is being passed
  // to declares what it returns, and a caller that declared a plain value gets a
  // promise instead. The contextual type is the only thing that knows.
  const ctx = checker.getContextualType(fn as ts.Expression)
  if (ctx !== undefined) {
    // An OPTIONAL property gives `((f) => unknown) | undefined`, and a union
    // itself has no call signatures — reading them off the whole type answered
    // "no constraint" for exactly the fields that constrain hardest.
    const constituents = ctx.isUnion() ? ctx.types : [ctx]
    const sigs = constituents.flatMap((c) => c.getCallSignatures())
    if (sigs.length > 0 && sigs.every((s) => !signatureAwaits(s, checker))) {
      return `passed where ${checker.typeToString(ctx)} is expected — that caller reads the value, not a promise`
    }
  }
  return undefined
}

/**
 * Would a caller expecting `t` also WAIT for a promise?
 *
 * Not the same question as "would the compiler allow it". A field typed
 * `unknown` accepts a promise happily and the value then reaches an assertion
 * as `Promise {}` — which is how the corrupt-blob oracle's readers first went
 * wrong here. So `any`, `unknown` and a bare `void` are answered NO: only a
 * type that actually mentions a thenable, as vitest's `() => Awaitable<void>`
 * does, is a caller that awaits.
 */
/**
 * Does the caller behind this signature WAIT for what it gets back?
 *
 * The resolved type cannot always say. `Awaitable<unknown>` — which is what
 * vitest's `beforeEach` declares — collapses to plain `unknown`, and so does the
 * corrupt-blob oracle's `read?: (f) => unknown`, which puts what it gets in front
 * of an assertion. The two are indistinguishable AFTER resolution and obvious
 * BEFORE it, so read what the author actually wrote first.
 */
function signatureAwaits(sig: ts.Signature, checker: ts.TypeChecker): boolean {
  const written =
    sig.declaration !== undefined && 'type' in sig.declaration
      ? (sig.declaration.type as ts.TypeNode | undefined)?.getText()
      : undefined
  if (written !== undefined) {
    if (/\b(Awaitable|Promise|PromiseLike|Thenable)\b/.test(written)) return true
    if (/^(unknown|void)$/.test(written.trim())) return false
  }
  return acceptsPromise(checker.getReturnTypeOfSignature(sig))
}

function acceptsPromise(t: ts.Type): boolean {
  // `any` is what vitest's own `TestFunction` collapses to (`Awaitable<any> | void`),
  // and vitest does await what a test returns. `unknown` is the opposite case: the
  // corrupt-blob oracle's `read?: (f) => unknown` accepts a promise and then puts it
  // in front of an assertion. So `any` yes, `unknown` no.
  if (t.getFlags() & ts.TypeFlags.Any) return true
  if (t.isUnion()) return t.types.some(acceptsPromise)
  return t.getProperty('then') !== undefined
}

/** Is this call already inside an `await`, directly or through parentheses? */
function alreadyAwaited(call: ts.Node): boolean {
  let n: ts.Node = call
  while (n.parent !== undefined && ts.isParenthesizedExpression(n.parent)) n = n.parent
  return ts.isAwaitExpression(n.parent)
}

/** Does this expression sit at the very start of its statement? */
function startsAStatement(call: ts.Node, sf: ts.SourceFile): boolean {
  let n: ts.Node = call
  while (n.parent !== undefined && !ts.isSourceFile(n.parent) && !ts.isBlock(n.parent)) {
    if (ts.isStatement(n.parent)) {
      return n.parent.getStart(sf) === call.getStart(sf)
    }
    n = n.parent
  }
  return false
}

/** `await x` binds tighter than `.y`, so a receiver needs parentheses. */
function needsParens(call: ts.Node): boolean {
  const p = call.parent
  if (ts.isPropertyAccessExpression(p) && p.expression === call) return true
  if (ts.isElementAccessExpression(p) && p.expression === call) return true
  if (ts.isCallExpression(p) && p.expression === call) return true
  if (ts.isNonNullExpression(p)) return true
  return false
}

export interface RunOptions {
  pass: 'rename' | 'awaits'
  apply: boolean
  configPath: string
  /** `<repo-relative file>|<original offset>` of functions that must stay sync. */
  keepSync?: Set<string>
  /** Where to write the edited spans of every function this run made async. */
  spansPath?: string
}

const fnKey = (fn: ts.Node): string =>
  `${rel(fn.getSourceFile().fileName)}|${fn.getStart(fn.getSourceFile())}`

export interface RunResult {
  edited: string[]
  refusals: Refusal[]
  sites: number
  /**
   * Keep-sync keys the run never looked up. An entry addresses a function by
   * byte offset, so any edit that moves that function turns its entry into a
   * silent no-op: the pass stops refusing there and proposes the edit again,
   * with nothing saying the list went stale. POD-3262 ran a round-4 list against
   * round-5 code and it REGENERATED the bad form. An unused entry is therefore a
   * failure, not a wart.
   */
  unusedKeepSync: string[]
}

export function run(opts: RunOptions): RunResult {
  const cfgFile = ts.readConfigFile(opts.configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfgFile.config, ts.sys, dirname(opts.configPath))
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()

  // --- seed -------------------------------------------------------------
  // Declarations whose call sites must be awaited. Grows as functions become async.
  const seed = new Set<ts.Node>()
  const refusals: Refusal[] = []
  const keepSyncUsed = new Set<string>()

  const storeFile = program.getSourceFile(join(ROOT, 'apps/server/src/store.ts'))
  if (storeFile === undefined) throw new Error('store.ts not in program')

  if (opts.pass === 'awaits') {
    // The helper is the store's construction, and it is async at the flip.
    const helper = program.getSourceFile(
      join(ROOT, 'apps/server/src/test-support/open-test-store.ts'),
    )
    const helperFn = helper?.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === 'openTestStore',
    )
    if (helperFn === undefined) throw new Error('openTestStore not found')
    seed.add(helperFn)

    // Every method of every repository the store exposes, plus transact.
    const storeClass = storeFile.statements.find(
      (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'SessionStore',
    )
    if (storeClass === undefined) throw new Error('SessionStore class not found')
    for (const member of storeClass.members) {
      if (ts.isPropertyDeclaration(member) && member.type !== undefined) {
        // The 34 repositories and nothing else. `db: SqlDatabase` is the driver
        // seam — it stays synchronous, and a test that reaches for the raw handle
        // to set a row up is not a store call.
        const name = member.type.getText(storeFile)
        if (!name.endsWith('Repository') && name !== 'OperationStore') continue
        const t = checker.getTypeAtLocation(member.type)
        for (const prop of checker.getPropertiesOfType(t)) {
          for (const d of prop.declarations ?? []) {
            if (ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) seed.add(d)
          }
        }
      }
      if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
        if (member.name.text === 'transact') seed.add(member)
      }
    }
  }

  // --- fixpoint ---------------------------------------------------------
  const awaitSites = new Map<ts.SourceFile, Set<ts.Node>>()
  const parenSites = new Set<ts.Node>()
  const asyncSites = new Map<ts.SourceFile, Set<FnLike>>()
  /** For each recorded await site: the function it sits in, and what it calls. */
  const siteHost = new Map<ts.Node, FnLike | undefined>()
  const siteTarget = new Map<ts.Node, ts.Node | undefined>()
  const mustStaySync = new Set<FnLike>()
  const targets = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isTestOrHelper(sf.fileName))

  const record = (sf: ts.SourceFile, call: ts.Node): void => {
    const forFile = awaitSites.get(sf) ?? new Set<ts.Node>()
    awaitSites.set(sf, forFile)
    forFile.add(call)
    if (needsParens(call)) parenSites.add(call)
  }

  let changed = true
  let rounds = 0
  while (changed && rounds < 12) {
    changed = false
    rounds++
    for (const sf of targets) {
      const file = rel(sf.fileName)
      const excluded = EXCLUDED_SUITES.has(file)
      const visit = (node: ts.Node): void => {
        let hit = false
        if (ts.isCallExpression(node) && opts.pass === 'awaits') {
          const sig = checker.getResolvedSignature(node)
          const decl = sig?.declaration
          if (decl !== undefined && seed.has(decl)) hit = true
        }
        if (hit && excluded) {
          // An excluded suite is not edited at all, so anything it calls has to
          // keep working synchronously — including a shared helper that other
          // suites do await. The helper converts with the excluded suites, in the
          // flip branch.
          const target = ts.isCallExpression(node)
            ? checker.getResolvedSignature(node)?.declaration
            : undefined
          if (
            target !== undefined &&
            isFnLike(target) &&
            isTestOrHelper(target.getSourceFile().fileName) &&
            !mustStaySync.has(target)
          ) {
            mustStaySync.add(target)
            changed = true
          }
        }
        if (hit && !excluded) {
          const already = awaitSites.get(sf)?.has(node) === true
          // `(await x).y` puts a ParenthesizedExpression between the call and its
          // await, so a bare parent check reads it as un-awaited and awaits it
          // again. Re-running the pass over its own output must be a no-op.
          const inAwait = alreadyAwaited(node)
          if (!already && !inAwait) {
            const fn = enclosingFn(node)
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
            const target = ts.isCallExpression(node)
              ? checker.getResolvedSignature(node)?.declaration
              : undefined
            if (fn === 'illegal') {
              refusals.push({
                file,
                line,
                reason: 'no await possible here (parameter default, accessor or constructor)',
                snippet: node.getText(sf).slice(0, 90),
              })
            } else {
              record(sf, node)
              siteHost.set(node, fn)
              siteTarget.set(node, target as ts.Node | undefined)
              changed = true
              if (fn !== undefined && !isAsyncFn(fn)) {
                const forFile = asyncSites.get(sf) ?? new Set<FnLike>()
                asyncSites.set(sf, forFile)
                if (!forFile.has(fn)) {
                  forFile.add(fn)
                  // Its own callers must now await it.
                  seed.add(fn)
                  // A function whose value a caller consumes synchronously — an
                  // `expect(() => …).toThrow()` arm, an array callback — cannot
                  // become async without changing what the test asserts.
                  const key = fnKey(fn)
                  const kept = opts.keepSync?.has(key) === true
                  if (kept) keepSyncUsed.add(key)
                  const refusal = kept
                    ? 'a caller reads this synchronously — the compiler said so'
                    : refuseAsync(fn, checker)
                  if (refusal !== undefined) {
                    mustStaySync.add(fn)
                    refusals.push({
                      file,
                      line: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
                      reason: refusal,
                      snippet: fn.getText(sf).slice(0, 90).replace(/\s+/g, ' '),
                    })
                  }
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(sf, visit)
    }
  }

  // --- backward propagation ---------------------------------------------
  // A function that must stay synchronous cannot hold an `await`, so every call
  // it makes to something this pass turned async is un-awaited, and that callee
  // must stay synchronous too. The chain ends at a repository method, which WILL
  // be async at the flip: those sites are reported, because the flip has to
  // change what the test asserts there and this commit may not.
  const hostSites = new Map<FnLike, ts.Node[]>()
  for (const [site, host] of siteHost) {
    if (host === undefined) continue
    const forHost = hostSites.get(host) ?? []
    hostSites.set(host, forHost)
    forHost.push(site)
  }
  const declSourceFile = (n: ts.Node): ts.SourceFile => n.getSourceFile()
  const work = [...mustStaySync]
  while (work.length > 0) {
    const fn = work.pop()
    if (fn === undefined) break
    asyncSites.get(declSourceFile(fn))?.delete(fn)
    for (const site of hostSites.get(fn) ?? []) {
      awaitSites.get(declSourceFile(site))?.delete(site)
      parenSites.delete(site)
      const target = siteTarget.get(site)
      if (target === undefined) continue
      if (isFnLike(target) && isTestOrHelper(target.getSourceFile().fileName)) {
        if (!mustStaySync.has(target)) {
          mustStaySync.add(target)
          work.push(target)
        }
      } else {
        const sf = declSourceFile(site)
        refusals.push({
          file: rel(sf.fileName),
          line: sf.getLineAndCharacterOfPosition(site.getStart(sf)).line + 1,
          reason:
            'reached from a synchronous-only context; at the flip this call becomes a promise ' +
            'and the assertion around it has to change',
          snippet: site.getText(sf).slice(0, 90).replace(/\s+/g, ' '),
        })
      }
    }
  }

  // --- the type-level consequence ---------------------------------------
  // `ReturnType<typeof harness>` names what a helper returns, and a helper this
  // pass made async now returns a promise of it. Every such reference becomes
  // `Awaited<ReturnType<typeof harness>>` — the type-shape edit the spec's step
  // 11a names as the one exemption from "not in the same commit".
  const allAsync = new Set<ts.Node>()
  for (const set of asyncSites.values()) for (const fn of set) allAsync.add(fn)
  const awaitedTypeRefs = new Map<ts.SourceFile, ts.TypeReferenceNode[]>()
  const declaresAnAsyncFn = (sym: ts.Symbol | undefined): boolean => {
    for (const d of sym?.declarations ?? []) {
      if (allAsync.has(d)) return true
      if (
        ts.isVariableDeclaration(d) &&
        d.initializer !== undefined &&
        allAsync.has(d.initializer)
      ) {
        return true
      }
    }
    return false
  }
  for (const sf of targets) {
    const visit = (n: ts.Node): void => {
      const arg =
        ts.isTypeReferenceNode(n) &&
        ts.isIdentifier(n.typeName) &&
        n.typeName.text === 'ReturnType' &&
        n.typeArguments?.length === 1
          ? n.typeArguments[0]
          : undefined
      if (
        arg !== undefined &&
        ts.isTypeReferenceNode(n) &&
        ts.isTypeQueryNode(arg) &&
        ts.isIdentifier(arg.exprName) &&
        declaresAnAsyncFn(checker.getSymbolAtLocation(arg.exprName))
      ) {
        const forFile = awaitedTypeRefs.get(sf) ?? []
        awaitedTypeRefs.set(sf, forFile)
        forFile.push(n)
      }
      ts.forEachChild(n, visit)
    }
    ts.forEachChild(sf, visit)
  }

  // --- emit -------------------------------------------------------------
  const spans: { file: string; key: string; start: number; end: number }[] = []
  const edited: string[] = []
  let sites = 0
  const files =
    opts.pass === 'awaits'
      ? new Set([...awaitSites.keys(), ...asyncSites.keys(), ...awaitedTypeRefs.keys()])
      : opts.pass === 'rename'
        ? new Set(targets.filter(hasConstruction))
        : new Set<ts.SourceFile>()
  for (const sf of files) {
    const text = sf.getFullText()
    const edits: Edit[] = []
    for (const call of awaitSites.get(sf) ?? []) {
      sites++
      const start = call.getStart(sf)
      if (parenSites.has(call)) {
        // `foo()` newline `(await bar()).baz()` is one call expression to the
        // JavaScript parser. The repo writes semicolons only where they are
        // needed, so this is one of the places they are needed.
        const lead = startsAStatement(call, sf) ? ';(await ' : '(await '
        edits.push({ start, end: start, text: lead, why: 'await', span: call.getEnd() - start })
        edits.push({ start: call.getEnd(), end: call.getEnd(), text: ')', why: 'await' })
      } else {
        edits.push({ start, end: start, text: 'await ', why: 'await', span: call.getEnd() - start })
      }
    }
    for (const fn of asyncSites.get(sf) ?? []) {
      // `async` goes after `export`/`static`, never before them.
      const mods = (fn as ts.HasModifiers).modifiers
      const lastMod = mods === undefined ? undefined : mods[mods.length - 1]
      const afterMods = lastMod === undefined ? undefined : lastMod.getEnd() + 1
      const at = afterMods ?? (ts.isMethodDeclaration(fn) ? fn.name.getStart(sf) : fn.getStart(sf))
      edits.push({ start: at, end: at, text: 'async ', why: 'async' })
      // An explicit return type is now the resolved type of a promise.
      if (fn.type !== undefined) {
        edits.push({
          start: fn.type.getStart(sf),
          end: fn.type.getStart(sf),
          text: 'Promise<',
          why: 'return type',
        })
        edits.push({
          start: fn.type.getEnd(),
          end: fn.type.getEnd(),
          text: '>',
          why: 'return type',
        })
      }
    }
    if (opts.pass === 'rename') edits.push(...renameConstructions(sf))
    for (const ref of awaitedTypeRefs.get(sf) ?? []) {
      edits.push({
        start: ref.getStart(sf),
        end: ref.getStart(sf),
        text: 'Awaited<',
        why: 'awaited type',
      })
      edits.push({ start: ref.getEnd(), end: ref.getEnd(), text: '>', why: 'awaited type' })
    }
    if (opts.apply) {
      // A deletion can swallow an edit inside it (renaming the construction in a
      // local wrapper that is itself being removed). Drop the contained edits,
      // then refuse any pair that still overlaps rather than corrupting the file.
      const deletions = edits.filter((e) => e.end > e.start && e.text === '')
      const kept = edits.filter((e) => {
        if (e.start === e.end) {
          // An insertion anchored inside a range that is going away (the helper
          // import anchored on the `SessionStore` import being dropped) moves to
          // where that range started rather than vanishing with it.
          const host = deletions.find((d) => e.start > d.start && e.start <= d.end)
          if (host !== undefined) {
            e.start = host.start
            e.end = host.start
          }
          return true
        }
        return !deletions.some((d) => d !== e && e.start >= d.start && e.end <= d.end)
      })
      // Descending, so each application leaves earlier offsets untouched. At one
      // offset the LAST applied ends up leftmost, so the widest expression sorts
      // last and wraps the narrower ones.
      kept.sort((a, b) => b.start - a.start || b.end - a.end || (a.span ?? 0) - (b.span ?? 0))
      for (let i = 1; i < kept.length; i++) {
        const here = kept[i]
        const before = kept[i - 1]
        if (here === undefined || before === undefined) continue
        if (here.end > before.start) {
          throw new Error(
            `overlapping edits in ${rel(sf.fileName)} at ${here.start}: ` +
              `${here.why} vs ${before.why}`,
          )
        }
      }
      let out = text
      for (const e of kept) out = out.slice(0, e.start) + e.text + out.slice(e.end)
      writeFileSync(sf.fileName, out)

      // Where each newly-async function ENDS UP, so a compiler error in the
      // edited file can be traced back to the function whose `async` caused it.
      if (opts.spansPath !== undefined) {
        const ascending = [...kept].sort((a, b) => a.start - b.start)
        const shift = (offset: number): number => {
          let delta = 0
          for (const e of ascending) {
            if (e.start >= offset) break
            delta += e.text.length - (e.end - e.start)
          }
          return offset + delta
        }
        for (const fn of asyncSites.get(sf) ?? []) {
          spans.push({
            file: rel(sf.fileName),
            key: fnKey(fn),
            start: shift(fn.getStart(sf)),
            end: shift(fn.getEnd()),
          })
        }
      }
    }
    // Only a file this run actually CHANGES. A file can reach here with every
    // edit dropped — already awaited, or reverted by the backward propagation —
    // and counting it made `files=45` the headline of a run that touched
    // nothing, which is the reading the idempotence check exists to prevent.
    if (edits.length > 0) edited.push(rel(sf.fileName))
  }
  const seen = new Set<string>()
  const unique = refusals.filter((r) => {
    const k = `${r.file}:${r.line}:${r.reason}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (opts.spansPath !== undefined) writeFileSync(opts.spansPath, JSON.stringify(spans))
  const unusedKeepSync = [...(opts.keepSync ?? [])].filter((k) => !keepSyncUsed.has(k)).sort()
  return { edited, refusals: unique, sites, unusedKeepSync }
}

/**
 * `new SessionStore(` -> `openTestStore(` plus the import bookkeeping. Runs for
 * every file with a construction, including the twelve that take no `await`.
 */
function hasConstruction(sf: ts.SourceFile): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'SessionStore'
    ) {
      found = true
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  return found
}

function renameConstructions(sf: ts.SourceFile): Edit[] {
  const edits: Edit[] = []
  const found: ts.NewExpression[] = []
  const visit = (n: ts.Node): void => {
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'SessionStore'
    ) {
      found.push(n)
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  if (found.length === 0) return edits
  for (const n of found) {
    edits.push({
      start: n.getStart(sf),
      end: n.expression.getEnd(),
      text: 'openTestStore',
      why: 'rename',
    })
  }

  // A file that had already written its own `openTestStore` wrapper loses it to
  // the shared one — otherwise the import collides with the local binding.
  const localWrapper = sf.statements.find(
    (s): s is ts.VariableStatement =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some(
        (d) =>
          ts.isIdentifier(d.name) &&
          d.name.text === 'openTestStore' &&
          d.initializer !== undefined &&
          found.some((n) => n.getStart(sf) > d.getStart(sf) && n.getEnd() <= d.getEnd()),
      ),
  )
  if (localWrapper !== undefined) {
    edits.push({
      start: localWrapper.getFullStart(),
      end: localWrapper.getEnd(),
      text: '',
      why: 'drop local wrapper',
    })
  }

  // `SessionStore` may still be needed as a type; drop the specifier only when
  // every remaining mention is the import itself.
  let stillUsed = false
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'SessionStore') {
      const p = n.parent
      const isConstructed = ts.isNewExpression(p) && p.expression === n
      const isSpecifier = ts.isImportSpecifier(p)
      if (!isConstructed && !isSpecifier) stillUsed = true
    }
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(sf, walk)

  let lastImport: ts.ImportDeclaration | undefined
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    lastImport = stmt
    if (stillUsed) continue
    const bindings = stmt.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    const specs = bindings.elements
    const target = specs.find((s) => s.name.text === 'SessionStore')
    if (target === undefined) continue
    if (specs.length === 1 && stmt.importClause?.name === undefined) {
      edits.push({ start: stmt.getFullStart(), end: stmt.getEnd(), text: '', why: 'drop import' })
    } else {
      const idx = specs.indexOf(target)
      const prev = specs[idx - 1]
      const next = specs[idx + 1]
      const start = idx === 0 || prev === undefined ? target.getStart(sf) : prev.getEnd()
      const end = idx === 0 && next !== undefined ? next.getStart(sf) : target.getEnd()
      edits.push({ start, end, text: '', why: 'drop specifier' })
    }
  }

  const hasHelperImport = sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text.endsWith('test-support/open-test-store'),
  )
  if (!hasHelperImport) {
    let spec = relative(
      dirname(sf.fileName),
      join(ROOT, 'apps/server/src/test-support/open-test-store'),
    )
    if (!spec.startsWith('.')) spec = `./${spec}`
    const at = lastImport === undefined ? 0 : lastImport.getEnd()
    edits.push({
      start: at,
      end: at,
      text: `\nimport { openTestStore } from '${spec}'`,
      why: 'add import',
    })
  }
  return edits
}

/**
 * The refusal report: every site the pass would not touch, with its category.
 *
 * Grouped by category first and file second, because at the flip the question is
 * "what kind of decision is this" before it is "where". POD-3262 produced this
 * report and did not keep it, so two reviewers have since re-derived the same
 * refusals from scratch and filed them as missing work.
 */
export function renderReport(refusals: Refusal[]): string {
  const byCategory = new Map<RefusalCategory, Refusal[]>()
  for (const x of refusals) {
    const c = categorize(x.reason)
    const list = byCategory.get(c)
    if (list === undefined) byCategory.set(c, [x])
    else list.push(x)
  }
  const lines: string[] = [
    `# Await pass refusals — ${refusals.length} sites`,
    '',
    'Generated by `bun scripts/awaitify.ts --pass=awaits',
    '--keep-sync=scripts/awaitify-keep-sync.txt --report=<path>`. Line numbers are',
    'pinned to the commit it was generated at and go stale as tests move; the',
    'CATEGORIES do not. Regenerate rather than hand-edit.',
    '',
  ]
  for (const [category, xs] of [...byCategory].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${category} (${xs.length})`, '')
    const byFile = new Map<string, Refusal[]>()
    for (const x of xs) {
      const list = byFile.get(x.file)
      if (list === undefined) byFile.set(x.file, [x])
      else list.push(x)
    }
    for (const [file, ys] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`### ${file} (${ys.length})`)
      for (const y of [...ys].sort((a, b) => a.line - b.line)) {
        lines.push(`- L${y.line} — ${y.reason}`)
        lines.push(`  \`${y.snippet}\``)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * Read a keep-sync set from the checked-in file.
 *
 * The file the pass consumes is also the file a human reads at the flip, so each
 * line is `<file>|<offset>` followed by ` # <category>: <reason>`. Everything
 * from the first `#` is commentary; a line that is only commentary is a heading.
 * Without the reason a reader gets 305 coordinates and no way to answer "why was
 * this skipped", which is the question each entry becomes at the flip.
 */
export function readKeepSync(path: string): Set<string> {
  const keys = new Set<string>()
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const key = (raw.split('#')[0] ?? '').trim()
    if (key.length > 0) keys.add(key)
  }
  return keys
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const pass = (args.find((a) => a.startsWith('--pass='))?.slice(7) ?? 'rename') as
    | 'rename'
    | 'awaits'
  const apply = args.includes('--apply')
  const config =
    args.find((a) => a.startsWith('--project='))?.slice(10) ??
    join(ROOT, 'apps/server/tsconfig.json')
  const keepSyncPath = args.find((a) => a.startsWith('--keep-sync='))?.slice(12)
  const keepSync = keepSyncPath === undefined ? undefined : readKeepSync(keepSyncPath)
  const spansPath = args.find((a) => a.startsWith('--spans='))?.slice(8)
  const r = run({ pass, apply, configPath: config, keepSync, spansPath })
  console.log(`pass=${pass} apply=${apply} awaited=${r.sites} files=${r.edited.length}`)
  console.log(`refusals=${r.refusals.length} unused-keep-sync=${r.unusedKeepSync.length}`)
  const tally = new Map<RefusalCategory, number>()
  for (const x of r.refusals) {
    const c = categorize(x.reason)
    tally.set(c, (tally.get(c) ?? 0) + 1)
  }
  for (const [c, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${c}`)
  for (const k of r.unusedKeepSync) console.log(`  UNUSED ${k}`)
  for (const x of r.refusals) console.log(`  ${x.file}:${x.line}  ${x.reason}\n      ${x.snippet}`)
  const reportPath = args.find((a) => a.startsWith('--report='))?.slice(9)
  if (reportPath !== undefined) {
    writeFileSync(reportPath, renderReport(r.refusals))
  }
}

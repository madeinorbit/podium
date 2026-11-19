/**
 * THE HIDDEN-READ INVENTORY (POD-3256 [B0.1], POD-3372; epic POD-3221, spec §3.6).
 *
 * Run:
 *   bun run audit:hidden-reads           # the gate — exit 1 on any shipping finding
 *   bun run audit:hidden-reads --probe   # prove every check can say YES, and stay quiet
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REPORTS
 * ---------------------------------------------------------------------------
 *
 * Every store call that RUNS when a constructor or a getter under
 * `apps/server/src` runs. Spec §3.6 moves those into `static create()` factories
 * and explicit hydrate steps while the store is still synchronous, because at the
 * flip a read becomes a promise and a constructor cannot await.
 *
 * Two things make it a mechanism check rather than a spelling check:
 *
 *  - A call is resolved through the type checker to the callable's body, never
 *    classified merely by its import or module home. Bodies that reach a query
 *    surface count; pure helpers and listener setters do not. Renaming a
 *    repository method or aliasing the store cannot hide its query.
 *  - The walk is TRANSITIVE through helpers called on `this` and through
 *    same-module functions, because `get rows() { this.hydrate() }` is a hidden
 *    read even though the getter names no repository. It is NOT transitive
 *    through `new`: a constructor that constructs another object is composition,
 *    and the constructed class's own constructor is scanned as its own site.
 *
 * The walk stops at every nested function boundary, so a lambda DEFINED in a
 * constructor and called later is not reported: that is the sync-predicate
 * category (spec §2.5 item 4, issue B0.6), not this one.
 *
 * ---------------------------------------------------------------------------
 * WHY {@link calleeDeclarations} RESOLVES THE ALIAS — POD-3372
 * ---------------------------------------------------------------------------
 *
 * `checker.getSymbolAtLocation` on an imported identifier returns the ALIAS
 * symbol, whose only declaration is the `import { … }` specifier — a node in the
 * IMPORTING file. Classifying by that declaration classifies by where the import
 * statement sits, not by where the function lives, and it is wrong in both
 * directions:
 *
 *   FLOOD. Every repository constructor calls `legacyHandle(executor)`, which
 *   obtains the compatibility handle and issues no statement. `legacyHandle` is
 *   declared in `store/executor/`, which {@link NOT_STORE_PATHS} excludes — but
 *   the import specifier sits in `store/<repository>.ts`, which is a store path.
 *   So all 32 of them were reported as shipping database reads at 2b4c7a607, and
 *   an inventory that is 32/33 false is one people stop reading.
 *
 *   LOSS. The same mistake in reverse: a genuine repository function imported
 *   into a file OUTSIDE the store — a module service, the relay — is classified
 *   by that non-store import specifier and silently dropped. That is the
 *   dangerous half, and it is the half a shorter fix (excluding `legacyHandle`
 *   by name) would have left in place while making the count zero.
 *
 * {@link calleeDeclarations} therefore follows `getAliasedSymbol` to the end of
 * the re-export chain, so classification always reads the declaration site.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT SEE, SAID OUT LOUD
 * ---------------------------------------------------------------------------
 *
 * Two categories are not "clean" and are not filtered away: they are counted and
 * printed on every run.
 *
 *  - `SessionStore`'s own constructor ({@link OUT_OF_SCOPE}) — B1 converted
 *    those boot reads to `SessionStore.open()`. The constructor is still
 *    scanned so a new eager read fails here rather than as shipping.
 *  - {@link REGISTRATIONS} — repository members that issue no statement, named
 *    one by one with the reason rather than inferred, so a member that grows a
 *    query falls back into the report.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * "No hidden read in shipping code" is an ABSENCE claim, and an absence is
 * exactly what a broken instrument reports. `--probe` runs {@link analyze} over
 * a planted in-memory fixture and fails if a hidden read is not found, then over
 * the clean shape and fails if it fires anyway. Both halves: a scan that fires on
 * everything is as useless as one that fires on nothing. The probe runs FIRST,
 * always, even without the flag.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

/** How a call's declaration site is classified. */
type Classification = {
  /** Where persistence lives. A call declared here is a database call. */
  readonly storePaths: readonly string[]
  /** Inside a store path but not a database call. */
  readonly notStorePaths: readonly string[]
  /** `<declaring file>#<member>` -> why that member issues no statement. */
  readonly registrations: ReadonlyMap<string, string>
  /** Reported in its own section rather than as shipping code. */
  readonly outOfScope: readonly string[]
  /** Only constructors and getters under these paths are scanned. */
  readonly roots: readonly string[]
}

const CLASSIFICATION: Classification = {
  storePaths: [
    'apps/server/src/store/',
    'apps/server/src/modules/operations/store.ts',
    'packages/sync/src/adapters/sqlite/',
  ],
  /**
   * The write-announcement bus, and the executor's own handle accessor, error
   * classes and scheduler plumbing. `store/executor/` is where `legacyHandle`
   * lives: it reads `executor.legacy` and returns it, or throws, and issues no
   * statement (`store/executor/executor.ts`, checked 2026-09-04).
   */
  notStorePaths: ['apps/server/src/store/table-writes.ts', 'apps/server/src/store/executor/'],
  /**
   * Repository members that issue NO statement — they install a listener on the
   * repository object and return. Named one by one, with the reason, rather than
   * inferred: the body scan takes precedence over this label, so a repository
   * method that grows a query falls back into the shipping report.
   * Checked against the body at 2026-09-04: `EventsRepository.onAppend` is
   * `this.appendListener = listener`.
   */
  registrations: new Map([
    [
      'apps/server/src/store/events.ts#onAppend',
      'assigns the append listener; issues no statement',
    ],
  ]),
  /**
   * `SessionStore`'s own constructor was the boot step the flip (B1) converted
   * to `SessionStore.open()`, and store.ts is the coordinator's file. Reported
   * separately so a new constructor read is visible rather than filtered away.
   */
  outOfScope: ['apps/server/src/store.ts'],
  roots: ['apps/server/src/'],
}

type Finding = {
  file: string
  line: number
  holder: string
  kind: 'constructor' | 'getter'
  call: string
  via: string[]
  /** Set when the callee issues no statement — see {@link Classification.registrations}. */
  registration?: string
}

const toPosix = (p: string) => p.split(path.sep).join('/')
const under = (f: string, dirs: readonly string[]) => dirs.some((d) => f === d || f.startsWith(d))

const isFunctionBoundary = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isAccessor(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isClassLike(n)

/** Walk a body, stopping at every nested function boundary. */
function walkEager(node: ts.Node, visit: (n: ts.Node) => void): void {
  node.forEachChild((child) => {
    if (isFunctionBoundary(child)) return
    visit(child)
    walkEager(child, visit)
  })
}

type Body =
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression

/**
 * Scan a program's constructors and getters for store calls that run eagerly.
 *
 * @param repoRoot absolute path the reported file names are relative to.
 */
export function analyze(
  program: ts.Program,
  repoRoot: string,
  config: Classification = CLASSIFICATION,
): Finding[] {
  const checker = program.getTypeChecker()
  const rel = (f: string) => toPosix(path.relative(repoRoot, f))
  const isStoreDeclaration = (fileName: string) => {
    const r = rel(fileName)
    return under(r, config.storePaths) && !under(r, config.notStorePaths)
  }

  /**
   * The declarations a call expression's callee resolves to, following import
   * and re-export aliases to the declaration site — see the alias note above.
   */
  const calleeDeclarations = (node: ts.CallExpression): readonly ts.Declaration[] => {
    const target = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name
      : node.expression
    const symbol = checker.getSymbolAtLocation(target)
    if (!symbol) return []
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    return resolved.declarations ?? []
  }

  /** Is this call a helper of the same object (`this.x()`) or a same-module function? */
  const localHelperBody = (node: ts.CallExpression, from: ts.SourceFile): Body | undefined => {
    const expr = node.expression
    const sameObject =
      ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword
    const bareCall = ts.isIdentifier(expr)
    if (!sameObject && !bareCall) return undefined
    for (const decl of calleeDeclarations(node)) {
      if (ts.isMethodDeclaration(decl) || ts.isFunctionDeclaration(decl)) {
        if (bareCall && decl.getSourceFile() !== from) continue
        if (decl.body) return decl
      }
    }
    return undefined
  }

  const holderName = (node: ts.Node) =>
    ts.isClassLike(node.parent) ? (node.parent.name?.text ?? '<anonymous class>') : '<unknown>'

  // Persistence is a module home, not evidence that a call queries anything.
  // Follow callable bodies to the query surface; a listener setter and a pure
  // dialect choice remain pure, even when declared beside repository methods.
  const queryDefinitions = new Set([
    'prepared',
    'preparedFamily',
    'preparedGlobal',
    'preparedAcross',
    'dialectPrepared',
    'inWorkspace',
  ])
  const queryMethods = new Set(['all', 'get', 'run', 'execute', 'query', 'batch', 'prepare'])
  const bodyOf = (decl: ts.Declaration): ts.Node | undefined => {
    if (ts.isFunctionLike(decl) && 'body' in decl) return decl.body
    if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) {
      const value = decl.initializer
      return value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
        ? value.body
        : value
    }
    return undefined
  }
  const declarationName = (decl: ts.Declaration): string =>
    'name' in decl && decl.name && ts.isIdentifier(decl.name as ts.Node)
      ? (decl.name as ts.Identifier).text
      : ''
  const querySurface = (decl: ts.Declaration): boolean => {
    const file = toPosix(decl.getSourceFile().fileName)
    const name = declarationName(decl)
    if (queryDefinitions.has(name))
      return /\/(?:store\/executor|sync\/src\/adapters|identity\/src)\//.test(file)
    return (
      queryMethods.has(name) &&
      (file.includes('/node_modules/drizzle-orm/') ||
        /\/packages\/runtime\/src\/sqlite\//.test(file) ||
        /\/apps\/server\/src\/store\/executor\/(?:driver|sync-drizzle)\.ts$/.test(file) ||
        /\/packages\/sync\/src\/adapters\/(?:sqlite|pg)\//.test(file))
    )
  }
  const reading = new Map<ts.Declaration, boolean>()
  const readsStore = (decl: ts.Declaration, seen = new Set<ts.Declaration>()): boolean => {
    if (querySurface(decl)) return true
    const cached = reading.get(decl)
    if (cached !== undefined) return cached
    if (seen.has(decl)) return false
    const file = rel(decl.getSourceFile().fileName)
    if (!file.startsWith('apps/server/src/') && !file.startsWith('packages/')) return false
    const body = bodyOf(decl)
    if (!body) return false
    const next = new Set(seen).add(decl)
    let found = false
    const inspect = (node: ts.Node) => {
      if (found || !ts.isCallExpression(node)) return
      found = calleeDeclarations(node).some((callee) => readsStore(callee, next))
    }
    inspect(body)
    walkEager(body, inspect)
    // A positive answer is safe to reuse even through a cycle. A negative
    // answer from a recursive path must not hide another path to a query.
    if (found || seen.size === 0) reading.set(decl, found)
    return found
  }

  const findings: Finding[] = []

  const scanBody = (
    body: Body,
    holder: ts.ConstructorDeclaration | ts.GetAccessorDeclaration,
    kind: 'constructor' | 'getter',
    sourceFile: ts.SourceFile,
    via: string[],
    seen: Set<ts.Node>,
  ): void => {
    if (!body.body || seen.has(body)) return
    seen.add(body)
    walkEager(body.body, (node) => {
      if (!ts.isCallExpression(node)) return
      const decls = calleeDeclarations(node)
      const storeDecl = decls.find(
        (d) =>
          isStoreDeclaration(d.getSourceFile().fileName) ||
          (readsStore(d) && !localHelperBody(node, sourceFile)),
      )
      if (storeDecl) {
        const file = node.getSourceFile()
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        const member = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : node.expression.getText(file)
        const queries = readsStore(storeDecl)
        const registration =
          !queries &&
          config.registrations.get(`${rel(storeDecl.getSourceFile().fileName)}#${member}`)
        if (!queries && !registration) return
        findings.push({
          file: rel(file.fileName),
          line: line + 1,
          holder: holderName(holder),
          kind,
          call: node.expression.getText(file).replace(/\s+/g, ' '),
          via,
          ...(registration ? { registration } : {}),
        })
        return
      }
      const helper = localHelperBody(node, sourceFile)
      if (helper) {
        scanBody(
          helper,
          holder,
          kind,
          sourceFile,
          [...via, node.expression.getText(sourceFile)],
          seen,
        )
      }
    })
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    if (!under(rel(sourceFile.fileName), config.roots)) continue
    const visit = (node: ts.Node): void => {
      if (ts.isConstructorDeclaration(node))
        scanBody(node, node, 'constructor', sourceFile, [], new Set())
      if (ts.isGetAccessorDeclaration(node))
        scanBody(node, node, 'getter', sourceFile, [], new Set())
      node.forEachChild(visit)
    }
    visit(sourceFile)
  }
  return findings
}

type Buckets = {
  shipping: Finding[]
  boot: Finding[]
  registrations: Finding[]
  tests: Finding[]
}

const isTest = (f: Finding) => /\.test\.ts$|test-support|\/testing\//.test(f.file)

function bucket(findings: Finding[], config: Classification = CLASSIFICATION): Buckets {
  const outOfScope = (f: Finding) => under(f.file, config.outOfScope)
  return {
    registrations: findings.filter((f) => f.registration),
    shipping: findings.filter((f) => !isTest(f) && !outOfScope(f) && !f.registration),
    boot: findings.filter((f) => !isTest(f) && outOfScope(f) && !f.registration),
    tests: findings.filter((f) => isTest(f) && !f.registration),
  }
}

// ---------------------------------------------------------------------------
// The probe — the scan must be able to say YES, and to stay quiet
// ---------------------------------------------------------------------------

/**
 * The fixture. Every path is virtual, and it is the PATHS that make the
 * classification: `store/` is persistence, `store/executor/` is not, and
 * `modules/` is a caller outside the store.
 */
const FIXTURE: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/executor/executor.ts',
    `export function legacyHandle(e: { readonly legacy: number | undefined }): number {
       if (!e.legacy) throw new Error('no legacy handle')
       return e.legacy
     }`,
  ],
  [
    'apps/server/src/store/executor/driver.ts',
    `export declare const db: { get(sql: string): number }`,
  ],
  // A re-export, because that is how the repositories reach it: two alias hops.
  ['apps/server/src/store/executor/index.ts', `export { legacyHandle } from './executor'`],
  [
    'apps/server/src/store/probe-repo.ts',
    `import { legacyHandle } from './executor'
     import { db } from './executor/driver'
     export function probeRead(): number { return db.get('SELECT 1') }
     export function pureChoice(): number { return 1 }
     export function nowReading(): number { return db.get('SELECT 2') }
     export function registeredRead(): number { return db.get('SELECT 3') }
     export function onProbeAppend(): number { return 2 }
     /** The shape of all 32: a NON-store function imported INTO a store file. */
     export class CleanRepo {
       readonly db: number
       constructor(e: { readonly legacy: number | undefined }) { this.db = legacyHandle(e) }
     }
     /** A member the registrations map names: no statement, own section. */
     export class PureUser {
       constructor() { pureChoice() }
     }
     export class ChangedPureUser {
       constructor() { nowReading() }
     }
     export class ChangedRegistrarUser {
       constructor() { registeredRead() }
     }
     export class RegistrarUser {
       readonly n: number
       constructor() { this.n = onProbeAppend() }
     }`,
  ],
  [
    'apps/server/src/modules/probe-service.ts',
    `import { probeRead } from '../store/probe-repo'
     /** The site the alias bug LOST: a store function imported into a non-store file. */
     export class PlantedService {
       readonly n: number
       constructor() { this.n = probeRead() }
     }
     /** A getter whose read is one hop away through a helper on \`this\`. */
     export class LazyService {
       private v = 0
       get rows(): number { this.hydrate(); return this.v }
       private hydrate(): void { this.v = probeRead() }
     }`,
  ],
])

const PROBE_CONFIG: Classification = {
  storePaths: ['apps/server/src/store/'],
  notStorePaths: ['apps/server/src/store/executor/'],
  registrations: new Map([
    ['apps/server/src/store/probe-repo.ts#onProbeAppend', 'planted registration'],
    ['apps/server/src/store/probe-repo.ts#registeredRead', 'registration that gained a query'],
  ]),
  outOfScope: [],
  roots: ['apps/server/src/'],
}

const PROBE_ROOT = '/probe'

function probeProgram(): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    noLib: false,
  }
  const abs = (p: string) => `${PROBE_ROOT}/${p}`
  const source = (fileName: string) => FIXTURE.get(toPosix(path.relative(PROBE_ROOT, fileName)))
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text =
        source(fileName) ?? (ts.sys.fileExists(fileName) ? ts.sys.readFile(fileName) : undefined)
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true)
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => {},
    getCurrentDirectory: () => PROBE_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => source(fileName) !== undefined || ts.sys.fileExists(fileName),
    readFile: (fileName) => source(fileName) ?? ts.sys.readFile(fileName),
  }
  return ts.createProgram([...FIXTURE.keys()].map(abs), options, host)
}

/** @returns the reasons the instrument is broken; empty means it works. */
export function probe(): string[] {
  const broken: string[] = []
  const program = probeProgram()
  const syntactic = program.getSyntacticDiagnostics()
  if (syntactic.length > 0) {
    return [
      `the probe fixture does not parse: ${ts.flattenDiagnosticMessageText(syntactic[0]?.messageText, ' ')}`,
    ]
  }
  const found = bucket(analyze(program, PROBE_ROOT, PROBE_CONFIG), PROBE_CONFIG)
  const at = (rows: Finding[], file: string, holder: string) =>
    rows.some((f) => f.file === file && f.holder === holder)

  // YES: a store call reached from a constructor in a file OUTSIDE the store —
  // the site the alias bug dropped. This is the half an exclusion list cannot buy.
  if (!at(found.shipping, 'apps/server/src/modules/probe-service.ts', 'PlantedService')) {
    broken.push('did not find a planted store read in a constructor outside the store directory')
  }
  // YES: a getter whose read is one transitive hop away through `this`.
  if (
    !found.shipping.some(
      (f) => f.kind === 'getter' && f.holder === 'LazyService' && f.via.length > 0,
    )
  ) {
    broken.push('did not find a planted transitive store read behind a getter')
  }
  // QUIET: the shape of all 32 — a non-store function imported into a store file.
  if (at(found.shipping, 'apps/server/src/store/probe-repo.ts', 'CleanRepo')) {
    broken.push('fired on a handle accessor declared outside the persistence paths')
  }
  // A named registration is counted in its own section, never as shipping.
  if (at(found.shipping, 'apps/server/src/store/probe-repo.ts', 'RegistrarUser')) {
    broken.push('reported a named registration as a shipping finding')
  }
  if (!found.registrations.some((f) => f.holder === 'RegistrarUser')) {
    broken.push('lost a named registration instead of counting it')
  }
  if (at(found.shipping, 'apps/server/src/store/probe-repo.ts', 'PureUser'))
    broken.push('reported a pure function as a store read')
  for (const holder of ['ChangedPureUser', 'ChangedRegistrarUser'])
    if (!at(found.shipping, 'apps/server/src/store/probe-repo.ts', holder))
      broken.push(`lost the query added to ${holder}`)
  return broken
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const render = (rows: Finding[]) =>
  rows
    .map(
      (f) =>
        `${f.file}:${f.line}  ${f.kind} ${f.holder}${f.via.length ? ` (via ${f.via.join(' -> ')})` : ''}  ->  ${f.call}`,
    )
    .join('\n')

/** Run the scan over this checkout, bucketed. */
export function scanCheckout(): Buckets {
  const repoRoot = process.cwd()
  const project = path.join(repoRoot, 'apps/server/tsconfig.json')
  const configFile = ts.readConfigFile(project, (p) => readFileSync(p, 'utf8'))
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(project))
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  return bucket(analyze(program, repoRoot))
}

function main(): void {
  const broken = probe()
  if (broken.length > 0) {
    console.error('THE SCAN IS BROKEN — its own probe failed:')
    for (const reason of broken) console.error(`  ${reason}`)
    process.exit(2)
  }
  if (process.argv.includes('--probe')) {
    console.log(
      `probe: the scan finds what it hunts and stays quiet otherwise (${FIXTURE.size} fixture files)`,
    )
    return
  }

  const { shipping, boot, registrations, tests } = scanCheckout()

  console.log('# Store calls that run when a constructor or getter runs (apps/server/src)')
  console.log(`\n## Shipping code — must be empty (${shipping.length})`)
  console.log(shipping.length ? render(shipping) : '(none)')
  console.log(`\n## SessionStore's own boot, converted to open() by the flip [B1] (${boot.length})`)
  console.log(boot.length ? render(boot) : '(none)')
  console.log(`\n## Listener registrations, no statement issued (${registrations.length})`)
  console.log(
    registrations.length
      ? registrations.map((f) => `${render([f])}   — ${f.registration}`).join('\n')
      : '(none)',
  )
  console.log(`\n## Tests and test support (${tests.length})`)
  console.log(tests.length ? render(tests) : '(none)')

  process.exit(shipping.length === 0 ? 0 : 1)
}

if (import.meta.main) main()

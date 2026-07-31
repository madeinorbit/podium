/**
 * DOES ANY CODE READ THIS DECLARATION? — the detector behind POD-1224.
 *
 * The class, from `docs/agents/rewrite-fanout-ledger.md`:
 *
 *     A DECLARATION WITH NO CONSUMER IS INDISTINGUISHABLE FROM AN ENFORCED ONE.
 *
 * The totality tests prove every contract field is CLASSIFIED. They say nothing
 * about whether any code READS the classification, and they cannot: a
 * declaration with no consumer passes every test a declaration with a consumer
 * passes, because the only difference is in code that does not exist. So the
 * detector cannot live in the declaring module. It has to look at the rest of
 * the repo and ask a question the declaring module cannot ask about itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A GREP, AND WHY THAT MATTERS MORE THAN IT SOUNDS
 * ---------------------------------------------------------------------------
 *
 * POD-1203 measured the obvious implementation failing: matching the bare
 * identifier flagged eight files, ALL of them comments explaining a deletion. A
 * text search cannot tell `policy.roleFloor` from "we removed roleFloor" in a
 * doc comment, from `'roleFloor'` in a string, or from `roleFloor: 'admin'` —
 * which is the DECLARATION, the very thing whose consumer we are looking for. A
 * grep-based gate on this class does not merely have false positives; it passes
 * on exactly the evidence that proves the defect.
 *
 * This resolves references through the TypeScript CHECKER instead. That makes it
 * comment-immune BY CONSTRUCTION rather than by pattern-tuning: comments and
 * string literals are not in the AST as property references, so no amount of
 * prose mentioning a field can produce a read. It also makes it precise across
 * types — a `.note` on an unrelated interface is a different symbol and does not
 * count toward `RedactionPolicy.note`.
 *
 * Three reference positions are distinguished, and the distinction IS the check:
 *
 *   - READ    `contract.policy.roleFloor`, `const { roleFloor } = policy`,
 *             `policy['roleFloor']` — somebody consults the value.
 *   - WRITE   `roleFloor: 'admin'` inside an object literal — somebody DECLARES
 *             the value. Counting these as consumers is the whole defect: every
 *             unread field has dozens of them.
 *   - TYPE    the property signature itself, in the declaring interface.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS A CONSUMER, WHICH IS A JUDGEMENT THIS FILE MAKES EXPLICIT
 * ---------------------------------------------------------------------------
 *
 * A read inside the DECLARING module does not count. `classificationErrors` in
 * `contract.ts` reads `redaction.reviewed` and `policy.rationale`; POD-352 still
 * correctly called `redaction` "declared and read by nothing", because a lint
 * that validates a declaration is not a consumer OF it — it changes no
 * behaviour, it only checks that the author filled the field in. Folding those
 * in would make every field self-consuming and the detector would report zero
 * forever. `lintSelfReads` is reported separately so the distinction stays
 * visible rather than becoming a silent exclusion.
 *
 * A read inside a TEST does not count either, for the same reason one directory
 * over: `expect(c.policy.roleFloor).toBe('admin')` asserts the declaration, and
 * a field asserted by tests and read by nothing else is precisely the shape this
 * issue exists to find. Reported separately as `testReads`.
 *
 * ---------------------------------------------------------------------------
 * THE FALSE-NEGATIVE THIS ALMOST SHIPPED WITH — READ BEFORE TRUSTING A ZERO
 * ---------------------------------------------------------------------------
 *
 * The first working version of this detector reported `CommandPolicy.roleFloor`
 * as having ZERO product reads. That is false: `apps/server/src/modules/
 * settings/authz.ts` reads it to enforce the floor, which is the consumer
 * POD-421 shipped. The cause was module resolution, not the classifier — this
 * worktree has no `node_modules`, so `@podium/model` resolved UP AND OUT into
 * the main checkout at `/home/mgw/src/other/podium`, and `@podium/commands` did
 * not resolve at all. Every cross-package read was therefore invisible, and the
 * detector reported a confident, entirely wrong zero for the whole fleet.
 *
 * That is this class's own failure mode turned on the instrument: a detector
 * that resolves nothing reports "no consumers" in exactly the same words as a
 * detector that looked and found none. So resolution is PINNED here (explicit
 * `paths` over the workspace globs, no ambient `node_modules` lookup) and then
 * ASSERTED — {@link assertInstrumentHealthy} refuses to report at all unless
 * every workspace package resolved inside this repo AND a canary field with a
 * known consumer is observed being consumed. The instrument must say YES about
 * something true before its NO about anything else is worth reading.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

export interface ReadSite {
  readonly file: string
  readonly line: number
}

export interface DeclaredField {
  /** `CommandPolicy.roleFloor` — the owning type and the property. */
  readonly key: string
  /** Repo-relative path of the declaring file. */
  readonly declaredIn: string
  /** Reads outside the declaring module and outside tests. THE consumer count. */
  readonly productReads: readonly ReadSite[]
  /** Reads inside the declaring module — a lint of the declaration, not a consumer. */
  readonly lintSelfReads: readonly ReadSite[]
  /** Reads inside test files — an assertion about the declaration, not a consumer. */
  readonly testReads: readonly ReadSite[]
  /**
   * SHADOWED READS — a property access spelling this field's name whose symbol
   * is NOT this declaration. Reported, never counted, and the reason the gate
   * needs a human in the loop at all.
   *
   * `apps/server/src/modules/fleet/authz.ts` enforces the machine verb through
   * `(policy as { machineVerb?: MachineVerb }).machineVerb`. The cast erases the
   * link to `CommandPolicy.machineVerb`, so the checker sees a read of a fresh
   * anonymous type and the semantic count is zero — a FALSE UNREAD on a field
   * that is genuinely enforced. Nothing about resolution is wrong there; a cast
   * is exactly a statement that the author is leaving the declared type behind.
   *
   * A silent false negative on this class is the worst outcome available: it
   * retires a control that was working. So a name collision anywhere in the repo
   * surfaces the field for review instead of letting a zero stand unexamined.
   */
  readonly shadowedReads: readonly ReadSite[]
}

const isTestFile = (f: string): boolean => /\.test\.tsx?$|\.spec\.tsx?$|^tests\//.test(f)

// ---------------------------------------------------------------------------
// Program construction — hermetic on purpose
// ---------------------------------------------------------------------------

/**
 * Every workspace package specifier mapped to its source file IN THIS CHECKOUT,
 * SUBPATH EXPORTS INCLUDED.
 *
 * Explicit rather than left to node resolution because the ambient lookup walks
 * UP out of a git worktree into whatever checkout happens to own the nearest
 * `node_modules` — see the header. A path map cannot silently do that.
 *
 * The subpaths are not a detail: mapping only the bare package name left
 * `@podium/runtime/instance` and thirteen of its siblings to resolve
 * ambiently, which put 87 files from the neighbouring checkout back into the
 * program. A partial pin is a pin that reports the same confident zero.
 */
export function workspacePaths(repoRoot: string): Record<string, string[]> {
  const globs: string[] =
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).workspaces ?? []
  const out: Record<string, string[]> = {}
  const targetOf = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
      const c = value as Record<string, unknown>
      for (const key of ['@podium/source', 'types', 'import', 'default']) {
        const picked = c[key]
        if (typeof picked === 'string') return picked
      }
    }
    return undefined
  }
  for (const glob of globs) {
    const dir = glob.replace(/\/\*$/, '')
    const listing = execFileSync('ls', ['-1', join(repoRoot, dir)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const entry of listing) {
      const pkgDir = join(repoRoot, dir, entry)
      const pkgJson = join(pkgDir, 'package.json')
      if (!existsSync(pkgJson)) continue
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
        name?: string
        exports?: Record<string, unknown>
      }
      const name = pkg.name
      if (!name) continue
      const add = (specifier: string, relFile: string): void => {
        const abs = join(pkgDir, relFile)
        if (existsSync(abs) && /\.tsx?$/.test(abs)) out[specifier] = [abs]
      }
      for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
        const target = targetOf(value)
        if (!target) continue
        add(subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`, target)
      }
      // Packages that declare no exports map still get their conventional entry.
      if (!out[name]) add(name, 'src/index.ts')
    }
  }
  return out
}

export function repoSourceFiles(repoRoot: string): string[] {
  return execFileSync(
    'git',
    ['ls-files', 'packages', 'apps', 'services', 'scripts', 'tooling', 'tests'],
    { encoding: 'utf8', maxBuffer: 1 << 28, cwd: repoRoot },
  )
    .trim()
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
    .map((f) => join(repoRoot, f))
}

export function createRepoProgram(repoRoot: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ['@podium/source'],
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
    baseUrl: repoRoot,
    paths: workspacePaths(repoRoot),
    types: [],
  }
  return ts.createProgram(repoSourceFiles(repoRoot), options)
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

interface Target {
  readonly key: string
  readonly declaredIn: string
  readonly symbol: ts.Symbol
}

/** Every property signature declared in `declaringFiles`, with its symbol. */
export function declaredFieldsOf(
  program: ts.Program,
  repoRoot: string,
  declaringFiles: readonly string[],
): Target[] {
  const checker = program.getTypeChecker()
  const targets: Target[] = []
  for (const rel of declaringFiles) {
    const sf = program.getSourceFile(join(repoRoot, rel))
    if (!sf) throw new Error(`declared-consumers: declaring file not in program: ${rel}`)
    const visit = (node: ts.Node, enclosing: string | undefined): void => {
      let owner = enclosing
      if (ts.isInterfaceDeclaration(node)) owner = node.name.text
      else if (ts.isTypeAliasDeclaration(node)) owner = node.name.text
      if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name))
            continue
          const symbol = checker.getSymbolAtLocation(member.name)
          // The key is FILE-QUALIFIED because a type name is not unique across
          // the declaring modules: `CommandPolicy` is declared in BOTH
          // `contract.ts` and `framework.ts` with different members. Keying on
          // the bare name merged the two into one row and reported a blended
          // count for neither of them.
          if (symbol)
            targets.push({
              key: `${rel.replace(/^.*\/src\//, '').replace(/\.ts$/, '')} ${owner ?? '(anonymous)'}.${member.name.text}`,
              declaredIn: rel,
              symbol,
            })
        }
      }
      ts.forEachChild(node, (child) => visit(child, owner))
    }
    visit(sf, undefined)
  }
  return targets
}

/**
 * Locate every READ of every target, repo-wide.
 *
 * A read is a property access, a string element access, or an object binding
 * element. A `PropertyAssignment` is deliberately NOT a read — see the header.
 */
export function readSitesOf(
  program: ts.Program,
  repoRoot: string,
  targets: readonly Target[],
): { reads: Map<string, ReadSite[]>; shadowed: Map<string, ReadSite[]> } {
  const checker = program.getTypeChecker()
  const wanted = new Map<ts.Symbol, string>()
  for (const t of targets) wanted.set(t.symbol, t.key)
  /** Property name → the target keys declaring it, for shadow detection. */
  const byName = new Map<string, string[]>()
  for (const t of targets) {
    const prop = t.key.slice(t.key.indexOf('.') + 1)
    byName.set(prop, [...(byName.get(prop) ?? []), t.key])
  }
  const found = new Map<string, ReadSite[]>()
  const shadowed = new Map<string, ReadSite[]>()
  for (const t of targets) {
    if (!found.has(t.key)) found.set(t.key, [])
    if (!shadowed.has(t.key)) shadowed.set(t.key, [])
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    if (!sf.fileName.startsWith(repoRoot)) continue
    const rel = sf.fileName.slice(repoRoot.length + 1)
    if (rel.startsWith('node_modules/')) continue

    const record = (nameNode: ts.Node, text: string): void => {
      const at = (): ReadSite => ({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1,
      })
      const symbol = checker.getSymbolAtLocation(nameNode)
      const key = symbol
        ? (wanted.get(symbol) ??
          (symbol.flags & ts.SymbolFlags.Alias
            ? wanted.get(checker.getAliasedSymbol(symbol))
            : undefined))
        : undefined
      if (key !== undefined) {
        found.get(key)?.push(at())
        return
      }
      // Same spelling, different (or unresolved) symbol — a cast, a structural
      // copy, or an unrelated type. Surfaced for review, never counted.
      for (const candidate of byName.get(text) ?? []) shadowed.get(candidate)?.push(at())
    }

    const walk = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name))
        record(node.name, node.name.text)
      else if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression)
      )
        record(node.argumentExpression, node.argumentExpression.text)
      else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        // `const { roleFloor } = policy` — the binding name resolves to the new
        // LOCAL, not to the property, so asking the checker at that position
        // returns a symbol that matches no target and the read is lost. The
        // property has to come off the type being destructured. Missing this
        // shape means every destructuring consumer reads as unread, which is a
        // false zero in the direction that retires a live control.
        const nameNode = node.propertyName ?? node.name
        if (ts.isIdentifier(nameNode)) {
          const propertyName = nameNode.text
          const symbol = checker.getTypeAtLocation(node.parent).getProperty(propertyName)
          const key = symbol ? wanted.get(symbol) : undefined
          if (key !== undefined) {
            const { line } = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf))
            found.get(key)?.push({ file: rel, line: line + 1 })
          } else record(nameNode, propertyName)
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(sf)
  }
  return { reads: found, shadowed }
}

export function analyse(
  program: ts.Program,
  repoRoot: string,
  declaringFiles: readonly string[],
): DeclaredField[] {
  const targets = declaredFieldsOf(program, repoRoot, declaringFiles)
  const { reads, shadowed } = readSitesOf(program, repoRoot, targets)
  const seen = new Set<string>()
  const out: DeclaredField[] = []
  for (const t of targets) {
    if (seen.has(t.key)) continue
    seen.add(t.key)
    const all = reads.get(t.key) ?? []
    const isProduct = (s: ReadSite): boolean =>
      !declaringFiles.includes(s.file) && !isTestFile(s.file)
    out.push({
      key: t.key,
      declaredIn: t.declaredIn,
      lintSelfReads: all.filter((s) => declaringFiles.includes(s.file)),
      testReads: all.filter((s) => !declaringFiles.includes(s.file) && isTestFile(s.file)),
      productReads: all.filter(isProduct),
      shadowedReads: (shadowed.get(t.key) ?? []).filter(isProduct),
    })
  }
  return out.sort((a, b) => a.declaredIn.localeCompare(b.declaredIn) || a.key.localeCompare(b.key))
}

// ---------------------------------------------------------------------------
// Instrument health — the gate refuses to report a zero it has not earned
// ---------------------------------------------------------------------------

/**
 * A field whose consumer is KNOWN to exist, used as a canary.
 *
 * `roleFloor` is the right choice precisely because it is one of POD-352's
 * original three: it had no consumer, POD-421 shipped one in
 * `apps/server/src/modules/settings/authz.ts`, and that consumer lives in a
 * DIFFERENT PACKAGE from the declaration. So the canary fails the moment
 * cross-package resolution breaks — which is the exact failure this detector
 * shipped with once already.
 */
export const CANARY = {
  key: 'contract CommandPolicy.roleFloor',
  mustBeReadIn: 'apps/server/src/modules/settings/authz.ts',
} as const

export function instrumentFaults(
  program: ts.Program,
  repoRoot: string,
  fields: readonly DeclaredField[],
): string[] {
  const faults: string[] = []

  // 1. No FIRST-PARTY source may resolve outside this checkout.
  //
  // Third-party `node_modules` legitimately live in the neighbouring checkout —
  // this worktree has none of its own, and nothing about a dependency's own
  // sources affects who reads a Podium declaration. The hole this guards is
  // `@podium/model` resolving to another tree's `packages/model/src/index.ts`,
  // which is not under `node_modules` and so is still caught.
  const escaped = program
    .getSourceFiles()
    .filter(
      (f) =>
        !f.isDeclarationFile &&
        !f.fileName.startsWith(repoRoot) &&
        !f.fileName.includes('/node_modules/'),
    )
  if (escaped.length > 0) {
    faults.push(
      `${escaped.length} source file(s) resolved OUTSIDE this checkout, e.g. ${escaped[0]?.fileName}. ` +
        'Resolution has escaped the worktree; every cross-package read is being attributed to another tree.',
    )
  }

  // 2. Every workspace package must have resolved.
  for (const [name, [entry]] of Object.entries(workspacePaths(repoRoot))) {
    if (entry && !program.getSourceFile(entry)) {
      faults.push(
        `workspace package ${name} (${entry}) is not in the program — its readers are invisible.`,
      )
    }
  }

  // 3. The canary must be observed being consumed.
  const canary = fields.find((f) => f.key === CANARY.key)
  if (!canary) {
    faults.push(
      `canary field ${CANARY.key} was not found at all — the declaring file changed shape.`,
    )
  } else if (!canary.productReads.some((s) => s.file === CANARY.mustBeReadIn)) {
    faults.push(
      `canary ${CANARY.key} is not observed being read in ${CANARY.mustBeReadIn}. ` +
        'A known cross-package consumer is invisible, so every zero this run reports is unreliable.',
    )
  }
  return faults
}

export function assertInstrumentHealthy(
  program: ts.Program,
  repoRoot: string,
  fields: readonly DeclaredField[],
): void {
  const faults = instrumentFaults(program, repoRoot, fields)
  if (faults.length === 0) return
  throw new Error(
    'declared-consumers: THE INSTRUMENT IS BROKEN — it cannot be trusted to say NO.\n' +
      faults.map((f) => `  · ${f}`).join('\n'),
  )
}

export function findRepoRoot(from: string = process.cwd()): string {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'turbo.json'))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error('declared-consumers: no repo root above ' + from)
    dir = up
  }
}

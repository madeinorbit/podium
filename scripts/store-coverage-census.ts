#!/usr/bin/env bun
/**
 * The store coverage census, re-derived [POD-3244, POD-3360].
 *
 * `docs/internal/pod-3244-store-coverage-census.md` was measured once by hand and
 * drifted: seven members added after the measurement had no row, and the ledger
 * Stage A is planned from therefore did not describe the code. A hand-maintained
 * count drifts silently, so the inventory half of the census is derived here
 * instead — from the same TypeScript AST rules the document states — and `check`
 * fails when the committed document stops matching the tree.
 *
 * WHAT IS DERIVED HERE AND WHAT IS NOT. The member inventory (which files, which
 * classes, which public members, at which line) and the "named in a test file"
 * heuristic are computed from the source tree, so they can be re-derived in
 * seconds and checked in CI. Whether a member is EXECUTED is a measurement — it
 * needs six instrumented lanes — so it is read back out of the committed
 * document rather than recomputed, and `check` reports a member with no measured
 * verdict as drift. That is the split that matters: a member can appear without
 * anyone re-running coverage, and that is exactly the case this catches.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The tree the census is derived from. Overridable so the derivation can be run
 * against an older checkout and reconciled with what the census recorded there —
 * a derivation that only ever ran against today's tree cannot be shown faithful.
 */
const repoRoot = process.env.CENSUS_REPO_ROOT
  ? resolve(process.env.CENSUS_REPO_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const censusDoc = 'docs/internal/pod-3244-store-coverage-census.md'

/**
 * The document's stated file rules, as globs over the repository root.
 * `store/*.ts` excludes `helpers.ts`, `types.ts` and `issue-storage.ts` (free
 * functions and Zod schemas, no repository class) and every `*.test.ts`.
 *
 * It is a PATH rule and it is one level deep on purpose — `store/spike/` and
 * `store/executor/` are not repositories. The cost is the one thing this file
 * cannot catch for you: a repository class put in a NEW subdirectory of `store/`
 * is outside the census by the census's own definition, and adding it is a
 * deliberate edit here, not something the check will notice.
 */
const excludedStoreFiles = new Set(['helpers.ts', 'types.ts', 'issue-storage.ts'])

function repositoryFiles(): string[] {
  const files: string[] = []
  const push = (p: string) => files.push(relative(repoRoot, p).split('\\').join('/'))
  const dirEntries = (dir: string) =>
    ts.sys
      .readDirectory(join(repoRoot, dir), ['.ts'], undefined, undefined, 1)
      .filter((p) => !p.endsWith('.test.ts'))
      .sort()
  for (const p of dirEntries('apps/server/src/store')) {
    if (excludedStoreFiles.has(p.split('/').pop() ?? '')) continue
    push(p)
  }
  for (const p of dirEntries('apps/server/src/store/conversations')) push(p)
  push(join(repoRoot, 'apps/server/src/modules/operations/store.ts'))
  push(join(repoRoot, 'packages/sync/src/adapters/sqlite/sync-repository.ts'))
  return [...new Set(files)].sort()
}

export type Member = { file: string; className: string; member: string; line: number }

/**
 * Public members carrying a function body, on exported classes: methods,
 * accessors and arrow-function (or function-expression) properties.
 * Constructors, `private`/`protected` and `#private` members are excluded.
 */
function membersOf(file: string): Member[] {
  return membersOfSource(file, readFileSync(join(repoRoot, file), 'utf8'))
}

export function membersOfSource(file: string, text: string): Member[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: Member[] = []
  const isExported = (node: ts.ClassDeclaration) =>
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
  const isHidden = (node: ts.ClassElement) => {
    const flags = ts.getCombinedModifierFlags(node)
    if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return true
    return node.name !== undefined && ts.isPrivateIdentifier(node.name)
  }
  const carriesBody = (node: ts.ClassElement) => {
    if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node))
      return node.body !== undefined
    if (ts.isPropertyDeclaration(node) && node.initializer)
      return ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)
    return false
  }
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name && isExported(node)) {
      for (const element of node.members) {
        if (ts.isConstructorDeclaration(element)) continue
        if (isHidden(element) || !carriesBody(element)) continue
        const name = element.name
        if (!name) continue
        const member =
          ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(source)
        out.push({
          file,
          className: node.name.text,
          member,
          line: source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

let memberCache: Member[] | undefined
export function enumerateMembers(): Member[] {
  if (!memberCache) memberCache = repositoryFiles().flatMap(membersOf)
  return memberCache
}

export const memberKey = (m: { file: string; className: string; member: string }) =>
  `${m.file}|${m.className}|${m.member}`

/** A row of the committed document's full table. */
export type Row = Member & { covered: boolean; covering: string; named: string }

const stripCode = (cell: string) => cell.trim().replace(/^`|`$/g, '')

export function parseCommittedRows(markdown: string): Row[] {
  const rows: Row[] = []
  const fullTable = markdown.slice(markdown.indexOf('\n## Full table'))
  for (const line of fullTable.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cells = line.slice(1, -1).split(' | ')
    if (cells.length !== 7) continue
    const [
      file = '',
      className = '',
      member = '',
      lineNo = '',
      covered = '',
      covering = '',
      named = '',
    ] = cells
    rows.push({
      file: stripCode(file),
      className: className.trim(),
      member: stripCode(member),
      line: Number(lineNo.trim()),
      covered: stripCode(covered).replace(/\*/g, '') === 'yes',
      covering: covering.trim(),
      named: named.trim(),
    })
  }
  return rows
}

/**
 * The store-accessor spelling a test would use to reach a repository class.
 *
 * Derived, not listed: a `this.<prop> = new <Class>(` assignment anywhere in the
 * non-test tree names the accessor the class is reached through. A class can have
 * more than one (the conversation sub-repositories hang off `conversations`), and
 * one with none is reached only by direct construction.
 */
function accessorsByClass(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const file of sourceFiles()) {
    const text = readText(file)
    for (const match of text.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Z][\w$]*)\s*\(/g)) {
      const [, accessor, className] = match
      if (!accessor || !className) continue
      const set = out.get(className) ?? new Set<string>()
      set.add(accessor)
      out.set(className, set)
    }
  }
  return out
}

const sourceRoots = ['apps', 'packages', 'scripts', 'tests', 'services']

/** The scans read the same few thousand files repeatedly; read each one once. */
const textCache = new Map<string, string>()
const readText = (file: string): string => {
  const cached = textCache.get(file)
  if (cached !== undefined) return cached
  const text = readFileSync(join(repoRoot, file), 'utf8')
  textCache.set(file, text)
  return text
}

function walk(dir: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = []
  const visit = (absolute: string) => {
    let entries: string[]
    try {
      entries = ts.sys.readDirectory(
        absolute,
        ['.ts', '.tsx'],
        ['node_modules', 'dist', 'build'],
        undefined,
        1,
      )
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = relative(repoRoot, entry).split('\\').join('/')
      if (predicate(rel)) out.push(rel)
    }
    for (const child of ts.sys.getDirectories(absolute)) {
      if (child === 'node_modules' || child === 'dist' || child === 'build') continue
      visit(join(absolute, child))
    }
  }
  visit(join(repoRoot, dir))
  return out
}

let sourceFileCache: string[] | undefined
function sourceFiles(): string[] {
  if (!sourceFileCache)
    sourceFileCache = sourceRoots
      .flatMap((root) => walk(root, (p) => !p.includes('.test.') && !p.includes('.bench.')))
      .sort()
  return sourceFileCache
}

let testFileCache: string[] | undefined
export function testFiles(): string[] {
  if (!testFileCache)
    testFileCache = sourceRoots.flatMap((root) => walk(root, (p) => p.includes('.test.'))).sort()
  return testFileCache
}

/**
 * The naming heuristic the census reports beside the measurement: a test file
 * NAMES a member when it spells the store-accessor call (`.<accessor>.<member>(`)
 * or constructs the class directly and calls the member somewhere in the file.
 * It is deliberately a text scan — the point of the column is what a reviewer
 * reading the test can SEE, not what the test reaches.
 */
const namedCache = new Map<string, Map<string, string[]>>()
export function namedIn(members: Member[]): Map<string, string[]> {
  const cacheKey = members.map(memberKey).join('\n')
  const cached = namedCache.get(cacheKey)
  if (cached) return cached
  const accessors = accessorsByClass()
  const named = new Map<string, string[]>()
  for (const m of members) named.set(memberKey(m), [])
  const byClass = new Map<string, Member[]>()
  for (const m of members) {
    const list = byClass.get(m.className) ?? []
    list.push(m)
    byClass.set(m.className, list)
  }
  for (const test of testFiles()) {
    const text = readText(test)
    for (const [className, classMembers] of byClass) {
      const constructed = new RegExp(`new\\s+${className}\\s*\\(`).test(text)
      const paths = accessors.get(className) ?? new Set<string>()
      for (const m of classMembers) {
        const member = escapeRegExp(m.member)
        const calls = new RegExp(`\\.${member}\\s*[(<]`).test(text)
        const viaAccessor = [...paths].some((accessor) =>
          new RegExp(`\\.${accessor}\\s*[.!?]+\\s*${member}\\s*[(<]`).test(text),
        )
        if ((constructed && calls) || viaAccessor) named.get(memberKey(m))?.push(test)
      }
    }
  }
  namedCache.set(cacheKey, named)
  return named
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Check the derived naming scan against the column the census recorded, on the
 * rows that did not change. A derivation that has never been reconciled against
 * the measurement it replaces is a guess: this prints the disagreements so they
 * can be read one at a time rather than assumed away.
 */
function reconcileNaming(): number {
  const derived = enumerateMembers()
  const committed = parseCommittedRows(readFileSync(join(repoRoot, censusDoc), 'utf8'))
  const named = namedIn(derived)
  const derivedByKey = new Map(derived.map((m) => [memberKey(m), m]))
  let agree = 0
  const onlyDerived: string[] = []
  const onlyCommitted: string[] = []
  for (const row of committed) {
    if (!derivedByKey.has(memberKey(row))) continue
    const derivedNamed = (named.get(memberKey(row)) ?? []).length > 0
    const committedNamed = row.named !== '\u2014'
    if (derivedNamed === committedNamed) agree += 1
    else if (derivedNamed) onlyDerived.push(`${row.file} ${row.className}.${row.member}`)
    else onlyCommitted.push(`${row.file} ${row.className}.${row.member}`)
  }
  console.log(
    `naming heuristic: ${agree} agree, ${onlyDerived.length} derived-only, ${onlyCommitted.length} committed-only`,
  )
  for (const line of onlyDerived) console.log(`  derived names it, census did not:  ${line}`)
  for (const line of onlyCommitted) console.log(`  census named it, derived did not:  ${line}`)
  return 0
}

/**
 * Fold istanbul JSON reports into a per-member verdict.
 *
 * A member is mapped to its `fnMap` entry by declaration line — the same
 * attribution the census used. As a check on that mapping, statement hits inside
 * the function's range are computed independently and any member the two
 * disagree about is reported rather than silently resolved.
 */
export type LaneCoverage = { lane: string; hit: Set<string>; present: Set<string> }

type IstanbulFile = {
  fnMap: Record<
    string,
    {
      decl: { start: { line: number }; end: { line: number } }
      loc: { start: { line: number }; end: { line: number } }
    }
  >
  f: Record<string, number>
  statementMap: Record<string, { start: { line: number }; end: { line: number } }>
  s: Record<string, number>
}

export function foldLane(lane: string, reportPath: string, members: Member[]): LaneCoverage {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, IstanbulFile>
  const byFile = new Map<string, IstanbulFile>()
  for (const [absolute, data] of Object.entries(report)) {
    const rel = relative(repoRoot, absolute).split('\\').join('/')
    byFile.set(rel, data)
  }
  const hit = new Set<string>()
  const present = new Set<string>()
  const disagreements: string[] = []
  for (const m of members) {
    const data = byFile.get(m.file)
    if (!data) continue
    const entry = Object.entries(data.fnMap).find(([, v]) => v.decl.start.line === m.line)
    if (!entry) continue
    present.add(memberKey(m))
    const byFunction = (data.f[entry[0]] ?? 0) > 0
    const { start, end } = entry[1].loc
    const statements = Object.entries(data.statementMap).filter(
      ([, loc]) => loc.start.line >= start.line && loc.end.line <= end.line,
    )
    const byStatement = statements.some(([id]) => (data.s[id] ?? 0) > 0)
    if (byFunction !== byStatement && statements.length > 0)
      disagreements.push(
        `${m.file} ${m.className}.${m.member}: fn=${byFunction} stmt=${byStatement}`,
      )
    if (byFunction) hit.add(memberKey(m))
  }
  if (disagreements.length > 0) {
    console.error(`lane ${lane}: ${disagreements.length} fn/statement disagreement(s)`)
    for (const line of disagreements) console.error(`  ${line}`)
  }
  return { lane, hit, present }
}

/** The lane labels, in the order the census reports them. */
const laneLabels: Record<string, string> = {
  store: 'server:store',
  services: 'server:services',
  boundary: 'server:boundary',
  contracts: 'server:contracts',
  'normalized-wire': 'server:normalized-wire',
  sync: '@podium/sync',
}

type Measured = Member & {
  lanes: string[]
  files: string[]
  named: string[]
}

function loadMeasurement(coverageRoot: string, members: Member[]): Measured[] {
  const lanes = Object.keys(laneLabels)
    .filter((lane) => ts.sys.fileExists(join(coverageRoot, lane, 'coverage-final.json')))
    .map((lane) => ({
      lane,
      folded: foldLane(lane, join(coverageRoot, lane, 'coverage-final.json'), members),
    }))
  const missing = Object.keys(laneLabels).filter((lane) => !lanes.some((l) => l.lane === lane))
  if (missing.length > 0) throw new Error(`no coverage report for lane(s): ${missing.join(', ')}`)
  const perFileDir = join(coverageRoot, 'per-file')
  const perFile = new Map<string, string[]>()
  if (ts.sys.directoryExists(perFileDir)) {
    for (const slug of ts.sys.getDirectories(perFileDir)) {
      const report = join(perFileDir, slug, 'coverage-final.json')
      const marker = join(perFileDir, slug, 'test-file.txt')
      if (!ts.sys.fileExists(report) || !ts.sys.fileExists(marker)) continue
      const testFile = readFileSync(marker, 'utf8').trim()
      const folded = foldLane(`per-file ${testFile}`, report, members)
      for (const key of folded.hit) perFile.set(key, [...(perFile.get(key) ?? []), testFile])
    }
  }
  // A member no report even KNOWS about is an instrumentation gap, and it would
  // read as "never executed" — the most consequential verdict in the census.
  // Refuse rather than record it: `coverage.all` instruments every included
  // file, so a member missing from every lane means the include list or the
  // line attribution is wrong, not that no test runs it.
  const unseen = members.filter(
    (m) => !lanes.some(({ folded }) => folded.present.has(memberKey(m))),
  )
  if (unseen.length > 0)
    throw new Error(
      `no lane instrumented ${unseen.length} member(s), so their verdict cannot be measured:\n` +
        unseen.map((m) => `  ${m.file}:${m.line} ${m.className}.${m.member}`).join('\n'),
    )
  const named = namedIn(members)
  return members.map((m) => ({
    ...m,
    lanes: lanes
      .filter(({ folded }) => folded.hit.has(memberKey(m)))
      .map(({ lane }) => laneLabels[lane] ?? lane),
    files: (perFile.get(memberKey(m)) ?? []).sort(),
    named: (named.get(memberKey(m)) ?? []).sort(),
  }))
}

const code = (s: string) => `\`${s}\``

function renderCovering(row: Measured): string {
  const otherLanes =
    row.files.length > 0 ? row.lanes.filter((l) => l !== 'server:store') : row.lanes
  const shown = row.files.slice(0, 3).map(code)
  const extra = row.files.length - shown.length
  const head = shown.length > 0 ? `${shown.join(', ')}${extra > 0 ? ` +${extra} more` : ''}` : ''
  if (head && otherLanes.length > 0) return `${head} — also ${otherLanes.join(', ')}`
  if (head) return head
  return otherLanes.length > 0 ? otherLanes.join(', ') : '—'
}

function renderNamed(row: Measured): string {
  if (row.named.length === 0) return '—'
  const shown = row.named.slice(0, 2).map(code)
  const extra = row.named.length - shown.length
  return `${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}`
}

/** Replace the block between `<!-- census:<id> -->` markers. */
function replaceBlock(markdown: string, id: string, body: string): string {
  const open = `<!-- census:${id} -->`
  const close = `<!-- /census:${id} -->`
  const start = markdown.indexOf(open)
  const end = markdown.indexOf(close)
  if (start < 0 || end < 0) throw new Error(`missing marker block ${id} in ${censusDoc}`)
  return `${markdown.slice(0, start + open.length)}\n${body}\n${markdown.slice(end)}`
}

function generate(coverageRoot: string): number {
  const members = enumerateMembers()
  const rows = loadMeasurement(coverageRoot, members)
  const never = rows.filter((r) => r.lanes.length === 0)
  const executedUnnamed = rows.filter((r) => r.lanes.length > 0 && r.named.length === 0)
  const executedNamed = rows.filter((r) => r.lanes.length > 0 && r.named.length > 0)
  const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`

  const headline = [
    '| | Methods | Share |',
    '| --- | ---: | ---: |',
    `| Never executed by any test in any lane | **${never.length}** | ${pct(never.length)} |`,
    `| Executed, but never named in any test file | ${executedUnnamed.length} | ${pct(executedUnnamed.length)} |`,
    `| Executed and named in at least one test file | ${executedNamed.length} | ${pct(executedNamed.length)} |`,
    `| **Total public repository methods** | **${rows.length}** | |`,
  ].join('\n')

  const neverTable = [
    '| Repository file | Class | Method | Line | Named in a test file |',
    '| --- | --- | --- | ---: | --- |',
    ...never.map(
      (r) =>
        `| ${code(r.file)} | ${r.className} | ${code(r.member)} | ${r.line} | ${renderNamed(r)} |`,
    ),
  ].join('\n')

  const files = [...new Set(rows.map((r) => r.file))]
  const perRepository = files
    .map((file) => {
      const own = rows.filter((r) => r.file === file)
      return {
        file,
        total: own.length,
        never: own.filter((r) => r.lanes.length === 0).length,
        unnamed: own.filter((r) => r.lanes.length > 0 && r.named.length === 0).length,
      }
    })
    .sort((a, b) => b.total - a.total || a.file.localeCompare(b.file))
  const perRepositoryTable = [
    '| Repository file | Public methods | Never executed | Executed, never named |',
    '| --- | ---: | ---: | ---: |',
    ...perRepository.map((r) => `| ${code(r.file)} | ${r.total} | ${r.never} | ${r.unnamed} |`),
  ].join('\n')

  const untested = files
    .filter((file) => rows.filter((r) => r.file === file).every((r) => r.named.length === 0))
    .map((file) => {
      const own = rows.filter((r) => r.file === file)
      return `- ${code(file)} — ${own.length} method${own.length === 1 ? '' : 's'}, ${own.filter((r) => r.lanes.length === 0).length} of them never executed`
    })
    .join('\n')

  const largest = perRepository.slice(0, 5)
  const largestSection = largest
    .map(({ file }) => {
      const own = rows.filter((r) => r.file === file)
      const neverOwn = own.filter((r) => r.lanes.length === 0)
      const unnamedOwn = own.filter((r) => r.lanes.length > 0 && r.named.length === 0)
      const list = (ms: Measured[]) =>
        ms.length === 0 ? '*none*' : ms.map((m) => code(m.member)).join(', ')
      return [
        `**${code(file)}** — ${own.length} public methods; ${neverOwn.length} never executed; ${unnamedOwn.length} executed but never named.`,
        '',
        `- Never executed: ${list(neverOwn)}`,
        `- Executed, never named: ${list(unnamedOwn)}`,
      ].join('\n')
    })
    .join('\n\n')

  const fullTable = [
    '| Repository file | Class | Method | Line | Covered | Covering test file(s) / lane(s) | Named in a test file |',
    '| --- | --- | --- | ---: | :-: | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${code(r.file)} | ${r.className} | ${code(r.member)} | ${r.line} | ${r.lanes.length > 0 ? 'yes' : '**no**'} | ${renderCovering(r)} | ${renderNamed(r)} |`,
    ),
  ].join('\n')

  const outsideRefs = never.map((row) => ({
    row,
    unique: nameIsUnique(row, rows),
    refs: nameIsUnique(row, rows) ? referencesOutsideOwnFile(row) : [],
  }))
  const orphans = outsideRefs.filter(({ unique, refs }) => unique && refs.length === 0)
  const noCallerTable = [
    orphans.length === 0
      ? 'Every never-executed member whose name the scan can answer for is named somewhere outside its own file.'
      : `${orphans.length} of the ${never.length} are not thin tests, they are unused code — nothing outside the repository file names them anywhere in \`apps\`, \`packages\`, \`scripts\`, \`tests\` or \`services\`:`,
    '',
    '| Method | Named outside its own file |',
    '| --- | --- |',
    ...outsideRefs.map(({ row, unique, refs }) => {
      const shown = refs.slice(0, 2).map(code)
      const extra = refs.length - shown.length
      const cell = !unique
        ? 'unanswerable by name — another repository declares a member with this name'
        : refs.length === 0
          ? '**none** — the declaration is the only occurrence in the tree'
          : `${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}`
      return `| ${code(`${row.className}.${row.member}`)} | ${cell} |`
    }),
  ].join('\n')

  const path = join(repoRoot, censusDoc)
  let markdown = readFileSync(path, 'utf8')
  markdown = replaceBlock(markdown, 'headline', headline)
  markdown = replaceBlock(markdown, 'never-executed', neverTable)
  markdown = replaceBlock(markdown, 'no-caller', noCallerTable)
  markdown = replaceBlock(markdown, 'per-repository', perRepositoryTable)
  markdown = replaceBlock(markdown, 'unnamed-repositories', untested)
  markdown = replaceBlock(markdown, 'largest-repositories', largestSection)
  markdown = replaceBlock(markdown, 'full-table', fullTable)
  writeFileSync(path, markdown)
  console.log(
    `regenerated ${censusDoc}: ${files.length} files, ${rows.length} members, ${never.length} never executed, ${executedUnnamed.length} executed but never named`,
  )
  return 0
}

/**
 * Does anything outside the repository file name this member at all?
 *
 * A never-executed method with no caller either is unused code rather than
 * untested code, and converting it is work spent on nothing. The scan is a name
 * scan, so it can only answer for a member whose name is its own: `upsert` is a
 * method on nine repositories and a method on half the objects in the tree, and
 * a name scan that reported 191 "references" for it would be reporting noise.
 * So the answer is withheld — explicitly, in the table — for any member whose
 * name is shared with another member of the census. A withheld answer is worth
 * more than a confident wrong one: it says which rows still need a human.
 */
export function nameIsUnique(member: Member, all: Member[]): boolean {
  return all.filter((m) => m.member === member.member).length === 1
}

export function referencesOutsideOwnFile(member: Member): string[] {
  const pattern = new RegExp(`\\b${escapeRegExp(member.member)}\\b`)
  return [...sourceFiles(), ...testFiles()]
    .filter((file) => file !== member.file && pattern.test(readText(file)))
    .sort()
}

/**
 * WHAT THE GATE FAILS ON, AND WHY IT IS NOT EVERYTHING.
 *
 * MEMBERSHIP is the defect POD-3360 found: a member with no row is never
 * classified, so Stage A is planned as if it did not exist. That fails the gate.
 *
 * A NAMING REGRESSION fails it too, but only in one direction. A member that
 * gains a naming test makes the census PESSIMISTIC — it says "guarded only
 * indirectly" about something a reviewer can now see a test for, which costs a
 * conversion an unnecessary golden test and nothing else. A member that LOSES
 * its last naming test makes the census OPTIMISTIC about the evidence a reviewer
 * will find, which is the direction that hurts.
 *
 * LINE NUMBERS do not fail it. Every edit above a method moves them, and this
 * epic edits these files constantly; a gate that goes red on a line shift is a
 * gate that gets switched off. `sync-lines` rewrites them mechanically, and the
 * check says when that is worth doing.
 */
export type Drift = {
  newFiles: string[]
  goneFiles: string[]
  added: Member[]
  removed: Row[]
  moved: { member: Member; was: number }[]
  namingLost: Row[]
  namingGained: Member[]
}

export function censusDrift(markdown = readFileSync(join(repoRoot, censusDoc), 'utf8')): Drift {
  const derived = enumerateMembers()
  const committed = parseCommittedRows(markdown)
  const committedByKey = new Map(committed.map((r) => [memberKey(r), r]))
  const derivedByKey = new Map(derived.map((m) => [memberKey(m), m]))
  const named = namedIn(derived)
  const derivedFiles = new Set(derived.map((m) => m.file))
  const committedFiles = new Set(committed.map((r) => r.file))
  const isNamed = (row: Row) => row.named !== '—'
  return {
    newFiles: [...derivedFiles].filter((f) => !committedFiles.has(f)),
    goneFiles: [...committedFiles].filter((f) => !derivedFiles.has(f)),
    added: derived.filter((m) => !committedByKey.has(memberKey(m))),
    removed: committed.filter((r) => !derivedByKey.has(memberKey(r))),
    moved: derived
      .map((member) => ({
        member,
        was: committedByKey.get(memberKey(member))?.line ?? member.line,
      }))
      .filter(({ member, was }) => was !== member.line),
    namingLost: committed.filter(
      (r) =>
        derivedByKey.has(memberKey(r)) &&
        isNamed(r) &&
        (named.get(memberKey(r)) ?? []).length === 0,
    ),
    namingGained: derived.filter((m) => {
      const row = committedByKey.get(memberKey(m))
      return row !== undefined && !isNamed(row) && (named.get(memberKey(m)) ?? []).length > 0
    }),
  }
}

/** The differences that fail the gate — see the note above for what does not. */
export const blockingDrift = (drift: Drift): number =>
  drift.newFiles.length +
  drift.goneFiles.length +
  drift.added.length +
  drift.removed.length +
  drift.namingLost.length

function report(): number {
  const drift = censusDrift()
  const derived = enumerateMembers()
  console.log(`derived:   ${repositoryFiles().length} files, ${derived.length} public members`)
  for (const f of drift.newFiles) console.log(`  + file          ${f}`)
  for (const f of drift.goneFiles) console.log(`  - file          ${f}`)
  for (const m of drift.added)
    console.log(`  + member        ${m.file}:${m.line} ${m.className}.${m.member}`)
  for (const r of drift.removed)
    console.log(`  - member        ${r.file} ${r.className}.${r.member} (was line ${r.line})`)
  for (const r of drift.namingLost)
    console.log(
      `  ! unnamed now   ${r.file} ${r.className}.${r.member} — the census names a test that no longer names it`,
    )
  for (const m of drift.namingGained)
    console.log(
      `  ~ named now     ${m.file} ${m.className}.${m.member} — a test names it since the census (pessimistic, not blocking)`,
    )
  if (drift.moved.length > 0)
    console.log(
      `  ~ ${drift.moved.length} line number(s) stale — 'store-coverage-census.ts sync-lines' rewrites them`,
    )
  const blocking = blockingDrift(drift)
  console.log(
    blocking === 0
      ? 'the census describes the tree'
      : `the census does not describe the tree: ${blocking} blocking difference(s) — re-measure and regenerate`,
  )
  return blocking === 0 ? 0 : 1
}

/** Rewrite the Line column of rows whose member still exists, in place. */
function syncLines(): number {
  const derivedByKey = new Map(enumerateMembers().map((m) => [memberKey(m), m]))
  const path = join(repoRoot, censusDoc)
  const markdown = readFileSync(path, 'utf8')
  let rewritten = 0
  const out = markdown.split('\n').map((line) => {
    if (!line.startsWith('| `')) return line
    const cells = line.slice(1, -1).split(' | ')
    if (cells.length !== 7) return line
    const [file = '', className = '', member = '', lineNo = ''] = cells
    const derived = derivedByKey.get(
      memberKey({ file: stripCode(file), className: className.trim(), member: stripCode(member) }),
    )
    if (!derived || Number(lineNo.trim()) === derived.line) return line
    rewritten += 1
    cells[3] = ` ${derived.line}`
    return `|${cells.join(' | ')}|`
  })
  writeFileSync(path, out.join('\n'))
  console.log(`rewrote ${rewritten} line number(s) in ${censusDoc}`)
  return 0
}

if (import.meta.main) {
  const mode = process.argv[2] ?? 'check'
  if (mode === 'enumerate') {
    console.log(JSON.stringify(enumerateMembers(), null, 2))
    process.exit(0)
  }
  if (mode === 'sync-lines') process.exit(syncLines())
  if (mode === 'reconcile-naming') process.exit(reconcileNaming())
  if (mode === 'generate') {
    const dir = process.argv[3]
    if (!dir) {
      console.error('generate needs a coverage reports directory: generate <dir>')
      process.exit(2)
    }
    process.exit(generate(resolve(dir)))
  }
  if (mode === 'check') process.exit(report())
  console.error(
    `usage: store-coverage-census.ts [check|enumerate|generate <coverage-dir>|sync-lines|reconcile-naming]`,
  )
  process.exit(2)
}

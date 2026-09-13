/**
 * THE ISSUE-SURFACE AUDIT, source half (POD-311, the 3.1 split's gate).
 *
 * Run:
 *   bun run audit:issues           # the gate — exit 1 on any finding
 *   bun run audit:issues --json
 *   bun run audit:issues --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE THE TESTS THAT CHECK THE SAME FAMILY
 * ---------------------------------------------------------------------------
 *
 * Paired instruments of DIFFERENT KINDS, which is the remedy this run arrived at
 * after three suites were found that could not say NO. POD-732's one-liner is the
 * clearest statement of the problem: *an empty router satisfies every absence claim
 * perfectly.*
 *
 *  - THIS SCRIPT reads source TEXT and resolves no modules. It runs in a fresh
 *    checkout, in a worktree with no local install of the `@podium` scope, and
 *    before anything is built. It catches the textual regressions a runtime check
 *    cannot see: a contract field growing back onto a handler, a re-export shim
 *    reappearing in `@podium/protocol`, the derived name list being replaced by a
 *    hand-typed array again.
 *  - `apps/server/src/modules/issues/cli-surface.runtime.test.ts` is the other half.
 *    It drives the REAL `podium issue` command table against a REAL dispatcher over
 *    a REAL registry — no Proxy, no mock — because only a running object can prove
 *    a surface actually serves something.
 *
 * Neither substitutes for the other. A source scan cannot tell a wired surface from
 * a dead one; a runtime check cannot tell a moved declaration from a copied one.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Every check below is an ABSENCE or an EQUALITY claim, and both are exactly what a
 * broken instrument reports. `--probe` runs each check against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it. The probe
 * runs FIRST, always, even without the flag: a green gate whose zero could only mean
 * "the scan broke" is the audit's own worst failure mode.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Finding {
  /** Which obligation failed — the acceptance criterion, in one token. */
  check: string
  /** Where, as `file:line` when a line is known. */
  where: string
  detail: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

const REGISTRY = 'apps/server/src/modules/issues/registry.ts'
const CONTRACTS = 'packages/commands/src/issues/contracts.ts'
const CELLS = 'packages/commands/src/issues/cells.ts'
const CLI_TABLE = 'packages/issue-client/src/commands.ts'

// ---------------------------------------------------------------------------
// 1 — no contract field may grow back onto a handler
// ---------------------------------------------------------------------------

/**
 * The split's core claim: the handler record carries `kind`, `target` and `handler`,
 * and NOTHING ELSE. `input`, `action`, `scope` and `cli` are the contract's.
 *
 * A regression here is not hypothetical — it is the single most likely way this
 * migration is undone, because re-adding `action: 'read'` to a handler compiles, runs,
 * and is silently ignored by the join (which overwrites it from the contract). A
 * second declaration that has no effect is worse than one that does: it reads as the
 * authority while the contract decides.
 *
 * Scanned by BRACE MATCHING over each `def('name', {` literal rather than by line
 * regex, so a field nested inside a handler body — `z.object({ action: … })` is a
 * legitimate thing to write — does not fire.
 */
export function contractFieldOnHandler(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  const opener = /def\('(\w+)',\s*\{/g
  const FORBIDDEN = new Set(['input', 'action', 'scope', 'cli', 'policy', 'exposure'])
  for (const match of source.matchAll(opener)) {
    const open = source.indexOf('{', match.index + match[0].length - 1)
    let depth = 0
    let end = source.length
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '{' || ch === '(' || ch === '[') depth += 1
      else if (ch === '}' || ch === ')' || ch === ']') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const body = source.slice(open, end)
    // Top-level keys only: exactly four spaces of indent inside the def literal.
    for (const key of body.matchAll(/^ {4}(\w+):/gm)) {
      const name = key[1] as string
      if (!FORBIDDEN.has(name)) continue
      findings.push({
        check: 'no-contract-field-on-handler',
        where: `${file}:${lineOf(source, open + (key.index ?? 0))}`,
        detail:
          `\`${match[1]}\` re-declares \`${name}\` on the HANDLER. That field belongs to the L1 ` +
          'contract, and the join overwrites it — so this declaration reads as authoritative and ' +
          'decides nothing. Move it to packages/commands/src/issues/contracts.ts.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — stranded protocol contracts stay absorbed; the unsent envelope stays retired
// ---------------------------------------------------------------------------

/**
 * POD-311 absorbed four modules out of `@podium/protocol`. The live framework
 * modules stay absorbed, while the never-sent mutation envelope stays deleted.
 * The failure modes look different:
 *
 *   · the file comes BACK, and there are two frameworks again;
 *   · a re-export SHIM is left in its place, which is worse, because every call site
 *     keeps compiling and the duplicate is invisible — and it would add to the
 *     `reexport-shims` ratchet the deletion audit counts.
 */
export function strandedContractsReturned(
  fileExists: (rel: string) => boolean,
  protocolIndex: string,
  messagesIndex: string,
): Finding[] {
  const findings: Finding[] = []
  const ABSORBED = [
    'packages/protocol/src/commands.ts',
    'packages/protocol/src/messages/mutations.ts',
    'packages/protocol/src/session-commands.ts',
    'packages/protocol/src/session-command-plane.ts',
  ]
  for (const rel of ABSORBED) {
    if (fileExists(rel)) {
      findings.push({
        check: 'stranded-contracts-absorbed',
        where: rel,
        detail:
          'this module was absorbed into @podium/commands by POD-311; its return means there are ' +
          'two contract frameworks again',
      })
    }
  }
  const retiredEnvelope = 'packages/commands/src/mutations.ts'
  if (fileExists(retiredEnvelope)) {
    findings.push({
      check: 'unused-mutation-envelope-retired',
      where: retiredEnvelope,
      detail:
        'MutationEnvelope/MutationResult were never sent or received; production durable writes use OutboxCommand',
    })
  }
  const shim = /export \* from '\.\/(commands|session-commands|session-command-plane)'/
  const shimMatch = shim.exec(protocolIndex)
  if (shimMatch) {
    findings.push({
      check: 'stranded-contracts-absorbed',
      where: `packages/protocol/src/index.ts:${lineOf(protocolIndex, shimMatch.index)}`,
      detail: `re-export shim for './${shimMatch[1]}' — the move must be visible at every call site`,
    })
  }
  const mutationShim = /export \* from '\.\/mutations'/.exec(messagesIndex)
  if (mutationShim) {
    findings.push({
      check: 'stranded-contracts-absorbed',
      where: `packages/protocol/src/messages/index.ts:${lineOf(messagesIndex, mutationShim.index)}`,
      detail: "re-export shim for './mutations' — absorbed into @podium/commands by POD-311",
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — the name list stays DERIVED
// ---------------------------------------------------------------------------

/**
 * `ISSUE_COMMAND_NAMES` was a hand-maintained array of sixty-eight string literals in
 * `@podium/protocol` — a second place to remember to edit. It is now
 * `Object.keys(ISSUE_CONTRACTS)`. The regression is somebody "fixing" the derivation
 * back into a literal to get a narrower type, which silently restores the drift.
 */
export function nameListRestated(source: string, file: string): Finding[] {
  // The declaration's text, NOT its first line. Anchoring on the line breaks the
  // moment biome reflows a long declaration — which is exactly what happened when
  // POD-301 added an import and pushed `Object.keys(ISSUE_CONTRACTS).sort()` onto
  // three lines: the derivation was intact and this check reported it restated.
  // `representation-audit.ts` documents the same trap for its own key matcher.
  const decl = /export const ISSUE_COMMAND_NAMES[^=]*=\s*([\s\S]{0,240})/.exec(source)
  if (!decl) {
    return [
      {
        check: 'derived-name-list',
        where: file,
        detail:
          'ISSUE_COMMAND_NAMES is not declared here at all — the check cannot say anything, which ' +
          'is a finding and not a pass',
      },
    ]
  }
  // Whitespace-normalized: the reflowed form splits `Object.keys(` from
  // `ISSUE_CONTRACTS)` across lines, and a raw substring test cannot see through
  // that. The check is about the DERIVATION being present, not its layout.
  // Whitespace stripped AND the trailing comma dropped: biome's reflowed form is
  // `Object.keys(\n  ISSUE_CONTRACTS,\n)`, so both the newlines and the magic
  // comma sit between the two halves of the substring being tested.
  const derivation = (decl[1] as string).replace(/\s+/g, '').replace(/,\)/g, ')')
  if (!derivation.includes('Object.keys(ISSUE_CONTRACTS)')) {
    return [
      {
        check: 'derived-name-list',
        where: `${file}:${lineOf(source, decl.index)}`,
        detail:
          'ISSUE_COMMAND_NAMES is no longer derived from the contract table. A restated list is a ' +
          'second place a command name can exist, which is exactly what POD-311 folded in.',
      },
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// 4 — declared CLI/MCP exposure equals the CLI table's actual reach, both ways
// ---------------------------------------------------------------------------

/**
 * ADR 3 D3's content is that a transport is served because a contract NAMES it. That
 * is only true if the naming and the wiring agree, so this compares them — in BOTH
 * directions, because the two failures are different bugs:
 *
 *   · a proc the CLI table calls whose contract does NOT declare `cli` is a surface
 *     served without a declaration — the default-closed rule defeated;
 *   · a contract declaring `cli` that no CLI verb reaches is a declaration that
 *     opens nothing — the field decaying into decoration.
 *
 * CLI and MCP are ONE decision because they are one table: `apps/server/src/
 * issue-mcp.ts` derives its tool list from the same `ISSUE_COMMANDS` the CLI renders.
 *
 * Both sides are read from SOURCE TEXT. The reach is every `.issues.<proc>` the CLI
 * table names, which is branch-insensitive — a runtime recorder only sees the procs
 * the branches it happens to take actually call, and that is the runtime half's known
 * weakness, covered here.
 *
 * THE DECLARED SIDE IS RESOLVED TO A TAG SET, NOT MATCHED BY CONSTANT NAME (PDM-416).
 * It used to ask `exposure === 'SERVED_EVERYWHERE'`, which made the check a test of
 * WHICH CELL a contract cited rather than of WHAT IT DECLARES. The two came apart the
 * moment a second cell carried the same `cli`/`mcp` tags: adding
 * `SERVED_EVERYWHERE_QUEUED` — literally `[...SERVED_EVERYWHERE, 'outbox']` — made
 * nine contracts that plainly declare `cli` and `mcp` read as declaring NOTHING, and
 * this audit reported nine reached-but-undeclared findings that were all false.
 *
 * It failed CLOSED, which is why the rename was caught rather than smuggled, but a
 * check that answers a question about a NAME cannot be trusted to answer the question
 * about TAGS it claims to ask. So cells are parsed into tag sets and spreads between
 * them are followed; a contract is `declared` when its resolved set contains `cli` and
 * `mcp`, whatever cell it got them from and however many cells there are.
 */
export function exposureMismatch(
  contractsSource: string,
  cellsSource: string,
  cliSource: string,
): Finding[] {
  const findings: Finding[] = []

  // EVERY exposure cell, resolved to the tags it actually carries. Read, never
  // assumed, so neither renaming a cell nor adding one can silently empty this check.
  const cellTags = new Map<string, Set<string>>()
  const cellSpreads = new Map<string, string[]>()
  for (const m of cellsSource.matchAll(
    /export const (\w+): readonly TransportTag\[\] = \[([^\]]*)\]/g,
  )) {
    const body = m[2] as string
    cellTags.set(m[1] as string, new Set([...body.matchAll(/'(\w+)'/g)].map((t) => t[1] as string)))
    cellSpreads.set(
      m[1] as string,
      [...body.matchAll(/\.\.\.(\w+)/g)].map((t) => t[1] as string),
    )
  }
  /**
   * A cell's tags including everything it spreads in, AND the names of any spread
   * parents this file could not parse.
   *
   * THE UNRESOLVED LIST IS THE POINT, and it is the same defect as the one above
   * met one level down. An earlier version returned only a Set, so a cell that
   * spread an UNPARSED parent resolved to the tags it happened to state directly
   * and looked completely resolved. `A = [...UNKNOWN, 'outbox']` then answers "I do
   * not name cli/mcp" with total confidence, when the truthful answer is "I cannot
   * tell you" — and the root-level check cannot catch it, because `A` itself parses
   * fine. A contract citing `A` that nothing reaches would drop out of `declared`
   * silently. Reviewer's finding (PDM-139), source-read.
   *
   * Cycle-guarded: a cell that spreads itself must not hang the audit, it must
   * resolve to what it states.
   */
  const resolveCell = (
    cellName: string,
    seen = new Set<string>(),
  ): { tags: Set<string>; unresolved: string[] } => {
    if (seen.has(cellName)) return { tags: new Set(), unresolved: [] }
    seen.add(cellName)
    const own = cellTags.get(cellName)
    if (!own) return { tags: new Set(), unresolved: [cellName] }
    const tags = new Set(own)
    const unresolved: string[] = []
    for (const parent of cellSpreads.get(cellName) ?? []) {
      const resolved = resolveCell(parent, seen)
      for (const tag of resolved.tags) tags.add(tag)
      unresolved.push(...resolved.unresolved)
    }
    return { tags, unresolved }
  }
  /** The cells that mean "on the CLI and MCP". More than one is normal. */
  const cliMcpCells = [...cellTags.keys()].filter((name) => {
    const { tags } = resolveCell(name)
    return tags.has('cli') && tags.has('mcp')
  })
  if (cliMcpCells.length === 0) {
    return [
      {
        check: 'exposure-matches-reach',
        where: CELLS,
        detail:
          'no exposure cell names both `cli` and `mcp` — the exposure comparison below ' +
          'would be comparing against nothing',
      },
    ]
  }
  const cliMcp = new Set(cliMcpCells)

  // Read one DECLARATION AT A TIME. A single lazy `name … exposure` regex over the
  // whole file cannot do this: a contract that inherits its exposure by spreading a
  // sibling (`{ ...issueShareContract, name: 'issues.unshare' }`) has no `exposure:`
  // line of its own, so the scan runs past it and swallows the NEXT contract's name —
  // which silently drops a real declaration and reports it as undeclared (POD-1314).
  const blocks = new Map<string, { name?: string; exposure?: string; spread?: string }>()
  const order: string[] = []
  for (const m of contractsSource.matchAll(/export const (\w+)[^=]*=\s*\{([\s\S]*?)\n\}/g)) {
    const constName = m[1] as string
    const body = m[2] as string
    order.push(constName)
    blocks.set(constName, {
      name: /name: 'issues\.(\w+)'/.exec(body)?.[1],
      exposure: /^\s*exposure: (\w+),/m.exec(body)?.[1],
      spread: /^\s*\.\.\.(\w+),/m.exec(body)?.[1],
    })
  }

  const exposureOf = (constName: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(constName)) return undefined
    seen.add(constName)
    const block = blocks.get(constName)
    if (!block) return undefined
    if (block.exposure) return block.exposure
    return block.spread ? exposureOf(block.spread, seen) : undefined
  }

  const declared = new Set<string>()
  for (const constName of order) {
    const block = blocks.get(constName)
    if (!block?.name) continue
    const exposure = exposureOf(constName)
    if (exposure === undefined) {
      findings.push({
        check: 'exposure-matches-reach',
        where: CONTRACTS,
        detail:
          `\`issues.${block.name}\` (${constName}) declares no \`exposure\` and none can be resolved ` +
          'through its spread — an unread declaration would silently drop out of this comparison',
      })
      continue
    }
    // AN EXPOSURE CELL THIS FILE CANNOT PARSE IS UNRESOLVED, NOT "NO CLI/MCP".
    // `exposureOf` returns an IDENTIFIER, and asking `cliMcp.has(identifier)`
    // directly answers false for two very different situations: a cell that really
    // does not name cli/mcp, and a cell that was never parsed at all (declared in
    // another file, or spelled in a way the cell regex does not match). Collapsing
    // them fails CLOSED in one direction — a reached proc still gets reported as
    // undeclared — and OPEN in the other: a contract nothing reaches would drop out
    // of the `declared` set silently and its decayed declaration would never be
    // named. So an unknown cell is its own finding, exactly like an absent one.
    // A cell that parses but DEPENDS on one that does not is unresolved too. Reported
    // conservatively — even when the cell already states cli/mcp directly — because
    // the honest claim is that this audit cannot see the whole declaration, and a
    // gate that cannot see it should say so rather than answer from the part it can.
    const unresolvedParents = cellTags.has(exposure) ? resolveCell(exposure).unresolved : []
    if (unresolvedParents.length > 0) {
      findings.push({
        check: 'exposure-matches-reach',
        where: CELLS,
        detail:
          `\`issues.${block.name}\` cites exposure cell \`${exposure}\`, which spreads ` +
          `\`${[...new Set(unresolvedParents)].sort().join('`, `')}\` — not parsed here, so the ` +
          'cell resolves to only the tags it states DIRECTLY and this comparison would be ' +
          'answering from a partial declaration',
      })
      continue
    }
    if (!cellTags.has(exposure)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: CONTRACTS,
        detail:
          `\`issues.${block.name}\` (${constName}) cites exposure cell \`${exposure}\`, which is ` +
          'not among the cells this audit parsed — it is UNRESOLVED, and treating it as ' +
          '"declares no cli/mcp" would drop a real declaration out of this comparison silently',
      })
      continue
    }
    if (cliMcp.has(exposure)) declared.add(block.name)
  }
  const reached = new Set(
    [...cliSource.matchAll(/\.issues\.(\w+)\b/g)].map((m) => m[1] as string),
  )

  if (declared.size === 0 || reached.size === 0) {
    return [
      {
        check: 'exposure-matches-reach',
        where: `${CONTRACTS} / ${CLI_TABLE}`,
        detail:
          `one side of the comparison is EMPTY (declared=${declared.size}, reached=${reached.size}) ` +
          '— an equality between empty sets is not evidence',
      },
    ]
  }

  for (const proc of [...reached].sort()) {
    if (!declared.has(proc)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: CLI_TABLE,
        detail:
          `the CLI/MCP table calls \`issues.${proc}\` but its contract does not declare \`cli\` ` +
          'exposure — a transport served without a declaration defeats ADR 3 D3',
      })
    }
  }
  for (const proc of [...declared].sort()) {
    if (!reached.has(proc)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: CONTRACTS,
        detail:
          `\`issues.${proc}\` declares \`cli\`/\`mcp\` exposure but no CLI verb reaches it — a ` +
          'declaration that opens nothing is the field decaying into decoration',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------

export function auditIssueCommands(): Finding[] {
  return [
    ...contractFieldOnHandler(read(REGISTRY), REGISTRY),
    ...strandedContractsReturned(
      (rel) => existsSync(join(ROOT, rel)),
      read('packages/protocol/src/index.ts'),
      read('packages/protocol/src/messages/index.ts'),
    ),
    ...nameListRestated(read(CONTRACTS), CONTRACTS),
    ...exposureMismatch(read(CONTRACTS), read(CELLS), read(CLI_TABLE)),
  ]
}

/** Counted as the probes run, so the summary line cannot drift from what ran. */
const probeCounts = { planted: 0, clean: 0 }

/** Each check, run against a fixture containing exactly what it hunts. */
function probe(): Finding[] {
  const failures: Finding[] = []
  const expect = (name: string, found: Finding[]): void => {
    probeCounts.planted += 1
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-issue-commands.ts',
        detail: `the ${name} check did NOT find its planted fixture — its zero is meaningless`,
      })
    }
  }
  const mustNotFire = (name: string, found: Finding[]): void => {
    probeCounts.clean += 1
    if (found.length > 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-issue-commands.ts',
        detail: `the ${name} check fired on a CLEAN fixture — it cannot say NO: ${found[0]?.detail}`,
      })
    }
  }

  const handlerWithField = [
    "  close: def('close', {",
    "    kind: 'mutation',",
    '    target: targetId,',
    "    action: 'write',", // ← planted
    '    handler: (ctx, input) => ctx.issues.close(input.id),',
    '  }),',
  ].join('\n')
  expect('no-contract-field-on-handler', contractFieldOnHandler(handlerWithField, '<probe>'))

  // …and it must NOT fire on a clean def, nor on the same key nested inside a
  // handler body, or it would be matching the word rather than the declaration.
  mustNotFire(
    'no-contract-field-on-handler',
    contractFieldOnHandler(
      [
        "  close: def('close', {",
        "    kind: 'mutation',",
        '    target: targetId,',
        '    handler: (ctx, input) =>',
        "      ctx.issues.close(input.id, { action: 'close', input: input.reason }),",
        '  }),',
      ].join('\n'),
      '<probe>',
    ),
  )

  expect(
    'stranded-contracts-absorbed/file',
    strandedContractsReturned((rel) => rel === 'packages/protocol/src/commands.ts', '', ''),
  )
  expect(
    'stranded-contracts-absorbed/shim',
    strandedContractsReturned(() => false, "export * from './session-commands'\n", ''),
  )
  expect(
    'stranded-contracts-absorbed/mutations-shim',
    strandedContractsReturned(() => false, '', "export * from './mutations'\n"),
  )
  expect(
    'unused-mutation-envelope-retired/file',
    strandedContractsReturned(
      (rel) => rel === 'packages/commands/src/mutations.ts',
      '',
      '',
    ),
  )
  mustNotFire(
    'stranded-contracts-absorbed',
    strandedContractsReturned(() => false, "export * from './handshake'\n", "export * from './sync'\n"),
  )

  expect(
    'derived-name-list/restated',
    nameListRestated("export const ISSUE_COMMAND_NAMES = ['action', 'close'] as const\n", '<probe>'),
  )
  expect('derived-name-list/absent', nameListRestated('const nothing = 1\n', '<probe>'))
  mustNotFire(
    'derived-name-list',
    nameListRestated(
      'export const ISSUE_COMMAND_NAMES = Object.keys(ISSUE_CONTRACTS).sort() as X\n',
      '<probe>',
    ),
  )

  // Both cells the contract fixtures cite. Since an UNPARSED cell is now its own
  // finding, a fixture that cites a cell it does not define is not a clean fixture —
  // the probe harness caught exactly that and it was the fixture that was wrong.
  const CELLS_OK = [
    "export const SERVED_EVERYWHERE: readonly TransportTag[] = ['trpc', 'relay', 'cli', 'mcp']",
    "export const SERVED_ON_WIRE: readonly TransportTag[] = ['trpc', 'relay']",
  ].join('\n')
  const contractsFixture = [
    'export const shownContract = {',
    "  name: 'issues.shown',",
    '  exposure: SERVED_EVERYWHERE,',
    '} as const',
    '',
    'export const hiddenContract = {',
    "  name: 'issues.hidden',",
    '  exposure: SERVED_ON_WIRE,',
    '} as const',
  ].join('\n')
  // Reached but not declared.
  expect(
    'exposure-matches-reach/undeclared',
    exposureMismatch(contractsFixture, CELLS_OK, 'client.issues.shown.query()\nclient.issues.hidden.query()\n'),
  )
  // Declared but unreachable.
  expect(
    'exposure-matches-reach/unreached',
    exposureMismatch(contractsFixture, CELLS_OK, 'client.issues.other.query()\n'),
  )
  // The empty-side arm: an equality between empty sets must be a FINDING.
  expect('exposure-matches-reach/empty', exposureMismatch(contractsFixture, CELLS_OK, 'nothing\n'))
  expect(
    'exposure-matches-reach/cell-renamed',
    exposureMismatch(contractsFixture, 'export const SOMETHING_ELSE = []', 'client.issues.shown.query()\n'),
  )
  mustNotFire(
    'exposure-matches-reach',
    exposureMismatch(contractsFixture, CELLS_OK, 'client.issues.shown.query()\n'),
  )
  // POD-1314: a contract that inherits its exposure by SPREADING a sibling must be
  // read through the spread, and must not swallow the declaration that follows it.
  const spreadFixture = [
    contractsFixture,
    '',
    'export const spreadContract = {',
    '  ...shownContract,',
    "  name: 'issues.spread',",
    '} as const',
    '',
    'export const afterContract = {',
    "  name: 'issues.after',",
    '  exposure: SERVED_EVERYWHERE,',
    '} as const',
  ].join('\n')
  mustNotFire(
    'exposure-matches-reach',
    exposureMismatch(
      spreadFixture,
      CELLS_OK,
      'client.issues.shown.query()\nclient.issues.spread.query()\nclient.issues.after.query()\n',
    ),
  )
  // PDM-416: a contract declaring `cli`/`mcp` through a DIFFERENT cell — one that
  // spreads the canonical one and adds a tag — must read as DECLARED. Keying on the
  // cell's NAME made nine such contracts read as declaring nothing and produced nine
  // false reached-but-undeclared findings; this fixture is that regression, pinned.
  const QUEUED_CELLS = [
    CELLS_OK,
    "export const SERVED_EVERYWHERE_QUEUED: readonly TransportTag[] = [...SERVED_EVERYWHERE, 'outbox']",
  ].join('\n')
  const queuedFixture = [
    'export const queuedContract = {',
    "  name: 'issues.queued',",
    '  exposure: SERVED_EVERYWHERE_QUEUED,',
    '} as const',
  ].join('\n')
  mustNotFire(
    'exposure-matches-reach',
    exposureMismatch(queuedFixture, QUEUED_CELLS, 'client.issues.queued.query()\n'),
  )
  // And the direction that must STILL fire through the second cell: declared there,
  // reached by nobody. Without this the fixture above could pass by the check going
  // blind to the new cell altogether rather than by resolving it.
  expect(
    'exposure-matches-reach/unreached-via-spread-cell',
    exposureMismatch(queuedFixture, QUEUED_CELLS, 'client.issues.other.query()\n'),
  )

  // A cell that PARSES but spreads a parent that does not must be unresolved too —
  // the root-level check cannot see this, because the cited cell itself is fine.
  // Shape specified by the PDM-139 reviewer: a valid root, an unknown PARENT, and an
  // unrelated valid cli/mcp declaration that IS reached, so the empty-side guard
  // stays green and this fires on the spread arm alone rather than on a degenerate
  // comparison.
  expect(
    'exposure-matches-reach/unknown-spread-parent',
    exposureMismatch(
      [
        contractsFixture,
        '',
        'export const spreadsUnknownContract = {',
        "  name: 'issues.spreadsunknown',",
        '  exposure: CELL_WITH_UNKNOWN_PARENT,',
        '} as const',
      ].join('\n'),
      [
        CELLS_OK,
        "export const CELL_WITH_UNKNOWN_PARENT: readonly TransportTag[] = [...DEFINED_ELSEWHERE, 'outbox']",
      ].join('\n'),
      'client.issues.shown.query()\n',
    ),
  )

  // An exposure cell the audit never parsed must be UNRESOLVED, not silently read as
  // "declares no cli/mcp". Note the cells source here IS valid (it has a cli/mcp
  // cell), so this exercises the per-contract arm rather than the early return above.
  expect(
    'exposure-matches-reach/unknown-cell',
    exposureMismatch(
      [
        contractsFixture,
        '',
        'export const elsewhereContract = {',
        "  name: 'issues.elsewhere',",
        '  exposure: A_CELL_DEFINED_IN_ANOTHER_FILE,',
        '} as const',
      ].join('\n'),
      CELLS_OK,
      'client.issues.shown.query()\n',
    ),
  )

  // An exposure that can be resolved from NEITHER a field nor a spread is a finding,
  // not a silent drop.
  expect(
    'exposure-matches-reach/unresolvable',
    exposureMismatch(
      [contractsFixture, '', 'export const orphanContract = {', "  name: 'issues.orphan',", '} as const'].join('\n'),
      CELLS_OK,
      'client.issues.shown.query()\n',
    ),
  )

  return failures
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Issue-surface audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log(
      `issue-surface audit: all ${probeCounts.planted} probes found their planted fixtures, and ` +
        `all ${probeCounts.clean} clean fixtures stayed silent`,
    )
    return
  }

  const findings = auditIssueCommands()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Issue-surface audit: ${findings.length} finding(s). The 3.1 split's claims are:\n` +
        '  · a handler declares kind/target/handler and NOTHING the contract owns\n' +
        '  · the absorbed protocol contracts stay absorbed, with no re-export shim\n' +
        '  · the never-sent generic mutation envelope stays retired\n' +
        '  · ISSUE_COMMAND_NAMES stays DERIVED from the contract table\n' +
        "  · declared cli/mcp exposure equals the CLI table's actual reach, both ways\n",
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'issue-surface audit OK — handlers carry no contract field, the stranded contracts stayed ' +
      'absorbed with no shim, the unused mutation envelope stayed retired, the name list is ' +
      'derived, exposure matches reach in both directions',
  )
}

if (import.meta.main) main()

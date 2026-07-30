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
// 2 — the stranded protocol contracts stay absorbed, with no shim behind them
// ---------------------------------------------------------------------------

/**
 * POD-311 absorbed four modules out of `@podium/protocol`. Two failure modes end the
 * "ONE contract framework" claim, and they look nothing alike:
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
  const decl = /export const ISSUE_COMMAND_NAMES[^\n]*=\s*([^\n]*)/.exec(source)
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
  if (!(decl[1] as string).includes('Object.keys(ISSUE_CONTRACTS)')) {
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
 */
export function exposureMismatch(
  contractsSource: string,
  cellsSource: string,
  cliSource: string,
): Finding[] {
  const findings: Finding[] = []

  // Which cell means "on the CLI and MCP" — read, never assumed, so renaming the
  // constant cannot silently empty this check.
  const cell = /export const SERVED_EVERYWHERE[^=]*=\s*\[([^\]]*)\]/.exec(cellsSource)
  if (!cell || !(cell[1] as string).includes("'cli'") || !(cell[1] as string).includes("'mcp'")) {
    return [
      {
        check: 'exposure-matches-reach',
        where: CELLS,
        detail:
          'SERVED_EVERYWHERE is missing or no longer names both `cli` and `mcp` — the exposure ' +
          'comparison below would be comparing against nothing',
      },
    ]
  }

  const declared = new Set<string>()
  for (const m of contractsSource.matchAll(
    /name: 'issues\.(\w+)',[\s\S]*?exposure: (SERVED_EVERYWHERE|SERVED_ON_WIRE),/g,
  )) {
    if (m[2] === 'SERVED_EVERYWHERE') declared.add(m[1] as string)
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

/** Each check, run against a fixture containing exactly what it hunts. */
function probe(): Finding[] {
  const failures: Finding[] = []
  const expect = (name: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-issue-commands.ts',
        detail: `the ${name} check did NOT find its planted fixture — its zero is meaningless`,
      })
    }
  }
  const mustNotFire = (name: string, found: Finding[]): void => {
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

  const CELLS_OK = "export const SERVED_EVERYWHERE: readonly TransportTag[] = ['trpc', 'relay', 'cli', 'mcp']"
  const contractsFixture = [
    "  name: 'issues.shown',",
    '  exposure: SERVED_EVERYWHERE,',
    "  name: 'issues.hidden',",
    '  exposure: SERVED_ON_WIRE,',
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
      'issue-surface audit: all 11 probes found their planted fixtures, and all 4 checks stayed ' +
        'silent on clean ones',
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
        '  · ISSUE_COMMAND_NAMES stays DERIVED from the contract table\n' +
        "  · declared cli/mcp exposure equals the CLI table's actual reach, both ways\n",
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'issue-surface audit OK — handlers carry no contract field, the stranded contracts stayed ' +
      'absorbed with no shim, the name list is derived, exposure matches reach in both directions',
  )
}

if (import.meta.main) main()

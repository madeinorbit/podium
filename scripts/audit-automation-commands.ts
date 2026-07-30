/**
 * THE AUTOMATION-SURFACE AUDIT (POD-735, the 3.11 cutover gate; POD-424's
 * criterion for the automations router).
 *
 * Run:
 *   bun run audit:automations            # the gate — exit 1 on any finding
 *   bun run audit:automations --json
 *   bun run audit:automations --probe    # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS OF DIFFERENT KINDS, AND THIS IS THE TEXTUAL ONE
 * ---------------------------------------------------------------------------
 *
 * `apps/server/src/automation-cutover.audit.test.ts` reads the RUNNING system: the
 * real `appRouter`, the real contract objects, and the real `AgentRelayGate`
 * refusing `automations.*` with a positive control beside it. It is the only thing
 * that can show the derived surface EXISTS with the right verbs and that a gate
 * actually refuses.
 *
 * This script resolves NO modules and reads source TEXT. It runs in a fresh
 * checkout, in a worktree with no local install of the `@podium` scope, and before
 * anything is built — the three situations in which that suite cannot run at all.
 * It catches the textual regressions a runtime check cannot see: a hand-written
 * `.mutation(` back inside the `automations:` router literal, the deleted
 * `automationInput`/`automationPatch` schemas regrowing beside the contracts, a
 * second cron parser appearing in `apps/server`, or a contract added without its
 * `visibility` / `operatorOnly` line.
 *
 * ---------------------------------------------------------------------------
 * AN EMPTY ROUTER SATISFIES EVERY ABSENCE CLAIM PERFECTLY (POD-732)
 * ---------------------------------------------------------------------------
 *
 * "No hand-written mutation in the `automations` router" is true of an
 * `automations` router with nothing in it, and true of a `router.ts` that failed to
 * spread the derived procedures. So check 2 is a PRESENCE claim — the block must
 * carry `...automationProcedures()` — and it is what stops check 1 from being
 * satisfiable by deletion.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Every check below is an ABSENCE or an OBLIGATION claim, and an absence is exactly
 * what a broken instrument reports. `probe()` runs each against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it; each also
 * gets the converse probe against a CLEAN fixture, because a check that fires on
 * everything is as useless as one that fires on nothing. The probe runs FIRST,
 * always, with or without the flag.
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

const ROUTER = 'apps/server/src/router.ts'
const CONTRACTS = 'packages/commands/src/automations/contracts.ts'
const CRON = 'packages/commands/src/automations/cron.ts'
const SERVER_CRON = 'apps/server/src/modules/automations/cron.ts'

/**
 * A FILE THAT IS NOT THERE IS A FINDING, NOT A CRASH.
 *
 * `readFileSync` on a moved or renamed subject throws ENOENT, and an audit that
 * dies reads as an ENVIRONMENT problem — a bad checkout, a missing install —
 * rather than as the audit having lost the thing it exists to check. Those get
 * opposite responses: one is retried, the other is investigated. Taken as a PORT so
 * the probe can plant a missing file without touching the working tree.
 */
export function missingSubjects(
  exists: (rel: string) => boolean = (rel) => existsSync(join(ROOT, rel)),
): Finding[] {
  return [ROUTER, CONTRACTS, CRON]
    .filter((rel) => !exists(rel))
    .map((rel) => ({
      check: 'subject-present',
      where: rel,
      detail:
        'the audit’s subject is not at this path — moved or renamed. That is a finding about the ' +
        'cutover, not an environment problem: this gate cannot check what it cannot find.',
    }))
}

/**
 * Extract the `automations: t.router({ … })` literal by BRACE MATCHING.
 *
 * Not a line scan: the literal carries comments and nested objects, and a
 * line-based reader stops at the first `})` — which would report a serene zero for
 * a mutation written anywhere after it. `--probe` plants its mutation at the END of
 * the block for exactly that reason.
 *
 * Returns `undefined` when the router is absent, which every caller treats as a
 * FINDING and never as a pass: a router that vanished is not a router with no
 * hand-written mutations.
 */
export function routerBlock(source: string): { text: string; startLine: number } | undefined {
  const marker = /^\s{2}automations: t\.router\(/m
  const match = marker.exec(source)
  if (!match) return undefined
  const open = source.indexOf('(', match.index + match[0].length - 1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) {
        return { text: source.slice(open, i + 1), startLine: lineOf(source, match.index) }
      }
    }
  }
  return undefined
}

/** The procedure key a `.mutation(` belongs to — the nearest `    <key>: ` above it. */
function keyAbove(block: string, index: number): string {
  const keys = [...block.slice(0, index).matchAll(/\n\s{4}(\w+):/g)]
  return keys.length > 0 ? (keys[keys.length - 1]?.[1] ?? '?') : '?'
}

// ---------------------------------------------------------------------------
// 1 — no hand-written mutation in the automations router (POD-424's criterion)
// ---------------------------------------------------------------------------

export function handWrittenMutations(source: string, where: string): Finding[] {
  const block = routerBlock(source)
  if (!block) {
    return [
      {
        check: 'derived-surface',
        where,
        detail:
          'no `automations: t.router(` literal found — the scan has nothing to check, which is a ' +
          'finding and not a pass',
      },
    ]
  }
  return [...block.text.matchAll(/\.mutation\(/g)].map((match) => ({
    check: 'derived-surface',
    where: `${where}:${block.startLine + lineOf(block.text, match.index) - 1}`,
    detail:
      `hand-written \`.mutation(\` for \`automations.${keyAbove(block.text, match.index)}\` — every ` +
      'automation write is derived from its contract by modules/automations/trpc.ts, which is also ' +
      'where its exposure and operator-only decisions come from',
  }))
}

// ---------------------------------------------------------------------------
// 2 — the derived surface is actually SPREAD (an empty router is not a pass)
// ---------------------------------------------------------------------------

export function missingDerivedSpread(source: string, where: string): Finding[] {
  const block = routerBlock(source)
  if (!block) return [] // already reported by check 1
  if (block.text.includes('...automationProcedures()')) return []
  return [
    {
      check: 'derived-surface-present',
      where: `${where}:${block.startLine}`,
      detail:
        'the `automations` router does not spread `...automationProcedures()` — an empty router ' +
        'satisfies every absence claim in this audit perfectly, so presence is checked too',
    },
  ]
}

// ---------------------------------------------------------------------------
// 3 — the deleted input schemas have not regrown beside the contracts
// ---------------------------------------------------------------------------

/**
 * `automationFields` / `automationInput` / `automationPatch` were the router's own
 * schema declarations. Their contract-side replacements live in
 * `packages/commands/src/automations/contracts.ts`; a copy back in `router.ts` is
 * how a surface acquires two schemas that agree until one is edited.
 *
 * Keyed on the DECLARATION (`const <name>` at column 0), not on any mention, so
 * the comments explaining the move do not fire it.
 */
export function resurrectedSchemas(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const name of ['automationFields', 'automationInput', 'automationPatch']) {
    const pattern = new RegExp(`^const ${name}\\b`, 'm')
    const match = pattern.exec(source)
    if (match) {
      findings.push({
        check: 'one-schema',
        where: `${where}:${lineOf(source, match.index)}`,
        detail:
          `\`${name}\` is back in the router — the automation input vocabulary lives with the ` +
          'contracts in @podium/commands, and a second copy here can only disagree with it',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — ONE cron parser, and it is the one the contracts validate with
// ---------------------------------------------------------------------------

/**
 * The cron parser moved to L1 because the composer's BAD_REQUEST guarantee makes
 * cron validation part of the input SCHEMA. A parser back in `apps/server` would
 * mean the schema and the service could disagree about which expressions are legal
 * — the failure that produces a 500 the composer cannot render.
 *
 * Checked as a FILE-EXISTENCE claim (taken as a port so the probe can plant one)
 * plus the positive half: the L1 parser must still be what the contracts import.
 */
export function duplicateCronParser(
  contracts: string,
  exists: (rel: string) => boolean = (rel) => existsSync(join(ROOT, rel)),
): Finding[] {
  const findings: Finding[] = []
  if (exists(SERVER_CRON)) {
    findings.push({
      check: 'one-cron-parser',
      where: SERVER_CRON,
      detail:
        'a second cron parser is back in apps/server — the contracts validate with the L1 parser ' +
        `(${CRON}), and two parsers means the schema and the service can disagree about which ` +
        'expressions are legal',
    })
  }
  if (!/from '\.\/cron'/.test(contracts)) {
    findings.push({
      check: 'one-cron-parser',
      where: CONTRACTS,
      detail:
        'the contracts no longer import the L1 cron parser — the composer’s BAD_REQUEST guarantee ' +
        'depends on cron validity being decided by the INPUT SCHEMA',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 5 — every automation contract declares its class AND its operator-only policy
// ---------------------------------------------------------------------------

/**
 * Both fields are REQUIRED at the type level, so this looks redundant — and it is
 * not, for the reason POD-731 hit: a widening cast (`as unknown as`) over the table
 * compiles happily with a field missing from every entry, silently defeating the
 * compile-time half of the default-closed rule. A textual check cannot be cast away.
 *
 * `visibility` matters more here than in any sibling family: `personal` is also
 * what ADR 9 D4's backstop answers for a row nobody classified, so a contract that
 * simply omitted the line would be INDISTINGUISHABLE at runtime from one that
 * declared it. The only instrument that can tell those apart is a textual one.
 */
export function undeclaredContractFields(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const match of source.matchAll(/^export const (\w+Contract) = \{\n/gm)) {
    const start = match.index + match[0].length
    const end = source.indexOf('\n} as const', start)
    const body = source.slice(start, end === -1 ? source.length : end)
    for (const field of ['visibility', 'operatorOnly'] as const) {
      if (!new RegExp(`^\\s{2}${field}:`, 'm').test(body)) {
        findings.push({
          check: 'contract-totality',
          where: `${where}:${lineOf(source, match.index)}`,
          detail:
            `\`${match[1]}\` declares no \`${field}\` — ADR 3 D3 rule 1 / ADR 9 D4: the ` +
            'default-closed answer must be WRITTEN, never reached by leaving the field off. For ' +
            '`visibility` this is the only check that can see the difference at all, because the ' +
            'backstop’s answer for an unclassified row (`personal`) is also this family’s answer.',
        })
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 6 — the operator-only claim is not quietly widened
// ---------------------------------------------------------------------------

/**
 * An `exposure` naming an agent transport is the one edit that turns this surface
 * agent-reachable, and it is a one-word diff. `modules/automations/trpc.ts` refuses
 * at module load, but that is a RUNTIME check in a file someone could also edit;
 * this reads the contracts' own text.
 */
export function widenedExposure(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const match of source.matchAll(
    /^const SERVED_ON: readonly TransportTag\[\] = (\[.*\])$/gm,
  )) {
    if (match[1] !== "['trpc']") {
      findings.push({
        check: 'operator-only',
        where: `${where}:${lineOf(source, match.index)}`,
        detail:
          `the automation exposure set is ${match[1]}, not ['trpc'] — an automation spawns agent ` +
          'sessions, so opening it to another transport is a policy decision and not an exposure edit',
      })
    }
  }
  for (const match of source.matchAll(/^\s{2}exposure: \[/gm)) {
    findings.push({
      check: 'operator-only',
      where: `${where}:${lineOf(source, match.index)}`,
      detail:
        'a contract declares an inline `exposure` array instead of the shared SERVED_ON cell — the ' +
        'operator-only claim is checked on that cell, so an inline set walks around it',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function auditAutomationCommands(): Finding[] {
  const missing = missingSubjects()
  if (missing.length > 0) return missing
  const router = read(ROUTER)
  const contracts = read(CONTRACTS)
  return [
    ...handWrittenMutations(router, ROUTER),
    ...missingDerivedSpread(router, ROUTER),
    ...resurrectedSchemas(router, ROUTER),
    ...duplicateCronParser(contracts),
    ...undeclaredContractFields(contracts, CONTRACTS),
    ...widenedExposure(contracts, CONTRACTS),
  ]
}

// ---------------------------------------------------------------------------
// The probe — every check, against a fixture that contains what it hunts AND a
// clean one it must stay silent on
// ---------------------------------------------------------------------------

const PROBE_ROUTER_WITH_MUTATION = [
  '  automations: t.router({',
  '    list: t.procedure.query(({ ctx }) => mods(ctx).automations.list()),',
  '    ...automationProcedures(),',
  '    // planted at the END of the block: a line-based reader stops before here',
  '    sneak: t.procedure.mutation(({ ctx }) => mods(ctx).automations.list()),',
  '  }),',
].join('\n')

const PROBE_ROUTER_CLEAN = [
  '  automations: t.router({',
  '    list: t.procedure.query(({ ctx }) => mods(ctx).automations.list()),',
  '    runs: t.procedure',
  '      .input(z.object({ automationId: z.string().min(1) }))',
  '      .query(({ ctx, input }) => mods(ctx).automations.runs(input.automationId)),',
  '    ...automationProcedures(),',
  '  }),',
].join('\n')

const PROBE_CONTRACTS_CLEAN = [
  "const SERVED_ON: readonly TransportTag[] = ['trpc']",
  '',
  "import { isValidCron } from './cron'",
  '',
  'export const automationCreateContract = {',
  "  name: 'automations.create',",
  '  version: 1,',
  '  operatorOnly: true,',
  "  visibility: 'personal',",
  '  exposure: SERVED_ON,',
  '} as const satisfies AutomationCommandContract',
].join('\n')

const PROBE_CONTRACTS_DIRTY = [
  "const SERVED_ON: readonly TransportTag[] = ['trpc', 'relay']",
  '',
  'export const automationCreateContract = {',
  "  name: 'automations.create',",
  '  version: 1,',
  "  exposure: ['trpc', 'mcp'],",
  '} as const satisfies AutomationCommandContract',
].join('\n')

function probe(): Finding[] {
  const failures: Finding[] = []
  const fail = (detail: string): void => {
    failures.push({ check: 'instrument', where: 'scripts/audit-automation-commands.ts', detail })
  }
  const expect = (check: string, found: Finding[]): void => {
    if (found.length === 0) {
      fail(`the ${check} check found nothing in a fixture that contains one — it cannot say YES`)
    }
  }
  const expectSilent = (check: string, found: Finding[]): void => {
    if (found.length > 0) {
      fail(`the ${check} check fires on a CLEAN fixture — it cannot say NO: ${found[0]?.detail}`)
    }
  }

  expect(
    'subject-present',
    missingSubjects(() => false),
  )
  expectSilent(
    'subject-present',
    missingSubjects(() => true),
  )

  expect('derived-surface', handWrittenMutations(PROBE_ROUTER_WITH_MUTATION, '<probe>'))
  // A VANISHED router is a finding, not silence — the arm that turns "I renamed
  // the router" into a red rather than into a serene zero.
  expect('derived-surface', handWrittenMutations('const nothing = 1\n', '<probe>'))
  expectSilent('derived-surface', handWrittenMutations(PROBE_ROUTER_CLEAN, '<probe>'))

  expect(
    'derived-surface-present',
    missingDerivedSpread(
      '  automations: t.router({\n    list: t.procedure.query(() => []),\n  }),',
      '<probe>',
    ),
  )
  expectSilent('derived-surface-present', missingDerivedSpread(PROBE_ROUTER_CLEAN, '<probe>'))

  expect(
    'one-schema',
    resurrectedSchemas('const automationPatch = automationFields.partial()\n', '<probe>'),
  )
  expectSilent(
    'one-schema',
    resurrectedSchemas('// automationPatch moved to @podium/commands\n', '<probe>'),
  )

  expect(
    'one-cron-parser',
    duplicateCronParser(PROBE_CONTRACTS_CLEAN, () => true),
  )
  expect(
    'one-cron-parser',
    duplicateCronParser('no import here', () => false),
  )
  expectSilent(
    'one-cron-parser',
    duplicateCronParser(PROBE_CONTRACTS_CLEAN, () => false),
  )

  expect('contract-totality', undeclaredContractFields(PROBE_CONTRACTS_DIRTY, '<probe>'))
  expectSilent('contract-totality', undeclaredContractFields(PROBE_CONTRACTS_CLEAN, '<probe>'))

  expect('operator-only', widenedExposure(PROBE_CONTRACTS_DIRTY, '<probe>'))
  expectSilent('operator-only', widenedExposure(PROBE_CONTRACTS_CLEAN, '<probe>'))

  return failures
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Automation-surface audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log(
      'automation-surface audit: all 6 checks found their planted fixtures and stayed silent on the clean ones',
    )
    return
  }

  const findings = auditAutomationCommands()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Automation-surface audit: ${findings.length} finding(s). POD-735's claims are:\n` +
        '  · every automation write is DERIVED from its contract (no hand-written procedure)\n' +
        '  · the derived procedures are actually SPREAD (an empty router is not a pass)\n' +
        '  · the router’s deleted input schemas have not regrown beside the contracts\n' +
        '  · ONE cron parser, at L1, and it is what the contracts validate with\n' +
        '  · every contract DECLARES its visibility class and its operator-only policy\n' +
        '  · the operator-only exposure set has not been widened\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'automation-surface audit OK — the automations surface is derived and present, one schema set, ' +
      'one cron parser, every contract classified and operator-only',
  )
}

if (import.meta.main) main()

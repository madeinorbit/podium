/**
 * THE FLEET-SURFACE AUDIT (POD-384; the machines / repos / discovery family).
 *
 * Run:
 *   bun run audit:fleet            # the gate — exit 1 on any finding
 *   bun run audit:fleet --json
 *   bun run audit:fleet --probe    # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS OF DIFFERENT KINDS, AND THIS IS THE TEXTUAL ONE
 * ---------------------------------------------------------------------------
 *
 * `apps/server/src/server.role.test.ts` reads the RUNNING system: it boots a real
 * server with `role: { hub: false }`, drives it over a real HTTP tRPC client, and
 * proves the fleet-admin procs answer 404 while the core ones still work. It is
 * the only thing that can show a gate actually refuses.
 *
 * This script resolves no modules and reads source TEXT. It runs in a fresh
 * checkout, in a worktree with no local install of the `@podium` scope, and
 * before anything is built. It catches the textual regressions a runtime check
 * cannot see: a hand-written `.mutation(` reappearing inside one of the three
 * router literals, a second `hubProc` growing back beside the derived one, a
 * contract added without the `serverRole` or `visibility` line.
 *
 * ---------------------------------------------------------------------------
 * AN EMPTY ROUTER SATISFIES EVERY ABSENCE CLAIM PERFECTLY (POD-732)
 * ---------------------------------------------------------------------------
 *
 * "No hand-written mutation in the `repos` router" is true of a `repos` router
 * with nothing in it at all, and true of a `router.ts` that failed to spread the
 * derived procedures. So check 2 is a PRESENCE claim — each of the three blocks
 * must carry its `...fleet.<router>` spread — and it is what stops check 1 from
 * being satisfiable by deletion.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * The absence checks below are exactly what a broken instrument reports. `probe()`
 * runs each against a planted fixture containing the thing it hunts and FAILS if
 * the check does not find it. It runs FIRST, always, with or without the flag.
 */

import { readFileSync } from 'node:fs'
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
const CONTRACTS = 'packages/commands/src/fleet/contracts.ts'

/** The three routers this family serves, and the derived spread each must carry. */
export const FLEET_ROUTERS = ['machines', 'repos', 'discovery'] as const

/**
 * The ONE hand-written mutation allowed in these blocks, with its reason.
 *
 * `discovery.scan` scans CONVERSATIONS (`rpc.scan()` returns
 * `{ conversations, diagnostics }`) and belongs to the session-discovery family;
 * it shares this router's name and nothing else. Allowlisted BY KEY and only on
 * the `discovery` router, so the same key appearing under `repos` would still be
 * a finding — an allowlist that forgave a name everywhere would be a hole.
 */
export const ALLOWED_HAND_WRITTEN: Readonly<Record<string, readonly string[]>> = {
  discovery: ['scan'],
}

/**
 * Extract a `<name>: t.router({ … })` literal by BRACE MATCHING.
 *
 * Not a line scan: these literals contain nested objects, template strings and
 * comments, and a line-based reader stops at the first `})` — which would report
 * a serene zero for a mutation written anywhere after it. `--probe` plants its
 * mutation at the END of the block for exactly that reason.
 *
 * Returns `undefined` when the router is absent, which every caller treats as a
 * FINDING and never as a pass: a router that vanished is not a router with no
 * hand-written mutations.
 */
export function routerBlock(
  source: string,
  name: string,
): { text: string; startLine: number } | undefined {
  const marker = new RegExp(`^\\s{2}${name}: t\\.router\\(`, 'm')
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

/** The procedure key a `.mutation(` belongs to — the nearest `  <key>: ` above it. */
function keyAbove(block: string, index: number): string {
  const before = block.slice(0, index)
  const keys = [...before.matchAll(/\n\s{4}(\w+):/g)]
  return keys.length > 0 ? (keys[keys.length - 1]?.[1] ?? '?') : '?'
}

// ---------------------------------------------------------------------------
// 1 — no hand-written mutation in the three fleet routers
// ---------------------------------------------------------------------------

export function handWrittenFleetMutations(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const router of FLEET_ROUTERS) {
    const block = routerBlock(source, router)
    if (!block) {
      findings.push({
        check: 'derived-surface',
        where,
        detail: `no \`${router}: t.router(\` literal found — the scan has nothing to check`,
      })
      continue
    }
    const allowed = ALLOWED_HAND_WRITTEN[router] ?? []
    for (const match of block.text.matchAll(/\.mutation\(/g)) {
      const key = keyAbove(block.text, match.index)
      if (allowed.includes(key)) continue
      findings.push({
        check: 'derived-surface',
        where: `${where}:${block.startLine + lineOf(block.text, match.index) - 1}`,
        detail:
          `hand-written \`.mutation(\` for \`${router}.${key}\` — every fleet write is derived ` +
          'from its contract by modules/fleet/trpc.ts, which is also where its role gate comes from',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the derived surface is actually SPREAD (an empty router is not a pass)
// ---------------------------------------------------------------------------

export function missingDerivedSpread(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const router of FLEET_ROUTERS) {
    const block = routerBlock(source, router)
    if (!block) continue // already reported by check 1
    if (!block.text.includes(`...fleet.${router}`)) {
      findings.push({
        check: 'derived-surface-present',
        where: `${where}:${block.startLine}`,
        detail:
          `the \`${router}\` router does not spread \`...fleet.${router}\` — an empty router ` +
          'satisfies every absence claim in this audit perfectly, so presence is checked too',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — the role gate lives with the contracts, not beside the router
// ---------------------------------------------------------------------------

/**
 * A `hubProc` rebuilt in `router.ts` is how the gate goes back to being a
 * call-site habit: the next fleet procedure is gated because someone remembered,
 * and the one after that is not. The guard has ONE home
 * (`modules/fleet/trpc.ts`) and the contract's `serverRole` decides who gets it.
 *
 * Keyed on the DECLARATION, not on any mention, so the comments explaining the
 * move do not fire it.
 */
export function resurrectedHubProc(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  const patterns: Array<[RegExp, string]> = [
    [
      /^const hubProc\b/m,
      '`hubProc` is back in the router — the hub gate is derived from each contract’s ' +
        '`serverRole` in modules/fleet/trpc.ts, so a second one here can only disagree with it',
    ],
    [
      /^const hubRoleGuard\b/m,
      '`hubRoleGuard` is back in the router — the middleware has one home, beside the contracts ' +
        'that declare which commands need it',
    ],
  ]
  for (const [pattern, detail] of patterns) {
    const match = pattern.exec(source)
    if (match) {
      findings.push({
        check: 'one-role-gate',
        where: `${where}:${lineOf(source, match.index)}`,
        detail,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — every fleet contract declares its visibility class AND its server role
// ---------------------------------------------------------------------------

/**
 * Both fields are REQUIRED at the type level, so this looks redundant — and it is
 * not, for the reason POD-731 hit: a widening cast (`as unknown as`) over the
 * table compiles happily with a field missing from every entry, silently
 * defeating the compile-time half of the default-closed rule. A textual check
 * cannot be cast away.
 *
 * Keyed on the contract literal's opening line, so a contract added without the
 * line is found wherever in the object it would have gone.
 */
export function undeclaredContractFields(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const match of source.matchAll(/^export const (\w+Contract) = \{\n/gm)) {
    const start = match.index + match[0].length
    const end = source.indexOf('\n} as const', start)
    const body = source.slice(start, end === -1 ? source.length : end)
    for (const field of ['visibility', 'serverRole'] as const) {
      if (!new RegExp(`^\\s{2}${field}:`, 'm').test(body)) {
        findings.push({
          check: 'contract-totality',
          where: `${where}:${lineOf(source, match.index)}`,
          detail:
            `\`${match[1]}\` declares no \`${field}\` — ADR 3 D3 rule 1 / ADR 9 D4: the ` +
            'default-closed answer must be WRITTEN, never reached by leaving the field off',
        })
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function auditFleetCommands(): Finding[] {
  const router = read(ROUTER)
  const contracts = read(CONTRACTS)
  return [
    ...handWrittenFleetMutations(router, ROUTER),
    ...missingDerivedSpread(router, ROUTER),
    ...resurrectedHubProc(router, ROUTER),
    ...undeclaredContractFields(contracts, CONTRACTS),
  ]
}

// ---------------------------------------------------------------------------
// The probe — every check, against a fixture that contains what it hunts
// ---------------------------------------------------------------------------

const PROBE_ROUTER_WITH_MUTATION = [
  '  repos: t.router({',
  '    list: t.procedure.query(({ ctx }) => ctx.repos.list()),',
  '    ...fleet.repos,',
  '    // planted at the END of the block: a line-based reader stops before here',
  '    sneak: t.procedure.mutation(({ ctx }) => ctx.repos.list()),',
  '  }),',
].join('\n')

const PROBE_ROUTER_CLEAN = [
  '  machines: t.router({',
  '    list: t.procedure.query(({ ctx }) => []),',
  '    ...fleet.machines,',
  '  }),',
  '  repos: t.router({',
  '    ...fleet.repos,',
  '  }),',
  '  discovery: t.router({',
  '    scan: t.procedure.mutation(({ ctx }) => mods(ctx).rpc.scan()),',
  '    ...fleet.discovery,',
  '  }),',
].join('\n')

function probe(): Finding[] {
  const failures: Finding[] = []
  const expect = (check: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-fleet-commands.ts',
        detail: `the ${check} check found nothing in a fixture that contains one — it cannot say YES`,
      })
    }
  }

  expect('derived-surface', handWrittenFleetMutations(PROBE_ROUTER_WITH_MUTATION, '<probe>'))
  // …and it must NOT fire on the allowlisted conversation scan, or the allowlist
  // is decorative and the check is firing on the shape rather than on the name.
  if (handWrittenFleetMutations(PROBE_ROUTER_CLEAN, '<probe>').length > 0) {
    failures.push({
      check: 'instrument',
      where: 'scripts/audit-fleet-commands.ts',
      detail:
        'the derived-surface check fires on a CLEAN fixture (or on the allowlisted ' +
        '`discovery.scan`) — it cannot say NO',
    })
  }

  expect(
    'derived-surface-present',
    missingDerivedSpread(
      '  repos: t.router({\n    list: t.procedure.query(() => []),\n  }),',
      '<probe>',
    ),
  )
  if (missingDerivedSpread(PROBE_ROUTER_CLEAN, '<probe>').length > 0) {
    failures.push({
      check: 'instrument',
      where: 'scripts/audit-fleet-commands.ts',
      detail: 'the spread-presence check fires on a router that DOES spread — it cannot say NO',
    })
  }

  expect(
    'one-role-gate',
    resurrectedHubProc('const hubProc = t.procedure.use(hubRoleGuard)\n', '<probe>'),
  )
  if (resurrectedHubProc('// hubProc moved to modules/fleet/trpc.ts\n', '<probe>').length > 0) {
    failures.push({
      check: 'instrument',
      where: 'scripts/audit-fleet-commands.ts',
      detail: 'the one-role-gate check fires on a COMMENT mentioning hubProc — it cannot say NO',
    })
  }

  expect(
    'contract-totality',
    undeclaredContractFields(
      [
        'export const fineContract = {',
        "  name: 'machines.fine',",
        "  visibility: 'owned-compute',",
        "  serverRole: 'hub',",
        '} as const satisfies FleetCommandContract',
        '',
        'export const forgottenContract = {',
        "  name: 'machines.forgotten',",
        '  version: 1,',
        '} as const satisfies FleetCommandContract',
      ].join('\n'),
      '<probe>',
    ),
  )
  return failures
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Fleet-surface audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('fleet-surface audit: all 4 probes found their planted fixtures')
    return
  }

  const findings = auditFleetCommands()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Fleet-surface audit: ${findings.length} finding(s). POD-384's claims are:\n` +
        '  · every fleet mutation is DERIVED from its contract (no hand-written procedure)\n' +
        '  · the derived procedures are actually SPREAD (an empty router is not a pass)\n' +
        '  · the hub role gate has ONE home, driven by each contract’s `serverRole`\n' +
        '  · every fleet contract DECLARES its visibility class and its server role\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'fleet-surface audit OK — the fleet surface is derived and present, the role gate has one ' +
      'home, every contract declares its class and its role',
  )
}

if (import.meta.main) main()

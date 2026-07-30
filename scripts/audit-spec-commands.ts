/**
 * THE SPEC-SURFACE AUDIT (POD-386; the pspec `specs.*` family).
 *
 * Run:
 *   bun run audit:spec            # the gate — exit 1 on any finding
 *   bun run audit:spec --json
 *   bun run audit:spec --probe    # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS OF DIFFERENT KINDS, AND THIS IS THE TEXTUAL ONE
 * ---------------------------------------------------------------------------
 *
 * `apps/server/src/modules/specs/spec-trpc.runtime.test.ts` reads the RUNNING
 * system: it inspects the built `appRouter`, asserts the three writes are
 * MUTATIONS on it, and drives one through a real `SpecsService` over a real temp
 * repo to show the derived procedure dispatches. It is the only thing that can
 * show the surface actually answers.
 *
 * This script resolves no modules and reads source TEXT. It runs in a fresh
 * checkout, in a worktree with no local install of the `@podium` scope, and
 * before anything is built. It catches the textual regressions a runtime check
 * cannot see: a hand-written `.mutation(` growing back inside the `specs` router
 * literal, the derived spread being dropped, a fourth contract added without its
 * `visibility` line, or the schema identity POD-385 established being quietly
 * restated.
 *
 * ---------------------------------------------------------------------------
 * AN EMPTY ROUTER SATISFIES EVERY ABSENCE CLAIM PERFECTLY (POD-732)
 * ---------------------------------------------------------------------------
 *
 * "No hand-written mutation in the `specs` router" is true of a `specs` router
 * with nothing in it at all, and true of a `router.ts` that failed to spread the
 * derived procedures. So check 2 is a PRESENCE claim — the block must carry
 * `...specFamily` — and it is what stops check 1 from being satisfiable by
 * deletion. `routerBlock` returning `undefined` is likewise always a FINDING and
 * never a pass: a router that vanished is not a router with no mutations.
 *
 * ---------------------------------------------------------------------------
 * CHECK 4 IS THE ONE THE GOLDEN FIXTURES CANNOT MAKE (POD-305)
 * ---------------------------------------------------------------------------
 *
 * `specsInputs.create` must BE `specsCreateInput`, not a restatement of it. A
 * restated schema with the same fields is byte-identical on the wire and passes
 * every golden fixture in the repo; only object identity sees the fork. The
 * runtime test asserts that identity with `toBe`, and this check catches the
 * textual shape that produces it — a `z.object({…})` literal where the contract's
 * schema should be — in a checkout where nothing can be imported.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Three of the four checks below are ABSENCE claims, which is exactly what a
 * broken instrument reports. `probe()` runs each against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it; where a
 * check could plausibly over-fire it is also run against a clean fixture and must
 * find nothing. It runs FIRST, always, with or without the flag.
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
const CONTRACTS = 'packages/commands/src/specs/contracts.ts'
const SERVICE = 'apps/server/src/modules/specs/service.ts'

/** The one router this family serves, and the derived spread it must carry. */
export const SPEC_ROUTER = 'specs'
export const SPEC_SPREAD = '...specFamily'

/** The three WRITES. The reads (`list`, `get`, `search`) are deliberately not
 *  here — they carry no contract, because a `visibility` class describes what a
 *  command WRITES. This audit checks procedure TYPE, so a write cannot hide
 *  among them by being spelled as a query. */
export const SPEC_WRITES = ['create', 'save', 'remove'] as const

/**
 * Extract a `<name>: t.router({ … })` literal by BRACE MATCHING.
 *
 * Not a line scan: these literals contain nested objects, template strings and
 * comments, and a line-based reader stops at the first `})` — which would report
 * a serene zero for a mutation written anywhere after it. `--probe` plants its
 * mutation at the END of the block for exactly that reason.
 *
 * Returns `undefined` when the router is absent, which every caller treats as a
 * FINDING and never as a pass.
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
// 1 — no hand-written mutation in the specs router
// ---------------------------------------------------------------------------

/**
 * There is NO allowlist here, unlike the fleet audit's `discovery.scan`. Every
 * write this router serves is one of the three contracted ones, so a
 * `.mutation(` in this block is a finding without exception — and adding a
 * fourth spec write means adding a contract, which is the point.
 */
export function handWrittenSpecMutations(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  const block = routerBlock(source, SPEC_ROUTER)
  if (!block) {
    return [
      {
        check: 'derived-surface',
        where,
        detail: `no \`${SPEC_ROUTER}: t.router(\` literal found — the scan has nothing to check`,
      },
    ]
  }
  for (const match of block.text.matchAll(/\.mutation\(/g)) {
    const key = keyAbove(block.text, match.index)
    findings.push({
      check: 'derived-surface',
      where: `${where}:${block.startLine + lineOf(block.text, match.index) - 1}`,
      detail:
        `hand-written \`.mutation(\` for \`specs.${key}\` — every spec write is derived from ` +
        'its contract by modules/specs/trpc.ts, which is also where its exposure decision comes from',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the derived surface is actually SPREAD (an empty router is not a pass)
// ---------------------------------------------------------------------------

export function missingDerivedSpread(source: string, where: string): Finding[] {
  const block = routerBlock(source, SPEC_ROUTER)
  if (!block) return [] // already reported by check 1
  if (block.text.includes(SPEC_SPREAD)) return []
  return [
    {
      check: 'derived-surface-present',
      where: `${where}:${block.startLine}`,
      detail:
        `the \`${SPEC_ROUTER}\` router does not spread \`${SPEC_SPREAD}\` — an empty router ` +
        'satisfies every absence claim in this audit perfectly, so presence is checked too',
    },
  ]
}

// ---------------------------------------------------------------------------
// 3 — every spec contract declares its visibility class
// ---------------------------------------------------------------------------

/**
 * `visibility` is REQUIRED at the type level, so this looks redundant — and it is
 * not, for the reason POD-731 hit: a widening cast (`as unknown as`) over the
 * table compiles happily with a field missing from every entry, silently
 * defeating the compile-time half of the default-closed rule. A textual check
 * cannot be cast away.
 *
 * `exposure` is checked with it. POD-385's classification note is that
 * `visibilityClassOf` answered `personal` from ADR 9 D4's default-closed
 * BACKSTOP before the `pspec-component` row existed — the backstop firing looks
 * exactly like a declaration, which is why the declaration must be written.
 */
export function undeclaredContractFields(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const match of source.matchAll(/^export const (\w+Contract) = \{\n/gm)) {
    const start = match.index + match[0].length
    const end = source.indexOf('\n} as const', start)
    const body = source.slice(start, end === -1 ? source.length : end)
    for (const field of ['visibility', 'exposure'] as const) {
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
// 4 — the service mounts the CONTRACT'S schema, not a restatement of it
// ---------------------------------------------------------------------------

/**
 * The write entries in `specsInputs` must name the contract's exported schema.
 * A `z.object({…})` there would be a restatement: byte-identical on the wire,
 * invisible to every golden fixture, and a fork the moment either side is edited
 * (POD-305). The reads are exempt and expected to be local literals — they have
 * no contract to point at.
 */
export function restatedWriteSchemas(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  const open = source.indexOf('export const specsInputs = {')
  if (open === -1) {
    return [
      {
        check: 'one-schema-instance',
        where,
        detail:
          'no `export const specsInputs = {` table found — the scan has nothing to check, which ' +
          'is not the same as the schemas being shared',
      },
    ]
  }
  const end = source.indexOf('\n} as const', open)
  const table = source.slice(open, end === -1 ? source.length : end)
  const expected: Record<string, string> = {
    create: 'specsCreateInput',
    save: 'specsSaveInput',
    remove: 'specsRemoveInput',
  }
  for (const write of SPEC_WRITES) {
    const entry = new RegExp(`^\\s{2}${write}:\\s*(.+?),\\s*$`, 'm').exec(table)
    if (!entry) {
      findings.push({
        check: 'one-schema-instance',
        where: `${where}:${lineOf(source, open)}`,
        detail: `\`specsInputs.${write}\` is absent — the contracted write is not mounted at all`,
      })
      continue
    }
    if (entry[1]?.trim() !== expected[write]) {
      findings.push({
        check: 'one-schema-instance',
        where: `${where}:${lineOf(source, open + entry.index)}`,
        detail:
          `\`specsInputs.${write}\` is \`${entry[1]?.trim()}\` and not the contract's own ` +
          `\`${expected[write]}\` — a restated schema is byte-identical on the wire and passes ` +
          'every golden fixture; only object identity sees the fork (POD-305)',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function auditSpecCommands(): Finding[] {
  const router = read(ROUTER)
  return [
    ...handWrittenSpecMutations(router, ROUTER),
    ...missingDerivedSpread(router, ROUTER),
    ...undeclaredContractFields(read(CONTRACTS), CONTRACTS),
    ...restatedWriteSchemas(read(SERVICE), SERVICE),
  ]
}

// ---------------------------------------------------------------------------
// The probe — every check, against a fixture that contains what it hunts
// ---------------------------------------------------------------------------

const PROBE_ROUTER_WITH_MUTATION = [
  '  specs: t.router({',
  '    list: t.procedure.input(specsInputs.list).query(({ ctx, input }) => []),',
  '    ...specFamily,',
  '    // planted at the END of the block: a line-based reader stops before here',
  '    sneak: t.procedure.mutation(({ ctx, input }) => mods(ctx).specs.create(input)),',
  '  }),',
].join('\n')

const PROBE_ROUTER_CLEAN = [
  '  specs: t.router({',
  '    list: t.procedure.input(specsInputs.list).query(({ ctx, input }) => []),',
  '    get: t.procedure.input(specsInputs.get).query(({ ctx, input }) => null),',
  '    ...specFamily,',
  '    search: t.procedure.input(specsInputs.search).query(({ ctx, input }) => []),',
  '  }),',
].join('\n')

const PROBE_SERVICE_CLEAN = [
  'export const specsInputs = {',
  '  list: z.object({ ...byRepo }),',
  '  create: specsCreateInput,',
  '  save: specsSaveInput,',
  '  remove: specsRemoveInput,',
  '  search: z.object({ ...byRepo, query: z.string() }),',
  '} as const',
].join('\n')

const PROBE_SERVICE_RESTATED = [
  'export const specsInputs = {',
  '  create: z.object({ ...byRepo, title: z.string().min(1), parent: z.string() }),',
  '  save: specsSaveInput,',
  '  remove: specsRemoveInput,',
  '} as const',
].join('\n')

function probe(): Finding[] {
  const failures: Finding[] = []
  const cannotSayYes = (check: string): Finding => ({
    check: 'instrument',
    where: 'scripts/audit-spec-commands.ts',
    detail: `the ${check} check found nothing in a fixture that contains one — it cannot say YES`,
  })
  const cannotSayNo = (check: string, why: string): Finding => ({
    check: 'instrument',
    where: 'scripts/audit-spec-commands.ts',
    detail: `the ${check} check fires on ${why} — it cannot say NO`,
  })
  const expect = (check: string, found: Finding[]): void => {
    if (found.length === 0) failures.push(cannotSayYes(check))
  }

  expect('derived-surface', handWrittenSpecMutations(PROBE_ROUTER_WITH_MUTATION, '<probe>'))
  if (handWrittenSpecMutations(PROBE_ROUTER_CLEAN, '<probe>').length > 0) {
    failures.push(cannotSayNo('derived-surface', 'a CLEAN specs router'))
  }
  // A missing router must be a finding and never a serene pass.
  expect('derived-surface', handWrittenSpecMutations('const nothing = 1\n', '<probe>'))

  expect(
    'derived-surface-present',
    missingDerivedSpread(
      '  specs: t.router({\n    list: t.procedure.query(() => []),\n  }),',
      '<probe>',
    ),
  )
  if (missingDerivedSpread(PROBE_ROUTER_CLEAN, '<probe>').length > 0) {
    failures.push(cannotSayNo('derived-surface-present', 'a router that DOES spread'))
  }

  expect(
    'contract-totality',
    undeclaredContractFields(
      [
        'export const fineContract = {',
        "  name: 'specs.fine',",
        "  visibility: 'owned-compute',",
        '  exposure: SERVED_ON,',
        '} as const satisfies CommandContract<typeof x>',
        '',
        'export const forgottenContract = {',
        "  name: 'specs.forgotten',",
        '  version: 1,',
        '} as const satisfies CommandContract<typeof y>',
      ].join('\n'),
      '<probe>',
    ),
  )

  expect('one-schema-instance', restatedWriteSchemas(PROBE_SERVICE_RESTATED, '<probe>'))
  if (restatedWriteSchemas(PROBE_SERVICE_CLEAN, '<probe>').length > 0) {
    failures.push(
      cannotSayNo('one-schema-instance', 'a table that DOES mount the contract schemas'),
    )
  }
  // An absent table is a finding, not a pass — nothing to read is not "shared".
  expect('one-schema-instance', restatedWriteSchemas('const unrelated = 1\n', '<probe>'))
  return failures
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Spec-surface audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('spec-surface audit: all 4 probes found their planted fixtures')
    return
  }

  const findings = auditSpecCommands()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Spec-surface audit: ${findings.length} finding(s). POD-386's claims are:\n` +
        '  · every spec write is DERIVED from its contract (no hand-written procedure)\n' +
        '  · the derived procedures are actually SPREAD (an empty router is not a pass)\n' +
        '  · every spec contract DECLARES its visibility class and its exposure\n' +
        '  · the service mounts the CONTRACT’s schema instance, not a restatement of it\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'spec-surface audit OK — the spec surface is derived and present, every contract declares ' +
      'its class and its exposure, and one schema instance serves every transport',
  )
}

if (import.meta.main) main()

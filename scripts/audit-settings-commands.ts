/**
 * THE SETTINGS-SURFACE AUDIT (POD-420; the ninth family gate).
 *
 * Run:
 *   bun run audit:settings            # the gate — exit 1 on any finding
 *   bun run audit:settings --json
 *   bun run audit:settings --probe    # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS OF DIFFERENT KINDS, AND THIS IS THE TEXTUAL ONE
 * ---------------------------------------------------------------------------
 *
 * `apps/server/src/router.settings-guard.test.ts` reads the RUNNING object: the
 * built `appRouter`'s `_def.procedures` and the verbs tRPC will enforce. It is
 * the only one that can see what is actually served.
 *
 * This script resolves no modules and reads source TEXT. It runs in a fresh
 * checkout, in a worktree with no local install of the `@podium` scope, and
 * before anything is built. It catches what a runtime check cannot: a
 * hand-written `.mutation(` reappearing in the `settings` router, an `outbox`
 * tag added to a settings contract, the secret guard being deleted from the
 * legacy blob write, or a settings command acquiring a client outbox executor.
 *
 * ---------------------------------------------------------------------------
 * AN EMPTY ROUTER SATISFIES EVERY ABSENCE CLAIM PERFECTLY (POD-732)
 * ---------------------------------------------------------------------------
 *
 * "No hand-written mutation beyond the named three" is true of a `settings`
 * router with nothing in it at all, and true of a `router.ts` that failed to
 * spread the derived procedures. So check 2 is a PRESENCE claim — the block must
 * carry `...settingsFamily` — and check 1's exception list is checked in BOTH
 * directions: a named exception that VANISHED is a finding too, because an
 * absorbed surface reads as progress on every ratchet (POD-386's rule, which
 * this family inherits).
 *
 * ---------------------------------------------------------------------------
 * ANCHOR ON NESTING DEPTH, NEVER ON COLUMNS
 * ---------------------------------------------------------------------------
 *
 * Two issues have been bitten by a matcher anchored on FORMATTING: POD-386 found
 * the per-family audits keying the procedure name off a fixed indentation (which
 * named the last field of an inline `z.object` as the procedure), and POD-301
 * found biome splitting a derivation across three lines so a line-anchored
 * matcher read it as a literal. Hand-formatting is undone by the next
 * `bun run format`, so {@link procedureKeys} tracks BRACE DEPTH and attributes a
 * `.mutation(` to the nearest key at the router's own level. The probe fixture
 * contains a nested `z.object` whose last field would fool a column matcher.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Most of what follows is an absence or an equality claim, which is exactly what
 * a broken parser reports. `probe()` runs each check against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it; each is
 * also run against a clean fixture and must find nothing. It runs FIRST, always,
 * with or without the flag.
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
const CONTRACTS = 'packages/commands/src/settings/contracts.ts'
const SERVICE = 'apps/server/src/modules/settings/service.ts'
const CLIENT_OUTBOX = 'packages/client-core/src/outbox.ts'
const WEB_OUTBOX = 'apps/web/src/app/outbox.ts'

/** The derived spread the `settings` router must carry. */
export const DERIVED_SPREAD = '...settingsFamily'

/**
 * The hand-written writes this family still allows, BY KEY, each with its
 * reason. Checked in both directions: an unlisted key is an ungoverned write,
 * and a listed key that disappeared is a surface absorbed without a contract to
 * account for it.
 *
 *  - `set` — the legacy blob write. Still called by the sidebar, the
 *    auto-continue dialog and the engine, and it REFUSES a secret change
 *    (check 4). Retiring it belongs with POD-419's client scrub.
 * `telegramSetupStart` / `telegramSetupPoll` WERE HERE AND ARE GONE, which is
 * the direction this list is supposed to move. POD-420 deferred them —
 * "modelling a ceremony as a command contract is its own design question, and
 * ADR 9 D8's note that the inbound Telegram edge becomes an AUTHENTICATION
 * surface under multi-user says that question is bigger than this issue" — and
 * POD-1080 is that issue: they are contracted (ADR 3 Amendment 1 D22) and
 * derived like every other classified write, under the same wire keys. The
 * both-directions check is what makes their removal from this list mean
 * something: if they were still hand-written in `router.ts`, dropping them here
 * would fail check 1 rather than pass quietly.
 */
export const ALLOWED_HAND_WRITTEN: readonly string[] = ['set']

/**
 * Extract a `<name>: t.router({ … })` literal by BRACE MATCHING.
 *
 * Not a line scan: the literal contains nested objects, template strings and
 * comments, and a line-based reader stops at the first `})` — which would report
 * a serene zero for a mutation written anywhere after it.
 *
 * Returns `undefined` when the router is absent, which every caller treats as a
 * FINDING and never as a pass: a router that vanished is not a router with no
 * hand-written mutations.
 */
export function routerBlock(
  source: string,
  name: string,
): { text: string; startLine: number; offset: number } | undefined {
  const marker = new RegExp(`^\\s*${name}: t\\.router\\(`, 'm')
  const match = marker.exec(source)
  if (!match) return undefined
  const open = source.indexOf('(', match.index + match[0].length - 1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) {
        return {
          text: source.slice(open, i + 1),
          startLine: lineOf(source, match.index),
          offset: open,
        }
      }
    }
  }
  return undefined
}

/**
 * Every `.mutation(` in the block, attributed to the PROCEDURE KEY it belongs to
 * — by brace depth, never by column.
 *
 * The router literal is `({ key: …, key: … })`, so a procedure key is an
 * identifier followed by `:` at brace depth 1 relative to the block's opening
 * `{`. A key inside a nested `z.object({ … })` sits at depth 2+ and is ignored,
 * which is the case POD-386 found a column matcher getting wrong.
 */
export function procedureKeys(block: string): { key: string; index: number }[] {
  const out: { key: string; index: number }[] = []
  let depth = 0
  let current = '?'
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '.' && block.startsWith('.mutation(', i)) {
      out.push({ key: current, index: i })
    }
    if (depth !== 1) continue
    // A key at the router's own level: `<identifier>:` with only whitespace or a
    // separator before it.
    const key = /^(\w+)\s*:/.exec(block.slice(i))
    if (key?.[1] && /[\s{,]/.test(block[i - 1] ?? '')) current = key[1]
  }
  return out
}

// ---------------------------------------------------------------------------
// 1 — the settings router carries exactly the named hand-written writes
// ---------------------------------------------------------------------------

export function handWrittenDrift(source: string, where = ROUTER): Finding[] {
  const block = routerBlock(source, 'settings')
  if (!block) {
    return [
      {
        check: 'settings-router-present',
        where,
        detail:
          'no `settings: t.router(` literal — a router that VANISHED is not a router with no ' +
          'hand-written mutations, and every absence claim below would pass against it',
      },
    ]
  }
  const findings: Finding[] = []
  const found = procedureKeys(block.text)
  const keys = found.map((f) => f.key)
  for (const { key, index } of found) {
    if (ALLOWED_HAND_WRITTEN.includes(key)) continue
    findings.push({
      check: 'hand-written-write',
      where: `${where}:${lineOf(source, block.offset + index)}`,
      detail:
        `hand-written \`.mutation(\` for \`settings.${key}\` — the settings write surface is ` +
        'DERIVED from `SETTINGS_CONTRACTS` (POD-420), and a procedure written beside the derived ' +
        'ones is a second answer to "how is this authorized". Add a contract, or name the key in ' +
        '`ALLOWED_HAND_WRITTEN` with its reason.',
    })
  }
  // BOTH DIRECTIONS, no ratchet relief: a named exception that vanished is a
  // surface absorbed without a contract to account for it, and that reads as
  // progress on every ratchet in this repo (POD-386).
  for (const key of ALLOWED_HAND_WRITTEN) {
    if (keys.includes(key)) continue
    findings.push({
      check: 'hand-written-write',
      where: `${where}:${block.startLine}`,
      detail:
        `\`settings.${key}\` is GONE from the router. It is a NAMED exception, so its removal ` +
        'fails exactly as an addition does: either it was migrated (then it needs a contract and ' +
        'this list needs editing) or the surface was absorbed silently.',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — …and it carries the DERIVED spread (the presence claim)
// ---------------------------------------------------------------------------

export function derivedSpreadMissing(source: string, where = ROUTER): Finding[] {
  const block = routerBlock(source, 'settings')
  if (!block) return [] // reported by check 1; not counted twice
  if (block.text.includes(DERIVED_SPREAD)) return []
  return [
    {
      check: 'derived-spread',
      where: `${where}:${block.startLine}`,
      detail:
        `the \`settings\` router does not spread \`${DERIVED_SPREAD}\` — without it the contract ` +
        'table has no dispatcher (POD-385: a contract naming a transport nothing serves), and ' +
        'check 1 would be satisfied by a router that serves no settings write at all (POD-732).',
    },
  ]
}

// ---------------------------------------------------------------------------
// 3 — no settings contract may name the outbox
// ---------------------------------------------------------------------------

export function outboxExposure(contracts: string, where = CONTRACTS): Finding[] {
  const findings: Finding[] = []
  const exposure = /exposure:\s*(\[[^\]]*\])/g
  for (const match of contracts.matchAll(exposure)) {
    if (!match[1]?.includes('outbox')) continue
    findings.push({
      check: 'outbox-exposure',
      where: `${where}:${lineOf(contracts, match.index)}`,
      detail:
        'a settings contract names `outbox` in its exposure. ADR 3 D3 rule 2 forbids it for any ' +
        'class but offline-eligible, and ADR 1 D6 forbids a queued secret outright — POD-352: a ' +
        'generic offline settings write persists credential material into browser and mobile ' +
        'replica storage.',
    })
  }
  // The SERVED_ON constant is the family's single exposure cell; if it ever
  // grows `outbox` the literal above catches it, and if the cell is inlined per
  // contract the same regex still reads each one.
  return findings
}

/** No client outbox executor may name a settings command. The check the running
 *  router cannot make: an executor lives in the CLIENT, where the server's
 *  dispatch table has no visibility at all. */
export function outboxExecutors(sources: { rel: string; text: string }[]): Finding[] {
  const findings: Finding[] = []
  for (const { rel, text } of sources) {
    const match = /['"`]settings\.\w+['"`]/.exec(text)
    if (!match) continue
    findings.push({
      check: 'outbox-executor',
      where: `${rel}:${lineOf(text, match.index)}`,
      detail:
        `the client outbox names ${match[0]} — a settings command has acquired a queue executor. ` +
        'The preference commands MAY be queued (offline-eligible) but declare no `outbox` ' +
        'exposure, so landing one is a decision to retake deliberately (ADR 3 D3); the secret ' +
        'commands may never be queued at all.',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — the legacy blob write still refuses a secret change
// ---------------------------------------------------------------------------

/**
 * `settings.set` is the one command that can still address the whole blob, and
 * the ONLY thing stopping it writing credential material is the guard call
 * inside the blob write. Deleting that call is a one-line change that no test
 * name mentions and that every "the contracts are correct" assertion survives.
 *
 * POD-1213 renamed that method `setSettingsFor(userId, settings)` — the blob a
 * client posts now spans two homes, so the write takes the person it is made by.
 * The check follows the SIGNATURE rather than the bare name, so it keeps
 * pointing at the one method that can address the whole blob.
 *
 * Checked as SOURCE TEXT because that is the failure this instrument can see
 * before anything is built. `service.commands.test.ts` checks the BEHAVIOUR.
 */
export function secretGuardMissing(service: string, where = SERVICE): Finding[] {
  const declared = /private\s+assertNoSecretChange\s*\(/.test(service)
  const setSettings =
    /setSettingsFor\s*\(userId: UserId, settings: PodiumSettings\)\s*:\s*PodiumSettings\s*\{([\s\S]*?)\n {2}\}/.exec(
      service,
    )
  const called = setSettings ? /this\.assertNoSecretChange\(/.test(setSettings[1] ?? '') : false
  if (declared && called) return []
  return [
    {
      check: 'blob-secret-guard',
      where,
      detail: !declared
        ? '`assertNoSecretChange` is not declared — the legacy blob write can carry a secret again ' +
          '(ADR 1 D6 / POD-352)'
        : '`setSettings` does not CALL `assertNoSecretChange` — the guard exists and guards nothing, ' +
          'which is the shape a reviewer reads as protected',
    },
  ]
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function auditSettingsCommands(
  router: string,
  contracts: string,
  service: string,
  outboxes: { rel: string; text: string }[],
): Finding[] {
  return [
    ...handWrittenDrift(router),
    ...derivedSpreadMissing(router),
    ...outboxExposure(contracts),
    ...outboxExecutors(outboxes),
    ...secretGuardMissing(service),
  ]
}

// ---------------------------------------------------------------------------
// --probe — every check must find its planted fixture
// ---------------------------------------------------------------------------

/** A clean fixture: the derived spread, the one named exception, and a nested
 *  `z.object` whose LAST FIELD would fool a column-anchored matcher into naming
 *  it as the procedure (POD-386's defect, planted deliberately).
 *
 *  The decoy moved onto `set` when POD-1080 contracted the telegram ceremony and
 *  the exception list shrank to one. It had to move rather than be dropped: the
 *  POD-386 defect is about how a procedure KEY is chosen, and a fixture with no
 *  nested object literal stops exercising it. */
const PROBE_CLEAN_ROUTER = `
export const appRouter = t.router({
  settings: t.router({
    get: t.procedure.query(({ ctx }) => mods(ctx).settings.getSettings()),
    set: t.procedure
      .input(z.object({ values: PodiumSettings, decoy: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).settings.setSettings(input)),
    ...settingsFamily,
  }),
})
`

/** The same fixture with an UNGOVERNED write added after a nested block closed —
 *  the position a naive line scan stops before. */
const PROBE_SMUGGLED_ROUTER = PROBE_CLEAN_ROUTER.replace(
  '    ...settingsFamily,',
  `    ...settingsFamily,
    smuggled: t.procedure
      .input(z.object({ key: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).settings.smuggle(input)),`,
)

/** A fixture that lost a NAMED exception — the removal direction. An absorbed
 *  surface reads as progress on every ratchet, so it must be a finding. */
const PROBE_ABSORBED_ROUTER = PROBE_CLEAN_ROUTER.replace(
  `    set: t.procedure
      .input(z.object({ values: PodiumSettings, decoy: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).settings.setSettings(input)),\n`,
  '',
)

/** A fixture with no derived spread — check 1 passes against it perfectly. */
const PROBE_UNDERIVED_ROUTER = PROBE_CLEAN_ROUTER.replace('    ...settingsFamily,\n', '')

const PROBE_CLEAN_CONTRACTS = `const SERVED_ON: readonly TransportTag[] = ['trpc']
export const c = { name: 'settings.setSecret', exposure: SERVED_ON }
export const d = { name: 'settings.updatePersonal', exposure: ['trpc'] }
`
const PROBE_QUEUED_CONTRACTS = `export const c = { name: 'settings.setSecret', exposure: ['trpc', 'outbox'] }`

const PROBE_CLEAN_SERVICE = `  private assertNoSecretChange(previous: PodiumSettings, next: PodiumSettings): void {
    return
  }

  setSettingsFor(userId: UserId, settings: PodiumSettings): PodiumSettings {
    const previous = this.store.getSettingsFor(userId)
    this.assertNoSecretChange(previous, settings)
    this.store.setSettingsFor(userId, settings, now)
    return settings
  }
`
/** The guard declared but NOT called — "mechanism present, coverage absent". */
const PROBE_UNCALLED_SERVICE = PROBE_CLEAN_SERVICE.replace(
  '    this.assertNoSecretChange(previous, settings)\n',
  '',
)
const PROBE_UNGUARDED_SERVICE = PROBE_CLEAN_SERVICE.replace(
  'private assertNoSecretChange',
  'private somethingElse',
).replace('    this.assertNoSecretChange(previous, settings)\n', '')

const PROBE_CLEAN_OUTBOX = `const executors = { 'issues.close': close, 'sessions.rename': rename }`
const PROBE_QUEUED_OUTBOX = `const executors = { 'settings.setSecret': setSecret }`

export function probe(): Finding[] {
  const failures: Finding[] = []
  const at = 'scripts/audit-settings-commands.ts'
  const yes = (check: string, findings: Finding[], what: string): void => {
    if (findings.some((f) => f.check === check)) return
    failures.push({
      check: 'instrument',
      where: at,
      detail: `check \`${check}\` did not find its planted fixture (${what}) — it cannot say YES, so its silence on the real tree means nothing`,
    })
  }
  const no = (findings: Finding[], what: string): void => {
    if (findings.length === 0) return
    failures.push({
      check: 'instrument',
      where: at,
      detail: `a check fired on the CLEAN fixture (${what}): ${findings.map((f) => f.detail).join(' | ')}`,
    })
  }

  // The parser itself, on the shape a column matcher gets wrong.
  const keys = procedureKeys(routerBlock(PROBE_CLEAN_ROUTER, 'settings')?.text ?? '')
  if (!keys.every((k) => ALLOWED_HAND_WRITTEN.includes(k.key))) {
    failures.push({
      check: 'instrument',
      where: at,
      detail:
        `the depth parser attributed a mutation to ${JSON.stringify(keys.map((k) => k.key))} on a ` +
        'CLEAN fixture — a nested `z.object` field was read as the procedure key (POD-386), which ' +
        'is what anchoring on columns rather than nesting depth produces',
    })
  }
  // DERIVED from the allowlist rather than a literal (was `3` until POD-1080
  // shrank the list to one). The clean fixture is built to contain exactly the
  // allowed keys, so deriving it means adding an exception without extending the
  // fixture fires HERE — where a literal would just have to be re-typed. The
  // `> 0` half is the original point: a parser that finds nothing passes every
  // absence claim, and an empty allowlist must not make that vacuous.
  if (keys.length !== ALLOWED_HAND_WRITTEN.length || keys.length === 0) {
    failures.push({
      check: 'instrument',
      where: at,
      detail: `the depth parser found ${keys.length} mutations in a fixture built to have ${ALLOWED_HAND_WRITTEN.length} — a parser that finds none passes every absence claim`,
    })
  }

  no(handWrittenDrift(PROBE_CLEAN_ROUTER, '<probe>'), 'clean router')
  yes('hand-written-write', handWrittenDrift(PROBE_SMUGGLED_ROUTER, '<probe>'), 'ungoverned write')
  yes('hand-written-write', handWrittenDrift(PROBE_ABSORBED_ROUTER, '<probe>'), 'REMOVED exception')
  yes('settings-router-present', handWrittenDrift('export const x = 1', '<probe>'), 'no router')

  no(derivedSpreadMissing(PROBE_CLEAN_ROUTER, '<probe>'), 'clean router')
  yes(
    'derived-spread',
    derivedSpreadMissing(PROBE_UNDERIVED_ROUTER, '<probe>'),
    'no derived spread',
  )

  no(outboxExposure(PROBE_CLEAN_CONTRACTS, '<probe>'), 'clean contracts')
  yes('outbox-exposure', outboxExposure(PROBE_QUEUED_CONTRACTS, '<probe>'), 'outbox exposure')

  no(outboxExecutors([{ rel: '<probe>', text: PROBE_CLEAN_OUTBOX }]), 'clean outbox')
  yes(
    'outbox-executor',
    outboxExecutors([{ rel: '<probe>', text: PROBE_QUEUED_OUTBOX }]),
    'settings executor',
  )

  no(secretGuardMissing(PROBE_CLEAN_SERVICE, '<probe>'), 'clean service')
  yes(
    'blob-secret-guard',
    secretGuardMissing(PROBE_UNCALLED_SERVICE, '<probe>'),
    'guard not called',
  )
  yes('blob-secret-guard', secretGuardMissing(PROBE_UNGUARDED_SERVICE, '<probe>'), 'guard deleted')
  return failures
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const wants = (flag: string): boolean => process.argv.includes(flag)

function main(): void {
  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error(
      `settings audit: the INSTRUMENT is broken — ${probeFailures.length} check(s) cannot say YES.\n`,
    )
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  if (wants('--probe')) {
    console.log('settings surface: the parser and all 5 checks found their planted fixtures')
    return
  }

  const findings = auditSettingsCommands(read(ROUTER), read(CONTRACTS), read(SERVICE), [
    { rel: CLIENT_OUTBOX, text: read(CLIENT_OUTBOX) },
    { rel: WEB_OUTBOX, text: read(WEB_OUTBOX) },
  ])
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Settings surface: ${findings.length} finding(s). POD-420's claims are:\n` +
        '  · the `settings` router carries EXACTLY the three named hand-written writes, both directions\n' +
        '  · …and spreads the derived family, so the contracts have a dispatcher\n' +
        '  · no settings contract names `outbox`, and no client outbox executor names a settings command\n' +
        '  · the legacy blob write still REFUSES a secret change\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    `settings surface OK — ${ALLOWED_HAND_WRITTEN.length} named hand-written writes, the derived ` +
      'family spread, no queued settings command, and the blob write still refuses a secret',
  )
}

if (import.meta.main) main()

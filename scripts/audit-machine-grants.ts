#!/usr/bin/env bun
/**
 * THE MACHINE OWNERSHIP + GRANTS AUDIT (POD-1079; ADR 9 D2/D6, ADR 3 Am1 D18,
 * docs/multi-user-readiness.md §3.1.4).
 *
 * Run:
 *   bun run audit:machine-grants           # the gate — exit 1 on any finding
 *   bun run audit:machine-grants --json
 *   bun run audit:machine-grants --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS HALF CAN SEE, AND WHAT IT STRUCTURALLY CANNOT
 * ---------------------------------------------------------------------------
 *
 * These are SOURCE-TEXT checks. They resolve no modules, run in a fresh checkout
 * with no `@podium` scope installed, and catch textual regressions no running
 * object can see: the device-grade placeholder appearing at a new composition
 * root, a fleet handler growing its own machine check, a fan-out losing its
 * filter, an owner id reaching the wire.
 *
 * They CANNOT see whether the gate refuses anything. POD-732's line is the
 * standard — "an empty router satisfies every absence claim perfectly" — and every
 * absence claim below would be perfectly satisfied by a fleet surface that served
 * nothing at all. The RUNNING-OBJECT half is
 * `apps/server/src/modules/fleet/authz.test.ts`, which builds the real `appRouter`
 * and drives refusals out of it, and `apps/server/src/store/grants.test.ts`, which
 * runs against a real migrated database. Neither half is sufficient; both are in
 * the lanes.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Every check here is an ABSENCE claim, and an absence is exactly what a broken
 * instrument reports. `--probe` runs each check against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it, then
 * against a clean fixture and fails if it fires anyway. The probe runs FIRST,
 * always, even without the flag.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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

/**
 * Is this offset inside a comment line?
 *
 * Every check below hunts a CALL, and a doc comment that NAMES the call is the
 * documentation of the rule far more often than a violation of it — three of
 * these checks fired on their own prose the first time this ran. A detector that
 * cries wolf on comments is one the next reader silences rather than fixes.
 */
const inComment = (source: string, index: number): boolean =>
  /^\s*(\*|\/\/|\/\*)/.test(source.slice(0, index).split('\n').pop() ?? '')

/** The instrument does not audit itself: this file quotes every pattern it hunts,
 *  in its own probe fixtures and in its own prose. */
const INSTRUMENT = 'scripts/audit-machine-grants.ts'

/**
 * TEST SCAFFOLDING THAT BUILDS A FIXTURE FLEET, named one file at a time.
 *
 * The oracle harness seeds machine rows for suites that then assert on placement;
 * those rows stand in for machines the operator paired, and there is no principal
 * in a fixture builder to resolve. It is NOT `.test.ts`, so the ordinary test
 * exemption does not reach it — and naming it explicitly is the point: a
 * substring rule (`includes('oracle-')`) would silently exempt every future file
 * whose name happened to contain it.
 */
const FIXTURE_BUILDERS: ReadonlySet<string> = new Set([
  'apps/server/src/modules/sessions/oracle-support.ts',
])

// ---------------------------------------------------------------------------
// 1 — the device-grade placeholder has a declared, SMALL set of homes
// ---------------------------------------------------------------------------

/**
 * `deviceGradeSoleOwner()` is the honest name for "this build cannot tell who is
 * asking, so the owner is the one account" — the pattern POD-1077 established
 * with `DeviceGradeUnscopedPolicy`. It is also a hole if it spreads: one more
 * call at a new pairing path silently makes another machine everybody's.
 *
 * So the site list is a RATCHET. When per-user login lands the module is DELETED
 * and this list goes to zero, which is what forces every site to name a real
 * principal at that moment instead of quietly keeping the default.
 */
export const SOLE_OWNER_ALLOWLIST: ReadonlySet<string> = new Set([
  // The definition itself.
  'apps/server/src/device-grade-owner.ts',
  // The local sentinel's synthesized row: `__local__` was paired by nobody.
  'apps/server/src/machine-access.ts',
  // `ensureHostMachine` — provisioned at boot with no principal in scope.
  'apps/server/src/modules/machines/service.ts',
  // POD-1080: the user a Telegram claim code is minted FOR. Not a machine
  // owner, and deliberately the same placeholder rather than a fourth spelling
  // of "this build cannot tell two humans apart" — one name means one deletion
  // when POD-315 lands, and this list is the census of what that deletion has
  // to visit.
  'apps/server/src/relay.ts',
])

const SCANNED_DIRS = ['apps', 'packages', 'scripts'] as const

export function soleOwnerSites(
  files: ReadonlyMap<string, string>,
  allowlist: ReadonlySet<string> = SOLE_OWNER_ALLOWLIST,
): Finding[] {
  const findings: Finding[] = []
  for (const [file, source] of files) {
    if (allowlist.has(file) || file === INSTRUMENT || file.includes('.test.')) continue
    for (const match of source.matchAll(/\bdeviceGradeSoleOwner\s*\(/g)) {
      if (inComment(source, match.index)) continue
      findings.push({
        check: 'sole-owner-sites',
        where: `${file}:${lineOf(source, match.index)}`,
        detail:
          'a new site invents a machine owner because the transport cannot name one. Allowed at ' +
          `exactly ${[...allowlist].join(', ')} — see device-grade-owner.ts on why the module exists ` +
          'and what deleting it is meant to force.',
      })
    }
  }
  return findings
}

/**
 * The SAME hole, spelled without the placeholder.
 *
 * Check 1 counts calls to a named function, so it is evaded completely by
 * writing `ownerUserId: FIRST_ADMIN_USER_ID` — which is what the code did before
 * the placeholder had a name, and is exactly as permissive. A detector that
 * covers one syntax for a concept covers the concept only by luck.
 */
export function bareFirstAdminOwnerSites(
  files: ReadonlyMap<string, string>,
  allowlist: ReadonlySet<string> = SOLE_OWNER_ALLOWLIST,
): Finding[] {
  const findings: Finding[] = []
  for (const [file, source] of files) {
    if (
      allowlist.has(file) ||
      file === INSTRUMENT ||
      FIXTURE_BUILDERS.has(file) ||
      file.includes('.test.')
    )
      continue
    for (const match of source.matchAll(
      // `ownerUserId` / `owner_user_id` ONLY. A bare `owner:` is somebody else's
      // column — sessions and issues have transitional sole-account answers of
      // their own (POD-1075's), and firing on those would make this gate about a
      // question it does not own, which is how a gate gets suppressed.
      /owner(?:UserId|_user_id)\s*[:=]\s*(FIRST_ADMIN_USER_ID|SOLE_USER_ID|'user:sole'|"user:sole")/g,
    )) {
      if (inComment(source, match.index)) continue
      findings.push({
        check: 'bare-sole-owner',
        where: `${file}:${lineOf(source, match.index)}`,
        detail:
          'an owner assigned from the sole-account constant directly. Say it with ' +
          '`deviceGradeSoleOwner()` so the placeholder is countable, or resolve the real principal.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the fleet gate is DERIVED, and no handler re-implements it
// ---------------------------------------------------------------------------

/**
 * The whole point of POD-384's declaration is that the check follows the
 * contract. Two claims, and the POSITIVE one comes first for the reason POD-732
 * gives: an absence claim about handlers is satisfied perfectly by a family with
 * no gate anywhere.
 */
export function fleetGateDerived(trpcSource: string, handlersSource: string): Finding[] {
  const findings: Finding[] = []
  if (!/fleetAuthzFailure\s*\(/.test(trpcSource)) {
    findings.push({
      check: 'fleet-gate-derived',
      where: 'apps/server/src/modules/fleet/trpc.ts',
      detail:
        'the derived fleet surface does not call `fleetAuthzFailure`. Every fleet procedure must run ' +
        "the contract's own roleFloor/machineVerb gate — a per-handler check is ten places to forget.",
    })
  }
  for (const match of handlersSource.matchAll(/\b(checkMachineVerb|checkMachineUse)\s*\(/g)) {
    findings.push({
      check: 'fleet-gate-derived',
      where: `apps/server/src/modules/fleet/handlers.ts:${lineOf(handlersSource, match.index)}`,
      detail:
        'a fleet HANDLER performs its own machine check. The gate is derived from the contract in ' +
        'trpc.ts; a second copy in a handler is the one that drifts.',
    })
  }
  return findings
}

/**
 * Every fleet contract has an entry in the target table.
 *
 * `satisfies Record<FleetContractName, …>` already makes this a compile error —
 * and this check exists anyway, because the `satisfies` is one edit away from
 * being replaced with a wider annotation, and because this gate runs in a
 * checkout where nothing is built.
 */
export function targetsCoverContracts(
  contractsSource: string,
  targetsSource: string,
): Finding[] {
  const findings: Finding[] = []
  const declared = [...contractsSource.matchAll(/^\s*name:\s*'([\w.]+)',$/gm)].map((m) => m[1])
  if (declared.length === 0) {
    return [
      {
        check: 'targets-cover-contracts',
        where: 'packages/commands/src/fleet/contracts.ts',
        detail:
          'no contract names were found at all — the instrument cannot see the family it is auditing.',
      },
    ]
  }
  for (const name of declared) {
    if (!targetsSource.includes(`'${name}'`)) {
      findings.push({
        check: 'targets-cover-contracts',
        where: 'apps/server/src/modules/fleet/authz.ts',
        detail: `${name} has no entry in FLEET_TARGETS, so the gate cannot tell which machine it is about.`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — a fleet-wide fan-out carries the principal's filter
// ---------------------------------------------------------------------------

/**
 * `scanReposAll()` walks every online machine's filesystem through its daemon.
 * Called with no filter from a transport path, it does that on machines the
 * caller holds no `use` on — the code-execution boundary, crossed by omission.
 *
 * The declaration site is allowed to call it bare (that IS the declaration), and
 * so are in-process callers with no principal to filter by; those are named here
 * rather than pattern-matched, so adding one is a visible edit.
 */
export const UNFILTERED_SCAN_ALLOWLIST: ReadonlySet<string> = new Set([
  'apps/server/src/repo-registry.ts',
])

export function unfilteredFanOut(
  files: ReadonlyMap<string, string>,
  allowlist: ReadonlySet<string> = UNFILTERED_SCAN_ALLOWLIST,
): Finding[] {
  const findings: Finding[] = []
  for (const [file, source] of files) {
    if (allowlist.has(file) || file === INSTRUMENT || file.includes('.test.')) continue
    for (const match of source.matchAll(/scanReposAll\s*\(\s*\)/g)) {
      if (inComment(source, match.index)) continue
      findings.push({
        check: 'unfiltered-fan-out',
        where: `${file}:${lineOf(source, match.index)}`,
        detail:
          '`scanReposAll()` with no `mayUse` predicate scans every online machine, including ones ' +
          'this caller holds no `use` on (ADR 9 D6 M2).',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — ownership does not travel on the machine wire
// ---------------------------------------------------------------------------

/**
 * Who owns a machine is a SERVER-SIDE fact. `MachineWire` reaches every client
 * that can see the machine, and putting an owner id on it would disclose the
 * fleet's ownership graph to everyone with `see` — a decision nobody made, and
 * one the gate does not need: refusals are computed on the server.
 *
 * Scanned on the schema BLOCK rather than the file, so an unrelated `owner` in a
 * neighbouring type is not a finding.
 *
 * WHAT IS FORBIDDEN IS AN IDENTITY, NOT THE WORD (amended by POD-1495). The rule
 * above is about the ownership GRAPH: a field naming WHO owns a machine tells
 * every principal with `see` who everyone else is. A VIEWER-RELATIVE boolean —
 * `owned`, "are you this machine's owner" — discloses nothing of the kind: it
 * says only what the caller already knows about itself, and "someone else's" and
 * "nobody's" are one indistinguishable `false`. Without it the settings panel
 * cannot withhold an owner-only control (`machines.transferOwnership`) and has to
 * offer it on every row and let the server refuse.
 *
 * So the check now looks for a field whose VALUE could carry a user id, and the
 * probe pair below still plants `ownerUserId` and still catches it. Anything
 * declared with a UserId — `owner: UserIdField`, `ownerUserId: z.string()` — is a
 * finding; a boolean is not. A future field that smuggles an identity through a
 * loose type is the residual risk, and it is the same risk any grep-shaped gate
 * carries.
 */
export function ownerOnMachineWire(machineEntitySource: string): Finding[] {
  const block = /export const MachineWire = z\.object\(\{[\s\S]*?\n\}\)/.exec(machineEntitySource)
  if (!block) {
    return [
      {
        check: 'owner-on-wire',
        where: 'packages/model/src/entities/machine.ts',
        detail: 'MachineWire could not be located — the instrument cannot see what it is auditing.',
      },
    ]
  }
  // An owner-shaped KEY whose value is anything but a boolean. `owned:
  // z.boolean()` passes; `ownerUserId: z.string()` and `owner: UserIdField` do not.
  return /\bowner\w*\s*:\s*(?!z\.boolean\(\))/i.test(block[0])
    ? [
        {
          check: 'owner-on-wire',
          where: 'packages/model/src/entities/machine.ts',
          detail:
            'MachineWire carries an owner. Ownership is resolved server-side (`ownershipRows()`); ' +
            'shipping it would disclose the ownership graph to every principal that can `see` a machine.',
        },
      ]
    : []
}

// ---------------------------------------------------------------------------
// The file sweep
// ---------------------------------------------------------------------------

function collectSources(): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx'))
        files.set(relative(ROOT, full), readFileSync(full, 'utf8'))
    }
  }
  for (const dir of SCANNED_DIRS) walk(join(ROOT, dir))
  return files
}

export function auditMachineGrants(): Finding[] {
  const files = collectSources()
  return [
    ...soleOwnerSites(files),
    ...bareFirstAdminOwnerSites(files),
    ...fleetGateDerived(
      read('apps/server/src/modules/fleet/trpc.ts'),
      read('apps/server/src/modules/fleet/handlers.ts'),
    ),
    ...targetsCoverContracts(
      read('packages/commands/src/fleet/contracts.ts'),
      read('apps/server/src/modules/fleet/authz.ts'),
    ),
    ...unfilteredFanOut(files),
    ...ownerOnMachineWire(read('packages/model/src/entities/machine.ts')),
  ]
}

// ---------------------------------------------------------------------------
// The probe — every check against a planted fixture AND a clean one
// ---------------------------------------------------------------------------

function probe(): Finding[] {
  const broken: Finding[] = []
  const expectFinds = (check: string, findings: Finding[], what: string): void => {
    if (findings.length === 0)
      broken.push({ check, where: '<probe>', detail: `did not find a planted ${what}` })
  }
  const expectClean = (check: string, findings: Finding[]): void => {
    if (findings.length > 0)
      broken.push({ check, where: '<probe>', detail: 'fired on a clean fixture' })
  }
  const one = (source: string): Map<string, string> => new Map([['apps/server/src/planted.ts', source]])

  expectFinds(
    'sole-owner-sites',
    soleOwnerSites(one('const owner = deviceGradeSoleOwner()')),
    'placeholder call at an unlisted site',
  )
  expectClean('sole-owner-sites', soleOwnerSites(one('const owner = principal.user')))
  // The allowlist must actually exempt, or the ratchet is a blanket ban and the
  // first honest site would be silenced rather than counted.
  expectClean(
    'sole-owner-sites',
    soleOwnerSites(new Map([['apps/server/src/device-grade-owner.ts', 'deviceGradeSoleOwner()']])),
  )

  expectFinds(
    'bare-sole-owner',
    bareFirstAdminOwnerSites(one('upsertMachine({ ownerUserId: FIRST_ADMIN_USER_ID })')),
    'owner assigned from the sole-account constant',
  )
  expectFinds(
    'bare-sole-owner',
    bareFirstAdminOwnerSites(one("upsertMachine({ ownerUserId: 'user:sole' })")),
    'owner assigned from the sole-account literal',
  )
  expectClean(
    'bare-sole-owner',
    bareFirstAdminOwnerSites(one('upsertMachine({ ownerUserId: pairingGrant.ownerUserId ?? null })')),
  )

  expectFinds(
    'fleet-gate-derived',
    fleetGateDerived('const p = base.input(x).mutation(run)', ''),
    'derived surface with no gate call',
  )
  expectFinds(
    'fleet-gate-derived',
    fleetGateDerived('fleetAuthzFailure(name, input, deps)', 'checkMachineUse(principal, id, own)'),
    'handler-local machine check',
  )
  expectClean(
    'fleet-gate-derived',
    fleetGateDerived('fleetAuthzFailure(name, input, deps)', 'mods(ctx).machines.renameMachine(x)'),
  )

  expectFinds(
    'targets-cover-contracts',
    targetsCoverContracts("  name: 'machines.rename',\n  name: 'machines.newThing',\n", "'machines.rename'"),
    'contract with no target entry',
  )
  expectFinds(
    'targets-cover-contracts',
    targetsCoverContracts('nothing that looks like a contract', "'machines.rename'"),
    'unreadable contract file',
  )
  expectClean(
    'targets-cover-contracts',
    targetsCoverContracts("  name: 'machines.rename',\n", "'machines.rename': () => x"),
  )

  expectFinds(
    'unfiltered-fan-out',
    unfilteredFanOut(one('await ctx.repos.scanReposAll()')),
    'unfiltered fleet-wide scan',
  )
  expectClean('unfiltered-fan-out', unfilteredFanOut(one('await ctx.repos.scanReposAll(mayUse)')))

  expectFinds(
    'owner-on-wire',
    ownerOnMachineWire('export const MachineWire = z.object({\n  id: z.string(),\n  ownerUserId: z.string(),\n})'),
    'owner field on the machine wire',
  )
  expectFinds('owner-on-wire', ownerOnMachineWire('nothing here'), 'missing MachineWire block')
  expectClean(
    'owner-on-wire',
    ownerOnMachineWire('export const MachineWire = z.object({\n  id: z.string(),\n  name: z.string(),\n})'),
  )
  // POD-1495's amendment, PINNED: the viewer-relative boolean is clean, and it
  // sits next to the planted `ownerUserId` above which is still a finding. An
  // amendment that quietly disabled the check would show up as that probe going
  // silent, not as this one passing.
  expectClean(
    'owner-on-wire',
    ownerOnMachineWire(
      'export const MachineWire = z.object({\n  id: z.string(),\n  owned: z.boolean().optional(),\n})',
    ),
  )
  return broken
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Machine-grants audit: THE INSTRUMENT IS BROKEN — a check cannot say YES or NO.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log(
      'machine-grants audit: every check found its planted fixture and spared the clean ones',
    )
    return
  }

  const findings = auditMachineGrants()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Machine-grants audit: ${findings.length} finding(s). POD-1079's claims are:\n` +
        '  · the device-grade owner placeholder has a small, declared set of homes — in BOTH spellings\n' +
        "  · the fleet gate is DERIVED from each contract's roleFloor/machineVerb, and no handler copies it\n" +
        '  · every fleet contract says which machine it is about\n' +
        '  · a fleet-wide fan-out carries the principal\'s `use` filter\n' +
        '  · ownership never travels on the machine wire\n' +
        '  (whether the gate actually REFUSES is apps/server/src/modules/fleet/authz.test.ts, which\n' +
        '   builds the real appRouter — a source scan cannot see that)\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'machine-grants audit OK — placeholder ratchet held, gate derived, targets complete, fan-out ' +
      'filtered, no owner on the wire (the running-object half is modules/fleet/authz.test.ts)',
  )
}

if (import.meta.main) main()

/**
 * THE DRIFT GUARD for the client's outbox contract table (POD-316).
 *
 * `OUTBOX_COMMANDS` in `@podium/client-core/engine` carries each queued kind's
 * contract name, version AND its `policy.confirmation` rule, because the
 * dead-letter recovery surface has to know whether an inline confirmation can
 * possibly satisfy a `confirmation-required` refusal — and it must know that
 * without importing the whole command registry into the browser bundle
 * (`audit:browser-reach`).
 *
 * A copied value needs a guard or it is drift waiting to happen. This test is
 * that guard, and it lives HERE — on the client side — rather than in
 * `packages/commands`, because commands is L1 and client-core depends on IT. A
 * first draft put it in commands and imported `@podium/client-core/engine`,
 * which is a dependency CYCLE: the import resolved to `undefined` at module
 * init and the suite failed with "Object.entries requires that input parameter
 * not be null" rather than with anything about contracts. The direction of the
 * dependency decides where a cross-package guard can live. It asserts equality with `toBe` against the
 * contract's own field, so a contract that changes its confirmation rule reddens
 * this test rather than silently leaving the client offering a confirm
 * affordance the command no longer has — or, worse, withholding one it does.
 *
 * It also asserts the offline class of every queued kind, which is the property
 * ADR 3 D4 rule 3 makes structural: a kind the client queues whose contract is
 * `online-only` or `online-sensitive` is a secret or a live-daemon operation
 * that must never have entered the queue at all.
 *
 * ---------------------------------------------------------------------------
 * PDM-423 — THE DEFINITION SIDE, AND WHY IT IS TWO CHECKS AND NOT ONE
 * ---------------------------------------------------------------------------
 *
 * Eleven queued kinds carry a presence-class `CommandDef` instead of a full
 * contract. They used to be listed as UNGUARDED and skipped entirely — not
 * because anyone judged them safe, but because the only resolver here looked for
 * a full contract and they resolved to nothing. Eleven rows of a table whose
 * whole purpose is to stop drift were outside the guard.
 *
 * They are now resolved and checked, and the two things checked are kept APART:
 *
 *   ENROLMENT   the definition declares `outbox` — the Outbox serves this command
 *   ELIGIBILITY the definition declares `offline: 'eligible'` — ADR 3 D4 rule 3
 *
 * `contract.ts`'s D3 rule 2 makes `outbox` exposure IMPLY an offline-eligible
 * delivery class, and says nothing in the other direction. So eligibility is
 * PERMISSION to be queued and enrolment is BEING queued; a definition that is
 * eligible has not thereby declared that anything serves it. Reading the one-way
 * constraint as an equivalence is the error PDM-423 was filed on and then made
 * itself before the review caught it. Two cases, so neither can hold the other up.
 *
 * The queued-side enumeration is EXHAUSTIVE and reports what it could not resolve
 * as a GROWING list rather than asserting a fixed roster of skipped kinds — see
 * the first case below for why that distinction is the difference between a guard
 * and a guard-shaped thing that passes when its resolver breaks.
 */

import type { CommandContract, CommandDef } from '@podium/commands'
import {
  commandExposure,
  ISSUE_CONTRACTS,
  LAYOUT_CONTRACTS,
  SESSION_STATE_COMMAND_TABLES,
  SETTINGS_CONTRACTS,
  sessionCommandPlane,
  sessionRenameContract,
} from '@podium/commands'
import { describe, expect, it } from 'vitest'
import { OUTBOX_COMMANDS } from './wiring'

/** Every contract a queued kind may name, by dotted name. The presence class
 *  (sessions.*, snoozes.*) has its own by-name lookup; issues.* is a plain
 *  registry. Both are consulted so no queued kind is excluded by silence. */
const byName = new Map<string, CommandContract>()
for (const contract of [
  ...Object.values(ISSUE_CONTRACTS),
  ...Object.values(SETTINGS_CONTRACTS),
  ...Object.values(LAYOUT_CONTRACTS),
]) {
  byName.set((contract as CommandContract).name, contract as CommandContract)
}
/**
 * Only a FULL contract can be compared: `sessionStateCommand` returns the leaf
 * `CommandDef` (action + scope), which has no `policy` and no `delivery`. A
 * first draft cast it to `CommandContract` anyway and every presence row failed
 * with "expected 'none' to be undefined" — the cast silenced the type system
 * about a difference that was real.
 *
 * So the lookup returns a contract or nothing, and the kinds with no full
 * contract are listed EXPLICITLY below rather than filtered away, because an
 * unguarded row that nobody can see is how the copy drifts.
 */
const lookup = (name: string): CommandContract | undefined => {
  const contract = byName.get(name)
  if (contract?.policy !== undefined) return contract
  return undefined
}

/**
 * THE DEFINITION SIDE (PDM-423).
 *
 * Eleven queued kinds carry a presence-class `CommandDef` rather than a full
 * `CommandContract`. Until PDM-423 they were listed as UNGUARDED and skipped
 * wholesale, because the only resolver here looked for a full contract. They are
 * now resolved and checked against what a definition CAN express.
 *
 * TWO RESOLVERS ARE REQUIRED, NOT ONE, and the reason is a real hazard rather
 * than a detail: `sessionStateCommands` and `sessionCommandPlane` are BOTH
 * `defineCommands('sessions', …)`, so they share the `sessions.` namespace.
 * `sessionStateCommand()` walks only `SESSION_STATE_COMMAND_TABLES` and CANNOT
 * resolve `sessions.resumeAndSend`; the plane's own table is a separate source.
 * Rather than consult them in some order and let the first win, this builds one
 * index and REFUSES a name that arrives twice (see `AMBIGUOUS` below) — an
 * arbitrary precedence between two tables that share a namespace is exactly the
 * kind of silent decision this file exists to prevent.
 *
 * A CORRECTION CARRIED HERE: the note this block replaces said
 * `sessions.resumeAndSend` "lives in a registry this module does not reach". It
 * is reachable — `@podium/commands`' index re-exports the command plane with
 * `export *`, and the import above resolves. It was skipped because a walk
 * looking for full CONTRACTS cannot recognise a `defineCommands` result, whose
 * shape is `{ namespace, defs }` and carries no `name` or `exposure` of its own.
 * A shape miss, not an import-graph limit.
 */
type DefTable = { readonly namespace: string; readonly defs: Record<string, CommandDef> }

const DEF_TABLES: readonly DefTable[] = [
  ...(SESSION_STATE_COMMAND_TABLES as unknown as readonly DefTable[]),
  sessionCommandPlane as unknown as DefTable,
]

const defsByName = new Map<string, CommandDef>()
/** Dotted names offered by more than one table. Asserted EMPTY — see the note above. */
const AMBIGUOUS: string[] = []
/** Table entries this index could not interpret. RETAINED AND REPORTED rather than
 *  filtered away: a walk that silently skips what it does not recognise makes every
 *  claim built on it a claim about the shapes it happened to like. */
const UNSUPPORTED_SHAPES: string[] = []
for (const table of DEF_TABLES) {
  if (typeof table?.namespace !== 'string' || typeof table?.defs !== 'object') {
    UNSUPPORTED_SHAPES.push(`table ${String(table?.namespace ?? '?')}`)
    continue
  }
  for (const [key, def] of Object.entries(table.defs)) {
    const name = `${table.namespace}.${key}`
    if (typeof def !== 'object' || def === null || !('action' in def)) {
      UNSUPPORTED_SHAPES.push(name)
      continue
    }
    if (defsByName.has(name)) AMBIGUOUS.push(name)
    else defsByName.set(name, def)
  }
}

/**
 * The eleven queued kinds backed by a DEFINITION at this pin, asserted EXACTLY.
 *
 * TEN of them are the kinds that were previously UNGUARDED. The eleventh is
 * `rename`, which was on that list for a different reason: `sessionRenameContract`
 * is a full contract and always was, exported standalone rather than inside a
 * `*_CONTRACTS` registry, so the registry-shaped resolver below cannot see it. It
 * is therefore definition-backed HERE while being contract-backed in fact — which
 * is why the cross-vocabulary check further down is written to be independent of
 * which resolver wins.
 *
 * INTEGRATION NOTE, CORRECTED (PDM-449): PDM-416 (unlanded at the time of writing)
 * widens the contract walk to reach standalone exports, so `rename` will ALSO resolve
 * as a contract. This list does NOT change when that happens, and that is the repair:
 * the population is every queued kind with a DEFINITION, so a kind gaining a contract
 * is added to the contract checks rather than removed from these. An earlier draft
 * excluded contract-resolved kinds here, which would have dropped `rename` out of both
 * definition checks on the day PDM-416 landed. Adjusting the list would not have fixed
 * that; decoupling the population from contract resolution is what fixes it.
 */
const DEFINITION_RESOLVED = [
  'dismissOffer',
  'pinSet',
  'rename',
  'resumeAndSend',
  'sessionMarkRead',
  'sessionMarkUnread',
  'setArchived',
  'setWorkState',
  'snoozeClear',
  'snoozeSet',
  'tabSetOrder',
].sort()

describe('the client outbox contract table matches the contracts', () => {
  const entries = Object.entries(OUTBOX_COMMANDS)
  const queuedNames = new Set(entries.map(([, command]) => command.name))
  const resolveDef = (name: string): CommandDef | undefined => defsByName.get(name)

  const contractBacked = entries.filter(([, c]) => lookup(c.name) !== undefined)
  /**
   * EVERY queued kind with a resolvable definition — INDEPENDENT of whether a full
   * contract also resolves (PDM-449).
   *
   * This used to read `lookup(...) === undefined && resolveDef(...) !== undefined`,
   * and that conjunction was a hole rather than a filter. `rename` is
   * definition-resolved here only because the registry-shaped `lookup` cannot see a
   * STANDALONE contract export; PDM-416 widens exactly that, and on the day it lands
   * `rename` would have become contract-backed and DROPPED OUT OF BOTH definition
   * checks — enrolment and eligibility — with its definition then unchecked. A
   * definition quietly moved to `offline: 'direct-only'` would have escaped while the
   * contract stayed `offline-eligible` and everything here passed.
   *
   * The two vocabularies are two declarations and BOTH are checked. Resolution order
   * decides which contract case applies; it must never decide WHETHER a definition is
   * checked. Note this also makes the population below stable across PDM-416 rather
   * than something that must be adjusted when it lands — adjusting the list alone
   * would not have closed this.
   */
  const definitionResolved = entries.filter(([, c]) => resolveDef(c.name) !== undefined)

  // -------------------------------------------------------------------------
  // EXHAUSTIVE QUEUED-SIDE ENUMERATION — the anti-vacuity spine of this file.
  // -------------------------------------------------------------------------

  it('every queued kind resolves to a contract or a definition — an unresolved kind would replay under a guess', () => {
    // REPORTED AS A GROWING LIST, not as an empty allow-list. The old shape asserted
    // an UNGUARDED roster equal to a fixed set, which a resolver returning nothing
    // for everything would still satisfy once that roster covered every kind. Here a
    // broken resolver makes THIS list grow, so the failure mode is loud by
    // construction rather than by remembering to add a floor.
    const unresolved = entries
      .filter(([, c]) => lookup(c.name) === undefined && resolveDef(c.name) === undefined)
      .map(([kind]) => kind)
      .sort()
    expect(unresolved).toEqual([])
  })

  it('the definition index is unambiguous and interpreted every entry it was given', () => {
    // Two tables share the `sessions.` namespace. If a key ever appears in both,
    // REFUSE rather than pick one: a silent precedence would decide which
    // definition governs a queued kind without anyone choosing it.
    expect(AMBIGUOUS).toEqual([])
    expect(UNSUPPORTED_SHAPES).toEqual([])
    // …and the ambiguity detector has a live subject, or it proves nothing: the two
    // tables really do share a namespace, and stay disjoint only by their keys.
    const planeNamespace = (sessionCommandPlane as unknown as DefTable).namespace
    const stateNamespaces = (
      SESSION_STATE_COMMAND_TABLES as unknown as readonly DefTable[]
    ).map((t) => t.namespace)
    expect(stateNamespaces).toContain(planeNamespace)
  })

  it('the definition-resolved population is exactly the eleven presence kinds', () => {
    expect(definitionResolved.map(([kind]) => kind).sort()).toEqual(DEFINITION_RESOLVED)
    // The contract-backed population is non-empty, or the contract cases below are
    // vacuous for a reason no assertion in them would report.
    expect(contractBacked.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // CONTRACT-BACKED KINDS
  // -------------------------------------------------------------------------

  it.each(contractBacked)(
    '%s: confirmation rule and offline class match the contract',
    (_kind, command) => {
      const contract = lookup(command.name)
      if (!contract) throw new Error(`no contract for ${command.name}`)
      // `toBe`, not a shape check: the whole point is that the copied VALUE is
      // the contract's value.
      expect(command.confirmation).toBe(contract.policy.confirmation)
      // D4 rule 3: only an offline-eligible contract may be in this table at all.
      expect(contract.delivery.class).toBe('offline-eligible')
    },
  )

  // -------------------------------------------------------------------------
  // DEFINITION-BACKED KINDS — enrolment and eligibility, SEPARATELY.
  // -------------------------------------------------------------------------
  //
  // Two cases, never one. `contract.ts`'s D3 rule 2 constrains `outbox` exposure to
  // imply an offline-eligible delivery class and NOT the converse, so eligibility is
  // PERMISSION and enrolment is enrolment. A definition that is eligible has not
  // thereby said the Outbox serves it, and a check on one is not evidence about the
  // other. Collapsing them into a single case would let either hold the other up.

  it.each(definitionResolved)(
    '%s: the definition DECLARES outbox enrolment — being queued is being served',
    (_kind, command) => {
      const def = resolveDef(command.name)
      if (!def) throw new Error(`no definition for ${command.name}`)
      expect(commandExposure(def)).toContain('outbox')
    },
  )

  it.each(definitionResolved)(
    '%s: the definition declares offline ELIGIBILITY — D4 rule 3, a separate fact',
    (_kind, command) => {
      const def = resolveDef(command.name)
      if (!def) throw new Error(`no definition for ${command.name}`)
      expect(def.offline).toBe('eligible')
    },
  )

  it('the two definition checks DISCRIMINATE — a definition that is neither enrolled nor eligible', () => {
    // Without this arm both cases above pass against a table where every definition
    // says `outbox` and `eligible`, which is indistinguishable from a gate stuck at
    // true. `setIssueId` and `setDraft` are the live negative controls: real
    // definitions, in a table this file walks, that are direct-only and NOT queued.
    for (const name of ['sessions.setIssueId', 'sessions.setDraft']) {
      const def = resolveDef(name)
      expect(def, `${name} must be reachable for this control to mean anything`).toBeDefined()
      expect(queuedNames.has(name), `${name} must not be queued`).toBe(false)
      expect(def?.offline, `${name} eligibility`).toBe('direct-only')
      expect(commandExposure(def as CommandDef), `${name} enrolment`).not.toContain('outbox')
    }
    // And the default-closed reading itself, on a definition declaring nothing.
    expect(commandExposure({ input: sessionRenameContract.input, action: 'write' })).toEqual([])
  })

  // -------------------------------------------------------------------------
  // REVERSE DIRECTION, and the CROSS-VOCABULARY agreement.
  // -------------------------------------------------------------------------

  it('no definition declares `outbox` that this table does not queue', () => {
    const declaredNotQueued = [...defsByName.entries()]
      .filter(([, def]) => commandExposure(def).includes('outbox'))
      .map(([name]) => name)
      .filter((name) => !queuedNames.has(name))
      .sort()
    expect(declaredNotQueued).toEqual([])
    // BOUND, stated where it applies: this direction sees the definitions reachable
    // from `@podium/commands`. `issueRegistry` and `lockRegistry` are declared in
    // `apps/server` and are NOT reachable from client-core, so a definition there
    // declaring `outbox` would be invisible here. Neither is queued today.
  })

  it('`sessions.rename` — definition and full contract AGREE on outbox enrolment', () => {
    // The one command holding BOTH vocabularies, and before PDM-423 they DISAGREED:
    // the definition said ['trpc'] while the contract said ['trpc','outbox'], about
    // the same command, with nothing comparing them. The definition was not wrong —
    // it was unable to agree.
    //
    // Written against BOTH sources by name rather than through the resolver above,
    // deliberately: which resolver wins for `rename` changes when PDM-416 lands, and
    // this comparison must not change with it.
    const def = (SESSION_STATE_COMMAND_TABLES as unknown as readonly DefTable[])
      .map((table) => table.defs.rename)
      .find((candidate) => candidate !== undefined)
    expect(def, 'rename definition must be reachable').toBeDefined()
    expect(commandExposure(def as CommandDef)).toContain('outbox')
    expect(sessionRenameContract.exposure).toContain('outbox')
    // AND ELIGIBILITY, which this case used to omit (PDM-449). Enrolment agreeing is
    // not the whole agreement: the two vocabularies each carry a delivery class too,
    // and a definition drifting to `direct-only` while the contract stays
    // `offline-eligible` is precisely the disagreement this case exists to catch.
    expect((def as CommandDef).offline).toBe('eligible')
    expect(sessionRenameContract.delivery.class).toBe('offline-eligible')
  })

  it('a contract-resolved kind is STILL definition-checked — the PDM-416 control', () => {
    // THE DISCRIMINATING CONTROL PDM-449 REQUIRES. The cases above cannot cover this:
    // they run OVER the population, so re-coupling it to contract resolution would stop
    // them GENERATING rows for `rename` — and a case that does not run cannot fail.
    //
    // It DRIVES the widened resolver rather than asserting beside it (PDM-449 follow-up).
    // An earlier draft built `widened` and then only asked whether it returned something,
    // while every other assertion ran against the LIVE resolver — so the scenario was
    // named and never exercised. Both predicate shapes are evaluated under BOTH
    // resolvers below, and the repaired one is the shape production uses.
    const widened = (name: string): CommandContract | undefined =>
      name === 'sessions.rename' ? sessionRenameContract : lookup(name)

    const populationsUnder = (contractResolver: (name: string) => CommandContract | undefined) => ({
      // The repair: definitions alone decide the population.
      repaired: entries
        .filter(([, c]) => resolveDef(c.name) !== undefined)
        .map(([kind]) => kind)
        .sort(),
      // The shape this file used to carry, evaluated under the SAME resolver.
      previous: entries
        .filter(([, c]) => contractResolver(c.name) === undefined && resolveDef(c.name) !== undefined)
        .map(([kind]) => kind)
        .sort(),
    })

    const live = populationsUnder(lookup)
    const afterPdm416 = populationsUnder(widened)

    // WHY THIS WAS LATENT, stated as an assertion rather than as a comment: under the
    // resolver that ships TODAY the two shapes agree exactly, so no run could tell them
    // apart and the defect was invisible until PDM-416 moved the resolver underneath it.
    expect(live.previous).toEqual(live.repaired)

    // THE PREMISE IS LIVE: the widened resolver really does change the old answer.
    // Without this the next assertion could pass against a simulation that does nothing.
    expect(afterPdm416.previous).not.toContain('rename')

    // AND THE REPAIR HOLDS UNDER EXACTLY THAT RESOLVER — the population production
    // computes is unchanged by a kind gaining a full contract.
    expect(afterPdm416.repaired).toContain('rename')
    expect(afterPdm416.repaired).toEqual(definitionResolved.map(([kind]) => kind).sort())

    // WHAT THE OLD SHAPE WOULD HAVE COST, made concrete: excluded from the population,
    // `rename`'s definition is never examined at all, so a wrong delivery class on it is
    // unobservable while its contract stays correct.
    const def = resolveDef('sessions.rename')
    expect(def, 'rename definition must be reachable').toBeDefined()
    const wrongDefinition: CommandDef = { ...(def as CommandDef), offline: 'direct-only' }
    expect(wrongDefinition.offline).not.toBe('eligible')
    expect((def as CommandDef).offline).toBe('eligible')
    expect(sessionRenameContract.delivery.class).toBe('offline-eligible')
  })
})

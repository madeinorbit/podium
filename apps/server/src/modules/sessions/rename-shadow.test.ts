/**
 * THE SHADOW COMPARISON — POD-351's most falsifiable criterion.
 *
 * ---------------------------------------------------------------------------
 * WHAT "SHADOW-COMPARED" HAS TO MEAN, AND WHAT IT MUST NOT
 * ---------------------------------------------------------------------------
 *
 * NOT two green test files, one per path. That proves each path is
 * self-consistent and nothing about whether they agree — it is the easiest way to
 * fake this criterion and it is why the criterion is written the way it is.
 *
 * What it means here: ONE input list, run through BOTH paths against two
 * independently-seeded but identically-constructed real stacks, with a single
 * assertion that FAILS if the observable results differ. Divergence is a test
 * failure, not a diff a human reads.
 *
 * And — the part that makes it evidence rather than decoration — the comparison
 * is PROVEN ABLE TO FAIL. A shadow assertion that has only ever been observed
 * agreeing is not evidence; the last describe block below mutates one path in
 * process and asserts the comparison reds.
 *
 * ---------------------------------------------------------------------------
 * REAL COLLABORATORS ON BOTH SIDES
 * ---------------------------------------------------------------------------
 *
 * Both fixtures use a real `SessionStore(':memory:')` and a real
 * `SessionRegistry`, so both paths drive the real `SessionsService` — the same
 * `renameSession` / `setAgentName` the product runs. A fake service would let the
 * two paths agree about a service neither of them actually calls, which is the
 * characterization trap this run has hit before.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS COMPARED
 * ---------------------------------------------------------------------------
 *
 * The OBSERVABLE state after the call — `name` and `nameSource` on the row — plus
 * a normalised verdict (did it apply, was it refused, and with what reason). The
 * two paths deliberately have different RETURN TYPES (legacy returns `undefined`
 * on success; the target path returns the contract's outcome union), so comparing
 * return values verbatim would be comparing shapes rather than behaviour. The row
 * is the shared truth both paths write, and the verdict is normalised to the
 * coarsest form that still distinguishes accept from reject-with-reason.
 */

import { OPERATOR, SOLE_USER_ID, asSessionId } from '@podium/model'
import { isExposedOn, presenceCommand } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { FIRST_ADMIN_USER_ID, type CommandPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'
import { MIGRATED_COMMANDS, renamePath, RENAME_PATH_ENV } from './rename-adapter'
import { PresenceRegistry, soleHumanPrincipal } from './presence-registry'
import { renameOnTargetPath, type RenameServices } from './rename-target-path'
import { sessionSurfaceManifest } from './trpc'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const reg of registries.splice(0)) reg.dispose()
})

/** One real stack. Two of these, seeded identically, are the shadow pair. */
function stack() {
  const store = new SessionStore(':memory:')
  const reg = new SessionRegistry(store)
  registries.push(reg)
  reg.gateway.attachDaemon('local', () => {})
  return { store, sessions: reg.modules.sessions, mutations: reg.modules.mutations }
}

/** What both paths write, read back off the row. The shared observable truth. */
function observe(sessions: SessionRegistry['modules']['sessions'], sessionId: string) {
  const row = sessions.listSessions().find((s) => s.sessionId === sessionId)
  return { name: row?.name, nameSource: row?.nameSource }
}

/** The coarsest verdict that still tells accept from reject-with-reason. */
type Verdict =
  | { kind: 'applied' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'refused' }

/**
 * The AGENT principal, on both paths.
 *
 * `actorSessionId` is the existing seam for the actor half (§3.1.3 A3), and it is
 * what makes the legacy path route through `setAgentName` and the target path
 * build an agent `CommandPrincipal`. Both therefore hit SP-eb60's arbitration —
 * which is the branch this comparison most needs to cover, since it is the one
 * with two possible answers.
 */
const agentCapability = { ...OPERATOR, actorSessionId: asSessionId('agent-sess-1') }

const agentPrincipal: CommandPrincipal = {
  kind: 'agent',
  agentSessionId: asSessionId('agent-sess-1'),
  onBehalfOf: FIRST_ADMIN_USER_ID,
  capability: agentCapability,
  chain: [],
}

const humanPrincipal: CommandPrincipal = {
  kind: 'user',
  user: FIRST_ADMIN_USER_ID,
  capability: OPERATOR,
}

type Actor = 'human' | 'agent'

/** Run one rename on the LEGACY path and report the verdict + resulting row. */
function runLegacy(input: { sessionId: string; name: string }, actor: Actor) {
  const { store, sessions, mutations } = stack()
  const created = sessions.createSession({ agentKind: 'shell', cwd: '/p' })
  const presence = new PresenceRegistry({ sessions, store, now: () => 1, mutations })
  const capability = actor === 'agent' ? agentCapability : OPERATOR

  const result = presence.execute(
    'sessions.rename',
    { ...input, sessionId: created.sessionId },
    soleHumanPrincipal(capability),
    'trpc',
  )

  // The legacy handler returns setAgentName's raw shape for an agent, and
  // `undefined` for a human. Normalise to the shared verdict vocabulary.
  const value = result.value as { ok?: boolean; reason?: string } | undefined
  const verdict: Verdict =
    result.outcome !== 'applied'
      ? { kind: 'refused' }
      : value?.ok === false
        ? { kind: 'rejected', reason: value.reason ?? '' }
        : { kind: 'applied' }

  return { verdict, row: observe(sessions, created.sessionId), sessions, store, mutations, created }
}

/** Run the SAME rename on the TARGET path, on its own identically-seeded stack. */
function runTarget(input: { sessionId: string; name: string }, actor: Actor) {
  const { sessions, mutations } = stack()
  const created = sessions.createSession({ agentKind: 'shell', cwd: '/p' })
  const deps = { sessions: sessions as RenameServices, mutations }

  const dispatch = renameOnTargetPath(
    deps,
    { ...input, sessionId: created.sessionId },
    actor === 'agent' ? agentPrincipal : humanPrincipal,
    'trpc',
  )

  const verdict: Verdict =
    dispatch.outcome !== 'applied' && dispatch.outcome !== 'replayed'
      ? { kind: 'refused' }
      : dispatch.result.ok
        ? { kind: 'applied' }
        : { kind: 'rejected', reason: dispatch.result.reason }

  return { verdict, row: observe(sessions, created.sessionId), sessions, created, deps }
}

// ---------------------------------------------------------------------------
// THE COMPARISON
// ---------------------------------------------------------------------------

/**
 * The input matrix. Chosen to cover every branch BOTH implementations have:
 * the human trim path, the agent trim-and-collapse path, the empty-name clear,
 * the empty-name agent refusal, and the 120-character boundary.
 */
const CASES: ReadonlyArray<{ name: string; actor: Actor; why: string }> = [
  { name: 'a plain rename', actor: 'human', why: 'the ordinary human write' },
  { name: 'a plain rename', actor: 'agent', why: 'the ordinary agent write' },
  { name: '  padded  ', actor: 'human', why: 'human trims only' },
  { name: '  two   words  ', actor: 'agent', why: 'agent trims AND collapses' },
  { name: '', actor: 'human', why: 'clearing the name clears the source' },
  { name: '   ', actor: 'human', why: 'whitespace-only is a clear' },
  { name: '   ', actor: 'agent', why: 'whitespace-only is an agent REFUSAL' },
  { name: 'a'.repeat(120), actor: 'agent', why: 'exactly at the cap' },
  { name: 'a'.repeat(120), actor: 'human', why: 'exactly at the cap' },
]

describe('shadow comparison: the legacy and target paths agree on every case', () => {
  for (const { name, actor, why } of CASES) {
    it(`agrees for [${actor}] ${why}`, () => {
      const legacy = runLegacy({ sessionId: asSessionId('x'), name }, actor)
      const target = runTarget({ sessionId: asSessionId('x'), name }, actor)

      // ONE assertion over BOTH paths. A divergence in the written row or in the
      // verdict fails HERE — there is no second green test to hide behind.
      expect({ row: target.row, verdict: target.verdict }).toEqual({
        row: legacy.row,
        verdict: legacy.verdict,
      })
    })
  }

  it('agrees on the SP-eb60 arbitration: an agent rename over a human-set name', () => {
    // The branch with two possible answers, and the reason string is compared
    // verbatim — a migration that quietly reworded a user-visible refusal would
    // fail here rather than ship.
    const legacy = runLegacy({ sessionId: asSessionId('x'), name: 'human choice' }, 'human')
    const legacyAgent = new PresenceRegistry({
      sessions: legacy.sessions,
      store: legacy.store,
      now: () => 1,
      mutations: legacy.mutations,
    }).execute(
      'sessions.rename',
      { sessionId: legacy.created.sessionId, name: 'agent guess' },
      soleHumanPrincipal(agentCapability),
      'trpc',
    )

    const target = runTarget({ sessionId: asSessionId('x'), name: 'human choice' }, 'human')
    const targetAgent = renameOnTargetPath(
      target.deps,
      { sessionId: target.created.sessionId, name: 'agent guess' },
      agentPrincipal,
      'trpc',
    )

    const legacyValue = legacyAgent.value as { ok?: boolean; reason?: string }
    expect(legacyValue.ok).toBe(false)
    expect(targetAgent.outcome).toBe('applied')
    if (targetAgent.outcome !== 'applied') throw new Error('unreachable')
    expect(targetAgent.result.ok).toBe(false)
    if (targetAgent.result.ok) throw new Error('unreachable')

    // The reasons match, verbatim.
    expect(targetAgent.result.reason).toBe(legacyValue.reason)
    // And neither path moved the human's name.
    expect(observe(target.sessions, target.created.sessionId)).toEqual(
      observe(legacy.sessions, legacy.created.sessionId),
    )
    expect(observe(target.sessions, target.created.sessionId).nameSource).toBe('user')
  })

  it('agrees that an unknown session is a silent no-op on both paths', () => {
    // The consistent-error rule (§3.1.5): invisible and nonexistent must be
    // indistinguishable, and both paths must produce the SAME indistinguishable
    // answer or the migration itself becomes the oracle.
    const { store, sessions, mutations } = stack()
    const presence = new PresenceRegistry({ sessions, store, now: () => 1, mutations })
    const legacy = presence.execute(
      'sessions.rename',
      { sessionId: asSessionId('no-such-session'), name: 'x' },
      soleHumanPrincipal(OPERATOR),
      'trpc',
    )
    const target = renameOnTargetPath(
      { sessions: sessions as RenameServices, mutations },
      { sessionId: asSessionId('no-such-session'), name: 'x' },
      humanPrincipal,
      'trpc',
    )

    expect(legacy.outcome).toBe('denied')
    expect(target.outcome).toBe('denied')
    // Neither carries a reason, a name or any detail that would distinguish
    // "you may not" from "it is not there".
    expect(Object.keys(target)).toEqual(['outcome'])
    expect(legacy.value).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// PROVE THE COMPARISON CAN FAIL
// ---------------------------------------------------------------------------

/**
 * A shadow comparison that has only ever been observed agreeing is not evidence.
 * These tests mutate ONE path in process and assert the comparison reds — so the
 * green above is a measurement rather than a coincidence.
 */
describe('the shadow comparison is able to FAIL', () => {
  it('reds when one path writes a different name', () => {
    const legacy = runLegacy({ sessionId: asSessionId('x'), name: 'agreed' }, 'human')
    const target = runTarget({ sessionId: asSessionId('x'), name: 'agreed' }, 'human')

    // Divergence injected into the TARGET stack only, through the real service —
    // the same method the path calls, so this is the divergence a real regression
    // would produce rather than a hand-built object.
    target.sessions.renameSession({ sessionId: target.created.sessionId, name: 'diverged' })

    expect(() =>
      expect({ row: observe(target.sessions, target.created.sessionId) }).toEqual({
        row: legacy.row,
      }),
    ).toThrow()
  })

  it('reds when one path writes a different nameSource', () => {
    // The subtler divergence, and the one a name-only comparison would MISS: same
    // string, different provenance. If the comparison did not read `nameSource`,
    // an agent write laundered as a human write would pass the shadow and take
    // SP-eb60's sovereignty with it.
    const legacy = runLegacy({ sessionId: asSessionId('x'), name: 'same string' }, 'human')
    const target = runTarget({ sessionId: asSessionId('x'), name: 'same string' }, 'agent')

    expect(legacy.row.name).toBe(target.row.name)
    expect(legacy.row.nameSource).not.toBe(target.row.nameSource)
    expect(() => expect(target.row).toEqual(legacy.row)).toThrow()
  })

  it('reds when the two paths disagree about accept versus reject', () => {
    const legacy = runLegacy({ sessionId: asSessionId('x'), name: '   ' }, 'agent') // refused
    const target = runTarget({ sessionId: asSessionId('x'), name: 'fine' }, 'agent') // applied

    expect(legacy.verdict.kind).toBe('rejected')
    expect(target.verdict.kind).toBe('applied')
    expect(() => expect(target.verdict).toEqual(legacy.verdict)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// THE ADAPTER: exactly one command moved
// ---------------------------------------------------------------------------

describe('the compatibility adapter moves ONE command and defaults to the target path', () => {
  it('defaults to the target path in production config', () => {
    // The acceptance criterion is that rename RUNS on the target path in
    // production config — not that it is available behind a flag. A default of
    // 'legacy' would leave the target path with zero production callers.
    expect(renamePath({})).toBe('target')
  })

  it('falls back to legacy only for the exact documented value', () => {
    expect(renamePath({ [RENAME_PATH_ENV]: 'legacy' })).toBe('legacy')
    expect(renamePath({ [RENAME_PATH_ENV]: 'target' })).toBe('target')
    // A typo must not silently disable a shipped command.
    expect(renamePath({ [RENAME_PATH_ENV]: 'LEGACY' })).toBe('target')
    expect(renamePath({ [RENAME_PATH_ENV]: 'lgeacy' })).toBe('target')
  })

  it('has migrated EXACTLY sessions.rename, and left the other ten alone', () => {
    // "The legacy path is unchanged for all other commands" as an assertion
    // rather than as a claim in a commit message. A list that grew without this
    // failing is how one low-risk command becomes a broad migration.
    expect(MIGRATED_COMMANDS).toEqual(['sessions.rename'])

    const stillLegacy = PresenceRegistry.names().filter((n) => !MIGRATED_COMMANDS.includes(n))
    expect(stillLegacy).toEqual([
      'sessions.setArchived',
      'sessions.setWorkState',
      'sessions.setIssueId',
      'sessions.markRead',
      'sessions.markUnread',
      'snoozes.set',
      'snoozes.clear',
      'pins.set',
      'tabs.setOrder',
      'sessions.setDraft',
    ])
  })
})

// ---------------------------------------------------------------------------
// A DEFECT THIS SKELETON FOUND — NOW CLOSED (POD-1172, by POD-1075)
// ---------------------------------------------------------------------------

/**
 * TWO CONSTANTS NAMED THE ONE PRE-ACCOUNTS HUMAN, and the delegation ceiling was
 * the first code in the tree to put them side by side:
 *
 *   SOLE_USER_ID   'user:sole'       @podium/model, POD-380 — what sessionOwner stamps
 *   INSTANCE_OWNER 'instance-owner'  command-principal.ts, POD-381 — what resolvePrincipal minted
 *
 * Nothing compared them before, because POD-380 read owners with a principal
 * built from the first and POD-381 built principals nobody checked against an
 * owner column. The ceiling needed both, and unreconciled it DENIED EVERY AGENT
 * WRITE — a liveness defect that failed closed, so not a leak, but one that would
 * have surfaced as "agents inexplicably cannot rename".
 *
 * POD-351 bridged it in ONE named place (`samePrincipal`) and put a TRIPWIRE on
 * the premise — an assertion that the two constants still differed — so that
 * whoever reconciled them would be told to delete the bridge rather than let it
 * become a permanent alias table.
 *
 * IT FIRED, AND THIS IS WHAT REPLACED IT. POD-1075's `FIRST_ADMIN_USER_ID` is
 * the reconciliation: one constant, value `'user:sole'`, because that is the id
 * the POD-380 migration had already written into every pin, snooze and
 * tab-order row and a migration is frozen history. `samePrincipal` is deleted,
 * the comparison in `rename-target-path.ts` is a plain equality, and the
 * tripwire is deleted with them.
 *
 * What survives is the test that was never about the bridge: the ceiling itself.
 * That one is kept — and strengthened — below.
 */
describe('the sole-human identity fork this skeleton surfaced, now reconciled', () => {
  it('there is ONE constant for the one human, and it is the stored value', () => {
    // The tripwire's successor. It asserts the reconciliation rather than the
    // fork: if a second spelling is ever reintroduced, the id the database
    // actually holds is the one that must win, and this says which that is.
    expect(FIRST_ADMIN_USER_ID as string).toBe(SOLE_USER_ID as string)
    expect(FIRST_ADMIN_USER_ID as string).toBe('user:sole')
  })

  it('an agent whose human IS the sole human may write — the ceiling can say YES', () => {
    // The positive control, and the test the old bridge existed to make pass.
    // Without it, the denial below could be produced by a ceiling that refuses
    // everything — which is exactly what the unreconciled constants DID, and
    // what nothing in the suite would have distinguished from correctness.
    const { sessions, mutations } = stack()
    const created = sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    const ownAgent: CommandPrincipal = {
      kind: 'agent',
      agentSessionId: asSessionId('agent-sess-8'),
      onBehalfOf: FIRST_ADMIN_USER_ID,
      capability: agentCapability,
      chain: [],
    }

    const dispatch = renameOnTargetPath(
      { sessions: sessions as RenameServices, mutations },
      { sessionId: created.sessionId, name: 'mine to rename' },
      ownAgent,
      'trpc',
    )

    expect(dispatch.outcome).toBe('applied')
    expect(observe(sessions, created.sessionId).name).toBe('mine to rename')
  })

  it('an agent whose human does NOT hold the session is denied at apply', () => {
    // The ceiling doing its job, and the counterfactual for the YES above: the
    // two together are what make the ceiling an instrument rather than a
    // constant answer.
    const { sessions, mutations } = stack()
    const created = sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    const strangersAgent: CommandPrincipal = {
      kind: 'agent',
      agentSessionId: asSessionId('agent-sess-9'),
      onBehalfOf: 'user:stranger' as typeof FIRST_ADMIN_USER_ID,
      capability: agentCapability,
      chain: [],
    }

    const dispatch = renameOnTargetPath(
      { sessions: sessions as RenameServices, mutations },
      { sessionId: created.sessionId, name: 'not yours' },
      strangersAgent,
      'trpc',
    )

    // Denied even though the AGENT's own capability is admin/all — the human
    // ceiling is what refuses, which is the intersection A1 requires.
    expect(dispatch.outcome).toBe('denied')
    expect(observe(sessions, created.sessionId).name).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// THE COMMAND IS ON THE DERIVED SURFACE, NOT BESIDE IT (POD-382 reconciliation)
// ---------------------------------------------------------------------------

/**
 * After POD-382's 3.2 cutover there is no hand-written session procedure to be —
 * `scripts/audit-session-commands.ts` fails the build if a `.mutation(` for a
 * session appears in `router.ts` at all. These pin that rename arrives through the
 * derived surface AND that it is the walking skeleton's envelope rather than the
 * presence one, which is the whole point of the issue and the single fact most
 * likely to be silently undone by a later edit to the manifest walk.
 */
describe('rename is served by the derived surface, on the target envelope', () => {
  it('appears exactly once in the session-surface manifest, with source walking-skeleton', () => {
    const rows = sessionSurfaceManifest().filter((e) => e.name === 'sessions.rename')

    expect(rows).toHaveLength(1)
    expect(rows[0]?.source).toBe('walking-skeleton')
    expect(rows[0]?.router).toBe('sessions')
    expect(rows[0]?.key).toBe('rename')
  })

  it('is the ONLY command on that envelope — its ten siblings stay on presence', () => {
    // The counterfactual for the assertion above: `source` would also read
    // 'walking-skeleton' for rename if the walk had put EVERY presence command on
    // it. This is the "legacy path unchanged for all other commands" criterion,
    // asserted against the thing that actually decides which builder runs.
    const skeleton = sessionSurfaceManifest().filter((e) => e.source === 'walking-skeleton')
    expect(skeleton.map((e) => e.name)).toEqual(['sessions.rename'])

    const presence = sessionSurfaceManifest()
      .filter((e) => e.source === 'presence')
      .map((e) => e.name)
    expect(presence).toEqual([
      'sessions.setArchived',
      'sessions.setWorkState',
      'sessions.setIssueId',
      'sessions.markRead',
      'sessions.markUnread',
      'snoozes.set',
      'snoozes.clear',
      'pins.set',
      'tabs.setOrder',
    ])
  })

  it('is still governed by its presence contract’s exposure declaration', () => {
    // Moving the ENVELOPE must not move the DECLARATION. `presenceEntries()` throws
    // at module load if a listed name's contract stops declaring `trpc`, and rename
    // is still inside that walk — so this asserts the cross-check still covers it
    // rather than that a constant was copied.
    const contract = presenceCommand('sessions.rename')
    expect(contract).toBeDefined()
    expect(isExposedOn(contract as never, 'trpc')).toBe(true)
  })
})

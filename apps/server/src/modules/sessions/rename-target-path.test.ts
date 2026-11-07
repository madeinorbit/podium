/**
 * `sessions.rename` ON THE TARGET PATH (POD-351): the delegation ceiling, and the
 * command's place on the derived surface.
 *
 * The shadow comparison against the session-state envelope's rename is gone with
 * that envelope's rename (POD-6601): there is one path, and nothing to compare it
 * with. What is kept is what was never about the comparison: the ceiling can say
 * yes and no, and the route is the walking skeleton's.
 */

import { isExposedOn, sessionStateCommand } from '@podium/commands'
import { asSessionId, MemberId, type UserId } from '@podium/model'

import { afterEach, describe, expect, it } from 'vitest'
import { type CommandPrincipal, firstAdminMemberId } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { OPERATOR } from '../../test-support/capabilities'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { type RenameServices, renameOnTargetPath } from './rename-target-path'
import { sessionSurfaceManifest } from './trpc'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

/** One real stack. */
async function stack() {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  await attachHostDaemon(reg, () => {})
  return { store, sessions: reg.modules.sessions, mutations: reg.modules.mutations }
}

/** What the rename writes, read back off the row. */
async function observe(sessions: SessionRegistry['modules']['sessions'], sessionId: string) {
  const row = (await sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)
  return { name: row?.name, nameSource: row?.nameSource }
}

/** An agent's capability: the operator's, with the actor half (§3.1.3 A3). */
const agentCapability = { ...OPERATOR, actorSessionId: asSessionId('agent-sess-1') }

// ---------------------------------------------------------------------------
// A DEFECT THIS SKELETON FOUND — NOW CLOSED (POD-1172, by POD-1075)
// ---------------------------------------------------------------------------

/**
 * TWO CONSTANTS NAMED THE ONE PRE-ACCOUNTS HUMAN, and the delegation ceiling was
 * the first code in the tree to put them side by side:
 *
 *   firstAdminMemberId()   'user:sole'       @podium/model, POD-380 — what sessionOwner stamps
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
 * IT FIRED, AND THIS IS WHAT REPLACED IT. POD-1075's `firstAdminMemberId()` is
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
  it('there is ONE answer for the one human, and it is the STORED value', () => {
    // The tripwire's successor, and A2 sharpened rather than retired it. It used
    // to assert that the one constant spelled the value the database held. There
    // is no constant now: the first admin is a `mem_` id minted per
    // installation, so the assertion is the property the constant was standing
    // in for — what the code resolves IS the row `users` holds. A second
    // spelling reintroduced anywhere would disagree with this.
    expect(firstAdminMemberId() as string).not.toBe('user:sole')
    expect(() => MemberId.parse(firstAdminMemberId())).not.toThrow()
  })

  it('an agent whose human IS the sole human may write — the ceiling can say YES', async () => {
    // The positive control, and the test the old bridge existed to make pass.
    // Without it, the denial below could be produced by a ceiling that refuses
    // everything — which is exactly what the unreconciled constants DID, and
    // what nothing in the suite would have distinguished from correctness.
    const { sessions, mutations } = await stack()
    const created = await sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    const ownAgent: CommandPrincipal = {
      kind: 'agent',
      agentSessionId: asSessionId('agent-sess-8'),
      onBehalfOf: firstAdminMemberId(),
      capability: agentCapability,
      chain: [],
    }

    const dispatch = await renameOnTargetPath(
      { sessions: sessions as RenameServices, mutations },
      { sessionId: created.sessionId, name: 'mine to rename' },
      ownAgent,
      'trpc',
    )

    expect(dispatch.outcome).toBe('applied')
    expect((await observe(sessions, created.sessionId)).name).toBe('mine to rename')
  })

  it('an agent whose human does NOT hold the session is denied at apply', async () => {
    // The ceiling doing its job, and the counterfactual for the YES above: the
    // two together are what make the ceiling an instrument rather than a
    // constant answer.
    const { sessions, mutations } = await stack()
    const created = await sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    const strangersAgent: CommandPrincipal = {
      kind: 'agent',
      agentSessionId: asSessionId('agent-sess-9'),
      onBehalfOf: 'user:stranger' as UserId,
      capability: agentCapability,
      chain: [],
    }

    const dispatch = await renameOnTargetPath(
      { sessions: sessions as RenameServices, mutations },
      { sessionId: created.sessionId, name: 'not yours' },
      strangersAgent,
      'trpc',
    )

    // Denied even though the AGENT's own capability is admin/all — the human
    // ceiling is what refuses, which is the intersection A1 requires.
    expect(dispatch.outcome).toBe('denied')
    expect((await observe(sessions, created.sessionId)).name).toBeUndefined()
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

  it('is the ONLY command on that envelope — its siblings stay on presence', () => {
    // The counterfactual for the assertion above: `source` would also read
    // 'walking-skeleton' for rename if the walk had put EVERY session-state command on
    // it. This is the "legacy path unchanged for all other commands" criterion,
    // asserted against the thing that actually decides which builder runs.
    const skeleton = sessionSurfaceManifest().filter((e) => e.source === 'walking-skeleton')
    expect(skeleton.map((e) => e.name)).toEqual(['sessions.rename'])

    const presence = sessionSurfaceManifest()
      .filter((e) => e.source === 'session-state')
      .map((e) => e.name)
    // `sessions.setIssueId` has no route: `sync.submit` is its only door (POD-6416).
    expect(presence).toEqual([
      'sessions.setArchived',
      'sessions.setWorkState',
      'sessions.dismissOffer',
      'sessions.markRead',
      'sessions.markUnread',
      'snoozes.set',
      'snoozes.clear',
      'pins.set',
      'tabs.setOrder',
    ])
  })

  it('is still governed by its session-state contract’s exposure declaration', () => {
    // Moving the ENVELOPE must not move the DECLARATION. `presenceEntries()` throws
    // at module load if a listed name's contract stops declaring `trpc`, and rename
    // is still inside that walk — so this asserts the cross-check still covers it
    // rather than that a constant was copied.
    const contract = sessionStateCommand('sessions.rename')
    expect(contract).toBeDefined()
    expect(isExposedOn(contract as never, 'trpc')).toBe(true)
  })
})

import {
  asDeviceId,
  asUserId,
  firstAdminMemberId,
  ISSUE_PRIVATE_EXECUTION_KEYS,
  type IssueExecutionProjection,
  joinIssueExecution,
} from '@podium/model'
import { asCapabilityRef, type Principal } from '@podium/protocol'
import type { ServerMessage } from '@podium/protocol'
import { encode } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { issueRowToProjection } from './modules/issues/projection'
import { SessionRegistry } from './relay'
import { attachTestClient } from './test-support/client-transport'
import { fixtureInventory } from './test-support/daemon-inventory'
import { openTestStore } from './test-support/open-test-store'

/**
 * **WHAT A NON-OWNER GRANT-HOLDER ACTUALLY RECEIVES** — the transport evidence
 * PDM-415 was opened to supply, and the half B4's split did not buy.
 *
 * PDM-405 measured the publication seam against the issue's OWNER, who is
 * entitled to the four private execution keys, and bounded its own finding
 * accordingly: it had shown the shared `issue`/`issueProjection` rows still
 * CARRY the keys, and had NOT shown a reader who is not the owner receiving
 * them. This file attaches that reader.
 *
 * WHY THE CONTROLS ARE THE POINT OF THE FILE. A red assertion about a payload
 * proves nothing on its own — it is equally consistent with a fixture that
 * scopes nothing, or with a grantee who receives every row because the harness
 * never consulted a predicate. So the load-bearing assertion is surrounded by
 * three soft controls that must each hold for it to mean anything:
 *
 *   1. A STRANGER receives nothing for this issue, WHILE receiving rows for a
 *      second issue it does hold a grant on   -> the fixture scopes per issue,
 *                                                and the empty result is NOT an
 *                                                inert client.
 *      BOUNDED [PDM-447]: that pair rules out an inert client and nothing more.
 *      It shows filtering happens PER ISSUE; it does not identify WHICH
 *      mechanism filtered, and several would produce the same two numbers. The
 *      grant clause is the mechanism named in `feed-visibility.ts`, but this
 *      test does not discriminate it from any other per-issue filter.
 *   2. The GRANTEE receives the two shared kinds       -> the grant admits, so
 *                                                         the key assertion is
 *                                                         not vacuous.
 *   3. The GRANTEE receives NO `issueExecution`, and
 *      the OWNER does                                  -> B4's predicate arm is
 *                                                         intact, so this is a
 *                                                         hole in the SHARED
 *                                                         PAYLOAD and not a
 *                                                         broken predicate.
 *
 * Control 3 is what makes the finding precise. `feed-visibility.test.ts` already
 * pins that a read-grantee is refused `issueExecution`, and that test is green.
 * It is green here too. The split's owner-only sidecar works exactly as
 * designed — and the grantee gets the same four values anyway, off the shared
 * rows the sidecar was supposed to take them from.
 *
 * WHAT THIS FILE DOES NOT ESTABLISH. It measures the live feed delta path for a
 * grant-holding member. It does not measure the bootstrap snapshot tail, the
 * `sync.changesSince` catch-up path, or the C4 (PDM-144) active-member class
 * policy that is to replace this predicate. Those are the same payload from the
 * same producers, but that is an argument, not a measurement, and it is not made
 * here.
 */

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

const OWNER = firstAdminMemberId()
const GRANTEE = asUserId('user:grantee')
const STRANGER = asUserId('user:stranger')

/** Values planted on the row so a key that arrives can be told apart from a key
 *  that arrives EMPTY. Run 1 of this file reported `machineId` "present" when
 *  nothing had ever set it — a null column, not a disclosure. Distinct,
 *  recognisable strings mean the assertion is about data that left the owner's
 *  machine, not about the shape of an object. */
const PRIVATE_MACHINE = 'machine-pdm-415-private'
/** The fourth private key. `startedBySession` is stamped at CREATE from the
 *  authenticated actor and is not an `update()` field, so it is planted with the
 *  issue rather than alongside the other three. */
const STARTED_BY = 'session-pdm-415-started-by'
const PLANTED: Record<string, string> = {
  worktreePath: '/wt/pdm-415-private',
  machineId: PRIVATE_MACHINE,
  coordinatorSessionId: 'session-pdm-415-coordinator',
}

type Seen = { entity: string; id: string; value: unknown }

const rowsFor = (inbox: ServerMessage[], issueId: string): Seen[] =>
  inbox.flatMap((message) => {
    if (message.type !== 'feedDelta') return []
    return message.changes
      .filter((change) => change.op !== 'evict' && change.entityId === issueId)
      .map((change) => ({
        entity: change.entity,
        id: change.entityId,
        value: (change as { value?: unknown }).value,
      }))
  })

/**
 * The private keys this payload carries WITH A NON-EMPTY VALUE, as `key=value`.
 *
 * THE RIGHT INSTRUMENT FOR PROVING THE DISCLOSURE, AND THE WRONG ONE FOR PROVING
 * THE FIX [PDM-447]. A key present but null is not a disclosure and must not be
 * counted as one, which is why the original finding measured values — run 1 of
 * this file reported `machineId` "present" when nothing had ever set it. But the
 * shared CONTRACT is ABSENCE, and this predicate ignores `null`: a mask that left
 * `worktreePath: null` on the payload would pass it. So it is kept for the
 * historical disclosure evidence and is NEVER the only assertion — every place
 * it appears, {@link privateKeysOn} asserts own-property absence beside it.
 */
const privateValuesOn = (value: unknown): string[] => {
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  return ISSUE_PRIVATE_EXECUTION_KEYS.filter(
    (key) => record[key] !== undefined && record[key] !== null,
  ).map((key) => `${key}=${String(record[key])}`)
}

/** `issues.update` validates `machineId` against the machine registry, so the
 *  planted id has to name a real one. Owned by the issue's owner, which is also
 *  what makes it private data: under "exactly one human may execute through
 *  Podium on a machine" the id maps the task to a person. */
async function registerMachine(
  store: Awaited<ReturnType<typeof openTestStore>>,
): Promise<void> {
  await store.machines.upsertMachine({
    id: PRIVATE_MACHINE,
    name: 'private',
    hostname: 'private',
    tokenHash: 'x',
    ownerUserId: OWNER,
  })
  await store.machines.setMachineInventory(
    PRIVATE_MACHINE,
    JSON.stringify(fixtureInventory({ agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }] })),
  )
}

/**
 * The private keys this payload carries AS OWN PROPERTIES, whatever their value
 * [PDM-447].
 *
 * `Object.hasOwn` rather than `in`, so a key inherited from a prototype is not
 * counted as the payload carrying it, and rather than a truthiness test, so
 * `null` and `undefined` COUNT. This is the one that pins the shared contract:
 * `SharedIssueWire` / `SharedIssueProjection` omit these keys, so a conforming
 * payload does not have them at all.
 */
const privateKeysOn = (value: unknown): string[] =>
  typeof value === 'object' && value !== null
    ? ISSUE_PRIVATE_EXECUTION_KEYS.filter((key) => Object.hasOwn(value, key))
    : []

async function grantRead(
  store: Awaited<ReturnType<typeof openTestStore>>,
  issueId: string,
  grantee: string = GRANTEE,
): Promise<void> {
  await store.grants.upsert({
    resourceKind: 'issue',
    resourceId: issueId,
    grantee,
    verb: 'read',
    owner: OWNER,
    visibility: 'personal',
    createdAt: '2026-09-13T00:00:00.000Z',
    actorKind: 'user',
    actorId: OWNER,
    onBehalfOf: OWNER,
  })
}

async function readyClient(
  registry: SessionRegistry,
  userId: string,
): Promise<ServerMessage[]> {
  const inbox: ServerMessage[] = []
  const clientId = attachTestClient(registry.clientGateway, {
    send: (message) => inbox.push(message),
    userId: asUserId(userId),
    userRole: 'member',
  })
  await registry.clientGateway.routeClientFrame(clientId, {
    type: 'hello',
    wireVersion: 2,
    clientId: '',
    viewport: { cols: 80, rows: 24, dpr: 1 },
  })
  await expect.poll(() => inbox.some((m) => m.type === 'feedBootstrap' && m.last)).toBe(true)
  return inbox
}

describe('the shared issue rows a non-owner grant-holder receives [PDM-415]', () => {
  it('a read grant admits the shared rows, and those rows carry the private execution values', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)

    await registerMachine(store)
    const issue = await registry.issues.create({
      repoPath: '/r',
      title: 'solo',
      startNow: false,
      startedBySession: STARTED_BY,
    })
    // A SECOND issue the stranger DOES hold a read grant on. Its only job is to
    // make control 1 discriminating. Without it, "the stranger received nothing"
    // is one reason wide: it is equally satisfied by a client that never
    // subscribed to anything, by a ref that never entered the prefetch, and by
    // the grant clause actually refusing. With it, the SAME client in the SAME
    // flush receives rows for one issue and not the other, so the only surviving
    // explanation is the per-issue predicate.
    const bystander = await registry.issues.create({
      repoPath: '/r',
      title: 'bystander',
      startNow: false,
    })

    // The fixture is only meaningful if the issue is owned by somebody OTHER
    // than the grantee. Pinned rather than assumed.
    const row = await store.issues.getIssue(issue.id)
    expect.soft(row?.ownerUserId).toBe(OWNER)
    expect.soft(row?.ownerUserId).not.toBe(GRANTEE)

    await grantRead(store, issue.id)
    await grantRead(store, bystander.id, STRANGER)

    const owner = await readyClient(registry, OWNER)
    const grantee = await readyClient(registry, GRANTEE)
    const stranger = await readyClient(registry, STRANGER)
    for (const inbox of [owner, grantee, stranger]) inbox.length = 0

    // MOVE THE PRIVATE KEYS, and touch the bystander in the SAME window so the
    // stranger's two results are produced by one flush and one client.
    await registry.issues.update(issue.id, PLANTED)
    await registry.issues.update(bystander.id, { notes: 'bystander touched' })
    registry.modules.funnel.flushDeltas()

    await expect.poll(() => rowsFor(owner, issue.id).length).toBeGreaterThan(0)
    await expect.poll(() => rowsFor(stranger, bystander.id).length).toBeGreaterThan(0)

    const ownerRows = rowsFor(owner, issue.id)
    const granteeRows = rowsFor(grantee, issue.id)
    const strangerRows = rowsFor(stranger, issue.id)
    const strangerBystanderRows = rowsFor(stranger, bystander.id)

    // ---- CONTROL 1: the fixture scopes, and it scopes BY ISSUE. -----------
    // The negative and its discriminator, asserted as a pair. The stranger is a
    // live feed participant — it receives the bystander it holds a grant on —
    // and receives nothing for the issue it does not. An inert client would fail
    // the first of these; only the grant clause explains both.
    expect.soft(strangerBystanderRows.length).toBeGreaterThan(0)
    expect.soft(strangerRows.map((r) => r.entity)).toEqual([])

    // ---- CONTROL 2: the grant admits the shared rows (non-vacuity). -------
    expect.soft(granteeRows.filter((r) => r.entity === 'issue').length).toBeGreaterThan(0)
    expect.soft(granteeRows.filter((r) => r.entity === 'issueProjection').length).toBeGreaterThan(0)

    // ---- CONTROL 3: B4's owner-only sidecar arm is intact. ----------------
    expect.soft(granteeRows.filter((r) => r.entity === 'issueExecution').length).toBe(0)
    expect.soft(ownerRows.filter((r) => r.entity === 'issueExecution').length).toBeGreaterThan(0)

    // ---- THE MEASUREMENT. -------------------------------------------------
    const carried = granteeRows
      .filter((r) => r.entity === 'issue' || r.entity === 'issueProjection')
      .flatMap((r) => privateValuesOn(r.value).map((kv) => `${r.entity} ${kv}`))

    // THE HISTORICAL DISCLOSURE EVIDENCE. Values, not presence: this is the
    // assertion that was red before the mask, carrying all sixteen planted
    // values, and it is what makes the finding a disclosure rather than a shape
    // complaint. Kept exactly as it was.
    expect.soft(carried).toEqual([])

    // THE CONTRACT ITSELF [PDM-447]. `SharedIssueWire` / `SharedIssueProjection`
    // OMIT these keys, so a conforming payload does not have them at all. The
    // assertion above ignores `null`, so a mask that nulled the fields instead of
    // dropping them would satisfy it; this one does not.
    const present = granteeRows
      .filter((r) => r.entity === 'issue' || r.entity === 'issueProjection')
      .flatMap((r) => privateKeysOn(r.value).map((k) => `${r.entity} ${k}`))
    expect(present).toEqual([])
  })

  it('the values survive JSON encoding, so they cross the wire and not just the in-process seam', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await registerMachine(store)
    const issue = await registry.issues.create({
      repoPath: '/r',
      title: 'solo',
      startNow: false,
      startedBySession: STARTED_BY,
    })
    await grantRead(store, issue.id)
    const grantee = await readyClient(registry, GRANTEE)
    grantee.length = 0

    await registry.issues.update(issue.id, PLANTED)
    registry.modules.funnel.flushDeltas()
    await expect.poll(() => rowsFor(grantee, issue.id).length).toBeGreaterThan(0)

    // `encode` is `JSON.stringify` with NO schema parse on the way out
    // (packages/protocol/src/messages/codec.ts) — the strict arms are a producer
    // TYPE, and the only `ServerMessage.parse` calls are the DECODE side. So the
    // object this in-process fixture observes is what a socket would serialise.
    // Round-tripping it says that with a command instead of a claim about the
    // codec, and it also rules out a key that only exists as a non-enumerable
    // or prototype property of the in-memory object.
    const shared = grantee
      .filter((m) => m.type === 'feedDelta')
      .map((m) => JSON.parse(encode(m)) as typeof m)
      .flatMap((m) => m.changes)
      .filter(
        (c) => c.entityId === issue.id && (c.entity === 'issue' || c.entity === 'issueProjection'),
      )

    // Non-vacuity: there must BE rows to inspect after the round trip.
    expect.soft(shared.length).toBeGreaterThan(0)
    expect.soft(shared.flatMap((c) => privateValuesOn((c as { value?: unknown }).value))).toEqual([])
    // Own-property absence after the round trip too [PDM-447]. `JSON.stringify`
    // DROPS an `undefined` value but KEEPS an explicit `null`, so these two
    // assertions can come apart here in a way they cannot in memory.
    expect(shared.flatMap((c) => privateKeysOn((c as { value?: unknown }).value))).toEqual([])
  })
})


/** A real user principal, so the scoped reads below are made AS somebody rather
 *  than as the device-grade default that bypasses per-user scoping. */
const principalFor = (user: string): Principal => ({
  kind: 'user',
  user: asUserId(user),
  device: asDeviceId('device:pdm-415'),
  capability: asCapabilityRef('cap:pdm-415'),
})

/** Every row for one issue in a bootstrap OR a delta frame. The bootstrap
 *  carries the same `FeedChange` shape as a delta, so one reader serves both and
 *  the two paths are compared like with like. */
const allRowsFor = (inbox: ServerMessage[], issueId: string): Seen[] =>
  inbox.flatMap((message) => {
    if (message.type !== 'feedDelta' && message.type !== 'feedBootstrap') return []
    return message.changes
      .filter((c) => c.op !== 'evict' && c.entityId === issueId)
      .map((c) => ({ entity: c.entity, id: c.entityId, value: (c as { value?: unknown }).value }))
  })

/**
 * **THE OTHER HALF OF THE REPAIR** — masking must not strand the owner.
 *
 * Removing the keys from the broadcast payload is only correct if the entitled
 * reader gets them back. The owner's client does that with `joinIssueExecution`,
 * already wired at five call sites in `client-core`.
 *
 * WHAT THIS FILE'S OWNER WITNESS IS, EXACTLY [PDM-448]. It invokes
 * `joinIssueExecution` — the production JOIN FUNCTION — over REAL SERVING OUTPUT
 * taken from a real client's inbox. That makes it evidence about the SERVING
 * SEAM: the server emits a shared row and a sidecar row that the production join
 * can put back together. It is NOT evidence that the production CONSUMER does
 * so, because the consumer is `createReplicaBinding`'s `joinExecutions` and this
 * test does not run it. Calling this "owner-side client reassembly" without that
 * distinction overstated it, and the reviewer was right to separate the two.
 *
 * WHY THE CONSUMER IS NOT EXERCISED HERE RATHER THAN JUST NOT EXERCISED: the
 * `declared-deps` boundary rule refuses `apps/server` depending on
 * `@podium/client-core` (`modules/interactions/synthesis.ts:204` says so), so the
 * consumer is unreachable from this package by construction. It is covered
 * instead beside itself, in
 * `packages/client-core/src/engine/replica-binding.issue-execution.test.ts`,
 * which drives the real binding over held owner rows, an update and a sidecar
 * removal with an unrelated-row control.
 *
 * NEITHER FILE IS END-TO-END, AND THE PAIR SHOULD NOT BE READ AS ONE. Nothing
 * here runs a server's output INTO that binding; that would need a package
 * depending on both sides and this repair creates none. Serving seam here,
 * consumer seam there, and the join between them is an argument.
 */
describe("the owner's reassembly after masking [PDM-415]", () => {
  const reassemble = (rows: Seen[]) => {
    const shared = rows.find((r) => r.entity === 'issue')?.value as object | undefined
    const sidecar = rows.find((r) => r.entity === 'issueExecution')?.value as
      | IssueExecutionProjection
      | undefined
    return shared === undefined ? undefined : joinIssueExecution(shared, sidecar)
  }

  it('the SERVING SEAM hands the owner all four values, and an update moves them', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await registerMachine(store)
    const issue = await registry.issues.create({
      repoPath: '/r',
      title: 'solo',
      startNow: false,
      startedBySession: STARTED_BY,
    })
    const owner = await readyClient(registry, OWNER)
    owner.length = 0

    await registry.issues.update(issue.id, PLANTED)
    registry.modules.funnel.flushDeltas()
    await expect.poll(() => rowsFor(owner, issue.id).length).toBeGreaterThan(0)

    // NON-VACUITY: the shared row must have been masked, or the join below is
    // not what put the values back and this witness proves nothing.
    const sharedRow = rowsFor(owner, issue.id).find((r) => r.entity === 'issue')
    expect.soft(privateValuesOn(sharedRow?.value)).toEqual([])

    const joined = reassemble(rowsFor(owner, issue.id))
    expect.soft(joined).toBeDefined()
    expect(privateValuesOn(joined).sort()).toEqual(
      [
        `coordinatorSessionId=${PLANTED.coordinatorSessionId}`,
        `machineId=${PLANTED.machineId}`,
        `startedBySession=${STARTED_BY}`,
        `worktreePath=${PLANTED.worktreePath}`,
      ].sort(),
    )

    // AN UPDATE MOVES THEM. A join that returned a stale value would pass the
    // assertion above and fail this one.
    owner.length = 0
    await registry.issues.update(issue.id, { worktreePath: '/wt/moved' })
    registry.modules.funnel.flushDeltas()
    await expect.poll(() => rowsFor(owner, issue.id).length).toBeGreaterThan(0)
    const moved = reassemble(rowsFor(owner, issue.id))
    expect(privateValuesOn(moved)).toContain('worktreePath=/wt/moved')
    expect(privateValuesOn(moved)).not.toContain(`worktreePath=${PLANTED.worktreePath}`)
  })

  /**
   * THE REMOVAL HALF IS **UNCLEARED**, AND DELIBERATELY NOT ASSERTED HERE.
   *
   * The reviewer asked for owner-side reassembly including removal, so that
   * masking cannot strand entitled values. I measured it and found a defect that
   * is NOT MINE, so this file does not carry a red for it and does not pin the
   * behaviour either.
   *
   * WHAT I MEASURED. `purgeEmptyDraft` is the one HARD-remove path on the issue
   * service — the user-facing delete is a SOFT delete riding an `upsert` that
   * carries `deletedAt` (`prepareSoftDelete`), which masks like any other upsert
   * and IS covered by the witnesses above. On the hard path, an attached owner's
   * bootstrap carries all three rows for the draft —
   * `["issue/upsert","issueProjection/upsert","issueExecution/upsert"]` — and
   * after the purge the owner receives ZERO change rows. Nothing evicts any of
   * the three, including the `issueExecution` sidecar holding all four private
   * execution values.
   *
   * WHY IT IS NOT MINE. Run with the mask REMOVED from
   * `authority-arbitration.ts`, the same diagnostic prints the same three
   * bootstrap rows and the same zero changes. The behaviour is identical with
   * and without this issue's change, so the mask neither causes nor worsens it.
   * (`maskChangeSpecs` returns a `remove` spec by identity — a removal carries no
   * value — which is the mechanism behind that control.)
   *
   * THE BOUND, because it decides how alarming this is. I measured that NO
   * EVICTION ACCOMPANIES THE PURGE ITSELF, over a flush and ~600ms with no
   * further writes. I did NOT measure whether a later unrelated issue write
   * heals it through the full-truth `allProjections` reconcile. So "the row is
   * stranded forever" is NOT established; "the purge emits no eviction" is.
   * Filed as its own finding rather than absorbed here.
   */
})

/**
 * **THE SNAPSHOT AND CATCH-UP PRODUCERS, MEASURED SEPARATELY.**
 *
 * These read the same masked ledger baseline as the delta path, so it is
 * tempting to argue them from the delta result. That is a SOURCE ARGUMENT and it
 * is refused here on purpose: a shared payload source is not an executed
 * transport witness, and the whole reason PDM-415 exists is that an unexecuted
 * argument about these payloads was wrong once already.
 */
describe('the snapshot and catch-up producers, executed [PDM-415]', () => {
  it('a non-owner grant-holder attaching FRESH gets no private values in its bootstrap', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await registerMachine(store)
    const issue = await registry.issues.create({
      repoPath: '/r',
      title: 'solo',
      startNow: false,
      startedBySession: STARTED_BY,
    })
    await registry.issues.update(issue.id, PLANTED)
    await grantRead(store, issue.id)

    // Attached AFTER the keys were set, so its world arrives in the BOOTSTRAP
    // rather than as a delta. This is a different producer from the one the
    // first file measured.
    const grantee = await readyClient(registry, GRANTEE)
    const owner = await readyClient(registry, OWNER)

    const granteeBoot = allRowsFor(grantee, issue.id).filter(
      (r) => r.entity === 'issue' || r.entity === 'issueProjection',
    )
    // NON-VACUITY FIRST: the bootstrap must actually carry the issue, or the
    // absence of keys below is the absence of the row.
    expect.soft(granteeBoot.length).toBeGreaterThan(0)
    expect.soft(granteeBoot.flatMap((r) => privateValuesOn(r.value))).toEqual([])
    expect(granteeBoot.flatMap((r) => privateKeysOn(r.value))).toEqual([])

    // AND THE OWNER IS NOT STRANDED ON THIS PATH EITHER: its bootstrap carries
    // the sidecar, so its join still yields the four values.
    const ownerSidecar = allRowsFor(owner, issue.id).find((r) => r.entity === 'issueExecution')
    expect.soft(ownerSidecar).toBeDefined()
    expect(privateValuesOn(ownerSidecar?.value).length).toBe(4)
    // The grantee is refused that same row, which is what keeps the join
    // owner-only rather than merely relocating the disclosure.
    expect(allRowsFor(grantee, issue.id).filter((r) => r.entity === 'issueExecution')).toEqual([])
  })

  it('the SNAPSHOT producer masks for a non-owner principal', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await registerMachine(store)
    const issue = await registry.issues.create({
      repoPath: '/r',
      title: 'solo',
      startNow: false,
      startedBySession: STARTED_BY,
    })
    await registry.issues.update(issue.id, PLANTED)
    await grantRead(store, issue.id)

    // A NULL CURSOR RETURNS A SNAPSHOT, NOT A CATCH-UP DELTA [PDM-448]. This
    // case was called "catch-up" and asserted `kind === 'snapshot'`, which is the
    // snapshot producer read through `syncChangesSince` — worth having, and NOT
    // the incremental path. Retained as snapshot evidence under its real name;
    // the incremental case is the test below.
    //
    // `syncChangesSince` takes a PRINCIPAL, so this is read AS the grantee rather
    // than as the device-grade default that scopes nothing.
    const boot = await registry.modules.sessions.syncChangesSince(null, principalFor(GRANTEE))
    expect.soft(boot.kind).toBe('snapshot')
    if (boot.kind !== 'snapshot') return

    // POSITIVE CONTROLS ON **BOTH** KINDS [PDM-448]. A positive `issues` count
    // does not establish `issueProjections` presence, and the previous version
    // asserted non-vacuity on one kind while drawing a conclusion about two.
    const mine = boot.issues.filter((i) => (i as { id?: string }).id === issue.id)
    const mineProjections = (boot.issueProjections ?? []).filter(
      (p) => (p as { id?: string }).id === issue.id,
    )
    expect.soft(mine.length).toBeGreaterThan(0)
    expect.soft(mineProjections.length).toBeGreaterThan(0)

    expect.soft([...mine, ...mineProjections].flatMap((r) => privateValuesOn(r))).toEqual([])
    expect([...mine, ...mineProjections].flatMap((r) => privateKeysOn(r))).toEqual([])
  })

  it('the INCREMENTAL catch-up producer masks for a non-owner principal', async () => {
    // THE PATH THE PREVIOUS CASE NEVER REACHED [PDM-448]: a NON-NULL cursor, so
    // `funnel.changesSince` answers and the response is a `delta` rather than a
    // snapshot. Asserted by its explicit response shape, because `kind` is the
    // only thing that distinguishes which producer ran.
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await registerMachine(store)
    const issue = await registry.issues.create({
      repoPath: '/r',
      title: 'solo',
      startNow: false,
      startedBySession: STARTED_BY,
    })
    await grantRead(store, issue.id)

    // Take a cursor BEFORE the private keys move, so the write below is inside
    // the window the delta has to describe.
    const before = await registry.modules.sessions.syncChangesSince(null, principalFor(GRANTEE))
    expect.soft(before.kind).toBe('snapshot')
    await registry.issues.update(issue.id, PLANTED)

    const caught = await registry.modules.sessions.syncChangesSince(
      before.cursor,
      principalFor(GRANTEE),
    )
    // EXPLICIT RESPONSE SHAPE. If this said `snapshot` the assertions below would
    // be measuring the snapshot producer again under a different name.
    expect.soft(caught.kind).toBe('delta')
    if (caught.kind !== 'delta') return

    const rows = caught.changes.filter(
      (c) => c.id === issue.id && (c.entity === 'issue' || c.entity === 'issueProjection'),
    )
    // POSITIVE CONTROLS ON BOTH SHARED KINDS, separately — the delta must carry
    // each of them, or an absence of keys below is an absence of the row.
    expect.soft(rows.filter((c) => c.entity === 'issue').length).toBeGreaterThan(0)
    expect.soft(rows.filter((c) => c.entity === 'issueProjection').length).toBeGreaterThan(0)
    // The grantee must NOT be handed the owner-only sidecar on this path either.
    expect.soft(
      caught.changes.filter((c) => c.id === issue.id && c.entity === 'issueExecution'),
    ).toEqual([])

    expect.soft(rows.flatMap((c) => privateValuesOn((c as { value?: unknown }).value))).toEqual([])
    expect(rows.flatMap((c) => privateKeysOn((c as { value?: unknown }).value))).toEqual([])
  })
})

/**
 * **THE ACTUAL-PRODUCER PRESERVATION CHECK** [PDM-447].
 *
 * `shared-payload-mask.test.ts` compares key sets on a HAND-BUILT fixture. Even
 * the corrected version of that file is a claim about a payload I wrote, and the
 * reviewer's remaining item is the one it cannot answer: what does a REAL
 * producer emit, and does masking lose any of it?
 *
 * So this reconciles the two directly. It calls the real producer on a real
 * stored row, masks nothing itself, and compares that payload's key set against
 * what a real client actually received over the feed. Every supported key must
 * survive, and exactly the four private ones must not.
 */
describe('what a real producer emits, reconciled with what the client receives [PDM-447]', () => {
  it('the shared rows lose EXACTLY the four private keys and no supported field', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await registerMachine(store)

    // Populated deliberately wide, so the comparison has optional fields to lose.
    // A minimal issue would make "nothing was lost" a claim about a payload with
    // little in it — the fixture-sized-for-convenience shape.
    const issue = await registry.issues.create({
      repoPath: '/r',
      title: 'reconciliation subject',
      description: 'a shared description',
      brief: 'a shared brief',
      startNow: false,
      startedBySession: STARTED_BY,
      parentBranch: 'main',
      defaultAgent: 'claude-code',
      defaultModel: 'claude-opus-5',
      defaultEffort: 'high',
      priority: 2,
      type: 'task',
    })
    await registry.issues.update(issue.id, { ...PLANTED, notes: 'shared notes', branch: 'issue/x' })

    const owner = await readyClient(registry, OWNER)
    owner.length = 0
    await registry.issues.update(issue.id, { activityNotes: 'one more shared field' })
    registry.modules.funnel.flushDeltas()
    await expect.poll(() => rowsFor(owner, issue.id).length).toBeGreaterThan(0)

    // THE ACTUAL PRODUCER, called on the real stored row — not a fixture.
    const row = await store.issues.getIssue(issue.id)
    expect.soft(row).toBeDefined()
    if (!row) return
    const produced = issueRowToProjection(row, await store.issues.getIssueLabels(issue.id)) as Record<
      string,
      unknown
    >
    const producedKeys = Object.keys(produced)

    // NON-VACUITY, and it is the assertion that makes the rest mean anything: the
    // producer must really be emitting the private keys AND a broad set of shared
    // ones, or "nothing was lost" is a claim about an almost-empty object.
    expect.soft(ISSUE_PRIVATE_EXECUTION_KEYS.filter((k) => k in produced).sort()).toEqual(
      [...ISSUE_PRIVATE_EXECUTION_KEYS].sort(),
    )
    expect.soft(producedKeys.length).toBeGreaterThan(15)

    const received = rowsFor(owner, issue.id).find((r) => r.entity === 'issueProjection')
    expect.soft(received).toBeDefined()
    const receivedKeys = Object.keys((received?.value ?? {}) as object)

    // THE RECONCILIATION. Nothing the producer emits may go missing except the
    // four, and the four must go. Stated as a set difference in BOTH directions so
    // a loss and a leak are distinguishable in the diagnostic rather than summed.
    const lost = producedKeys.filter(
      (k) =>
        !receivedKeys.includes(k) && !(ISSUE_PRIVATE_EXECUTION_KEYS as readonly string[]).includes(k),
    )
    const leaked = receivedKeys.filter((k) =>
      (ISSUE_PRIVATE_EXECUTION_KEYS as readonly string[]).includes(k),
    )
    expect.soft(lost).toEqual([])
    expect(leaked).toEqual([])
  })

  it('the legacy issue wire loses EXACTLY the four as well', async () => {
    // The `issue` kind's producer is NOT a schema parse — it is a hand-built
    // literal in `IssueService.toWire` — so its preservation is a separate
    // question from `issueProjection`'s and is reconciled separately here rather
    // than assumed to follow.
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await registerMachine(store)
    const issue = await registry.issues.create({
      repoPath: '/r',
      title: 'legacy reconciliation subject',
      description: 'a shared description',
      brief: 'a shared brief',
      startNow: false,
      startedBySession: STARTED_BY,
    })
    await registry.issues.update(issue.id, { ...PLANTED, notes: 'shared notes' })

    const owner = await readyClient(registry, OWNER)
    owner.length = 0
    await registry.issues.update(issue.id, { activityNotes: 'one more shared field' })
    registry.modules.funnel.flushDeltas()
    await expect.poll(() => rowsFor(owner, issue.id).length).toBeGreaterThan(0)

    const row = await store.issues.getIssue(issue.id)
    if (!row) return
    const produced = (await registry.issues.toWire(row)) as unknown as Record<string, unknown>
    const producedKeys = Object.keys(produced)
    expect.soft(ISSUE_PRIVATE_EXECUTION_KEYS.filter((k) => k in produced).length).toBeGreaterThan(0)

    const received = rowsFor(owner, issue.id).find((r) => r.entity === 'issue')
    expect.soft(received).toBeDefined()
    const receivedKeys = Object.keys((received?.value ?? {}) as object)

    const lost = producedKeys.filter(
      (k) =>
        !receivedKeys.includes(k) && !(ISSUE_PRIVATE_EXECUTION_KEYS as readonly string[]).includes(k),
    )
    const leaked = receivedKeys.filter((k) =>
      (ISSUE_PRIVATE_EXECUTION_KEYS as readonly string[]).includes(k),
    )
    expect.soft(lost).toEqual([])
    expect(leaked).toEqual([])
  })
})


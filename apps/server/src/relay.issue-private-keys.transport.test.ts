import {
  asUserId,
  firstAdminMemberId,
  ISSUE_PRIVATE_EXECUTION_KEYS,
} from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import { encode } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
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
 *   1. A STRANGER receives nothing for this issue      -> the fixture scopes.
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

/** The private keys this payload carries WITH A NON-EMPTY VALUE, as
 *  `key=value`. A key present but null is not a disclosure and must not be
 *  counted as one; a key carrying the planted string is. */
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

async function grantRead(
  store: Awaited<ReturnType<typeof openTestStore>>,
  issueId: string,
): Promise<void> {
  await store.grants.upsert({
    resourceKind: 'issue',
    resourceId: issueId,
    grantee: GRANTEE,
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

    // The fixture is only meaningful if the issue is owned by somebody OTHER
    // than the grantee. Pinned rather than assumed.
    const row = await store.issues.getIssue(issue.id)
    expect.soft(row?.ownerUserId).toBe(OWNER)
    expect.soft(row?.ownerUserId).not.toBe(GRANTEE)

    await grantRead(store, issue.id)

    const owner = await readyClient(registry, OWNER)
    const grantee = await readyClient(registry, GRANTEE)
    const stranger = await readyClient(registry, STRANGER)
    for (const inbox of [owner, grantee, stranger]) inbox.length = 0

    // MOVE THE PRIVATE KEYS.
    await registry.issues.update(issue.id, PLANTED)
    registry.modules.funnel.flushDeltas()

    await expect.poll(() => rowsFor(owner, issue.id).length).toBeGreaterThan(0)

    const ownerRows = rowsFor(owner, issue.id)
    const granteeRows = rowsFor(grantee, issue.id)
    const strangerRows = rowsFor(stranger, issue.id)

    // ---- CONTROL 1: the fixture scopes at all. ----------------------------
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

    // The shared contract (`SharedIssueWire` / `SharedIssueProjection`, which
    // `protocol/messages/feed.ts` already names on both arms) omits all four
    // keys. A payload a non-owner receives must therefore carry none of them.
    // Red here IS the disclosure.
    expect(carried).toEqual([])
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
    expect(shared.flatMap((c) => privateValuesOn((c as { value?: unknown }).value))).toEqual([])
  })
})

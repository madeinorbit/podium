/**
 * A MIGRATED SESSION KEEPS BINDING AND RESUMING (POD-6283, `session-owner-is-its-starter`).
 *
 * The daemon never learns a session's `owner_user_id`. It stamps every resume
 * receipt with the human of the binding's server-authored DELEGATION
 * (`BindingStore.bindingOwner` = `delegation.onBehalfOf`, from the spawn
 * instruction, a handoff adoption or the server's binding facts at reconnect),
 * and acknowledges only acks that name that human. The server drops any receipt
 * whose owner is not the row's owner (`SessionBindingReceipts.observeResumeRef`).
 *
 * Before POD-6283 a session Bob started on Alice's task was stored with Alice as
 * owner while its delegation named Bob, so the daemon stamped Bob, the server
 * compared against Alice, and every receipt was dropped. The migration takes the
 * new owner from that same delegation, so after it the two agree: the receipt is
 * accepted, the resume ref is bound, and the daemon accepts the server's ack.
 *
 * This is the evidence for the multi-member path. The upgrade rehearsal on a
 * real one-member state directory cannot exercise it: its guard skips
 * one-member instances.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asAgentIdentityId,
  asMachineId,
  asSessionId,
  asUserId,
  type SessionDelegation,
  type UserId,
} from '@podium/model'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { BindingStore } from '../../../daemon/src/binding-store'
import { Session } from '../modules/sessions/session'
import { SessionBindingReceipts } from '../modules/sessions/session-binding'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'session-owner-is-its-starter'
const machineId = asMachineId('machine-bob')
const sessionId = asSessionId('bob-on-alice-task')
const bob = asUserId('mem_bob')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** What `authorSpawnBinding` wrote for Bob's session: Bob is the delegating human. */
const delegation: SessionDelegation = {
  revision: 1,
  actor: asAgentIdentityId(sessionId),
  onBehalfOf: bob,
  grantedScope: { kind: 'none' },
  parentBindingId: null,
}

function rewound(createdBy: UserId): { db: SqlDatabase; upgrade(): void; alice: UserId } {
  const db = openDatabase(':memory:')
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  const alice = (
    db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as {
      id: UserId
    }
  ).id
  db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)').run(
    bob,
    'Bob',
    'member',
    '2026-10-01T00:00:00.000Z',
  )
  if (createdBy !== bob) {
    db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)').run(
      createdBy,
      'Dan',
      'member',
      '2026-10-01T00:00:00.000Z',
    )
  }
  // The pre-POD-6283 row: the task's owner as owner, Bob as starter and delegate.
  db.prepare(
    `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, status, durable_label,
       created_at, last_active_at, machine_id, owner_user_id, delegation,
       created_by_actor_kind, created_by_actor_id, created_by_on_behalf_of)
     VALUES (?, 'claude-code', '/wt/a', 't', 'spawn', 'live', 'l', '2026-10-01T00:00:00.000Z',
       '2026-10-02T00:00:00.000Z', ?, ?, ?, 'user', ?, ?)`,
  ).run(sessionId, machineId, alice, JSON.stringify(delegation), createdBy, createdBy)
  return {
    db,
    alice,
    upgrade: () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1)),
  }
}

it.each([
  ['the recorded starter is the delegate', bob],
  // Never written by session-start, but if a row's two facts disagree the
  // owner must follow the delegation, which is what the machine binds by.
  ['the recorded starter differs from the delegate', asUserId('mem_dan')],
] as const)('a session adopted under its pre-migration owner binds its resume ref once migrated (%s)', async (_case, createdBy) => {
  const { db, upgrade, alice } = rewound(createdBy)
  try {
    const rowOwner = () =>
      (
        db.prepare('SELECT owner_user_id AS owner FROM sessions WHERE id = ?').get(sessionId) as {
          owner: UserId
        }
      ).owner
    expect(rowOwner()).toBe(alice)

    // THE DAEMON: the binding was adopted with the server's delegation, and its
    // exact resume receipt is stamped with that delegation's human.
    const root = mkdtempSync(join(tmpdir(), 'podium-owner-binding-'))
    roots.push(root)
    const daemon = await BindingStore.open({ dir: join(root, 'bindings') })
    await daemon.ensureBinding({
      sessionId,
      agentKind: 'claude-code',
      claimantMachineId: machineId,
      delegation,
    })
    const resume = { kind: 'claude-session', value: 'native-conversation' }
    expect(await daemon.recordPendingNativeReceipt(sessionId, resume, 'native-hook')).toBe(true)
    const replayed: DaemonMessage[] = []
    expect(
      await daemon.replayPendingReceiptForSession(sessionId, (msg) => replayed.push(msg)),
    ).toBe(1)
    const observation = replayed[0] as Extract<DaemonMessage, { type: 'sessionResumeRef' }>
    expect(observation.receipt?.ownerId).toBe(bob)

    // THE SERVER: the real receipt gate, reading the row's owner.
    const session = new Session({
      sessionId,
      durableLabel: 'l',
      agentKind: 'claude-code',
      cwd: '/wt/a',
      title: 't',
      origin: { kind: 'spawn' },
      createdAt: '2026-10-01T00:00:00.000Z',
      geometry: { cols: 80, rows: 24 },
      machineId,
      ownerUserId: alice,
      toDaemon: vi.fn(),
    })
    const toMachine: ControlMessage[] = []
    const receipts = new SessionBindingReceipts({
      memory: {
        ensureConversationIdentity: vi.fn(async () => 'conversation' as never),
        linkConversationSegment: vi.fn(async () => 'conversation' as never),
      },
      now: () => 0,
      sessions: () => [session],
      session: (id) => (id === sessionId ? session : undefined),
      sessionOwner: async () => ({ owner: rowOwner() }),
      write: async (target, mutate) => {
        const draft = target.captureDurableState()
        mutate(draft)
        target.installDurableState(draft)
      },
      broadcastSessions: vi.fn(),
      toMachine: (_machine, msg) => toMachine.push(msg),
    })

    // Before the migration the row says Alice and the receipt says Bob: dropped.
    await receipts.observeResumeRef(machineId, observation)
    expect(session.resume).toBeUndefined()
    expect(toMachine).toEqual([])

    upgrade()
    expect(rowOwner()).toBe(bob)

    // After it they agree: the ref binds and the server acknowledges it…
    await receipts.observeResumeRef(machineId, observation)
    expect(session.resume).toEqual(resume)
    const ack = toMachine.find(
      (msg): msg is Extract<ControlMessage, { type: 'sessionResumeRefAck' }> =>
        msg.type === 'sessionResumeRefAck',
    )
    expect(ack?.ownerId).toBe(bob)
    // …and the daemon accepts that ack, so the receipt stops replaying.
    expect(
      await daemon.acknowledgePendingReceipt(ack!.ownerId, sessionId, ack!.resume, ack!.receipt),
    ).toBe(true)
    expect(await daemon.pendingReceiptsForOwner(bob, sessionId)).toEqual([])
  } finally {
    db.close()
  }
})

/**
 * GENERIC SYNCED EDITS ON THE SYNC WRITE ENTRY POINT (ADR 12 D3/D4, POD-6391).
 *
 * Driven through the REAL composed server (`makeOracle`), over `sync.submit`, the
 * path the apps' outbox takes: the generic commands are registered where
 * `relay.ts` registers them, and every assertion reads back what was durably
 * written.
 */

import {
  defineSyncedKind,
  fieldConflict,
  freshRow,
  ISSUE_RECORD,
  pendingCells,
  RECORD_CONTRACTS,
  recordSpecField,
  recordStatusField,
  SYNCED_KINDS,
  specFields,
} from '@podium/commands'
import {
  asUserId,
  conflictRuleFor,
  deviceIdSchema,
  firstAdminMemberId,
  type IssueId,
  issueUserStateRowId,
  layoutRowId,
  OWNERSHIP_MATRIX_INDEX,
  ROW,
  type SessionId,
  sessionUserStateRowId,
} from '@podium/model'
import type { SyncSubmitReply } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import {
  appliedReply,
  envelope,
  expectAppliedOnPath,
  rowsOf,
  submit,
} from '../sync-write/outbox-test-support'
import { NO_TARGET } from '../sync-write/registry'
import { registerRecordKind } from './generic'

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value')
  return value
}

afterEach(() => disposeOracles())

const newIssueId = (): IssueId => `iss_${crypto.randomUUID()}` as IssueId

function refusal(reply: SyncSubmitReply) {
  if (reply.outcome !== 'rejected')
    throw new Error(`expected a refusal, got ${JSON.stringify(reply)}`)
  return reply.refusal
}

describe('each declaration agrees with ADR 1’s ownership matrix', () => {
  it('every field’s matrix row has the conflict rule its kind declares', () => {
    for (const d of SYNCED_KINDS) {
      for (const [name, field] of Object.entries(d.fields)) {
        expect(conflictRuleFor(field.row), `${d.kind}.${name}`).toBe(fieldConflict(d, name))
      }
    }
  })

  it('a spec field’s row admits a person or an agent as its writer', () => {
    for (const d of SYNCED_KINDS) {
      for (const name of specFields(d)) {
        const row = OWNERSHIP_MATRIX_INDEX.get(must(d.fields[name]).row)
        expect(
          row?.writers.some((w) => w === 'operator' || w === 'agent-session'),
          `${d.kind}.${name}`,
        ).toBe(true)
      }
    }
  })

  it('the composed registry serves every declared command', async () => {
    const o = await makeOracle()
    const names = o.reg.modules.syncWrite.registry.names()
    for (const name of Object.keys(RECORD_CONTRACTS)) expect(names, name).toContain(name)
  })
})

// ---------------------------------------------------------------------------
// The issue: exp-rev, a device-minted id, a server-filled label
// ---------------------------------------------------------------------------

async function repo(o: Oracle): Promise<void> {
  if (!(await o.store.repos.listRepoPaths()).includes('/p')) {
    await o.store.repos.addRepo('/p', o.store.hostMachineId)
  }
}

async function createIssue(o: Oracle, title = 'generic', id = newIssueId()): Promise<IssueId> {
  await repo(o)
  appliedReply(
    await submit(
      o,
      envelope(
        'records.issueProjection.create',
        { id, fields: { repoPath: '/p', title } },
        `c-${id}`,
      ),
    ),
  )
  return id
}

async function meta(o: Oracle, id: IssueId) {
  const row = await o.reg.modules.issues.reports.getMeta(id)
  if (row === null) throw new Error(`no issue ${id}`)
  return row
}

const edit = (
  id: IssueId,
  patch: Record<string, unknown>,
  expectedRevision: number | undefined,
  m: string,
) =>
  envelope(
    'records.issueProjection.edit',
    { id, patch, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
    m,
  )

describe('records.issueProjection.create', () => {
  it('files the issue under the device-minted id, with its seq label, on the path', async () => {
    const o = await makeOracle()
    await repo(o)
    const id = newIssueId()

    const { rows } = await expectAppliedOnPath(
      o,
      envelope(
        'records.issueProjection.create',
        { id, fields: { repoPath: '/p', title: 'minted' } },
        'm-create',
      ),
      { writes: true },
    )

    const row = await meta(o, id)
    expect(row.title).toBe('minted')
    // The label is the server's, filled inside the same write.
    expect(row.seq).toBeGreaterThan(0)
    expect(rows.some((r) => r.entity === 'issueProjection' && r.entityId === id)).toBe(true)
  })

  it('stores the row the creating device painted, on every cell the server does not assign (POD-6400)', async () => {
    const o = await makeOracle()
    await repo(o)
    const id = newIssueId()
    const fields = { repoPath: '/p', title: 'parity' }
    appliedReply(
      await submit(o, envelope('records.issueProjection.create', { id, fields }, 'm-parity')),
    )
    const change = (await rowsOf(o, 'm-parity')).find(
      (r) => r.entity === 'issueProjection' && r.entityId === id,
    )
    const stored = ISSUE_RECORD.wire.parse(JSON.parse(String(must(change).payload)))

    const painted = must(
      freshRow(ISSUE_RECORD, id, fields, { at: new Date().toISOString(), by: stored.owner }),
    )
    const pending = new Set(pendingCells(ISSUE_RECORD))
    const cells = new Set([...Object.keys(painted), ...Object.keys(stored)])
    const differ = [...cells].filter(
      (name) =>
        !pending.has(name) &&
        JSON.stringify((painted as Record<string, unknown>)[name]) !==
          JSON.stringify((stored as Record<string, unknown>)[name]),
    )
    // Every cell the server does not assign is the one the device painted.
    expect(differ).toEqual([])
    // And the server did assign the pending ones: a real number, its own clock.
    expect(stored.seq).toBeGreaterThan(0)
  })

  it('refuses an id that is not a device-minted one', async () => {
    const o = await makeOracle()
    await repo(o)
    for (const id of ['#12', 'POD-12', crypto.randomUUID(), 'iss_12']) {
      const reply = await submit(
        o,
        envelope(
          'records.issueProjection.create',
          { id, fields: { repoPath: '/p', title: 'x' } },
          `m-${id}`,
        ),
      )
      expect(refusal(reply).kind, id).toBe('invalid')
    }
  })

  it('never overwrites: an existing id under another envelope is a conflict', async () => {
    const o = await makeOracle()
    const id = await createIssue(o, 'first')

    const reply = await submit(
      o,
      envelope(
        'records.issueProjection.create',
        { id, fields: { repoPath: '/p', title: 'second' } },
        'm-again',
      ),
    )

    expect(refusal(reply)).toEqual({ kind: 'conflict' })
    expect((await meta(o, id)).title).toBe('first')
    expect(await rowsOf(o, 'm-again')).toEqual([])
  })
})

describe('records.issueProjection.edit', () => {
  it('applies a patch at the current revision, on the path', async () => {
    const o = await makeOracle()
    const id = await createIssue(o)
    const before = await meta(o, id)

    await expectAppliedOnPath(
      o,
      edit(id, { title: 'renamed', priority: 1 }, before.revision ?? undefined, 'm-edit'),
      {
        writes: true,
      },
    )

    const after = await meta(o, id)
    expect(after.title).toBe('renamed')
    expect(after.priority).toBe(1)
    expect(after.revision).toBeGreaterThan(before.revision ?? 0)
  })

  it('exp-rev: of two edits made at one revision, the second is refused', async () => {
    const o = await makeOracle()
    const id = await createIssue(o)
    const at = (await meta(o, id)).revision ?? undefined

    appliedReply(await submit(o, edit(id, { title: 'mine' }, at, 'm-first')))
    const second = await submit(o, edit(id, { title: 'theirs' }, at, 'm-second'))

    expect(refusal(second)).toMatchObject({ kind: 'conflict' })
    expect((await meta(o, id)).title).toBe('mine')
    expect(await rowsOf(o, 'm-second')).toEqual([])
  })

  it('a plain field names no revision: edits of two fields made at one revision both land (POD-6405)', async () => {
    const o = await makeOracle()
    const id = await createIssue(o)

    appliedReply(await submit(o, edit(id, { title: 'blind' }, undefined, 'm-title')))
    appliedReply(await submit(o, edit(id, { priority: 0 }, undefined, 'm-priority')))

    const row = await meta(o, id)
    expect([row.title, row.priority]).toEqual(['blind', 0])
  })

  it('labels go through the family’s set, normalized; a cleared defer ends the snooze; a past one unsnoozes', async () => {
    const o = await makeOracle()
    const id = await createIssue(o)

    appliedReply(await submit(o, edit(id, { labels: [' b', 'a', 'b'] }, undefined, 'm-labels')))
    const labelled = (await rowsOf(o, 'm-labels')).find(
      (r) => r.entity === 'issueProjection' && r.entityId === id,
    )
    expect(JSON.parse(String(must(labelled).payload)).labels).toEqual(['a', 'b'])

    appliedReply(
      await submit(o, edit(id, { deferUntil: '2099-01-01T00:00:00.000Z' }, undefined, 'm-defer')),
    )
    expect((await meta(o, id)).deferUntil).toBe('2099-01-01T00:00:00.000Z')

    appliedReply(
      await submit(o, edit(id, { deferUntil: '2000-01-01T00:00:00.000Z' }, undefined, 'm-undefer')),
    )
    const unsnoozed = (await meta(o, id)).deferUntil
    // The server backdated from ITS clock: just past, not the device's instant.
    expect(unsnoozed).not.toBe('2000-01-01T00:00:00.000Z')
    expect(Date.parse(String(unsnoozed))).toBeLessThan(Date.now())

    appliedReply(
      await submit(
        o,
        envelope(
          'records.issueProjection.edit',
          { id, patch: {}, unset: ['deferUntil'] },
          'm-clear',
        ),
      ),
    )
    expect((await meta(o, id)).deferUntil ?? null).toBeNull()

    appliedReply(await submit(o, edit(id, { archived: true }, undefined, 'm-archive')))
    expect((await meta(o, id)).archived).toBe(true)
  })

  it('refuses a field the caller may not write, and writes nothing', async () => {
    const o = await makeOracle()
    const id = await createIssue(o)
    const at = (await meta(o, id)).revision ?? undefined

    for (const patch of [
      { revision: 99 },
      { seq: 3 },
      { repoId: 'repo_x' },
      { updatedAt: 'now' },
    ]) {
      const m = `m-${Object.keys(patch)[0]}`
      const reply = await submit(o, edit(id, { title: 'sneaky', ...patch }, at, m))
      expect(refusal(reply), m).toEqual({ kind: 'unauthorized' })
      expect(await rowsOf(o, m)).toEqual([])
    }
    expect((await meta(o, id)).title).toBe('generic')
  })

  it('an undeclared field never parses', async () => {
    const o = await makeOracle()
    const id = await createIssue(o)
    const at = (await meta(o, id)).revision ?? undefined

    const reply = await submit(o, edit(id, { stage: 'done' }, at, 'm-stage'))

    expect(refusal(reply).kind).toBe('invalid')
  })

  it('an edit of an issue that does not exist is refused', async () => {
    const o = await makeOracle()
    await repo(o)

    const reply = await submit(o, edit(newIssueId(), { title: 'ghost' }, 1, 'm-ghost'))

    expect(refusal(reply).kind).toBe('target-not-found')
  })
})

describe('issues.create checks a device id’s shape (ADR 12 D4)', () => {
  it('accepts iss_<uuid> and refuses anything else', async () => {
    const o = await makeOracle()
    await repo(o)
    const id = newIssueId()

    const created = await o.call.issues.create({ id, repoPath: '/p', title: 'ok', startNow: false })
    expect(created.id).toBe(id)

    for (const bad of ['POD-12', '#12', 'iss_12', crypto.randomUUID()]) {
      await expect(
        o.call.issues.create({ id: bad as IssueId, repoPath: '/p', title: 'bad', startNow: false }),
        bad,
      ).rejects.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// A person's session state: single-writer, the user in the key
// ---------------------------------------------------------------------------

async function shellSession(o: Oracle): Promise<SessionId> {
  return (await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })).sessionId
}

const ME = firstAdminMemberId()
const SOMEONE_ELSE = asUserId('mem_0000000000000000000000000000')

const readAt = (o: Oracle, sessionId: SessionId) => o.store.sessions.getReadAt(ME, sessionId)

const editState = (id: string, patch: Record<string, unknown>, m: string) =>
  envelope('records.sessionUserState.edit', { id, patch }, m)

describe('records.sessionUserState', () => {
  it('sets my read mark to the patched value, on the path', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)
    const id = sessionUserStateRowId(ME, sessionId)

    await expectAppliedOnPath(o, editState(id, { readAt: '2026-11-04T10:00:00.000Z' }, 'm-read'), {
      writes: true,
    })

    expect(await readAt(o, sessionId)).toBe('2026-11-04T10:00:00.000Z')
  })

  it('single-writer: my two edits apply in commit order; null marks it unread', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)
    const id = sessionUserStateRowId(ME, sessionId)

    appliedReply(await submit(o, editState(id, { readAt: '2026-11-04T10:00:00.000Z' }, 'm-1')))
    appliedReply(await submit(o, editState(id, { readAt: '2026-11-04T09:00:00.000Z' }, 'm-2')))
    expect(await readAt(o, sessionId)).toBe('2026-11-04T09:00:00.000Z')

    appliedReply(await submit(o, editState(id, { readAt: null }, 'm-3')))
    expect(await readAt(o, sessionId)).toBeNull()
  })

  it('refuses somebody else’s row, and the key fields', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)

    const theirs = await submit(
      o,
      editState(
        sessionUserStateRowId(SOMEONE_ELSE, sessionId),
        { readAt: '2026-11-04T10:00:00.000Z' },
        'm-theirs',
      ),
    )
    expect(refusal(theirs)).toEqual({ kind: 'unauthorized' })

    const mine = sessionUserStateRowId(ME, sessionId)
    const rekey = await submit(o, editState(mine, { userId: SOMEONE_ELSE }, 'm-rekey'))
    expect(refusal(rekey)).toEqual({ kind: 'unauthorized' })
    expect(await rowsOf(o, 'm-theirs')).toEqual([])
    expect(await rowsOf(o, 'm-rekey')).toEqual([])
  })

  it('remove forgets my read mark and my snooze together', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)
    const id = sessionUserStateRowId(ME, sessionId)
    appliedReply(await submit(o, editState(id, { readAt: '2026-11-04T10:00:00.000Z' }, 'm-read')))
    await o.call.snoozes.set({ sessionId, until: '2099-01-01T00:00:00.000Z' })

    await expectAppliedOnPath(o, envelope('records.sessionUserState.remove', { id }, 'm-remove'), {
      writes: true,
    })

    expect(await readAt(o, sessionId)).toBeNull()
    expect((await o.store.sessions.listSnoozes(ME))[sessionId]).toBeUndefined()
  })
})

describe('records.sessionUserState: the snooze (POD-6404)', () => {
  const snoozedUntil = async (o: Oracle, sessionId: SessionId) => {
    const all = await o.store.sessions.listSnoozes(ME)
    return sessionId in all ? all[sessionId] : 'none'
  }

  it('sets a snooze, snoozes until the next message with null, and ends it by clearing the cell', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)
    const id = sessionUserStateRowId(ME, sessionId)

    await expectAppliedOnPath(
      o,
      editState(id, { snoozedUntil: '2099-01-01T00:00:00.000Z' }, 's-1'),
      { writes: true },
    )
    expect(await snoozedUntil(o, sessionId)).toBe('2099-01-01T00:00:00.000Z')

    appliedReply(await submit(o, editState(id, { snoozedUntil: null }, 's-2')))
    expect(await snoozedUntil(o, sessionId)).toBeNull()

    await expectAppliedOnPath(
      o,
      envelope('records.sessionUserState.edit', { id, patch: {}, unset: ['snoozedUntil'] }, 's-3'),
      { writes: true },
    )
    expect(await snoozedUntil(o, sessionId)).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// A person's state on an issue (POD-6404): the CALLER's row
// ---------------------------------------------------------------------------

const MEMBER = asUserId('user:member-6404')

async function member(o: Oracle): Promise<CommandPrincipal> {
  await o.store.users.create(
    {
      id: MEMBER,
      displayName: 'member',
      role: 'member',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabledAt: null,
    },
    'fixture-hash',
  )
  // A per-user row is written under a `self` scope: an owner-or-grant capability
  // reaches nobody's per-user rows (issue-authz §3.3).
  return {
    kind: 'user',
    user: MEMBER,
    capability: { role: 'worker', scope: { kind: 'self', userId: MEMBER } },
  }
}

const editIssueState = (id: string, patch: Record<string, unknown>, m: string) =>
  envelope('records.issueUserState.edit', { id, patch }, m)

describe('records.issueUserState', () => {
  it('marks read and unread for the caller, on the path', async () => {
    const o = await makeOracle()
    const issue = await createIssue(o)
    const me = await firstAdminMemberId(o.store)
    const id = issueUserStateRowId(me, issue)

    await expectAppliedOnPath(
      o,
      editIssueState(id, { readAt: '2099-01-01T00:00:00.000Z' }, 'i-1'),
      {
        writes: true,
      },
    )
    expect((await o.store.issues.getIssueUserState(me, issue))?.readAt).toBe(
      '2099-01-01T00:00:00.000Z',
    )

    appliedReply(await submit(o, editIssueState(id, { readAt: null }, 'i-2')))
    expect((await o.store.issues.getIssueUserState(me, issue))?.readAt ?? null).toBeNull()
  })

  it('writes the CALLER’s row, not the broadcast viewer’s', async () => {
    const o = await makeOracle()
    const issue = await createIssue(o)
    const admin = await firstAdminMemberId(o.store)
    const principal = await member(o)

    const reply = await o.reg.modules.syncWrite.submit(
      editIssueState(
        issueUserStateRowId(MEMBER, issue),
        { readAt: '2099-01-01T00:00:00.000Z' },
        'i-m',
      ),
      principal,
      'trpc',
    )

    appliedReply(reply)
    expect((await o.store.issues.getIssueUserState(MEMBER, issue))?.readAt).toBe(
      '2099-01-01T00:00:00.000Z',
    )
    expect((await o.store.issues.getIssueUserState(admin, issue))?.readAt ?? null).toBeNull()
    const rows = await rowsOf(o, 'i-m')
    expect(rows.map((r) => r.entityId)).toContain(issueUserStateRowId(MEMBER, issue))
  })

  it('refuses another person’s row', async () => {
    const o = await makeOracle()
    const issue = await createIssue(o)

    const reply = await submit(
      o,
      editIssueState(issueUserStateRowId(MEMBER, issue), { readAt: null }, 'i-theirs'),
    )

    expect(refusal(reply)).toEqual({ kind: 'unauthorized' })
  })

  it('tucks only a finished issue, and a re-tuck keeps the first stamp', async () => {
    const o = await makeOracle()
    const issue = await createIssue(o)
    const me = await firstAdminMemberId(o.store)
    const id = issueUserStateRowId(me, issue)

    const open = await submit(
      o,
      editIssueState(id, { tuckedAt: '2099-01-01T00:00:00.000Z' }, 't-1'),
    )
    expect(refusal(open)).toMatchObject({ kind: 'conflict' })

    await o.call.issues.close({ id: issue, reason: 'done' })
    appliedReply(
      await submit(o, editIssueState(id, { tuckedAt: '2099-01-01T00:00:00.000Z' }, 't-2')),
    )
    const first = (await o.store.issues.getIssueUserState(me, issue))?.tuckedAt
    expect(first).toEqual(expect.any(String))
    appliedReply(
      await submit(o, editIssueState(id, { tuckedAt: '2099-02-01T00:00:00.000Z' }, 't-3')),
    )
    expect((await o.store.issues.getIssueUserState(me, issue))?.tuckedAt).toBe(first)

    appliedReply(await submit(o, editIssueState(id, { tuckedAt: null }, 't-4')))
    expect((await o.store.issues.getIssueUserState(me, issue))?.tuckedAt ?? null).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// One of my layout keys (POD-6404)
// ---------------------------------------------------------------------------

describe('records.userLayout', () => {
  const snapshot = (o: Oracle) => o.reg.modules.layout.getSnapshot(ME)

  it('sets one key and forgets it, on the path', async () => {
    const o = await makeOracle()
    const id = layoutRowId(ME, 'sidebar.section.nulldisk')

    await expectAppliedOnPath(
      o,
      envelope('records.userLayout.edit', { id, patch: { value: '1' } }, 'l-1'),
      { writes: true },
    )
    expect((await snapshot(o))['sidebar.section.nulldisk']).toBe('1')

    await expectAppliedOnPath(o, envelope('records.userLayout.remove', { id }, 'l-2'), {
      writes: true,
    })
    expect(await snapshot(o)).not.toHaveProperty('sidebar.section.nulldisk')
  })

  it('refuses somebody else’s row and a key outside the vocabulary', async () => {
    const o = await makeOracle()
    const theirs = await submit(
      o,
      envelope(
        'records.userLayout.edit',
        { id: layoutRowId(SOMEONE_ELSE, 'sidebar.section.nulldisk'), patch: { value: '1' } },
        'l-theirs',
      ),
    )
    const unknownKey = await submit(
      o,
      envelope(
        'records.userLayout.edit',
        { id: layoutRowId(ME, 'not.a.layout.key'), patch: { value: '1' } },
        'l-unknown',
      ),
    )
    expect(refusal(theirs)).toEqual({ kind: 'unauthorized' })
    expect(refusal(unknownKey).kind).toBe('invalid')
    expect(await rowsOf(o, 'l-theirs')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A MEMBER's own per-user rows (POD-6404): written under the caller's self scope
// ---------------------------------------------------------------------------

describe('a member writes their own per-user rows through sync.submit', () => {
  /** A member with an owner-or-grant capability, as a signed-in member has. */
  async function asMember(o: Oracle): Promise<CommandPrincipal> {
    await member(o)
    return userCommandPrincipal(MEMBER, 'member')
  }
  /** A session the member may read: shared with them by the admin. */
  async function sharedSession(o: Oracle): Promise<SessionId> {
    const sessionId = await shellSession(o)
    const admin = await firstAdminMemberId(o.store)
    await o.store.grants.upsert({
      resourceKind: 'session',
      resourceId: sessionId,
      grantee: MEMBER,
      verb: 'read',
      owner: admin,
      visibility: 'personal',
      createdAt: '2026-01-01T00:00:00.000Z',
      actorKind: 'user',
      actorId: admin,
      onBehalfOf: admin,
    })
    return sessionId
  }
  const as = (o: Oracle, principal: CommandPrincipal, env: Parameters<typeof submit>[1]) =>
    o.reg.modules.syncWrite.submit(env, principal, 'trpc')

  it('marks a session read, snoozes it, marks an issue read, tucks it and sets a layout key', async () => {
    const o = await makeOracle()
    const principal = await asMember(o)
    const sessionId = await sharedSession(o)
    const issue = await createIssue(o)
    await o.call.issues.close({ id: issue, reason: 'done' })
    const sessionRow = sessionUserStateRowId(MEMBER, sessionId)
    const issueRow = issueUserStateRowId(MEMBER, issue)

    for (const env of [
      editState(sessionRow, { readAt: '2099-01-01T00:00:00.000Z' }, 'mb-read'),
      editState(sessionRow, { snoozedUntil: null }, 'mb-snooze'),
      editIssueState(issueRow, { readAt: '2099-01-01T00:00:00.000Z' }, 'mb-issue-read'),
      editIssueState(issueRow, { tuckedAt: '2099-01-01T00:00:00.000Z' }, 'mb-tuck'),
      envelope(
        'records.userLayout.edit',
        { id: layoutRowId(MEMBER, 'sidebar.section.mine'), patch: { value: '1' } },
        'mb-layout',
      ),
    ]) {
      appliedReply(await as(o, principal, env))
    }

    expect(await o.store.sessions.getReadAt(MEMBER, sessionId)).toBe('2099-01-01T00:00:00.000Z')
    expect((await o.store.sessions.listSnoozes(MEMBER))[sessionId]).toBeNull()
    const marks = await o.store.issues.getIssueUserState(MEMBER, issue)
    expect(marks?.readAt).toBe('2099-01-01T00:00:00.000Z')
    expect(marks?.tuckedAt).toEqual(expect.any(String))
    expect((await o.reg.modules.layout.getSnapshot(MEMBER))['sidebar.section.mine']).toBe('1')
  })

  it('the old route a member’s older app sends is applied too (sessions.markRead)', async () => {
    const o = await makeOracle()
    const principal = await asMember(o)
    const sessionId = await sharedSession(o)

    appliedReply(
      await as(o, principal, envelope('sessions.markRead', { sessionId }, 'mb-old-read')),
    )

    expect(await o.store.sessions.getReadAt(MEMBER, sessionId)).not.toBeNull()
  })

  it('refuses another person’s row', async () => {
    const o = await makeOracle()
    const principal = await asMember(o)
    const issue = await createIssue(o)
    const admin = await firstAdminMemberId(o.store)

    const reply = await as(
      o,
      principal,
      editIssueState(issueUserStateRowId(admin, issue), { readAt: null }, 'mb-theirs'),
    )

    expect(refusal(reply)).toEqual({ kind: 'unauthorized' })
  })

  it('an agent writes its human’s row, and nobody else’s', async () => {
    const o = await makeOracle()
    await member(o)
    const issue = await createIssue(o)
    const agentSession = await shellSession(o)
    const agent: CommandPrincipal = {
      kind: 'agent',
      agentSessionId: agentSession,
      onBehalfOf: MEMBER,
      capability: {
        role: 'worker',
        scope: { kind: 'subtree', rootId: issue },
        actorSessionId: agentSession,
      },
      chain: [agentSession],
    }
    const admin = await firstAdminMemberId(o.store)

    appliedReply(
      await as(
        o,
        agent,
        editIssueState(
          issueUserStateRowId(MEMBER, issue),
          { readAt: '2099-01-01T00:00:00.000Z' },
          'ag-read',
        ),
      ),
    )
    const theirs = await as(
      o,
      agent,
      editIssueState(issueUserStateRowId(admin, issue), { readAt: null }, 'ag-theirs'),
    )

    expect((await o.store.issues.getIssueUserState(MEMBER, issue))?.readAt).toBe(
      '2099-01-01T00:00:00.000Z',
    )
    expect(refusal(theirs)).toEqual({ kind: 'unauthorized' })
  })
})

// ---------------------------------------------------------------------------
// The generic layer ALONE: an adapter with no guards of its own
// ---------------------------------------------------------------------------

/**
 * The issue family arbitrates its own revision and refuses its own id reuse, so
 * against the real issue kind the generic checks are a second guard nobody can
 * see fire. This kind's adapter checks nothing: a stale edit or a reused id that
 * gets through here is the generic layer's failure alone.
 */
async function fixtureKind() {
  const o = await makeOracle()
  const records = new Map<string, { title: string; note?: string; revision: number }>()
  const writes: string[] = []
  // The issue's ADR 3 cells and ops, without its placement input.
  const { placement: _placement, ...cells } = ISSUE_RECORD
  const NOTE = defineSyncedKind({
    ...cells,
    kind: 'conversation',
    title: 'note',
    wire: z.object({
      id: z.string(),
      title: z.string(),
      note: z.string().optional(),
      revision: z.number(),
    }),
    ref: z.string(),
    newId: deviceIdSchema('nt_'),
    conflict: 'exp-rev',
    fields: {
      title: recordSpecField(z.string(), ROW.issueCore, { required: true }),
      // A plain field (POD-6403): its last writer wins, whatever the revision.
      note: recordSpecField(z.string(), ROW.composerDraft, { conflict: 'field-LWW' }),
      revision: recordStatusField(z.number(), ROW.issueCore),
    },
    // A new note is its title; the server numbers its first revision.
    fresh: { cells: {}, pending: { revision: () => 1 } },
  })
  registerRecordKind(o.reg.modules.syncWrite.registry, NOTE, {
    target: async () => NO_TARGET,
    read: async (id) => records.get(id),
    create: async (_ctx, id, fields) => {
      writes.push(`create ${id}`)
      records.set(id, { title: String(fields.title), revision: 1 })
    },
    edit: async (_ctx, id, patch, _expected, unset) => {
      writes.push(`edit ${id}`)
      const next = { ...must(records.get(id)) }
      if (patch.title !== undefined) next.title = String(patch.title)
      if (patch.note !== undefined) next.note = String(patch.note)
      if (unset.includes('note')) delete next.note
      next.revision += 1
      records.set(id, next)
      return { revision: next.revision }
    },
  })
  return { o, records, writes }
}

describe('the generic layer, with an adapter that guards nothing', () => {
  it('refuses a stale revision before the adapter writes', async () => {
    const { o, records, writes } = await fixtureKind()
    const id = `nt_${crypto.randomUUID()}`
    appliedReply(
      await submit(
        o,
        envelope('records.conversation.create', { id, fields: { title: 'a' } }, 'f-1'),
      ),
    )
    appliedReply(
      await submit(
        o,
        envelope(
          'records.conversation.edit',
          { id, patch: { title: 'b' }, expectedRevision: 1 },
          'f-2',
        ),
      ),
    )

    const stale = await submit(
      o,
      envelope(
        'records.conversation.edit',
        { id, patch: { title: 'c' }, expectedRevision: 1 },
        'f-3',
      ),
    )

    expect(refusal(stale)).toEqual({ kind: 'conflict' })
    expect(records.get(id)).toEqual({ title: 'b', revision: 2 })
    expect(writes).toEqual([`create ${id}`, `edit ${id}`])
  })

  it('refuses a create on an existing id before the adapter writes', async () => {
    const { o, records, writes } = await fixtureKind()
    const id = `nt_${crypto.randomUUID()}`
    appliedReply(
      await submit(
        o,
        envelope('records.conversation.create', { id, fields: { title: 'a' } }, 'f-1'),
      ),
    )

    const again = await submit(
      o,
      envelope('records.conversation.create', { id, fields: { title: 'b' } }, 'f-2'),
    )
    const replay = appliedReply(
      await submit(
        o,
        envelope('records.conversation.create', { id, fields: { title: 'a' } }, 'f-1'),
      ),
    )

    expect(refusal(again)).toEqual({ kind: 'conflict' })
    expect(replay.replayed).toBe(true)
    expect(records.get(id)?.title).toBe('a')
    expect(writes).toEqual([`create ${id}`])
  })
})

describe('plain fields, clearing, and the revision an edit wrote (POD-6403)', () => {
  const create = async (o: Oracle, id: string) =>
    appliedReply(
      await submit(
        o,
        envelope('records.conversation.create', { id, fields: { title: 'a' } }, `c-${id}`),
      ),
    )

  it('an edit of plain fields only needs no revision, and two made at one revision both land', async () => {
    const { o, records } = await fixtureKind()
    const id = `nt_${crypto.randomUUID()}`
    await create(o, id)

    appliedReply(
      await submit(o, envelope('records.conversation.edit', { id, patch: { note: 'x' } }, 'p-1')),
    )
    appliedReply(
      await submit(o, envelope('records.conversation.edit', { id, patch: { note: 'y' } }, 'p-2')),
    )

    expect(records.get(id)?.note).toBe('y')
  })

  it('an edit that also names an exp-rev field is still held to its revision', async () => {
    const { o, writes } = await fixtureKind()
    const id = `nt_${crypto.randomUUID()}`
    await create(o, id)

    const bare = await submit(
      o,
      envelope('records.conversation.edit', { id, patch: { note: 'x', title: 'b' } }, 'p-1'),
    )
    const stale = await submit(
      o,
      envelope(
        'records.conversation.edit',
        { id, patch: { note: 'x', title: 'b' }, expectedRevision: 7 },
        'p-2',
      ),
    )

    expect(refusal(bare)).toEqual({ kind: 'invalid', details: ['expectedRevision'] })
    expect(refusal(stale)).toEqual({ kind: 'conflict' })
    expect(writes).toEqual([`create ${id}`])
  })

  it('unset clears an optional spec cell; anything else is refused at parse', async () => {
    const { o, records } = await fixtureKind()
    const id = `nt_${crypto.randomUUID()}`
    await create(o, id)
    appliedReply(
      await submit(o, envelope('records.conversation.edit', { id, patch: { note: 'x' } }, 'u-1')),
    )

    appliedReply(
      await submit(
        o,
        envelope('records.conversation.edit', { id, patch: {}, unset: ['note'] }, 'u-2'),
      ),
    )
    const notOptional = await submit(
      o,
      envelope('records.conversation.edit', { id, patch: {}, unset: ['title'] }, 'u-3'),
    )

    expect(records.get(id)).not.toHaveProperty('note')
    expect(refusal(notOptional).kind).toBe('invalid')
  })

  it('answers with the revision the edit wrote', async () => {
    const { o } = await fixtureKind()
    const id = `nt_${crypto.randomUUID()}`
    await create(o, id)

    const reply = appliedReply(
      await submit(
        o,
        envelope(
          'records.conversation.edit',
          { id, patch: { title: 'b' }, expectedRevision: 1 },
          'r-1',
        ),
      ),
    )

    expect(reply.result).toEqual({ revision: 2 })
  })

  it('the issue answers with its revision too, so a device can chain its next edit', async () => {
    const o = await makeOracle()
    const id = await createIssue(o)
    const at = (await meta(o, id)).revision ?? undefined

    const reply = appliedReply(await submit(o, edit(id, { priority: 1 }, at, 'r-issue')))

    expect(reply.result).toEqual({ revision: (await meta(o, id)).revision })
  })
})

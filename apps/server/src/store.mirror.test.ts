import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

// Transcript-mirror store state (docs/spec/transcript-mirror.md §2.2): additive
// `mirrored_bytes`/`mirrored_at` columns on conversation_segments — the pull
// cursor the MirrorService resumes from, and the work-list query that feeds it.

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-mirror-store-'))
  return join(dir, 'podium.db')
}

/** Raw column peek — mirrored_at has no public getter (telemetry-only today). */
function rawMirrorRow(
  store: SessionStore,
  machineId: string,
  nativeId: string,
): { mirrored_bytes: number; mirrored_at: string | null } | undefined {
  return (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): unknown } } }).db
    .prepare(
      'SELECT mirrored_bytes, mirrored_at FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
    )
    .get(machineId, nativeId) as { mirrored_bytes: number; mirrored_at: string | null } | undefined
}

describe('SessionStore transcript mirror state', () => {
  it('defaults mirror columns to 0/NULL on a fresh segment', () => {
    const store = new SessionStore(':memory:')
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n1',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/n1.jsonl',
    })
    expect(store.conversations.mirrorCursor('m1', 'n1')).toBe(0)
    expect(rawMirrorRow(store, 'm1', 'n1')).toEqual({ mirrored_bytes: 0, mirrored_at: null })
    // A segment we never registered reads as cursor 0 too (nothing mirrored).
    expect(store.conversations.mirrorCursor('m1', 'never-seen')).toBe(0)
    store.close()
  })

  it('setMirrorCursor round-trips and stores mirrored_at', () => {
    const store = new SessionStore(':memory:')
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n1',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/n1.jsonl',
    })
    store.conversations.setMirrorCursor('m1', 'n1', 4096, '2026-07-02T10:00:00.000Z')
    expect(store.conversations.mirrorCursor('m1', 'n1')).toBe(4096)
    expect(rawMirrorRow(store, 'm1', 'n1')).toEqual({
      mirrored_bytes: 4096,
      mirrored_at: '2026-07-02T10:00:00.000Z',
    })
    // A rewrite resets the cursor to 0 through the same call (spec §2.3).
    store.conversations.setMirrorCursor('m1', 'n1', 0, '2026-07-02T11:00:00.000Z')
    expect(store.conversations.mirrorCursor('m1', 'n1')).toBe(0)
    expect(rawMirrorRow(store, 'm1', 'n1')?.mirrored_at).toBe('2026-07-02T11:00:00.000Z')
    store.close()
  })

  it('segmentsToMirror lists only path-known segments of the requested machine', () => {
    const store = new SessionStore(':memory:')
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'with-path',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/with-path.jsonl',
    })
    // Path evidence never observed — the mirror has nothing to pull from.
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'no-path',
      providerId: 'claude-code-jsonl',
    })
    // Same native id shape on ANOTHER machine — must not leak into m1's list.
    store.conversations.ensureConversationIdentity({
      machineId: 'm2',
      nativeId: 'other-machine',
      providerId: 'claude-code-jsonl',
      path: '/home/v/.claude/projects/-proj/other-machine.jsonl',
    })
    store.conversations.setMirrorCursor('m1', 'with-path', 128, '2026-07-02T10:00:00.000Z')

    expect(store.conversations.segmentsToMirror('m1')).toEqual([
      {
        nativeId: 'with-path',
        path: '/home/u/.claude/projects/-proj/with-path.jsonl',
        mirroredBytes: 128,
      },
    ])
    expect(store.conversations.segmentsToMirror('m2')).toEqual([
      {
        nativeId: 'other-machine',
        path: '/home/v/.claude/projects/-proj/other-machine.jsonl',
        mirroredBytes: 0,
      },
    ])
    expect(store.conversations.segmentsToMirror('m3')).toEqual([])
    store.close()
  })

  it('persists reported_bytes through ensureConversationIdentity (insert, update, COALESCE)', () => {
    const store = new SessionStore(':memory:')
    // Insert with a size (first observation carries discovery's stat).
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n1',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/n1.jsonl',
      sizeBytes: 100,
    })
    expect(store.conversations.reportedBytes('m1', 'n1')).toBe(100)
    // Re-observation with a newer size updates it.
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n1',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/n1.jsonl',
      sizeBytes: 250,
    })
    expect(store.conversations.reportedBytes('m1', 'n1')).toBe(250)
    // A size-less re-observation (e.g. a live-roll link) must NOT blank the
    // last-known size — attach-time reconcile depends on it surviving.
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n1',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/n1.jsonl',
    })
    expect(store.conversations.reportedBytes('m1', 'n1')).toBe(250)
    // Never-reported row reads undefined (the NULL upgrade-path marker).
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n2',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/n2.jsonl',
    })
    expect(store.conversations.reportedBytes('m1', 'n2')).toBeUndefined()
    store.close()
  })

  it('segmentsToMirrorDirty lists behind + NULL-reported segments, never caught-up ones', () => {
    const store = new SessionStore(':memory:')
    const seed = (nativeId: string, sizeBytes?: number) =>
      store.conversations.ensureConversationIdentity({
        machineId: 'm1',
        nativeId,
        providerId: 'claude-code-jsonl',
        path: `/home/u/.claude/projects/-proj/${nativeId}.jsonl`,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      })
    seed('caught-up', 64)
    store.conversations.setMirrorCursor('m1', 'caught-up', 64, '2026-07-02T10:00:00.000Z')
    seed('behind', 128)
    store.conversations.setMirrorCursor('m1', 'behind', 64, '2026-07-02T10:00:00.000Z')
    seed('never-reported') // NULL reported_bytes → dirty (upgrade path)
    // Path evidence never observed — not mirrorable at all, dirty or not.
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'no-path',
      providerId: 'claude-code-jsonl',
    })

    expect(
      store
        .conversations.segmentsToMirrorDirty('m1')
        .map((s) => s.nativeId)
        .sort(),
    ).toEqual(['behind', 'never-reported'])
    // setReportedBytes (the mirror's eof observation) quiets a segment.
    store.conversations.setReportedBytes('m1', 'never-reported', 0)
    store.conversations.setReportedBytes('m1', 'behind', 64)
    expect(store.conversations.segmentsToMirrorDirty('m1')).toEqual([])
    // The FULL work list is untouched by dirtiness — the manual-reconcile seam.
    expect(store.conversations.segmentsToMirror('m1').length).toBe(3)
    store.close()
  })

  it('reopening a file-backed store is idempotent and keeps cursors (ALTER guard)', async () => {
    const file = await tmpDbPath()
    const first = new SessionStore(file)
    first.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'n1',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-proj/n1.jsonl',
    })
    first.conversations.setMirrorCursor('m1', 'n1', 777, '2026-07-02T10:00:00.000Z')
    first.conversations.setReportedBytes('m1', 'n1', 900)
    first.close()

    // Second open replays CREATE TABLE ... IF NOT EXISTS + the ALTER guards over a
    // schema that ALREADY has the mirror columns — must not throw, must not reset.
    const second = new SessionStore(file)
    expect(second.conversations.mirrorCursor('m1', 'n1')).toBe(777)
    // reported_bytes survives too — attach-time dirty reconcile reads it before
    // the first scan of the new server life.
    expect(second.conversations.reportedBytes('m1', 'n1')).toBe(900)
    expect(rawMirrorRow(second, 'm1', 'n1')).toEqual({
      mirrored_bytes: 777,
      mirrored_at: '2026-07-02T10:00:00.000Z',
    })
    second.close()
  })
})

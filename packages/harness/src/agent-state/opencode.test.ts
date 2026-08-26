import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentStateProviderFor } from '../registry.js'
import { loadOpencodeMessageParts, opencodeSessionDbPath } from '../opencode/db.js'
import { observeOpencodeState, opencodeStateProvider } from './opencode.js'

// Mock the opencode DB module so the gate test can (a) count handle opens and the
// per-tick session query and (b) drive the mtime gate deterministically. The
// observer snapshots these functions into a memoized runtime via a module spread,
// so a post-load `vi.spyOn` on the namespace wouldn't be visible — a hoisted
// `vi.mock` is applied before any (static OR dynamic) import resolves, so the
// spread captures these wrappers. Each wrapper delegates to the real export by
// default, so every other test keeps its real behavior.
const dbHooks = vi.hoisted(() => ({
  // Settable mtime for the gate; undefined ⇒ delegate to the real stat.
  mtimeMs: undefined as number | undefined,
  openCount: 0,
  getCount: 0,
  closed: [] as unknown[],
}))

vi.mock('../opencode/db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../opencode/db.js')>()
  return {
    ...real,
    openOpencodeDb: (homeDir?: string, databasePath?: string) => {
      const db = real.openOpencodeDb(homeDir, databasePath)
      dbHooks.openCount += 1
      if (db) {
        const realClose = db.close.bind(db)
        db.close = () => {
          dbHooks.closed.push(db)
          realClose()
        }
      }
      return db
    },
    getOpencodeSession: (db: Parameters<typeof real.getOpencodeSession>[0], id: string) => {
      dbHooks.getCount += 1
      return real.getOpencodeSession(db, id)
    },
    opencodeDbMtimeMs: (homeDir?: string, databasePath?: string) =>
      dbHooks.mtimeMs ?? real.opencodeDbMtimeMs(homeDir, databasePath),
  }
})

// Poll a predicate until true or a deadline so tests read the observer's effects
// without coupling to its exact poll cadence.
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: predicate not satisfied in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function seedSessionDb(
  root: string,
  sessionId: string,
  cwd: string,
  assistantText: string,
  databasePath = join(root, 'opencode.db'),
  messageRole: 'user' | 'assistant' = 'assistant',
): Promise<void> {
  const db = openDatabase(databasePath)
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'proj',
    parent_id TEXT,
    slug TEXT NOT NULL DEFAULT 'slug',
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1',
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    workspace_id TEXT,
    path TEXT,
    agent TEXT,
    model TEXT,
    cost REAL NOT NULL DEFAULT 0,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
  )`)
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`)
  db.prepare(
    `INSERT INTO session (id, directory, title, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, cwd, 't', 1_700_000_000_000, 1_700_000_100_000)
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('msg-a', sessionId, 1, 2, JSON.stringify({ role: messageRole }))
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('prt-a', 'msg-a', sessionId, 1, 2, JSON.stringify({ type: 'text', text: assistantText }))
  db.close()
}
function opencodeMessageCounts(
  databasePath: string,
  sessionId: string,
): { messageRows: number; assistantRows: number; partRows: number } {
  const db = openDatabase(databasePath)
  const messages = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as {
    data: string
  }[]
  const parts = db.prepare('SELECT id FROM part WHERE session_id = ?').all(sessionId) as unknown[]
  db.close()
  return {
    messageRows: messages.length,
    assistantRows: messages.filter((row) => JSON.parse(row.data).role === 'assistant').length,
    partRows: parts.length,
  }
}

describe('opencode state provider', () => {
  let home: string

  afterEach(() => {
    delete process.env.HOME
  })

  it('registers in the agent state provider map', () => {
    expect(agentStateProviderFor('opencode')).toBe(opencodeStateProvider)
  })

  it('bootEvents classifies a resumed session from sqlite transcript tail', async () => {
    home = await mkdtemp(join(tmpdir(), 'podium-opencode-boot-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_boot', '/repo/opencode', 'Ready when you are.')
    process.env.HOME = home

    const events = await opencodeStateProvider.bootEvents?.({
      cwd: '/repo/opencode',
      resumeValue: 'ses_boot',
      homeDir: home,
    })
    expect(events).toEqual([
      {
        kind: 'turn_completed',
        source: 'poll',
        confidence: 0.7,
        verdict: { kind: 'done', summary: 'Ready when you are.' },
        at: new Date(2).toISOString(), // the assistant part row's time_updated
      },
    ])
  })

  it('emits the provider-qualified model and variant from the session row', async () => {
    home = await mkdtemp(join(tmpdir(), 'podium-opencode-model-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_model', '/repo/model', 'ready')
    const db = openDatabase(join(root, 'opencode.db'))
    db.prepare('UPDATE session SET model = ? WHERE id = ?').run(
      JSON.stringify({ id: 'deepseek-v4-flash-free', providerID: 'opencode', variant: 'max' }),
      'ses_model',
    )
    db.close()

    const models: [string, string | undefined][] = []
    const obs = observeOpencodeState({
      cwd: '/repo/model',
      homeDir: home,
      resumeValue: 'ses_model',
      pollMs: 10,
      onEvents: () => {},
      onModel: (model, effort) => models.push([model, effort]),
    })
    try {
      await waitFor(() => models.length > 0)
      await new Promise((r) => setTimeout(r, 50))
      expect(models).toEqual([['opencode/deepseek-v4-flash-free', 'max']])
    } finally {
      obs.stop()
    }
  })

  it('does not skip parts sharing the cursor timestamp', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-cursor-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_cursor', '/repo/cursor', 'initial')
    const db = openDatabase(join(root, 'opencode.db'))
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run('msg-b', 'ses_cursor', 3, 3, JSON.stringify({ role: 'assistant' }))
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run('msg-c', 'ses_cursor', 3, 3, JSON.stringify({ role: 'assistant' }))
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('prt-b', 'msg-b', 'ses_cursor', 3, 2, JSON.stringify({ type: 'text', text: 'b' }))
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('prt-c', 'msg-c', 'ses_cursor', 3, 2, JSON.stringify({ type: 'text', text: 'c' }))
    const rows = loadOpencodeMessageParts(db, 'ses_cursor', 2, 'prt-a')
    db.close()
    expect(rows.map((row) => row.partId)).toEqual(['prt-b', 'prt-c'])
  })
})

describe('OpenCode session identity (POD-2871)', () => {
  const discoveryStartMs = 1_700_000_000_000

  it('isolates same-directory sessions and measures the fault row, not just visible text', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-same-dir-'))
    const faultDb = opencodeSessionDbPath(home, 'pod-fault')
    const peerDb = opencodeSessionDbPath(home, 'pod-peer')
    await mkdir(dirname(faultDb), { recursive: true })
    await seedSessionDb(
      dirname(faultDb),
      'ses-fault',
      '/repo/shared',
      'fault prompt',
      faultDb,
      'user',
    )
    await seedSessionDb(dirname(peerDb), 'ses-peer', '/repo/shared', 'PODIUM-7ZP0U7', peerDb)

    const faultText: string[] = []
    const peerText: string[] = []
    const fault = observeOpencodeState({
      cwd: '/repo/shared',
      homeDir: home,
      podiumSessionId: 'pod-fault',
      startedAtMs: discoveryStartMs,
      pollMs: 10,
      onEvents: () => {},
      onTranscriptItems: (items) => faultText.push(...items.map((item) => item.text ?? '')),
    })
    const peer = observeOpencodeState({
      cwd: '/repo/shared',
      homeDir: home,
      podiumSessionId: 'pod-peer',
      startedAtMs: discoveryStartMs,
      pollMs: 10,
      onEvents: () => {},
      onTranscriptItems: (items) => peerText.push(...items.map((item) => item.text ?? '')),
    })
    try {
      await waitFor(() => fault.sessionId === 'ses-fault' && peer.sessionId === 'ses-peer')
      await waitFor(() => faultText.length > 0 && peerText.length > 0)

      expect(faultText).toEqual(['fault prompt'])
      expect(faultText).not.toContain('PODIUM-7ZP0U7')
      expect(peerText).toContain('PODIUM-7ZP0U7')
      expect(opencodeMessageCounts(faultDb, 'ses-fault')).toEqual({
        messageRows: 1,
        assistantRows: 0,
        partRows: 1,
      })
      expect(opencodeMessageCounts(peerDb, 'ses-peer')).toEqual({
        messageRows: 1,
        assistantRows: 1,
        partRows: 1,
      })
    } finally {
      fault.stop()
      peer.stop()
    }
  })

  it('keeps different-directory sessions readable from their own stores', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-different-dir-'))
    const leftDb = opencodeSessionDbPath(home, 'pod-left')
    const rightDb = opencodeSessionDbPath(home, 'pod-right')
    await mkdir(dirname(leftDb), { recursive: true })
    await seedSessionDb(dirname(leftDb), 'ses-left', '/repo/left', 'LEFT-OWN', leftDb)
    await seedSessionDb(dirname(rightDb), 'ses-right', '/repo/right', 'RIGHT-OWN', rightDb)

    const leftText: string[] = []
    const rightText: string[] = []
    const left = observeOpencodeState({
      cwd: '/repo/left',
      homeDir: home,
      podiumSessionId: 'pod-left',
      startedAtMs: discoveryStartMs,
      pollMs: 10,
      onEvents: () => {},
      onTranscriptItems: (items) => leftText.push(...items.map((item) => item.text ?? '')),
    })
    const right = observeOpencodeState({
      cwd: '/repo/right',
      homeDir: home,
      podiumSessionId: 'pod-right',
      startedAtMs: discoveryStartMs,
      pollMs: 10,
      onEvents: () => {},
      onTranscriptItems: (items) => rightText.push(...items.map((item) => item.text ?? '')),
    })
    try {
      await waitFor(() => left.sessionId === 'ses-left' && right.sessionId === 'ses-right')
      await waitFor(() => leftText.length > 0 && rightText.length > 0)

      expect(leftText).toEqual(['LEFT-OWN'])
      expect(rightText).toEqual(['RIGHT-OWN'])
      expect(opencodeMessageCounts(leftDb, 'ses-left')).toEqual({
        messageRows: 1,
        assistantRows: 1,
        partRows: 1,
      })
      expect(opencodeMessageCounts(rightDb, 'ses-right')).toEqual({
        messageRows: 1,
        assistantRows: 1,
        partRows: 1,
      })
    } finally {
      left.stop()
      right.stop()
    }
  })

  it('fails closed when a legacy shared store has no session identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-legacy-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses-legacy-a', '/repo/shared', 'LEGACY-A')
    const db = openDatabase(join(root, 'opencode.db'))
    db.prepare(
      `INSERT INTO session (id, directory, title, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('ses-legacy-b', '/repo/shared', 't', 1_700_000_000_000, 1_700_000_100_000)
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('msg-b', 'ses-legacy-b', 1, 2, JSON.stringify({ role: 'assistant' }))
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'prt-b',
      'msg-b',
      'ses-legacy-b',
      1,
      2,
      JSON.stringify({ type: 'text', text: 'LEGACY-B' }),
    )
    db.close()

    const events: Array<{ kind: string; errorClass?: string; retryable?: boolean }> = []
    const text: string[] = []
    const obs = observeOpencodeState({
      cwd: '/repo/shared',
      homeDir: home,
      startedAtMs: discoveryStartMs,
      pollMs: 10,
      onEvents: (next) => events.push(...next),
      onTranscriptItems: (items) => text.push(...items.map((item) => item.text ?? '')),
    })
    try {
      await waitFor(() => events.some((event) => event.kind === 'turn_failed'))
      expect(obs.sessionId).toBeUndefined()
      expect(text).toEqual([])
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'turn_failed',
          errorClass: 'transcript_identity_unavailable',
          retryable: false,
        }),
      ])
    } finally {
      obs.stop()
    }
  })
})
describe('observeOpencodeState DB handle reuse + mtime gate', () => {
  it('reuses one handle, skips the per-tick query while mtime is unchanged, re-runs when it advances, and closes on stop', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-gate-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_gate', '/repo/gate', 'idle text')

    // Reset the shared counters/state, then pin the gate to a fixed mtime so the
    // tick read can be skipped deterministically (independent of fs granularity).
    dbHooks.openCount = 0
    dbHooks.getCount = 0
    dbHooks.closed = []
    dbHooks.mtimeMs = 1_000

    const obs = observeOpencodeState({
      cwd: '/repo/gate',
      homeDir: home,
      resumeValue: 'ses_gate',
      pollMs: 10,
      onEvents: () => {},
    })
    try {
      // Attach via the resume path; once attached the poll ticks run.
      await waitFor(() => obs.sessionId === 'ses_gate')
      // The attach read + the first (ungated) poll tick run once each; let the gate
      // settle, then snapshot a count that must then hold steady while mtime is pinned.
      await waitFor(() => dbHooks.getCount >= 1)
      await new Promise((r) => setTimeout(r, 60)) // let attach + first tick settle
      const settled = dbHooks.getCount
      await new Promise((r) => setTimeout(r, 80)) // ~8 more ticks, all gated out
      // The query did NOT re-run while the mtime was unchanged…
      expect(dbHooks.getCount).toBe(settled)
      // …and the handle was opened exactly once and reused across every tick.
      expect(dbHooks.openCount).toBe(1)

      // A write bumps the (pinned) mtime → the next tick must read again.
      dbHooks.mtimeMs = 2_000
      await waitFor(() => dbHooks.getCount > settled)
      // Still the same single reused handle — no extra opens.
      expect(dbHooks.openCount).toBe(1)
    } finally {
      obs.stop()
    }

    // stop() closed the one handle it held open.
    expect(dbHooks.closed.length).toBe(1)
    dbHooks.mtimeMs = undefined // un-pin for any later tests
  })
})

/**
 * THE TRANSCRIPT READ MUST NOT EAT THE STATE READ (POD-2801).
 *
 * `emitTranscript` and `tick` both query the message parts newer than
 * `(lastPartTime, lastPartId)` and both ADVANCE that cursor, and `pollOnce` ran
 * them in that order. So on every tick the transcript read consumed the new rows
 * and the state read queried from a cursor already past all of them: zero rows,
 * no `prompt_submitted`, no `activity`, no `turn_completed`. The session's phase
 * never left the boot-seeded `idle` while the agent wrote megabytes to the
 * terminal — measured on the POD-2777 rig as 121,554 bytes of PTY output across
 * 60 polls, `idle` at every one.
 *
 * `onTranscriptItems` IS THE POINT OF THIS TEST, not scaffolding. `emitTranscript`
 * returns immediately when no transcript sink is registered, so an observer built
 * without one never starves its own state read and the bug is invisible. Every
 * pre-existing test here passes `onEvents` alone; the daemon always passes both.
 * A test that omits the sink is testing a wiring that production never uses.
 */
describe('observeOpencodeState state events (POD-2801)', () => {
  it('reports the live rows on the state plane, not only on the transcript plane', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-phase-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_phase', '/repo/phase', 'previous answer')

    dbHooks.mtimeMs = 3_000
    const events: string[] = []
    const items: unknown[] = []
    const obs = observeOpencodeState({
      cwd: '/repo/phase',
      homeDir: home,
      resumeValue: 'ses_phase',
      pollMs: 10,
      onEvents: (e) => events.push(...e.map((x) => x.kind)),
      onTranscriptItems: (i) => items.push(...i),
    })
    try {
      await waitFor(() => obs.sessionId === 'ses_phase')
      // Let the attach-time tail load finish and the cursor settle before the
      // live rows land, so this measures the STEADY-STATE poll, not the boot read.
      await new Promise((r) => setTimeout(r, 60))
      const before = events.length

      const db = openDatabase(join(root, 'opencode.db'))
      db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
      ).run('msg-live-u', 'ses_phase', 10, 10, JSON.stringify({ role: 'user' }))
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'prt-live-u',
        'msg-live-u',
        'ses_phase',
        10,
        10,
        JSON.stringify({ type: 'text', text: 'count to a hundred' }),
      )
      db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
      ).run('msg-live-a', 'ses_phase', 11, 11, JSON.stringify({ role: 'assistant' }))
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'prt-live-a',
        'msg-live-a',
        'ses_phase',
        11,
        11,
        JSON.stringify({ type: 'text', text: 'one. two. three.' }),
      )
      db.close()
      dbHooks.mtimeMs = 4_000

      // The transcript plane sees the new rows — this is the control. It fires
      // whether or not the state plane is starved, so a state plane that stayed
      // empty here cannot be blamed on rows that never arrived.
      await waitFor(() => items.length >= 2)
      await waitFor(() => events.length > before)
      expect(events.slice(before)).toEqual(['prompt_submitted', 'activity'])
    } finally {
      obs.stop()
      dbHooks.mtimeMs = undefined
    }
  })
})

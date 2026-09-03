import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadOpencodeMessageParts,
  loadOpencodeTranscriptTail,
  opencodeSessionDbPath,
} from '../opencode/db.js'
import { agentStateProviderFor } from '../registry.js'
import { observeOpencodeState, opencodeStateProvider } from './opencode.js'
import { initialAgentState, reduceAgentState } from './reducer.js'
import type { AgentStateEvent } from './types.js'

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
  it('keeps reading an open turn until a same-mtime step-finish closes it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-terminal-gate-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_terminal_gate', '/repo/terminal-gate', 'previous answer')

    dbHooks.openCount = 0
    dbHooks.getCount = 0
    dbHooks.closed = []
    dbHooks.mtimeMs = 1_000
    const events: AgentStateEvent[] = []
    const obs = observeOpencodeState({
      cwd: '/repo/terminal-gate',
      homeDir: home,
      resumeValue: 'ses_terminal_gate',
      startedAtMs: 1,
      pollMs: 10,
      onEvents: (next) => events.push(...next),
    })
    try {
      await waitFor(() => obs.sessionId === 'ses_terminal_gate')
      await new Promise((resolve) => setTimeout(resolve, 60))

      const promptDb = openDatabase(join(root, 'opencode.db'))
      promptDb
        .prepare(
          'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
        )
        .run('msg-gate-user', 'ses_terminal_gate', 20, 20, JSON.stringify({ role: 'user' }))
      promptDb
        .prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'prt-gate-user',
          'msg-gate-user',
          'ses_terminal_gate',
          20,
          20,
          JSON.stringify({ type: 'text', text: 'answer once' }),
        )
      promptDb.close()
      dbHooks.mtimeMs = 2_000
      await waitFor(() => events.some((event) => event.kind === 'prompt_submitted'))
      const readsAfterPrompt = dbHooks.getCount

      const finishDb = openDatabase(join(root, 'opencode.db'))
      finishDb
        .prepare(
          'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          'msg-gate-assistant',
          'ses_terminal_gate',
          21,
          21,
          JSON.stringify({ role: 'assistant' }),
        )
      finishDb
        .prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'prt-gate-finish',
          'msg-gate-assistant',
          'ses_terminal_gate',
          21,
          21,
          JSON.stringify({ type: 'step-finish', reason: 'stop' }),
        )
      finishDb.close()

      // The mocked mtime deliberately stays at 2_000. Only the open-turn
      // confirmation read can observe the provider-authored terminal row.
      await waitFor(() => events.some((event) => event.kind === 'turn_completed'))
      expect(dbHooks.getCount).toBeGreaterThan(readsAfterPrompt)
    } finally {
      obs.stop()
      dbHooks.mtimeMs = undefined
    }
  })
})

/**
 * THE INITIAL TRANSCRIPT AND LIVE STATE SHARE ONE CURSOR (POD-2801).
 *
 * A freshly minted OpenCode resume id can bind before its first message exists.
 * The first provider rows must therefore pass through the reader that drives both
 * transcript and state; a separate initial-tail read can consume them and leave
 * prompt/activity/completion permanently absent from the causal stream. The
 * transcript sink is the production control that makes that starvation visible.
 */
describe('observeOpencodeState state events (POD-2801)', () => {
  it('reports the live rows on the state plane, not only on the transcript plane', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-phase-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_phase', '/repo/phase', 'previous answer')
    const emptyDb = openDatabase(join(root, 'opencode.db'))
    emptyDb.exec('DELETE FROM part; DELETE FROM message')
    emptyDb.close()

    dbHooks.mtimeMs = 3_000
    const events: string[] = []
    const items: unknown[] = []
    const obs = observeOpencodeState({
      cwd: '/repo/phase',
      homeDir: home,
      databasePath: join(root, 'opencode.db'),
      startedAtMs: 1,
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
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'prt-live-finish',
        'msg-live-a',
        'ses_phase',
        12,
        12,
        JSON.stringify({ type: 'step-finish', reason: 'stop' }),
      )
      db.close()
      dbHooks.mtimeMs = 4_000

      // The transcript plane sees the new rows — this is the control. It fires
      // whether or not the state plane is starved, so a state plane that stayed
      // empty here cannot be blamed on rows that never arrived.
      await waitFor(() => items.length >= 2)
      await waitFor(() => events.includes('turn_completed'))
      expect(events.slice(before)).toEqual(['prompt_submitted', 'activity', 'turn_completed'])
    } finally {
      obs.stop()
      dbHooks.mtimeMs = undefined
    }
  })
})

describe('observeOpencodeState interrupted verdict', () => {
  it('confirms one interrupted terminal verdict from a durable aborted message', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-interrupt-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_interrupt', '/repo/interrupt', 'previous answer')

    dbHooks.mtimeMs = 7_000
    const events: AgentStateEvent[] = []
    let transcriptItems: Array<{ id: string; event?: string; role?: string; text?: string }> = []
    const transcriptResets: Array<Array<{ id: string; event?: string }>> = []
    const obs = observeOpencodeState({
      cwd: '/repo/interrupt',
      homeDir: home,
      resumeValue: 'ses_interrupt',
      startedAtMs: 1,
      pollMs: 10,
      onEvents: (next) => events.push(...next),
      onTranscriptItems: (next, reset) => {
        transcriptItems = reset ? [...next] : [...transcriptItems, ...next]
        if (reset) transcriptResets.push(next)
      },
    })
    try {
      await waitFor(() => obs.sessionId === 'ses_interrupt')
      await new Promise((resolve) => setTimeout(resolve, 60))

      const db = openDatabase(join(root, 'opencode.db'))
      db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
      ).run('msg-abort', 'ses_interrupt', 20, 20, JSON.stringify({ role: 'assistant' }))
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'prt-abort',
        'msg-abort',
        'ses_interrupt',
        20,
        20,
        JSON.stringify({ type: 'text', text: 'partial' }),
      )
      db.close()
      dbHooks.mtimeMs = 8_000
      await waitFor(() => events.some((event) => event.kind === 'activity'))

      const abortDb = openDatabase(join(root, 'opencode.db'))
      abortDb
        .prepare('UPDATE message SET time_updated = ?, data = ? WHERE id = ?')
        .run(
          21,
          JSON.stringify({ role: 'assistant', error: { name: 'MessageAbortedError' } }),
          'msg-abort',
        )
      abortDb.close()
      dbHooks.mtimeMs = 9_000

      await waitFor(() =>
        transcriptResets.some((items) => items.some((item) => item.event === 'interrupt')),
      )
      await waitFor(() =>
        events.some(
          (event) => event.kind === 'turn_completed' && event.verdict?.kind === 'interrupted',
        ),
      )

      const afterInterrupt = events.length
      const laterDb = openDatabase(join(root, 'opencode.db'))
      const insertPart = laterDb.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      insertPart.run(
        'prt-later-text',
        'msg-abort',
        'ses_interrupt',
        22,
        22,
        JSON.stringify({ type: 'text', text: 'late text' }),
      )
      insertPart.run(
        'prt-later-tool',
        'msg-abort',
        'ses_interrupt',
        23,
        23,
        JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed' } }),
      )
      insertPart.run(
        'prt-later-finish',
        'msg-abort',
        'ses_interrupt',
        24,
        24,
        JSON.stringify({ type: 'step-finish', reason: 'stop' }),
      )
      laterDb.close()
      dbHooks.mtimeMs = 10_000
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(events.slice(afterInterrupt)).toEqual([])
      expect(
        events.filter(
          (event) => event.kind === 'turn_completed' && event.verdict?.kind === 'interrupted',
        ),
      ).toHaveLength(1)
      let state = initialAgentState('2026-08-30T00:00:00.000Z')
      for (const event of events) state = reduceAgentState(state, event, event.at ?? state.since)
      expect(state).toMatchObject({ phase: 'idle', idle: { kind: 'interrupted' } })

      expect(transcriptItems.filter((item) => item.event === 'interrupt')).toEqual([
        expect.objectContaining({ id: 'opencode-interrupt-msg-abort' }),
      ])
      expect(
        transcriptItems.filter(
          (item) =>
            item.role === 'assistant' && (item.text === 'partial' || item.text === 'late text'),
        ),
      ).toEqual([])
      const bootEventsProvider = opencodeStateProvider.bootEvents
      if (!bootEventsProvider) throw new Error('OpenCode state provider must expose boot events')
      const bootEvents = await bootEventsProvider({
        cwd: '/repo/interrupt',
        homeDir: home,
        resumeValue: 'ses_interrupt',
      })
      expect(bootEvents).toEqual([
        expect.objectContaining({
          kind: 'turn_completed',
          verdict: { kind: 'interrupted' },
        }),
      ])

      obs.stop()
      const reloadItems: Array<{ id: string; event?: string }> = []
      const reloaded = observeOpencodeState({
        cwd: '/repo/interrupt',
        homeDir: home,
        resumeValue: 'ses_interrupt',
        pollMs: 10,
        onEvents: () => {},
        onTranscriptItems: (next) => reloadItems.push(...next),
      })
      try {
        await waitFor(() => reloadItems.some((item) => item.event === 'interrupt'))
        expect(reloadItems.filter((item) => item.event === 'interrupt')).toEqual([
          expect.objectContaining({ id: 'opencode-interrupt-msg-abort' }),
        ])
      } finally {
        reloaded.stop()
      }
    } finally {
      obs.stop()
      dbHooks.mtimeMs = undefined
    }
  })
})

describe('OpenCode abort query rows', () => {
  it('keeps normal tail order and observes a zero-part abort once past its cursor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-abort-query-'))
    const root = join(home, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    await seedSessionDb(root, 'ses_abort_query', '/repo/abort-query', 'initial')
    const db = openDatabase(join(root, 'opencode.db'))
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insertPart.run(
      'prt-created-second',
      'msg-a',
      'ses_abort_query',
      40,
      10,
      JSON.stringify({ type: 'text', text: 'created second' }),
    )
    insertPart.run(
      'prt-created-first',
      'msg-a',
      'ses_abort_query',
      30,
      50,
      JSON.stringify({ type: 'text', text: 'created first' }),
    )
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'msg-zero-abort',
      'ses_abort_query',
      60,
      61,
      JSON.stringify({ role: 'assistant', error: { name: 'MessageAbortedError' } }),
    )

    const delta = loadOpencodeMessageParts(db, 'ses_abort_query', 60)
    const after = loadOpencodeMessageParts(db, 'ses_abort_query', 61, 'interrupt:msg-zero-abort')
    const tail = loadOpencodeTranscriptTail(db, 'ses_abort_query')
    db.close()

    expect(
      tail.filter((row) => row.partId.startsWith('prt-created-')).map((row) => row.partId),
    ).toEqual(['prt-created-first', 'prt-created-second'])
    const expectedAbort = expect.objectContaining({
      messageId: 'msg-zero-abort',
      partId: 'interrupt:msg-zero-abort',
      timeCreated: 61,
      timeUpdated: 61,
      partData: '{"type":"interrupt"}',
    })
    expect(delta).toContainEqual(expectedAbort)
    expect(tail).toContainEqual(expectedAbort)
    expect(after).toEqual([])
  })
})

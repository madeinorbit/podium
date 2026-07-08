import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentStateProviderFor } from '../harness/registry.js'
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
    openOpencodeDb: (homeDir?: string) => {
      const db = real.openOpencodeDb(homeDir)
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
    opencodeDbMtimeMs: (homeDir?: string) => dbHooks.mtimeMs ?? real.opencodeDbMtimeMs(homeDir),
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

type TestDatabase = {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): unknown }
  close(): void
}
type DatabaseSyncConstructor = new (path: string) => TestDatabase

let DatabaseSync: DatabaseSyncConstructor | undefined

beforeAll(async () => {
  try {
    DatabaseSync = (await import('node:sqlite')).DatabaseSync as DatabaseSyncConstructor
  } catch {
    DatabaseSync = undefined
  }
})

async function seedSessionDb(
  root: string,
  sessionId: string,
  cwd: string,
  assistantText: string,
): Promise<void> {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable')
  const dbPath = join(root, 'opencode.db')
  const db = new DatabaseSync(dbPath)
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
  ).run('msg-a', sessionId, 1, 2, JSON.stringify({ role: 'assistant' }))
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('prt-a', 'msg-a', sessionId, 1, 2, JSON.stringify({ type: 'text', text: assistantText }))
  db.close()
}

describe('opencode state provider', () => {
  let home: string

  afterEach(() => {
    delete process.env.HOME
  })

  it('registers in the agent state provider map', () => {
    expect(agentStateProviderFor('opencode')).toBe(opencodeStateProvider)
  })

  it('bootEvents classifies a resumed session from sqlite transcript tail when sqlite is available', async () => {
    if (!DatabaseSync) {
      await expect(
        opencodeStateProvider.bootEvents?.({
          cwd: '/repo/opencode',
          resumeValue: 'ses_boot',
          homeDir: '/tmp/does-not-matter',
        }),
      ).resolves.toEqual([{ kind: 'session_started' }])
      return
    }

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
        verdict: { kind: 'done', summary: 'Ready when you are.' },
        at: new Date(2).toISOString(), // the assistant part row's time_updated
      },
    ])
  })
})

describe('observeOpencodeState DB handle reuse + mtime gate', () => {
  it('reuses one handle, skips the per-tick query while mtime is unchanged, re-runs when it advances, and closes on stop', async () => {
    if (!DatabaseSync) return // node:sqlite unavailable in this runtime

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

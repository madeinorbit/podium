import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { agentStateProviderFor } from './claude-code.js'
import { opencodeStateProvider } from './opencode.js'

async function seedSessionDb(
  root: string,
  sessionId: string,
  cwd: string,
  assistantText: string,
): Promise<void> {
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
  ).run(
    'prt-a',
    'msg-a',
    sessionId,
    1,
    2,
    JSON.stringify({ type: 'text', text: assistantText }),
  )
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
      { kind: 'turn_completed', verdict: { kind: 'done', summary: 'Ready when you are.' } },
    ])
  })
})
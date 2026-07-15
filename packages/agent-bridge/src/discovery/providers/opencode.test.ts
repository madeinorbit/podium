import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { isOpencodeCliAvailable } from '../../opencode/cli.js'
import { createOpencodeConversationProvider } from './opencode.js'

const provider = createOpencodeConversationProvider()

async function seedOpencodeDb(
  root: string,
  session: {
    id: string
    directory: string
    title: string
    timeCreated?: number
    timeUpdated?: number
  },
): Promise<void> {
  const dbPath = join(root, 'opencode.db')
  const db = openDatabase(dbPath)
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
  ).run(
    session.id,
    session.directory,
    session.title,
    session.timeCreated ?? 1_700_000_000_000,
    session.timeUpdated ?? 1_700_000_100_000,
  )
  db.close()
}

describe('opencode discovery provider', () => {
  let home: string

  afterEach(async () => {
    if (home) {
      process.env.HOME = undefined
    }
  })

  // The provider gates on the real CLI being installed (scanRoot returns [] with a
  // warning otherwise) — mirror cli.test.ts and self-skip on machines without it.
  it.skipIf(!isOpencodeCliAvailable())(
    'summarizes sessions from the opencode sqlite database',
    async () => {
      home = await mkdtemp(join(tmpdir(), 'podium-opencode-home-'))
      const root = join(home, '.local', 'share', 'opencode')
      await mkdir(root, { recursive: true })
      await seedOpencodeDb(root, {
        id: 'ses_test123',
        directory: '/repo/opencode',
        title: 'Add mobile booking flow',
      })

      const prevHome = process.env.HOME
      process.env.HOME = home
      try {
        const result = await provider.scanRoot(root)
        expect(result.conversations).toEqual([
          expect.objectContaining({
            id: 'ses_test123',
            agentKind: 'opencode',
            title: 'Add mobile booking flow',
            projectPath: '/repo/opencode',
            resume: { kind: 'opencode-session', value: 'ses_test123' },
            source: expect.objectContaining({ providerId: 'opencode-sessions', root }),
          }),
        ])
      } finally {
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      }
    },
  )
})

import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readCodexStateMetadata } from './codex-state.js'

async function createCodexRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'podium-codex-state-'))
  await mkdir(root, { recursive: true })
  return root
}

function createStateDb(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, archived, git_sha, git_branch, git_origin_url,
      first_user_message, preview, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'thread-1',
    'sessions/2026/06/01/thread-1.jsonl',
    1,
    2,
    'codex',
    'openai',
    '/repo/project',
    'Native Codex Title',
    '{}',
    'on-request',
    1,
    'abc123',
    'main',
    'git@example.com:repo.git',
    'first message',
    'native preview',
    Date.parse('2026-06-01T10:00:00.000Z'),
    Date.parse('2026-06-01T10:05:00.000Z'),
  )
  db.prepare(
    'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)',
  ).run('parent-thread', 'thread-1', 'completed')
  db.close()
}

describe('readCodexStateMetadata', () => {
  test('reads native thread metadata and parent relationships from state sqlite', async () => {
    const root = await createCodexRoot()
    createStateDb(join(root, 'state_5.sqlite'))

    const result = await readCodexStateMetadata(root)

    expect(result.diagnostics).toEqual([])
    expect(result.byThreadId.get('thread-1')).toEqual(
      expect.objectContaining({
        id: 'thread-1',
        title: 'Native Codex Title',
        rolloutPath: join(root, 'sessions/2026/06/01/thread-1.jsonl'),
        cwd: '/repo/project',
        archived: true,
        parentThreadId: 'parent-thread',
        createdAt: new Date('2026-06-01T10:00:00.000Z'),
        updatedAt: new Date('2026-06-01T10:05:00.000Z'),
        git: {
          branch: 'main',
          sha: 'abc123',
          originUrl: 'git@example.com:repo.git',
        },
      }),
    )
    expect(result.byRolloutPath.get(join(root, 'sessions/2026/06/01/thread-1.jsonl'))?.id).toBe(
      'thread-1',
    )
  })

  test('returns empty metadata when no state database exists', async () => {
    const root = await createCodexRoot()

    const result = await readCodexStateMetadata(root)

    expect(result.byThreadId.size).toBe(0)
    expect(result.byRolloutPath.size).toBe(0)
    expect(result.diagnostics).toEqual([])
  })
})

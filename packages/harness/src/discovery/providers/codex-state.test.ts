import { mkdir, mkdtemp, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, test, vi } from 'vitest'
import {
  createCodexStateMetadataReader,
  createSharedCodexStateMetadataReaders,
  readCodexStateMetadata,
} from './codex-state.js'

// Rewrite the (single) threads row's title in place so a fresh read returns
// updated data. Mirrors a `/rename` done inside Codex.
function setNativeTitle(dbPath: string, title: string): void {
  const db = openDatabase(dbPath)
  db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, 'thread-1')
  db.close()
}

async function createCodexRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'podium-codex-state-'))
  await mkdir(root, { recursive: true })
  return root
}

function createStateDb(path: string): void {
  const db = openDatabase(path)
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

describe('createCodexStateMetadataReader', () => {
  test('skips the re-read while the state DB mtime is unchanged', async () => {
    const root = await createCodexRoot()
    const dbPath = join(root, 'state_5.sqlite')
    createStateDb(dbPath)

    const read = vi.fn(readCodexStateMetadata)
    const reader = createCodexStateMetadataReader(read)

    const first = await reader(root)
    expect(read).toHaveBeenCalledTimes(1)
    expect(first.byThreadId.get('thread-1')?.title).toBe('Native Codex Title')

    // Repeated polls with the file untouched must not re-open the DB; the same
    // cached result object is returned each time.
    const second = await reader(root)
    const third = await reader(root)
    expect(read).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  test('re-reads (and returns updated data) once the state DB mtime advances', async () => {
    const root = await createCodexRoot()
    const dbPath = join(root, 'state_5.sqlite')
    createStateDb(dbPath)

    const read = vi.fn(readCodexStateMetadata)
    const reader = createCodexStateMetadataReader(read)

    const before = await reader(root)
    expect(before.byThreadId.get('thread-1')?.title).toBe('Native Codex Title')
    expect(read).toHaveBeenCalledTimes(1)

    // A /rename: rewrite the title, then advance the file mtime so the gate trips.
    setNativeTitle(dbPath, 'Renamed By User')
    const bumped = (await stat(dbPath)).mtimeMs + 5000
    const when = new Date(bumped)
    await utimes(dbPath, when, when)

    const after = await reader(root)
    expect(read).toHaveBeenCalledTimes(2)
    expect(after).not.toBe(before)
    expect(after.byThreadId.get('thread-1')?.title).toBe('Renamed By User')

    // And it settles back to memoized reads at the new mtime.
    const again = await reader(root)
    expect(read).toHaveBeenCalledTimes(2)
    expect(again).toBe(after)
  })

  test('coalesces concurrent reads for one advanced state DB version', async () => {
    const root = await createCodexRoot()
    const dbPath = join(root, 'state_5.sqlite')
    createStateDb(dbPath)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = vi.fn(async (value: string) => {
      await held
      return readCodexStateMetadata(value)
    })
    const reader = createCodexStateMetadataReader(read)

    const first = reader(root)
    const second = reader(root)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    release()

    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a.byThreadId.get('thread-1')?.title).toBe('Native Codex Title')
  })

  test('shares one read per mtime version across 26 observers and releases the last cache', async () => {
    const root = await createCodexRoot()
    const dbPath = join(root, 'state_5.sqlite')
    createStateDb(dbPath)
    const read = vi.fn(readCodexStateMetadata)
    const shared = createSharedCodexStateMetadataReaders(read)
    const observers = Array.from({ length: 26 }, () => shared.acquire(root))

    const initial = await Promise.all(observers.map((observer) => observer.read()))
    expect(read).toHaveBeenCalledTimes(1)
    expect(new Set(initial).size).toBe(1)

    setNativeTitle(dbPath, 'One Shared Rename')
    const bumped = (await stat(dbPath)).mtimeMs + 5000
    await utimes(dbPath, new Date(bumped), new Date(bumped))
    const updated = await Promise.all(observers.map((observer) => observer.read()))
    expect(read).toHaveBeenCalledTimes(2)
    expect(new Set(updated).size).toBe(1)
    expect(updated[0]?.byThreadId.get('thread-1')?.title).toBe('One Shared Rename')

    for (const observer of observers.slice(0, -1)) observer.release()
    expect(shared.activeRoots()).toBe(1)
    observers.at(-1)?.release()
    expect(shared.activeRoots()).toBe(0)

    const replacement = shared.acquire(root)
    await replacement.read()
    expect(read).toHaveBeenCalledTimes(3)
    replacement.release()
  })

  test('falls back to a fresh read (never memoized stale data) when no state DB exists', async () => {
    const root = await createCodexRoot()
    const read = vi.fn(readCodexStateMetadata)
    const reader = createCodexStateMetadataReader(read)

    // No state DB → statePath is undefined; we never memoize, so each call reads.
    const a = await reader(root)
    const b = await reader(root)
    expect(a.byThreadId.size).toBe(0)
    expect(b.byThreadId.size).toBe(0)
    expect(read).toHaveBeenCalledTimes(2)
  })
})

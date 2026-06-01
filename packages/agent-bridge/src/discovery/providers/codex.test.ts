import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createCodexConversationProvider } from './codex.js'

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-codex-'))
}

async function writeCodexSession(root: string, relativePath: string, id = 'codex-session-1'): Promise<string> {
  const file = join(root, relativePath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({
        timestamp: '2026-06-01T10:00:00.000Z',
        type: 'session_meta',
        payload: { id, timestamp: '2026-06-01T10:00:00.000Z', cwd: '/repo/from-jsonl' },
      }),
      JSON.stringify({
        timestamp: '2026-06-01T10:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build scanner' }] },
      }),
      JSON.stringify({
        timestamp: '2026-06-01T10:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'scanner built' }],
        },
      }),
    ].join('\n'),
  )
  return file
}

function createStateDb(root: string): void {
  const db = new DatabaseSync(join(root, 'state_5.sqlite'))
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
      archived INTEGER NOT NULL DEFAULT 0,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
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
    'codex-session-1',
    'sessions/2026/06/01/session.jsonl',
    1,
    2,
    'codex',
    'openai',
    '/repo/from-sqlite',
    'Native Codex Title',
    '{}',
    'on-request',
    1,
    'abc123',
    'main',
    'git@example.com:repo.git',
    'first message',
    'native preview',
    Date.parse('2026-06-01T09:00:00.000Z'),
    Date.parse('2026-06-01T10:05:00.000Z'),
  )
  db.prepare(
    'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)',
  ).run('parent-thread', 'codex-session-1', 'completed')
  db.close()
}

describe('createCodexConversationProvider', () => {
  test('uses ~/.codex as the default root', () => {
    const provider = createCodexConversationProvider()
    expect(provider.defaultRoots({ homeDir: '/home/tester' })).toEqual(['/home/tester/.codex'])
  })

  test('scans Codex session JSONL files and enriches summaries from state sqlite', async () => {
    const root = await createRoot()
    await writeCodexSession(root, 'sessions/2026/06/01/session.jsonl')
    createStateDb(root)

    const result = await createCodexConversationProvider().scanRoot(root)

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: 'codex-session-1',
        agentKind: 'codex',
        title: 'Native Codex Title',
        titleSource: 'native',
        projectPath: '/repo/from-sqlite',
        parentConversationId: 'parent-thread',
        statusHint: 'archived',
        messageCount: 2,
        git: { branch: 'main', sha: 'abc123', originUrl: 'git@example.com:repo.git' },
        resume: { kind: 'codex-thread', value: 'codex-session-1' },
        source: expect.objectContaining({ providerId: 'codex-jsonl', root }),
      }),
    ])
    expect(result.conversations[0]).not.toHaveProperty('messages')
    expect(result.conversations[0]?.createdAt?.toISOString()).toBe('2026-06-01T09:00:00.000Z')
    expect(result.conversations[0]?.updatedAt?.toISOString()).toBe('2026-06-01T10:05:00.000Z')
  })

  test('loads full normalized Codex messages on demand', async () => {
    const root = await createRoot()
    await writeCodexSession(root, 'sessions/2026/06/01/session.jsonl')
    const provider = createCodexConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()

    const conversation = await provider.loadConversation(summary!)

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'build scanner' }),
      expect.objectContaining({ role: 'assistant', content: 'scanner built' }),
    ])
    expect(conversation.raw).toEqual(expect.any(Array))
  })

  test('reports malformed candidate files without failing the whole root', async () => {
    const root = await createRoot()
    await mkdir(join(root, 'sessions/2026/06/01'), { recursive: true })
    await writeFile(join(root, 'sessions/2026/06/01/bad.jsonl'), '{"ok":true}\nnot-json\n')

    const result = await createCodexConversationProvider().scanRoot(root)

    expect(result.conversations).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        providerId: 'codex-jsonl',
        message: expect.stringContaining('Could not parse JSONL line 2'),
      }),
    ])
  })
})

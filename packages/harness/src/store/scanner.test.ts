import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ConversationDiscoveryCache } from './cache.js'
import {
  loadAgentConversation,
  scanAgentConversations,
  scanAgentConversationsCached,
} from './scanner.js'
import { AgentConversationLoadError, type AgentConversationSummary } from './types.js'

async function createHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-scanner-'))
}

async function writeCodexSession(
  root: string,
  relativePath = 'sessions/2026/06/01/codex-session.jsonl',
  id = 'codex-session',
  timestamp = '2026-06-01T10:00:00.000Z',
): Promise<string> {
  const file = join(root, relativePath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({
        timestamp,
        type: 'session_meta',
        payload: { id, timestamp, cwd: '/repo/codex' },
      }),
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'codex scan' }],
        },
      }),
    ].join('\n'),
  )
  return file
}

async function writeClaudeSession(
  root: string,
  relativePath = 'projects/-repo/claude-session.jsonl',
  id = 'claude-session',
  timestamp = '2026-06-01T11:00:00.000Z',
): Promise<string> {
  const file = join(root, relativePath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'summary', customTitle: 'Claude work', sessionId: id }),
      JSON.stringify({
        type: 'user',
        timestamp,
        cwd: '/repo/claude',
        sessionId: id,
        message: { role: 'user', content: 'claude scan' },
      }),
    ].join('\n'),
  )
  return file
}

async function writeGrokSession(
  root: string,
  relativePath = 'sessions/%2Frepo%2Fgrok/grok-session/summary.json',
  id = 'grok-session',
): Promise<string> {
  const file = join(root, relativePath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({
      info: { id, cwd: '/repo/grok' },
      session_summary: 'Grok work',
      created_at: '2026-06-01T12:00:00.000Z',
      updated_at: '2026-06-01T12:01:00.000Z',
      num_chat_messages: 2,
      git_root_dir: '/repo/grok',
      head_branch: 'main',
      head_commit: 'abc123',
      git_remotes: ['git@example.com:repo/grok.git'],
    }),
  )
  await writeFile(
    join(file, '..', 'chat_history.jsonl'),
    [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'grok scan' }] }),
      JSON.stringify({ type: 'assistant', content: 'grok answer' }),
    ].join('\n'),
  )
  return file
}

describe('scanAgentConversations', () => {
  test('uses known default roots under the supplied home directory and sees built-in agent conversations', async () => {
    const homeDir = await createHome()
    await writeCodexSession(join(homeDir, '.codex'))
    await writeClaudeSession(join(homeDir, '.claude'))
    await writeGrokSession(join(homeDir, '.grok'))

    const result = await scanAgentConversations({ homeDir })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations.map((conversation) => conversation.agentKind).sort()).toEqual([
      'claude-code',
      'codex',
      'grok',
    ])
    expect(result.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'grok-session',
          source: expect.objectContaining({ providerId: 'grok-sessions' }),
          resume: { kind: 'grok-session', value: 'grok-session' },
        }),
        expect.objectContaining({
          id: 'claude-session',
          source: expect.objectContaining({ providerId: 'claude-code-jsonl' }),
        }),
        expect.objectContaining({
          id: 'codex-session',
          source: expect.objectContaining({ providerId: 'codex-jsonl' }),
        }),
      ]),
    )
    expect(result.conversations[0]).not.toHaveProperty('messages')
  })

  test('includeDefaults false scans explicit extra roots only', async () => {
    const homeDir = await createHome()
    await writeCodexSession(join(homeDir, '.codex'), undefined, 'default-codex')
    const extraRoot = join(homeDir, 'archive-codex')
    await writeCodexSession(extraRoot, undefined, 'extra-codex')

    const result = await scanAgentConversations({
      homeDir,
      includeDefaults: false,
      extraRoots: { codex: [extraRoot] },
    })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0]).toEqual(expect.objectContaining({ id: 'extra-codex' }))
  })

  test('filters providers by requested agents', async () => {
    const homeDir = await createHome()
    await writeCodexSession(join(homeDir, '.codex'))
    await writeClaudeSession(join(homeDir, '.claude'))
    await writeGrokSession(join(homeDir, '.grok'))

    const result = await scanAgentConversations({ homeDir, agents: ['grok'] })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0]).toEqual(expect.objectContaining({ agentKind: 'grok' }))
  })

  test('skips missing roots without diagnostics and dedupes symlinked roots', async () => {
    const homeDir = await createHome()
    const codexRoot = join(homeDir, 'codex-root')
    const codexLink = join(homeDir, 'codex-link')
    await writeCodexSession(codexRoot)
    await symlink(codexRoot, codexLink)

    const result = await scanAgentConversations({
      homeDir,
      includeDefaults: false,
      extraRoots: { codex: [join(homeDir, 'missing-codex'), codexRoot, codexLink] },
    })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0]).toEqual(expect.objectContaining({ id: 'codex-session' }))
  })

  test('extra root with tilde expands against the supplied home directory', async () => {
    const homeDir = await createHome()
    await writeCodexSession(join(homeDir, 'archive-codex'), undefined, 'tilde-codex')

    const result = await scanAgentConversations({
      homeDir,
      includeDefaults: false,
      extraRoots: { codex: ['~/archive-codex'] },
    })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0]).toEqual(expect.objectContaining({ id: 'tilde-codex' }))
  })
})

describe('loadAgentConversation', () => {
  test('loads through the provider recorded in the summary', async () => {
    const homeDir = await createHome()
    await writeGrokSession(join(homeDir, '.grok'))
    const result = await scanAgentConversations({ homeDir, agents: ['grok'] })
    const summary = result.conversations[0]
    expect(summary).toBeDefined()
    if (!summary) throw new Error('Expected conversation summary')

    const conversation = await loadAgentConversation(summary)

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'grok scan' }),
      expect.objectContaining({ role: 'assistant', content: 'grok answer' }),
    ])
  })

  test('throws AgentConversationLoadError for an unregistered provider id', async () => {
    const summary: AgentConversationSummary = {
      id: 'unknown',
      agentKind: 'codex',
      source: {
        providerId: 'missing-provider',
        root: '/tmp/missing',
        path: '/tmp/missing/session.jsonl',
      },
    }

    await expect(loadAgentConversation(summary)).rejects.toBeInstanceOf(AgentConversationLoadError)
  })
})

describe('scanAgentConversationsCached deltas', () => {
  test('reports only changed files on the second pass', async () => {
    const home = await createHome()
    const file = await writeClaudeSession(join(home, '.claude'))
    expect(file).toBeDefined()
    const cache = new ConversationDiscoveryCache(':memory:')
    try {
      const first = await scanAgentConversationsCached({ cache, homeDir: home })
      expect(first.changed.length).toBeGreaterThan(0)
      expect(first.removed).toEqual([])
      const second = await scanAgentConversationsCached({ cache, homeDir: home })
      expect(second.changed.length).toBe(0) // unchanged → empty delta
      expect(second.removed).toEqual([])
    } finally {
      cache.close()
    }
  })

  test('reports the conversation ids pruned when a file disappears', async () => {
    const home = await createHome()
    await writeClaudeSession(join(home, '.claude'))
    const cache = new ConversationDiscoveryCache(':memory:')
    try {
      const first = await scanAgentConversationsCached({ cache, homeDir: home })
      expect(first.changed.map((summary) => summary.id)).toContain('claude-session')

      // A second scan over an EMPTY home prunes the cached row; `removed` carries its id.
      const emptyHome = await createHome()
      const second = await scanAgentConversationsCached({ cache, homeDir: emptyHome })
      expect(second.removed).toContain('claude-session')
    } finally {
      cache.close()
    }
  })
})

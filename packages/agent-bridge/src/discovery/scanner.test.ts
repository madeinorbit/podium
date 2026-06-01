import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { AgentConversationLoadError, type AgentConversationSummary } from './types.js'
import { loadAgentConversation, scanAgentConversations } from './scanner.js'

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

describe('scanAgentConversations', () => {
  test('uses known default roots under the supplied home directory and sees Codex and Claude conversations', async () => {
    const homeDir = await createHome()
    await writeCodexSession(join(homeDir, '.codex'))
    await writeClaudeSession(join(homeDir, '.claude'))

    const result = await scanAgentConversations({ homeDir })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations.map((conversation) => conversation.agentKind)).toEqual([
      'claude-code',
      'codex',
    ])
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: 'claude-session',
        source: expect.objectContaining({ providerId: 'claude-code-jsonl' }),
      }),
      expect.objectContaining({
        id: 'codex-session',
        source: expect.objectContaining({ providerId: 'codex-jsonl' }),
      }),
    ])
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

    const result = await scanAgentConversations({ homeDir, agents: ['codex'] })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0]).toEqual(expect.objectContaining({ agentKind: 'codex' }))
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
    await writeCodexSession(join(homeDir, '.codex'))
    const result = await scanAgentConversations({ homeDir, agents: ['codex'] })
    const summary = result.conversations[0]
    expect(summary).toBeDefined()

    const conversation = await loadAgentConversation(summary!)

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'codex scan' }),
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

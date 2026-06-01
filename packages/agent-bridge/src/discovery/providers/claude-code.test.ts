import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { AgentConversationLoadError } from '../types.js'
import { createClaudeCodeConversationProvider } from './claude-code.js'

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-claude-'))
}

async function writeClaudeSession(
  root: string,
  relativePath: string,
  id = 'claude-session-1',
  title = 'Scanner work',
): Promise<string> {
  const file = join(root, relativePath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'summary', customTitle: title, sessionId: id }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-06-01T11:00:00.000Z',
        cwd: '/repo/project',
        sessionId: id,
        message: { role: 'user', content: 'scan conversations' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-06-01T11:01:00.000Z',
        cwd: '/repo/project',
        sessionId: id,
        message: { role: 'assistant', content: [{ type: 'text', text: 'found conversations' }] },
      }),
    ].join('\n'),
  )
  return file
}

describe('createClaudeCodeConversationProvider', () => {
  test('uses ~/.claude as the default root', () => {
    const provider = createClaudeCodeConversationProvider()
    expect(provider.defaultRoots({ homeDir: '/home/tester' })).toEqual(['/home/tester/.claude'])
  })

  test('returns no conversations or diagnostics when projects root is missing', async () => {
    const root = await createRoot()

    const result = await createClaudeCodeConversationProvider().scanRoot(root)

    expect(result).toEqual({ conversations: [], diagnostics: [] })
  })

  test('scans top-level project sessions and nested subagents with parent relationships', async () => {
    const root = await createRoot()
    await writeClaudeSession(root, 'projects/-repo-project/claude-session-1.jsonl')
    await writeClaudeSession(
      root,
      'projects/-repo-project/claude-session-1/subagents/agent-a.jsonl',
      'agent-a',
      'Subagent work',
    )

    const result = await createClaudeCodeConversationProvider().scanRoot(root)

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toHaveLength(2)
    const parent = result.conversations.find((conversation) => conversation.id === 'claude-session-1')
    const child = result.conversations.find((conversation) => conversation.id === 'agent-a')

    expect(parent).toEqual(
      expect.objectContaining({
        id: 'claude-session-1',
        agentKind: 'claude-code',
        title: 'Scanner work',
        titleSource: 'native',
        projectPath: '/repo/project',
        statusHint: 'unknown',
        messageCount: 2,
        resume: { kind: 'claude-session', value: 'claude-session-1' },
        source: expect.objectContaining({ providerId: 'claude-code-jsonl', root }),
      }),
    )
    expect(parent).not.toHaveProperty('messages')
    expect(parent?.createdAt?.toISOString()).toBe('2026-06-01T11:00:00.000Z')
    expect(parent?.updatedAt?.toISOString()).toBe('2026-06-01T11:01:00.000Z')

    expect(child).toEqual(
      expect.objectContaining({
        id: 'agent-a',
        agentKind: 'claude-code',
        parentConversationId: 'claude-session-1',
        title: 'Subagent work',
        titleSource: 'native',
        projectPath: '/repo/project',
        statusHint: 'unknown',
        messageCount: 2,
        resume: { kind: 'claude-session', value: 'agent-a' },
        source: expect.objectContaining({
          providerId: 'claude-code-jsonl',
          root,
          relatedPaths: [join(root, 'projects/-repo-project/claude-session-1/subagents/agent-a.meta.json')],
        }),
      }),
    )
    expect(child).not.toHaveProperty('messages')
  })

  test('falls back to filename titles when no custom title exists', async () => {
    const root = await createRoot()
    const file = join(root, 'projects/-repo-project/untitled.jsonl')
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({
        timestamp: '2026-06-01T11:00:00.000Z',
        sessionId: 'untitled',
        message: { role: 'user', content: 'hello' },
      }),
    )

    const result = await createClaudeCodeConversationProvider().scanRoot(root)

    expect(result.conversations[0]).toEqual(
      expect.objectContaining({ id: 'untitled', title: 'untitled', titleSource: 'filename' }),
    )
  })

  test('loads full normalized Claude Code messages on demand and includes raw records', async () => {
    const root = await createRoot()
    await writeClaudeSession(root, 'projects/-repo-project/claude-session-1.jsonl')
    const provider = createClaudeCodeConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()

    const conversation = await provider.loadConversation(summary!)

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'scan conversations' }),
      expect.objectContaining({ role: 'assistant', content: 'found conversations' }),
    ])
    expect(conversation.messages[0]?.raw).toEqual(expect.objectContaining({ uuid: 'user-1' }))
    expect(conversation.raw).toEqual(expect.any(Array))
  })

  test('reports malformed project JSONL without failing the whole root', async () => {
    const root = await createRoot()
    await writeClaudeSession(root, 'projects/-repo-project/good.jsonl', 'good')
    await mkdir(join(root, 'projects/-repo-project'), { recursive: true })
    await writeFile(join(root, 'projects/-repo-project/bad.jsonl'), '{"ok":true}\nnot-json\n')

    const result = await createClaudeCodeConversationProvider().scanRoot(root)

    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0]).toEqual(expect.objectContaining({ id: 'good' }))
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        providerId: 'claude-code-jsonl',
        message: expect.stringContaining('Could not parse JSONL line 2'),
      }),
    ])
  })

  test('reports deleted lazy-load files as load failures with the original cause', async () => {
    const root = await createRoot()
    await writeClaudeSession(root, 'projects/-repo-project/claude-session-1.jsonl')
    const provider = createClaudeCodeConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()
    await rm(summary!.source.path)

    let error: unknown
    try {
      await provider.loadConversation(summary!)
    } catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(AgentConversationLoadError)
    expect(error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Could not load Claude Code conversation'),
        cause: expect.objectContaining({ code: 'ENOENT' }),
      }),
    )
  })
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { AgentConversationLoadError } from '../types.js'
import { createGrokConversationProvider } from './grok.js'

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-grok-'))
}

async function writeGrokSession(
  root: string,
  id = '019e-grok',
  cwd = '/repo/grok',
): Promise<string> {
  const file = join(root, 'sessions', encodeURIComponent(cwd), id, 'summary.json')
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({
      info: { id, cwd },
      session_summary: 'Native Grok Title',
      created_at: '2026-06-01T12:00:00.000Z',
      updated_at: '2026-06-01T12:03:00.000Z',
      num_chat_messages: 2,
      head_branch: 'main',
      head_commit: 'abc123',
      git_remotes: ['git@example.com:repo/grok.git'],
    }),
  )
  await writeFile(
    join(file, '..', 'chat_history.jsonl'),
    [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'scan grok' }] }),
      JSON.stringify({ type: 'assistant', content: 'found grok' }),
    ].join('\n'),
  )
  return file
}

describe('createGrokConversationProvider', () => {
  test('uses ~/.grok as the default root', () => {
    const provider = createGrokConversationProvider()
    expect(provider.defaultRoots({ homeDir: '/home/tester' })).toEqual(['/home/tester/.grok'])
  })

  test('returns no conversations or diagnostics when sessions root is missing', async () => {
    const root = await createRoot()

    const result = await createGrokConversationProvider().scanRoot(root)

    expect(result).toEqual({ conversations: [], diagnostics: [] })
  })

  test('scans Grok summary.json sessions and builds resumable summaries', async () => {
    const root = await createRoot()
    await writeGrokSession(root)

    const result = await createGrokConversationProvider().scanRoot(root)

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: '019e-grok',
        agentKind: 'grok',
        title: 'Native Grok Title',
        titleSource: 'native',
        projectPath: '/repo/grok',
        messageCount: 2,
        git: {
          branch: 'main',
          sha: 'abc123',
          originUrl: 'git@example.com:repo/grok.git',
        },
        resume: { kind: 'grok-session', value: '019e-grok' },
        source: expect.objectContaining({ providerId: 'grok-sessions', root }),
      }),
    ])
    expect(result.conversations[0]?.createdAt?.toISOString()).toBe('2026-06-01T12:00:00.000Z')
    expect(result.conversations[0]?.updatedAt?.toISOString()).toBe('2026-06-01T12:03:00.000Z')
  })

  test('loads normalized Grok chat history on demand', async () => {
    const root = await createRoot()
    await writeGrokSession(root)
    const provider = createGrokConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()
    if (!summary) throw new Error('Expected Grok conversation summary')

    const conversation = await provider.loadConversation(summary)

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'scan grok' }),
      expect.objectContaining({ role: 'assistant', content: 'found grok' }),
    ])
    expect(conversation.raw).toEqual(expect.any(Array))
  })

  test('reports deleted lazy-load chat history as load failures', async () => {
    const root = await createRoot()
    await writeGrokSession(root)
    const provider = createGrokConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()
    if (!summary) throw new Error('Expected Grok conversation summary')
    await rm(join(summary.source.path, '..', 'chat_history.jsonl'))

    await expect(provider.loadConversation(summary)).rejects.toBeInstanceOf(
      AgentConversationLoadError,
    )
  })
})

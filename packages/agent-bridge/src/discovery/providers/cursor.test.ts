import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { AgentConversationLoadError } from '../types.js'
import { createCursorConversationProvider } from './cursor.js'

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-cursor-'))
}

async function writeCursorSession(
  root: string,
  id = '6ae2e968-64a4-40c7-9a9e-c4b2eba17511',
  cwd = '/home/user/src/other/podium',
): Promise<string> {
  const slug = cwd.replace(/^\//, '').replace(/\//g, '-').toLowerCase()
  const file = join(root, 'projects', slug, 'agent-transcripts', id, `${id}.jsonl`)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '<user_query>\nscan cursor\n</user_query>' }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'found cursor' }] },
      }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
    ].join('\n'),
  )
  return file
}

describe('createCursorConversationProvider', () => {
  test('uses ~/.cursor as the default root', () => {
    const provider = createCursorConversationProvider()
    expect(provider.defaultRoots({ homeDir: '/home/tester' })).toEqual(['/home/tester/.cursor'])
  })

  test('returns no conversations when projects root is missing', async () => {
    const root = await createRoot()
    const result = await createCursorConversationProvider().scanRoot(root)
    expect(result).toEqual({ conversations: [], diagnostics: [] })
  })

  test('scans agent-transcripts and builds resumable summaries', async () => {
    const root = await createRoot()
    await writeCursorSession(root)

    const result = await createCursorConversationProvider().scanRoot(root)

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: '6ae2e968-64a4-40c7-9a9e-c4b2eba17511',
        agentKind: 'cursor',
        title: 'scan cursor',
        titleSource: 'heuristic',
        projectPath: '/home/user/src/other/podium',
        resume: {
          kind: 'cursor-chat',
          value: '6ae2e968-64a4-40c7-9a9e-c4b2eba17511',
        },
        source: expect.objectContaining({ providerId: 'cursor-agent-transcripts', root }),
      }),
    ])
  })

  test('loads normalized transcript messages on demand', async () => {
    const root = await createRoot()
    await writeCursorSession(root)
    const provider = createCursorConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()
    if (!summary) throw new Error('Expected Cursor conversation summary')

    const conversation = await provider.loadConversation(summary)

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'scan cursor' }),
      expect.objectContaining({ role: 'assistant', content: 'found cursor' }),
    ])
  })

  test('reports deleted transcript files as load failures', async () => {
    const root = await createRoot()
    const file = await writeCursorSession(root)
    const provider = createCursorConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()
    if (!summary) throw new Error('Expected Cursor conversation summary')
    await rm(file)

    await expect(provider.loadConversation(summary)).rejects.toBeInstanceOf(
      AgentConversationLoadError,
    )
  })

  test('keeps the parseable records instead of failing the whole conversation on a torn line', async () => {
    const root = await createRoot()
    await writeCursorSession(root)
    const provider = createCursorConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    if (!summary) throw new Error('Expected Cursor conversation summary')
    await writeFile(summary.source.path, '{"ok":true}\nnot-json\n')

    const conversation = await provider.loadConversation(summary)
    expect(Array.isArray(conversation.messages)).toBe(true)
    expect(conversation.diagnostics).toEqual([
      expect.objectContaining({
        providerId: 'cursor-agent-transcripts',
        message: expect.stringContaining('Could not parse JSONL line 2'),
      }),
    ])
  })
})
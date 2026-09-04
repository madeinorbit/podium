import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createPiConversationProvider } from './pi.js'

const id = '9e804279-978a-4644-adc4-f815f25a5728'
const cwd = '/home/user/src/other/podium'

async function writePiSession(root: string, lines: string[] = defaultLines()): Promise<string> {
  const file = join(
    root,
    'sessions',
    '--home-user-src-other-podium--',
    `2026-09-02T09-48-46-898Z_${id}.jsonl`,
  )
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${lines.join('\n')}\n`)
  return file
}

function defaultLines(): string[] {
  return [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-09-02T09:48:46.898Z',
      cwd,
    }),
    JSON.stringify({
      type: 'model_change',
      id: '20382faf',
      parentId: null,
      timestamp: '2026-09-02T09:48:46.994Z',
      provider: 'fake',
      modelId: 'fake-model',
    }),
    JSON.stringify({
      type: 'message',
      id: '9d671487',
      parentId: '20382faf',
      timestamp: '2026-09-02T09:48:47.022Z',
      message: { role: 'user', content: [{ type: 'text', text: 'scan pi sessions please' }] },
    }),
    JSON.stringify({
      type: 'message',
      id: '57f31578',
      parentId: '9d671487',
      timestamp: '2026-09-02T09:48:47.074Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }],
        stopReason: 'toolUse',
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'ab5a0a4e',
      parentId: '57f31578',
      timestamp: '2026-09-02T09:48:47.091Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'a.txt\n' }],
        isError: false,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: '9442e01a',
      parentId: 'ab5a0a4e',
      timestamp: '2026-09-02T09:48:47.103Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Found one file.' }],
        stopReason: 'stop',
      },
    }),
  ]
}

describe('createPiConversationProvider', () => {
  test('uses ~/.pi/agent as the default root', () => {
    expect(createPiConversationProvider().defaultRoots({ homeDir: '/home/t' })).toEqual([
      '/home/t/.pi/agent',
    ])
  })

  test('returns no conversations when the sessions dir is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-pi-'))
    expect(await createPiConversationProvider().scanRoot(root)).toEqual({
      conversations: [],
      diagnostics: [],
    })
  })

  test('scans session files into resumable summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-pi-'))
    const file = await writePiSession(root)
    const result = await createPiConversationProvider().scanRoot(root)
    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id,
        agentKind: 'pi',
        title: 'scan pi sessions please',
        titleSource: 'heuristic',
        projectPath: cwd,
        createdAt: new Date('2026-09-02T09:48:46.898Z'),
        messageCount: 4,
        resume: { kind: 'pi-session', value: id },
        source: expect.objectContaining({ providerId: 'pi-sessions', root, path: file }),
      }),
    ])
  })

  test('a session_info name is the native title', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-pi-'))
    await writePiSession(root, [
      ...defaultLines(),
      JSON.stringify({
        type: 'session_info',
        id: 'x',
        parentId: '9442e01a',
        name: 'Refactor auth',
      }),
    ])
    const [summary] = (await createPiConversationProvider().scanRoot(root)).conversations
    expect(summary).toMatchObject({ title: 'Refactor auth', titleSource: 'native' })
  })

  test('loads the conversation with user, assistant and tool messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-pi-'))
    await writePiSession(root)
    const provider = createPiConversationProvider()
    const [summary] = (await provider.scanRoot(root)).conversations
    if (!summary) throw new Error('no summary')
    const conversation = await provider.loadConversation(summary)
    expect(conversation.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'scan pi sessions please'],
      ['tool', 'a.txt\n'],
      ['assistant', 'Found one file.'],
    ])
    expect(conversation.messages[0]?.createdAt).toEqual(new Date('2026-09-02T09:48:47.022Z'))
  })

  test('a torn line is a diagnostic, not a lost session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-pi-'))
    await writePiSession(root, [...defaultLines(), '{"type":"message","id":"trunc'])
    const provider = createPiConversationProvider()
    const [summary] = (await provider.scanRoot(root)).conversations
    if (!summary) throw new Error('no summary')
    const conversation = await provider.loadConversation(summary)
    expect(conversation.messages).toHaveLength(3)
    expect(conversation.diagnostics).toHaveLength(1)
  })
})

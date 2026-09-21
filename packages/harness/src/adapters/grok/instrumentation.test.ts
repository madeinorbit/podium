import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { grokInstrumentation, grokSessionPaths } from './instrumentation.js'

const tmpDirs: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(tmpDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** Hook payload fixtures decode through the section, not past it (POD-4472). */
describe('grokInstrumentation.payloadCodec', () => {
  const codec = grokInstrumentation.payloadCodec

  it('reads the camelCase routing fields', () => {
    const payload = {
      hookEventName: 'UserPromptSubmit',
      sessionId: 'g1',
      transcriptPath: '/x/updates.jsonl',
    }
    expect(codec.eventName(payload)).toBe('user_prompt_submit')
    expect(codec.sessionId(payload)).toBe('g1')
    expect(codec.transcriptPath(payload)).toBe('/x/updates.jsonl')
  })

  it('decodes native hooks with the poll channel', async () => {
    await expect(
      codec.decode({ hookEventName: 'SessionStart', sessionId: 'g-native' }),
    ).resolves.toEqual([{ kind: 'session_started', source: 'poll', confidence: 0.7 }])
    await expect(
      codec.decode({
        hookEventName: 'PreToolUse',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: 'Which implementation?' }] },
      }),
    ).resolves.toEqual([
      {
        kind: 'needs_user',
        need: 'question',
        summary: 'Which implementation?',
        source: 'poll',
        confidence: 0.7,
      },
    ])
    await expect(codec.decode(null)).resolves.toEqual([])
  })

  it('classifies Stop from chat history through the section', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-section-'))
    tmpDirs.push(home)
    const paths = grokSessionPaths({ homeDir: home, cwd: '/repo/grok', sessionId: 'g-native' })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.chatHistoryPath, JSON.stringify({ type: 'assistant', content: 'Done.' }))
    await expect(
      codec.decode({ hookEventName: 'Stop', chatHistoryPath: paths.chatHistoryPath }),
    ).resolves.toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'done' },
        source: 'poll',
        confidence: 0.7,
      },
    ])
  })

  it('declares the loopback transport and installs the callback env', async () => {
    expect(grokInstrumentation.hookTransport).toBe('loopback-http')
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-section-install-'))
    tmpDirs.push(home)
    await mkdir(join(home, '.grok'), { recursive: true })
    const installed = await grokInstrumentation.install({
      sessionId: 's1' as never,
      endpointUrl: 'http://127.0.0.1:1/hooks/s1',
      settingsDir: '/settings',
      harnessHome: join(home, '.grok'),
    })
    expect(installed.args).toEqual([])
    expect(installed.env?.PODIUM_GROK_HOOK_URL).toBe('http://127.0.0.1:1/hooks/s1')
    expect(installed.degradedReason).toBeUndefined()
  })
})

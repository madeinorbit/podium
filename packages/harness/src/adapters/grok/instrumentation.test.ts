import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensurePodiumGrokHooks,
  grokInstrumentation,
  grokSessionPaths,
  PODIUM_GROK_HOOK_COMMAND,
} from './instrumentation.js'

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
    const doc = JSON.parse(await readFile(join(home, '.grok', 'hooks', 'podium.json'), 'utf8'))
    expect(doc.hooks.StopCancelled).toEqual([
      { hooks: [{ type: 'command', command: PODIUM_GROK_HOOK_COMMAND, timeout: 5 }] },
    ])
  })

  it('refreshes an older install with StopCancelled while preserving other handlers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-cancel-install-'))
    tmpDirs.push(home)
    const hooksDir = join(home, '.grok', 'hooks')
    await mkdir(hooksDir, { recursive: true })
    const path = join(hooksDir, 'podium.json')
    const foreign = { hooks: [{ type: 'command', command: 'other-observer' }] }
    await writeFile(path, JSON.stringify({ hooks: { Stop: [foreign] } }))

    await expect(ensurePodiumGrokHooks({ homeDir: home })).resolves.toMatchObject({
      installed: true,
      changed: true,
    })
    const doc = JSON.parse(await readFile(path, 'utf8'))
    expect(doc.hooks.Stop[0]).toEqual(foreign)
    expect(doc.hooks.StopCancelled).toEqual([
      { hooks: [{ type: 'command', command: PODIUM_GROK_HOOK_COMMAND, timeout: 5 }] },
    ])
    await expect(ensurePodiumGrokHooks({ homeDir: home })).resolves.toMatchObject({
      installed: true,
      changed: false,
    })
  })
})

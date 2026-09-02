import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredValue } from '../manifest.js'
import { piManifest } from './pi.js'

const headless = declaredValue(piManifest.headless)
const buildExec = headless ? declaredValue(headless.buildExec) : undefined
const exec = declaredValue(piManifest.exec)

describe('pi manifest', () => {
  it('declares the pinned-id JSON-stream headless driver', () => {
    expect(headless).toMatchObject({
      driver: 'resume-exec',
      outputFormat: 'pi-jsonl',
      resumeIdAllocation: 'daemon-minted-uuid',
      noTools: 'enforced',
    })
  })

  it('first turn: -p --mode json --session-id <pre-minted>, prompt on stdin', () => {
    const spec = buildExec?.({
      prompt: 'first prompt',
      sessionId: '9e804279-978a-4644-adc4-f815f25a5728',
      model: 'anthropic/claude-sonnet-4-5',
      effort: 'high',
      systemPrompt: 'SYS-A',
      contextPrompt: 'CTX-B',
      permissionMode: 'auto',
    })
    expect(spec).toEqual({
      cmd: 'pi',
      args: [
        '-p',
        '--mode',
        'json',
        '--session-id',
        '9e804279-978a-4644-adc4-f815f25a5728',
        '--model',
        'anthropic/claude-sonnet-4-5',
        '--thinking',
        'high',
        '--append-system-prompt',
        'SYS-A',
        '--append-system-prompt',
        'CTX-B',
        '--approve',
      ],
      stdin: 'first prompt',
    })
  })

  it('later turns resume through the same --session-id; non-auto modes refuse project trust', () => {
    const spec = buildExec?.({ prompt: 'go on', resumeValue: 'abc-123', permissionMode: 'default' })
    expect(spec?.args).toEqual(['-p', '--mode', 'json', '--session-id', 'abc-123', '--no-approve'])
    expect(spec?.stdin).toBe('go on')
  })

  it('drops an unknown effort and the auto model sentinel', () => {
    const spec = buildExec?.({ prompt: 'p', sessionId: 's', model: 'auto', effort: 'ultra' })
    expect(spec?.args).not.toContain('--thinking')
    expect(spec?.args).not.toContain('--model')
  })

  it('a tool-less turn removes every tool, extension, skill and context channel', () => {
    const spec = buildExec?.({
      prompt: 'repair',
      sessionId: 's',
      toolPolicy: 'none',
      permissionMode: 'auto',
    })
    expect(spec?.args).toEqual([
      '-p',
      '--mode',
      'json',
      '--session-id',
      's',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-context-files',
      '--no-prompt-templates',
      '--no-approve',
    ])
    expect(spec?.args).not.toContain('--approve')
  })

  it('one-shot exec prints the answer, keeps no session, prompt on stdin', () => {
    expect(exec?.({ prompt: 'summarize', model: 'openai/gpt-5.5', systemPrompt: ' sys ' })).toEqual(
      {
        cmd: 'pi',
        args: ['-p', '--no-session', '--model', 'openai/gpt-5.5', '--append-system-prompt', 'sys'],
        stdin: 'summarize',
      },
    )
  })

  it('interactive launch: fresh sessions pin the caller-chosen id, resumes use --session', () => {
    expect(
      piManifest.launch({
        cwd: '/w',
        newSessionId: 'new-id',
        model: 'anthropic/claude-opus-4-8',
        effort: 'medium',
        initialPrompt: '- dashy prompt',
      }),
    ).toEqual({
      cmd: 'pi',
      args: [
        '--session-id',
        'new-id',
        '--model',
        'anthropic/claude-opus-4-8',
        '--thinking',
        'medium',
        '--',
        '- dashy prompt',
      ],
      cwd: '/w',
    })
    expect(
      piManifest.launch({ cwd: '/w', resume: { kind: 'pi-session', value: 'old-id' } }).args,
    ).toEqual(['--session', 'old-id'])
  })

  it('launch carries machine-authored instructions on the native system-prompt channel', () => {
    const spec = piManifest.launch({
      cwd: '/w',
      instructions: [{ source: 'issue', content: 'Work on POD-1.' }],
    })
    expect(spec.args).toContain('--append-system-prompt')
    expect(spec.args.at(-1)).toContain('Work on POD-1.')
  })

  it('identity probe accepts the coding agent and refuses another `pi`', () => {
    const probe = piManifest.inventory.executable.identityProbe
    expect(probe?.accepts('pi - AI coding assistant with read, bash, edit, write tools\n')).toBe(
      true,
    )
    expect(probe?.accepts('pi: raspberry pi utility\n')).toBe(false)
  })

  it('detects a login from auth.json provider entries; nothing on disk is unknown, not out', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-pi-manifest-'))
    expect(piManifest.inventory.detectLogin(home)).toEqual({ state: 'unknown' })

    const dir = join(home, '.pi', 'agent')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), '{}')
    expect(piManifest.inventory.detectLogin(home)).toEqual({ state: 'unknown' })

    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({
        openai: { type: 'api_key', key: 'sk-secret' },
        anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
        empty: {},
      }),
    )
    const login = piManifest.inventory.detectLogin(home)
    expect(login).toMatchObject({ state: 'in', account: 'anthropic, openai' })
    const identity = declaredValue(piManifest.inventory.loginIdentity)?.(home)
    expect(identity?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(identity)).not.toContain('sk-secret')

    // Re-authenticating changes the fingerprint.
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'sk-other' } }),
    )
    expect(declaredValue(piManifest.inventory.loginIdentity)?.(home)?.fingerprint).not.toBe(
      identity?.fingerprint,
    )
  })
})

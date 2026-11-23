import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testHarnessContext } from '../../driver/testing/harness-context.js'
import { declaredValue } from '../../manifest.js'
import { harnessSupportsCredentialPropagation } from '../../registry.js'
import { piManifest } from './index.js'

const piContext = testHarnessContext({ kind: 'pi' })

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
    })
    expect(spec).toEqual({
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
      ],
      stdin: 'first prompt',
    })
  })

  it('later turns resume through the same --session-id; project trust is the posture section', () => {
    const spec = buildExec?.({ prompt: 'go on', resumeValue: 'abc-123' })
    expect(spec?.args).toEqual(['-p', '--mode', 'json', '--session-id', 'abc-123'])
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
        harnessContext: piContext,
      }),
    ).toEqual({
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
      piManifest.launch({
        cwd: '/w',
        harnessContext: piContext,
        resume: { kind: 'pi-session', value: 'old-id' },
      }).args,
    ).toEqual(['--session', 'old-id'])
  })

  it('launch carries machine-authored instructions on the native system-prompt channel', () => {
    const spec = piManifest.launch({
      cwd: '/w',
      harnessContext: piContext,
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
    expect(piManifest.inventory.detectLogin(home, {})).toEqual({ state: 'unknown' })

    const dir = join(home, '.pi', 'agent')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), '{}')
    expect(piManifest.inventory.detectLogin(home, {})).toEqual({ state: 'unknown' })

    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({
        openai: { type: 'api_key', key: 'sk-secret' },
        anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
        empty: {},
      }),
    )
    const login = piManifest.inventory.detectLogin(home, {})
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
  it('declares auth.json for its home variable, follows PI_CODING_AGENT_DIR, and never copies it', async () => {
    const credentials = declaredValue(piManifest.credentials)
    expect(credentials?.files).toEqual([
      expect.objectContaining({
        kind: 'pi',
        dirName: '.pi/agent',
        fileName: 'auth.json',
        homeEnvVar: 'PI_CODING_AGENT_DIR',
        propagatable: false,
      }),
    ])
    expect(credentials?.files[0]?.validate('{"openai":{"type":"api_key","key":"k"}}')).toBe(true)
    expect(credentials?.files[0]?.validate('{"empty":{}}')).toBe(false)
    expect(credentials?.files[0]?.validate('not json')).toBe(false)

    // A login in a moved agent folder is read there, not in ~/.pi/agent.
    const home = await mkdtemp(join(tmpdir(), 'podium-pi-moved-'))
    const moved = join(home, 'podium-home')
    await mkdir(moved, { recursive: true })
    await writeFile(join(moved, 'auth.json'), '{"anthropic":{"type":"api_key","key":"k"}}')
    const env = { PI_CODING_AGENT_DIR: moved }
    expect(piManifest.inventory.detectLogin(home, {})).toEqual({ state: 'unknown' })
    expect(piManifest.inventory.detectLogin(home, env)).toMatchObject({
      state: 'in',
      account: 'anthropic',
    })
    expect(declaredValue(piManifest.inventory.loginIdentity)?.(home, env)?.providerAccountId).toBe(
      'anthropic',
    )
    expect(declaredValue(piManifest.inventory.portableCredential)).toBeUndefined()
    expect(harnessSupportsCredentialPropagation('pi')).toBe(false)
  })

  it('accepts passed-in provider keys only: no Pi login reaches a home of its own', () => {
    expect(piManifest.inventory.accepts.map((line) => line.deliver.kind)).toEqual([
      'env',
      'env',
      'env',
    ])
  })
})

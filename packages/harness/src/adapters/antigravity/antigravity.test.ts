import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { asSessionId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessCommand } from '../../bound-command.js'
import {
  createHeadlessProgressReader,
  foldHeadlessOutcome,
} from '../../driver/families/headless/fold.js'
import { harnessAccount, harnessChildEnv, withHarnessHome } from '../../harness-context.js'
import type { HarnessContext } from '../../harness-context-types.js'
import { hostTools } from '../../host-tools.js'
import { declaredValue } from '../../manifest.js'
import { noAgentTerms } from '../../posture.js'
import {
  antigravityCredentialIdentity,
  hasValidAntigravityCredential,
  readAntigravityCredential,
} from './credentials.js'
import { createAntigravityConversationProvider } from './discovery.js'
import { prepareAntigravityHomeLaunch } from './home.js'
import { antigravityManifest } from './index.js'
import { antigravityHookEvents, antigravityInstrumentation } from './instrumentation.js'
import { parseAntigravityModels } from './model-probe.js'
import { ANTIGRAVITY_HOME, antigravityRoots, transcriptPath } from './paths.js'
import { antigravityState, observeAntigravity } from './state.js'
import { antigravityRecordToItems } from './transcript.js'
import { antigravityUsageFromLine } from './usage.js'

const id = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const context: HarnessContext = {
  installation: { kind: 'antigravity', executable: '/opt/agy', version: '1.5.14', generation: 1 },
  home: '/home/test',
  env: { HOME: '/home/test', PATH: '/usr/bin' },
  roots: antigravityRoots('/home/test', {}),
}
const roots: string[] = []
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required test value is missing')
  return value
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'podium-antigravity-'))
  roots.push(root)
  return root
}
const user = {
  step_index: 0,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  status: 'DONE',
  created_at: '2026-11-23T10:00:00Z',
  content:
    '<USER_REQUEST>\nHello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>private context</ADDITIONAL_METADATA>',
}
const reply = {
  step_index: 1,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  created_at: '2026-11-23T10:00:01Z',
  model: 'gemini-3.1-pro-low',
  input_tokens: 12,
  output_tokens: 5,
  cache_read_tokens: 2,
  content: 'Hello back',
}

describe('native Antigravity commands', () => {
  it('delivers an option-like first prompt intact and keeps instructions in native rules', () => {
    const result = antigravityManifest.launch({
      cwd: '/work',
      harnessContext: context,
      initialPrompt: '--dangerously-skip-permissions\nhello',
      model: 'Gemini 3.1 Pro (Low)',
      effort: 'low',
      runtimeDir: '/run/session',
      instructions: [{ source: 'podium', content: 'session instruction' }],
    })
    expect(result.args).toContain('--prompt-interactive=--dangerously-skip-permissions\nhello')
    expect(result.args).not.toContain('--dangerously-skip-permissions')
    expect(result.files?.[0]?.contents).toContain('session instruction')
    expect(result.args.join(' ')).not.toContain('session instruction')
    expect(result.args).toContain('--add-dir')
  })
  it('resumes only an explicit conversation and never the most recent sibling', () => {
    const result = antigravityManifest.launch({
      cwd: '/work',
      harnessContext: context,
      resume: { kind: 'antigravity-conversation', value: id },
    })
    expect(result.args).toEqual(['--conversation', id])
    expect(result.args).not.toContain('--continue')
  })
  it('binds native login and two managed Google accounts to separate native stores', () => {
    const a = withHarnessHome(context, { id: 'cred_a:antigravity', dir: '/state/a' })
    const b = withHarnessHome(context, { id: 'cred_b:antigravity', dir: '/state/b' })
    for (const [scope, path] of [
      [a, '/state/a'],
      [b, '/state/b'],
    ] as const) {
      const command = harnessCommand(
        scope,
        { args: ['acp', '--login'] },
        noAgentTerms('native Google sign-in'),
      )
      expect(command.args).toEqual([
        '--gemini_dir',
        path,
        '--app_data_dir',
        'antigravity-cli',
        'acp',
        '--login',
      ])
      expect(command.env.SSH_CONNECTION).toBe('podium-managed-home')
      expect(scope.roots.state).toBe(join(path, 'antigravity-cli'))
      const child = harnessChildEnv(scope, {
        wiringEnv: command.env,
        sessionEnv: { [ANTIGRAVITY_HOME]: '/wrong' },
      })
      expect(child.env[ANTIGRAVITY_HOME]).toBe(path)
      expect(child.env.HOME).toBe('/home/test')
    }
    expect(
      harnessCommand(context, { args: ['models'] }, noAgentTerms('read the model catalog')).env
        .SSH_CONNECTION,
    ).toBeUndefined()
  })
  it('isolates named accounts and strips inherited Google billing credentials', () => {
    const scope = harnessAccount('antigravity', '/accounts/one', {
      HOME: '/home/test',
      PATH: '/usr/bin',
      GEMINI_API_KEY: 'inherited',
      AGY_ADC_AUTH: 'true',
      [ANTIGRAVITY_HOME]: '/operator',
    })
    expect(scope.env[ANTIGRAVITY_HOME]).toBe('/accounts/one/.gemini')
    expect(scope.env.GEMINI_API_KEY).toBeUndefined()
    expect(scope.env.AGY_ADC_AUTH).toBeUndefined()
    const child = harnessChildEnv(
      { ...scope, installation: context.installation },
      { sessionEnv: { GEMINI_API_KEY: 'chosen' } },
    )
    expect(child.env.GEMINI_API_KEY).toBe('chosen')
  })
  it('refuses a known older native CLI before launching', () => {
    expect(() =>
      harnessCommand(
        { ...context, installation: { ...context.installation, version: '1.0.0' } },
        { args: [] },
        noAgentTerms('verify native compatibility'),
      ),
    ).toThrow(/too old/)
  })
  it('uses structured stdin, session-local MCP and rules, and explicitly selects API-key auth', () => {
    const build = required(
      declaredValue(required(declaredValue(antigravityManifest.headless)).buildExec),
    )
    const result = build({
      prompt: '/model\n--evil',
      resumeValue: id,
      systemPrompt: 'hidden',
      runtimeDir: '/run/turn',
      credentialVariables: ['GEMINI_API_KEY'],
      mcpConfig: '{"mcpServers":{"podium":{"url":"http://127.0.0.1/mcp"}}}',
    })
    expect(JSON.parse(required(result.stdin))).toEqual({
      event: 'user',
      message: { content: '/model\n--evil' },
    })
    expect(result.args).toContain('--disable-slash-commands')
    expect(result.args).toContain('{"modelProvider":"gemini"}')
    expect(result.args.join(' ')).not.toContain('chosen')
    expect(result.args.join(' ')).not.toContain('hidden')
    expect(result.files).toHaveLength(2)
    expect(() => build({ prompt: 'hello', toolPolicy: 'none' })).toThrow(/all-tools-off/)
  })
  it('lists account-specific display names and filters auth chatter', () => {
    expect(
      parseAntigravityModels(
        'Available models:\nGemini 4 Neon (High)\nClaude Sonnet 4.6\nhttps://accounts.google.com\nError: signed out\n',
      ),
    ).toEqual([
      { value: 'Gemini 4 Neon (High)', label: 'Gemini 4 Neon (High)', efforts: ['high'] },
      { value: 'Claude Sonnet 4.6', label: 'Claude Sonnet 4.6' },
    ])
  })
})

describe('Antigravity stream completion', () => {
  const init = { event: 'init', conversation_id: id, init: { model: 'Gemini 3.1 Pro (Low)' } }
  const result = {
    event: 'result',
    result: { conversation_id: id, status: 'SUCCESS', response: 'Hello back' },
  }
  const fold = (events: unknown[]) =>
    foldHeadlessOutcome({
      outputFormat: 'antigravity-jsonl',
      stdout: events.map((event) => JSON.stringify(event)).join('\n'),
      stderrTail: '',
      exitCode: 0,
      agent: 'antigravity',
    })
  it('streams Unicode deltas and captures identity before the final result', () => {
    const events: unknown[] = []
    const reader = createHeadlessProgressReader('antigravity-jsonl', (event) => events.push(event))
    reader.line(JSON.stringify(init))
    for (const delta of ['Hello ', '世界'])
      reader.line(
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: id,
            step_index: 1,
            step_type: 'agent_response',
            text_delta: delta,
          },
        }),
      )
    expect(events[0]).toMatchObject({ harnessSessionId: id })
    expect(events.at(-1)).toMatchObject({ text: 'Hello 世界' })
    expect(fold([init, result])).toEqual({ harnessSessionId: id, output: 'Hello back' })
  })
  it('rejects a missing result, failed result, or partial timeout even after exit zero', () => {
    expect(() => fold([init])).toThrow(/without a result/)
    expect(() =>
      fold([
        init,
        {
          event: 'result',
          result: { conversation_id: id, status: 'ERROR', error: 'quota exhausted' },
        },
      ]),
    ).toThrow(/quota exhausted/)
    expect(() =>
      fold([
        init,
        { event: 'result', result: { ...result.result, finished_reason: 'print_timeout' } },
      ]),
    ).toThrow(/print_timeout/)
    try {
      fold([init])
    } catch (error) {
      expect(error).toHaveProperty('harnessSessionId', id)
    }
  })
})

describe('Google subscription identity', () => {
  const credential = (overrides = {}) =>
    JSON.stringify({
      auth_method: 'consumer',
      email: 'person@example.com',
      token: {
        access_token: 'access-a',
        refresh_token: 'refresh-a',
        expiry: '2000-01-01T00:00:00Z',
        ...overrides,
      },
    })
  it('keeps refreshable logins valid after access-token expiry and identity stable across refresh', () => {
    expect(hasValidAntigravityCredential(credential())).toBe(true)
    expect(antigravityCredentialIdentity(credential())).toEqual(
      antigravityCredentialIdentity(credential({ access_token: 'access-b' })),
    )
    expect(JSON.stringify(antigravityCredentialIdentity(credential()))).not.toContain('refresh-a')
  })
  it('refuses expired unrefreshable and malformed credentials', () => {
    expect(hasValidAntigravityCredential(credential({ refresh_token: '' }))).toBe(false)
    for (const raw of ['null', '[]', '{}', '{', '{"token":{}}'])
      expect(hasValidAntigravityCredential(raw)).toBe(false)
  })
  it('reads native keyrings through bounded account-scoped OS tools and never consults them for an isolated home', async () => {
    const root = await temp()
    const execFileSync = vi.fn(() => credential())
    const tools = { ...hostTools({}), execFileSync }
    const env = { PATH: '/account/bin' }
    if (['linux', 'darwin', 'win32'].includes(process.platform)) {
      expect(readAntigravityCredential(root, env, tools)).toBe(credential())
      expect(execFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ env, timeout: 5000, maxBuffer: expect.any(Number) }),
      )
    }
    execFileSync.mockClear()
    const isolated = { ...env, [ANTIGRAVITY_HOME]: join(root, 'managed') }
    expect(readAntigravityCredential(root, isolated, tools)).toBeUndefined()
    const token = join(isolated[ANTIGRAVITY_HOME], 'antigravity-cli', 'antigravity-oauth-token')
    await mkdir(dirname(token), { recursive: true })
    await writeFile(token, credential())
    expect(readAntigravityCredential(root, isolated, tools)).toBe(credential())
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

describe('native history and accounting', () => {
  it('pairs unambiguous native tool results and preserves failures and system messages', () => {
    const planner = {
      ...reply,
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pwd' } }],
    }
    const result = {
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      content: 'Command exited with code 0.\n\nCommand output:\n/work',
    }
    expect(antigravityRecordToItems(result, planner)[0]).toMatchObject({
      role: 'tool',
      toolName: 'run_command',
      toolUseId: 'agy:1:tool:0',
      toolExecution: { status: 'completed', exitCode: 0 },
      toolResult: expect.stringContaining('/work'),
    })
    expect(
      antigravityRecordToItems(
        { ...result, status: 'INVALID', content: 'invalid tool call' },
        planner,
      )[0],
    ).toMatchObject({ toolExecution: { status: 'failed' } })
    expect(
      antigravityRecordToItems(result, {
        ...planner,
        tool_calls: [...planner.tool_calls, ...planner.tool_calls],
      })[0]?.toolUseId,
    ).toBeUndefined()
    expect(
      antigravityRecordToItems({ ...result, type: 'SYSTEM_MESSAGE', source: 'SYSTEM' })[0]?.role,
    ).toBe('system')
  })
  it('unwraps only the visible user request and preserves tools without marking narration final', () => {
    expect(antigravityRecordToItems(user)[0]?.text).toBe('Hello')
    expect(antigravityRecordToItems(reply)[0]).toMatchObject({ role: 'assistant', answer: true })
    const items = antigravityRecordToItems({
      ...reply,
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pwd' } }],
    })
    expect(items[0]?.answer).toBeUndefined()
    expect(items[1]).toMatchObject({ toolName: 'run_command', toolUseId: 'agy:1:tool:0' })
    expect(antigravityRecordToItems(null)).toEqual([])
    expect(transcriptPath('/state', '../../other')).toBeUndefined()
    expect(antigravityUsageFromLine(JSON.stringify(reply))).toMatchObject({
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 2,
    })
    expect(antigravityUsageFromLine(JSON.stringify(user))).toBeNull()
  })
  it('discovers one full transcript, reads its native workspace, and preserves good records beside torn JSON', async () => {
    const root = await temp()
    const path = required(transcriptPath(root, id))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [JSON.stringify(user), JSON.stringify(reply), '{torn'].join('\n'))
    await writeFile(path.replace('transcript_full.jsonl', 'transcript.jsonl'), JSON.stringify(user))
    const db = openDatabase(join(root, 'conversation_summaries.db'))
    db.exec(
      'CREATE TABLE conversation_summaries(conversation_id TEXT, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT)',
    )
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run(
      id,
      'Native title',
      '["file:///work/repo"]',
      '',
    )
    db.close()
    const provider = createAntigravityConversationProvider()
    const scan = await provider.scanRoot(root)
    expect(scan.conversations).toHaveLength(1)
    expect(scan.conversations[0]).toMatchObject({
      id,
      title: 'Native title',
      projectPath: '/work/repo',
      resume: { value: id },
    })
    expect(scan.diagnostics).toHaveLength(1)
    const history = await provider.loadConversation(required(scan.conversations[0]))
    expect(history.messages.map((message) => message.content)).toEqual(['Hello', 'Hello back'])
    expect(history.diagnostics).toHaveLength(1)
  })
})

describe('native lifecycle observation', () => {
  it('finishes native Escape cancellation only with the idle composer visible', () => {
    const interrupted = '  ⎿ Interrupted · What should Antigravity CLI do instead?'
    expect(antigravityState.screen?.([interrupted, '> ', '? for shortcuts'])).toMatchObject({
      interactionVisible: false,
      events: [{ kind: 'turn_completed', verdict: { kind: 'interrupted' } }],
    })
    expect(
      antigravityState.screen?.([interrupted, '> new prompt', 'esc to cancel'])?.events,
    ).toEqual([])
  })
  it('recognizes the native permission modal without mistaking a tool log for approval', () => {
    expect(
      antigravityState.screen?.([
        'Requesting permission for:',
        '   printf safe',
        '',
        'Run this command?',
        '> 1. Yes, run command',
        '  4. No, cancel',
      ]),
    ).toMatchObject({
      interactionVisible: true,
      events: [{ kind: 'needs_user', need: 'permission', summary: 'printf safe' }],
    })
    expect(
      antigravityState.screen?.(['Running command: printf safe', 'Run this command?'])?.events,
    ).toEqual([])
  })
  it('surfaces native first-run setup and workspace trust as waiting for the person', () => {
    for (const screen of [
      'Choose your color scheme:',
      'Terms of Service & Data Use',
      'Yes, I trust this folder',
    ]) {
      expect(antigravityState.screen?.([screen])).toMatchObject({
        interactionVisible: true,
        events: [{ kind: 'needs_user', source: 'classifier' }],
      })
    }
  })
  it('does not finish on an intermediate stop or treat tool questions as completion', () => {
    expect(antigravityHookEvents({ hookEventName: 'Stop', fullyIdle: false })).toEqual([
      { kind: 'activity' },
    ])
    expect(antigravityHookEvents({ hookEventName: 'Stop' })).toEqual([])
    expect(
      antigravityHookEvents({
        hookEventName: 'PreToolUse',
        toolCall: { name: 'ask_question', args: { Question: 'Which file?' } },
      }),
    ).toMatchObject([{ kind: 'needs_user', need: 'question' }])
    expect(
      antigravityHookEvents({ hookEventName: 'Stop', fullyIdle: true, error: 'provider failed' }),
    ).toMatchObject([{ kind: 'turn_failed' }])
  })
  it('keeps late bookkeeping and foreign subagent conversations from rebinding a completed session', () => {
    const host = {
      onResumeValue: vi.fn(),
      tailFile: vi.fn(),
      onTitle: vi.fn(),
      onStateEvents: vi.fn(),
      onObservation: vi.fn(),
      onExactProviderRebind: vi.fn(),
      onTranscriptItems: vi.fn(),
    }
    const observer = observeAntigravity({ cwd: '/work', account: context, resumeValue: id }, host)
    observer.onHookPayload?.({ hookEventName: 'Stop', conversationId: id, fullyIdle: true })
    observer.onHookPayload?.({ hookEventName: 'PostToolUse', conversationId: id })
    observer.onHookPayload?.({ hookEventName: 'PreInvocation', conversationId: otherId })
    expect(host.onStateEvents).toHaveBeenCalledTimes(1)
    observer.onHookPayload?.({
      hookEventName: 'PreInvocation',
      conversationId: id,
      invocationNum: 0,
    })
    expect(host.onStateEvents).toHaveBeenCalledTimes(2)
    observer.stop()
  })
  it('installs hooks only in a session-owned customization workspace', async () => {
    const install = await antigravityInstrumentation.install({
      sessionId: asSessionId('session-a'),
      endpointUrl: 'http://127.0.0.1:9/hooks/test',
      settingsDir: '/run/session',
      harnessContext: context,
    })
    expect(install.args).toEqual(['--add-dir', '/run/session/antigravity-session-a'])
    expect(install.file?.path).toBe('/run/session/antigravity-session-a/.agents/hooks.json')
    expect(
      JSON.parse(required(install.file).contents)['podium-observer'].PreToolUse[0].hooks[0].command,
    ).toContain('"decision"')
    expect(install.file?.contents).not.toContain('auto_approve')
  })
})

describe('Google home configuration', () => {
  it('inherits customizations and UI preferences while keeping providers, projects and logins separate', async () => {
    const root = await temp()
    const defaultDir = join(root, 'person', '.gemini', 'antigravity-cli')
    const config = join(dirname(defaultDir), 'config')
    await mkdir(config, { recursive: true })
    await mkdir(defaultDir, { recursive: true })
    await writeFile(join(config, 'rules.json'), '{"entries":[]}')
    await writeFile(
      join(defaultDir, 'settings.json'),
      JSON.stringify({
        colorScheme: 'terminal',
        editorMode: 'vim',
        modelProvider: 'gemini',
        model: 'account-specific',
        customModels: { secret: 'private-key' },
      }),
    )
    const home = { harness: 'antigravity', dir: join(root, 'managed') }
    prepareAntigravityHomeLaunch(home, { defaultDir })
    expect(await readFile(join(home.dir, 'config', 'rules.json'), 'utf8')).toBe('{"entries":[]}')
    const settings = join(home.dir, 'antigravity-cli', 'settings.json')
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({
      colorScheme: 'terminal',
      editorMode: 'vim',
    })
    await writeFile(settings, '{"editorMode":"default"}')
    prepareAntigravityHomeLaunch(home, { defaultDir })
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ editorMode: 'default' })
  })
})

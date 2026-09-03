import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asAccountId } from '@podium/model'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { buildClaudeSdkOptions } from './claude-sdk-host.js'
import {
  buildHeadlessExec,
  HeadlessTurnError,
  headlessChildEnv,
  headlessSpawnEnv,
  runHeadlessTurn,
} from './headless-drivers.js'
import { testHarnessSnapshot } from './test-support/harness-snapshot.js'

const snapshot = testHarnessSnapshot()
const identity = {
  accountId: asAccountId('native:claude-code:test'),
  requestDigest: 'a'.repeat(64),
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buildHeadlessExec argv shapes', () => {
  it('reapplies the current system prompt when resuming a Claude SDK thread', () => {
    const options = buildClaudeSdkOptions({
      agent: 'claude-code',
      ...identity,
      cwd: '/repo',
      prompt: 'Why?',
      systemPrompt: 'NORMAL: HARD LIMIT 80 words total',
      contextPrompt: 'current context',
      resumeValue: 'claude-thread-1',
    })

    expect(options.resume).toBe('claude-thread-1')
    expect(options).not.toHaveProperty('sessionId')
    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'NORMAL: HARD LIMIT 80 words total\n\ncurrent context',
    })
  })

  it('makes structured permission prompts authoritative without overriding explicit policy', () => {
    const canUseTool = vi.fn()
    const structured = buildClaudeSdkOptions(
      {
        agent: 'claude-code',
        ...identity,
        cwd: '/repo',
        prompt: 'change a guarded file',
        structuredPermissions: true,
      },
      canUseTool,
    )

    expect(structured.permissionMode).toBe('default')
    expect(structured.canUseTool).toBe(canUseTool)
    expect(structured).not.toHaveProperty('allowDangerouslySkipPermissions')

    const explicitlyAuthorized = buildClaudeSdkOptions(
      {
        agent: 'claude-code',
        ...identity,
        cwd: '/repo',
        prompt: 'change a guarded file',
        structuredPermissions: true,
        permissionMode: 'auto',
      },
      canUseTool,
    )
    expect(explicitlyAuthorized.permissionMode).toBe('auto')

    const legacyUnstructured = buildClaudeSdkOptions({
      agent: 'claude-code',
      ...identity,
      cwd: '/repo',
      prompt: 'change a guarded file',
    })
    expect(legacyUnstructured.permissionMode).toBe('auto')
  })

  it('enforces a native no-tools posture and refuses unsupported adapters', () => {
    const options = buildClaudeSdkOptions({
      agent: 'claude-code',
      ...identity,
      cwd: '/repo',
      prompt: 'repair',
      toolPolicy: 'none',
      mcpConfig: JSON.stringify({ mcpServers: { podium: { url: 'http://podium.invalid' } } }),
    })
    expect(options.tools).toEqual([])
    expect(options.allowedTools).toEqual([])
    expect(options.settingSources).toEqual([])
    expect(options).not.toHaveProperty('mcpServers')

    expect(() =>
      runHeadlessTurn(
        { agent: 'codex', ...identity, cwd: '/repo', prompt: 'repair', toolPolicy: 'none' },
        () => {},
        snapshot,
      ),
    ).toThrow(/cannot enforce a no-tools headless turn/)
  })

  it('removes inherited account overrides while preserving a managed credential', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-daemon-key')
    vi.stubEnv('OPENAI_API_KEY', 'inherited-openai-key')

    const claude = buildClaudeSdkOptions({
      agent: 'claude-code',
      ...identity,
      cwd: '/repo',
      prompt: 'repair',
      toolPolicy: 'none',
      env: { HOME: '/accounts/claude' },
    })
    expect(claude.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(claude.env).toMatchObject({ HOME: '/accounts/claude' })

    const codex = headlessChildEnv('codex', { HOME: '/accounts/codex' })
    expect(codex).not.toHaveProperty('OPENAI_API_KEY')

    const managed = headlessChildEnv('claude-code', {
      HOME: '/accounts/managed',
      ANTHROPIC_API_KEY: 'server-selected-key',
    })
    expect(managed).toMatchObject({
      HOME: '/accounts/managed',
      ANTHROPIC_API_KEY: 'server-selected-key',
    })

    const subscription = headlessChildEnv('claude-code', {
      HOME: '/accounts/claude-oauth',
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-test-1',
    })
    expect(subscription).toMatchObject({
      HOME: '/accounts/claude-oauth',
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-test-1',
    })
    expect(subscription).not.toHaveProperty('ANTHROPIC_API_KEY')
  })
  it('codex first turn: exec --json with positional prompt, no resume subcommand', () => {
    const { cmd, args } = buildHeadlessExec('codex', { prompt: 'hi there' }, snapshot)
    expect(cmd).toBe('/opt/codex')
    expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', 'hi there'])
  })

  it('codex resume turn: `exec resume <id>` subcommand before flags', () => {
    const { args } = buildHeadlessExec(
      'codex',
      { prompt: 'go on', resumeValue: '019f-abc', model: 'gpt-5.2-codex' },
      snapshot,
    )
    expect(args).toEqual([
      'exec',
      'resume',
      '019f-abc',
      '--json',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.2-codex',
      'go on',
    ])
  })

  it('codex effort rides a -c model_reasoning_effort override', () => {
    const { args } = buildHeadlessExec('codex', { prompt: 'p', effort: 'low' }, snapshot)
    expect(args).toContain('-c')
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="low"')
  })

  it('codex MCP config becomes -c TOML overrides and a bad config throws', () => {
    const mcpConfig = JSON.stringify({
      mcpServers: { podium: { url: 'http://127.0.0.1:1/mcp', headers: { 'x-a': 'b' } } },
    })
    const { args } = buildHeadlessExec('codex', { prompt: 'p', mcpConfig }, snapshot)
    expect(args).toContain('mcp_servers."podium".url="http://127.0.0.1:1/mcp"')
    expect(args).toContain('mcp_servers."podium".http_headers={"x-a"="b"}')
    expect(() => buildHeadlessExec('codex', { prompt: 'p', mcpConfig: '{oops' }, snapshot)).toThrow(
      /malformed MCP config/,
    )
  })

  it('codex routes the MCP auth token to a bearer env var, not argv (POD-1021)', () => {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        podium: {
          url: 'http://127.0.0.1:1/mcp',
          headers: { 'x-podium-mcp-token': 'sekret', 'x-podium-mcp-thread': 'thr' },
        },
      },
    })
    const { args, env } = buildHeadlessExec('codex', { prompt: 'p', mcpConfig }, snapshot)
    expect(args).toContain('mcp_servers."podium".bearer_token_env_var="PODIUM_MCP_BEARER_PODIUM"')
    expect(env).toMatchObject({ PODIUM_MCP_BEARER_PODIUM: 'sekret' })
    expect(args).toContain('mcp_servers."podium".http_headers={"x-podium-mcp-thread"="thr"}')
    // The token never leaks into argv.
    expect(args.some((a) => a.includes('sekret'))).toBe(false)
  })

  it('grok: options precede --single so its required prompt is consumed correctly', () => {
    const { cmd, args } = buildHeadlessExec(
      'grok',
      { prompt: 'hello', sessionId: 'uuid-1', model: 'grok-4' },
      snapshot,
    )
    expect(cmd).toBe('/opt/grok')
    expect(args).toEqual(['--session-id', 'uuid-1', '--model', 'grok-4', '--single', 'hello'])
    const resumed = buildHeadlessExec('grok', { prompt: 'again', resumeValue: 'uuid-1' }, snapshot)
    expect(resumed.args).toEqual(['--resume', 'uuid-1', '--single', 'again'])
  })

  it('refuses Grok repair turns because hook/config isolation is not proven', () => {
    expect(() =>
      runHeadlessTurn(
        { agent: 'grok', ...identity, cwd: '/repo', prompt: 'repair', toolPolicy: 'none' },
        () => {},
        snapshot,
      ),
    ).toThrow(/cannot enforce a no-tools headless turn/)
  })

  it('pi: pinned --session-id on every turn, prompt on stdin, JSON event stream', () => {
    const first = buildHeadlessExec(
      'pi',
      { prompt: 'hello', sessionId: 'uuid-1', model: 'openai/gpt-5.5', effort: 'high' },
      snapshot,
    )
    expect(first.cmd).toBe('/opt/pi')
    expect(first.args).toEqual([
      '-p',
      '--mode',
      'json',
      '--session-id',
      'uuid-1',
      '--model',
      'openai/gpt-5.5',
      '--thinking',
      'high',
      '--no-approve',
    ])
    expect(first.stdin).toBe('hello')
    const resumed = buildHeadlessExec('pi', { prompt: 'again', resumeValue: 'uuid-1' }, snapshot)
    expect(resumed.args).toEqual(['-p', '--mode', 'json', '--session-id', 'uuid-1', '--no-approve'])
  })

  it('pi: a repair turn is accepted and runs tool-less', () => {
    const { args } = buildHeadlessExec(
      'pi',
      { prompt: 'repair', sessionId: 'uuid-1', toolPolicy: 'none' },
      snapshot,
    )
    expect(args).toContain('--no-tools')
    expect(args).toContain('--no-extensions')
  })

  it('opencode: forwards model and variant on first and resumed turns', () => {
    const first = buildHeadlessExec(
      'opencode',
      { prompt: 'hi', model: 'opencode/deepseek-v4-flash-free', effort: 'high' },
      snapshot,
    )
    expect(first.cmd).toBe('/opt/opencode')
    expect(first.args).toEqual([
      'run',
      '--format',
      'json',
      '-m',
      'opencode/deepseek-v4-flash-free',
      '--variant',
      'high',
      'hi',
    ])
    const resumed = buildHeadlessExec(
      'opencode',
      { prompt: 'go on', resumeValue: 'ses_1', effort: 'max' },
      snapshot,
    )
    expect(resumed.args).toEqual([
      'run',
      '--format',
      'json',
      '-s',
      'ses_1',
      '--variant',
      'max',
      'go on',
    ])
  })

  it('cursor: pins Auto unless a named model overrides it', () => {
    const { cmd, args } = buildHeadlessExec(
      'cursor',
      { prompt: 'hi', sessionId: 'chat-1' },
      snapshot,
    )
    expect(cmd).toBe('/opt/cursor-agent')
    expect(args).toEqual(['-p', '--resume', 'chat-1', '--model', 'auto', 'hi'])
    const named = buildHeadlessExec(
      'cursor',
      { prompt: 'hi', sessionId: 'chat-1', model: 'composer-2.5' },
      snapshot,
    )
    expect(named.args).toContain('composer-2.5')
    expect(named.args).not.toContain('auto')
  })

  it('uses Grok native rules and auto permission mode without polluting the prompt', () => {
    const { args } = buildHeadlessExec(
      'grok',
      {
        prompt: 'task',
        systemPrompt: 'orchestrate',
        contextPrompt: 'repo context',
        permissionMode: 'auto',
        sessionId: 'u',
      },
      snapshot,
    )
    expect(args).toContain('--rules')
    expect(args[args.indexOf('--rules') + 1]).toBe('orchestrate\n\nrepo context')
    expect(args).toContain('--permission-mode')
    expect(args.at(-1)).toBe('task')
  })

  it('uses Codex developer instructions without polluting the user prompt', () => {
    const { args } = buildHeadlessExec(
      'codex',
      { prompt: 'task', systemPrompt: 'orchestrate', contextPrompt: 'repo context' },
      snapshot,
    )
    expect(args).toContain('developer_instructions="orchestrate\\n\\nrepo context"')
    expect(args.at(-1)).toBe('task')
  })

  it("model 'auto' means no model flag", () => {
    const { args } = buildHeadlessExec(
      'grok',
      { prompt: 'p', sessionId: 'u', model: 'auto' },
      snapshot,
    )
    expect(args).not.toContain('--model')
  })
})

describe('headlessSpawnEnv', () => {
  // POD-3059. `bindHarnessExec` folds the machine command environment into every
  // adapter's exec env, so `execEnv` carries the OPERATOR `HOME` even when the
  // adapter only meant to contribute a bearer token. Letting it win reverted the
  // child to the operator account home; on a named instance the harness then
  // wrote its transcript where the reader does not look, and `sessions.read`
  // answered empty for every item type.
  const commandEnv = { PATH: '/opt:/usr/bin:/bin', HOME: '/home/operator' }

  it('keeps the instance HOME when the adapter env carries the machine HOME', () => {
    const env = headlessSpawnEnv({
      specEnv: { ...commandEnv, HOME: '/state/blue/agent-home', PODIUM_SESSION_ID: 's1' },
      execEnv: { ...commandEnv, PODIUM_MCP_BEARER_PODIUM: 'sekret' },
      commandEnv,
    })
    expect(env.HOME).toBe('/state/blue/agent-home')
    // ...and the adapter's own per-turn key still reaches the child (POD-1021).
    expect(env.PODIUM_MCP_BEARER_PODIUM).toBe('sekret')
    expect(env.PODIUM_SESSION_ID).toBe('s1')
  })

  it('lets an adapter override a key the instance did not decide', () => {
    // PATH is the command environment's own value in specEnv — the instance
    // never chose it — so an adapter that resolved a different one still wins.
    const env = headlessSpawnEnv({
      specEnv: { ...commandEnv, HOME: '/state/blue/agent-home' },
      execEnv: { PATH: '/adapter/bin' },
      commandEnv,
    })
    expect(env.PATH).toBe('/adapter/bin')
    expect(env.HOME).toBe('/state/blue/agent-home')
  })

  it('falls back to the command environment when no child environment was supplied', () => {
    expect(headlessSpawnEnv({ execEnv: { X: '1' }, commandEnv })).toEqual({ ...commandEnv, X: '1' })
  })
})

/**
 * The pi driver end to end against a stand-in `pi`: a shell script that speaks
 * pi 0.84.4's verified `--mode json` stream. Proves the prompt reaches stdin,
 * the pinned id is honoured, partial text and tool status stream out, and an
 * in-turn provider error becomes a HeadlessTurnError despite exit 0.
 */
describe('pi driver against a stand-in binary', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  function fakePi(): string {
    const dir = mkdtempSync(join(tmpdir(), 'podium-fake-pi-'))
    dirs.push(dir)
    const script = join(dir, 'pi')
    writeFileSync(
      script,
      `#!/bin/sh
sid=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--session-id" ]; then shift; sid="$1"; fi
  shift
done
prompt=$(cat)
# JSON-escape the echoed prompt (newlines only; the fixture has no quotes).
prompt=$(printf '%s' "$prompt" | sed ':a;N;$!ba;s/\\n/\\\\n/g')
printf '%s\\n' "{\\"type\\":\\"session\\",\\"version\\":3,\\"id\\":\\"$sid\\",\\"timestamp\\":\\"2026-09-02T09:48:46.898Z\\",\\"cwd\\":\\"/w\\"}"
printf '%s\\n' '{"type":"agent_start"}'
printf '%s\\n' '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending","responseId":"r1"}}'
case "$prompt" in
  *FAIL*)
    printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"500: simulated provider outage"}}'
    printf '%s\\n' '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"500: simulated provider outage"}'
    ;;
  *)
    printf '%s\\n' '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls"}}'
    printf '%s\\n' '{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Echo: "}}'
    printf '%s\\n' "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Echo: $prompt\\"}],\\"stopReason\\":\\"stop\\"}}"
    ;;
esac
printf '%s\\n' '{"type":"agent_settled"}'
exit 0
`,
    )
    chmodSync(script, 0o755)
    return script
  }

  it('delivers the prompt on stdin, keeps the pinned id, streams partial text and tool status', async () => {
    const piSnapshot = testHarnessSnapshot({ pi: fakePi() })
    const events: HeadlessTurnEvent[] = []
    const handle = runHeadlessTurn(
      {
        agent: 'pi',
        ...identity,
        cwd: tmpdir(),
        prompt: 'multi\nline prompt',
        sessionUuid: '9e804279-978a-4644-adc4-f815f25a5728',
      },
      (event) => events.push(event),
      piSnapshot,
    )
    const outcome = await handle.done
    expect(outcome).toEqual({
      harnessSessionId: '9e804279-978a-4644-adc4-f815f25a5728',
      output: 'Echo: multi\nline prompt',
    })
    expect(events).toContainEqual({ kind: 'status', status: 'tool', label: 'bash' })
    expect(events).toContainEqual({ kind: 'partial-text', text: 'Echo: ', itemHint: 'r1' })
    expect(events.at(-1)).toEqual({
      kind: 'partial-text',
      text: 'Echo: multi\nline prompt',
      itemHint: 'r1',
    })
  })

  it('an in-turn provider error fails the turn WITH its session id, despite exit 0', async () => {
    const piSnapshot = testHarnessSnapshot({ pi: fakePi() })
    const handle = runHeadlessTurn(
      { agent: 'pi', ...identity, cwd: tmpdir(), prompt: 'please FAIL', resumeValue: 'resumed-1' },
      () => {},
      piSnapshot,
    )
    const error = await handle.done.then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(HeadlessTurnError)
    expect((error as HeadlessTurnError).message).toBe('500: simulated provider outage')
    expect((error as HeadlessTurnError).harnessSessionId).toBe('resumed-1')
  })
})

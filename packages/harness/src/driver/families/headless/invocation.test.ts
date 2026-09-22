/**
 * WHAT A HEADLESS TURN RUNS (POD-4614). The argv suite moved from
 * apps/daemon/src/headless-drivers.test.ts with the builder it pins; the
 * composition cases below are new with the one merged invocation shape.
 */
import { asAccountId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  assertHeadlessToolPolicy,
  buildHeadlessExec,
  composeHeadlessInvocation,
} from './invocation.js'
import { testHarnessSnapshot } from './test-support.js'

const snapshot = testHarnessSnapshot()
const identity = {
  accountId: asAccountId('native:claude-code:test'),
  requestDigest: 'a'.repeat(64),
}

describe('buildHeadlessExec argv shapes', () => {
  it('refuses a no-tools turn for adapters without a native all-tools-off mechanism', () => {
    expect(() =>
      assertHeadlessToolPolicy({
        agent: 'codex',
        ...identity,
        cwd: '/repo',
        prompt: 'repair',
        toolPolicy: 'none',
      }),
    ).toThrow(/cannot enforce a no-tools headless turn/)
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
      composeHeadlessInvocation(
        { agent: 'grok', ...identity, cwd: '/repo', prompt: 'repair', toolPolicy: 'none' },
        snapshot,
        { isRoot: false },
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

describe('composeHeadlessInvocation', () => {
  const base = { ...identity, cwd: '/repo', prompt: 'the prompt' }

  it('claude: a bounded `claude -p` run with the prompt on stdin, pinned to the minted session', () => {
    const invocation = composeHeadlessInvocation(
      { agent: 'claude-code', ...base, sessionUuid: 'u-1' },
      snapshot,
      { isRoot: false },
    )
    expect(invocation.cmd).toBe('/opt/claude')
    expect(invocation.args.slice(0, 4)).toEqual(['-p', '--verbose', '--output-format', 'stream-json'])
    expect(invocation.args).toContain('--session-id')
    expect(invocation.stdin).toEqual({ kind: 'bytes', data: 'the prompt' })
    expect(invocation.pinnedSessionId).toBe('u-1')
  })

  it('claude: MCP rides argv as inline JSON — no staged file outlives the turn', () => {
    const mcpConfig = JSON.stringify({
      mcpServers: { podium: { url: 'http://127.0.0.1:1/mcp', headers: { 'x-a': 'b' } } },
    })
    const { args } = composeHeadlessInvocation(
      { agent: 'claude-code', ...base, mcpConfig },
      snapshot,
      { isRoot: false },
    )
    const inline = args[args.indexOf('--mcp-config') + 1] as string
    expect(JSON.parse(inline)).toEqual({
      mcpServers: { podium: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { 'x-a': 'b' } } },
    })
  })

  it('claude: a tool-less turn mounts no MCP at all', () => {
    const { args } = composeHeadlessInvocation(
      {
        agent: 'claude-code',
        ...base,
        toolPolicy: 'none',
        mcpConfig: JSON.stringify({ mcpServers: { p: { url: 'http://x' } } }),
      },
      snapshot,
      { isRoot: false },
    )
    expect(args).not.toContain('--mcp-config')
    expect(args).toContain('--tools')
  })

  it('claude: a structured turn is the stream-json conversation with a live stdin', () => {
    const invocation = composeHeadlessInvocation(
      { agent: 'claude-code', ...base, structuredPermissions: true, resumeValue: 'r-1' },
      snapshot,
      { isRoot: false },
    )
    expect(invocation.args).toContain('--input-format')
    expect(invocation.args).toContain('--permission-prompt-tool')
    expect(invocation.stdin).toEqual({ kind: 'live' })
    expect(invocation.pinnedSessionId).toBe('r-1')
  })

  it('codex: stdin closed at once, the MCP bearer as per-invocation env, no pin on a first turn', () => {
    const invocation = composeHeadlessInvocation(
      {
        agent: 'codex',
        ...base,
        mcpConfig: JSON.stringify({
          mcpServers: { podium: { url: 'http://x', headers: { 'x-podium-mcp-token': 't' } } },
        }),
      },
      snapshot,
      { isRoot: false },
    )
    expect(invocation.stdin).toEqual({ kind: 'none' })
    expect(invocation.execEnv).toMatchObject({ PODIUM_MCP_BEARER_PODIUM: 't' })
    expect(invocation.pinnedSessionId).toBeUndefined()
  })

  it("resume-exec: the server's pre-minted id wins (POD-782), and pi's prompt rides stdin", () => {
    const invocation = composeHeadlessInvocation(
      { agent: 'pi', ...base, sessionUuid: 'minted-by-server' },
      snapshot,
      { isRoot: false },
    )
    expect(invocation.pinnedSessionId).toBe('minted-by-server')
    expect(invocation.args).toContain('minted-by-server')
    expect(invocation.stdin).toEqual({ kind: 'bytes', data: 'the prompt' })
  })

  it('cursor: refuses to run without the allocated chat id, and pins to it once allocated', () => {
    expect(() =>
      composeHeadlessInvocation({ agent: 'cursor', ...base }, snapshot, { isRoot: false }),
    ).toThrow(/allocated conversation id/)
    const invocation = composeHeadlessInvocation({ agent: 'cursor', ...base }, snapshot, {
      allocated: 'chat-9',
      isRoot: false,
    })
    expect(invocation.pinnedSessionId).toBe('chat-9')
    expect(invocation.args).toEqual(['-p', '--resume', 'chat-9', '--model', 'auto', 'the prompt'])
  })
})

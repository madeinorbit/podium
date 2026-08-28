import { asAccountId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildClaudeSdkOptions } from './claude-sdk-host.js'
import { buildHeadlessExec, headlessChildEnv, runHeadlessTurn } from './headless-drivers.js'
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
    expect(env).toEqual({ PODIUM_MCP_BEARER_PODIUM: 'sekret' })
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

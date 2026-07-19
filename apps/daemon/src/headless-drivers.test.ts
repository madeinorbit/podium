import { describe, expect, it } from 'vitest'
import type { HarnessBins } from './harness-exec.js'
import { buildHeadlessExec } from './headless-drivers.js'

const bins: HarnessBins = { opencode: () => '/opt/opencode', cursor: () => '/opt/cursor-agent' }

describe('buildHeadlessExec argv shapes', () => {
  it('codex first turn: exec --json with positional prompt, no resume subcommand', () => {
    const { cmd, args } = buildHeadlessExec('codex', { prompt: 'hi there' }, bins)
    expect(cmd).toBe('codex')
    expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', 'hi there'])
  })

  it('codex resume turn: `exec resume <id>` subcommand before flags', () => {
    const { args } = buildHeadlessExec(
      'codex',
      { prompt: 'go on', resumeValue: '019f-abc', model: 'gpt-5.2-codex' },
      bins,
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
    const { args } = buildHeadlessExec('codex', { prompt: 'p', effort: 'low' }, bins)
    expect(args).toContain('-c')
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="low"')
  })

  it('codex MCP config becomes -c TOML overrides and a bad config throws', () => {
    const mcpConfig = JSON.stringify({
      mcpServers: { podium: { url: 'http://127.0.0.1:1/mcp', headers: { 'x-a': 'b' } } },
    })
    const { args } = buildHeadlessExec('codex', { prompt: 'p', mcpConfig }, bins)
    expect(args).toContain('mcp_servers."podium".url="http://127.0.0.1:1/mcp"')
    expect(args).toContain('mcp_servers."podium".http_headers={"x-a"="b"}')
    expect(() => buildHeadlessExec('codex', { prompt: 'p', mcpConfig: '{oops' }, bins)).toThrow(
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
    const { args, env } = buildHeadlessExec('codex', { prompt: 'p', mcpConfig }, bins)
    expect(args).toContain('mcp_servers."podium".bearer_token_env_var="PODIUM_MCP_BEARER_PODIUM"')
    expect(env).toEqual({ PODIUM_MCP_BEARER_PODIUM: 'sekret' })
    expect(args).toContain('mcp_servers."podium".http_headers={"x-podium-mcp-thread"="thr"}')
    // The token never leaks into argv.
    expect(args.some((a) => a.includes('sekret'))).toBe(false)
  })

  it('grok: -p with the pinned --session-id (create-or-resume) and positional prompt', () => {
    const { cmd, args } = buildHeadlessExec(
      'grok',
      { prompt: 'hello', sessionId: 'uuid-1', model: 'grok-4' },
      bins,
    )
    expect(cmd).toBe('grok')
    expect(args).toEqual(['-p', '--session-id', 'uuid-1', '--model', 'grok-4', 'hello'])
  })

  it('opencode: run --format json, -s only when resuming', () => {
    const first = buildHeadlessExec('opencode', { prompt: 'hi' }, bins)
    expect(first.cmd).toBe('/opt/opencode')
    expect(first.args).toEqual(['run', '--format', 'json', 'hi'])
    const resumed = buildHeadlessExec('opencode', { prompt: 'hi', resumeValue: 'ses_1' }, bins)
    expect(resumed.args).toEqual(['run', '--format', 'json', '-s', 'ses_1', 'hi'])
  })

  it('cursor: -p --resume <chatId> with positional prompt', () => {
    const { cmd, args } = buildHeadlessExec('cursor', { prompt: 'hi', sessionId: 'chat-1' }, bins)
    expect(cmd).toBe('/opt/cursor-agent')
    expect(args).toEqual(['-p', '--resume', 'chat-1', 'hi'])
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
      bins,
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
      bins,
    )
    expect(args).toContain('developer_instructions="orchestrate\\n\\nrepo context"')
    expect(args.at(-1)).toBe('task')
  })

  it("model 'auto' means no model flag", () => {
    const { args } = buildHeadlessExec('grok', { prompt: 'p', sessionId: 'u', model: 'auto' }, bins)
    expect(args).not.toContain('--model')
  })
})

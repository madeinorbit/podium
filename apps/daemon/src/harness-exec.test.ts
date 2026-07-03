import { describe, expect, it } from 'vitest'
import { buildHarnessExec, type HarnessBins } from './harness-exec.js'

const bins: HarnessBins = { opencode: () => '/bin/opencode', cursor: () => '/bin/agent' }

describe('buildHarnessExec', () => {
  it('injects the system prompt via --append-system-prompt for Claude (prompt unchanged)', () => {
    const { cmd, args } = buildHarnessExec(
      'claude-code',
      { prompt: 'list my sessions', systemPrompt: 'You are Podium.' },
      bins,
    )
    expect(cmd).toBe('claude')
    const i = args.indexOf('--append-system-prompt')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('You are Podium.')
    expect(args).toContain('list my sessions') // not prepended into the prompt
    expect(args.at(-1)).toBe('list my sessions')
  })

  it('prepends the system prompt for agents without a native flag (grok)', () => {
    const { cmd, args } = buildHarnessExec(
      'grok',
      { prompt: 'do the thing', systemPrompt: 'SYS' },
      bins,
    )
    expect(cmd).toBe('grok')
    expect(args).not.toContain('--append-system-prompt')
    expect(args.at(-1)).toBe('SYS\n\n---\n\ndo the thing')
  })

  it('omits the model flag when model is auto or unset', () => {
    expect(
      buildHarnessExec('claude-code', { prompt: 'p', model: 'auto' }, bins).args,
    ).not.toContain('--model')
    expect(buildHarnessExec('grok', { prompt: 'p' }, bins).args).not.toContain('--model')
  })

  it('passes the model flag when set', () => {
    const { args } = buildHarnessExec('claude-code', { prompt: 'p', model: 'opus' }, bins)
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('opus')
  })

  it('wires --mcp-config and --allowedTools for Claude', () => {
    const { args } = buildHarnessExec(
      'claude-code',
      {
        prompt: 'go',
        mcpConfigPath: '/tmp/mcp.json',
        allowedTools: ['Read', 'mcp__podium__list_sessions'],
      },
      bins,
    )
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,mcp__podium__list_sessions')
    expect(args.at(-1)).toBe('go')
  })

  it('ignores mcp args for agents without MCP mounting (grok)', () => {
    const { args } = buildHarnessExec(
      'grok',
      { prompt: 'go', mcpConfigPath: '/tmp/mcp.json', mcpConfig: '{}', allowedTools: ['Read'] },
      bins,
    )
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--allowedTools')
    expect(args).not.toContain('-c')
  })

  it('translates the MCP config into codex -c overrides (url + http_headers)', () => {
    const { cmd, args } = buildHarnessExec(
      'codex',
      {
        prompt: 'go',
        mcpConfig: JSON.stringify({
          mcpServers: {
            podium: {
              type: 'http',
              url: 'http://127.0.0.1:1878/mcp',
              headers: { 'x-podium-mcp-token': 'tok', 'x-podium-mcp-thread': 'thr' },
            },
          },
        }),
        allowedTools: ['Read'],
      },
      bins,
    )
    expect(cmd).toBe('codex')
    expect(args[0]).toBe('exec')
    expect(args).toContain('mcp_servers.podium.url="http://127.0.0.1:1878/mcp"')
    expect(args).toContain(
      'mcp_servers.podium.http_headers={"x-podium-mcp-token"="tok","x-podium-mcp-thread"="thr"}',
    )
    // No allowedTools flag on codex — MCP tools run without an approval flag.
    expect(args).not.toContain('--allowedTools')
    expect(args.at(-1)).toBe('go')
  })

  it('codex without an MCP config stays a plain exec (chat-only)', () => {
    const { args } = buildHarnessExec('codex', { prompt: 'p' }, bins)
    expect(args).toEqual(['exec', '--skip-git-repo-check', 'p'])
  })

  it('codex tolerates a malformed MCP config by omitting the overrides', () => {
    const { args } = buildHarnessExec('codex', { prompt: 'p', mcpConfig: 'not json' }, bins)
    expect(args).not.toContain('-c')
  })

  it('resolves opencode/cursor bins and uses their run flags', () => {
    expect(buildHarnessExec('opencode', { prompt: 'p' }, bins)).toEqual({
      cmd: '/bin/opencode',
      args: ['run', 'p'],
    })
    expect(buildHarnessExec('cursor', { prompt: 'p' }, bins).cmd).toBe('/bin/agent')
  })
})

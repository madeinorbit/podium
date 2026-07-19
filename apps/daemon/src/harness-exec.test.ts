import { describe, expect, it } from 'vitest'
import { buildHarnessExec, type HarnessBins } from './harness-exec.js'

const bins: HarnessBins = { opencode: () => '/bin/opencode', cursor: () => '/bin/agent' }

describe('buildHarnessExec', () => {
  it('injects the system prompt via --append-system-prompt for Claude (prompt on stdin)', () => {
    const { cmd, args, stdin } = buildHarnessExec(
      'claude-code',
      { prompt: 'list my sessions', systemPrompt: 'You are Podium.' },
      bins,
    )
    expect(cmd).toBe('claude')
    const i = args.indexOf('--append-system-prompt')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('You are Podium.')
    // The prompt rides stdin, never argv: --allowedTools is variadic and would
    // eat a trailing positional (live #84 incident), and argv has ARG_MAX.
    expect(stdin).toBe('list my sessions')
    expect(args).not.toContain('list my sessions')
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

  it('wires --mcp-config and --allowedTools for Claude, prompt via stdin', () => {
    const { args, stdin } = buildHarnessExec(
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
    // Regression (#84 live): variadic --allowedTools must be the FINAL argv
    // entry — any trailing positional would be swallowed as junk tool rules.
    expect(args.at(-1)).toBe('Read,mcp__podium__list_sessions')
    expect(stdin).toBe('go')
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

  it('translates the MCP config into codex -c overrides (url + bearer env + identity http_headers)', () => {
    const { cmd, args, env } = buildHarnessExec(
      'codex',
      {
        prompt: 'go',
        mcpConfig: JSON.stringify({
          mcpServers: {
            podium: {
              type: 'http',
              url: 'http://127.0.0.1:1878/mcp',
              headers: { 'x-podium-mcp-token': 'sekretval', 'x-podium-mcp-thread': 'thr' },
            },
          },
        }),
        allowedTools: ['Read'],
      },
      bins,
    )
    expect(cmd).toBe('codex')
    expect(args[0]).toBe('exec')
    expect(args).toContain('mcp_servers."podium".url="http://127.0.0.1:1878/mcp"')
    // Auth token is declared as a first-class bearer_token_env_var (POD-1021),
    // NOT smuggled as an http_header — otherwise codex 0.144.5's rmcp client
    // attempts OAuth and dies with Auth(AuthorizationRequired).
    expect(args).toContain('mcp_servers."podium".bearer_token_env_var="PODIUM_MCP_BEARER_PODIUM"')
    expect(env).toEqual({ PODIUM_MCP_BEARER_PODIUM: 'sekretval' })
    // Non-auth identity headers still ride http_headers.
    expect(args).toContain('mcp_servers."podium".http_headers={"x-podium-mcp-thread"="thr"}')
    // The auth token value must never appear in argv.
    expect(args.some((a) => a.includes('x-podium-mcp-token'))).toBe(false)
    expect(args.some((a) => a.includes('sekretval'))).toBe(false)
    // No allowedTools flag on codex — MCP tools run without an approval flag.
    expect(args).not.toContain('--allowedTools')
    expect(args.at(-1)).toBe('go')
  })

  it('codex without an MCP config stays a plain exec (chat-only)', () => {
    const { args } = buildHarnessExec('codex', { prompt: 'p' }, bins)
    expect(args).toEqual(['exec', '--skip-git-repo-check', 'p'])
  })

  it('codex REFUSES a malformed MCP config rather than running tool-less (throws)', () => {
    expect(() => buildHarnessExec('codex', { prompt: 'p', mcpConfig: 'not json' }, bins)).toThrow(
      /malformed MCP config/,
    )
  })

  it('resolves opencode/cursor bins and uses their run flags', () => {
    expect(buildHarnessExec('opencode', { prompt: 'p' }, bins)).toEqual({
      cmd: '/bin/opencode',
      args: ['run', 'p'],
    })
    expect(buildHarnessExec('cursor', { prompt: 'p' }, bins).cmd).toBe('/bin/agent')
  })
})

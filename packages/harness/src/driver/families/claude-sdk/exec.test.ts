/**
 * THE CLAUDE DURABLE-CLI TURN SHAPE (moved from
 * apps/daemon/src/durable-headless.test.ts in 1.5 with the code it pins).
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildClaudeDurableTurn } from './exec.js'

describe('buildClaudeDurableTurn', () => {
  it('uses Claude native auto mode and keeps machine context out of stdin', () => {
    const turn = buildClaudeDurableTurn(
      {
        prompt: 'human text',
        contextPrompt: 'machine context',
        systemPrompt: 'orchestrator',
        permissionMode: 'bypassPermissions',
        sessionUuid: randomUUID(),
      },
      { mcp: '/tmp/mcp.json' },
      '/opt/claude',
    )
    expect(turn.cmd).toBe('/opt/claude')
    expect(turn.stdin).toBe('human text')
    expect(turn.args).toContain('--permission-mode')
    expect(turn.args[turn.args.indexOf('--permission-mode') + 1]).toBe('auto')
    expect(turn.args).not.toContain('--dangerously-skip-permissions')
    expect(turn.args[turn.args.indexOf('--append-system-prompt') + 1]).toBe(
      'orchestrator\n\nmachine context',
    )
  })

  it('reapplies the current system prompt when resuming a Claude CLI thread', () => {
    const turn = buildClaudeDurableTurn(
      {
        prompt: 'Why?',
        systemPrompt: 'NORMAL: HARD LIMIT 80 words total',
        resumeValue: 'claude-thread-1',
      },
      { mcp: '/tmp/mcp.json' },
      '/opt/claude',
    )

    expect(turn.stdin).toBe('Why?')
    expect(
      turn.args.slice(turn.args.indexOf('--resume'), turn.args.indexOf('--resume') + 2),
    ).toEqual(['--resume', 'claude-thread-1'])
    expect(turn.args[turn.args.indexOf('--append-system-prompt') + 1]).toBe(
      'NORMAL: HARD LIMIT 80 words total',
    )
    expect(turn.knownSessionId).toBe('claude-thread-1')
  })

  it('removes Claude tools and MCP from a durable repair invocation', () => {
    const turn = buildClaudeDurableTurn(
      {
        prompt: 'repair',
        toolPolicy: 'none',
        mcpConfig: '{"mcpServers":{"podium":{"url":"http://podium.invalid"}}}',
      },
      { mcp: '/tmp/mcp.json' },
      '/opt/claude',
    )
    expect(
      turn.args.slice(turn.args.indexOf('--tools'), turn.args.indexOf('--tools') + 2),
    ).toEqual(['--tools', ''])
    expect(turn.args).not.toContain('--mcp-config')
  })
})

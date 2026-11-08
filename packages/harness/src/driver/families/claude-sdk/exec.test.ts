/**
 * THE CLAUDE DURABLE-CLI TURN SHAPE (moved from
 * apps/daemon/src/durable-headless.test.ts in 1.5 with the code it pins).
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { testHarnessContext } from '../../testing/harness-context.js'
import { buildClaudeDurableTurn } from './exec.js'

const claudeAt = (executable: string) => testHarnessContext({ kind: 'claude-code', executable })

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
      claudeAt('/opt/claude'),
    )
    expect(turn.command.cmd).toBe('/opt/claude')
    expect(turn.stdin).toBe('human text')
    expect(turn.command.args).toContain('--permission-mode')
    expect(turn.command.args[turn.command.args.indexOf('--permission-mode') + 1]).toBe('auto')
    expect(turn.command.args).not.toContain('--dangerously-skip-permissions')
    expect(turn.command.args[turn.command.args.indexOf('--append-system-prompt') + 1]).toBe(
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
      claudeAt('/opt/claude'),
    )

    expect(turn.stdin).toBe('Why?')
    expect(
      turn.command.args.slice(
        turn.command.args.indexOf('--resume'),
        turn.command.args.indexOf('--resume') + 2,
      ),
    ).toEqual(['--resume', 'claude-thread-1'])
    expect(turn.command.args[turn.command.args.indexOf('--append-system-prompt') + 1]).toBe(
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
      claudeAt('/opt/claude'),
    )
    expect(
      turn.command.args.slice(
        turn.command.args.indexOf('--tools'),
        turn.command.args.indexOf('--tools') + 2,
      ),
    ).toEqual(['--tools', ''])
    expect(turn.command.args).not.toContain('--mcp-config')
  })
})

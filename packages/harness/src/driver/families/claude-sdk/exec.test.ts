/**
 * THE CLAUDE DURABLE-CLI TURN SHAPE (moved from
 * apps/daemon/src/durable-headless.test.ts in 1.5 with the code it pins).
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { manifestFor } from '../../../registry.js'
import { testHarnessContext, testTurnPosture } from '../../testing/harness-context.js'
import { buildClaudeDurableTurn } from './exec.js'

const claudeAt = (executable: string) => testHarnessContext({ kind: 'claude-code', executable })
/** The Claude adapter's own posture section and a test launch posture. */
const TERMS = { manifest: manifestFor('claude-code')!, posture: testTurnPosture() }

describe('buildClaudeDurableTurn', () => {
  it('runs a native bypass pick as auto and keeps machine context out of stdin', () => {
    // Moved to posture (POD-6858): the mode flag is the posture section's; the
    // builder only turns a bypass pick into `auto`, as it always has.
    const turn = buildClaudeDurableTurn(
      {
        prompt: 'human text',
        contextPrompt: 'machine context',
        systemPrompt: 'orchestrator',
        sessionUuid: randomUUID(),
      },
      { mcp: '/tmp/mcp.json' },
      claudeAt('/opt/claude'),
      {
        ...TERMS,
        posture: { ...TERMS.posture, posture: { mode: { native: 'bypassPermissions' } } },
      },
    )
    expect(turn.command.cmd).toBe('/opt/claude')
    expect(turn.stdin).toBe('human text')
    expect(turn.command.args.filter((arg) => arg === '--permission-mode')).toHaveLength(1)
    expect(turn.command.args[turn.command.args.indexOf('--permission-mode') + 1]).toBe('auto')
    expect(turn.command.terms.requestedMode).toBe('auto')
    expect(turn.command.args).not.toContain('--dangerously-skip-permissions')
    expect(turn.command.args).not.toContain('--allow-dangerously-skip-permissions')
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
      TERMS,
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
      TERMS,
    )
    expect(
      turn.command.args.slice(
        turn.command.args.indexOf('--tools'),
        turn.command.args.indexOf('--tools') + 2,
      ),
    ).toEqual(['--tools', ''])
    expect(turn.command.args).not.toContain('--mcp-config')
    // A tool-less turn runs on no-agent terms: no mode, no allow rule.
    expect(turn.command.args).not.toContain('--permission-mode')
    expect(turn.command.args.some((arg) => arg.startsWith('--allowedTools'))).toBe(false)
  })

  it('takes the mode and the allow rules from the posture section, once each', () => {
    // Moved to posture (POD-6858): the builder's own `--permission-mode` and
    // its comma-joined `--allowedTools` are gone.
    const turn = buildClaudeDurableTurn(
      { prompt: 'hi', sessionUuid: 'uuid-1' },
      { mcp: '/tmp/mcp.json' },
      claudeAt('/opt/claude'),
      { ...TERMS, posture: { ...TERMS.posture, posture: { mode: 'supervised' } } },
    )
    const { args } = turn.command
    expect(args.filter((arg) => arg === '--permission-mode')).toHaveLength(1)
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
    expect(args).not.toContain('--allowedTools')
    expect(args).toContain('--allowedTools=Bash(podium *)')
    expect(turn.command.terms.requestedMode).toBe('default')
  })
})

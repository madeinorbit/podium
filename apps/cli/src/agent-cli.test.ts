// `podium agent` — cross-harness subagent spawn + bounded await (#237)
// [spec:SP-34d7 cross-harness]: argv shape, flag validation, wire forwarding
// (incl. #285 workflow pass-through), and the never-hangs await renderings.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type AgentClient, runAgentCli } from './agent-cli'

function client(over?: Partial<Record<'spawnAgent' | 'awaitAgent', unknown>>) {
  const proc = (result: unknown) => ({ mutate: vi.fn(async () => result) })
  return {
    messages: {
      spawnAgent: proc(
        over?.spawnAgent ?? {
          ok: true,
          sessionId: 'child1',
          issueId: 'iss_a',
          issueSeq: 228,
          cwd: '/wt/a',
        },
      ),
      awaitAgent: proc(
        over?.awaitAgent ?? {
          done: false,
          result: 'working',
          snapshot: { sessionId: 'child1', status: 'live', phase: 'working' },
        },
      ),
    },
  } satisfies AgentClient
}

describe('podium agent spawn', () => {
  it('requires --prompt and one of --issue/--new', async () => {
    const c = client()
    await expect(runAgentCli(['spawn', '--issue', '#228'], c)).rejects.toThrow(/--prompt/)
    await expect(runAgentCli(['spawn', '--prompt', 'x'], c)).rejects.toThrow(/--issue.*--new/)
  })

  it('forwards harness/model/effort/worktree and the #285 workflow metadata verbatim', async () => {
    const c = client()
    const out = await runAgentCli(
      [
        'spawn',
        '--issue',
        '#228',
        '--harness',
        'codex',
        '--prompt',
        'do it',
        '--worktree',
        '--model',
        'gpt-5.2',
        '--effort',
        'high',
        '--workflow-run-id',
        'run_1',
        '--workflow-step-id',
        'step_2',
        '--execution-profile-id',
        'prof_3',
      ],
      c,
    )
    expect(c.messages.spawnAgent.mutate).toHaveBeenCalledWith({
      issue: '#228',
      harness: 'codex',
      prompt: 'do it',
      worktree: true,
      model: 'gpt-5.2',
      effort: 'high',
      workflowRunId: 'run_1',
      workflowStepId: 'step_2',
      executionProfileId: 'prof_3',
    })
    expect(out).toContain('spawned child1 on issue #228')
    expect(out).toContain('podium agent await child1')
  })

  it('--new maps to newTitle (the deliberate issue-create path)', async () => {
    const c = client()
    await runAgentCli(['spawn', '--new', 'follow-up', '--repo', '/repo', '--prompt', 'go'], c)
    expect(c.messages.spawnAgent.mutate).toHaveBeenCalledWith({
      newTitle: 'follow-up',
      repo: '/repo',
      prompt: 'go',
    })
  })

  it('forwards --title as the spawner-prescribed child session name', async () => {
    const c = client()
    await runAgentCli(
      ['spawn', '--issue', '#228', '--prompt', 'go', '--title', 'Spawn placement worker'],
      c,
    )
    expect(c.messages.spawnAgent.mutate).toHaveBeenCalledWith({
      issue: '#228',
      prompt: 'go',
      title: 'Spawn placement worker',
    })
  })

  it('rejects unknown flags', async () => {
    await expect(
      runAgentCli(['spawn', '--issue', '#1', '--prompt', 'x', '--sender', 'me'], client()),
    ).rejects.toThrow(/--sender/)
  })
})

describe('podium agent await (bounded)', () => {
  it('renders "still working" + snapshot instead of hanging', async () => {
    const c = client()
    const out = await runAgentCli(['await', 'child1', '--timeout', '5'], c)
    expect(c.messages.awaitAgent.mutate).toHaveBeenCalledWith({
      sessionId: 'child1',
      timeoutSeconds: 5,
    })
    expect(out).toContain('still working (live/working)')
  })

  it('renders the ack body and the settle state', async () => {
    const acked = client({
      awaitAgent: {
        done: true,
        result: 'acked',
        ack: { id: 'msg_a', body: 'done: merged' },
        snapshot: { status: 'exited' },
      },
    })
    expect(await runAgentCli(['await', 'child1'], acked)).toContain('acked (msg_a): done: merged')
    const settled = client({
      awaitAgent: { done: true, result: 'settled', snapshot: { status: 'exited' } },
    })
    expect(await runAgentCli(['await', 'child1'], settled)).toContain('settled (exited)')
  })

  it('validates --timeout bounds and requires a session id', async () => {
    const c = client()
    await expect(runAgentCli(['await'], c)).rejects.toThrow(/session id/)
    await expect(runAgentCli(['await', 'x', '--timeout', '999'], c)).rejects.toThrow(/0-300/)
  })
})

// Real-binary smoke (repo norm: argv-shape tests miss real CLI quirks).
const cliEntry = join(__dirname, '../../../scripts/cli.ts')
const hasBun = (() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' })
    return existsSync(cliEntry)
  } catch {
    return false
  }
})()

describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !hasBun)('podium agent real-binary smoke', () => {
  it('renders help without a server', () => {
    const out = execFileSync('bun', [cliEntry, 'agent', '--help'], { encoding: 'utf8' })
    expect(out).toContain('podium agent <command>')
    expect(out).toContain('spawn --prompt')
    expect(out).toContain('await <sessionId>')
  })

  it('fails fast on an unknown agent command', () => {
    expect(() =>
      execFileSync('bun', [cliEntry, 'agent', 'bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    ).toThrow()
  })
})

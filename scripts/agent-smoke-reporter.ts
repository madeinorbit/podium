import type { Reporter, TestModule, Vitest } from 'vitest/node'

export const REAL_AGENT_CLIS = ['claude', 'codex', 'opencode', 'cursor', 'grok'] as const
export type RealAgentCli = (typeof REAL_AGENT_CLIS)[number]
export type AgentSmokeState = 'passed' | 'failed' | 'skipped' | 'pending'

export interface AgentSmokeCase {
  fullName: string
  state: AgentSmokeState
}

export interface AgentSmokeCount {
  passed: number
  failed: number
  skipped: number
  pending: number
}

export type AgentSmokeSummary = Record<RealAgentCli, AgentSmokeCount>

const marker = /\[real-agent:(claude|codex|opencode|cursor|grok)\]/

export function summarizeAgentSmokes(cases: Iterable<AgentSmokeCase>): AgentSmokeSummary {
  const summary = Object.fromEntries(
    REAL_AGENT_CLIS.map((cli) => [
      cli,
      { passed: 0, failed: 0, skipped: 0, pending: 0 } satisfies AgentSmokeCount,
    ]),
  ) as AgentSmokeSummary
  for (const test of cases) {
    const cli = marker.exec(test.fullName)?.[1] as RealAgentCli | undefined
    if (cli) summary[cli][test.state] += 1
  }
  return summary
}

export function agentSmokeCensusError(summary: AgentSmokeSummary): string | undefined {
  const missing = REAL_AGENT_CLIS.filter((cli) => {
    const count = summary[cli]
    return count.passed + count.failed + count.skipped + count.pending === 0
  })
  if (missing.length > 0) {
    return `real-agent smoke cases are missing for: ${missing.join(', ')}`
  }
  const ran = REAL_AGENT_CLIS.reduce(
    (total, cli) => total + summary[cli].passed + summary[cli].failed,
    0,
  )
  if (ran === 0) return 'every real-agent CLI smoke skipped; no real binary was exercised'
  return undefined
}

const displayName: Record<RealAgentCli, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  grok: 'Grok',
}

export default class AgentSmokeReporter implements Reporter {
  private ctx: Vitest | undefined

  onInit(ctx: Vitest): void {
    this.ctx = ctx
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const cases: AgentSmokeCase[] = []
    for (const module of testModules) {
      for (const test of module.children.allTests()) {
        cases.push({ fullName: test.fullName, state: test.result().state })
      }
    }
    const summary = summarizeAgentSmokes(cases)
    this.ctx?.logger.log('\nReal-agent smoke census (ran vs skipped per CLI)')
    for (const cli of REAL_AGENT_CLIS) {
      const count = summary[cli]
      const ran = count.passed + count.failed
      this.ctx?.logger.log(
        `  ${displayName[cli]}: ${ran} ran (${count.passed} passed, ${count.failed} failed), ${count.skipped} skipped`,
      )
    }

    const error = agentSmokeCensusError(summary)
    if (!error) return
    const failure = new Error(`[agent-smoke] ${error}`)
    this.ctx?.logger.error(`\n${failure.message}`)
    this.ctx?.state.catchError(failure, 'Agent Smoke Census')
    process.exitCode = 1
  }
}

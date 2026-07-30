/**
 * `podium quota` — read the same live harness plan limits shown in the web panel.
 *
 * Managed agent sessions use their capability-scoped daemon relay to call the
 * server's `quota.summary` procedure. `--json` preserves that payload verbatim.
 */

import { makeRelayIssueClient } from '@podium/issue-client'
import type { AgentKind, AgentQuotaWire, MachineQuotaWire, QuotaWindowWire } from '@podium/model'
import { resolveAgentRelay } from '@podium/runtime/config'

type QuotaProc = {
  query(input?: unknown): Promise<unknown>
}

export interface QuotaClient {
  quota: {
    summary: QuotaProc
  }
}

export class QuotaCliError extends Error {}

const AGENT_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}

export function quotaHelpText(): string {
  return [
    'podium quota [--json]',
    '',
    'From a managed agent session, show current plan usage limits for every harness',
    'reported by each online Podium daemon — the same data shown in the web panel.',
    '',
    '  --json    Print the exact multi-machine quota payload as JSON.',
    '  --help    Show this help.',
    '',
    'The readable view includes account, plan, percent used and remaining, reset',
    'time, and authentication/provider errors. Provider responses may be cached',
    'for up to two minutes, matching the panel polling path.',
  ].join('\n')
}

function quotaArgumentError(argv: string[]): string | undefined {
  const unknown = argv.find((arg) => arg !== '--json')
  if (!unknown) return undefined
  return `${unknown.startsWith('-') ? 'unknown option' : 'unexpected argument'} '${unknown}' (see \`podium quota --help\`)`
}

function decimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '')
}

function resetDescription(resetsAt: string, nowMs: number): string {
  const resetMs = Date.parse(resetsAt)
  if (!Number.isFinite(resetMs)) return 'reset unknown'
  const deltaMs = resetMs - nowMs
  if (deltaMs <= 0) return `resetting (${new Date(resetMs).toISOString()})`
  const minutes = Math.round(deltaMs / 60_000)
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const mins = minutes % 60
  const relative = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
  return `resets ${new Date(resetMs).toISOString()} (in ${relative})`
}

function accountDescription(agent: AgentQuotaWire): string {
  const details = [agent.account?.plan, agent.account?.email].filter((value): value is string =>
    Boolean(value),
  )
  return details.length > 0 ? ` (${details.join(' · ')})` : ''
}

function statusDescription(agent: AgentQuotaWire): string {
  switch (agent.status) {
    case 'unauthenticated':
      return 'not signed in'
    case 'expired':
      return agent.error ?? 'token expired'
    case 'error':
      return agent.error ?? 'unavailable'
    case 'ok':
      return agent.windows.length === 0 ? 'no limits reported' : 'ok'
  }
}

function renderWindow(window: QuotaWindowWire, nowMs: number): string {
  const used = Math.min(100, Math.max(0, window.usedPercent))
  const remaining = Math.max(0, 100 - used)
  const scope = window.scopeModel ? ` (${window.scopeModel})` : ''
  return `    ${window.label}${scope}: ${decimal(used)}% used · ${decimal(remaining)}% left · ${resetDescription(window.resetsAt, nowMs)}`
}

export function renderQuota(machines: MachineQuotaWire[], nowMs = Date.now()): string {
  if (machines.length === 0) return 'No online Podium daemons reported usage limits.'

  return machines
    .map((machine) => {
      const identity =
        machine.hostname && machine.hostname !== machine.machineName
          ? `${machine.machineName} (${machine.hostname})`
          : machine.machineName || machine.hostname || machine.machineId
      const lines = [identity]
      if (machine.agents.length === 0) {
        lines.push('  No harness usage limits reported.')
        return lines.join('\n')
      }
      for (const agent of machine.agents) {
        const label = AGENT_LABELS[agent.agent]
        const account = accountDescription(agent)
        if (agent.status !== 'ok' || agent.windows.length === 0) {
          lines.push(`  ${label}${account} — ${statusDescription(agent)}`)
          continue
        }
        lines.push(`  ${label}${account}`)
        for (const window of agent.windows) lines.push(renderWindow(window, nowMs))
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

export async function runQuotaCli(
  argv: string[],
  client: QuotaClient,
  nowMs = Date.now(),
): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return quotaHelpText()
  }
  const argumentError = quotaArgumentError(argv)
  if (argumentError) throw new QuotaCliError(argumentError)
  const raw = await client.quota.summary.query()
  const machines = raw as MachineQuotaWire[]
  return argv.includes('--json')
    ? JSON.stringify({ command: 'quota', ok: true, data: machines })
    : renderQuota(machines, nowMs)
}

export async function quotaCliMain(argv: string[]): Promise<void> {
  // Help must work without a running server or an agent relay.
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    console.log(quotaHelpText())
    return
  }
  const relay = resolveAgentRelay()
  const argumentError = quotaArgumentError(argv)
  if (argumentError) {
    if (argv.includes('--json'))
      console.log(JSON.stringify({ command: 'quota', ok: false, error: argumentError }))
    else console.error(`podium quota: ${argumentError}`)
    process.exitCode = 1
    return
  }

  if (!relay) {
    const message =
      'this command is available inside a Podium-managed agent session ' +
      '(PODIUM_AGENT_RELAY is unset); use the quota panel outside a session'
    if (argv.includes('--json'))
      console.log(JSON.stringify({ command: 'quota', ok: false, error: message }))
    else console.error(`podium quota: ${message}`)
    process.exitCode = 1
    return
  }
  const client = makeRelayIssueClient(relay) as unknown as QuotaClient
  try {
    console.log(await runQuotaCli(argv, client))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json'))
      console.log(JSON.stringify({ command: 'quota', ok: false, error: message }))
    else console.error(`podium quota: ${message}`)
    process.exitCode = 1
  }
}

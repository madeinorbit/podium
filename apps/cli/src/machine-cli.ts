/**
 * `podium machine` — answer "what can I run on?" from an agent session.
 *
 * Machines have been first-class since POD-318 and the web settings panel has listed
 * them for as long, but a coordinating agent had no way to ask (POD-1424): it fell
 * back to reading the sqlite `machines` table, or to `tailscale status`, which knows
 * the network and nothing about Podium. This is the read that was missing, and it is
 * deliberately ONLY a read — placement, pinning and handoff are separate commands.
 *
 * NO NEW AUTHORIZATION SURFACE. The server answers from one projection
 * (modules/machines/fleet-view.ts), which stamps each row with this caller's `use`
 * verdict and joins checkout paths only for machines that carry it. This command
 * renders that projection and nothing else.
 */

import { makeRelayIssueClient } from '@podium/issue-client'
import { resolveAgentRelay } from '@podium/runtime/config'
import { machineByRef, type NameableMachine } from './machine-ref'

type Proc = { query(input?: unknown): Promise<unknown> }

/**
 * `machines.listWithRepos` — the projection plus the registered checkout paths of the
 * machines this caller may USE. A separate proc from `machines.list` (which answers
 * exactly what the router answers) so neither ever returns two shapes; and the repo
 * rows are joined SERVER-side, because the unscoped `repos.listDetailed` would
 * disclose paths on machines the caller cannot see.
 */
export interface MachineClient {
  machines: { listWithRepos: Proc }
}

export class MachineCliError extends Error {}

/**
 * The machine row as this command reads it — declared LOCALLY on purpose.
 *
 * apps/cli already declares its own client shapes rather than importing server or
 * model types, and that is the right home for this one: it keeps a CLI view out of a
 * package whose layout is being restructured, and it creates nothing that has to be
 * reconciled later. Fields beyond these ride through `--json` untouched.
 */
export interface MachineRow extends NameableMachine {
  online: boolean
  lastSeenAt: string
  /** This caller's verdict. See fleet-view.ts — one value today, and load-bearing anyway. */
  use?: string
  inventory?: MachineInventory
}

interface MachineInventory {
  os: string
  arch: string
  podiumVersion?: string
  agents: AgentInventory[]
}

interface AgentInventory {
  kind: string
  installed: boolean
  version?: string
  login: { state: 'in' | 'out' | 'unknown'; account?: string }
}

/** One registered checkout, as the fleet view reports it. */
interface RepoRow {
  machineId: string
  path: string
}

interface FleetView {
  machines: MachineRow[]
  repos: RepoRow[]
}

export function machineHelpText(): string {
  return [
    'podium machine <command>',
    '',
    'Show the machines this session may see, so you can decide where to run work.',
    '',
    'Commands:',
    '  list [--json]           Every visible machine, one block each (default).',
    '  show <name|id> [--json] One machine in full, including its harness inventory.',
    '',
    'Options:',
    '  --json    Print the exact server payload as JSON.',
    '  --help    Show this help.',
    '',
    'A machine is usable for agent work when it is online, `use` is granted, the',
    'harness you want is installed and logged in, and the repository you want is',
    'registered on it. `list` shows all four so you do not have to guess.',
    '',
    'Placing work on a machine is a separate command: see `podium issue start',
    '--machine` to start there, and `podium session handoff --to` to move a session',
    'that is already running.',
  ].join('\n')
}

function argumentError(argv: string[]): string | undefined {
  const [command, ...rest] = argv
  if (command !== undefined && command !== 'list' && command !== 'show') {
    return `unknown command '${command}' (see \`podium machine --help\`)`
  }
  const positional = rest.filter((arg) => !arg.startsWith('-'))
  const unknownOption = rest.find((arg) => arg.startsWith('-') && arg !== '--json')
  if (unknownOption) return `unknown option '${unknownOption}' (see \`podium machine --help\`)`
  if (command === 'show' && positional.length === 0) {
    return 'usage: podium machine show <name|id>'
  }
  if (command !== 'show' && positional.length > 0) {
    return `unexpected argument '${positional[0]}' (see \`podium machine --help\`)`
  }
  if (positional.length > 1) {
    return `unexpected argument '${positional[1]}' (see \`podium machine --help\`)`
  }
  return undefined
}

/** Relative age of an ISO timestamp, coarse on purpose — "11d ago" is the fact that
 *  decides whether an offline machine is worth waiting for; minutes are not. */
export function lastSeenDescription(lastSeenAt: string, nowMs: number): string {
  const seenMs = Date.parse(lastSeenAt)
  if (!Number.isFinite(seenMs)) return `last seen ${lastSeenAt}`
  const deltaMs = nowMs - seenMs
  if (deltaMs < 0) return `last seen ${lastSeenAt}`
  const minutes = Math.floor(deltaMs / 60_000)
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const relative =
    days > 0
      ? `${days}d ago`
      : hours > 0
        ? `${hours}h ago`
        : minutes > 0
          ? `${minutes}m ago`
          : 'just now'
  return `last seen ${lastSeenAt} (${relative})`
}

function harnessDescription(agent: AgentInventory): string {
  if (!agent.installed) return `${agent.kind}: not installed`
  const version = agent.version ? ` ${agent.version}` : ''
  switch (agent.login.state) {
    case 'in':
      return `${agent.kind}${version}: ready${agent.login.account ? ` (${agent.login.account})` : ''}`
    case 'out':
      return `${agent.kind}${version}: installed, NOT logged in`
    default:
      return `${agent.kind}${version}: installed, login unknown`
  }
}

function machineBlock(machine: MachineRow, repos: RepoRow[], nowMs: number): string {
  const identity =
    machine.hostname && machine.hostname !== machine.name
      ? `${machine.name} (${machine.hostname})`
      : machine.name || machine.hostname || machine.id
  const liveness = machine.online ? 'online' : 'offline'
  const use = machine.use ? `use ${machine.use}` : 'use not evaluated'
  const lines = [`${identity} — ${liveness} · ${use}`]
  if (!machine.online) lines.push(`  ${lastSeenDescription(machine.lastSeenAt, nowMs)}`)
  lines.push(`  id ${machine.id}`)

  const inventory = machine.inventory
  if (!inventory) {
    // Inventory answers "what can I run on your hardware, and as whom", so the server
    // withholds it from a caller without `use`. Absent therefore means either withheld
    // or not-yet-reported, and which one is not knowable here — so say neither.
    lines.push('  inventory: not available to this session')
  } else {
    const version = inventory.podiumVersion ? ` · podium ${inventory.podiumVersion}` : ''
    lines.push(`  ${inventory.os}/${inventory.arch}${version}`)
    lines.push(
      inventory.agents.length === 0
        ? '  harnesses: none reported'
        : `  harnesses: ${inventory.agents.map(harnessDescription).join(', ')}`,
    )
  }

  // "none registered" is a fact about the MACHINE; "not available" is a fact about the
  // CALLER. The server sends no repo rows for a machine this principal cannot `use`, so
  // reporting that as "none registered" would state the first when only the second is
  // known — and the wire is identical either way, so no authorization test could catch
  // the substitution. This renderer is the only place it can be caught.
  const machineRepos = repos.filter((repo) => repo.machineId === machine.id)
  lines.push(
    machine.use === 'granted' || machineRepos.length > 0
      ? machineRepos.length === 0
        ? '  repos: none registered — work cannot be placed here until one is'
        : `  repos: ${machineRepos.map((repo) => repo.path).join(', ')}`
      : '  repos: not available to this session',
  )
  return lines.join('\n')
}

export function renderMachines(
  machines: MachineRow[],
  repos: RepoRow[],
  nowMs = Date.now(),
): string {
  if (machines.length === 0) return 'No machines are visible to this session.'
  return machines.map((machine) => machineBlock(machine, repos, nowMs)).join('\n\n')
}

/** `machineByRef` plus this command's refusal. The MATCHING rule is shared with
 *  `podium issue start --machine` and `podium session handoff --to` so the surfaces
 *  cannot come to disagree about which host a name means; only the error type is local. */
export function selectMachine(machines: MachineRow[], selector: string): MachineRow {
  const match = machineByRef(machines, selector)
  if (match) return match
  const known = machines.map((machine) => machine.name).join(', ')
  throw new MachineCliError(
    known
      ? `no visible machine named '${selector}' (visible: ${known})`
      : `no visible machine named '${selector}'`,
  )
}

export async function runMachineCli(
  argv: string[],
  client: MachineClient,
  nowMs = Date.now(),
): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return machineHelpText()
  const invalid = argumentError(argv)
  if (invalid) throw new MachineCliError(invalid)

  const { machines, repos } = (await client.machines.listWithRepos.query()) as FleetView
  const json = argv.includes('--json')

  if (argv[0] === 'show') {
    const selector = argv.slice(1).find((arg) => !arg.startsWith('-')) as string
    const machine = selectMachine(machines, selector)
    const machineRepos = repos.filter((repo) => repo.machineId === machine.id)
    return json
      ? JSON.stringify({
          command: 'machine show',
          ok: true,
          data: { machine, repos: machineRepos },
        })
      : machineBlock(machine, repos, nowMs)
  }

  return json
    ? JSON.stringify({ command: 'machine list', ok: true, data: { machines, repos } })
    : renderMachines(machines, repos, nowMs)
}

export async function machineCliMain(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const fail = (message: string): void => {
    if (json) console.log(JSON.stringify({ command: 'machine', ok: false, error: message }))
    else console.error(`podium machine: ${message}`)
    process.exitCode = 1
  }

  // Help must work without a running server or an agent relay.
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    console.log(machineHelpText())
    return
  }
  const invalid = argumentError(argv)
  if (invalid) {
    fail(invalid)
    return
  }
  const relay = resolveAgentRelay()
  if (!relay) {
    fail(
      'this command is available inside a Podium-managed agent session ' +
        '(PODIUM_AGENT_RELAY is unset); use the machines panel outside a session',
    )
    return
  }
  const client = makeRelayIssueClient(relay) as unknown as MachineClient
  try {
    console.log(await runMachineCli(argv, client))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

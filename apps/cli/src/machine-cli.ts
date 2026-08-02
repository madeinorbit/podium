/**
 * `podium machine` — answer "what can I run on?" from an agent session.
 *
 * Machines have been first-class in the model since POD-318, and the web
 * settings panel has listed them for as long, but a coordinating agent had no
 * way to ask: it fell back to reading the sqlite `machines` table or to
 * `tailscale status`, which knows the network and nothing about Podium
 * (POD-1386). This is the read that was missing, and it is deliberately ONLY a
 * read — placement, pinning and handoff are separate commands.
 *
 * NO NEW AUTHORIZATION SURFACE. `machines.list` is the server's one hand-written
 * read precisely because it carries an authorization projection: it scopes the
 * list to what this principal may `see` and stamps each row with the principal's
 * live `use` decision, so a machine the caller cannot execute on is never
 * OFFERED (readiness §3.1.4 M5). This command renders that projection and
 * nothing else. In particular the repo join below is drawn only for machines
 * that already survived the projection, so it widens no disclosure: `use:
 * denied` machines render their identity and liveness — the content of `see` —
 * and no inventory, because the server did not send any.
 */

import { makeRelayIssueClient } from '@podium/issue-client'
import type { AgentInventory, MachineWire } from '@podium/model'
import { resolveAgentRelay } from '@podium/runtime/config'

type Proc = { query(input?: unknown): Promise<unknown> }

export interface MachineClient {
  machines: { list: Proc }
  repos: { listDetailed: Proc }
}

export class MachineCliError extends Error {}

/** The `repos.listDetailed` row shape, narrowed to what this view renders. */
interface RepoRow {
  machineId: string
  path: string
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
    '--machine` to start there, and `podium session handoff` to move a session',
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

/** Relative age of an ISO timestamp, coarse on purpose — "11d ago" is the fact
 *  that decides whether a machine is worth waiting for; minutes are not. */
export function lastSeenDescription(lastSeenAt: string, nowMs: number): string {
  const seenMs = Date.parse(lastSeenAt)
  if (!Number.isFinite(seenMs)) return `last seen ${lastSeenAt}`
  const deltaMs = nowMs - seenMs
  if (deltaMs < 0) return `last seen ${lastSeenAt}`
  const minutes = Math.floor(deltaMs / 60_000)
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const relative =
    days > 0 ? `${days}d ago` : hours > 0 ? `${hours}h ago` : minutes > 0 ? `${minutes}m ago` : 'just now'
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
    case 'unknown':
      return `${agent.kind}${version}: installed, login unknown`
  }
}

function machineBlock(machine: MachineWire, repos: RepoRow[], nowMs: number): string {
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
    // Inventory is `use`-gated (machine.ts: "what can I run on your hardware, and
    // as whom"). Absent means the server withheld it or the daemon has not pushed
    // one yet — say which is not knowable here, so say neither.
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

  const machineRepos = repos.filter((repo) => repo.machineId === machine.id)
  lines.push(
    machineRepos.length === 0
      ? '  repos: none registered — work cannot be placed here until one is'
      : `  repos: ${machineRepos.map((repo) => repo.path).join(', ')}`,
  )
  return lines.join('\n')
}

export function renderMachines(
  machines: MachineWire[],
  repos: RepoRow[],
  nowMs = Date.now(),
): string {
  if (machines.length === 0) return 'No machines are visible to this session.'
  return machines.map((machine) => machineBlock(machine, repos, nowMs)).join('\n\n')
}

/** Match on id first, then exact name, then exact hostname. Deliberately no
 *  fuzzy or prefix matching: picking the wrong machine places real work on the
 *  wrong host, and an agent that guessed a name should be told it guessed. */
export function selectMachine(machines: MachineWire[], selector: string): MachineWire {
  const match =
    machines.find((machine) => machine.id === selector) ??
    machines.find((machine) => machine.name === selector) ??
    machines.find((machine) => machine.hostname === selector)
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

  const machines = (await client.machines.list.query()) as MachineWire[]
  const repos = (await client.repos.listDetailed.query()) as RepoRow[]
  const json = argv.includes('--json')

  if (argv[0] === 'show') {
    const selector = argv.slice(1).find((arg) => !arg.startsWith('-')) as string
    const machine = selectMachine(machines, selector)
    const machineRepos = repos.filter((repo) => repo.machineId === machine.id)
    return json
      ? JSON.stringify({ command: 'machine show', ok: true, data: { machine, repos: machineRepos } })
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

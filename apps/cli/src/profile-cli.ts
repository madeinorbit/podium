/**
 * `podium profile` — named agent setups (POD-6107, flight deck D3/D4).
 *
 * A profile is an ordered list of harness/model/effort candidates, an optional
 * machine and optional instructions. Issues and sessions point at one with
 * `--profile <name>`. People edit profiles; an agent session may list and show
 * them, and the server refuses its edits.
 *
 * Files: `import`/`export` use `.podium/agents/<name>.md` (frontmatter + body,
 * the Claude Code agent-file shape).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { makeRelayIssueClient } from '@podium/issue-client'
import { type AgentCandidate, AgentCandidate as AgentCandidateSchema, formatAgentCandidates } from '@podium/model'
import { localServerUrl, resolveAgentRelay, resolvePort } from '@podium/runtime/config'
import { makeOperatorIssueClient } from './operator-client'

type Proc = {
  query(input?: unknown): Promise<unknown>
  mutate(input?: unknown): Promise<unknown>
}

export interface ProfileClient {
  agentProfiles: Record<'list' | 'show' | 'export' | 'create' | 'update' | 'delete' | 'import', Proc>
}

export interface ProfileFs {
  readText(path: string): string
  writeText(path: string, text: string): void
  /** `.md` files directly inside a directory, or null when it is not a directory. */
  listMarkdown(dir: string): string[] | null
  ensureDir(dir: string): void
}

const nodeFs: ProfileFs = {
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, text) => writeFileSync(path, text),
  listMarkdown: (dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => join(dir, f))
  },
  ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
}

export class ProfileCliError extends Error {}

export const DEFAULT_AGENTS_DIR = join('.podium', 'agents')

interface ProfileView {
  id: string
  name: string
  description: string
  candidates: AgentCandidate[]
  machineId: string | null
  machineName?: string | null
  instructions: string
  updatedAt: string
}

export function profileHelpText(): string {
  return [
    'podium profile <command> [arguments]',
    '',
    'Agent profiles are named agent setups that issues and sessions start from',
    '(`podium issue create|update|start --profile <name>`, `podium agent spawn --profile <name>`).',
    'The first candidate whose harness can run on the target machine is used.',
    'People edit profiles; agents may only list, show and pick them.',
    '',
    '  list [--json]                     Every profile, with its candidates.',
    '  show <name> [--json]              One profile in full, instructions included.',
    '  create <name> [fields]            Create a profile.',
    '  update <name> [fields] [--name <new>]',
    '                                    Change a profile; only the given fields change.',
    '  delete <name>                     Delete a profile no open issue uses.',
    '  import [<dir|file.md>...]         Create or replace profiles from .md files',
    `                                    (default: ${DEFAULT_AGENTS_DIR}).`,
    '  export [<name>] [--dir <dir>]     Write profiles as <dir>/<name>.md',
    `                                    (default dir: ${DEFAULT_AGENTS_DIR}).`,
    '',
    'Fields:',
    '  --description "…"',
    '  --candidate <harness>[/<model>[/<effort>]]   Repeat in order of preference;',
    '                                    on update the list is replaced. Example:',
    '                                    --candidate claude-code/auto/high --candidate codex/auto/high',
    '  --machine <name>|none             Where its sessions run (none = wherever the issue runs).',
    '  --instructions "…" | --instructions-file <path>',
    '                                    Markdown added to the agent’s instructions.',
  ].join('\n')
}

/** Parse `harness[/model[/effort]]`. */
export function parseCandidate(raw: string): AgentCandidate {
  const [harness, model, effort, ...rest] = raw.split('/')
  if (rest.length > 0 || !harness) {
    throw new ProfileCliError(`--candidate '${raw}' is not <harness>[/<model>[/<effort>]]`)
  }
  const parsed = AgentCandidateSchema.safeParse({
    harness,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  })
  if (!parsed.success) {
    throw new ProfileCliError(`--candidate '${raw}': ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  }
  return parsed.data
}

const VALUE_FLAGS = new Set(['description', 'candidate', 'machine', 'instructions', 'instructions-file', 'name', 'dir'])
const BOOL_FLAGS = new Set(['json'])

interface ParsedArgs {
  command: string | undefined
  positionals: string[]
  flags: Map<string, string[]>
  json: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  let json = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const key = arg.slice(2, eq === -1 ? undefined : eq)
    if (BOOL_FLAGS.has(key)) {
      json = true
      continue
    }
    if (!VALUE_FLAGS.has(key)) throw new ProfileCliError(`unknown flag --${key} (see \`podium profile --help\`)`)
    const value = eq === -1 ? rest[++i] : arg.slice(eq + 1)
    if (value === undefined) throw new ProfileCliError(`--${key} needs a value`)
    flags.set(key, [...(flags.get(key) ?? []), value])
  }
  return { command, positionals, flags, json }
}

function one(args: ParsedArgs, key: string): string | undefined {
  const values = args.flags.get(key)
  if (values && values.length > 1) throw new ProfileCliError(`--${key} given more than once`)
  return values?.[0]
}

function allowOnly(args: ParsedArgs, allowed: string[]): void {
  for (const key of args.flags.keys()) {
    if (!allowed.includes(key)) {
      throw new ProfileCliError(`--${key} does not apply to \`profile ${args.command}\``)
    }
  }
}

/** The editable fields a create/update names. */
function fieldsFrom(args: ParsedArgs, fs: ProfileFs, cwd: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const description = one(args, 'description')
  if (description !== undefined) fields.description = description
  const candidates = args.flags.get('candidate')
  if (candidates) fields.candidates = candidates.map(parseCandidate)
  const machine = one(args, 'machine')
  if (machine !== undefined) fields.machine = machine === 'none' ? null : machine
  const instructions = one(args, 'instructions')
  const instructionsFile = one(args, 'instructions-file')
  if (instructions !== undefined && instructionsFile !== undefined) {
    throw new ProfileCliError('pass --instructions or --instructions-file, not both')
  }
  if (instructions !== undefined) fields.instructions = instructions
  if (instructionsFile !== undefined) fields.instructions = fs.readText(resolve(cwd, instructionsFile))
  return fields
}

function requireName(args: ParsedArgs): string {
  const [name, ...extra] = args.positionals
  if (!name) throw new ProfileCliError(`profile ${args.command} needs a profile name`)
  if (extra.length > 0) throw new ProfileCliError(`unexpected argument '${extra[0]}'`)
  return name
}

function renderLine(p: ProfileView): string {
  const machine = p.machineId ? ` @${p.machineName ?? p.machineId}` : ''
  const candidates = p.candidates.length > 0 ? formatAgentCandidates(p.candidates) : 'auto (Settings default)'
  const instructions = p.instructions ? '' : ' (no instructions)'
  return `${p.name.padEnd(12)} ${candidates}${machine}${instructions}${p.description ? `\n${' '.repeat(13)}${p.description}` : ''}`
}

function renderFull(p: ProfileView): string {
  return [
    `${p.name}  (${p.id})`,
    p.description ? p.description : null,
    `candidates: ${p.candidates.length > 0 ? formatAgentCandidates(p.candidates) : 'none — the Settings default'}`,
    `machine: ${p.machineId ? (p.machineName ?? p.machineId) : 'none — wherever the issue runs'}`,
    `updated: ${p.updatedAt}`,
    '',
    p.instructions ? p.instructions : '(no instructions)',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

export async function runProfileCli(
  argv: string[],
  deps: { client: ProfileClient; cwd: string; fs?: ProfileFs },
): Promise<string> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return profileHelpText()
  }
  const fs = deps.fs ?? nodeFs
  const api = deps.client.agentProfiles
  const args = parseArgs(argv)
  const out = (data: unknown, text: string): string => (args.json ? JSON.stringify({ ok: true, data }) : text)

  switch (args.command) {
    case 'list': {
      allowOnly(args, [])
      if (args.positionals.length > 0) throw new ProfileCliError(`unexpected argument '${args.positionals[0]}'`)
      const profiles = (await api.list.query({})) as ProfileView[]
      return out(profiles, profiles.length > 0 ? profiles.map(renderLine).join('\n') : 'no agent profiles')
    }
    case 'show': {
      allowOnly(args, [])
      const profile = (await api.show.query({ ref: requireName(args) })) as ProfileView
      return out(profile, renderFull(profile))
    }
    case 'create': {
      allowOnly(args, ['description', 'candidate', 'machine', 'instructions', 'instructions-file'])
      const profile = (await api.create.mutate({
        name: requireName(args),
        ...fieldsFrom(args, fs, deps.cwd),
      })) as ProfileView
      return out(profile, `created profile ${renderLine(profile)}`)
    }
    case 'update': {
      allowOnly(args, ['description', 'candidate', 'machine', 'instructions', 'instructions-file', 'name'])
      const fields = fieldsFrom(args, fs, deps.cwd)
      const rename = one(args, 'name')
      if (rename !== undefined) fields.name = rename
      if (Object.keys(fields).length === 0) {
        throw new ProfileCliError('update: no fields given — nothing changed (see `podium profile --help`)')
      }
      const profile = (await api.update.mutate({ ref: requireName(args), ...fields })) as ProfileView
      return out(profile, `updated profile ${renderLine(profile)}`)
    }
    case 'delete': {
      allowOnly(args, [])
      const deleted = (await api.delete.mutate({ ref: requireName(args) })) as { name: string }
      return out(deleted, `deleted profile ${deleted.name}`)
    }
    case 'import': {
      allowOnly(args, [])
      const sources = args.positionals.length > 0 ? args.positionals : [DEFAULT_AGENTS_DIR]
      const paths = sources.flatMap((source) => {
        const full = resolve(deps.cwd, source)
        const listed = fs.listMarkdown(full)
        if (listed) return listed
        if (!full.endsWith('.md')) throw new ProfileCliError(`${source} is neither a directory nor a .md file`)
        return [full]
      })
      if (paths.length === 0) throw new ProfileCliError(`no .md files in ${sources.join(', ')}`)
      const results = (await api.import.mutate({
        files: paths.map((path) => ({ name: basename(path, '.md'), text: fs.readText(path) })),
      })) as Array<{ name: string; action: string }>
      return out(results, results.map((r) => `${r.action} ${r.name}`).join('\n'))
    }
    case 'export': {
      allowOnly(args, ['dir'])
      if (args.positionals.length > 1) throw new ProfileCliError(`unexpected argument '${args.positionals[1]}'`)
      const ref = args.positionals[0]
      const files = (await api.export.query(ref ? { ref } : {})) as Array<{ name: string; text: string }>
      const dir = resolve(deps.cwd, one(args, 'dir') ?? DEFAULT_AGENTS_DIR)
      fs.ensureDir(dir)
      const written = files.map((file) => {
        const path = join(dir, `${file.name}.md`)
        fs.writeText(path, file.text)
        return path
      })
      return out(written, written.length > 0 ? written.map((p) => `wrote ${p}`).join('\n') : 'no agent profiles')
    }
    default:
      throw new ProfileCliError(`unknown command '${args.command}' (see \`podium profile --help\`)`)
  }
}

export async function profileCliMain(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    console.log(profileHelpText())
    return
  }
  const relay = resolveAgentRelay()
  const client = (relay
    ? makeRelayIssueClient(relay)
    : makeOperatorIssueClient(localServerUrl(resolvePort()))) as unknown as ProfileClient
  try {
    console.log(await runProfileCli(argv, { client, cwd: process.cwd() }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium profile: ${message}`)
    process.exitCode = 1
  }
}

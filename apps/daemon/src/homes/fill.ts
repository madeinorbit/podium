/**
 * FILLING THE PODIUM HOME FROM THE PERSON'S FOLDER (managed installs §4.5):
 * "Take my settings". Run once when a managed install appears and again on
 * request.
 *
 * Copied: instructions, skills, agents, commands, plugins and MCP servers
 * (Claude Code's `mcpServers` into the home's `.claude.json`, Codex's
 * `[mcp_servers.*]` tables into the home's `config.toml`). Never copied:
 * permissions, folder trust, hooks, update settings, logins, conversations.
 * Posture supplies what a launch needs.
 *
 * - The person's folder is only read. Nothing is written there.
 * - Additive: an entry the home has and the person does not stays.
 * - A file is written only when its bytes change, so a second fill with
 *   nothing changed in between writes nothing.
 * - A link inside a copied folder stays a link; one that points into the
 *   person's folder is pointed at the same place in the home instead, so the
 *   managed binary never reads the person's folder through it (M9).
 * - What cannot be copied is left as it is and reported, never guessed.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { claudePodiumHomeFill, codexPodiumHomeFill } from '@podium/harness'
import type { HomeHarness } from '@podium/protocol'
import { planTomlTablesReplace, tomlTablesUnder } from '../harness-home-toml'

/** The person's side of one harness, read only. */
export interface PersonFolder {
  /** The harness's own directory: `~/.claude` (or `CLAUDE_CONFIG_DIR`), `~/.codex`. */
  dir: string
  /** Claude Code's state file (`~/.claude.json`), where its MCP servers are. */
  claudeState?: string
}

export interface FillReport {
  harness: HomeHarness
  /** Entries in which something was written. */
  copied: string[]
  /** Entries the person has that were already the same in the home. */
  unchanged: string[]
  /** Entries left as they were, and why. */
  left: { entry: string; reason: string }[]
}

/** The name of the record that the home was filled, inside the home. */
export const FILLED_RECORD = '.podium-home.json'

/** Whether this Podium home was filled at least once. */
export function wasFilled(homeDir: string): boolean {
  return existsSync(join(homeDir, FILLED_RECORD))
}

/** Fill the Podium home `homeDir` of `harness` from `person`. */
export function fillPodiumHome(
  harness: HomeHarness,
  person: PersonFolder,
  homeDir: string,
  now: () => Date = () => new Date(),
): FillReport {
  const report: FillReport = { harness, copied: [], unchanged: [], left: [] }
  const copy = new Copier(person.dir, homeDir)
  const entries =
    harness === 'claude-code' ? claudePodiumHomeFill[1].entries : codexPodiumHomeFill[1].entries
  for (const entry of entries) {
    const source = join(person.dir, entry)
    if (!existsSync(source)) continue
    const before = copy.writes
    const problems = copy.entry(source, join(homeDir, entry))
    for (const reason of problems) report.left.push({ entry, reason })
    if (copy.writes > before) report.copied.push(entry)
    else if (problems.length === 0) report.unchanged.push(entry)
  }
  if (harness === 'claude-code') {
    fillOne(report, 'settings.json', () => fillClaudeSettings(person.dir, homeDir))
    if (person.claudeState) {
      const personState = person.claudeState
      fillOne(report, '.claude.json mcpServers', () => fillClaudeServers(personState, homeDir))
    }
  } else {
    fillOne(report, 'config.toml mcp_servers', () => fillCodexServers(person.dir, homeDir))
  }
  record(homeDir, now)
  return report
}

/** `undefined`: nothing of the person's to copy; `true`/`false`: written or not. */
type Outcome = boolean | undefined | { reason: string }

function fillOne(report: FillReport, entry: string, run: () => Outcome): void {
  let outcome: Outcome
  try {
    outcome = run()
  } catch (err) {
    outcome = { reason: err instanceof Error ? err.message : String(err) }
  }
  if (outcome === undefined) return
  if (outcome === true) report.copied.push(entry)
  else if (outcome === false) report.unchanged.push(entry)
  else report.left.push({ entry, reason: outcome.reason })
}

/** Of the person's `settings.json`, only the plugin keys, merged into the home's. */
function fillClaudeSettings(personDir: string, homeDir: string): Outcome {
  const person = readJsonObject(join(personDir, 'settings.json'))
  if (person === 'absent') return undefined
  if (person === 'unreadable') return { reason: 'the person’s settings.json is not a JSON object' }
  const picked: Record<string, unknown> = {}
  for (const key of claudePodiumHomeFill[1].settingsKeys) {
    if (person[key] !== undefined) picked[key] = person[key]
  }
  if (Object.keys(picked).length === 0) return undefined
  const path = join(homeDir, 'settings.json')
  const home = readJsonObject(path)
  if (home === 'unreadable') return { reason: 'the home’s settings.json is not a JSON object' }
  return writeJsonIfChanged(path, home === 'absent' ? undefined : home, {
    ...(home === 'absent' ? {} : home),
    ...rewritePaths(picked, personDir, homeDir),
  })
}

/** The person's user-scope MCP servers into the home's `.claude.json`. */
function fillClaudeServers(personState: string, homeDir: string): Outcome {
  const person = readJsonObject(personState)
  if (person === 'absent') return undefined
  if (person === 'unreadable') return { reason: 'the person’s .claude.json is not a JSON object' }
  const servers = asObject(person.mcpServers)
  if (!servers || Object.keys(servers).length === 0) return undefined
  const path = join(homeDir, '.claude.json')
  const home = readJsonObject(path)
  // Claude mid-write, or a hand edit: rewriting it could drop the home's state.
  if (home === 'unreadable') return { reason: 'the home’s .claude.json is not a JSON object' }
  const current = home === 'absent' ? {} : home
  return writeJsonIfChanged(path, home === 'absent' ? undefined : home, {
    ...current,
    mcpServers: { ...asObject(current.mcpServers), ...servers },
  })
}

/** The person's `[mcp_servers.*]` tables into the home's `config.toml`. */
function fillCodexServers(personDir: string, homeDir: string): Outcome {
  const personPath = join(personDir, 'config.toml')
  if (!existsSync(personPath)) return undefined
  const lifted = tomlTablesUnder(readFileSync(personPath, 'utf8'), codexRoot())
  if ('reason' in lifted) return lifted
  if (lifted.tables.length === 0) return undefined
  const path = join(homeDir, 'config.toml')
  const body = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const planned = planTomlTablesReplace(body, codexRoot(), lifted.tables)
  if ('reason' in planned) return planned
  if (planned.next === body) return false
  writeAtomic(path, planned.next, 0o600)
  return true
}

const codexRoot = (): string[] => [...codexPodiumHomeFill[1].configTables]

/**
 * Copies one entry (a file or a folder) into the home, writing only what
 * differs. `writes` counts every write, so a caller can tell a change.
 */
class Copier {
  writes = 0

  constructor(
    private readonly personDir: string,
    private readonly homeDir: string,
  ) {}

  /** The problems met; the rest of the entry is still copied. */
  entry(source: string, target: string): string[] {
    const problems: string[] = []
    // The entry itself may be a link (a skills folder kept in dotfiles): its
    // contents are what the person has, so they are copied.
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(source)
    } catch {
      return [`${source} cannot be read`]
    }
    if (stat.isDirectory()) this.folder(source, target, problems)
    else if (stat.isFile()) this.file(source, target, stat.mode, problems)
    return problems
  }

  private folder(source: string, target: string, problems: string[]): void {
    const present = kindAt(target)
    if (present === 'link') {
      rmSync(target)
      this.writes += 1
    } else if (present && present !== 'dir') {
      problems.push(`${this.shown(target)} is not a folder in the home; left it`)
      return
    }
    if (!present || present === 'link') mkdirSync(target, { recursive: true, mode: 0o700 })
    let names: string[]
    try {
      names = readdirSync(source)
    } catch {
      problems.push(`${source} cannot be listed`)
      return
    }
    for (const name of names) {
      const from = join(source, name)
      const to = join(target, name)
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(from)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) this.link(from, to, problems)
      else if (stat.isDirectory()) this.folder(from, to, problems)
      else if (stat.isFile()) this.file(from, to, stat.mode, problems)
    }
  }

  private file(source: string, target: string, mode: number, problems: string[]): void {
    const present = kindAt(target)
    if (present === 'dir') {
      problems.push(`${this.shown(target)} is a folder in the home; left it`)
      return
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(source)
    } catch {
      problems.push(`${source} cannot be read`)
      return
    }
    // A plugin's record names the folder it was installed in: in the home it
    // must name the home's copy, not the person's.
    const contents = isPluginRecord(source, this.personDir)
      ? Buffer.from(rewriteJsonPaths(bytes.toString('utf8'), this.personDir, this.homeDir))
      : bytes
    const wantedMode = mode & 0o777
    if (present === 'file') {
      const same = readFileSync(target).equals(contents)
      const sameMode = (lstatSync(target).mode & 0o777) === wantedMode
      if (same && sameMode) return
      if (same) {
        chmodSync(target, wantedMode)
        this.writes += 1
        return
      }
    }
    if (present === 'link') rmSync(target)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeAtomic(target, contents, wantedMode)
    this.writes += 1
  }

  private link(source: string, target: string, problems: string[]): void {
    let pointsAt: string
    try {
      pointsAt = readlinkSync(source)
    } catch {
      problems.push(`${source} cannot be read`)
      return
    }
    const absolute = resolve(dirname(source), pointsAt)
    const wanted = inside(absolute, this.personDir)
      ? join(this.homeDir, relative(this.personDir, absolute))
      : pointsAt
    const present = kindAt(target)
    if (present === 'link') {
      if (readlinkSync(target) === wanted) return
      rmSync(target)
    } else if (present) {
      problems.push(`${this.shown(target)} is the home’s own; left it`)
      return
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    symlinkSync(wanted, target)
    this.writes += 1
  }

  private shown(target: string): string {
    return relative(this.homeDir, target)
  }
}

/** A JSON record directly in `plugins/` (installed plugins, marketplaces). */
function isPluginRecord(path: string, personDir: string): boolean {
  return dirname(path) === join(personDir, 'plugins') && path.endsWith('.json')
}

/** The text with every JSON string under `from` moved under `to`; unparsable text as it is. */
function rewriteJsonPaths(text: string, from: string, to: string): string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return text
  }
  const next = rewritePaths(value, from, to)
  return JSON.stringify(next) === JSON.stringify(value)
    ? text
    : `${JSON.stringify(next, null, 2)}\n`
}

function rewritePaths<T>(value: T, from: string, to: string): T {
  if (typeof value === 'string') {
    return (inside(value, from) ? join(to, relative(from, value)) : value) as T
  }
  if (Array.isArray(value)) return value.map((item) => rewritePaths(item, from, to)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewritePaths(item, from, to)]),
    ) as T
  }
  return value
}

function inside(path: string, dir: string): boolean {
  const resolved = resolve(dir)
  return resolve(path) === resolved || resolve(path).startsWith(`${resolved}${sep}`)
}

function kindAt(path: string): 'link' | 'dir' | 'file' | 'other' | undefined {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'link'
    if (stat.isDirectory()) return 'dir'
    return stat.isFile() ? 'file' : 'other'
  } catch {
    return undefined
  }
}

function readJsonObject(path: string): Record<string, unknown> | 'absent' | 'unreadable' {
  if (!existsSync(path)) return 'absent'
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8'))) ?? 'unreadable'
  } catch {
    return 'unreadable'
  }
}

function writeJsonIfChanged(
  path: string,
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): boolean {
  if (current && JSON.stringify(current) === JSON.stringify(next)) return false
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600)
  return true
}

function writeAtomic(path: string, contents: string | Buffer, mode: number): void {
  const temporary = `${path}.podium-${process.pid}`
  writeFileSync(temporary, contents, { mode })
  chmodSync(temporary, mode)
  renameSync(temporary, path)
}

function record(homeDir: string, now: () => Date): void {
  const path = join(homeDir, FILLED_RECORD)
  if (existsSync(path)) return
  writeAtomic(path, `${JSON.stringify({ filledAt: now().toISOString() })}\n`, 0o600)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

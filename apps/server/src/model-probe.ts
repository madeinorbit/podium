import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Live model enumeration. Some agent CLIs list the models the current login can use
 * (`grok models`, `cursor-agent models`, `opencode models`); others (claude, codex)
 * have no list command and the web falls back to its static catalog.
 *
 * Kept in apps/server (rather than @podium/agent-bridge) so the server needs no new
 * package dependency — it only shells out via PATH, which already resolves all three
 * CLIs on the deploy host. The lists are network-backed (~2s warm, ~7s cold), so the
 * ModelCatalog caches them stale-while-revalidate rather than probing on every open.
 */

export interface ModelChoice {
  value: string
  label: string
}

/** Agent kinds that can enumerate models → the argv that lists them. Keyed by the
 *  web/protocol agent kind ('cursor'), not the binary ('cursor-agent'). */
const MODEL_PROBES = {
  grok: ['grok', 'models'],
  cursor: ['cursor-agent', 'models'],
  opencode: ['opencode', 'models'],
} as const satisfies Record<string, readonly string[]>

export type ProbeableAgent = keyof typeof MODEL_PROBES

export const PROBEABLE_AGENTS = Object.keys(MODEL_PROBES) as ProbeableAgent[]

// ---- parsers (pure; one per CLI's output shape) ----

/** grok models → a marker list under "Available models:" (`* id (default)` / `- id`). */
export function parseGrokModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  let inList = false
  for (const raw of out.split('\n')) {
    if (/^available models:/i.test(raw.trim())) {
      inList = true
      continue
    }
    if (!inList) continue
    const m = raw.match(/^\s*[*-]\s+(\S+)/)
    if (m?.[1]) models.push({ value: m[1], label: m[1] })
  }
  return models
}

/** cursor-agent models → `id - Label` lines. Drops `auto` (the picker adds its own
 *  sentinel) and strips trailing "(current)"/"(default)" markers. */
export function parseCursorModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  for (const raw of out.split('\n')) {
    const m = raw.match(/^([A-Za-z0-9][\w.:/-]*)\s+-\s+(.+)$/)
    if (!m?.[1]) continue
    const value = m[1]
    if (value === 'auto') continue
    const label = (m[2] ?? '').replace(/\s*\((?:current|default)\)\s*$/i, '').trim()
    models.push({ value, label: label || value })
  }
  return models
}

/** opencode models → one `provider/model` id per line. */
export function parseOpencodeModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (/^[^\s/]+\/\S+$/.test(line)) models.push({ value: line, label: line })
  }
  return models
}

const PARSERS: Record<ProbeableAgent, (out: string) => ModelChoice[]> = {
  grok: parseGrokModels,
  cursor: parseCursorModels,
  opencode: parseOpencodeModels,
}

export function parseModels(kind: ProbeableAgent, out: string): ModelChoice[] {
  return PARSERS[kind](out)
}

/** Runs a probe argv → stdout. Injectable so tests never shell out. */
export type ProbeExec = (argv: readonly string[], timeoutMs: number) => Promise<string>

const defaultExec: ProbeExec = async (argv, timeoutMs) => {
  const [cmd, ...args] = argv
  const { stdout } = await execFileAsync(cmd as string, args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

export interface ProbeOptions {
  exec?: ProbeExec
  timeoutMs?: number
}

/** Enumerate one agent's models. Any failure (CLI absent, not logged in, timeout)
 *  resolves to [] so one broken agent never breaks the catalog. */
export async function probeAgentModels(
  kind: ProbeableAgent,
  opts: ProbeOptions = {},
): Promise<ModelChoice[]> {
  const exec = opts.exec ?? defaultExec
  const timeoutMs = opts.timeoutMs ?? 8000
  try {
    return parseModels(kind, await exec(MODEL_PROBES[kind], timeoutMs))
  } catch {
    return []
  }
}

/** Probe every enumerable agent in parallel (wall time ≈ the slowest CLI). */
export async function probeAllModels(
  opts: ProbeOptions = {},
): Promise<Record<string, ModelChoice[]>> {
  const entries = await Promise.all(
    PROBEABLE_AGENTS.map(async (k) => [k, await probeAgentModels(k, opts)] as const),
  )
  return Object.fromEntries(entries)
}

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Live model enumeration for every agent:
 *   grok/cursor/opencode → `<cli> models`
 *   codex                → `codex debug models` (JSON)
 *   claude               → Anthropic `GET /v1/models` with the Claude Code OAuth token
 *                          (~/.claude/.credentials.json; no separate API key)
 *
 * Kept in apps/server (rather than @podium/agent-bridge) so the server needs no new
 * package dependency — the CLIs resolve via PATH and the claude call is a raw fetch.
 * The lists are network-backed (~2s warm, ~7s cold), so the ModelCatalog caches them
 * stale-while-revalidate rather than probing on every open. Every source degrades to
 * [] on failure, and the web falls back to its static catalog per agent.
 */

export interface ModelChoice {
  value: string
  label: string
}

/** Agent kinds that can enumerate models → the argv that lists them. Keyed by the
 *  web/protocol agent kind ('cursor'), not the binary ('cursor-agent'). codex uses
 *  `codex debug models` (JSON; the only non-interactive path — `codex models` forwards
 *  to the TUI). claude/codex-less agents have no list command → the web static list. */
const MODEL_PROBES = {
  grok: ['grok', 'models'],
  cursor: ['cursor-agent', 'models'],
  opencode: ['opencode', 'models'],
  codex: ['codex', 'debug', 'models'],
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

/** codex debug models → `{ models: [{ slug, display_name, visibility, priority }] }`.
 *  Keep only user-selectable models (`visibility === 'list'` drops internal ones like
 *  codex-auto-review), ordered by the CLI's own priority. */
export function parseCodexModels(out: string): ModelChoice[] {
  try {
    const parsed = JSON.parse(out) as {
      models?: Array<{
        slug?: string
        display_name?: string
        visibility?: string
        priority?: number
      }>
    }
    return (parsed.models ?? [])
      .filter((m): m is { slug: string; display_name?: string; priority?: number } =>
        Boolean(m.slug && m.visibility === 'list'),
      )
      .sort(
        (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
      )
      .map((m) => ({ value: m.slug, label: m.display_name || m.slug }))
  } catch {
    return []
  }
}

const PARSERS: Record<ProbeableAgent, (out: string) => ModelChoice[]> = {
  grok: parseGrokModels,
  cursor: parseCursorModels,
  opencode: parseOpencodeModels,
  codex: parseCodexModels,
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

// ---- claude: no `models` CLI command, but the Anthropic Models API lists them ----

/** The OAuth access token the `claude` CLI already stores (subscription login; same
 *  token, no separate API key). Refreshed by Claude Code itself on use. */
async function readClaudeOAuthToken(): Promise<string | null> {
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth
      ?.accessToken
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** Minimal fetch shape (so tests can inject without the full DOM fetch type). */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface ClaudeProbeOptions {
  /** Injected token (tests). `undefined` = read from ~/.claude/.credentials.json; `null` = none. */
  token?: string | null
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/**
 * List Claude models via `GET https://api.anthropic.com/v1/models` using the Claude
 * Code OAuth token — a read-only metadata call (the same subscription the `claude` CLI
 * uses). Returns [] on any failure (no creds, expired/401 token, network) → the web
 * falls back to its static claude list. (The response also carries per-model
 * `capabilities.effort`, available for a future per-model effort picker.)
 */
export async function probeClaudeModels(opts: ClaudeProbeOptions = {}): Promise<ModelChoice[]> {
  const token = opts.token !== undefined ? opts.token : await readClaudeOAuthToken()
  if (!token) return []
  const fetchImpl = (opts.fetchImpl ?? (fetch as unknown as FetchLike)) as FetchLike
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: Array<{ id?: unknown; display_name?: unknown }> }
    return (body.data ?? [])
      .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
      .map((m) => ({
        value: m.id,
        label: typeof m.display_name === 'string' ? m.display_name : m.id,
      }))
  } catch {
    return []
  }
}

/** Probe every enumerable agent in parallel (wall time ≈ the slowest source). CLI
 *  agents via their `models` command; claude via the Anthropic Models API (OAuth). */
export async function probeAllModels(
  opts: ProbeOptions & { claude?: ClaudeProbeOptions } = {},
): Promise<Record<string, ModelChoice[]>> {
  const [cli, claude] = await Promise.all([
    Promise.all(PROBEABLE_AGENTS.map(async (k) => [k, await probeAgentModels(k, opts)] as const)),
    probeClaudeModels({ timeoutMs: opts.timeoutMs, ...opts.claude }),
  ])
  const byAgent: Record<string, ModelChoice[]> = Object.fromEntries(cli)
  if (claude.length > 0) byAgent['claude-code'] = claude
  return byAgent
}

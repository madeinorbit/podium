import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { claudeCodeDescriptor } from './adapters/claude-code/descriptor.js'
import { codexModelProbeArgv, parseCodexModels } from './adapters/codex/model-probe.js'
import { cursorModelProbeArgv, parseCursorModels } from './adapters/cursor/model-probe.js'
import { grokModelProbeArgv, parseGrokModels } from './adapters/grok/model-probe.js'
import { opencodeModelProbeArgv, parseOpencodeModels } from './adapters/opencode/model-probe.js'
import { parsePiModels, piModelProbeArgv } from './adapters/pi/model-probe.js'

const execFileAsync = promisify(execFile)

/**
 * Live model enumeration for every agent:
 *   grok/cursor/opencode → `<cli> models`
 *   codex                → `codex debug models` (JSON)
 *   claude               → Anthropic `GET /v1/models`, matching the agent's auth: an
 *                          Anthropic API key if the user runs API-based Claude, else
 *                          the Claude Code OAuth token (subscription; no separate key)
 *
 * Lives in @podium/harness (POD-1466) because BOTH hosts run it: the server for its
 * own machine, and each DAEMON for the machine it serves. A probe only ever reports
 * the CLIs installed on the host it executes on, so a remote machine's catalog has
 * to be built by that machine's daemon and shipped back (`modelProbeRequest` /
 * `modelProbeResult`) — the same shape `inventoryReport` already uses.
 *
 * CLI probes receive generation-resolved absolute paths; the Claude call is a raw fetch, so this stays a
 * dependency-free corner of the package. The lists are network-backed (~2s warm,
 * ~7s cold), so the ModelCatalog caches them per machineId (stale-while-revalidate)
 * rather than probing on every open. Every source degrades to [] on failure, and the
 * web falls back to its static catalog per agent. The catalog stamps the machineId
 * the caller named so two machines never share one snapshot.
 */

export interface ModelChoice {
  value: string
  label: string
  /** Reasoning-effort levels this specific model supports, when the source reports
   *  them authoritatively (claude `capabilities.effort`, codex `supported_reasoning_levels`).
   *  `[]` = the model supports no effort (e.g. claude haiku). `undefined` = unknown
   *  (grok/cursor/opencode don't expose it) → the web falls back to its agent-level list. */
  efforts?: string[]
}

/** Agent kinds that can enumerate models → the argv that lists them, stated by
 *  each adapter beside its own parser (POD-4737 D3). Keyed by the web/protocol
 *  agent kind ('cursor'), not the binary ('cursor-agent'). codex uses
 *  `codex debug models` (JSON; the only non-interactive path — `codex models`
 *  forwards to the TUI). claude/codex-less agents have no list command → the
 *  web static list. Keys stay bare identifiers (never quoted literals); every
 *  binary spelling lives in its adapter module. */
const MODEL_PROBES = {
  grok: grokModelProbeArgv,
  cursor: cursorModelProbeArgv,
  opencode: opencodeModelProbeArgv,
  codex: codexModelProbeArgv,
  pi: piModelProbeArgv,
} as const satisfies Record<string, readonly string[]>

export type ProbeableAgent = keyof typeof MODEL_PROBES

export const PROBEABLE_AGENTS = Object.keys(MODEL_PROBES) as ProbeableAgent[]

// ---- parsers (pure; one per CLI's output shape, owned by each adapter) ----

// Re-exported so existing readers (tests, catalog builders) keep working;
// the implementations live beside the adapters that own them.
export { parseCodexModels, parseCursorModels, parseGrokModels, parseOpencodeModels, parsePiModels }

const PARSERS: Record<ProbeableAgent, (out: string) => ModelChoice[]> = {
  grok: parseGrokModels,
  cursor: parseCursorModels,
  opencode: parseOpencodeModels,
  codex: parseCodexModels,
  pi: parsePiModels,
}

export function parseModels(kind: ProbeableAgent, out: string): ModelChoice[] {
  return PARSERS[kind](out)
}

/** Runs a probe argv → stdout. Injectable so tests never shell out. */
export type ModelProbeExec = (argv: readonly string[], timeoutMs: number) => Promise<string>

const makeDefaultExec =
  (env?: Readonly<Record<string, string>>): ModelProbeExec =>
  async (argv, timeoutMs) => {
    const [cmd, ...args] = argv
    const { stdout } = await execFileAsync(cmd as string, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      ...(env ? { env } : {}),
    })
    return stdout
  }

export interface ProbeOptions {
  exec?: ModelProbeExec
  timeoutMs?: number
  /** Absolute executable selected by the current harness-runtime generation. */
  executables?: Partial<Record<ProbeableAgent, string>>
  /** Exact command environment paired with those executables. */
  env?: Readonly<Record<string, string>>
  /** Credential home used only for Claude's OAuth state. */
  homeDir?: string
}

/** Enumerate one agent's models. Any failure (CLI absent, not logged in, timeout)
 *  resolves to [] so one broken agent never breaks the catalog. */
export async function probeAgentModels(
  kind: ProbeableAgent,
  opts: ProbeOptions = {},
): Promise<ModelChoice[]> {
  const exec = opts.exec ?? makeDefaultExec(opts.env)
  const timeoutMs = opts.timeoutMs ?? 8000
  const [, ...args] = MODEL_PROBES[kind]
  const command = opts.executables?.[kind] ?? (opts.exec ? MODEL_PROBES[kind][0] : undefined)
  if (!command) return []
  try {
    return parseModels(kind, await exec([command, ...args], timeoutMs))
  } catch {
    return []
  }
}

// ---- claude: no `models` CLI command, but the Anthropic Models API lists them ----

/** The OAuth access token the `claude` CLI already stores (subscription login; same
 *  token, no separate API key). Refreshed by Claude Code itself on use. */
async function readClaudeOAuthToken(homeDir?: string): Promise<string | null> {
  try {
    const raw = await readFile(join(homeDir ?? homedir(), '.claude', '.credentials.json'), 'utf8')
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
  /** API-based Claude: an Anthropic API key (from `apiKeys.anthropic` or
   *  `ANTHROPIC_API_KEY`). When set it wins over the OAuth token — mirroring how the
   *  `claude` CLI resolves auth — so the models listed match the account the agent runs on. */
  apiKey?: string | null
  /** Subscription Claude: the OAuth token. `undefined` = read
   *  ~/.claude/.credentials.json; `null` = none. */
  token?: string | null
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Where `.claude/.credentials.json` lives. Defaults to the process home; the
   *  daemon passes its own so a fixture home probes that home's login. */
  homeDir?: string
}

/**
 * List Claude models via `GET https://api.anthropic.com/v1/models` — a read-only
 * metadata call. Works for BOTH auth modes the user might run the agent with, with no
 * dedicated setting: an Anthropic API key (`x-api-key`) for API-based Claude, else the
 * Claude Code OAuth token (`Authorization: Bearer`) for subscription Claude. Returns []
 * on any failure (no creds, expired/401, network) → the web falls back to its static
 * claude list. (The response also carries per-model `capabilities.effort`, available
 * for a future per-model effort picker.)
 */
export async function probeClaudeModels(opts: ClaudeProbeOptions = {}): Promise<ModelChoice[]> {
  const apiKey = opts.apiKey || undefined
  const token = apiKey
    ? undefined
    : opts.token !== undefined
      ? opts.token
      : await readClaudeOAuthToken(opts.homeDir)
  const auth: Record<string, string> | null = apiKey
    ? { 'x-api-key': apiKey }
    : token
      ? { authorization: `Bearer ${token}` }
      : null
  if (!auth) return []
  const fetchImpl = (opts.fetchImpl ?? (fetch as unknown as FetchLike)) as FetchLike
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', {
      headers: { ...auth, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as {
      data?: Array<{ id?: unknown; display_name?: unknown; capabilities?: unknown }>
    }
    return (body.data ?? [])
      .filter(
        (m): m is { id: string; display_name?: string; capabilities?: unknown } =>
          typeof m.id === 'string',
      )
      .map((m) => ({
        value: m.id,
        label: typeof m.display_name === 'string' ? m.display_name : m.id,
        // Per-model effort from capabilities.effort; [] when the model has none
        // (e.g. haiku) — authoritative, so the web won't show a spurious effort picker.
        efforts: claudeEffortLevels(m.capabilities),
      }))
  } catch {
    return []
  }
}

/** Extract supported effort levels from an Anthropic model's `capabilities.effort`
 *  (`{ supported, low: {supported}, ... }`). Returns [] when effort is unsupported. */
function claudeEffortLevels(capabilities: unknown): string[] {
  const effort = (capabilities as { effort?: Record<string, { supported?: boolean } | boolean> })
    ?.effort
  if (!effort || (effort as { supported?: boolean }).supported === false) return []
  return Object.entries(effort)
    .filter(([k, v]) => k !== 'supported' && (v as { supported?: boolean })?.supported)
    .map(([k]) => k)
}

/** Probe every enumerable agent in parallel (wall time ≈ the slowest source). CLI
 *  agents via their `models` command; claude via the Anthropic Models API (OAuth). */
export async function probeAllModels(
  opts: ProbeOptions & { claude?: ClaudeProbeOptions } = {},
): Promise<Record<string, ModelChoice[]>> {
  const [cli, claude] = await Promise.all([
    Promise.all(PROBEABLE_AGENTS.map(async (k) => [k, await probeAgentModels(k, opts)] as const)),
    probeClaudeModels({
      timeoutMs: opts.timeoutMs,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      ...opts.claude,
    }),
  ])
  const byAgent: Record<string, ModelChoice[]> = Object.fromEntries(cli)
  // Keyed by the adapter's declared kind (POD-4737 D3), never a literal.
  if (claude.length > 0) byAgent[claudeCodeDescriptor.kind] = claude
  return byAgent
}

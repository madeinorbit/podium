import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import { claudeCodeDescriptor } from './adapters/claude-code/descriptor.js'
import {
  codexModelProbeArgv,
  codexModelProbeContainment,
  parseCodexModels,
} from './adapters/codex/model-probe.js'
import { cursorModelProbeArgv, parseCursorModels } from './adapters/cursor/model-probe.js'
import {
  grokModelProbeArgv,
  grokModelProbeContainment,
  parseGrokModels,
} from './adapters/grok/model-probe.js'
import {
  opencodeModelProbeArgv,
  opencodeModelProbeContainment,
  parseOpencodeModels,
} from './adapters/opencode/model-probe.js'
import {
  parsePiModels,
  piModelProbeArgv,
  piModelProbeContainment,
} from './adapters/pi/model-probe.js'
import type { HarnessContext } from './harness-context.js'
import type { HarnessAccountScope, HarnessRoots } from './manifest.js'

const execFileAsync = promisify(execFile)
const log = createLogger('harness:model-probe')

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
 * CLI probes run under each harness's ACCOUNT CONTEXT (POD-6534): the
 * installation's verified executable, with the environment the session child
 * gets for that account (account HOME, instance selectors, foreign
 * credentials stripped) — never the daemon's own HOME. The Claude call uses
 * fetch with the token from the account's credential folder.
 *
 * A listing in the PERSON'S OWN folders writes nothing there (POD-7390,
 * POD-7392): a harness measured to write its state while listing (Grok,
 * OpenCode, Codex, Pi) runs with its folders moved into a temporary folder,
 * reading the person's login and settings in place
 * ({@link ModelProbeContainment}). A Podium home is listed in place, since it
 * is Podium's folder.
 * The lists are network-backed (~2s warm,
 * ~7s cold), so the ModelCatalog caches them per machineId (stale-while-revalidate)
 * rather than probing on every open. CLI sources report [] on failure; Claude is
 * omitted when its lookup yields no models so the catalog keeps its last good list.
 * The catalog stamps the machineId
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

/** Runs a probe argv → stdout under `env` (the account env, when the probe
 *  has a context), in `cwd` when one is given (a contained probe's own empty
 *  folder). Injectable so tests never shell out. */
export type ModelProbeExec = (
  argv: readonly string[],
  timeoutMs: number,
  env?: Readonly<Record<string, string>>,
  cwd?: string,
) => Promise<string>

const defaultExec: ModelProbeExec = async (argv, timeoutMs, env, cwd) => {
  const [cmd, ...args] = argv
  const { stdout } = await execFileAsync(cmd as string, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    // Never the daemon's inherited env: the default exec only runs with a
    // context (see probeAgentModels), so this is always the account's.
    env: env ?? {},
    ...(cwd ? { cwd } : {}),
  })
  return stdout
}

/** The account a contained listing reads: its HOME, env and resolved folders. */
export interface ModelProbeScope {
  readonly home: string
  readonly env: Readonly<Record<string, string>>
  readonly roots: Readonly<HarnessRoots>
}

/**
 * HOW ONE HARNESS LISTS ITS MODELS WITHOUT WRITING THE PERSON'S FOLDERS
 * (POD-7390), stated by its adapter beside its probe argv. The listing runs
 * with `env` over the account env, in an empty working folder, inside a
 * temporary folder (`root`) removed afterwards.
 *
 * A login is never copied in (POD-7392): a harness that refreshes a login
 * rotates its refresh token, and a rotation saved into a copy is lost when the
 * folder goes, which signs the person out. A login is read in place through a
 * variable (`envWhenPresent`) or a link the harness is measured to write
 * through; where that cannot be made, the harness is listed in place, as
 * before containment.
 */
export interface ModelProbeContainment {
  /** Set over the account env: the harness's folders, moved under `root`. */
  readonly env: Readonly<Record<string, string>>
  /** Set only when the named path exists: a person's file the listing reads
   *  in place (a login, a cache), so a missing one is not invented. */
  readonly envWhenPresent?: Readonly<Record<string, string>>
  /** Arguments placed before the probe's own: a setting the contained listing
   *  must run with. The in-place listing runs without them. */
  readonly args?: readonly string[]
  /** The person's small read-only files copied in; a missing one is skipped. */
  readonly copies?: readonly { readonly from: string; readonly to: string }[]
  /** The person's files and folders linked in, so a write the harness makes to
   *  them (a refreshed login) lands on the original. A missing one is skipped,
   *  unless `evenWhenMissing`: a lock file the harness creates on first use,
   *  linked so the listing and the person's own harness take the same lock.
   *  Where a link cannot be made (Windows without the privilege), the harness
   *  is listed in place. */
  readonly links?: readonly {
    readonly from: string
    readonly to: string
    readonly evenWhenMissing?: boolean
  }[]
  /** The person's files a contained listing needs; without one, the harness
   *  is listed in place. */
  readonly requires?: readonly string[]
  /** The harness is listed in place when one of the person's files matches:
   *  a setting under which a contained listing would not reach their login. */
  readonly inPlaceWhen?: readonly { readonly path: string; readonly pattern: RegExp }[]
}

/**
 * The harnesses measured to write their state during a model listing, and how
 * each is contained. A harness absent here is listed as before (Cursor: its
 * listing writes only its install's own `.running` marker, design §9).
 */
const MODEL_PROBE_CONTAINMENT: Partial<
  Record<ProbeableAgent, (scope: ModelProbeScope, root: string) => ModelProbeContainment>
> = {
  grok: grokModelProbeContainment,
  opencode: opencodeModelProbeContainment,
  codex: codexModelProbeContainment,
  pi: piModelProbeContainment,
}

export interface ProbeOptions {
  exec?: ModelProbeExec
  timeoutMs?: number
  /**
   * The account context per CLI-probed harness (POD-6534): the installation's
   * verified executable runs with the account env. A harness without a
   * context (not installed in this generation) is not probed.
   */
  contexts?: Partial<Record<ProbeableAgent, HarnessContext>>
}

/** Enumerate one agent's models. Any failure (CLI absent, not logged in, timeout)
 *  resolves to [] so one broken agent never breaks the catalog. */
export async function probeAgentModels(
  kind: ProbeableAgent,
  opts: ProbeOptions = {},
): Promise<ModelChoice[]> {
  const exec = opts.exec ?? defaultExec
  const timeoutMs = opts.timeoutMs ?? 8000
  const [, ...args] = MODEL_PROBES[kind]
  const context = opts.contexts?.[kind]
  // An injected exec with no context is the unit-test seam: it is handed the
  // adapter's own argv and never reaches a process.
  const command =
    context?.installation.executable ?? (opts.exec ? MODEL_PROBES[kind][0] : undefined)
  if (!command) return []
  // The person's own folders are contained; a Podium home is Podium's folder
  // and is listed in place (credential management §10).
  const contain = context && !context.harnessHome ? MODEL_PROBE_CONTAINMENT[kind] : undefined
  if (context && contain) {
    const listed = await probeContained(kind, command, args, context, contain, exec, timeoutMs)
    if (listed !== IN_PLACE) return listed
  }
  try {
    return parseModels(kind, await exec([command, ...args], timeoutMs, context?.env))
  } catch {
    return []
  }
}

/** {@link probeContained}'s answer when the harness is to be listed in place. */
const IN_PLACE = Symbol('in place')

/**
 * One model listing in a temporary folder (POD-7390): the person's own install
 * still answers with their account's models, and every file the listing writes
 * lands in the folder, which is removed afterwards.
 *
 * A machine where the folder cannot be made reports no models rather than
 * listing in the person's folders: the catalog keeps its last good list.
 * Where the person's login cannot be reached from the folder, the harness is
 * listed in place ({@link ModelProbeContainment}).
 */
async function probeContained(
  kind: ProbeableAgent,
  command: string,
  args: readonly string[],
  context: HarnessContext,
  contain: (scope: ModelProbeScope, root: string) => ModelProbeContainment,
  exec: ModelProbeExec,
  timeoutMs: number,
): Promise<ModelChoice[] | typeof IN_PLACE> {
  let root: string
  try {
    root = await mkdtemp(join(tmpdir(), `podium-models-${kind}-`))
  } catch (err) {
    log.warn('no temporary folder for the model listing; not listed', { kind, err })
    return []
  }
  try {
    const containment = contain(context, root)
    const inPlace = await inPlaceReason(containment)
    if (inPlace) {
      log.debug('model listing runs in place', { kind, reason: inPlace })
      return IN_PLACE
    }
    const work = join(root, 'work')
    await mkdir(work)
    const env: Record<string, string> = { ...context.env, ...containment.env }
    for (const [variable, path] of Object.entries(containment.envWhenPresent ?? {})) {
      if (await present(path)) env[variable] = path
    }
    for (const { from, to } of containment.copies ?? []) {
      if (!(await present(from))) continue
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
    }
    for (const { from, to, evenWhenMissing } of containment.links ?? []) {
      const source = await lstat(from).catch(() => undefined)
      if (!source && !evenWhenMissing) continue
      await mkdir(dirname(to), { recursive: true })
      try {
        // A folder is linked as a junction on Windows, which needs no privilege.
        await symlink(from, to, source?.isDirectory() ? 'junction' : 'file')
      } catch (err) {
        log.debug('model listing runs in place: no link to the person’s file', { kind, err })
        return IN_PLACE
      }
    }
    const argv = [command, ...(containment.args ?? []), ...args]
    return parseModels(kind, await exec(argv, timeoutMs, Object.freeze(env), work))
  } catch {
    return []
  } finally {
    await rm(root, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn('the model listing folder could not be removed', { path: root, err })
    })
  }
}

/** Why a containment's harness is listed in place instead, if it is. */
async function inPlaceReason(containment: ModelProbeContainment): Promise<string | undefined> {
  for (const path of containment.requires ?? []) {
    if (!(await present(path))) return `no ${path}`
  }
  for (const { path, pattern } of containment.inPlaceWhen ?? []) {
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text !== undefined && pattern.test(text)) return `a setting in ${path}`
  }
  return undefined
}

async function present(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  )
}

// ---- claude: no `models` CLI command, but the Anthropic Models API lists them ----

/** The OAuth access token the `claude` CLI already stores (subscription login; same
 *  token, no separate API key). Refreshed by Claude Code itself on use. Read
 *  from the ACCOUNT's credential folder (`roots.credentials`, which honours
 *  `CLAUDE_CONFIG_DIR` in the account env exactly as the credential layout
 *  does). The macOS Keychain copy is not read here. */
async function readClaudeOAuthToken(account: HarnessAccountScope): Promise<string | null> {
  try {
    const dir = account.roots.credentials ?? account.roots.state
    const raw = await readFile(join(dir, '.credentials.json'), 'utf8')
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
  /** Subscription Claude: the OAuth token. `undefined` = read it from
   *  `account`'s credential folder; `null` = none. */
  token?: string | null
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** The Claude account whose OAuth login is read (POD-6534). Absent with no
   *  `token`: no credential, no call — never the process home. */
  account?: HarnessAccountScope
}

/**
 * List Claude models via `GET https://api.anthropic.com/v1/models` — a read-only
 * metadata call. Works for BOTH auth modes the user might run the agent with, with no
 * dedicated setting: an Anthropic API key (`x-api-key`) for API-based Claude, else the
 * Claude Code OAuth token (`Authorization: Bearer`) for subscription Claude. Returns []
 * on any failure (no creds, expired/401, network). `probeAllModels` omits the Claude
 * key in that case so ModelCatalog can retain the last good models and efforts.
 */
export async function probeClaudeModels(opts: ClaudeProbeOptions = {}): Promise<ModelChoice[]> {
  const apiKey = opts.apiKey || undefined
  const token = apiKey
    ? undefined
    : opts.token !== undefined
      ? opts.token
      : opts.account
        ? await readClaudeOAuthToken(opts.account)
        : null
  const auth: Record<string, string> | null = apiKey
    ? { 'x-api-key': apiKey }
    : token
      ? { authorization: `Bearer ${token}` }
      : null
  if (!auth) {
    log.debug('Claude model probe skipped: no credentials')
    return []
  }
  const fetchImpl = (opts.fetchImpl ?? (fetch as unknown as FetchLike)) as FetchLike
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', {
      headers: { ...auth, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    })
    if (!res.ok) {
      log.warn('Claude model probe rejected', { status: res.status })
      return []
    }
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
  } catch (err) {
    log.warn('Claude model probe failed', { err })
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
  opts: ProbeOptions & {
    claude?: ClaudeProbeOptions
    /** Builds the Claude account when `claude.account` is not given: the
     *  caller names no harness, the probe asks for its own kind. */
    accountFor?: (kind: string) => HarnessAccountScope
  } = {},
): Promise<Record<string, ModelChoice[]>> {
  const claudeAccount = opts.claude?.account ?? opts.accountFor?.(claudeCodeDescriptor.kind)
  const [cli, claude] = await Promise.all([
    Promise.all(PROBEABLE_AGENTS.map(async (k) => [k, await probeAgentModels(k, opts)] as const)),
    probeClaudeModels({
      timeoutMs: opts.timeoutMs,
      ...opts.claude,
      ...(claudeAccount ? { account: claudeAccount } : {}),
    }),
  ])
  const byAgent: Record<string, ModelChoice[]> = Object.fromEntries(cli)
  // Keyed by the adapter's declared kind (POD-4737 D3), never a literal.
  if (claude.length > 0) byAgent[claudeCodeDescriptor.kind] = claude
  return byAgent
}

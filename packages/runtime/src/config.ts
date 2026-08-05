/**
 * Install config + THE layered config resolver (#251).
 *
 * Precedence — ONE order, everywhere: env (PODIUM_*) → file (config.json) → built-in
 * default. A third, server-side-only layer exists for a few keys: a settings ROW in
 * podium.db can override/extend at request time (e.g. `apiKeys.anthropic`); that layer
 * is applied by apps/server where the settings store lives — never here. Each resolved
 * key gets a typed accessor below (`resolvePort`, `resolveUpdateChannel`, …) so callers
 * stop hand-rolling `process.env.X ?? config.y ?? default` with drifting precedence.
 *
 * PODIUM_* environment-variable inventory (the full set, including keys whose
 * accessors deliberately live elsewhere):
 *
 * | Variable                      | Layered over            | Read by / accessor                                     |
 * |-------------------------------|-------------------------|--------------------------------------------------------|
 * | PODIUM_INSTANCE               | — → default             | global selector; state/ports/runtime/services [spec:SP-15aa] |
 * | PODIUM_STATE_DIR              | — (env-only)            | `stateDir()` (config/run-registry/logs home)           |
 * | PODIUM_PORT                   | config.port → per-id    | `resolvePort()` (cli, scripts entrypoints)             |
 * | PODIUM_HOOK_PORT              | config.hookPort → per-id| `resolveHookPort()` (daemon hook ingest)                |
 * | PODIUM_AGENT_RELAY_PORT       | config.agentRelayPort   | `resolveAgentRelayPort()` (daemon CLI relay)            |
 * | PODIUM_AGENT_HOME             | config.agentHome        | `resolveAgentHomeDir()` (native runtime/history)       |
 * | PODIUM_ADOPT_STATE            | — (env-only flag)       | explicit adoption of named non-empty state roots       |
 * | PODIUM_HOST                   | — → 127.0.0.1           | apps/server bindHost (injectable env param)            |
 * | PODIUM_PASSWORD               | — (env-only, one-shot)  | apps/server applyEnvPassword (headless deploy seam)    |
 * | PODIUM_UPDATE_CHANNEL         | config.updateChannel    | `resolveUpdateChannel()`                               |
 * | DO_NOT_TRACK                  | — (env-only kill switch)| @podium/telemetry `telemetrySuppressedBy()` [SP-f933]  |
 * | PODIUM_TELEMETRY              | — (env-only kill switch)| `=off` suppresses sending AND the setup prompt         |
 * | PODIUM_TELEMETRY_ENDPOINT     | config.telemetry.endpoint| @podium/telemetry `resolveTelemetryEndpoint()`         |
 * | PODIUM_UPDATE_FEED            | config.updateFeed       | `resolveUpdateFeed()`                                  |
 * | PODIUM_UPDATE_TARGET          | — → 'linux-x86_64'      | `resolveUpdateTarget()`                                |
 * | PODIUM_HOME                   | — → dirname(execPath)   | `resolveInstallDir()` (headless launcher exports it)   |
 * | PODIUM_RUN_MODE               | — (env-only)            | `resolveRunRecordMode()` ('detached' set by cli-spawn) |
 * | NOTIFY_SOCKET (systemd's)     | — (env-only)            | `resolveRunRecordMode()`, sd-notify                    |
 * | PODIUM_AGENT_RELAY            | — (env-only)            | `resolveAgentRelay()` (daemon-injected per AGENT)      |
 * | PODIUM_SESSION_RELAY          | — (env-only)            | `resolveSessionRelay()` (per SESSION, shells included) |
 * | PODIUM_NO_RELAY               | — (env-only flag)       | both resolvers (shed inherited relay; escape hatch)    |
 * | PODIUM_ISSUE_RELAY            | — (env-only, LEGACY)    | `resolveAgentRelay()` read-only alias (dual-read, 1 rel)|
 * | PODIUM_SESSION_ID             | — (env-only)            | daemon-injected agent identity (control/session.ts)    |
 * | PODIUM_BOOT_TIMEOUT_MS        | — → 45000               | boot.ts boot watchdog                                  |
 * | PODIUM_LOOP_PROFILE           | — (env-only flag)       | server + daemon event-loop profiling                   |
 * | PODIUM_APP_VERSION            | — (BUILD-time --define) | server /version; must stay a literal `process.env.…`   |
 * | PODIUM_WEB_DIR                | — → bundled dist path   | apps/server static web (packaged bundle sets it)       |
 * | PODIUM_MOBILE_WEB_DIR         | — → bundled dist path   | apps/server static mobile web                          |
 * | PODIUM_PTY_BACKEND            | — → auto by runtime     | agent-bridge PTY backend selection                     |
 * | PODIUM_ABDUCO                 | — → embedded/PATH       | agent-bridge/embedded-abduco binary override           |
 * | PODIUM_NO_SCOPE               | — (env-only flag)       | agent-bridge: skip per-master systemd-run scopes       |
 * | PODIUM_CODEX_HOOK_*           | — (env-only)            | daemon codex hook plumbing (codex-hooks.ts)            |
 * | PODIUM_CLOUD_*                | — (env-only)            | apps/server cloud-runtime seam (hosted provider)       |
 * | PODIUM_UPDATE_SIGNING_KEY     | — (env-only)            | scripts/build-bun.ts + release tooling                 |
 * | PODIUM_INSTALL_PUBKEY         | — (env-only)            | install.sh signed-install override                     |
 * | PODIUM_UPDATE_AUTOCONFIRM     | — (env-only flag)       | desktop updater verification script                    |
 * | PODIUM_ALLOWED_HOSTS          | — (env-only)            | apps/web vite dev-server host check                    |
 * | PODIUM_WEB_PORT               | — → 55556               | apps/web vite dev-server port                          |
 * | test-only: PODIUM_STUB_*, PODIUM_SKIP_*, PODIUM_GROK_CHAT_OK, PODIUM_CURL_LOG,      |
 * |   PODIUM_DISCOVERY_BENCH_DB, PODIUM_FEED_PORT, PODIUM_HEADLESS_FEED_PORT — fixtures |
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  assertInstanceStateIdentity,
  defaultInstancePorts,
  ensureInstanceStateIdentity,
  instanceStateDir,
  resolveInstanceId,
} from './instance'

export { resolveInstanceId, selectInstance } from './instance'

/** Deployment mode chosen at setup. Unset = not yet configured. */
export const PodiumMode = z.enum(['all-in-one', 'daemon', 'client', 'server'])
export type PodiumMode = z.infer<typeof PodiumMode>

/**
 * THE CONFIG SCHEMA VERSION — bumped by any migration below.
 *
 * Why a version field exists at all (POD-333): without one, "the config does not
 * say X" is ambiguous between *this deployment does not want X* and *this file
 * predates X*, and the CLI resolved that ambiguity by carrying MIGRATION STATES
 * IN THE LAUNCH PLAN. Two of `LaunchPlan`'s variants existed only to repair a
 * config shape — `reconcile-pending-persistence` and `interactive-setup`'s
 * `incomplete-headless-config` reason — so every reader of the launch matrix had
 * to know the history of the config format to know which branches were real.
 *
 * With a version, absence is an answer: a v2 config that names no `persistence`
 * is a box that is not headless-managed (the desktop sidecar), full stop. A
 * pre-v2 file that names none is migrated ONCE, at load, and then it is a v2
 * config like any other. A config is either current or migrated; it is never
 * special-cased downstream.
 *
 * v1 = the unversioned original (no `configVersion` key).
 * v2 = `pendingPersistence` folded into `persistence` — see CONFIG_MIGRATIONS.
 */
export const CURRENT_CONFIG_VERSION = 2

/** Persisted install config — the single source of truth shared by the CLI and the
 *  (later) Tauri shell. `serverUrl` is a ws://|wss:// relay URL for daemon/client modes. */
export const PodiumConfig = z.object({
  /**
   * Schema version. OPTIONAL, and absent means v1 — the unversioned original.
   * It is stamped by {@link saveConfig}, so the only files without it are ones
   * written before POD-333, which is exactly the population the migrations
   * target. A required field with a default would make every legacy file claim
   * to be current, which is the failure this field exists to prevent.
   */
  configVersion: z.number().int().positive().optional(),
  mode: PodiumMode.optional(),
  serverUrl: z.string().optional(),
  port: z.number().int().positive().optional(),
  /** Stable daemon hook-ingest endpoint; env PODIUM_HOOK_PORT wins. */
  hookPort: z.number().int().positive().optional(),
  /** Stable per-session CLI relay endpoint; env PODIUM_AGENT_RELAY_PORT wins. */
  agentRelayPort: z.number().int().positive().optional(),
  /** Native agent HOME/history root. Explicit values opt into sharing that root. */
  agentHome: z.string().min(1).optional(),
  /** One-shot pairing code for daemon mode (consumed once → token; a stale value is harmless). */
  pairCode: z.string().optional(),
  /** Whether this joined daemon is a Podium-managed host (default true). */ podiumManaged: z
    .boolean()
    .optional(),
  /** Base URL of the self-update feed (`podium update`). Env PODIUM_UPDATE_FEED wins. */
  updateFeed: z.string().optional(),
  /** Self-update channel for the headless build (desktop is always stable). Default 'stable'. */
  updateChannel: z.enum(['stable', 'edge']).optional(),
  /** Externally-reachable base URL captured at setup; embedded into machine join tokens. */
  publicUrl: z.string().optional(),
  /**
   * How the headless backend is kept running, chosen at setup (docs/internal/superpowers/specs/
   * 2026-07-06-headless-process-model-design.md): `systemd` = supervised `--user` units that
   * survive reboot; `detached` = setsid spawn-and-forget (survives logout, dies on reboot).
   * ABSENT = not a headless-managed install: the desktop sidecar, or a plain
   * foreground run. Since v2 that is the field's ONLY meaning — "pre-dates the
   * choice" was the second meaning, and it is what {@link CONFIG_MIGRATIONS}
   * removes.
   *
   * It records the CHOICE, not whether the backend is currently up under it.
   * Liveness is a run-registry question and is answered there; conflating the
   * two is what produced `pendingPersistence` (v1), a second field meaning
   * "chosen but not yet applied".
   */
  persistence: z.enum(['systemd', 'detached']).optional(),
  // RETIRED at POD-309 (ADR 5 D8 "Retirement"): `upstream: { url, token }` named the hub
  // a NODE dialed. Federation is deferred ([spec:SP-0371]), the dialer is deleted, and a
  // config key nothing reads is a promise the binary does not keep. The key is NOT
  // re-reserved as an inert optional: zod objects strip unknown keys by default, so an
  // operator's stale `upstream` block loads WITHOUT crash-looping the box (it is dropped
  // from the file on the next `saveConfig`, which is the honest outcome for a retired
  // key rather than a field pretending to still do something). `config.test.ts` pins
  // both halves. A future hub (POD-353) re-declares it, with a live reader.
  /**
   * Operator feature-flag overrides [spec:SP-f4b9]. Keys are stable feature ids
   * from the protocol registry (`FEATURES`); values force enable/disable and
   * lock the Experimental UI toggle. Config-file only — there is deliberately
   * no `PODIUM_FEATURES` env layer (hidden flags are enableable only via this
   * file, except in development mode where they are listed).
   */
  features: z.record(z.string(), z.boolean()).optional(),
  /**
   * INSTANCE LOGIN POLICY (POD-1554). `openMode: true` means *this instance serves
   * everything without a login* — the loopback / all-in-one default, and a regime an
   * operator can deliberately return to. Absent and `false` both mean login is required
   * whenever any account has a credential.
   *
   * It lives HERE, and it is NOT credential deletion, which was the alternative. Deleting
   * every credential would keep one source of truth, but it makes an ADMIN's instance-level
   * choice destroy other people's passwords, and turning login back on would make everyone
   * re-enrol. A flag is reversible: flip it back and every account's password still works.
   *
   * The cost — two pieces of state behind one question — is contained by there being ONE
   * reader that joins them (`credentialsRequired()` in apps/server/src/server.ts, passed to
   * every gate as `loginRequired`). Nothing else may read this key and conclude anything
   * about whether a request needs a session.
   *
   * Config-file-and-command only: there is deliberately no `PODIUM_OPEN_MODE` env layer.
   * "Serve with no authentication" is not something a stray environment variable should be
   * able to turn on.
   */
  auth: z
    .object({
      openMode: z.boolean().optional(),
    })
    .optional(),
  /**
   * Opt-in telemetry consent + identity [spec:SP-f933]. Lives HERE rather than
   * in the settings blob so `podium telemetry off` works whether or not the
   * server is running — and so a user can turn it off with a text editor.
   *
   * Each tier is TRI-state: `on` | `off` | ABSENT. Absent and `off` both send
   * nothing; absent additionally means "never asked", which is what lets
   * `podium setup` know to ask. Nothing is ever sent unless a tier is
   * explicitly `on` — and DO_NOT_TRACK=1 / PODIUM_TELEMETRY=off override even
   * that (env kill switches, resolved in @podium/telemetry's consent.ts, which
   * is also the only writer of this key).
   *
   * `installId` + `since` are minted on the first OPT-IN, never at install and
   * never by an opt-out: a user who says no never gets an identifier. The
   * `endpoint` override is the config layer of the relay-URL precedence
   * (PODIUM_TELEMETRY_ENDPOINT → here → signed update manifest → baked-in).
   */
  telemetry: z
    .object({
      /** Random UUIDv4 (not derived from the machine); `podium telemetry reset-id` rotates it. */
      installId: z.string().uuid().optional(),
      /** Epoch ms the clock started — set with installId on first opt-in (D5). */
      since: z.number().int().positive().optional(),
      usage: z.enum(['on', 'off']).optional(),
      crash: z.enum(['on', 'off']).optional(),
      endpoint: z.string().optional(),
    })
    .optional(),
})
export type PodiumConfig = z.infer<typeof PodiumConfig>

/** The Podium state directory: $PODIUM_STATE_DIR, else ~/.podium. Home for config.json, the
 *  run registry (run/), logs (logs/), etc. */
export function stateDir(): string {
  return instanceStateDir()
}

/** $PODIUM_STATE_DIR/config.json, else ~/.podium/config.json. */
export function configPath(): string {
  return join(stateDir(), 'config.json')
}

export interface ConfigInspection {
  /** missing = fresh box; ok = parsed; corrupt = a file EXISTS but won't parse/validate. */
  state: 'missing' | 'ok' | 'corrupt'
  config: PodiumConfig
  /** The JSON/zod failure, when corrupt. */
  error?: string
  /**
   * Migrations applied to reach {@link CURRENT_CONFIG_VERSION}, in order, by
   * `describe`. Empty on a current file. The CLI entry point persists the result
   * once when this is non-empty — see {@link migrateConfig} on why the WRITE is
   * not done here.
   */
  migrated: string[]
}

// ---------------------------------------------------------------------------
// One-shot migrations (POD-333)
// ---------------------------------------------------------------------------

/**
 * One step from version `to - 1` to `to`, applied to the RAW parsed JSON.
 *
 * Raw, not a `PodiumConfig`: zod strips unknown keys, so a migration reading a
 * key the current schema no longer declares (`pendingPersistence` is exactly
 * that) would find it already gone if it ran after parsing. Migrations run
 * BEFORE validation for that reason, and the result is validated afterwards —
 * so a migration that produces a malformed config fails loudly at the same place
 * a hand-edited one does.
 */
export interface ConfigMigration {
  /** The version this step produces. */
  to: number
  /**
   * One line for the load-time log and the ledger.
   *
   * It names WHAT THE VERSION MEANS, not the edit performed — because a step
   * legitimately runs on a config it does not change. A v1 desktop-sidecar
   * config has no `pendingPersistence` to fold, but it is still migrated: at v2
   * its absent `persistence` stops being ambiguous and starts meaning
   * "unmanaged". Phrased as the edit ("folded pendingPersistence into
   * persistence"), the load-time message told that box something untrue about
   * itself.
   */
  describe: string
  apply(raw: Record<string, unknown>): Record<string, unknown>
}

export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  {
    to: 2,
    describe: 'v2: persistence is one field, and absent means not headless-managed',
    /**
     * v1 recorded a persistence INTENT separately from the persistence itself:
     * the web setup (`setup.complete` / `setup.join`) runs inside the serving
     * process and cannot self-daemonize — stopping the old backend would kill
     * the request in flight — so it wrote `pendingPersistence` and left the next
     * `podium` invocation to "reconcile" it (issue #20).
     *
     * The split was the mistake. `persistence` is the operator's CHOICE, and it
     * was chosen the moment the web setup wrote it down; whether a backend is
     * currently running under that choice is a RUN-REGISTRY question, and the
     * managed launch paths already answer it. Two fields for one fact meant the
     * launch resolver had to branch on which of them was set, which is the
     * migration state POD-333 deletes.
     *
     * `persistence` wins if both are somehow present: it is the fulfilled one.
     */
    apply(raw) {
      const { pendingPersistence, ...rest } = raw
      if (typeof rest.persistence === 'string') return rest
      if (pendingPersistence === 'systemd' || pendingPersistence === 'detached') {
        return { ...rest, persistence: pendingPersistence }
      }
      return rest
    },
  },
]

/**
 * Bring a raw config object up to {@link CURRENT_CONFIG_VERSION}, in order.
 *
 * PURE, and it does not write. The write is the caller's, and deliberately: this
 * runs on every `loadConfig` in every process — server, daemon, janitor, each
 * CLI invocation — and a loader that rewrites the file would have N processes
 * racing to save the same result on every boot. The CLI entry point persists it
 * once (`migrateConfigFile`); everyone else gets the migrated shape in memory
 * and never has to know which version the file is at.
 *
 * Idempotent by construction: a config already at the current version applies no
 * steps, and re-running a step on its own output is a no-op (asserted in
 * config.test.ts, because "the migration ran twice" is the normal outcome of the
 * in-memory design above).
 */
export function migrateConfig(raw: unknown): {
  config: Record<string, unknown>
  applied: string[]
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: {}, applied: [] }
  }
  let config = { ...(raw as Record<string, unknown>) }
  // Absent = v1, the unversioned original. A non-numeric value is treated the
  // same rather than trusted: a hand-edited `"configVersion": "2"` must not skip
  // migrations by claiming to be current.
  const from = typeof config.configVersion === 'number' ? config.configVersion : 1
  const applied: string[] = []
  for (const migration of CONFIG_MIGRATIONS) {
    if (migration.to <= from) continue
    config = migration.apply(config)
    applied.push(migration.describe)
  }
  // A file from a NEWER Podium keeps its own version rather than being stamped
  // backwards: downgrading the number would make the next run of the old binary
  // re-apply migrations it already has.
  config.configVersion = Math.max(from, CURRENT_CONFIG_VERSION)
  return { config, applied }
}

/**
 * Read the config WITHOUT collapsing "corrupt" into "missing" (issue #21): callers that
 * would overwrite the file (setup flows) must distinguish a fresh box from a broken file —
 * silently re-setting-up over a corrupt config destroys whatever the operator had.
 */
export function inspectConfig(path = configPath()): ConfigInspection {
  assertInstanceStateIdentity(resolveInstanceId(), dirname(path))
  try {
    // Migrate BEFORE validating: zod strips unknown keys, so a step reading a
    // field the current schema no longer declares must see the raw object.
    const { config, applied } = migrateConfig(JSON.parse(readFileSync(path, 'utf8')))
    return { state: 'ok', config: PodiumConfig.parse(config), migrated: applied }
  } catch (err) {
    // Read directly instead of preflighting with existsSync: besides removing a
    // TOCTOU window, this keeps config reads reliable in syscall-emulated Linux
    // environments where statx may be unavailable while open/read still works.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing', config: {}, migrated: [] }
    }
    // A ZodError's message is the full issues array as JSON — condense it to
    // one `path: message` line per issue so boot logs stay readable.
    const error =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : err instanceof Error
          ? err.message
          : String(err)
    return { state: 'corrupt', config: {}, error, migrated: [] }
  }
}

/** Read + validate the config; a missing file yields {}. A CORRUPT file also yields {}
 *  (boot must not crash-loop on it) but is logged LOUDLY (#21) — it used to be silent. */
export function loadConfig(path = configPath()): PodiumConfig {
  const res = inspectConfig(path)
  if (res.state === 'corrupt') {
    console.error(
      `[podium] ${path} exists but is invalid — treating this box as unconfigured. ` +
        `Fix the file or run \`podium setup --repair\`. (${res.error})`,
    )
  }
  return res.config
}

/** Validate + write the config (pretty JSON). Throws on an invalid config — including a
 *  daemon/client mode without a serverUrl, which would exit-2 crash-loop at boot under
 *  Restart=always; catch it at SAVE time instead (#21). */
export function saveConfig(config: PodiumConfig, path = configPath()): void {
  // Stamp the version on every write, so a file this binary has touched is never
  // re-migrated. Callers do not pass it — a caller that had to remember would
  // eventually forget, and the forgotten case is silent.
  const parsed = PodiumConfig.parse({ ...config, configVersion: CURRENT_CONFIG_VERSION })
  ensureInstanceStateIdentity({ dir: dirname(path) })
  if ((parsed.mode === 'daemon' || parsed.mode === 'client') && !parsed.serverUrl) {
    throw new Error(
      `refusing to save a mode=${parsed.mode} config without a serverUrl — the ${parsed.mode} ` +
        'would crash-loop at boot. Provide a server URL (join code) first.',
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
}

/**
 * Persist a migrated config ONCE, at the CLI entry point.
 *
 * Separate from `loadConfig` on purpose — see {@link migrateConfig}: the loader
 * runs in every process, and a loader that wrote would have the server, the
 * daemon, the janitor and every CLI invocation racing to save the same result on
 * every boot. Here the write happens on the one invocation a human ran.
 *
 * Returns the migrations applied, or [] when the file was already current (or
 * missing, or corrupt — a corrupt file is not an old file, and rewriting it
 * would destroy whatever the operator had).
 */
export function migrateConfigFile(path = configPath()): string[] {
  const res = inspectConfig(path)
  if (res.state !== 'ok' || res.migrated.length === 0) return []
  saveConfig(res.config, path)
  return res.migrated
}

/** True until a deployment mode has been chosen. */
export function needsSetup(config: PodiumConfig): boolean {
  return !config.mode
}

// ---------------------------------------------------------------------------
// Layered resolvers (#251) — env (PODIUM_*) → config.json → default, one typed
// accessor per key. See the inventory table at the top of this file. All take
// their sources as parameters (defaulting to the real ones) so they stay pure
// and snapshot-testable.
// ---------------------------------------------------------------------------

/** An env source for the resolvers — pass `process.env` (the default) or a snapshot. */
export type EnvSource = Readonly<Record<string, string | undefined>>

/** The port the local server binds / local CLIs dial: PODIUM_PORT → config.port → 18787.
 *  A non-numeric or zero PODIUM_PORT falls through (never NaN into a listen call). */
export function resolvePort(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): number {
  return (
    Number(env.PODIUM_PORT) || config.port || defaultInstancePorts(resolveInstanceId(env)).server
  )
}

/**
 * The host the LOCAL daemon dials to reach its server (POD-1585).
 *
 * The pair has to agree, and until now only one of them read `PODIUM_HOST`: the
 * server binds `resolveBindHost()` (`PODIUM_HOST` → `127.0.0.1`), while the
 * bundled daemon dialed a hard-coded `localhost`. Set `PODIUM_HOST` to a real
 * interface — which is exactly what you do to reach Podium from another device —
 * and the server binds THAT ADDRESS ONLY. Loopback is then not listening, the
 * local daemon's connect is refused on every retry, and the host machine never
 * attaches: it reads offline forever, its folders cannot be browsed, no agent can
 * be placed, and first-run onboarding cannot complete. The UI itself is fine over
 * the network, so the whole failure looks like a broken server rather than a
 * daemon that is dialing an address nothing is listening on.
 *
 * A WILDCARD BIND STAYS ON LOOPBACK. `0.0.0.0`/`::` mean "every interface",
 * which includes 127.0.0.1, so the daemon keeps its short, DNS-free local path;
 * dialing `0.0.0.0` as a destination is not portable and would be a regression.
 * Any other value is the only address the server can be reached on, so it is the
 * only correct thing for the daemon to dial.
 */
export function resolveLocalServerHost(env: EnvSource = process.env): string {
  const host = env.PODIUM_HOST?.trim()
  if (!host || host === '0.0.0.0' || host === '::' || host === '[::]') return 'localhost'
  // A bare IPv6 literal has to be bracketed before it can go in a URL authority.
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * The base URL a LOCAL component dials to reach its server — `resolveLocalServerHost()`
 * applied to a whole URL (POD-1607).
 *
 * POD-1585 fixed the bundled daemon's hard-coded `localhost`; every CLI verb still had
 * its own copy of it (`podium issue`, `mail`, `session`, the janitor's `--server`, the
 * health poll, the daemon's `ws://`). Bind `PODIUM_HOST` to a real interface — what the
 * setup wizard tells you to do to reach Podium from another device — and loopback is not
 * listening, so every one of those dials was refused while a browser reached the server
 * fine. One builder rather than a dozen call sites deciding this independently.
 */
export function localServerUrl(port: number, env: EnvSource = process.env): string {
  return `http://${resolveLocalServerHost(env)}:${port}`
}

/** The websocket form of {@link localServerUrl} — what the local daemon dials. */
export function localServerWsUrl(port: number, env: EnvSource = process.env): string {
  return `ws://${resolveLocalServerHost(env)}:${port}`
}

export function resolveHookPort(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): number {
  return (
    Number(env.PODIUM_HOOK_PORT) ||
    config.hookPort ||
    defaultInstancePorts(resolveInstanceId(env)).hook
  )
}

export function resolveAgentRelayPort(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): number {
  return (
    Number(env.PODIUM_AGENT_RELAY_PORT) ||
    config.agentRelayPort ||
    defaultInstancePorts(resolveInstanceId(env)).agentRelay
  )
}

/** Native harness HOME/history root. Named instances isolate it unless sharing is explicit. */
export function resolveAgentHomeDir(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
  home: string = env.HOME || homedir(),
): string {
  return (
    env.PODIUM_AGENT_HOME ||
    config.agentHome ||
    (resolveInstanceId(env) === 'default'
      ? home
      : join(instanceStateDir(resolveInstanceId(env), env, home), 'agent-home'))
  )
}

/** Self-update channel: PODIUM_UPDATE_CHANNEL → config.updateChannel → 'stable'. */
export function resolveUpdateChannel(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): 'stable' | 'edge' {
  return (env.PODIUM_UPDATE_CHANNEL ?? config.updateChannel ?? 'stable') as 'stable' | 'edge'
}

/**
 * Operator feature-flag overrides from config.json [spec:SP-f4b9].
 * Config-file only — deliberately no env layer (`PODIUM_FEATURES`). Hidden flags
 * are enableable only via this file (except in development mode, where they are
 * listed in Experimental). Returns `{}` when absent.
 */
export function resolveFeatureOverrides(
  config: PodiumConfig = loadConfig(),
): Record<string, boolean> {
  return config.features ?? {}
}

/** Self-update feed override: PODIUM_UPDATE_FEED → config.updateFeed → undefined
 *  (undefined = the default GitHub Releases feed). */
export function resolveUpdateFeed(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): string | undefined {
  return env.PODIUM_UPDATE_FEED ?? config.updateFeed
}

/** Self-update platform target: PODIUM_UPDATE_TARGET → caller-supplied fallback
 *  (the CLI passes its host-derived os/arch mapping; default keeps the historical
 *  linux-x64 behavior for callers that don't). */
export function resolveUpdateTarget(
  env: EnvSource = process.env,
  fallback = 'linux-x86_64',
): string {
  return env.PODIUM_UPDATE_TARGET ?? fallback
}

/** The headless install dir: PODIUM_HOME (exported by the headless launcher) →
 *  the running binary's own directory. */
export function resolveInstallDir(
  env: EnvSource = process.env,
  execPath: string = process.execPath,
): string {
  return env.PODIUM_HOME ?? dirname(execPath)
}

/** Daemon-injected agent-relay endpoint for a constrained agent process (env-only —
 *  set by apps/daemon per session; never configured by the operator).
 *  PODIUM_NO_RELAY forces "act as operator / not this session" — the escape hatch used
 *  by nested subagent contexts and the hermetic test harness to shed an inherited relay
 *  (so they stop acting as the parent session).
 *  Reads the new name, falling back to the legacy PODIUM_ISSUE_RELAY for one release
 *  (in-flight sessions spawned before the cutover still carry it). [spec:SP-b85a] */
export function resolveAgentRelay(env: EnvSource = process.env): string | undefined {
  if (env.PODIUM_NO_RELAY) return undefined
  return env.PODIUM_AGENT_RELAY ?? env.PODIUM_ISSUE_RELAY
}

/** Daemon-injected relay endpoint for THIS session, whatever drives it — bound for
 *  shells too, where `resolveAgentRelay()` deliberately reads undefined [POD-1375].
 *
 *  Use this ONLY for commands that are the session talking about ITSELF and carry no
 *  delegate authority (the browser shim's URL open, `podium worktree`). Anything whose
 *  answer depends on WHO is asking — issues, mail, specs, locks, workflows, quota,
 *  offers, workspace claims — must keep reading `resolveAgentRelay()`, so a human in
 *  their own terminal gets the operator path instead of a constrained agent identity.
 *
 *  Falls back to the agent relay (and its legacy alias) so sessions spawned before the
 *  split — whose env carries only the old name — keep working for one release. */
export function resolveSessionRelay(env: EnvSource = process.env): string | undefined {
  if (env.PODIUM_NO_RELAY) return undefined
  return env.PODIUM_SESSION_RELAY ?? env.PODIUM_AGENT_RELAY ?? env.PODIUM_ISSUE_RELAY
}

/**
 * How this process is being supervised, for the run-registry record: NOTIFY_SOCKET ⇒
 * a systemd Type=notify unit; PODIUM_RUN_MODE=detached ⇒ the setup detached-spawn;
 * otherwise a plain foreground run (desktop sidecar, dev).
 */
export function resolveRunRecordMode(
  env: EnvSource = process.env,
): 'systemd' | 'detached' | 'foreground' {
  return env.NOTIFY_SOCKET
    ? 'systemd'
    : env.PODIUM_RUN_MODE === 'detached'
      ? 'detached'
      : 'foreground'
}

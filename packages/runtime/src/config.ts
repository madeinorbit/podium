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
 * Provenance: `resolveSetting(key)` also reports WHICH LAYER answered, for every
 * key in `LAYERED_KEYS`. A value the environment set locks its UI control and
 * refuses its mutation rather than no-oping. Operator-facing write-up:
 * docs/configuration.md.
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
 * | PODIUM_MODE                   | config.mode             | `resolveMode()` — the deployment owns the mode          |
 * | PODIUM_PUBLIC_URL             | config.publicUrl        | `resolvePublicUrl()` — https unless loopback, immutable |
 * | PODIUM_APP_URL                | config.appUrl           | `resolveAppUrl()` — where the web UI is served from     |
 * | PODIUM_ALLOWED_ORIGINS        | config.allowedOrigins   | `resolveAllowedOrigins()` — credentialed CORS list      |
 * | PODIUM_UPDATE_SCOPE           | config.updateScope      | `resolveUpdateScope()` — 'fleet-only' = CI owns server  |
 * | PODIUM_TRANSCRIPT_LAKE        | config.transcriptLake   | `resolveTranscriptLake()` — 'off' = no mirroring        |
 * | DO_NOT_TRACK                  | — (env-only kill switch)| @podium/telemetry `telemetrySuppressedBy()` [SP-f933]  |
 * | PODIUM_TELEMETRY              | — (env-only kill switch)| `=off` suppresses sending AND the setup prompt         |
 * | PODIUM_TELEMETRY_ENDPOINT     | config.telemetry.endpoint| @podium/telemetry `resolveTelemetryEndpoint()`         |
 * | PODIUM_UPDATE_FEED            | config.updateFeed       | `resolveUpdateFeed()`                                  |
 * | PODIUM_DEV_ARTIFACT_BASE_URL  | config.publicUrl        | `resolveDevArtifactOrigin()` (source publisher only)   |
 * | PODIUM_DEV_SOURCE_ROOT        | — (env-only opt-in)     | installed development publisher checkout              |
 * | PODIUM_UPDATE_TARGET          | — → 'linux-x86_64'      | `resolveUpdateTarget()`                                |
 * | PODIUM_HOME                   | — → dirname(execPath)   | `resolveInstallDir()` (headless launcher exports it)   |
 * | PODIUM_RUN_MODE               | — (env-only)            | `resolveRunRecordMode()` ('detached' set by cli-spawn) |
 * | NOTIFY_SOCKET (systemd's)     | — (env-only)            | `resolveRunRecordMode()`, sd-notify                    |
 * | PODIUM_DESKTOP_SUPERVISED     | — (env-only flag)       | `resolveLoggingMode()` (desktop sidecar → file sink)   |
 * | PODIUM_AGENT_RELAY            | — (env-only)            | `resolveAgentRelay()` (daemon-injected per AGENT)      |
 * | PODIUM_SESSION_RELAY          | — (env-only)            | `resolveSessionRelay()` (per SESSION, shells included) |
 * | PODIUM_NO_RELAY               | — (env-only flag)       | both resolvers (shed inherited relay; escape hatch)    |
 * | PODIUM_ISSUE_RELAY            | — (env-only, LEGACY)    | `resolveAgentRelay()` read-only alias (dual-read, 1 rel)|
 * | PODIUM_SESSION_ID             | — (env-only)            | daemon-injected agent identity (control/session.ts)    |
 * | PODIUM_INSTANCE_UUID          | — (env-only)            | daemon-owned process identity (instance reaper)       |
 * | PODIUM_BOOT_TIMEOUT_MS        | — → 45000               | boot.ts boot watchdog                                  |
 * | PODIUM_LOOP_PROFILE           | — (env-only flag)       | server + daemon event-loop profiling                   |
 * | ?switchTrace=1 / podium.switchTrace | — (browser runtime toggle; off by default) | optional long-task marks + console output          |
 * | PODIUM_APP_VERSION            | — (BUILD-time --define) | server /version; must stay a literal `process.env.…`   |
 * | PODIUM_WEB_DIR                | — → bundled dist path   | apps/server static web (packaged bundle sets it)       |
 * | PODIUM_MOBILE_WEB_DIR         | — → bundled dist path   | apps/server static mobile web                          |
 * | PODIUM_PTY_BACKEND            | — → auto by runtime     | agent-bridge PTY backend selection                     |
 * | PODIUM_ABDUCO                 | — → embedded/PATH       | agent-bridge/embedded-abduco binary override           |
 * | PODIUM_NO_SCOPE               | — (env-only flag)       | agent-bridge: skip per-master systemd-run scopes       |
 * | PODIUM_SESSION_MEMORY_MAX     | — → 50% RAM (2–16 GiB)  | per-session scope MemoryMax (`infinity` lifts it)      |
 * | PODIUM_SESSION_MEMORY_HIGH    | — → UNSET               | reclaim-only throttle; any band below max can wedge    |
 * | PODIUM_SESSION_MEMORY_SWAP_MAX| — → 0                   | per-session MemorySwapMax (`0` is a value; swap adds)  |
 * | PODIUM_SESSION_TASKS_MAX      | — → 4096 (attach: 256)  | per-session scope TasksMax                             |
 * | PODIUM_SESSIONS_MEMORY_HIGH   | — → 75% RAM             | aggregate throttle on the instance's sessions slice     |
 * | PODIUM_BUILD_MEMORY_MAX       | — → 4 GiB (≤50% RAM)    | per-build scope MemoryMax (`infinity` lifts it)        |
 * | PODIUM_BUILD_MEMORY_SWAP_MAX  | — → 0 (no swap)         | MemorySwapMax per build AND for the builds slice total  |
 * | PODIUM_BUILD_TASKS_MAX        | — → 2048                | TasksMax per build and for the builds slice            |
 * | PODIUM_BUILDS_MEMORY_MAX      | — → 50% RAM             | aggregate CAP on the instance's builds slice           |
 * | PODIUM_NO_SESSION_BUDGET      | — (env-only flag)       | keep the slice/scope tree, drop every limit            |
 * | PODIUM_CGROUP_ROOT            | — → /sys/fs/cgroup      | cgroup2 mount for session observation (tests point it) |
 * | PODIUM_CODEX_HOOK_*           | — (env-only)            | daemon codex hook plumbing (codex-hooks.ts)            |
 * | PODIUM_CLOUD_*                | — (env-only)            | apps/server cloud-runtime seam (hosted provider)       |
 * | PODIUM_UPDATE_SIGNING_KEY     | — (env-only)            | scripts/build-bun.ts + release tooling                 |
 * | PODIUM_INSTALL_PUBKEY         | — (env-only)            | install.sh signed-install override                     |
 * | PODIUM_UPDATE_TEST_AUTOCONFIRM| — (env-only flag)       | desktop updater verification script (test-only)        |
 * | PODIUM_ALLOWED_HOSTS          | — (env-only)            | apps/web vite dev-server host check                    |
 * | PODIUM_WEB_PORT               | — → 55556               | apps/web vite dev-server port                          |
 * | PODIUM_TRUSTED_PROXY_HOPS     | — → 0                   | apps/server `resolveTrustedProxyHops()` (server.ts)    |
 * | PODIUM_TLS_KEY_FILE           | — (env-only)            | apps/server `tlsFromEnv()`; pairs with the cert file   |
 * | PODIUM_TLS_CERT_FILE          | — (env-only)            | apps/server `tlsFromEnv()`; pairs with the key file    |
 * | PODIUM_DB_PATH                | — (env-only)            | apps/server migrations/restore.ts (`--db` default)     |
 * | PODIUM_UNDER_PARENT           | — (env-only flag)       | daemon/cli parent-supervision handshake                |
 * | PODIUM_E2E_DISABLE_LOCAL_UPDATE_PARTICIPANT | — (env-only, test) | apps/server local update participant     |
 * | test-only: PODIUM_STUB_*, PODIUM_SKIP_*, PODIUM_GROK_CHAT_OK, PODIUM_CURL_LOG,      |
 * |   PODIUM_DISCOVERY_BENCH_DB, PODIUM_FEED_PORT, PODIUM_HEADLESS_FEED_PORT — fixtures |
 *
 * The always-on client switch collector records bounded traces. The optional long-task
 * observer and console output are off by default. Add ?switchTrace=1 to the browser URL,
 * or set device-local podium.switchTrace to 1, for a diagnostic session; remove the query
 * or clear that setting to disable the optional diagnostics.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from '@podium/logger'
import { z } from 'zod'
import {
  assertInstanceStateIdentity,
  defaultInstancePorts,
  ensureInstanceStateIdentity,
  instanceStateDir,
  resolveInstanceId,
} from './instance'

export { resolveInstanceId, selectInstance } from './instance'

const log = createLogger('runtime:config')

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
  /**
   * The FLEET DEFAULT update channel (desktop is always stable). Default 'stable'.
   * It governs this instance's own self-update AND every joined machine that has
   * not pinned an override of its own (POD-1882). `dev` is a Podium-development
   * channel: reachable only while Settings → Experimental has "Podium development"
   * on, but honoured here whatever the UI is currently showing.
   */
  updateChannel: z.enum(['stable', 'edge', 'dev']).optional(),
  /** Device-reachable base URL captured at setup; embedded into machine join tokens. */
  publicUrl: z.string().optional(),
  /**
   * WHERE THE WEB UI LIVES WHEN IT IS NOT THIS SERVER.
   *
   * Absent for every self-hosted install: the server serves its own clients, and
   * `publicUrl` is the whole address. Present when the UI is a separate origin —
   * the hosted shape, `https://app.…` in front of an API-only `https://api.…` —
   * and then it is what the server ADVERTISES to clients and what the desktop
   * shell navigates to. It is not a second name for this server; a request that
   * arrives at the API origin looking for a page is redirected here.
   */
  appUrl: z.string().optional(),
  /**
   * Browser origins allowed to make CREDENTIALED cross-site requests to this
   * instance (consumed by the CORS/WS checks, PDM-24). A DEPLOYMENT FACT — the
   * hosted control plane serves its web app from a different origin than its API
   * — not an authentication switch, which is why this one has an env layer where
   * `auth.openMode` deliberately does not: it widens trust only to an explicit,
   * fully-qualified list, never to a wildcard, and never to "anyone".
   */
  allowedOrigins: z.array(z.string()).optional(),
  /**
   * WHO REPLACES THIS SERVER'S OWN BINARY. `all` (the default) is the
   * self-hosted shape: the coordinator updates itself along with its fleet.
   * `fleet-only` says the deployment replaces the server out-of-band — a
   * container image, a CI deploy — and Podium must only ever update the JOINED
   * MACHINES.
   *
   * It is a DECLARATION rather than a runtime probe because the current
   * correctness is accidental: a container has no parent supervisor, so the
   * local update participant happens not to start and `canRestartServer`
   * happens to be false — while the wave planner still holds the host row
   * `coordinator-last` and the UI still offers a server update that can never
   * land.
   */
  updateScope: z.enum(['all', 'fleet-only']).optional(),
  /**
   * Whether this server mirrors and indexes daemon transcripts into the lake
   * under `<stateDir>/transcripts`. `on` (the default) is every install that
   * exists today. `off` is for a deployment whose disk is ephemeral or whose
   * blob store does not exist yet: the mirror, the indexer and the lake's disk
   * footprint all go away, and turning it back on resumes from the persisted
   * cursors rather than re-fetching history.
   */
  transcriptLake: z.enum(['on', 'off']).optional(),
  /** How the reachable URL is exposed. Saved so Settings can restore the operator's choice. */
  networkOption: z
    .enum(['tailscale-funnel', 'tailscale-serve', 'cloudflare-tunnel', 'manual'])
    .optional(),
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
    log.error(
      'config file exists but is invalid — treating this box as unconfigured; fix the file or run `podium setup --repair`',
      { path, reason: res.error },
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
  return resolveSetting('port', config, env).value
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
  return resolveSetting('hookPort', config, env).value
}

export function resolveAgentRelayPort(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): number {
  return resolveSetting('agentRelayPort', config, env).value
}

/** Native harness HOME/history root. Named instances isolate it unless sharing is explicit. */
export function resolveAgentHomeDir(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
  home: string = env.HOME || homedir(),
): string {
  return env.PODIUM_AGENT_HOME || config.agentHome || defaultAgentHome(env, home)
}

/**
 * The channels an INSTANCE can default its fleet to. Deliberately the same three
 * values as `UpdateChannel` in @podium/model, which is what a single machine may
 * pin — a fleet default and a per-machine override answer the same question at
 * two scopes, so they must range over the same answers (POD-1882). Restated here
 * rather than imported because @podium/runtime is the lower layer.
 */
export type FleetUpdateChannel = 'stable' | 'edge' | 'dev'

/** Fleet default update channel: PODIUM_UPDATE_CHANNEL → config.updateChannel → 'stable'. */
export function resolveUpdateChannel(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): FleetUpdateChannel {
  return resolveSetting('updateChannel', config, env).value
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
  return resolveSetting('updateFeed', config, env).value
}

/** Which machines this instance's updater may replace. See `config.updateScope`. */
export type UpdateScope = 'all' | 'fleet-only'

/** Whether this instance mirrors daemon transcripts. See `config.transcriptLake`. */
export type TranscriptLakeMode = 'on' | 'off'

// ---------------------------------------------------------------------------
// PROVENANCE (PDM-26) — ONE implementation of the precedence rule.
//
// The accessors above each stated "env ?? file ?? default" in their own words.
// That was fine while a forced value only had to be COMPUTED. It stops being
// fine the moment the UI has to say WHICH LAYER a value came from, because a
// per-key `envForced` boolean is a second copy of the same rule sitting next to
// the accessor it can drift from — and the one key that already needed it
// (`PODIUM_UPDATE_CHANNEL`) was about to become six.
//
// So the rule lives once, in `resolveSetting`, and every accessor below is a
// projection of it. Adding a layered key is one edit to `LAYERED_READERS`, and
// that edit cannot forget the provenance half.
// ---------------------------------------------------------------------------

/**
 * Which layer answered.
 *
 * `settings` is the persisted instance-tier settings row, and it exists for the
 * one key that is a USER-FACING CHOICE first and a deployment override second:
 * transcript mirroring is a toggle in Settings, and env / config.json sit above
 * it so a deployment can take the choice away. It never appears for a key with
 * no settings row.
 */
export type SettingSource = 'env' | 'file' | 'settings' | 'default'

/**
 * A resolved value and where it came from. `env` names the VARIABLE and is
 * present exactly when `source === 'env'` — it is what a refusal message and a
 * disabled control quote back, so an operator is told which string to unset
 * rather than that "something" overrode them.
 */
export interface Resolved<T> {
  value: T
  source: SettingSource
  env?: string
}

/**
 * The keys that HAVE an env layer.
 *
 * A key missing from this list is missing deliberately: `features` and
 * `auth.openMode` are file-only because one enables hidden code paths and the
 * other turns off authentication, and neither should be reachable from a
 * process environment that a supervisor, a container platform or a stray `.env`
 * can populate by accident. See docs/configuration.md.
 */
export const LAYERED_KEYS = [
  'port',
  'hookPort',
  'agentRelayPort',
  'agentHome',
  'updateChannel',
  'updateFeed',
  'mode',
  'publicUrl',
  'appUrl',
  'allowedOrigins',
  'updateScope',
  'transcriptLake',
] as const
export type LayeredKey = (typeof LAYERED_KEYS)[number]

/** The variable each layered key reads. */
export const LAYERED_ENV: Readonly<Record<LayeredKey, string>> = {
  port: 'PODIUM_PORT',
  hookPort: 'PODIUM_HOOK_PORT',
  agentRelayPort: 'PODIUM_AGENT_RELAY_PORT',
  agentHome: 'PODIUM_AGENT_HOME',
  updateChannel: 'PODIUM_UPDATE_CHANNEL',
  updateFeed: 'PODIUM_UPDATE_FEED',
  mode: 'PODIUM_MODE',
  publicUrl: 'PODIUM_PUBLIC_URL',
  appUrl: 'PODIUM_APP_URL',
  allowedOrigins: 'PODIUM_ALLOWED_ORIGINS',
  updateScope: 'PODIUM_UPDATE_SCOPE',
  transcriptLake: 'PODIUM_TRANSCRIPT_LAKE',
}

/** What each layered key resolves TO. */
export interface LayeredValues {
  port: number
  hookPort: number
  agentRelayPort: number
  agentHome: string
  updateChannel: FleetUpdateChannel
  updateFeed: string | undefined
  mode: PodiumMode | undefined
  publicUrl: string | undefined
  appUrl: string | undefined
  allowedOrigins: string[]
  updateScope: UpdateScope
  transcriptLake: TranscriptLakeMode
}
export type LayeredValue<K extends LayeredKey> = LayeredValues[K]

/**
 * A boot-time env parse failure. Thrown before the server listens, naming the
 * variable AND the accepted values: the person reading this is looking at a
 * container log with no other context, so the message has to be self-contained.
 */
function envError(name: string, detail: string): never {
  throw new Error(`${name} is invalid: ${detail}`)
}

function parseEnum<T extends string>(raw: string, accepted: readonly T[], name: string): T {
  const value = raw.trim() as T
  if (!accepted.includes(value)) {
    envError(name, `expected one of ${accepted.join(', ')}, got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Loopback hostnames the https rule exempts — a container probing itself, and
 *  every local development shape. */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  )
}

/**
 * The ENV public URL, held to a stricter rule than the file layer.
 *
 * The file layer is what an operator typed at setup and is deliberately
 * unchanged: a self-hosted `http://box.lan:18787` keeps working. The env layer
 * is what a deployment platform injects, and a platform that can inject a URL
 * can inject an https one — so a plaintext origin here is a misconfiguration
 * worth failing the boot on, not a preference. Loopback is exempt because a
 * container talking to itself has no certificate to present.
 *
 * BARE ORIGIN ONLY. This URL is embedded into join tokens and mobile pairing
 * payloads and then has routes appended to it; a path, query or fragment
 * silently reinterprets every one of them.
 */
function parseEnvPublicUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return envError('PODIUM_PUBLIC_URL', `not a valid URL: ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    envError('PODIUM_PUBLIC_URL', 'must start with https:// (or http:// for loopback)')
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    envError('PODIUM_PUBLIC_URL', `must use https:// unless the host is loopback (got ${trimmed})`)
  }
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    envError(
      'PODIUM_PUBLIC_URL',
      `must be a bare origin with no path, query or fragment (got ${trimmed})`,
    )
  }
  return url.origin
}

/**
 * The origin the web UI is served from, when it is not this server.
 *
 * HTTPS ONLY, and unlike the public URL there is no loopback exemption: an
 * `appUrl` exists precisely because the UI is on a DIFFERENT site from the API,
 * which means a real browser doing real cross-site requests, which means a
 * secure context. A self-hoster whose UI is this server does not set this key at
 * all.
 *
 * Bare origin, because it is advertised to clients that append their own routes
 * to it — the same reason `publicUrl` is.
 */
function parseAppUrl(raw: string, name: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return envError(name, `not a valid URL: ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'https:') {
    envError(name, `must be an https:// origin (got ${trimmed})`)
  }
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    envError(name, `must be a bare origin with no path, query or fragment (got ${trimmed})`)
  }
  return url.origin
}

/**
 * The registrable domain, APPROXIMATED as the last two labels.
 *
 * Deliberately not a public-suffix list. What this guards is a coarse mistake —
 * an `appUrl` pointing at a site nothing about this deployment relates to — and
 * the precise answer is already available by other means: an operator whose
 * setup genuinely spans two registrable domains states the second one in
 * `allowedOrigins`, which is the explicit list that decides trust anyway. A PSL
 * here would make the approximation stricter without making the DECISION any
 * different, because the escape hatch is the same either way.
 */
function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split('.')
  return labels.slice(-2).join('.')
}

/**
 * A comma-separated origin allowlist.
 *
 * Every entry must be EXACTLY an origin — scheme, host, optional port, nothing
 * else — so that the `origin === entry` comparison downstream cannot be widened
 * by a stray path, and so a wildcard cannot arrive disguised as a hostname.
 * Duplicates are dropped, first occurrence wins, order is preserved.
 */
function parseAllowedOrigins(raw: string, name: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw.split(',').map((part) => part.trim())) {
    if (entry === '') continue
    let url: URL
    try {
      url = new URL(entry)
    } catch {
      return envError(name, `${JSON.stringify(entry)} is not a valid origin`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      envError(name, `${JSON.stringify(entry)} must use http:// or https://`)
    }
    if (url.hostname === '' || url.hostname.includes('*')) {
      envError(name, `${JSON.stringify(entry)} must name a host and may not use a wildcard`)
    }
    if (url.origin !== entry.replace(/\/$/, '')) {
      envError(
        name,
        `${JSON.stringify(entry)} must be a bare origin with no path, query or fragment`,
      )
    }
    if (seen.has(url.origin)) continue
    seen.add(url.origin)
    out.push(url.origin)
  }
  return out
}

/** The agent HOME root when neither env nor config names one. Shared by
 *  `resolveAgentHomeDir` and the layer table so the two cannot disagree. */
function defaultAgentHome(env: EnvSource, home: string): string {
  return resolveInstanceId(env) === 'default'
    ? home
    : join(instanceStateDir(resolveInstanceId(env), env, home), 'agent-home')
}

/**
 * Per-key layer readers. `env` and `file` return `undefined` for "this layer has
 * nothing to say"; `default` always answers.
 *
 * `default` takes the env source because two defaults are themselves
 * env-derived — the per-instance port block and the agent home root both follow
 * `PODIUM_INSTANCE`. That is precedence WITHIN the default layer, not a second
 * env layer, and `resolveSetting` reports those as `default` accordingly.
 */
const LAYERED_READERS: {
  [K in LayeredKey]: {
    env(env: EnvSource): LayeredValues[K] | undefined
    file(config: PodiumConfig): LayeredValues[K] | undefined
    default(env: EnvSource): LayeredValues[K]
  }
} = {
  port: {
    env: (env) => Number(env.PODIUM_PORT) || undefined,
    file: (config) => config.port || undefined,
    default: (env) => defaultInstancePorts(resolveInstanceId(env)).server,
  },
  hookPort: {
    env: (env) => Number(env.PODIUM_HOOK_PORT) || undefined,
    file: (config) => config.hookPort || undefined,
    default: (env) => defaultInstancePorts(resolveInstanceId(env)).hook,
  },
  agentRelayPort: {
    env: (env) => Number(env.PODIUM_AGENT_RELAY_PORT) || undefined,
    file: (config) => config.agentRelayPort || undefined,
    default: (env) => defaultInstancePorts(resolveInstanceId(env)).agentRelay,
  },
  agentHome: {
    env: (env) => env.PODIUM_AGENT_HOME || undefined,
    file: (config) => config.agentHome || undefined,
    default: (env) => defaultAgentHome(env, env.HOME || homedir()),
  },
  updateChannel: {
    env: (env) => env.PODIUM_UPDATE_CHANNEL as FleetUpdateChannel | undefined,
    file: (config) => config.updateChannel,
    default: () => 'stable',
  },
  updateFeed: {
    env: (env) => env.PODIUM_UPDATE_FEED,
    file: (config) => config.updateFeed,
    default: () => undefined,
  },
  mode: {
    env: (env) =>
      env.PODIUM_MODE === undefined
        ? undefined
        : parseEnum(env.PODIUM_MODE, PodiumMode.options, 'PODIUM_MODE'),
    file: (config) => config.mode,
    default: () => undefined,
  },
  publicUrl: {
    env: (env) =>
      env.PODIUM_PUBLIC_URL === undefined ? undefined : parseEnvPublicUrl(env.PODIUM_PUBLIC_URL),
    file: (config) => config.publicUrl,
    default: () => undefined,
  },
  appUrl: {
    env: (env) =>
      env.PODIUM_APP_URL === undefined
        ? undefined
        : parseAppUrl(env.PODIUM_APP_URL, 'PODIUM_APP_URL'),
    file: (config) =>
      config.appUrl === undefined ? undefined : parseAppUrl(config.appUrl, 'appUrl'),
    default: () => undefined,
  },
  allowedOrigins: {
    env: (env) =>
      env.PODIUM_ALLOWED_ORIGINS === undefined
        ? undefined
        : parseAllowedOrigins(env.PODIUM_ALLOWED_ORIGINS, 'PODIUM_ALLOWED_ORIGINS'),
    file: (config) =>
      config.allowedOrigins === undefined
        ? undefined
        : parseAllowedOrigins(config.allowedOrigins.join(','), 'allowedOrigins'),
    default: () => [],
  },
  updateScope: {
    env: (env) =>
      env.PODIUM_UPDATE_SCOPE === undefined
        ? undefined
        : parseEnum(env.PODIUM_UPDATE_SCOPE, ['all', 'fleet-only'] as const, 'PODIUM_UPDATE_SCOPE'),
    file: (config) => config.updateScope,
    default: () => 'all',
  },
  transcriptLake: {
    env: (env) =>
      env.PODIUM_TRANSCRIPT_LAKE === undefined
        ? undefined
        : parseEnum(env.PODIUM_TRANSCRIPT_LAKE, ['on', 'off'] as const, 'PODIUM_TRANSCRIPT_LAKE'),
    file: (config) => config.transcriptLake,
    default: () => 'on',
  },
}

/**
 * THE PRECEDENCE RULE, ONCE: env (PODIUM_*) → config.json → built-in default,
 * plus which of the three answered.
 *
 * Every layered accessor in this file is `resolveSetting(key, …).value`, and the
 * server's `instance.provenance` is this function over `LAYERED_KEYS`. There is
 * no second place that decides what wins.
 */
export function resolveSetting<K extends LayeredKey>(
  key: K,
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): Resolved<LayeredValue<K>> {
  const reader = LAYERED_READERS[key]
  const fromEnv = reader.env(env)
  if (fromEnv !== undefined) {
    return { value: fromEnv as LayeredValue<K>, source: 'env', env: LAYERED_ENV[key] }
  }
  const fromFile = reader.file(config)
  if (fromFile !== undefined) return { value: fromFile as LayeredValue<K>, source: 'file' }
  return { value: reader.default(env) as LayeredValue<K>, source: 'default' }
}

/**
 * DEPLOYMENT MODE: PODIUM_MODE → config.mode → undefined (not yet configured).
 *
 * The key whose absence made a headless boot impossible. `mode` gates the whole
 * data plane through readiness and had no env layer, so a container with a
 * perfectly specified environment and an empty state dir still had to be walked
 * through a setup wizard by a human before it would serve anything.
 */
export function resolveMode(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): PodiumMode | undefined {
  return resolveSetting('mode', config, env).value
}

/**
 * Device-reachable base URL: PODIUM_PUBLIC_URL → config.publicUrl → undefined.
 * The env layer is normalized to a bare origin and must be https unless the host
 * is loopback; the file layer is unchanged — see {@link parseEnvPublicUrl}.
 */
export function resolvePublicUrl(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): string | undefined {
  return resolveSetting('publicUrl', config, env).value
}

/**
 * The origin serving the web UI: PODIUM_APP_URL → config.appUrl → undefined.
 *
 * Undefined is the ordinary self-hosted answer and means "this server serves its
 * own UI"; nothing changes anywhere when it is absent.
 */
export function resolveAppUrl(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): string | undefined {
  return resolveSetting('appUrl', config, env).value
}

/**
 * A UI ON ANOTHER SITE HAS TO BE ONE THIS DEPLOYMENT VOUCHES FOR.
 *
 * Checked across three keys at once, which is why it is a separate assertion
 * rather than part of `appUrl`'s own layer reader: a per-key parser sees one
 * value and this question needs three.
 *
 * The session cookie is host-only on the API origin and `SameSite=Lax`, so a UI
 * on an unrelated site could not log in even if it were advertised — the failure
 * would be a redirect into a page that cannot authenticate, with nothing on
 * screen to explain it. Sharing a registrable domain with `publicUrl` is the
 * common case and needs no ceremony; anything else must appear in
 * `allowedOrigins`, which is where this deployment states cross-site trust
 * explicitly.
 *
 * Throws at boot, before the server listens.
 */
export function assertAppUrlCompatible(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): void {
  const appUrl = resolveAppUrl(config, env)
  if (appUrl === undefined) return
  const publicUrl = resolvePublicUrl(config, env)
  const appHost = new URL(appUrl).hostname
  if (
    publicUrl !== undefined &&
    registrableDomain(new URL(publicUrl).hostname) === registrableDomain(appHost)
  ) {
    return
  }
  if (resolveAllowedOrigins(config, env).includes(appUrl)) return
  throw new Error(
    `${LAYERED_ENV.appUrl} (${appUrl}) is on a different site from the public URL ` +
      `(${publicUrl ?? 'unset'}), so a browser there cannot hold this server's session cookie. ` +
      `List it in ${LAYERED_ENV.allowedOrigins} to say that is deliberate.`,
  )
}

/** Credentialed cross-site origins: PODIUM_ALLOWED_ORIGINS → config.allowedOrigins → [].
 *  A PRESENT but empty variable is a deliberate empty list, not "unset". */
export function resolveAllowedOrigins(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): string[] {
  return resolveSetting('allowedOrigins', config, env).value
}

/** Which machines this instance's updater may replace: PODIUM_UPDATE_SCOPE →
 *  config.updateScope → 'all'. */
export function resolveUpdateScope(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): UpdateScope {
  return resolveSetting('updateScope', config, env).value
}

/**
 * Transcript mirroring: PODIUM_TRANSCRIPT_LAKE → config.transcriptLake →
 * the Settings toggle → 'on'.
 *
 * FOUR LAYERS, and the extra one is the point: this is a choice a user makes in
 * Settings ("mirror transcripts to this server"), which a deployment may
 * override but does not otherwise own. `settings` is the stored toggle —
 * `undefined` when nobody has touched it, which is not the same as `false` and
 * resolves to the built-in `'on'`.
 *
 * The settings value is PASSED IN rather than read here because @podium/runtime
 * has no database; the server reads the row and hands it down.
 */
export function resolveTranscriptLake(
  settings: boolean | undefined,
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): TranscriptLakeMode {
  return resolveTranscriptLakeSetting(settings, config, env).value
}

/** {@link resolveTranscriptLake} with the layer that answered, for the toggle
 *  that has to render itself locked and say by what. */
export function resolveTranscriptLakeSetting(
  settings: boolean | undefined,
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): Resolved<TranscriptLakeMode> {
  const layered = resolveSetting('transcriptLake', config, env)
  if (layered.source !== 'default') return layered
  if (settings === undefined) return layered
  return { value: settings ? 'on' : 'off', source: 'settings' }
}

/**
 * The origin a source server publishes for its authenticated development bundle route.
 *
 * The dedicated env override wins over the deployment's durable `publicUrl`. There is
 * deliberately no loopback fallback: one target is advertised to every managed machine, and a
 * loopback URL would send each remote daemon back to itself. Only a bare origin is accepted so
 * appending the tokenized artifact route cannot silently discard or reinterpret a configured path.
 *
 * What it validates is the address as written — see {@link namesThisMachine} for what that
 * settles and what it deliberately leaves to the operator.
 */
export function resolveDevArtifactOrigin(
  config: Pick<PodiumConfig, 'publicUrl'> = loadConfig(),
  env: EnvSource = process.env,
): string | undefined {
  const configured = env.PODIUM_DEV_ARTIFACT_BASE_URL ?? config.publicUrl
  if (configured === undefined) return undefined

  let url: URL
  try {
    url = new URL(configured.trim())
  } catch {
    throw new Error('development artifact origin must be a valid HTTP(S) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('development artifact origin must use http:// or https://')
  }
  if (url.username || url.password) {
    throw new Error('development artifact origin must not contain URL credentials')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('development artifact origin must not contain a path, query, or fragment')
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (namesThisMachine(hostname)) {
    throw new Error(
      'development artifact origin must not be a loopback or unspecified address; ' +
        'it is published to other machines, which would fetch from themselves',
    )
  }

  return url.origin
}

/**
 * Does this host part name THIS machine wherever it is read — by what the
 * address IS, never by how it is spelled (POD-2229)?
 *
 * WHAT THIS CAN AND CANNOT DECIDE, stated because the previous version's
 * message promised what it never tested. It reads the address; it does not
 * resolve anything. So it is complete for address LITERALS — every way of
 * writing loopback or the unspecified address is caught, IPv4-mapped IPv6
 * included, which the old `startsWith('127.')` denylist could not see — and for
 * the one family of names where being loopback is part of what the name means
 * (RFC 6761's `localhost` and everything under it).
 *
 * It cannot decide an ordinary NAME, and a resolver would not fix that: this is
 * per-machine state, and the answer here is not the answer on the daemon's box.
 * Measured on the host that drove POD-2215: its own public FQDN maps to
 * 127.0.1.1 in `/etc/hosts` — the Debian convention — while being reachable
 * from anywhere else. Refusing on a server-side lookup would therefore reject a
 * correct configuration, which is why this guard says what it checked instead
 * of claiming reachability it has no way to test.
 *
 * The old test also had a false positive to go with its false negative:
 * `127.example.test` is an ordinary hostname that starts with three digits.
 */
function namesThisMachine(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return isLocalIpv6(hostname.slice(1, -1))
  }
  // WHATWG normalises every IPv4 form — `2130706433`, `0x7f000001`, `127.1` —
  // to a dotted quad, so an all-numeric dotted quad here IS an IPv4 literal.
  const octets = hostname.split('.')
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet))) return false
  return octets[0] === '127' || hostname === '0.0.0.0'
}

/** `::1`, `::`, and the IPv4-mapped forms of both, as the URL parser writes them. */
function isLocalIpv6(address: string): boolean {
  if (address === '::1' || address === '::') return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
  if (!mapped) return false
  const high = Number.parseInt(mapped[1] ?? '', 16)
  const low = Number.parseInt(mapped[2] ?? '', 16)
  // ::ffff:7f00:0/104 is 127.0.0.0/8; ::ffff:0:0 is 0.0.0.0.
  return high >> 8 === 0x7f || (high === 0 && low === 0)
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

/**
 * WHICH SINK this process's records go to, as opposed to how it is supervised.
 *
 * The two questions usually have one answer, and `resolveRunRecordMode` is it.
 * The desktop sidecar is the exception: the shell spawns `podium --takeover` as
 * a plain child and inherits stdio it never captures, so "foreground" is the
 * truth about its supervision and a lie about its console — a Finder-launched
 * .app's stdout goes nowhere, and the pretty sink wrote every record into it.
 * `PODIUM_DESKTOP_SUPERVISED` (set in apps/desktop/src-tauri/src/main.rs) is how
 * that process says so, and it takes the rotating file instead.
 *
 * NOTIFY_SOCKET still wins: a sidecar under systemd is journald's, and writing
 * a file as well is the double-writing @podium/runtime/logging exists to avoid.
 */
export function resolveLoggingMode(
  env: EnvSource = process.env,
): 'systemd' | 'detached' | 'foreground' {
  const supervised = resolveRunRecordMode(env)
  if (supervised === 'foreground' && env.PODIUM_DESKTOP_SUPERVISED === '1') return 'detached'
  return supervised
}

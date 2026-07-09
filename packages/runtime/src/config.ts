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
 * | PODIUM_STATE_DIR              | — (env-only)            | `stateDir()` (config/run-registry/logs home)           |
 * | PODIUM_PORT                   | config.port → 18787     | `resolvePort()` (cli, scripts entrypoints)             |
 * | PODIUM_HOST                   | — → 127.0.0.1           | apps/server bindHost (injectable env param)            |
 * | PODIUM_PASSWORD               | — (env-only, one-shot)  | apps/server applyEnvPassword (headless deploy seam)    |
 * | PODIUM_UPDATE_CHANNEL         | config.updateChannel    | `resolveUpdateChannel()`                               |
 * | PODIUM_UPDATE_FEED            | config.updateFeed       | `resolveUpdateFeed()`                                  |
 * | PODIUM_UPDATE_TARGET          | — → 'linux-x86_64'      | `resolveUpdateTarget()`                                |
 * | PODIUM_HOME                   | — → dirname(execPath)   | `resolveInstallDir()` (headless launcher exports it)   |
 * | PODIUM_RUN_MODE               | — (env-only)            | `resolveRunRecordMode()` ('detached' set by cli-spawn) |
 * | NOTIFY_SOCKET (systemd's)     | — (env-only)            | `resolveRunRecordMode()`, sd-notify                    |
 * | PODIUM_ISSUE_RELAY            | — (env-only)            | `resolveIssueRelay()` (daemon-injected per agent)      |
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/** Deployment mode chosen at setup. Unset = not yet configured. */
export const PodiumMode = z.enum(['all-in-one', 'daemon', 'client', 'server'])
export type PodiumMode = z.infer<typeof PodiumMode>

/** Persisted install config — the single source of truth shared by the CLI and the
 *  (later) Tauri shell. `serverUrl` is a ws://|wss:// relay URL for daemon/client modes. */
export const PodiumConfig = z.object({
  mode: PodiumMode.optional(),
  serverUrl: z.string().optional(),
  port: z.number().int().positive().optional(),
  /** One-shot pairing code for daemon mode (consumed once → token; a stale value is harmless). */
  pairCode: z.string().optional(),
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
   * Absent = not a headless-managed install (e.g. the desktop sidecar) or pre-dates the choice.
   */
  persistence: z.enum(['systemd', 'detached']).optional(),
  /**
   * Persistence INTENT recorded by a setup surface that cannot start/persist the backend
   * itself — the web `setup.complete`/`setup.join` run inside the serving process, which
   * can't safely self-daemonize (stopping the old backend would kill the process handling
   * the request). The next `podium` invocation reconciles it: starts the backend under this
   * persistence and replaces the field with `persistence` (issue #20).
   */
  pendingPersistence: z.enum(['systemd', 'detached']).optional(),
  /**
   * Node⇄hub sync (docs/spec/node-hub-sync.md §2.1): when present, this server is a NODE
   * that mirrors the hub at `url` (http(s):// or ws(s):// base) through the thin-client
   * protocol, authenticating with `token` — a hub-minted long-lived client-session token
   * (`scripts/mint-upstream-token.ts` on the hub). Absent = today's behavior, byte-identical.
   */
  upstream: z
    .object({
      url: z.string(),
      token: z.string(),
    })
    .optional(),
})
export type PodiumConfig = z.infer<typeof PodiumConfig>

/** The Podium state directory: $PODIUM_STATE_DIR, else ~/.podium. Home for config.json, the
 *  run registry (run/), logs (logs/), etc. */
export function stateDir(): string {
  return process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
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
}

/**
 * Read the config WITHOUT collapsing "corrupt" into "missing" (issue #21): callers that
 * would overwrite the file (setup flows) must distinguish a fresh box from a broken file —
 * silently re-setting-up over a corrupt config destroys whatever the operator had.
 */
export function inspectConfig(path = configPath()): ConfigInspection {
  if (!existsSync(path)) return { state: 'missing', config: {} }
  try {
    return { state: 'ok', config: PodiumConfig.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  } catch (err) {
    return {
      state: 'corrupt',
      config: {},
      error: err instanceof Error ? err.message : String(err),
    }
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
  const parsed = PodiumConfig.parse(config)
  if ((parsed.mode === 'daemon' || parsed.mode === 'client') && !parsed.serverUrl) {
    throw new Error(
      `refusing to save a mode=${parsed.mode} config without a serverUrl — the ${parsed.mode} ` +
        'would crash-loop at boot. Provide a server URL (join code) first.',
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
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
  return Number(env.PODIUM_PORT) || config.port || 18787
}

/** Self-update channel: PODIUM_UPDATE_CHANNEL → config.updateChannel → 'stable'. */
export function resolveUpdateChannel(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): 'stable' | 'edge' {
  return (env.PODIUM_UPDATE_CHANNEL ?? config.updateChannel ?? 'stable') as 'stable' | 'edge'
}

/** Self-update feed override: PODIUM_UPDATE_FEED → config.updateFeed → undefined
 *  (undefined = the default GitHub Releases feed). */
export function resolveUpdateFeed(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): string | undefined {
  return env.PODIUM_UPDATE_FEED ?? config.updateFeed
}

/** Self-update platform target: PODIUM_UPDATE_TARGET → 'linux-x86_64'. */
export function resolveUpdateTarget(env: EnvSource = process.env): string {
  return env.PODIUM_UPDATE_TARGET ?? 'linux-x86_64'
}

/** The headless install dir: PODIUM_HOME (exported by the headless launcher) →
 *  the running binary's own directory. */
export function resolveInstallDir(
  env: EnvSource = process.env,
  execPath: string = process.execPath,
): string {
  return env.PODIUM_HOME ?? dirname(execPath)
}

/** Daemon-injected issue-relay endpoint for a constrained agent process (env-only —
 *  set by apps/daemon per session; never configured by the operator). */
export function resolveIssueRelay(env: EnvSource = process.env): string | undefined {
  return env.PODIUM_ISSUE_RELAY
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

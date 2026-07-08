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
   * How the headless backend is kept running, chosen at setup (docs/superpowers/specs/
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

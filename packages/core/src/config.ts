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

/** $PODIUM_STATE_DIR/config.json, else ~/.podium/config.json. */
export function configPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
  return join(base, 'config.json')
}

/** Read + validate the config; a missing or corrupt file yields {} (treated as "needs setup"). */
export function loadConfig(path = configPath()): PodiumConfig {
  if (!existsSync(path)) return {}
  try {
    return PodiumConfig.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

/** Validate + write the config (pretty JSON). Throws on an invalid config. */
export function saveConfig(config: PodiumConfig, path = configPath()): void {
  const parsed = PodiumConfig.parse(config)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
}

/** True until a deployment mode has been chosen. */
export function needsSetup(config: PodiumConfig): boolean {
  return !config.mode
}

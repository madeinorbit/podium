import { join } from 'node:path'
import type { ModelChoice, ModelProbeContainment, ModelProbeScope } from '../../model-probe.js'

/**
 * Codex's model-probe statement (POD-4737 D3): the probe argv plus the parser
 * for its output shape, beside the adapter that owns them. The orchestration
 * (exec, timeout, fan-out in `model-probe.ts`) reads these; nothing restates
 * the binary or the grammar anywhere else.
 */

/**
 * `codex debug models` (JSON; the only non-interactive path — `codex models`
 * forwards to the TUI).
 */
export const codexModelProbeArgv = ['codex', 'debug', 'models'] as const

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
        supported_reasoning_levels?: Array<{ effort?: unknown }>
      }>
    }
    return (parsed.models ?? [])
      .filter(
        (
          m,
        ): m is {
          slug: string
          display_name?: string
          priority?: number
          supported_reasoning_levels?: Array<{ effort?: unknown }>
        } => Boolean(m.slug && m.visibility === 'list'),
      )
      .sort(
        (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
      )
      .map((m) => ({
        value: m.slug,
        label: m.display_name || m.slug,
        // Per-model effort from the CLI's own catalog (authoritative).
        efforts: (m.supported_reasoning_levels ?? [])
          .map((r) => r.effort)
          .filter((e): e is string => typeof e === 'string'),
      }))
  } catch {
    return []
  }
}

/**
 * The person's files `codex debug models` reads besides its login: the
 * settings that choose the model provider and profile, the admin layers kept in
 * `CODEX_HOME`, and the cached remote model list. Copied: a write to them lands
 * in the copy.
 */
const CODEX_MODEL_PROBE_COPIES = [
  'config.toml',
  'managed_config.toml',
  'requirements.toml',
  'models_cache.json',
] as const

/** A login kept in the system keyring (`keyring`, `auto`), named in a Codex
 *  settings file. Its keyring entry is keyed by the `CODEX_HOME` path. */
const CODEX_KEYRING_STORE = /^\s*cli_auth_credentials_store\s*=\s*["'](?!file["'])/m

/**
 * `codex debug models` in the person's own folder (POD-7392). Measured on
 * 0.171.0, every Codex start creates an `arg0` helper folder (a lock and three
 * links) under `CODEX_HOME/tmp/arg0-linux` and removes stale ones: that is the
 * write in the person's folder. The listing also refreshes an expiring
 * ChatGPT login ("proactive_expiry").
 *
 * The listing therefore runs with `CODEX_HOME` in the probe's temporary
 * folder. Codex refuses to make the helpers under the system temporary
 * folder, so none are made. Codex has no variable for the login path:
 *
 * - `auth.json` is linked in. Codex writes a refreshed login to a new file
 *   beside the link's target and renames it over the target, so the rotated
 *   token lands in the person's file and the link stays (measured with a real
 *   refresh against a local token server).
 * - `auth.lock`, the lock a refresh holds, is linked in even when it does not
 *   exist yet. The listing then waits for a refresh the person's own Codex is
 *   making (measured), and Codex creates the file there on its first refresh,
 *   as it does in place.
 * - `-c cli_auth_credentials_store="file"` keeps the login in that file. With
 *   a keyring store, a contained listing would save a refreshed login to a
 *   keyring entry for the temporary folder, and lose it. A person whose
 *   settings choose a keyring store, or who has no `auth.json`, is listed in
 *   place, so their keyring login is the one read.
 *
 * `CODEX_SQLITE_HOME` is set too, so a database variable in the account
 * environment cannot send the listing's writes back into a person's store.
 */
export function codexModelProbeContainment(
  scope: ModelProbeScope,
  root: string,
): ModelProbeContainment {
  const home = join(root, 'codex')
  const personal = scope.roots.state
  const login = join(scope.roots.credentials ?? personal, 'auth.json')
  return {
    env: { CODEX_HOME: home, CODEX_SQLITE_HOME: join(root, 'sqlite') },
    args: ['-c', 'cli_auth_credentials_store="file"'],
    requires: [login],
    inPlaceWhen: ['config.toml', 'managed_config.toml'].map((name) => ({
      path: join(personal, name),
      pattern: CODEX_KEYRING_STORE,
    })),
    links: [
      { from: login, to: join(home, 'auth.json') },
      { from: join(personal, 'auth.lock'), to: join(home, 'auth.lock'), evenWhenMissing: true },
    ],
    copies: CODEX_MODEL_PROBE_COPIES.map((name) => ({
      from: join(personal, name),
      to: join(home, name),
    })),
  }
}

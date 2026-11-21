import { join } from 'node:path'
import type { ModelChoice, ModelProbeContainment, ModelProbeScope } from '../../model-probe.js'

/**
 * Grok's model-probe statement (POD-4737 D3): the probe argv plus the parser
 * for its output shape, beside the adapter that owns them. The orchestration
 * (exec, timeout, fan-out in `model-probe.ts`) reads these; nothing restates
 * the binary or the grammar anywhere else.
 */

/** `grok models` — a marker list under "Available models:". */
export const grokModelProbeArgv = ['grok', 'models'] as const

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

/**
 * The person's files `grok models` reads besides its login: their settings
 * (custom models, the default model), the fleet and admin layers kept in
 * `GROK_HOME`, and the agent id and experiment records that pick an
 * experiment's default model. Copied, never linked: Grok writes `config.toml`
 * on first start, and that write must land in the copy.
 */
const GROK_MODEL_PROBE_COPIES = [
  'config.toml',
  'managed_config.toml',
  'requirements.toml',
  'agent_id',
  'experiments_state.json',
  'experiments_remote.json',
] as const

/**
 * `grok models` in the person's own folder (POD-7390). Even a model listing
 * starts Grok's whole shell: measured on 1.0.92, it appends to
 * `logs/unified.jsonl` and opens `sessions/session_search.sqlite` under
 * `GROK_HOME`. The listing therefore runs with `GROK_HOME` in the probe's
 * temporary folder and `GROK_AUTH_PATH` naming the person's `auth.json`, so the
 * account's model list is the one shown and a token Grok refreshes is saved
 * where the person's next start reads it. A login named by `GROK_AUTH` or an
 * existing `GROK_AUTH_PATH` in the account environment stays as it is.
 */
export function grokModelProbeContainment(
  scope: ModelProbeScope,
  root: string,
): ModelProbeContainment {
  const home = join(root, 'grok')
  const personal = scope.roots.state
  return {
    env: { GROK_HOME: home },
    envWhenPresent: {
      GROK_AUTH_PATH:
        scope.env.GROK_AUTH_PATH ?? join(scope.roots.credentials ?? personal, 'auth.json'),
    },
    copies: GROK_MODEL_PROBE_COPIES.map((name) => ({
      from: join(personal, name),
      to: join(home, name),
    })),
  }
}

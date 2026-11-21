import { join } from 'node:path'
import { selectedRoot } from '../../manifest.js'
import type { ModelChoice, ModelProbeContainment, ModelProbeScope } from '../../model-probe.js'

/**
 * OpenCode's model-probe statement (POD-4737 D3): the probe argv plus the
 * parser for its output shape, beside the adapter that owns them. The
 * orchestration (exec, timeout, fan-out in `model-probe.ts`) reads these;
 * nothing restates the binary or the grammar anywhere else.
 */

/** `opencode models` — one `provider/model` id per line. */
export const opencodeModelProbeArgv = ['opencode', 'models'] as const

/** opencode models → one `provider/model` id per line. */
export function parseOpencodeModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (/^[^\s/]+\/\S+$/.test(line)) models.push({ value: line, label: line })
  }
  return models
}

/**
 * `opencode models` in the person's own folders (POD-7390). A model listing
 * boots a full OpenCode instance for the working directory: measured on
 * 1.19.6, it appends to `log/opencode.log` and writes `opencode.db` under the
 * data folder, rewrites the project lock files under the state folder, and
 * refreshes the models.dev cache. OpenCode has no single folder variable, so
 * the data, state and cache folders all move into the probe's temporary
 * folder, the working directory with them. What the listing reads stays the
 * person's:
 *
 * - the config folder (`XDG_CONFIG_HOME`), which defines custom providers;
 * - `auth.json`, linked into the moved data folder, so a write OpenCode makes
 *   to the login lands on the person's file;
 * - their models.dev cache, through `OPENCODE_MODELS_PATH`, when it exists.
 *   Without it OpenCode falls back to its bundled snapshot or a fetch.
 *
 * `OPENCODE_DB` is set too, so a database variable in the account environment
 * cannot send the listing's writes back into a person's store.
 */
export function opencodeModelProbeContainment(
  scope: ModelProbeScope,
  root: string,
): ModelProbeContainment {
  const data = join(root, 'data')
  const personalCache = selectedRoot(scope.env, 'XDG_CACHE_HOME', scope.home, '.cache')
  const personalAuth = join(scope.roots.credentials ?? scope.roots.state, 'auth.json')
  return {
    env: {
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_DB: join(data, 'opencode', 'opencode.db'),
    },
    envWhenPresent: {
      OPENCODE_MODELS_PATH:
        scope.env.OPENCODE_MODELS_PATH ?? join(personalCache, 'opencode', 'models.json'),
    },
    links: [{ from: personalAuth, to: join(data, 'opencode', 'auth.json') }],
  }
}

import { join } from 'node:path'
import type { ModelChoice, ModelProbeContainment, ModelProbeScope } from '../../model-probe.js'

/**
 * Pi's model-probe statement (POD-4737 D3): the probe argv plus the parser
 * for its output shape, beside the adapter that owns them. The orchestration
 * (exec, timeout, fan-out in `model-probe.ts`) reads these; nothing restates
 * the binary or the grammar anywhere else.
 */

/** `pi --list-models` — a whitespace table. */
export const piModelProbeArgv = ['pi', '--list-models'] as const

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** pi --list-models → a whitespace table `provider model context max-out thinking images`
 *  (verified against pi 0.84.4). The id Podium passes back is `provider/model`, the
 *  form `--model` accepts. A model whose thinking column is `yes` takes every
 *  thinking level; `no` means the effort picker has nothing to offer. */
export function parsePiModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  let inTable = false
  for (const raw of out.split('\n')) {
    const cells = raw.trim().split(/\s+/)
    if (cells.length < 2) continue
    const [provider, model] = cells
    if (!provider || !model) continue
    // Rows count only under the table header; prose ("No models found") never does.
    if (provider === 'provider' && model === 'model') {
      inTable = true
      continue
    }
    if (!inTable) continue
    const thinking = cells[4]
    models.push({
      value: `${provider}/${model}`,
      label: `${provider}/${model}`,
      efforts: thinking === 'yes' ? [...PI_THINKING_LEVELS] : [],
    })
  }
  return models
}

/**
 * `pi --list-models` in the person's own agent folder (POD-7392). Measured on
 * 1.6.0, a listing creates `auth.json`, `settings.json` and `models-store.json`
 * there when they are absent and refreshes the provider catalogs in
 * `models-store.json`. The listing therefore runs with `PI_CODING_AGENT_DIR` in
 * the probe's temporary folder. What it reads stays the person's:
 *
 * - `auth.json` is linked in. Pi writes the login through the link and locks
 *   the link's target, so a refreshed token lands in the person's file under
 *   the lock their own Pi takes (Pi supports linked logins, #11655).
 * - `extensions`, `npm` and `git` are linked in: the extensions and packages
 *   that can add providers to the list.
 * - `settings.json`, `models.json` (custom providers) and `models-store.json`
 *   are copied.
 *
 * Pi's managed install finds itself from its launcher, so its own
 * `install/update.lock` stays where it is.
 */
export function piModelProbeContainment(
  scope: ModelProbeScope,
  root: string,
): ModelProbeContainment {
  const dir = join(root, 'pi')
  const personal = scope.roots.state
  const login = join(scope.roots.credentials ?? personal, 'auth.json')
  return {
    env: { PI_CODING_AGENT_DIR: dir },
    links: [
      { from: login, to: join(dir, 'auth.json') },
      ...['extensions', 'npm', 'git'].map((name) => ({
        from: join(personal, name),
        to: join(dir, name),
      })),
    ],
    copies: ['settings.json', 'models.json', 'models-store.json'].map((name) => ({
      from: join(personal, name),
      to: join(dir, name),
    })),
  }
}

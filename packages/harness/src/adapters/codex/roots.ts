import { join } from 'node:path'
import { type HarnessEnvironment, type HarnessRoots, selectedRoot } from '../../manifest.js'

/**
 * Where Codex keeps its state (POD-6532): `CODEX_HOME` when set, else
 * `<home>/.codex`. Auth, config and `hooks.json` sit in that root; rollouts
 * under `sessions/`.
 *
 * This is the ONE Codex folder rule. The manifest declares it as `roots`, and
 * every Codex module that needs a folder calls it rather than joining `.codex`
 * itself. Modules inside the adapter import it directly instead of going
 * through the registry, which imports this adapter.
 */
export function codexRoots(home: string, env: HarnessEnvironment): Required<HarnessRoots> {
  const state = selectedRoot(env, 'CODEX_HOME', home, '.codex')
  return {
    state,
    config: state,
    credentials: state,
    transcripts: join(state, 'sessions'),
    hooks: state,
  }
}

/**
 * TRANSITIONAL (POD-6532 until POD-6533/POD-6534 hand callers a context).
 *
 * Many Codex call sites hold a home plus an already-resolved Codex home
 * (`codexHome`) instead of an environment. Treating that value
 * as the `CODEX_HOME` selector routes them through the same rule rather than a
 * separate `?? join(home, '.codex')`.
 */
export function codexRootsFor(home: string, codexHome: string | undefined): Required<HarnessRoots> {
  return codexRoots(home, codexHome ? { CODEX_HOME: codexHome } : {})
}

import { join } from 'node:path'
import { type HarnessEnvironment, type HarnessRoots, selectedRoot } from '../../manifest.js'

/**
 * Where Claude Code keeps its state (POD-6532/POD-6534): `CLAUDE_CONFIG_DIR`
 * when set, else `<home>/.claude`. Settings, `.credentials.json` and the
 * `projects/` transcript store sit in that root — the same precedence the
 * credential layout's `homeEnvVar` uses.
 *
 * The ONE Claude folder rule: the manifest declares it as `roots`, and the
 * adapter's own readers (transcript locate) call it rather than joining
 * `.claude` themselves.
 */
export function claudeRoots(
  home: string,
  env: HarnessEnvironment,
): Required<Pick<HarnessRoots, 'state' | 'config' | 'credentials' | 'transcripts'>> {
  const state = selectedRoot(env, 'CLAUDE_CONFIG_DIR', home, '.claude')
  return { state, config: state, credentials: state, transcripts: join(state, 'projects') }
}

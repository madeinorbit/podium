import { join } from 'node:path'
import type { HarnessInstallation } from '../../harness-context-types.js'
import type { HarnessAccountScope, HarnessEnvironment } from '../../manifest.js'
import { gateHarnessVersion, HARNESS_VERSION_POLICIES } from '../../version-policy.js'

/** Podium's selector; agy itself takes --gemini_dir, not an environment variable. */
export const ANTIGRAVITY_HOME = 'PODIUM_ANTIGRAVITY_HOME'
export const ANTIGRAVITY_TOKEN = 'antigravity-cli/antigravity-oauth-token'
export const CONVERSATION_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu

export function antigravityRoots(home: string, env: HarnessEnvironment) {
  const gemini = env[ANTIGRAVITY_HOME]?.trim() || join(home, '.gemini')
  const state = join(gemini, 'antigravity-cli')
  return {
    state,
    config: join(gemini, 'config'),
    credentials: gemini,
    transcripts: join(state, 'brain'),
    hooks: join(gemini, 'config'),
  }
}

export function antigravityAccountCommand(
  account: HarnessAccountScope & { installation?: HarnessInstallation },
) {
  const version = account.installation?.version
  if (version && gateHarnessVersion(HARNESS_VERSION_POLICIES.antigravity, version) === 'too-old') {
    throw new Error(`Antigravity ${version} is too old; update agy before starting this session`)
  }
  return {
    args: [
      '--gemini_dir',
      account.roots.credentials ?? join(account.home, '.gemini'),
      '--app_data_dir',
      'antigravity-cli',
    ],
    // Native remote sign-in is the CLI's supported file-token storage path.
    // A custom directory alone still reads the shared OS keyring. Use the
    // remote-auth detector only for isolated homes, so two Google accounts
    // never overwrite the same keyring entry. Preserve a real SSH connection.
    ...(account.env[ANTIGRAVITY_HOME]
      ? { env: { SSH_CONNECTION: account.env.SSH_CONNECTION || 'podium-managed-home' } }
      : {}),
  }
}

export function transcriptPath(root: string, id: string): string | undefined {
  return CONVERSATION_ID.test(id)
    ? join(root, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl')
    : undefined
}

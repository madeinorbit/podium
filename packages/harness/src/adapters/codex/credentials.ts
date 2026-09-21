/**
 * Codex credential file — the Inventory credentials section (POD-4414 §4.4,
 * issue 3.3).
 *
 * KNOWLEDGE, not mechanism: `~/.codex/auth.json` backs the portable `codex`
 * bundle, validity is both halves of the refresh lineage, and freshness orders
 * by the token expiry the file carries. The inventory mechanism resolves,
 * reads, writes and guards through this declaration without naming the
 * harness.
 */
import {
  compareCodexAuthFreshness,
  readFreshnessFromAuthContents,
  readIdentityFromAuthContents,
} from '../../codex-auth-identity.js'
import { hasValidCodexCredential } from '../../credential-freshness.js'
import { supported, unsupported, type HarnessCredentials } from '../../manifest.js'

export const codexCredentials: HarnessCredentials = {
  kinds: ['codex'],
  files: [
    {
      kind: 'codex',
      dirName: '.codex',
      fileName: 'auth.json',
      homeEnvVar: 'CODEX_HOME',
      propagatable: true,
      validate: hasValidCodexCredential,
      freshness: readFreshnessFromAuthContents,
      compareFreshness: compareCodexAuthFreshness,
    },
  ],
  identity: (read) => {
    const raw = read('.codex', 'auth.json')
    return raw ? readIdentityFromAuthContents(raw) : undefined
  },
  transfer: unsupported('Codex credentials live in a plain file; no platform transfer applies'),
}

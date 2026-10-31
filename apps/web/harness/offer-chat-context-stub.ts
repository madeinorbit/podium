/**
 * The offer harness's `use-chat-context` (POD-2111). The evidence row finds its
 * issue through the worklist pool, which a harness with no server never fills,
 * so this hands it the stub store's issue directly. Redirected by RESOLVED PATH
 * in vite.offer-harness.config.ts, like the store stub beside it.
 */
import { ISSUE } from './offer-store-stub'

export function useChatArtifactIssue(_session: unknown): typeof ISSUE {
  return ISSUE
}

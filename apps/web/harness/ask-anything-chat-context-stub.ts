/** The ask-anything harness's `use-chat-context` (POD-2198): no server, so no @ mentions. */
export function useChatMentions(_query: string | null): [] {
  return []
}
export { useChatArtifactIssue } from './offer-chat-context-stub'

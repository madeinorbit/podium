/**
 * Re-export shim: the shared nav/pin view types moved to
 * @podium/client-core/viewmodels (platform-neutral). Kept so existing
 * `./types` imports keep working.
 */
export type { PinKind, PinState, RepoView, WorktreeView } from '@podium/client-core/viewmodels'
export type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'

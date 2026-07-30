/**
 * @podium/protocol — wire types + codecs for agent/terminal sessions.
 */
export * from './delegation'
export * from './features'
export * from './handshake'
// Branded entity ids and the two legacy composite-key helpers moved to
// @podium/model (POD-361) — the L0 root, where a brand is reachable from every
// layer, which is what let the entity schemas adopt them. Re-exported HERE, in
// the barrel, rather than from a `src/ids.ts` tombstone: an all-re-export file is
// debt the deletion audit counts, and a barrel is the legitimate way to keep
// `@podium/protocol`'s import path stable. The surface is exactly what `ids.ts`
// exported before the move; POD-361's ADDITIONS (the field-position schemas,
// UserId, the tier-2 brands, EntityRef and the two new key shapes) are reachable
// only from @podium/model — they have no old path to preserve, and one of them
// would have collided with `planes/routing.ts`'s own weaker EntityRef (POD-1134).
// POD-362 / POD-363 re-point consumers at @podium/model and delete this block.
export {
  asConversationId,
  asIssueId,
  asMachineId,
  asMutationId,
  asRepoId,
  asSessionId,
  asThreadId,
  ConversationId,
  IssueId,
  MachineId,
  machineScopedKey,
  MutationId,
  parseMachineScopedKey,
  parseResumeKey,
  RepoId,
  resumeKey,
  SessionId,
  ThreadId,
} from '@podium/model'
export * from './maintenance'
export * from './messages'
export * from './perf'
export * from './planes'
export * from './refs'
export * from './relations'
export * from './session-cookie'
export * from './titles'
export * from './version'

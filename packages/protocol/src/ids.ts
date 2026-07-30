/**
 * RE-EXPORT SHIM — the brands and composite keys moved to `@podium/model` at
 * POD-361, which is where this file's own header always said they were going
 * ("P1 is additive-only: nothing adopts these yet; later phases migrate call
 * sites incrementally"). `packages/model` is the L0 zero-dependency root, so a
 * brand defined there is reachable from every layer; a brand defined here was
 * not reachable from `packages/model`, which is why the entity schemas could not
 * adopt these until they moved.
 *
 * THIS FILE IS ONE OF THE EDGE SHIMS POD-362 / POD-363 DELETE. It exists so that
 * POD-361 updates NO consumer: every `import { asSessionId } from
 * '@podium/protocol'` keeps working unchanged. When the sweeps re-point those
 * imports at `@podium/model`, delete this file and its line in `index.ts`.
 * `docs/rearch-branded-id-flip.md` §6 enumerates the shims.
 *
 * `UserId` is NOT re-exported here: its old home is `planes/principal.ts`, which
 * keeps its own shim, and re-exporting it from two files in one package would
 * make `@podium/protocol`'s barrel ambiguous. One old path per moved name.
 *
 * THE SURFACE IS EXACTLY WHAT THIS FILE EXPORTED BEFORE THE MOVE — the seven
 * brands, their casts, and the two legacy key helpers. POD-361's ADDITIONS (the
 * field-position schemas, `UserId`, the tier-2 brands, `EntityRef` and the two
 * new key shapes) are reachable ONLY from `@podium/model`: they have no old path
 * to preserve, and shimming them would hand consumers a second import site to
 * unpick later. One of them would also have collided outright —
 * `planes/routing.ts` already exports a DIFFERENT `EntityRef` (see POD-1129).
 *
 * NOTHING new may be added here. A new brand or a new composite key belongs in
 * `packages/model/src/ids/` — the single-definition-site rule is the entire point
 * of the move, and an addition here would re-create the split home it closed.
 */

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
  MutationId,
  machineScopedKey,
  parseMachineScopedKey,
  parseResumeKey,
  RepoId,
  resumeKey,
  SessionId,
  ThreadId,
} from '@podium/model'

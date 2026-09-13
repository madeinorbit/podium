/**
 * THE FILE-ACCESS GATE AS A PORT (PDM-272) — every door the `files` family has
 * onto bytes, each pre-bound to ONE caller, so a handler runs the right
 * authorization without ever being handed an authority object.
 *
 * ---------------------------------------------------------------------------
 * WHY A PORT AND NOT A PRINCIPAL ON THE STATE BUNDLE
 * ---------------------------------------------------------------------------
 *
 * Argued ONCE, in `derived-family.ts`'s header section "THE DECISIONS THIS FILE
 * DOES TAKE", under the THIRD position `PDM-290` opened and `PDM-297`,
 * `PDM-308` extended — not re-argued here, because two statements of one rule is
 * how the two come to disagree. This is that position's FIFTH member, and like
 * the fourth it needed no new rule to fit.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATE OWNS THE RPC RATHER THAN SITTING BESIDE IT
 * ---------------------------------------------------------------------------
 *
 * This is the part that is not merely the established shape, and it is
 * deliberate. The defect PDM-272 repairs was not one forgotten check — it was
 * that `FileState` NAMED `rpc`, `artifacts` and `repos` and named no identity at
 * all. Three handlers authorized on the path because the path was the only thing
 * they could see; `state.caller` was not in their seam and neither was any
 * principal. A family that cannot ask who is calling will answer with what it
 * has, and what it had was `isAllowedRoot`.
 *
 * So the repair is not `await assertMayRead(state, input)` at the top of three
 * handlers. `PDM-276` landed the argument this copies: a guard is one edit away
 * from removal, while "every caller happens to pass it" is a convention and not
 * a property. `FileState` is now `{ files: FileAccessGate }` and NOTHING ELSE —
 * the daemon RPC, the artifact store and the repo registry are all unreachable
 * from a file handler. A handler cannot read a byte without calling a method
 * here, and every method refuses or acts. There is no boolean to forget and no
 * second path to the bytes to forget it on.
 *
 * ---------------------------------------------------------------------------
 * THE THREE QUESTIONS, AND WHY EACH IS SOMEONE ELSE'S RULE
 * ---------------------------------------------------------------------------
 *
 * This file invents no policy. Each door asks the rule that already governs its
 * resource elsewhere, which is the whole of why it can be believed:
 *
 *  - A SESSION'S FILES — `mayReadSessionPrivate`, the rule `sessions.transcriptRead`,
 *    `read`, `recap` and `status` all run. That neighbour is the evidence the
 *    finding rests on: two reads of ONE session's bytes sat in adjacent modules,
 *    one asserting ownership and one asserting nothing. They now run one
 *    predicate, from one home, and `queries.authz.test.ts` pins the pair
 *    together so they cannot drift apart again.
 *
 *  - AN ISSUE'S ARTIFACT — `checkIssueAccess(…, 'read', issueId)`, the ONE
 *    issue-access gate. The shipped arm served `artifacts.read(issueId, …)` for
 *    ANY issue id the caller named, guarded only by a traversal check on the
 *    path beneath it.
 *
 *  - A ROOT ON A MACHINE — `checkMachineUse`, B2's owned-compute boundary, which
 *    is the question `isAllowedRoot` was standing in for and cannot answer.
 *    `assertAllowedRoot` is KEPT and runs FIRST, unchanged: containment is not
 *    authorization, but it is still containment, and dropping it while adding an
 *    identity check would trade one hole for another.
 *
 * THE MACHINE IS RESOLVED ONCE, HERE, and the resolved id is what gets both
 * CHECKED and DISPATCHED — `sessions.status`'s rule, for the same reason it
 * needed it. Resolving a second time inside the RPC would let the machine the
 * gate authorized and the machine the read executed on disagree, which is a
 * check that is merely adjacent to the thing it claims to govern.
 *
 * NOTE FOR PDM-261 / PDM-262. Those two cover the RAW HTTP routes over these
 * same bytes (`GET /files/artifact/…`, `GET /files/asset`). This gate is the
 * predicate they were told to adopt if one served all five doors: it does.
 *
 * PDM-262 ARRIVED SECOND AND CORRECTED THE SENTENCE THAT USED TO END HERE,
 * which named `readArtifact` and `readRoot` as "the two methods they want".
 * That split is wrong in both halves. `readArtifact` is PDM-261's alone.
 * `GET /files/asset` has TWO arms — one addressed by session and one by root —
 * so PDM-262 wants a session door and a root door, not one of them; and neither
 * of the doors that existed fits it, because both dispatch `rpc.readFile` while
 * an asset read is `rpc.readAsset`: binary, ranged, and answering `size`. So
 * PDM-262 added `readSessionAsset` and `readRootAsset` rather than reusing a
 * door whose only resemblance was its name. THE PREDICATES ARE UNCHANGED AND
 * UNDUPLICATED — each new door calls the same `mayReadSessionPrivate` /
 * `requireRoot` its text neighbour calls. PDM-251 renamed that first predicate
 * and narrowed its ANSWER (a session is private, so a task grantee no longer
 * reads its files) after these doors were written, and both doors moved with it
 * in ONE edit — which is the whole return on sharing a predicate rather than
 * copying one. Across the two issues it is THREE
 * methods, not two, and the gate now has seven doors rather than five.
 *
 * PDM-261 ADOPTED `readArtifact` AND CHANGED ONE THING ABOUT IT: the method now
 * forwards a byte `range`. `GET /files/artifact/…` serves `Range` requests and
 * the method could not, so adopting it as written would have meant the route
 * keeping a direct store read for ranged requests — an authorized door beside
 * an unauthorized one, which is the shape this port exists to make impossible.
 * The authorization is untouched: `checkIssueAccess` runs first and unchanged,
 * and `file-artifact-route.authz.test.ts` drives the raw route and `files.read`
 * over one fixture so a break in that single call reddens both.
 *
 * PDM-262'S TWO ASSET DOORS TAKE A RANGE FOR THE SAME REASON AND ON THAT
 * PRECEDENT — argued once, above, not re-decided. Its route has three read
 * paths, and the suffix path issues a ONE-BYTE PROBE READ before anything else,
 * so a door that could only answer with a whole file would have left the probe
 * outside the gate: `Range: bytes=-1` would serve the first byte and the true
 * size of anyone's file while every plain-path test stayed green.
 *
 * PDM-262 ALSO MOVED THE `..` COLLAPSE INTO `requireRoot`, which changed
 * BEHAVIOUR ON THE tRPC SIDE and is called out here rather than left to be
 * discovered: see that function's header. The raw asset route had the collapse
 * and `files.read` / `list` / `search` did not, so the containment half of this
 * gate was defeatable on the transport with more callers.
 *
 * Neither issue closing disposes of the other.
 */

import { isAbsolute, resolve } from 'node:path'
import {
  asMachineId,
  type ArtifactId,
  type Capability,
  type IssueId,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type {
  DirListResultMessage,
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
} from '@podium/protocol'
import type { OpResult } from '../machines/rpc'
import { TRPCError } from '@trpc/server'
import type { CommandPrincipal } from '../../command-principal'
import { checkIssueAccess, type IssueAccessIndex } from '../../issue-authz'
import { checkMachineUse, machineAccessMessage, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import type { RepoRegistry } from '../../repo-registry'
import { isAllowedRoot } from '../../root-allowlist'
import { asyncSessionIssueAccess, mayReadSessionPrivate } from '../sessions/session-access'

/** The four modules a file decision reads. A `Pick`, so a caller cannot reach
 *  the rest of the seam through this argument — the same narrowing
 *  `SessionAccessModules` and `OperationAccessModules` apply. */
export type FileAccessModules = Pick<
  RegistryModules,
  'rpc' | 'issueArtifacts' | 'sessions' | 'issues' | 'machines'
>

/** The identity half of one request, as the two rules that need it take it.
 *  `userId` decides the session rule; `capability` decides the issue rule. This
 *  is NOT widened to the whole `Capability` for the session arm — see
 *  `FamilyState.caller`'s header on why a handler gets names and not authority.
 *  The gate may hold both because the gate IS the decision. */
export interface FileCaller {
  readonly userId: UserId | undefined
  readonly capability: Capability
  readonly overrideScope?: boolean
}

/**
 * One caller's file-access gate.
 *
 * EVERY METHOD REFUSES OR ACTS — there is no predicate for a handler to call and
 * ignore, and no way to reach the bytes except through one of these.
 */
export interface FileAccessGate {
  /** One file of ONE SESSION, if this caller may read that session. */
  readSession(
    sessionId: SessionId,
    path: string,
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>>
  /**
   * One file of ONE ISSUE'S ARTIFACT, if this caller may read that issue.
   *
   * `range` IS HERE FOR THE RAW ROUTE (PDM-261), and it is a parameter rather
   * than a second method on purpose. `GET /files/artifact/…` serves `Range`
   * requests — a video artifact is seeked, not downloaded whole — so a gate
   * that could only answer with the entire file would have left that route
   * reading the store directly for exactly the requests where it matters most,
   * which is the hole this port exists to make unreachable. The store's own
   * `read` has taken this shape since the route was written; the gate now
   * forwards it instead of narrowing it away.
   */
  readArtifact(
    issueId: IssueId,
    artifactId: ArtifactId,
    path: string,
    range?: { offset: number; length: number },
  ): Promise<{ bytes: Buffer; contentType: string; size: number } | null>
  /** One file under an allowed root, on a machine this caller may use. */
  readRoot(
    root: string,
    path: string,
    machineId?: MachineId,
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>>
  /**
   * ONE SESSION'S ASSET BYTES, if this caller may read that session — the same
   * predicate `readSession` runs, over the other daemon op.
   *
   * A SECOND DOOR RATHER THAN A FLAG ON THE FIRST, because `readFile` and
   * `readAsset` are genuinely different reads: assets are binary, ranged, and
   * answer `size` so a partial-content response can be built. Collapsing them
   * into one method with an optional range would make the text door carry a
   * parameter it cannot honour. The AUTHORIZATION is what is shared, and it is
   * shared by construction — both call `mayReadSessionPrivate` below, once.
   */
  readSessionAsset(
    sessionId: SessionId,
    path: string,
    range?: { offset: number; length: number },
  ): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>>
  /** Asset bytes under an allowed root, on a machine this caller may use. */
  readRootAsset(
    root: string,
    path: string,
    machineId?: MachineId,
    range?: { offset: number; length: number },
  ): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>>
  /** One directory under an allowed root, on a machine this caller may use. */
  listRoot(
    root: string,
    path: string | undefined,
    machineId?: MachineId,
  ): Promise<Omit<DirListResultMessage, 'type' | 'requestId'>>
  /**
   * REFUSE UNLESS THIS CALLER MAY SEARCH THIS ROOT, and answer with the machine
   * the search will run on.
   *
   * This is the one method here that authorizes WITHOUT acting, and it exists
   * for a reason the other doors do not have: `files.search` serves a keystroke
   * from a process-wide index cache, so its loader does not run on a cache hit.
   * A gate consulted only inside that loader would authorize the first caller
   * and then serve the warm index to everyone. So the handler calls this on
   * every request and `lsFiles` only on a miss.
   *
   * The resolved machine comes back because the cache is keyed per (machine,
   * root) and must key on the machine the op ACTUALLY ran on. Keyed on the
   * caller's optional `machineId`, the default machine's index files under
   * `undefined` and is then served to a caller who named another machine.
   *
   * THE RESOLVED ROOT COMES BACK FOR THE SAME REASON (PDM-262), now that
   * `requireRoot` collapses `..`. Authorizing `/repo` and then keying the cache
   * on the caller's `/repo/sub/..` files one checkout's index under two names —
   * and worse, keying on the RAW string is what lets an unnormalized spelling
   * address an entry the normalized check never approved. Both values that come
   * back are the ones the op must use.
   */
  requireSearchableRoot(
    root: string,
    machineId?: MachineId,
  ): Promise<{ root: string; machineId: MachineId }>
  /** The path index of an allowed root, on a machine this caller may use. Runs
   *  the same gate again rather than trusting its caller to have run it. */
  lsFiles(root: string, machineId: MachineId): Promise<OpResult>
  /**
   * THE WRITE, WHOSE BEHAVIOUR IS UNCHANGED AND DELIBERATELY SO.
   *
   * `files.write` is a COMMAND and is not a row of the A3.2 read census PDM-272
   * came from; its session-addressed arm has the same unchecked shape the read's
   * did, and that is filed rather than fixed here — a read-authorization issue
   * that quietly re-authorizes a write is not reviewable. It is on the gate only
   * because `FileState` must stop naming `rpc` for the READS to be safe by
   * construction, and the write would otherwise have kept that door open for
   * everyone. The root allowlist below is `assertAllowedRoot` moved verbatim.
   */
  writeFile(
    input:
      | { sessionId: SessionId; path: string; content: string; baseHash?: string }
      | { machineId?: MachineId; root: string; path: string; content: string; baseHash?: string },
  ): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>>
}

/** The shipped FORBIDDEN, moved verbatim from `registry.ts` and unchanged.
 *
 *  EXPORTED FOR `git`, WHICH IS NOT YET REPAIRED. `modules/misc-queries.ts`'s
 *  five `GIT_QUERIES` (`status`, `log`, `diffFile`, `commitFiles`,
 *  `commitDiffFile`) run this and nothing else, on a caller-supplied
 *  `machineId` — the SAME defect this file repairs for `files`, on five more
 *  procedures, and they were outside PDM-272's census rows. They keep the
 *  shipped behaviour here rather than being silently re-authorized by a read
 *  issue; the finding is filed with a pointer to `fileAccessGate`, whose
 *  `requireSearchableRoot` is the method they want.
 *  CONTAINMENT, not authorization — it asks whether a path is a known repository
 *  and cannot ask whether this caller may read what is inside it. It is kept
 *  because it is still a true containment rule; every root-addressed method below
 *  runs it BEFORE the identity check it was standing in for. */
export const assertAllowedRoot = async (repos: RepoRegistry, root: string): Promise<void> => {
  if (!isAllowedRoot(await repos.list(), root)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
  }
}

export function fileAccessGate(
  modules: FileAccessModules,
  repos: RepoRegistry,
  caller: FileCaller,
  principal: CommandPrincipal,
): FileAccessGate {
  /**
   * THE MACHINE THIS READ WILL RUN ON, decided once.
   *
   * An omitted `machineId` is resolved to the default machine rather than left
   * for the broker to pick, so the id this function returns is the id the RPC is
   * then told to use. That is what makes the `use` check below a statement about
   * the machine that serves the bytes rather than about a machine that might.
   */
  const resolveTarget = async (machineId?: MachineId): Promise<MachineId> =>
    machineId ?? asMachineId(await modules.machines.defaultMachine())

  /** Refuse unless this caller may `use` the machine the read will run on.
   *
   *  ABSENT AND UNAUTHORIZED KEEP THEIR OWN CODES, as `checkMachineVerb`
   *  distinguishes them and `operationTargetGate` keeps them: a machine this
   *  caller cannot see is NOT_FOUND, so the surface is not an existence oracle
   *  for other people's machines. */
  const requireUsable = async (machineId: MachineId): Promise<void> => {
    const failure = checkMachineUse(
      principal,
      machineId,
      await ownershipSnapshotFromMachines(modules.machines),
    )
    if (!failure) return
    throw new TRPCError({
      code: failure === 'absent' ? 'NOT_FOUND' : 'FORBIDDEN',
      message: machineAccessMessage(failure, machineId, undefined),
    })
  }

  /**
   * NORMALIZE, then containment, then identity, then the resolved machine — in
   * that order, for every root-addressed door, and it hands BOTH resolved
   * values back so the caller dispatches what was authorized.
   *
   * THE COLLAPSE IS NEW HERE (PDM-262) AND IT CLOSES A HOLE ON THE tRPC SIDE.
   * `isAllowedRoot` prefix-matches LEXICALLY, so `/repo/../../etc` starts with
   * `/repo/` and passes it while the daemon resolves the path to `/etc`. The raw
   * `GET /files/asset` route already collapsed `..` before asking — it carries a
   * comment saying exactly why — but `files.read`, `list` and `search` handed
   * their `root` string to `assertAllowedRoot` untouched, so the containment
   * rule was defeatable on the transport that had more callers. Doing it here
   * rather than in the route is the point: ONE collapse, before the one
   * allowlist, for every door.
   *
   * `resolve` is LEXICAL — it is not `realpath`, touches no filesystem and
   * follows no symlink — which is what makes it safe to run server-side on a
   * path that belongs to a remote daemon's machine. `root-allowlist.ts` warns
   * against server-side realpath for exactly that reason; this is not that.
   *
   * A RELATIVE ROOT IS REFUSED rather than resolved, because `resolve` would
   * otherwise complete it against the SERVER's cwd and authorize a path the
   * caller never named.
   */
  const requireRoot = async (
    root: string,
    machineId?: MachineId,
  ): Promise<{ root: string; machineId: MachineId }> => {
    if (!isAbsolute(root)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'root must be an absolute path' })
    }
    const scoped = resolve(root)
    await assertAllowedRoot(repos, scoped)
    const target = await resolveTarget(machineId)
    await requireUsable(target)
    return { root: scoped, machineId: target }
  }

  return {
    async readSession(sessionId, path) {
      const mayRead = await mayReadSessionPrivate(
        caller.userId,
        sessionId,
        async (id) => await modules.sessions.sessionOwner(id as never),
      )
      // NOT_FOUND, not FORBIDDEN, and the same refusal `transcriptRead` gives —
      // FORBIDDEN would confirm the session exists.
      if (!mayRead) throw new TRPCError({ code: 'NOT_FOUND' })
      return await modules.rpc.readFile({ sessionId, path })
    },

    async readArtifact(issueId, artifactId, path, range) {
      await checkIssueAccess(
        {
          capability: caller.capability,
          ...(caller.overrideScope ? { overrideScope: true } : {}),
        },
        asyncSessionIssueAccess(modules.issues as never),
        'files.read',
        'read',
        issueId,
      )
      return await modules.issueArtifacts.read(issueId, artifactId, path, range)
    },

    async readRoot(root, path, machineId) {
      const target = await requireRoot(root, machineId)
      return await modules.rpc.readFile({
        machineId: target.machineId,
        root: target.root,
        path,
      })
    },

    /**
     * THE RAW-HTTP READS (PDM-262). `GET /files/asset` has these two arms and
     * had no identity in its port at all: its session arm consulted NOTHING,
     * and its root arm consulted `allowsRoot`, which takes a path and a machine
     * and has nowhere to put a caller. Both now ask the same questions their
     * tRPC neighbours ask, from this one home.
     *
     * THE REFUSAL CODES ARE THE NEIGHBOURS' AND NOT THE ROUTE'S CONVENIENCE:
     * `readSessionAsset` refuses NOT_FOUND for the same reason `readSession`
     * does — FORBIDDEN would confirm that a session id someone guessed is real,
     * which on this surface is the whole thing worth not leaking.
     */
    async readSessionAsset(sessionId, path, range) {
      const mayRead = await mayReadSessionPrivate(
        caller.userId,
        sessionId,
        async (id) => await modules.sessions.sessionOwner(id as never),
      )
      if (!mayRead) throw new TRPCError({ code: 'NOT_FOUND' })
      return await modules.rpc.readAsset({ sessionId, path, ...(range ?? {}) })
    },

    async readRootAsset(root, path, machineId, range) {
      const target = await requireRoot(root, machineId)
      return await modules.rpc.readAsset({
        machineId: target.machineId,
        root: target.root,
        path,
        ...(range ?? {}),
      })
    },

    async listRoot(root, path, machineId) {
      const target = await requireRoot(root, machineId)
      return await modules.rpc.listDir({
        machineId: target.machineId,
        root: target.root,
        ...(path !== undefined ? { path } : {}),
      })
    },

    async requireSearchableRoot(root, machineId) {
      return await requireRoot(root, machineId)
    },

    async lsFiles(root, machineId) {
      const target = await requireRoot(root, machineId)
      return await modules.rpc.repoOp('lsFiles', target.root, undefined, target.machineId)
    },

    async writeFile(input) {
      // Moved verbatim from `FILE_COMMANDS_TRPC.write`: the union's
      // session-addressed arm resolves its root from the session and carries no
      // `root` to check; the explicit arm is gated. See the interface note on
      // why this is preserved rather than repaired here.
      //
      // THE INPUT AND RESULT TYPES ARE THE RPC'S OWN, not `unknown`. The first
      // draft of this method took and returned `unknown` — every test passed and
      // `apps/web` lost `AppRouter` inference on `files.write`, surfacing as
      // seven `TS18046: 'r' is of type 'unknown'` in `useFileDocument.ts`. That
      // is POD-732's failure exactly: the damage lands at the call sites, and
      // nothing in a vitest run can see it.
      if ('root' in input) await assertAllowedRoot(repos, input.root)
      return await modules.rpc.writeFile(input)
    },
  }
}

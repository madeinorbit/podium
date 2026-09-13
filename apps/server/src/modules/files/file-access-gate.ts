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
 *  - A SESSION'S FILES — `mayReadSessionOwned`, the rule `sessions.transcriptRead`,
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
 * predicate they were told to adopt if one served all five doors: it does, and
 * `readArtifact` and `readRoot` are the two methods they want. Neither issue
 * closing disposes of the other, and nothing here reaches across to edit them.
 */

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
import { asyncSessionIssueAccess, mayReadSessionOwned } from '../sessions/session-access'

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
  /** One file of ONE ISSUE'S ARTIFACT, if this caller may read that issue. */
  readArtifact(
    issueId: IssueId,
    artifactId: ArtifactId,
    path: string,
  ): Promise<{ bytes: Buffer; contentType: string; size: number } | null>
  /** One file under an allowed root, on a machine this caller may use. */
  readRoot(
    root: string,
    path: string,
    machineId?: MachineId,
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>>
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
   */
  requireSearchableRoot(root: string, machineId?: MachineId): Promise<MachineId>
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

  /** Containment, then identity, then the resolved machine — in that order, for
   *  every root-addressed door. */
  const requireRoot = async (root: string, machineId?: MachineId): Promise<MachineId> => {
    await assertAllowedRoot(repos, root)
    const target = await resolveTarget(machineId)
    await requireUsable(target)
    return target
  }

  return {
    async readSession(sessionId, path) {
      const mayRead = await mayReadSessionOwned(
        caller.userId,
        sessionId,
        async (id) => await modules.sessions.sessionOwner(id as never),
      )
      // NOT_FOUND, not FORBIDDEN, and the same refusal `transcriptRead` gives —
      // FORBIDDEN would confirm the session exists.
      if (!mayRead) throw new TRPCError({ code: 'NOT_FOUND' })
      return await modules.rpc.readFile({ sessionId, path })
    },

    async readArtifact(issueId, artifactId, path) {
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
      return await modules.issueArtifacts.read(issueId, artifactId, path)
    },

    async readRoot(root, path, machineId) {
      const target = await requireRoot(root, machineId)
      return await modules.rpc.readFile({ machineId: target, root, path })
    },

    async listRoot(root, path, machineId) {
      const target = await requireRoot(root, machineId)
      return await modules.rpc.listDir({
        machineId: target,
        root,
        ...(path !== undefined ? { path } : {}),
      })
    },

    async requireSearchableRoot(root, machineId) {
      return await requireRoot(root, machineId)
    },

    async lsFiles(root, machineId) {
      const target = await requireRoot(root, machineId)
      return await modules.rpc.repoOp('lsFiles', root, undefined, target)
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

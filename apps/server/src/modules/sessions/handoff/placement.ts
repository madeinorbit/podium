/**
 * PLACEMENT — where this session is, where it is going, and whether that move
 * is possible AT ALL. The second phase, between admission and the pre-flight.
 *
 * IT DECIDES EVERYTHING AND CHANGES NOTHING, and that is the whole reason it is
 * its own module. Every statement here reads the world (the session row, the
 * repo list, the issue's home, the machine inventory) or derives a value from
 * what it read; not one of them writes, sends, spawns or awaits. So the entire
 * set of refusals below happens with the session still live on its source
 * machine, no overlay painted, and nothing to unwind — which is what lets the
 * coordinator's next phase treat "we got a placement" as "we are allowed to
 * start doing irreversible things".
 *
 * THAT PROPERTY IS ALSO THE TEST SEAM. Resolution used to be the first 70 lines
 * of a 400-line method reachable only by driving a two-machine transfer to
 * completion; here each refusal is one call with a hand-built ports stub, so
 * "an unregistered source repo is refused", "a non-worktree session is
 * refused" and "an offline target is UNREACHABLE, not denied" are each a test
 * that constructs nothing and moves nothing.
 *
 * WHAT IS DELIBERATELY NOT DECIDED HERE: the `use` rights on either machine.
 * Those are admission's (before anything moves) and the transfer's (again, at
 * each apply point, ADR 3 D8/D16) — a rights answer computed in this phase and
 * carried forward would be exactly the snapshot D16 forbids. Placement is
 * evaluated ONCE and its answers are facts about placement, not about rights.
 *
 * ORDER IS PART OF THE CONTRACT. The refusals are sequenced so that an unusable
 * TARGET answers the same way whatever the session's current home is, and so a
 * caller cannot distinguish "machine you may not see" from "machine that does
 * not exist" (§3.1.5's consistent-error rule); reordering them changes which
 * refusal a caller receives when two apply at once.
 */

import { randomUUID } from 'node:crypto'
import { asMachineId, HandoffManifestV1, type MachineId } from '@podium/model'
import type { Session } from '../session'
import { type ExportedIdentity, exportedIdentity } from './attribution'
import {
  type ExportableAgentKind,
  HANDOFF_UNKNOWN_SESSION,
  type HandoffCaller,
  type HandoffInput,
  type HandoffIssue,
  type HandoffMachine,
  type HandoffPorts,
  type HandoffRepo,
} from './ports'
import { HandoffRefusalError } from './refusal'

/** A session that can survive the move — the resume ref is what brings the
 *  conversation back on the target, so its presence is a precondition, not a
 *  detail. Derived from `Session` so it cannot describe a field the row lost. */
export type ResumableSession = Session & { resume: NonNullable<Session['resume']> }

const isResumable = (session: Session | undefined): session is ResumableSession =>
  Boolean(session?.resume)

/** A repo row that carries a repo id. The bundle's repo identity is what makes
 *  the package match the tree it lands in, so an unregistered repo is refused
 *  rather than exported without one. */
export type RegisteredRepo = HandoffRepo & { repoId: string }

const isRegistered = (repo: HandoffRepo | undefined): repo is RegisteredRepo =>
  Boolean(repo?.repoId)

/** The reads and derivations placement needs, and nothing that writes. The type
 *  is the argument: a port this phase cannot reach is a side effect it cannot
 *  have. */
export type HandoffPlacementPorts = Pick<
  HandoffPorts,
  'getSession' | 'listRepos' | 'listMachines' | 'issueMeta'
>

/** Everything the later phases need that was decided from state alone. */
export interface HandoffPlacement {
  readonly session: ResumableSession
  /** The manifest's own agent-kind list, parsed — see the note at the parse. */
  readonly agentKind: ExportableAgentKind
  /** Attribution for the bundle manifest, resolved from the transport caller. */
  readonly exportIdentity: ExportedIdentity
  /** Correlates the five binding legs of this one transfer. */
  readonly transferId: string
  readonly sourceMachineId: MachineId
  readonly targetMachineId: MachineId
  readonly sourceRepo: RegisteredRepo
  /** The issue's row, when the session has one — its branch, parent branch and
   *  machine-local worktree are read by the pre-flight and the transfer. */
  readonly issue: HandoffIssue | undefined
  /** The worktree to fall back to when `session.cwd` drifted to the repo root
   *  ([spec:SP-3f7a]); undefined when the session's own cwd is the answer. */
  readonly issueWorktree: string | undefined
  readonly targetMachine: HandoffMachine
}

/**
 * Resolve the move, or throw the refusal that applies. Synchronous by
 * construction — see the header.
 */
export function resolveHandoffPlacement(
  ports: HandoffPlacementPorts,
  input: HandoffInput,
  caller: HandoffCaller,
): HandoffPlacement {
  // Eligibility and both `use` checks already passed in admission — obligation
  // 1 is satisfied there so that a JOINING caller is authorized too.
  const session = ports.getSession(input.sessionId)
  if (!isResumable(session)) throw new Error(HANDOFF_UNKNOWN_SESSION)
  // TYPE NARROWING, NOT A SECOND ELIGIBILITY RULE. The export frame and the
  // bundle it produces accept only the exportable kinds, and this is the
  // MANIFEST'S OWN list (the shared schema instance from `packages/model`, whose
  // header explains that widening it would accept a bundle no importer can
  // resume). So the manifest and schema cannot drift silently: if the capability
  // above ever calls a kind handoff-capable that the bundle format cannot carry,
  // this parse says so loudly instead of shipping an unresumable package.
  const agentKind = HandoffManifestV1.shape.agentKind.parse(session.agentKind)
  const exportIdentity = exportedIdentity(caller)
  const transferId = randomUUID()
  const sourceMachineId = asMachineId(session.machineId)
  const targetMachineId = asMachineId(input.machineId)

  if (session.machineId === input.machineId) throw new Error('session is already on that machine')

  const repos = ports.listRepos()
  const issue = session.issueId ? ports.issueMeta(session.issueId) : undefined
  // A resumed old daemon can report a transcript's pre-handoff cwd after rollback.
  // The issue's machine-local worktree is the durable workspace anchor; consult it
  // before the session's momentary cwd when resolving the source repository.
  const sourceAnchors = [
    ...(issue?.machineId === session.machineId && issue.worktreePath ? [issue.worktreePath] : []),
    session.cwd,
  ]
  const sourceRepo = repos
    .filter(
      (repo) =>
        repo.machineId === session.machineId &&
        sourceAnchors.some((anchor) => anchor === repo.path || anchor.startsWith(`${repo.path}/`)),
    )
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!isRegistered(sourceRepo))
    throw new Error(
      `source repository is not registered (machine=${session.machineId}, anchors=${sourceAnchors.join(',')})`,
    )
  // [spec:SP-3f7a] `session.cwd` drifts — the daemon follows the shell, so an
  // agent that ran a command against the main checkout is stamped at the repo
  // root. Its issue's worktree is still its home, so offer that as a fallback
  // source instead of refusing. Restricted to this repo, so the package's repo
  // identity always matches the tree it carries. Which candidate wins is the
  // exporter's call (it asks git); refuse up front only when neither exists.
  const issueWorktree =
    issue?.machineId === session.machineId &&
    issue.worktreePath?.startsWith(`${sourceRepo.path}/`)
      ? issue.worktreePath
      : undefined
  if (session.cwd === sourceRepo.path && !issueWorktree)
    throw new Error('only worktree sessions can be handed off')
  const targetMachine = ports.listMachines().find((machine) => machine.id === input.machineId)
  // REACHABILITY IS A DIFFERENT ANSWER FROM AUTHORIZATION (§3.1.4 M5). By the
  // time execution reaches here the principal may `use` this machine, so
  // saying it is offline reveals nothing it could not already see.
  // UNREACHABLE, and it is a different answer from unauthorized (M5): the two
  // `use` checks above already passed, so the principal may use this machine
  // and retrying later is the correct advice. Reachable only inside the `see`
  // set, which is what keeps this compatible with the consistent-error rule.
  if (!targetMachine?.online)
    throw new HandoffRefusalError('target machine is offline', 'unreachable')
  const harness = targetMachine.inventory?.agents.find((agent) => agent.kind === session.agentKind)
  if (!harness?.installed || harness.login.state === 'out') {
    throw new Error(`target machine cannot run logged-in ${session.agentKind}`)
  }
  return {
    session,
    agentKind,
    exportIdentity,
    transferId,
    sourceMachineId,
    targetMachineId,
    sourceRepo,
    issue,
    issueWorktree,
    targetMachine,
  }
}

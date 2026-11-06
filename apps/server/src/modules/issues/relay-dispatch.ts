import { commandAccess } from './command-ctx'
/**
 * THE AGENT-RELAY DISPATCH ARM (POD-418).
 *
 * Moved out of the composition root verbatim — ARM ORDER UNCHANGED. This is the
 * body of `AgentRelayGateDeps.dispatch`, the port `AgentRelayGate` has always
 * declared and whose doc comment already called this "the dispatch arm in the
 * composition root". It is the last surface an agent's `podium <verb>` crosses
 * before it reaches a service, and it is emphatically not wiring: it routes
 * router/proc pairs, hand-validates the input that has no contract
 * (`sessions.title`; `offer.set` has one since POD-6419), applies the scope gates that the allowlist in
 * `relay-gate.ts` deliberately leaves to it, and stitches the issue-prime tail.
 *
 * WHY IT WAS A SECOND JOB. The root's argument is that it decides nothing and
 * only names and constructs. Every one of the decisions above is a decision, and
 * they are made about ALREADY-CONSTRUCTED services — nothing in here participates
 * in the construction order at all. Kept inline it was ~420 lines of policy
 * inside a constructor, which is the shape a reviewer opening `relay.ts` to check
 * the wiring has to read past, and the shape that made the root's own claim
 * false. Out here the root is left with one delegate.
 *
 * WHAT DELIBERATELY STAYED BEHIND. Nothing. `sessionTitlePrime` and its
 * `sessionLabel` helper came with it: their only caller is the `issues.prime`
 * tail at the bottom of this file, and a private method on the registry whose one
 * reader is this arm was part of the same job.
 *
 * WHAT IS NOT HERE, AND MUST NOT COME HERE. The RELAY_ALLOWED allowlist stays in
 * `relay-gate.ts`. It answers "may a relay reach this router at all", which is a
 * question about the transport's least privilege; this file answers "and is THIS
 * caller in scope for THIS target", which is a question about the caller. Two
 * gates, deliberately in two files — POD-381 collapsed the ones that really were
 * duplicates, and these are not.
 */

import { isExposedOn, sessionCommandPlane, sessionHandoffInput } from '@podium/commands'
import {
  asMachineId,
  asSessionId,
  isSpawnedBy,
  type SessionId,
  type SessionMeta,
  spawnedByParentSessionId,
} from '@podium/model'
import { SyncSubmitInput, sessionTitleRule } from '@podium/protocol'
import { resolvePrincipalAsync } from '../../command-principal'
import type { getFeatureStates, isFeatureEnabled } from '../../features'
import { type Capability, checkIssueAccess } from '../../issue-authz'
import type { RegistryModules } from '../../relay'
import { isGenericClaudeTitle, isTransientTitle } from '../../title-filter'
import type { ApprovalService } from '../approvals/service'
import type { LockCommandDispatcher } from '../lock/registry'
import type { MessageGate } from '../messages/gate'
import {
  fleetViewFor,
  lifecycleEditsFor,
  sessionCommandCtx,
  visibleMachinesFor,
} from '../sessions/command-ctx'
import { dispatchSessionCommand, isCommandPlaneProc } from '../sessions/command-plane'
import type { SessionLifecycle } from '../sessions/lifecycle'
import type { SessionReadToolkit } from '../sessions/read-toolkit'
import { handoffThroughEffect } from '../sessions/session-handoff-effect'
import { submitPlaneCommand } from '../sessions/sync-write'
import { dispatchSpecRelay, NO_SUCH_SPEC_PROC } from '../specs/relay'
import type { SpecsService } from '../specs/service'
import { dispatchWorkflowRpc, workflowRelayWrite } from '../workflows/rpc'
import type { WorkflowCaller, WorkflowService } from '../workflows/service'
import type { IssueCommandDispatcher } from './dispatcher'
import type { AgentRelayGateDeps } from './relay-gate'
import { NO_SUCH_PROCEDURE } from './relay-gate'
import type { IssueService } from './service'

/**
 * Everything the arm reads. All of it is already constructed when the root builds
 * this — the two thunks exist because the values they return change after
 * construction (feature state on every settings write, `modules` once the
 * root finishes filling it), not because anything here is a deferred dependency.
 */
export interface AgentRelayDispatchDeps {
  readonly approvals: ApprovalService
  readonly featureStates: () => ReturnType<typeof getFeatureStates>
  readonly featureEnabled: (id: Parameters<typeof isFeatureEnabled>[0]) => boolean
  readonly issueCommands: IssueCommandDispatcher
  readonly issues: IssueService
  readonly listRepos: () =>
    | Parameters<typeof fleetViewFor>[2]
    | Promise<Parameters<typeof fleetViewFor>[2]>
  readonly lockCommands: LockCommandDispatcher
  readonly messageGate: MessageGate
  readonly modules: () => RegistryModules
  readonly readToolkit: SessionReadToolkit
  readonly sessionsSvc: SessionLifecycle
  readonly specs: SpecsService
  readonly workflowCallerForCapability: (
    capability: Capability,
    overrideScope?: boolean,
  ) => WorkflowCaller | Promise<WorkflowCaller>
  readonly workflows: WorkflowService
}

/**
 * The label a session shows in the sidebar, or undefined when it has none worth
 * showing (#490). Mirrors the client's sessionDisplayName (name beats title) minus
 * its 'untitled' fallback: a placeholder — an empty/spinner OSC title, or Claude's
 * generic "Claude Code" — is NOT a label, and listing it as a sibling would tell an
 * agent to distinguish itself from nothing.
 */
function sessionLabel(session: SessionMeta): string | undefined {
  const name = session.name?.trim()
  if (name) return name
  const title = session.title.trim()
  if (!title || isTransientTitle(title) || isGenericClaudeTitle(title)) return undefined
  return title
}

/**
 * The "name your own session" block appended to an agent's issue prime (#490).
 *
 * Returns '' — nothing appended — when the session already HAS a name (the user's
 * or one this agent set on an earlier turn), or when it has no issue: a session
 * that doesn't sit under an issue in the sidebar has no siblings to be
 * distinguished from, and nothing to be named relative to.
 *
 * The wording is NOT written here: sessionTitleRule (@podium/protocol) is the one
 * copy of the titling doctrine every surface reuses. What this adds is the local
 * facts — the issue's seq, and the display names of the OTHER sessions on it, so
 * the agent can pick a name that isn't a duplicate of its neighbours'.
 */
async function sessionTitlePrime(
  sessionsSvc: SessionLifecycle,
  issues: IssueService,
  actorSessionId: SessionId,
): Promise<string> {
  const actor = await sessionsSvc.sessionById(actorSessionId)
  if (!actor) return ''
  if (actor.name?.trim()) return ''
  const issueId = actor.issueId ?? (await issues.reports.issueForCwd(actor.cwd))
  if (!issueId) return ''
  const issue = await issues.reports.getMeta(issueId)
  const seq = issue?.seq
  if (seq === undefined) return ''
  // Siblings = the other sessions on the SAME issue that have a usable label. A
  // session still showing a placeholder ('Claude Code', a spinner frame, an empty
  // OSC title) contributes nothing an agent could distinguish itself from, so it
  // is skipped rather than listed as noise.
  const members = (
    await sessionsSvc.listSessionsForIssue(issue?.worktreePath ?? null, issueId)
  ).filter((s) => s.sessionId !== actorSessionId && !s.archived)
  // Every unbound member's owner in one indexed read (POD-6155).
  const owners = await issues.reports.issuesForCwds(
    members.flatMap((s) => (s.issueId ? [] : [s.cwd])),
  )
  const siblings = members
    .filter((s) => (s.issueId ?? owners.get(s.cwd) ?? null) === issueId)
    .map((s) => sessionLabel(s))
    .filter((label): label is string => label !== undefined)
  return sessionTitleRule(seq, siblings)
}

/** Build the arm. The root names the result as `AgentRelayGate`'s `dispatch`. */
export function makeAgentRelayDispatch(
  deps: AgentRelayDispatchDeps,
): AgentRelayGateDeps['dispatch'] {
  const {
    approvals,
    featureStates,
    featureEnabled,
    issueCommands,
    issues,
    listRepos,
    lockCommands,
    messageGate,
    modules,
    readToolkit,
    sessionsSvc,
    specs,
    workflowCallerForCapability,
    workflows,
  } = deps

  return async (capability, overrideScope, router, proc, input) => {
    // The relay caller as a principal, resolved when an arm needs one.
    const relayPrincipal = async () =>
      await resolvePrincipalAsync(capability, {
        parentSessionOf: async (sessionId) =>
          spawnedByParentSessionId((await sessionsSvc.sessionById(sessionId))?.spawnedBy),
      })
    // The sync write entry point's relay adapter (ADR 12 D2, POD-6413). The gate
    // has bound the relay context onto the envelope's input and checked its
    // command against the allowlist; the entry point does the rest. The agent's
    // --outside-scope is its confirmation, as on the direct call.
    if (router === 'sync') {
      if (proc !== 'submit') return NO_SUCH_PROCEDURE
      const envelope = SyncSubmitInput.parse(input)
      const principal = await relayPrincipal()
      return await modules().syncWrite.submit(
        overrideScope === true ? { ...envelope, confirmed: true } : envelope,
        principal,
        'relay',
      )
    }
    if (router === 'features' && proc === 'state') {
      return await Promise.resolve(featureStates())
    }
    if (router === 'quota' && proc === 'summary') {
      return await modules().rpc.agentQuotaAll()
    }
    /**
     * `machines.list` for agents (POD-1386) — "what can I run on?".
     *
     * INHERITED, NOT RESTATED. This calls the SAME `visibleMachinesFor` the
     * router serves at router.ts:399, and that is the whole design: the
     * projection filters the see-set and stamps each row's `use` decision, and
     * a second copy of that scoping decision is precisely how the property
     * would quietly stop holding on ONE path while still holding on the other,
     * with nothing to report it. There is no policy in this arm.
     *
     * WHY REPOS RIDE ALONG, AND WHY THEY ARE FILTERED TWICE. A machine's
     * registered checkout paths are what makes an enumeration actionable —
     * without them "which machine can take this work" is unanswerable — but
     * `repos.listDetailed` returns every row across every machine, unscoped.
     * Allowlisting that proc would disclose checkout paths on machines the
     * caller cannot even see: a worse leak than the gap being closed. So the
     * rows are cut to machines that survived the projection AND carry
     * `use: 'granted'`, putting a checkout path in the same class the model
     * already puts `inventory` in — "what can I run on your hardware, and as
     * whom" is a `use` question, not a `see` question.
     *
     * A `see`-only machine therefore arrives with no repos and no inventory,
     * and the CLI renders that as "not available to this session" rather than
     * "none registered" — the two differ in what they are a fact ABOUT, and
     * only the second would be a lie.
     *
     * TWO PROCS, ONE SHAPE EACH. `list` answers EXACTLY what the router
     * answers — the same projection, the same array — because a proc that
     * returned one shape over HTTP and another over the relay would be a trap
     * for every caller that can reach both (`podium issue start --machine`
     * resolves names over whichever transport it has). The repo join is a
     * SECOND proc rather than a wider `list`.
     */
    if (router === 'machines' && proc === 'list') {
      return await Promise.resolve(await visibleMachinesFor(modules(), capability))
    }
    if (router === 'machines' && proc === 'listWithRepos') {
      return await fleetViewFor(modules(), capability, await listRepos())
    }
    if (router === 'machines' && proc === 'reprobe') {
      const raw = (input ?? {}) as Record<string, unknown>
      if (typeof raw.id !== 'string' || !raw.id) throw new Error('machine id is required')
      const machine = (await visibleMachinesFor(modules(), capability)).find(
        (candidate) => candidate.id === raw.id,
      )
      if (!machine) throw new Error(`no visible machine with id '${raw.id}'`)
      if (machine.use !== 'granted') {
        throw new Error(`you do not have access to re-probe machine '${machine.name}'`)
      }
      if (!machine.online) throw new Error(`machine '${machine.name}' is offline`)
      modules().machines.toMachine(asMachineId(machine.id), { type: 'inventoryRequest' })
      return await Promise.resolve({ machineId: machine.id, requested: true })
    }
    if (router === 'specs') {
      // Writes on the plain command path, reads the service's own (POD-6418).
      const answer = await dispatchSpecRelay(specs, relayPrincipal, proc, input)
      return answer === NO_SUCH_SPEC_PROC ? NO_SUCH_PROCEDURE : answer
    }
    // Advisory lease locks [spec:SP-85d1]: the caller's session identity is
    // stamped server-side via the capability (actorSessionId), never from input.
    if (router === 'lock') {
      return await lockCommands.dispatch(
        { capability, ...(overrideScope ? { overrideScope } : {}) },
        proc,
        input,
        relayPrincipal,
      )
    }
    // Unified messaging command surface (#237) [spec:SP-34d7]: podium mail
    // send/inbox/show/reply + the stop-hook's pendingReminders. Authz lives
    // in the gate (session targets: same containment as the sessions arm).
    // The writes go on through the sync write entry point as relay calls
    // (POD-6525): the gate is their adapter.
    // LEGACY(remove-after: 2027-03): this arm's writes, for the CLI's `podium mail` and `agent` commands; removing it breaks them against this server.
    if (router === 'messages') {
      return await messageGate.dispatch(capability, overrideScope, proc, input)
    }
    // The workflow surface, derived from the contract + query tables
    // (POD-732). `WorkflowService.dispatch` — a reflective call over the
    // deleted `workflowInputs` that served any proc with a schema — is gone;
    // exposure is asked per declaration and both transports enter through
    // the same `execute` door.
    if (router === 'workflows') {
      return await dispatchWorkflowRpc(
        workflows,
        await workflowCallerForCapability(capability, overrideScope),
        proc,
        input,
        'relay',
        // A write goes onto the sync write entry point (POD-6418).
        workflowRelayWrite(modules().syncWrite, relayPrincipal, overrideScope === true),
      )
    }
    // Lazy cross-machine workspace fetch [POD-658]: materialize another
    // session's working state on the CALLER's machine (fetch), or remove
    // what fetch materialized (clean). Fetch is scope-gated against the
    // TARGET's issue exactly like sessions.status — seeing a peer's dirty
    // tree is a read of that peer.
    if (router === 'workspace') {
      const actorSessionId = capability.actorSessionId
      if (!actorSessionId) {
        throw new Error(`workspace.${proc} is only callable by a session (no actor bound)`)
      }
      if (proc === 'clean') {
        return await sessionsSvc.workspace.cleanPeeks({
          callerSessionId: actorSessionId,
        })
      }
      if (proc !== 'fetch') return NO_SUCH_PROCEDURE
      return await (async () => {
        const raw = (input ?? {}) as Record<string, unknown>
        if (typeof raw.ref !== 'string' || !raw.ref) throw new Error('ref is required')
        const target = await readToolkit.resolveTarget(raw.ref)
        if (!target) throw new Error(`no session found for ${raw.ref}`)
        const targetIssueId = target.issueId ?? (await issues.reports.issueForCwd(target.cwd))
        if (targetIssueId) {
          await checkIssueAccess(
            {
              capability,
              ...(overrideScope ? { overrideScope: true } : {}),
            },
            commandAccess(issues),
            'workspace.fetch',
            'write',
            targetIssueId,
          )
        }
        return await sessionsSvc.workspace.fetch({
          sourceSessionId: target.sessionId,
          callerSessionId: actorSessionId,
        })
      })()
    }
    // Agent action offer [spec:SP-c7f1]: `podium offer` set/clear, a sync write
    // on the calling session (`sessions/offer-sync-write.ts`, POD-6419).
    // LEGACY(remove-after: 2027-03): this arm is an older CLI's `podium offer`,
    // as an adapter onto `submit`; the current CLI sends `sync.submit` itself.
    // Removing it breaks that CLI's offers against this server.
    if (router === 'offer') {
      if (proc !== 'set' && proc !== 'clear') return NO_SUCH_PROCEDURE
      return await submitPlaneCommand(modules(), await relayPrincipal(), 'relay', {
        command: `offer.${proc}`,
        input: input ?? {},
        confirmed: overrideScope === true,
      })
    }
    if (router === 'sessions') {
      // Read toolkit tiers 1–2 (#237) [spec:SP-34d7 read-toolkit]: status is
      // a structured snapshot (no transcript text); read is a bounded
      // uuid-cursor transcript window. Both are scope-gated like the send
      // ops against the RESOLVED target's issue and event-logged per read.
      // Tier 4 — the seance (#237) [spec:SP-34d7 read-toolkit]: `podium
      // session ask` rides the messages gate (it IS a message: question +
      // next-turn + wake + bounded ack wait; the gate owns its authz).
      if (proc === 'ask') {
        return await messageGate.dispatch(capability, overrideScope, 'ask', input)
      }
      if (proc === 'status' || proc === 'read' || proc === 'recap') {
        return await (async () => {
          const raw = (input ?? {}) as Record<string, unknown>
          const ref = proc === 'status' ? raw.ref : raw.sessionId
          if (typeof ref !== 'string' || !ref) {
            throw new Error(`${proc === 'status' ? 'ref' : 'sessionId'} is required`)
          }
          const target = await readToolkit.resolveTarget(ref)
          if (!target) throw new Error(`no session found for ${ref}`)
          const targetIssueId = target.issueId ?? (await issues.reports.issueForCwd(target.cwd))
          if (targetIssueId) {
            await checkIssueAccess(
              {
                capability,
                ...(overrideScope ? { overrideScope: true } : {}),
              },
              commandAccess(issues),
              `sessions.${proc}`,
              'write',
              targetIssueId,
            )
          } else {
            const isOperator = capability.scope.kind === 'all'
            const isParent =
              capability.actorSessionId !== undefined &&
              isSpawnedBy(target.spawnedBy, {
                kind: 'session',
                id: capability.actorSessionId,
              })
            if (!isOperator && !isParent) {
              throw new Error(
                'target session has no issue; only its parent or the operator may read it',
              )
            }
          }
          const reader = capability.actorSessionId ?? 'operator'
          if (proc === 'status') return await readToolkit.status(ref, reader)
          // Tier 3 — server-side recap since a watermark (#237)
          // [spec:SP-34d7 read-toolkit]: delta-priced repeated check-ins.
          if (proc === 'recap') {
            return await readToolkit.recap(
              {
                sessionId: target.sessionId,
                ...(typeof raw.since === 'string' && raw.since ? { since: raw.since } : {}),
              },
              reader,
            )
          }
          const turns = raw.turns != null ? Number(raw.turns) : undefined
          return await readToolkit.read(
            {
              sessionId: target.sessionId,
              ...(turns != null && Number.isFinite(turns) ? { turns } : {}),
              ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}),
            },
            reader,
          )
        })()
      }
      // The agent names its OWN session (#490) — `podium session title "…"`.
      // The target is the CALLING session, taken from the capability exactly as
      // issues.attachSession takes it from the relay context: there is no
      // sessionId in the input, so an agent CANNOT retitle anyone else's
      // session, and no scope gate is needed (a session is always in its own
      // scope). The user's own name is sovereign — the service refuses against
      // it and hands back a reason instead of throwing.
      if (proc === 'title') {
        const actorSessionId = capability.actorSessionId
        if (!actorSessionId) {
          throw new Error('sessions.title is only callable by a session (no actor bound)')
        }
        const raw = (input ?? {}) as Record<string, unknown>
        const name = raw.name ?? raw.title
        if (typeof name !== 'string' || name.trim().length === 0) {
          throw new Error('name is required')
        }
        return await Promise.resolve(sessionsSvc.setAgentName({ sessionId: actorSessionId, name }))
      }
      // Clean end [spec:SP-9904]: stop process, free worktree, keep branch.
      // No id → self-stop (the calling session). Outside subtree needs
      // --outside-scope; self / same-issue siblings / subtree are free.
      //
      // BY DESIRED STATE (POD-6422): the arm keeps its scope gates and its
      // answer, and writes `desired: stopped` through `records.session.edit` as
      // the agent; the lifecycle controller acts after the commit and the arm
      // answers with what it did. A self-stop is the agent's own revision, so the
      // controller parks and frees but leaves the process alive, and the
      // relay's after-reply hook ends it once this answer is on the wire.
      if (proc === 'stop') {
        return await (async () => {
          const raw = (input ?? {}) as Record<string, unknown>
          const actorSessionId = capability.actorSessionId
          const requestedId =
            typeof raw.sessionId === 'string' && raw.sessionId
              ? asSessionId(raw.sessionId)
              : undefined
          const sessionId = requestedId ?? actorSessionId
          if (!sessionId) {
            throw new Error(
              'sessions.stop needs a session id, or must be called from a session (self-stop)',
            )
          }
          const selfStop = actorSessionId !== undefined && sessionId === actorSessionId
          if (!selfStop) {
            const target = await sessionsSvc.sessionById(sessionId)
            if (!target) throw new Error('session not found')
            const targetIssueId = target.issueId ?? (await issues.reports.issueForCwd(target.cwd))
            if (targetIssueId) {
              await checkIssueAccess(
                { capability, ...(overrideScope ? { overrideScope: true } : {}) },
                commandAccess(issues),
                'sessions.stop',
                'write',
                targetIssueId,
              )
            } else {
              // Issueless: parent/operator free; otherwise --outside-scope
              // asserts the agent got human OK [spec:SP-9904].
              const isOperator = capability.scope.kind === 'all'
              const isParent =
                actorSessionId !== undefined &&
                isSpawnedBy(target.spawnedBy, { kind: 'session', id: actorSessionId })
              if (!isOperator && !isParent && !overrideScope) {
                throw new Error(
                  'target session has no issue and is outside your tree; re-run with --outside-scope to confirm human permission',
                )
              }
            }
          }
          const { principal } = await sessionCommandCtx(
            modules(),
            capability,
            overrideScope,
            'relay',
          )
          const r = await lifecycleEditsFor(modules(), principal, overrideScope).desire(
            sessionId,
            'stopped',
            raw.force === true,
          )
          if (!r.ok) throw new Error(r.reason ?? 'stop refused')
          return r
        })()
      }
      // MIGRATED (POD-381). sendText / resumeAndSend / continue used to be
      // ~70 lines here: hand-rolled input validation, a hand-rolled subtree
      // gate with its own error strings, and a second application of the
      // idempotency wrapper under a locally-spelled proc name — all of it a
      // near-copy of the tRPC procedure's, differing in ways nobody chose.
      // The contract owns every one of those now, and this arm is transport.
      //
      // The AGENT-vs-OPERATOR differences that were real are preserved
      // because they are properties of the PRINCIPAL, not of the router: an
      // agent's send rides as that agent (senderFromCapability's shape,
      // resolved in the handler from ctx.principal), and an agent addressing
      // an absent session throws `session not found` where the operator's
      // returns the substrate's dead_letter. Both are POD-379-pinned.
      /**
       * `sessions.handoff` over the relay (POD-1386) — the SAME schema and the
       * SAME adapter the tRPC procedure uses (`modules/sessions/trpc.ts`
       * `handoffProcedure`), so this arm is transport and nothing else. Since
       * POD-6422 that adapter creates a `session.handoff` effect record as the
       * agent and waits for it. LEGACY(remove-after: 2027-03): the CLI's
       * `podium session handoff` calls this arm.
       *
       * Deliberately NOT hand-validated: parsing with the contract's own
       * `sessionHandoffInput` is what keeps the two transports from drifting,
       * and hand-rolled input checks beside a contract are exactly what POD-381
       * deleted from this file.
       *
       * The caller rides as a SEPARATE argument built from the capability, never
       * out of `input` — the input schema carries no identity field at all, so a
       * forged `actor`/`onBehalfOf` is inert by construction (ADR 3 D7). The
       * principal comes from `sessionCommandCtx`, the same resolver the command
       * plane below uses, so an agent hands off AS ITSELF on behalf of its human
       * and cannot reach past its parent.
       *
       * It sits outside the command plane for the reason `handoffProcedure`
       * gives: handoff gates `use` on BOTH machines and re-authorizes at two
       * apply points minutes apart, which the plane's dispatch does not model.
       */
      if (proc === 'handoff') {
        const parsed = sessionHandoffInput.parse(input)
        const { principal } = await sessionCommandCtx(modules(), capability, overrideScope, 'relay')
        return await handoffThroughEffect(modules(), principal, parsed)
      }
      // `continue` (POD-6416) and the chat sends (POD-6591) are on the sync
      // write entry point: this arm is their relay adapter, and the agent's
      // `--outside-scope` rides as the envelope's confirmation. A send's
      // refusal keeps the plane's words (`planeGateRefusal`).
      // LEGACY(remove-after: 2027-03): the CLI's `podium session send` (and an
      // older CLI's `podium session continue`) call it; removing it breaks them.
      if (proc === 'continue' || proc === 'sendText' || proc === 'resumeAndSend') {
        const ctx = await sessionCommandCtx(modules(), capability, overrideScope, 'relay')
        return await submitPlaneCommand(modules(), ctx.principal, 'relay', {
          command: `sessions.${proc}`,
          input,
          ...(overrideScope ? { confirmed: true } : {}),
        })
      }
      if (isCommandPlaneProc(proc) && isExposedOn(sessionCommandPlane.defs[proc], 'relay')) {
        return await Promise.resolve(
          dispatchSessionCommand(
            // `modules` is a getter, not a value: the root fills the
            // module set around this construction and the closure only
            // runs per request, long after.
            await sessionCommandCtx(modules(), capability, overrideScope, 'relay'),
            proc,
            input,
          ),
        )
      }
      return NO_SUCH_PROCEDURE
    }
    if (router === 'approvals') {
      if (proc === 'request') return await Promise.resolve(await approvals.request(input))
      if (proc === 'get') return await Promise.resolve(await approvals.getFromAgent(input))
      return NO_SUCH_PROCEDURE
    }
    const result = await issueCommands.dispatch(
      { capability, ...(overrideScope ? { overrideScope } : {}) },
      router,
      proc,
      input,
    )
    const actorSessionId = capability.actorSessionId
    if (result && router === 'issues' && proc === 'prime' && actorSessionId) {
      return await Promise.resolve(result).then(async (issuePrime) => {
        const workflowPrime = featureEnabled('workflows')
          ? await workflows.prime({ actor: { kind: 'session', id: actorSessionId }, capability })
          : ''
        // Name-your-own-session (#490): asked for only while the session HAS no
        // name — a named session (by the user or by an earlier turn of this agent)
        // never sees the instruction, so the prime doesn't nag an agent into
        // re-titling something already titled.
        const titlePrime = await sessionTitlePrime(sessionsSvc, issues, actorSessionId)
        return [String(issuePrime), workflowPrime, titlePrime].filter(Boolean).join('\n\n')
      })
    }
    return result
  }
}

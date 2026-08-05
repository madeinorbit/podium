/**
 * THE AGENT-RELAY DISPATCH ARM (POD-418).
 *
 * Moved out of the composition root verbatim — ARM ORDER UNCHANGED. This is the
 * body of `AgentRelayGateDeps.dispatch`, the port `AgentRelayGate` has always
 * declared and whose doc comment already called this "the dispatch arm in the
 * composition root". It is the last surface an agent's `podium <verb>` crosses
 * before it reaches a service, and it is emphatically not wiring: it routes
 * router/proc pairs, hand-validates the two inputs that have no contract
 * (`offer.set`, `sessions.title`), applies the scope gates that the allowlist in
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
import { asSessionId, isSpawnedBy, type SessionMeta } from '@podium/model'
import { bareSelfRefCount, selfRefNudge, sessionTitleRule } from '@podium/protocol'
import type { getFeatureStates, isFeatureEnabled } from '../../features'
import { type Capability, checkIssueAccess } from '../../issue-authz'
import type { RegistryModules } from '../../relay'
import { isGenericClaudeTitle, isTransientTitle } from '../../title-filter'
import type { ApprovalService } from '../approvals/service'
import type { IssueSessionLifecycle } from '../issue-session-lifecycle'
import type { LockCommandDispatcher } from '../lock/registry'
import type { MessageGate } from '../messages/gate'
import { fleetViewFor, sessionCommandCtx, visibleMachinesFor } from '../sessions/command-ctx'
import { dispatchSessionCommand, isCommandPlaneProc } from '../sessions/command-plane'
import type { SessionLifecycle } from '../sessions/lifecycle'
import type { SessionReadToolkit } from '../sessions/read-toolkit'
import type { SpecsService } from '../specs/service'
import { dispatchWorkflowRpc } from '../workflows/rpc'
import type { WorkflowCaller, WorkflowService } from '../workflows/service'
import type { IssueCommandDispatcher } from './dispatcher'
import type { AgentRelayGateDeps } from './relay-gate'
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
  readonly issueSessionLifecycle: IssueSessionLifecycle
  readonly issues: IssueService
  readonly listRepos: () => Parameters<typeof fleetViewFor>[2]
  readonly lockCommands: LockCommandDispatcher
  readonly messageGate: MessageGate
  readonly modules: () => RegistryModules
  readonly readToolkit: SessionReadToolkit
  readonly sessionsSvc: SessionLifecycle
  readonly specs: SpecsService
  readonly workflowCallerForCapability: (
    capability: Capability,
    overrideScope?: boolean,
  ) => WorkflowCaller
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
function sessionTitlePrime(
  sessionsSvc: SessionLifecycle,
  issues: IssueService,
  actorSessionId: string,
): string {
  const all = sessionsSvc.listSessions()
  const actor = all.find((s) => s.sessionId === actorSessionId)
  if (!actor) return ''
  if (actor.name?.trim()) return ''
  const issueId = actor.issueId ?? issues.issueForCwd(actor.cwd)
  if (!issueId) return ''
  const seq = issues.getMeta(issueId)?.seq
  if (seq === undefined) return ''
  // Siblings = the other sessions on the SAME issue that have a usable label. A
  // session still showing a placeholder ('Claude Code', a spinner frame, an empty
  // OSC title) contributes nothing an agent could distinguish itself from, so it
  // is skipped rather than listed as noise.
  const siblings = all
    .filter((s) => s.sessionId !== actorSessionId && !s.archived)
    .filter((s) => (s.issueId ?? issues.issueForCwd(s.cwd)) === issueId)
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
    issueSessionLifecycle,
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

  return (capability, overrideScope, router, proc, input) => {
    if (router === 'features' && proc === 'state') {
      return Promise.resolve(featureStates())
    }
    if (router === 'quota' && proc === 'summary') {
      return modules().rpc.agentQuotaAll()
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
      return Promise.resolve(visibleMachinesFor(modules(), capability))
    }
    if (router === 'machines' && proc === 'listWithRepos') {
      return Promise.resolve(fleetViewFor(modules(), capability, listRepos()))
    }
    if (router === 'specs') {
      return specs.has(proc) ? (specs.invoke(proc, input) as Promise<unknown>) : undefined
    }
    // Advisory lease locks [spec:SP-85d1]: the caller's session identity is
    // stamped server-side via the capability (actorSessionId), never from input.
    if (router === 'lock') {
      return lockCommands.dispatch(
        { capability, ...(overrideScope ? { overrideScope } : {}) },
        proc,
        input,
      )
    }
    // Unified messaging command surface (#237) [spec:SP-34d7]: podium mail
    // send/inbox/show/reply + the stop-hook's pendingReminders. Authz lives
    // in the gate (session targets: same containment as the sessions arm).
    if (router === 'messages') {
      return messageGate.dispatch(capability, overrideScope, proc, input)
    }
    // The workflow surface, derived from the contract + query tables
    // (POD-732). `WorkflowService.dispatch` — a reflective call over the
    // deleted `workflowInputs` that served any proc with a schema — is gone;
    // exposure is asked per declaration and both transports enter through
    // the same `execute` door.
    if (router === 'workflows') {
      return dispatchWorkflowRpc(
        workflows,
        workflowCallerForCapability(capability, overrideScope),
        proc,
        input,
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
        return sessionsSvc.workspace.cleanPeeks({
          callerSessionId: actorSessionId,
        })
      }
      if (proc !== 'fetch') return undefined
      return (async () => {
        const raw = (input ?? {}) as Record<string, unknown>
        if (typeof raw.ref !== 'string' || !raw.ref) throw new Error('ref is required')
        const target = readToolkit.resolveTarget(raw.ref)
        if (!target) throw new Error(`no session found for ${raw.ref}`)
        const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
        if (targetIssueId) {
          checkIssueAccess(
            {
              capability,
              ...(overrideScope ? { overrideScope: true } : {}),
            },
            issues,
            'workspace.fetch',
            'write',
            targetIssueId,
          )
        }
        return sessionsSvc.workspace.fetch({
          sourceSessionId: target.sessionId,
          callerSessionId: actorSessionId,
        })
      })()
    }
    // Agent action offer [spec:SP-c7f1]: `podium offer` set/clear. Like
    // sessions.title, the target is ALWAYS the CALLING session (bound from
    // the capability, never from input), so no scope gate is needed — a
    // session is always within its own scope.
    if (router === 'offer') {
      const actorSessionId = capability.actorSessionId
      if (!actorSessionId) {
        throw new Error('offer is only callable by a session (no actor bound)')
      }
      if (proc === 'clear') {
        sessionsSvc.clearOffer(actorSessionId)
        return Promise.resolve({ ok: true, cleared: true })
      }
      if (proc === 'set') {
        const raw = (input ?? {}) as Record<string, unknown>
        const message = typeof raw.message === 'string' ? raw.message.trim() : ''
        if (!message || message.length > 4_000) {
          throw new Error('message must contain 1..4000 characters')
        }
        if (!Array.isArray(raw.actions)) {
          throw new Error('actions must be an array')
        }
        if (raw.actions.length > 6) {
          throw new Error('at most 6 actions are allowed')
        }
        const actions = raw.actions.map((a, i) => {
          const rec = (a ?? {}) as Record<string, unknown>
          const label = typeof rec.label === 'string' ? rec.label.trim() : ''
          const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : ''
          if (!label || label.length > 80) {
            throw new Error(`action ${i + 1}: label must contain 1..80 characters`)
          }
          if (!prompt || prompt.length > 4_000) {
            throw new Error(`action ${i + 1}: prompt must contain 1..4000 characters`)
          }
          // Feedback-collecting action [spec:SP-c7f1]: the UI asks for
          // freeform text before sending, appended to the prompt.
          return rec.input === true ? { label, prompt, input: true } : { label, prompt }
        })
        // Issue-artifact references [POD-120]: bare paths, resolved by the
        // client against the issue panel's artifact list — validated here
        // only for shape (the artifact may legitimately not exist yet).
        let artifacts: string[] | undefined
        if (raw.artifacts !== undefined) {
          if (!Array.isArray(raw.artifacts)) {
            throw new Error('artifacts must be an array')
          }
          if (raw.artifacts.length > 6) {
            throw new Error('at most 6 artifacts are allowed')
          }
          artifacts = raw.artifacts.map((p, i) => {
            const path = typeof p === 'string' ? p.trim() : ''
            if (!path || path.length > 512) {
              throw new Error(`artifact ${i + 1}: path must contain 1..512 characters`)
            }
            return path
          })
        }
        sessionsSvc.setOffer({
          sessionId: actorSessionId,
          message,
          actions,
          ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
        })
        // Self-reference nudge (POD-389). The offer headline is the most-read
        // sentence an agent writes, and ~1 in 4 named the agent's own issue in
        // it. The rule ships in prime, but prime is injected once per session
        // and the headline is written at the far end of a long one — so remind
        // at the moment of the mistake instead. Advisory only: the offer is
        // already set; the notice just rides back on the result.
        const ownIssueId = capability.scope.kind === 'subtree' ? capability.scope.rootId : null
        const ownRow = ownIssueId ? issues.getMeta(ownIssueId) : null
        const ownRef = ownRow ? issues.niceRef(ownRow) : null
        const notice =
          ownRef && bareSelfRefCount(message, ownRef) > 0
            ? selfRefNudge(ownRef, 'offer message')
            : undefined
        return Promise.resolve({ ok: true, ...(notice ? { notice } : {}) })
      }
      return undefined
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
        return messageGate.dispatch(capability, overrideScope, 'ask', input)
      }
      if (proc === 'status' || proc === 'read' || proc === 'recap') {
        return (async () => {
          const raw = (input ?? {}) as Record<string, unknown>
          const ref = proc === 'status' ? raw.ref : raw.sessionId
          if (typeof ref !== 'string' || !ref) {
            throw new Error(`${proc === 'status' ? 'ref' : 'sessionId'} is required`)
          }
          const target = readToolkit.resolveTarget(ref)
          if (!target) throw new Error(`no session found for ${ref}`)
          const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
          if (targetIssueId) {
            checkIssueAccess(
              {
                capability,
                ...(overrideScope ? { overrideScope: true } : {}),
              },
              issues,
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
          if (proc === 'status') return readToolkit.status(ref, reader)
          // Tier 3 — server-side recap since a watermark (#237)
          // [spec:SP-34d7 read-toolkit]: delta-priced repeated check-ins.
          if (proc === 'recap') {
            return readToolkit.recap(
              {
                sessionId: target.sessionId,
                ...(typeof raw.since === 'string' && raw.since ? { since: raw.since } : {}),
              },
              reader,
            )
          }
          const turns = raw.turns != null ? Number(raw.turns) : undefined
          return readToolkit.read(
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
        return Promise.resolve(sessionsSvc.setAgentName({ sessionId: actorSessionId, name }))
      }
      // Clean end [spec:SP-9904]: stop process, free worktree, keep branch.
      // No id → self-stop (the calling session). Outside subtree needs
      // --outside-scope; self / same-issue siblings / subtree are free.
      if (proc === 'stop') {
        return (async () => {
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
            const target = sessionsSvc.sessionById(sessionId)
            if (!target) throw new Error('session not found')
            const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
            if (targetIssueId) {
              checkIssueAccess(
                { capability, ...(overrideScope ? { overrideScope: true } : {}) },
                issues,
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
          const r = await issueSessionLifecycle.stopSession({
            sessionId,
            force: raw.force === true,
            selfStop,
          })
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
       * SAME handler the tRPC procedure uses (`modules/sessions/trpc.ts`
       * `handoffProcedure`), so this arm is transport and nothing else.
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
        return issueSessionLifecycle.handoffSession(parsed, {
          capability,
          principal: sessionCommandCtx(modules(), capability, overrideScope, 'relay').principal,
        })
      }
      if (isCommandPlaneProc(proc) && isExposedOn(sessionCommandPlane.defs[proc], 'relay')) {
        return Promise.resolve(
          dispatchSessionCommand(
            // `modules` is a getter, not a value: the root fills the
            // module set around this construction and the closure only
            // runs per request, long after.
            sessionCommandCtx(modules(), capability, overrideScope, 'relay'),
            proc,
            input,
          ),
        )
      }
      return undefined
    }
    if (router === 'approvals') {
      if (proc === 'request') return Promise.resolve(approvals.request(input))
      if (proc === 'get') return Promise.resolve(approvals.getFromAgent(input))
      return undefined
    }
    const result = issueCommands.dispatch(
      { capability, ...(overrideScope ? { overrideScope } : {}) },
      router,
      proc,
      input,
    )
    const actorSessionId = capability.actorSessionId
    if (result && router === 'issues' && proc === 'prime' && actorSessionId) {
      return Promise.resolve(result).then((issuePrime) => {
        const workflowPrime = featureEnabled('workflows')
          ? workflows.prime({ actor: { kind: 'session', id: actorSessionId }, capability })
          : ''
        // Name-your-own-session (#490): asked for only while the session HAS no
        // name — a named session (by the user or by an earlier turn of this agent)
        // never sees the instruction, so the prime doesn't nag an agent into
        // re-titling something already titled.
        const titlePrime = sessionTitlePrime(sessionsSvc, issues, actorSessionId)
        return [String(issuePrime), workflowPrime, titlePrime].filter(Boolean).join('\n\n')
      })
    }
    return result
  }
}

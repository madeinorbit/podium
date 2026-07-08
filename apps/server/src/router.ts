import { PodiumSettings } from '@podium/core'
import { loadConfig } from '@podium/core/config'
import {
  applyJoin,
  applyMode,
  applySetup,
  getUpdateChannel,
  NETWORK_OPTIONS,
  networkOptionCommand,
  setUpdateChannel,
  validatePublicUrl,
} from '@podium/core/setup'
import { AgentKind, agentSupportsCloud, isAgentKind, ResumeRef, WorkState } from '@podium/protocol'
import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { clearPassword, hasPassword, setPassword, verifyPassword } from './auth-store'
import {
  type CloudAgentKind,
  type CloudRepoRequest,
  type CloudRuntimeProvider,
  CloudRuntimeUnavailableError,
  disabledCloudRuntimeProvider,
} from './cloud-runtime'
import { buildJoinCommand } from './hub/machines-join'
import { type Capability, checkIssueAccess, PROC_ACTION, SCOPED_TARGET } from './issue-authz'
import { type IssueCaller, issueInputs } from './modules/issues/commands'
import { specsInputs } from './modules/specs/service'
import type { RegistryModules, SessionRegistry } from './relay'
import { normalizeOriginUrl } from './repo-id'
import { browseDirectories, type RepoRegistry } from './repo-registry'
import type { ServerRoleConfig } from './roles'
import { isAllowedRoot } from './root-allowlist'
import { searchAll } from './search'
import type { SuperagentService } from './superagent'

export interface Context {
  registry: SessionRegistry
  repos: RepoRegistry
  superagent: SuperagentService
  cloud?: CloudRuntimeProvider
  /** What this caller may do with issues (authz, distinct from the login authn on /trpc).
   *  Every HTTP caller is the OPERATOR today; the in-process MCP passes its own. */
  capability: Capability
  /** Set by the daemon relay when an agent passed --outside-scope, allowing a knowing
   *  write outside its subtree. Undefined for the operator (/trpc) and the superagent. */
  overrideScope?: boolean
  /** Typed accessor to the composed services (issue #13 Phase 2). Optional so
   *  existing context builders keep working — mods() falls back to the
   *  registry's own composition. */
  modules?: RegistryModules
  /** Runtime role composition (roles.ts): hub-only procs 404 when the hub role
   *  is off. Optional so existing context builders keep the historical shape
   *  (absent = core + hub, exactly as before roles existed). */
  role?: ServerRoleConfig
}

/** The typed module seam router procs reach services through (ctx.modules when
 *  the context provides it, else the registry's composed set). */
function mods(ctx: Context): RegistryModules {
  return ctx.modules ?? ctx.registry.modules
}

/** The caller identity the in-process issue command service authorizes against. */
function issueCaller(ctx: Context): IssueCaller {
  return {
    capability: ctx.capability,
    ...(ctx.overrideScope !== undefined ? { overrideScope: ctx.overrideScope } : {}),
  }
}

const t = initTRPC.context<Context>().create()
const PinKind = z.enum(['panel', 'worktree', 'repo'])
const cloudRepoInput = z.object({
  provider: z.literal('github'),
  owner: z.string().min(1),
  name: z.string().min(1),
  ref: z.string().min(1).optional(),
})
const cloudRuntimeSizeInput = z.enum(['small', 'medium', 'large'])
const cloudSourceSessionInput = z.object({
  sessionId: z.string().min(1),
  agent: z.enum(['claude-code', 'codex']),
  resumeRef: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  machineId: z.string().min(1).optional(),
})
const cloudAgentInput = z.object({
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  size: cloudRuntimeSizeInput.optional(),
  repo: cloudRepoInput,
  issueId: z.string().optional(),
  purpose: z.string().optional(),
  sourceSession: cloudSourceSessionInput.optional(),
})
const cloudMachineInput = z.object({
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  size: cloudRuntimeSizeInput,
  repo: cloudRepoInput.optional(),
  purpose: z.string().optional(),
})
const cloudMoveSessionInput = z.object({
  sessionId: z.string().min(1),
  tenantId: z.string().min(1),
  size: cloudRuntimeSizeInput.optional(),
  repo: cloudRepoInput.optional(),
  hibernateLocal: z.boolean().optional(),
})
const cloudRuntimeIdInput = z.object({ id: z.string().min(1) })

// Moved to issue-authz.ts (a leaf module) so relay.ts can share it without importing
// the router; re-exported here for existing importers/tests.
export { SCOPED_TARGET } from './issue-authz'

/** Authorize every issues.* call against the caller's capability. The middleware `path`
 *  is e.g. "issues.create"; its last segment is the proc name, mapped to the action it needs
 *  (PROC_ACTION, unlisted ⇒ 'read'). Two gates: (1) a role gate — `authorize` with no issue
 *  denies if the role can't perform the action (⇒ FORBIDDEN); (2) a scope gate — for a
 *  constrained (non-'all') capability writing an EXISTING target issue, resolve the target +
 *  its ancestors and `authorize` against the subtree. Out-of-subtree ⇒ PRECONDITION_FAILED
 *  (the caller may knowingly override via --outside-scope → ctx.overrideScope). Reads and
 *  create (additive, no existing target) are never scope-restricted. */
const issueCapabilityGuard = t.middleware(async ({ ctx, path, next, getRawInput }) => {
  const proc = path.split('.').pop() ?? ''
  const action = PROC_ACTION[proc] ?? 'read'
  // Target extraction: only for constrained caps writing an existing target issue.
  const extract = ctx.capability.scope.kind !== 'all' ? SCOPED_TARGET[proc] : undefined
  let targetId: string | undefined
  if (extract) {
    const rawTarget = extract((await getRawInput()) as Record<string, unknown>)
    // Resolve display refs (#seq) to the internal id BEFORE the subtree check —
    // scope.rootId is an internal id, so comparing the raw ref would false-negative
    // on the agent's own bound issue. Scope the resolution to the bound issue's repo
    // (by repo_id) so a bare `#N` disambiguates to the agent's own repo (#140).
    const scopeRepoPath =
      ctx.capability.scope.kind === 'subtree'
        ? (mods(ctx).issues.get(ctx.capability.scope.rootId)?.repoPath ?? undefined)
        : undefined
    targetId =
      typeof rawTarget === 'string'
        ? mods(ctx).issues.resolveRef(rawTarget, scopeRepoPath)
        : rawTarget
  }
  // The shared decision + throw shape (#25) — also used by the in-proc mailClaim gate.
  checkIssueAccess(ctx, mods(ctx).issues, proc, action, targetId)
  return next()
})
const issueProc = t.procedure.use(issueCapabilityGuard)

/** Hub-role gate (roles.ts): fleet admin + pairing procs exist on the wire only
 *  when this process runs the hub role. NOT_FOUND (→ HTTP 404), not FORBIDDEN —
 *  on a node the surface is absent, not permission-gated. Context builders that
 *  set no role (tests, in-process callers) keep the historical core+hub shape. */
const hubRoleGuard = t.middleware(({ ctx, next }) => {
  if (ctx.role && !ctx.role.hub) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'not available: this server does not run the hub role',
    })
  }
  return next()
})
const hubProc = t.procedure.use(hubRoleGuard)

function cloudProvider(ctx: Context): CloudRuntimeProvider {
  return ctx.cloud ?? disabledCloudRuntimeProvider
}

function cloudAgentKind(agentKind: string): CloudAgentKind {
  // Capability lookup (#158): cloud-movable kinds are declared in the protocol
  // capability table (claude-code, codex today).
  if (isAgentKind(agentKind) && agentSupportsCloud(agentKind)) return agentKind as CloudAgentKind
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `agent kind ${agentKind} cannot be moved to cloud yet`,
  })
}

function githubRepoFromOrigin(originUrl: string | null | undefined): CloudRepoRequest | null {
  const normalized = normalizeOriginUrl(originUrl)
  const match = normalized?.match(/^github\.com\/([^/]+)\/([^/]+)$/)
  const owner = match?.[1]
  const name = match?.[2]
  if (!owner || !name) return null
  return { provider: 'github', owner, name }
}

function inferCloudRepoForSession(
  ctx: Context,
  session: ReturnType<SessionRegistry['listSessions']>[number],
): CloudRepoRequest {
  const repoPath = ctx.repos.inferFromPath(session.cwd, session.machineId)
  if (!repoPath) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'session cwd is not inside a registered repo; pass repo explicitly',
    })
  }

  const repoRow =
    ctx.registry.sessionStore.listRepos(session.machineId).find((row) => row.path === repoPath) ??
    ctx.registry.sessionStore.listRepos().find((row) => row.path === repoPath)
  const repo = githubRepoFromOrigin(repoRow?.originUrl)
  if (!repo) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'registered repo has no GitHub origin; pass repo explicitly',
    })
  }
  return repo
}

function cloudError(error: unknown): never {
  if (error instanceof CloudRuntimeUnavailableError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message })
  }
  throw error
}

export const appRouter = t.router({
  cloud: t.router({
    capabilities: t.procedure.query(({ ctx }) => cloudProvider(ctx).capabilities()),
    createMachine: t.procedure.input(cloudMachineInput).mutation(async ({ ctx, input }) => {
      try {
        return await cloudProvider(ctx).createCloudMachine(input)
      } catch (error) {
        cloudError(error)
      }
    }),
    createAgent: t.procedure.input(cloudAgentInput).mutation(async ({ ctx, input }) => {
      try {
        return await cloudProvider(ctx).createCloudAgent(input)
      } catch (error) {
        cloudError(error)
      }
    }),
    moveSession: t.procedure.input(cloudMoveSessionInput).mutation(async ({ ctx, input }) => {
      const session = mods(ctx)
        .sessions.listSessions()
        .find((s) => s.sessionId === input.sessionId)
      if (!session) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'session not found' })
      }
      const agent = cloudAgentKind(session.agentKind)
      if (!session.resume?.value) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'session has no resume ref' })
      }
      if (input.hibernateLocal) {
        if (session.status !== 'live') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'local session cannot be hibernated: not running',
          })
        }
        const phase = session.agentState?.phase
        if (phase === 'working' || phase === 'compacting') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'local session cannot be hibernated: agent is working',
          })
        }
      }

      try {
        const runtime = await cloudProvider(ctx).createCloudAgent({
          tenantId: input.tenantId,
          displayName: session.name?.trim() || session.title || `${agent} session`,
          ...(input.size ? { size: input.size } : {}),
          repo: input.repo ?? inferCloudRepoForSession(ctx, session),
          ...(session.issueId ? { issueId: session.issueId } : {}),
          purpose: 'move-session',
          sourceSession: {
            sessionId: session.sessionId,
            agent,
            resumeRef: session.resume.value,
            cwd: session.cwd,
            ...(session.machineId ? { machineId: session.machineId } : {}),
          },
        })

        if (input.hibernateLocal) {
          const parked = mods(ctx).sessions.hibernateSession({ sessionId: session.sessionId })
          if (!parked.ok) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `local session could not be hibernated: ${parked.reason ?? 'unknown reason'}`,
            })
          }
        }

        return runtime
      } catch (error) {
        cloudError(error)
      }
    }),
    runtime: t.procedure
      .input(cloudRuntimeIdInput)
      .query(({ ctx, input }) => cloudProvider(ctx).getRuntime(input.id)),
    stop: t.procedure.input(cloudRuntimeIdInput).mutation(async ({ ctx, input }) => {
      try {
        return await cloudProvider(ctx).stopRuntime(input.id)
      } catch (error) {
        cloudError(error)
      }
    }),
    wake: t.procedure.input(cloudRuntimeIdInput).mutation(async ({ ctx, input }) => {
      try {
        return await cloudProvider(ctx).wakeRuntime(input.id)
      } catch (error) {
        cloudError(error)
      }
    }),
  }),
  sessions: t.router({
    list: t.procedure.query(({ ctx }) => mods(ctx).sessions.listSessions()),
    create: t.procedure
      .input(
        z.object({
          // Omitted = the settings default decides which harness to start.
          agentKind: AgentKind.optional(),
          cwd: z.string(),
          title: z.string().optional(),
          // Which machine to spawn on. Omitted = resolved by repo affinity / the sole
          // online machine (single-machine behavior is unchanged).
          machineId: z.string().optional(),
          // Explicit issue attachment (issue-as-workspace). Omitted = derived from
          // cwd (sole non-archived owning issue) inside createSession.
          issueId: z.string().optional(),
          // Client-supplied id (optimistic UI): the web client can render an
          // optimistic row before the round-trip completes, then reconcile it
          // seamlessly when the server's broadcast lands using this same id.
          // Omitted = the server mints one (unchanged default behavior). uuid-bounded
          // because it feeds durableLabel → the systemd-run scope / abduco socket name.
          sessionId: z.string().uuid().optional(),
          // Low-friction start: create a draft issue vessel first and attach the
          // new session to it (spec: issue-as-workspace).
          draftIssue: z.object({ repoPath: z.string(), issueId: z.string().optional() }).optional(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      // Provenance (issue #60) is stamped HERE, the one human seam: every tRPC
      // sessions.create is an operator action (web UI / CLI). Programmatic creators
      // (issues, superagent) call registry.createSession directly with their own tag.
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.create', () => {
          const { draftIssue, mutationId: _m, ...rest } = input
          const issueId =
            rest.issueId ??
            (draftIssue
              ? mods(ctx).issues.createDraftFor(
                  draftIssue.repoPath,
                  rest.agentKind,
                  draftIssue.issueId,
                ).id
              : undefined)
          return mods(ctx).sessions.createSession({
            ...rest,
            ...(issueId ? { issueId } : {}),
            spawnedBy: 'user',
          })
        }),
      ),
    resume: t.procedure
      .input(
        z.object({
          agentKind: AgentKind,
          cwd: z.string(),
          resume: ResumeRef,
          conversationId: z.string(),
          title: z.string().optional(),
          machineId: z.string().optional(),
        }),
      )
      // Same human seam as create (issue #60): a tRPC resume is an operator action.
      // Only the fresh-spawn fallback uses this — a resume that lands on an existing
      // row keeps that row's original provenance (see resumeSession).
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.resumeSession({ ...input, spawnedBy: 'user' }),
      ),
    kill: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).sessions.killSession(input)),
    continue: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).sessions.continueSession(input)),
    // Chat-view send path: routes around controller gating on purpose — a chat
    // message is an explicit user act, not a competing keyboard.
    sendText: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          text: z.string().min(1).max(32_768),
          // Idempotency key (docs/spec/outbox-write-path.md §2.1): a replayed send
          // must NOT double-type into the PTY.
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.sendText', () =>
          mods(ctx).sessions.sendText(input),
        ),
      ),
    // Chat-view answer to a live AskUserQuestion prompt: type the chosen option
    // number(s) into the agent's native menu (the native terminal is unmounted in
    // chat mode). One entry per question, each with its 1-based option indices.
    answerAskUserQuestion: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          choices: z
            .array(z.object({ optionIndices: z.array(z.number().int().min(1).max(9)).min(1) }))
            .min(1),
        }),
      )
      .mutation(({ ctx, input }) => mods(ctx).sessions.answerAskUserQuestion(input)),
    // Chat compose for a parked session: wake it if needed, then deliver the
    // message once the resumed CLI is ready (auto-resume on submit).
    resumeAndSend: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          text: z.string().min(1).max(32_768),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.resumeAndSend', () =>
          mods(ctx).sessions.resumeAndSend(input),
        ),
      ),
    // On-demand transcript window for the chat view — a pure disk read via the
    // daemon (disk = source of truth). `anchor` is a cursor; `direction` reads the
    // `limit` items before (older) or after (newer) it. No anchor = the latest
    // window. Serves both initial load and scroll-to-top paging, for live AND parked
    // sessions alike — independent of the server's recent-delta cache.
    transcriptRead: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          anchor: z.string().optional(),
          direction: z.enum(['before', 'after']),
          limit: z.number().int().positive().max(2000),
        }),
      )
      .query(({ ctx, input }) => mods(ctx).rpc.readTranscript(input)),
    hibernate: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).sessions.hibernateSession(input)),
    resurrect: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).sessions.resurrectSession(input)),
    rename: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          name: z.string().max(120),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.rename', () =>
          mods(ctx).sessions.renameSession(input),
        ),
      ),
    setArchived: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          archived: z.boolean(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.setArchived', () =>
          mods(ctx).sessions.setArchived(input),
        ),
      ),
    // Mark a session read (issue #124): stamp read_at = now, flipping derived `unread`.
    markRead: t.procedure
      .input(z.object({ sessionId: z.string(), mutationId: z.string().max(128).optional() }))
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.markRead', () =>
          mods(ctx).sessions.markSessionRead(input.sessionId),
        ),
      ),
    // Mark a session UNREAD again (issue #138): clear read_at, flipping derived
    // `unread` back to true. Mirrors markRead exactly (email-style inverse action).
    markUnread: t.procedure
      .input(z.object({ sessionId: z.string(), mutationId: z.string().max(128).optional() }))
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'sessions.markUnread', () =>
          ctx.registry.markSessionUnread(input.sessionId),
        ),
      ),
    // Move (or clear) a session's explicit issue attachment (issue-as-workspace).
    setIssueId: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          issueId: z.string().nullable(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.setIssueId', () =>
          mods(ctx).sessions.setSessionIssueId(input.sessionId, input.issueId),
        ),
      ),
    setWorkState: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          workState: WorkState.nullable(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.setWorkState', () =>
          mods(ctx).sessions.setWorkState(input),
        ),
      ),
    // Image upload: the client sends a base64-encoded image; the daemon writes
    // it to ~/.podium/uploads/<sessionId>/<uuid>.<ext> and returns the absolute
    // path so it can be inserted into a prompt. Claude Code reads images by path.
    uploadImage: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          filename: z.string().max(255),
          mimeType: z.string().max(100),
          dataBase64: z.string().max(10 * 1024 * 1024), // ~7.5 MB decoded
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await mods(ctx).rpc.uploadImage(input)
        if (result.error) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: result.error,
          })
        }
        if (!result.path) {
          throw new TRPCError({
            code: 'TIMEOUT',
            message: 'no daemon answered the image upload request',
          })
        }
        return result
      }),
  }),
  sync: t.router({
    // Metadata-oplog catch-up (docs/spec/oplog-read-path.md): null cursor = bootstrap
    // snapshot; a valid cursor = the changes after it; a compacted/future cursor
    // falls back to snapshot. The client heals every WS (re)connect through this.
    changesSince: t.procedure
      .input(z.object({ cursor: z.number().int().nonnegative().nullable() }))
      .query(({ ctx, input }) => mods(ctx).sessions.syncChangesSince(input.cursor)),
  }),
  pins: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listPins()),
    set: t.procedure
      .input(z.object({ kind: PinKind, id: z.string(), pinned: z.boolean() }))
      .mutation(({ ctx, input }) => {
        try {
          ctx.registry.setPin(input.kind, input.id, input.pinned)
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return ctx.registry.listPins()
      }),
  }),
  snoozes: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listSnoozes()),
    // until === null => "until next message"; ISO string => timed.
    set: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          until: z.string().nullable(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'snoozes.set', () => {
          mods(ctx).sessions.setSnooze(input)
          return ctx.registry.listSnoozes()
        }),
      ),
    clear: t.procedure
      .input(z.object({ sessionId: z.string(), mutationId: z.string().max(128).optional() }))
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'snoozes.clear', () => {
          mods(ctx).sessions.clearSnooze(input.sessionId)
          return ctx.registry.listSnoozes()
        }),
      ),
  }),
  superagent: t.router({
    // The global orchestrator thread plus per-session 'btw' threads.
    listThreads: t.procedure.query(({ ctx }) => ctx.superagent.listThreads()),
    history: t.procedure
      .input(z.object({ threadId: z.string().default('global') }))
      .query(({ ctx, input }) => ctx.superagent.history(input.threadId)),
    // One headless harness turn on an existing thread (concierge unification):
    // acks {threadId, podiumSessionId} as soon as the turn is dispatched — output
    // arrives via the session's transcript stream + headlessActivity frames.
    sendTurn: t.procedure
      .input(
        z.object({ threadId: z.string().default('global'), text: z.string().min(1).max(32_768) }),
      )
      .mutation(({ ctx, input }) => ctx.superagent.sendTurn(input)),
    // `send` is the same turn path (kept as the generic entry the panel uses).
    send: t.procedure
      .input(
        z.object({ threadId: z.string().default('global'), text: z.string().min(1).max(32_768) }),
      )
      .mutation(({ ctx, input }) => ctx.superagent.sendTurn(input)),
    // Stop the thread's running headless turn.
    interruptTurn: t.procedure
      .input(z.object({ threadId: z.string() }))
      .mutation(({ ctx, input }) => ctx.superagent.interruptTurn(input)),
    // Escape hatch: open the thread's harness session as a normal PTY session
    // (resume argv) and lock the thread — one writer at a time.
    openInTerminal: t.procedure
      .input(z.object({ threadId: z.string() }))
      .mutation(({ ctx, input }) => ctx.superagent.openInTerminal(input)),
    clear: t.procedure
      .input(z.object({ threadId: z.string().default('global') }))
      .mutation(({ ctx, input }) => ctx.superagent.clear(input.threadId)),
    // Ensure (or re-open) a btw thread for a chat session. The transcript seed /
    // re-open delta is prepended to the thread's next sendTurn.
    startBtw: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.superagent.startBtwTurn(input)),
    // Per-repo concierge intake (issue #64): ensure the repo's thread, then run
    // the message as a headless harness turn (digest seed on the first turn,
    // issue-event delta on re-entry). Returns the sendTurn ack + isNew.
    concierge: t.procedure
      .input(z.object({ repoPath: z.string().min(1), text: z.string().min(1).max(32_768) }))
      .mutation(({ ctx, input }) => ctx.superagent.conciergeTurn(input)),
  }),
  conversations: t.router({
    // Keyword search over the durable index (FTS5 where available). Empty query
    // browses by recency. projectPath narrows to a repo/worktree subtree.
    search: t.procedure
      .input(
        z.object({
          query: z.string().optional(),
          projectPath: z.string().optional(),
          limit: z.number().int().positive().max(200).optional(),
        }),
      )
      .query(({ ctx, input }) => mods(ctx).conversations.searchConversations(input)),
    // Curation written by the command center (user rename / work-LLM summary).
    setMeta: t.procedure
      .input(
        z.object({
          id: z.string(),
          name: z.string().max(200).optional(),
          summary: z.string().max(2000).optional(),
        }),
      )
      .mutation(({ ctx, input }) => mods(ctx).conversations.setConversationMeta(input)),
  }),
  search: t.router({
    // Omni-search (docs/spec/search-v1.md §2.4): one ranked, typed result list
    // across transcripts/issues/conversations/sessions/settings. Wire shape:
    // SearchResultWire (@podium/protocol).
    query: t.procedure
      .input(
        z.object({
          text: z.string().min(1).max(256),
          limit: z.number().int().positive().max(100).optional(),
        }),
      )
      .query(({ ctx, input }) => searchAll(ctx.registry.sessionStore, ctx.registry, input)),
  }),
  settings: t.router({
    get: t.procedure.query(({ ctx }) => mods(ctx).settings.getSettings()),
    // Whole-object set: the client always round-trips the full blob, so there is
    // no partial-merge ambiguity. PodiumSettings fills defaults for missing keys.
    set: t.procedure
      .input(PodiumSettings)
      .mutation(({ ctx, input }) => mods(ctx).settings.setSettings(input)),
    telegramSetupStart: t.procedure.mutation(({ ctx }) => mods(ctx).settings.startTelegramSetup()),
    telegramSetupPoll: t.procedure
      .input(z.object({ setupId: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).settings.pollTelegramSetup(input.setupId)),
  }),
  tabs: t.router({
    listOrders: t.procedure.query(({ ctx }) => ctx.registry.listTabOrders()),
    setOrder: t.procedure
      .input(z.object({ worktree: z.string(), sessionIds: z.array(z.string()) }))
      .mutation(({ ctx, input }) => {
        try {
          ctx.registry.setTabOrder(input.worktree, input.sessionIds)
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return ctx.registry.listTabOrders()
      }),
  }),
  repos: t.router({
    list: t.procedure.query(({ ctx }) => ctx.repos.list()),
    // cwd → repo inference for the CLI: longest registered root that contains `path`.
    inferFromPath: t.procedure
      .input(z.object({ path: z.string() }))
      .query(({ ctx, input }) => ({ repoPath: ctx.repos.inferFromPath(input.path) ?? null })),
    add: t.procedure
      .input(z.object({ path: z.string(), machineId: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        try {
          await ctx.repos.add(input.path, input.machineId)
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return ctx.repos.list()
      }),
    // Persist a selected set in one call (the scan-and-select flow). Each path is
    // added independently so one bad entry doesn't drop the rest; failures are reported.
    addMany: t.procedure
      .input(z.object({ paths: z.array(z.string()), machineId: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const failed: { path: string; message: string }[] = []
        for (const path of input.paths) {
          try {
            await ctx.repos.add(path, input.machineId)
          } catch (e) {
            failed.push({ path, message: e instanceof Error ? e.message : String(e) })
          }
        }
        return { repos: ctx.repos.list(), failed }
      }),
    remove: t.procedure
      .input(z.object({ path: z.string(), machineId: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        await ctx.repos.remove(input.path, input.machineId)
        return ctx.repos.list()
      }),
    browse: t.procedure
      .input(
        z.object({ path: z.string().optional(), includeHidden: z.boolean().optional() }).optional(),
      )
      .query(async ({ input }) => {
        try {
          return await browseDirectories(input?.path, { includeHidden: input?.includeHidden })
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
      }),
  }),
  usage: t.router({
    // Hour×model token buckets for the last 7 days, harvested from harness
    // transcripts on the dev machine. Window math (5h/weekly/cost) is client-side.
    summary: t.procedure.query(({ ctx }) => mods(ctx).rpc.usage()),
  }),
  quota: t.router({
    // Per-agent plan-quota (5h/weekly % used + reset times), read live on the
    // daemon host from each agent's own usage endpoint. Fans out to every online
    // machine (each runs its agents under its own account) — one entry per
    // machine. Distinct from `usage`, transcript-harvested token-cost analytics.
    summary: t.procedure.query(({ ctx }) => mods(ctx).rpc.agentQuotaAll()),
  }),
  models: t.router({
    // Live per-agent model lists (grok/cursor/opencode `models`). Stale-while-
    // revalidate: `catalog` returns instantly (cached, possibly empty on first ever
    // call) and refreshes in the background; the web merges these over its static
    // catalog and re-reads on the next open. `refresh` forces + awaits a fresh probe.
    catalog: t.procedure.query(({ ctx }) => mods(ctx).settings.getModelCatalog()),
    refresh: t.procedure.mutation(({ ctx }) => mods(ctx).settings.refreshModelCatalog()),
  }),
  hosts: t.router({
    // Who owns the used memory right now. Roots are derived server-side — the
    // registered repos plus their worktrees (worktrees often live OUTSIDE the
    // repo path as siblings, so the repo path alone would miss their dev servers).
    memoryBreakdown: t.procedure
      .input(z.object({ machineId: z.string().optional() }).optional())
      .mutation(async ({ ctx, input }) => {
        const machineId = input?.machineId
        // Roots are derived server-side — the target machine's registered repos
        // plus their worktrees (worktrees often live OUTSIDE the repo path as
        // siblings, so the repo path alone would miss their dev servers). Scoping
        // to the clicked machine's repos keeps foreign paths out of its /proc walk.
        const repoPaths = ctx.repos.list(machineId)
        const { repositories } = machineId
          ? await ctx.registry.scanReposForMachine(repoPaths, machineId, {
              includeHome: false,
              maxDepth: 0,
            })
          : await ctx.registry.scanRepos(repoPaths, { includeHome: false, maxDepth: 0 })
        const roots = [
          ...new Set(repositories.flatMap((r) => [r.path, ...r.worktrees.map((w) => w.path)])),
        ]
        const breakdown = await mods(ctx).hosts.memoryBreakdown(roots, machineId)
        if (!breakdown) {
          throw new TRPCError({
            code: 'TIMEOUT',
            message: 'no daemon answered the memory breakdown request',
          })
        }
        return breakdown
      }),
  }),
  discovery: t.router({
    scan: t.procedure.mutation(({ ctx }) => mods(ctx).rpc.scan()),
    // Load path: enrich only the already-registered repos with branch/worktree metadata.
    // Fans out to each online machine; each result is stamped with its machineId.
    // Single-machine: identical to the old scanRepos(list()) path (maxDepth:0 inspects
    // each registered root in place, never walking the filesystem), just with machineId added.
    refreshRepos: t.procedure.mutation(({ ctx }) => ctx.repos.scanReposAll()),
    // Discovery path: walk a user-picked folder (never all of $HOME) to a bounded
    // depth and return candidates for the selection screen.
    scanFolder: t.procedure
      .input(z.object({ path: z.string(), maxDepth: z.number().int().positive().optional() }))
      .mutation(({ ctx, input }) =>
        ctx.registry.scanRepos([input.path], {
          includeHome: false,
          maxDepth: input.maxDepth ?? 6,
        }),
      ),
  }),
  machines: t.router({
    // Registered machines (online flag + last-seen), shown in Settings → Machines and
    // the machine dropdown. Single-machine: just the one 'local' machine. CORE —
    // a node reads its own (and its hub-mirrored) fleet; only ADMITTING and
    // administering machines is the hub's job (hubProc below).
    list: t.procedure.query(({ ctx }) => mods(ctx).machines.listMachines()),
    rename: hubProc
      .input(z.object({ id: z.string(), name: z.string().min(1).max(80) }))
      .mutation(({ ctx, input }) => {
        mods(ctx).machines.renameMachine(input.id, input.name)
        return mods(ctx).machines.listMachines()
      }),
    revoke: hubProc.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
      mods(ctx).machines.revokeMachine(input.id)
      return mods(ctx).machines.listMachines()
    }),
    // Mint a short-lived pairing code the user types into a new machine's daemon to
    // join it to this server.
    pairingCode: hubProc.mutation(({ ctx }) => {
      const code = mods(ctx).machines.mintPairingCode()
      const publicUrl = loadConfig().publicUrl
      return {
        code,
        joinCommand: publicUrl ? buildJoinCommand({ publicUrl, pairCode: code }) : null,
      }
    }),
  }),
  // First-run "make this instance reachable" flow (Tailscale-first). The web setup screen
  // reaches these instead of importing @podium/core/setup directly, which would pull node:fs
  // (via ./config) into the browser bundle.
  setup: t.router({
    // Current deployment identity, for Settings → Network to show + let the user change how this
    // server is reached after first-run setup.
    info: t.procedure.query(() => {
      const c = loadConfig()
      return {
        mode: c.mode ?? null,
        publicUrl: c.publicUrl ?? null,
        serverUrl: c.serverUrl ?? null,
      }
    }),
    options: t.procedure.query(() => NETWORK_OPTIONS),
    commandFor: t.procedure
      .input(
        z.object({
          option: z.enum(['tailscale-funnel', 'tailscale-serve', 'cloudflare-tunnel', 'manual']),
          port: z.number(),
        }),
      )
      .query(({ input }) => networkOptionCommand(input.option, input.port)),
    complete: t.procedure
      // password is optional: making the instance reachable strongly suggests setting one.
      // Blank password is still supported, but must be an explicit, auditable opt-out.
      .input(
        z.object({
          publicUrl: z.string(),
          // Which host mode this reachable box is (the web runs this step for both now); absent
          // preserves the existing mode (default all-in-one on first run).
          mode: z.enum(['all-in-one', 'server']).optional(),
          password: z.string().optional(),
          acknowledgeNoPassword: z.literal(true).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const v = validatePublicUrl(input.publicUrl)
        if (!v.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: v.error })
        const password = input.password?.trim()
        // Neither a new password NOR an explicit no-password ack is required when one is ALREADY
        // set — that's "keep the current password" (e.g. setting the URL later from Settings →
        // Machines). It's only a mandatory choice on a fresh, password-less instance.
        if (!password && !input.acknowledgeNoPassword && !hasPassword()) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Confirm running without a login password.',
          })
        }
        const cfg = applySetup({
          publicUrl: v.normalized,
          ...(input.mode ? { mode: input.mode } : {}),
        })
        if (password) await setPassword(password)
        return cfg
      }),
    // Daemon onboarding: one pasted join code (server URL + pairing code) → daemon config.
    // Same core `applyJoin` the CLI uses, so the web and terminal flows stay identical.
    join: t.procedure.input(z.object({ code: z.string() })).mutation(({ input }) => {
      try {
        return applyJoin(input.code.trim())
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
      }
    }),
    // Modes with no reachability flow: all-in-one ("skip"), client (remote URL), server-only.
    // Replaces the legacy POST /setup/config — one tRPC surface for every setup write.
    connect: t.procedure
      .input(
        z.object({
          mode: z.enum(['all-in-one', 'client', 'server']),
          serverUrl: z.string().optional(),
        }),
      )
      .mutation(({ input }) => {
        try {
          return applyMode(input)
        } catch (e) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
        }
      }),
    channel: t.procedure.query(() => getUpdateChannel()),
    setChannel: t.procedure
      .input(z.object({ channel: z.enum(['stable', 'edge']) }))
      .mutation(({ input }) => setUpdateChannel(input.channel)),
  }),
  // Manage the human-client login password on an already-configured instance. These run
  // under the same /trpc guard, so once a password is set you must be logged in to reach
  // them; we ALSO require the current password for a change/disable (defends against a
  // hijacked session). In open mode (no password) the current check is skipped — bootstrap.
  auth: t.router({
    status: t.procedure.query(() => ({ enabled: hasPassword() })),
    setPassword: t.procedure
      .input(z.object({ current: z.string().optional(), next: z.string().min(1) }))
      .mutation(async ({ input }) => {
        if (hasPassword() && !(input.current && (await verifyPassword(input.current)))) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is incorrect' })
        }
        await setPassword(input.next)
        return { enabled: true }
      }),
    clearPassword: t.procedure
      .input(z.object({ current: z.string(), acknowledgeNoPassword: z.literal(true).optional() }))
      .mutation(async ({ input }) => {
        if (!input.acknowledgeNoPassword) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Confirm running without a login password.',
          })
        }
        if (hasPassword() && !(await verifyPassword(input.current))) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is incorrect' })
        }
        clearPassword()
        return { enabled: false }
      }),
  }),
  // Every issues proc body lives in the in-process command service
  // (modules/issues/commands) so the daemon relay and the MCP run the SAME
  // code + authz as this router; the procs here are thin mounts. The
  // issueCapabilityGuard middleware still gates the HTTP path exactly as before.
  issues: t.router({
    list: issueProc
      .input(issueInputs.list)
      .query(({ ctx, input }) => mods(ctx).issueCommands.list(issueCaller(ctx), input)),
    prime: issueProc
      .input(issueInputs.prime)
      .query(({ ctx, input }) => mods(ctx).issueCommands.prime(issueCaller(ctx), input)),
    ready: issueProc
      .input(issueInputs.ready)
      .query(({ ctx, input }) => mods(ctx).issueCommands.ready(issueCaller(ctx), input)),
    blocked: issueProc
      .input(issueInputs.blocked)
      .query(({ ctx, input }) => mods(ctx).issueCommands.blocked(issueCaller(ctx), input)),
    graph: issueProc
      .input(issueInputs.graph)
      .query(({ ctx, input }) => mods(ctx).issueCommands.graph(issueCaller(ctx), input)),
    epicStatus: issueProc
      .input(issueInputs.epicStatus)
      .query(({ ctx, input }) => mods(ctx).issueCommands.epicStatus(issueCaller(ctx), input)),
    children: issueProc
      .input(issueInputs.children)
      .query(({ ctx, input }) => mods(ctx).issueCommands.children(issueCaller(ctx), input)),
    tree: issueProc
      .input(issueInputs.tree)
      .query(({ ctx, input }) => mods(ctx).issueCommands.tree(issueCaller(ctx), input)),
    setState: issueProc
      .input(issueInputs.setState)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.setState(issueCaller(ctx), input)),
    panelApply: issueProc
      .input(issueInputs.panelApply)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.panelApply(issueCaller(ctx), input)),
    depReport: issueProc
      .input(issueInputs.depReport)
      .query(({ ctx, input }) => mods(ctx).issueCommands.depReport(issueCaller(ctx), input)),
    closeEligibleEpics: issueProc
      .input(issueInputs.closeEligibleEpics)
      .query(({ ctx, input }) =>
        mods(ctx).issueCommands.closeEligibleEpics(issueCaller(ctx), input),
      ),
    findDuplicates: issueProc
      .input(issueInputs.findDuplicates)
      .query(({ ctx, input }) => mods(ctx).issueCommands.findDuplicates(issueCaller(ctx), input)),
    stale: issueProc
      .input(issueInputs.stale)
      .query(({ ctx, input }) => mods(ctx).issueCommands.stale(issueCaller(ctx), input)),
    lint: issueProc
      .input(issueInputs.lint)
      .query(({ ctx, input }) => mods(ctx).issueCommands.lint(issueCaller(ctx), input)),
    doctor: issueProc
      .input(issueInputs.doctor)
      .query(({ ctx, input }) => mods(ctx).issueCommands.doctor(issueCaller(ctx), input)),
    preflight: issueProc
      .input(issueInputs.preflight)
      .query(({ ctx, input }) => mods(ctx).issueCommands.preflight(issueCaller(ctx), input)),
    search: issueProc
      .input(issueInputs.search)
      .query(({ ctx, input }) => mods(ctx).issueCommands.search(issueCaller(ctx), input)),
    count: issueProc
      .input(issueInputs.count)
      .query(({ ctx, input }) => mods(ctx).issueCommands.count(issueCaller(ctx), input)),
    stats: issueProc
      .input(issueInputs.stats)
      .query(({ ctx, input }) => mods(ctx).issueCommands.stats(issueCaller(ctx), input)),
    orphans: issueProc
      .input(issueInputs.orphans)
      .query(({ ctx, input }) => mods(ctx).issueCommands.orphans(issueCaller(ctx), input)),
    get: issueProc
      .input(issueInputs.get)
      .query(({ ctx, input }) => mods(ctx).issueCommands.get(issueCaller(ctx), input)),
    // Lazy comment fetch (#175): comment bodies no longer ride IssueWire.
    comments: issueProc
      .input(issueInputs.comments)
      .query(({ ctx, input }) => mods(ctx).issueCommands.comments(issueCaller(ctx), input)),
    events: issueProc
      .input(issueInputs.events)
      .query(({ ctx, input }) => mods(ctx).issueCommands.events(issueCaller(ctx), input)),
    create: issueProc
      .input(issueInputs.create)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.create(issueCaller(ctx), input)),
    start: issueProc
      .input(issueInputs.start)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.start(issueCaller(ctx), input)),
    update: issueProc
      .input(issueInputs.update)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.update(issueCaller(ctx), input)),
    attachSession: issueProc
      .input(issueInputs.attachSession)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.attachSession(issueCaller(ctx), input)),
    archive: issueProc
      .input(issueInputs.archive)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.archive(issueCaller(ctx), input)),
    delete: issueProc
      .input(issueInputs.delete)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.delete(issueCaller(ctx), input)),
    action: issueProc
      .input(issueInputs.action)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.action(issueCaller(ctx), input)),
    cleanup: issueProc
      .input(issueInputs.cleanup)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.cleanup(issueCaller(ctx), input)),
    integrate: issueProc
      .input(issueInputs.integrate)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.integrate(issueCaller(ctx), input)),
    addSession: issueProc
      .input(issueInputs.addSession)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.addSession(issueCaller(ctx), input)),
    addShell: issueProc
      .input(issueInputs.addShell)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.addShell(issueCaller(ctx), input)),
    applySuggestion: issueProc
      .input(issueInputs.applySuggestion)
      .mutation(({ ctx, input }) =>
        mods(ctx).issueCommands.applySuggestion(issueCaller(ctx), input),
      ),
    dismissSuggestion: issueProc
      .input(issueInputs.dismissSuggestion)
      .mutation(({ ctx, input }) =>
        mods(ctx).issueCommands.dismissSuggestion(issueCaller(ctx), input),
      ),
    refreshAssistant: issueProc
      .input(issueInputs.refreshAssistant)
      .mutation(({ ctx, input }) =>
        mods(ctx).issueCommands.refreshAssistant(issueCaller(ctx), input),
      ),
    setLabels: issueProc
      .input(issueInputs.setLabels)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.setLabels(issueCaller(ctx), input)),
    addComment: issueProc
      .input(issueInputs.addComment)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.addComment(issueCaller(ctx), input)),
    mailSend: issueProc
      .input(issueInputs.mailSend)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.mailSend(issueCaller(ctx), input)),
    mailInbox: issueProc
      .input(issueInputs.mailInbox)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.mailInbox(issueCaller(ctx), input)),
    mailClaim: issueProc
      .input(issueInputs.mailClaim)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.mailClaim(issueCaller(ctx), input)),
    mailPending: issueProc
      .input(issueInputs.mailPending)
      .query(({ ctx, input }) => mods(ctx).issueCommands.mailPending(issueCaller(ctx), input)),
    depAdd: issueProc
      .input(issueInputs.depAdd)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.depAdd(issueCaller(ctx), input)),
    depRemove: issueProc
      .input(issueInputs.depRemove)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.depRemove(issueCaller(ctx), input)),
    defer: issueProc
      .input(issueInputs.defer)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.defer(issueCaller(ctx), input)),
    undefer: issueProc
      .input(issueInputs.undefer)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.undefer(issueCaller(ctx), input)),
    markRead: issueProc
      .input(issueInputs.markRead)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.markRead(issueCaller(ctx), input)),
    // Mark an issue UNREAD again (issue #138): clear read_at, flipping derived
    // `unread` back to true. Node-local like markRead (NOT issueWrite / never
    // hub-forwarded; unlisted in PROC_ACTION) — read-tracking needs only 'read'.
    markUnread: issueProc
      .input(issueInputs.markUnread)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.markUnread(issueCaller(ctx), input)),
    setNeedsHuman: issueProc
      .input(issueInputs.setNeedsHuman)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.setNeedsHuman(issueCaller(ctx), input)),
    clearNeedsHuman: issueProc
      .input(issueInputs.clearNeedsHuman)
      .mutation(({ ctx, input }) =>
        mods(ctx).issueCommands.clearNeedsHuman(issueCaller(ctx), input),
      ),
    reparent: issueProc
      .input(issueInputs.reparent)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.reparent(issueCaller(ctx), input)),
    claim: issueProc
      .input(issueInputs.claim)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.claim(issueCaller(ctx), input)),
    close: issueProc
      .input(issueInputs.close)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.close(issueCaller(ctx), input)),
    supersede: issueProc
      .input(issueInputs.supersede)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.supersede(issueCaller(ctx), input)),
    duplicate: issueProc
      .input(issueInputs.duplicate)
      .mutation(({ ctx, input }) => mods(ctx).issueCommands.duplicate(issueCaller(ctx), input)),
    linearSearch: issueProc
      .input(issueInputs.linearSearch)
      .query(({ ctx, input }) => mods(ctx).issueCommands.linearSearch(issueCaller(ctx), input)),
    subscriptionAdd: issueProc
      .input(issueInputs.subscriptionAdd)
      .mutation(({ ctx, input }) =>
        mods(ctx).issueCommands.subscriptionAdd(issueCaller(ctx), input),
      ),
    subscriptionRemove: issueProc
      .input(issueInputs.subscriptionRemove)
      .mutation(({ ctx, input }) =>
        mods(ctx).issueCommands.subscriptionRemove(issueCaller(ctx), input),
      ),
    subscriptionList: issueProc.query(({ ctx }) =>
      mods(ctx).issueCommands.subscriptionList(issueCaller(ctx)),
    ),
    subscriptionSetEnabled: issueProc
      .input(issueInputs.subscriptionSetEnabled)
      .mutation(({ ctx, input }) =>
        mods(ctx).issueCommands.subscriptionSetEnabled(issueCaller(ctx), input),
      ),
  }),
  files: t.router({
    read: t.procedure
      .input(
        z.union([
          z.object({ sessionId: z.string(), path: z.string() }),
          z.object({ machineId: z.string().optional(), root: z.string(), path: z.string() }),
        ]),
      )
      .query(({ ctx, input }) => {
        if ('root' in input && !isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return mods(ctx).rpc.readFile(input)
      }),
    write: t.procedure
      .input(
        z.union([
          z.object({
            sessionId: z.string(),
            path: z.string(),
            content: z.string(),
            baseHash: z.string().optional(),
          }),
          z.object({
            machineId: z.string().optional(),
            root: z.string(),
            path: z.string(),
            content: z.string(),
            baseHash: z.string().optional(),
          }),
        ]),
      )
      .mutation(({ ctx, input }) => {
        if ('root' in input && !isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return mods(ctx).rpc.writeFile(input)
      }),
    list: t.procedure
      .input(
        z.object({
          machineId: z.string().optional(),
          root: z.string(),
          path: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) => {
        if (!isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return mods(ctx).rpc.listDir(input)
      }),
  }),
  // pspec — the living spec tree in <repo>/pspec/ (modules/specs over
  // apps/server/src/pspec.ts). Prototype scope: local-filesystem repos only
  // (reads/writes on the server host). The repo-root allowlist gate lives in
  // the SpecsService so the daemon-relay path enforces the identical check.
  specs: t.router({
    list: t.procedure
      .input(specsInputs.list)
      .query(({ ctx, input }) => mods(ctx).specs.list(input)),
    get: t.procedure.input(specsInputs.get).query(({ ctx, input }) => mods(ctx).specs.get(input)),
    create: t.procedure
      .input(specsInputs.create)
      .mutation(({ ctx, input }) => mods(ctx).specs.create(input)),
    save: t.procedure
      .input(specsInputs.save)
      .mutation(({ ctx, input }) => mods(ctx).specs.save(input)),
    remove: t.procedure
      .input(specsInputs.remove)
      .mutation(({ ctx, input }) => mods(ctx).specs.remove(input)),
    search: t.procedure
      .input(specsInputs.search)
      .query(({ ctx, input }) => mods(ctx).specs.search(input)),
  }),
})

export type AppRouter = typeof appRouter

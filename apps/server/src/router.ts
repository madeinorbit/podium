import { AgentKind, agentSupportsCloud, isAgentKind, ResumeRef, WorkState } from '@podium/protocol'
import { PodiumSettings } from '@podium/runtime'
import { loadConfig } from '@podium/runtime/config'
import {
  applyJoin,
  applyMode,
  applySetup,
  getUpdateChannel,
  NETWORK_OPTIONS,
  networkOptionCommand,
  setUpdateChannel,
  validatePublicUrl,
} from '@podium/runtime/setup'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { accountViews } from './accounts'
import { clearPassword, hasPassword, setPassword, verifyPassword } from './auth-store'
import {
  type CloudAgentKind,
  type CloudRepoRequest,
  type CloudRuntimeProvider,
  CloudRuntimeUnavailableError,
  disabledCloudRuntimeProvider,
} from './cloud-runtime'
import { buildJoinCommand } from './hub/machines-join'
import { issueRegistry } from './modules/issues/registry'
import { routerFromCommands } from './modules/issues/trpc'
import { lockRegistry } from './modules/lock/registry'
import { lockRouterFromCommands } from './modules/lock/trpc'
import { specsInputs } from './modules/specs/service'
import { UserFocus } from './modules/superagent'
import { type WorkflowCaller, workflowInputs } from './modules/workflows/service'
import type { RegistryModules } from './relay'
import { normalizeOriginUrl } from './repo-id'
import { browseDirectories } from './repo-registry'
import { isAllowedRoot } from './root-allowlist'
import { searchAll } from './search'

// The request Context, the shared `t` instance, and the ctx accessors live in
// ./trpc so the derived issues router (modules/issues/trpc.ts) shares them
// without a runtime cycle. Re-exported for existing import sites.
export { type Context, mods } from './trpc'

import { type Context, mods, t } from './trpc'

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
  session: ReturnType<RegistryModules['sessions']['listSessions']>[number],
): CloudRepoRequest {
  const repoPath = ctx.repos.inferFromPath(session.cwd, session.machineId)
  if (!repoPath) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'session cwd is not inside a registered repo; pass repo explicitly',
    })
  }

  const repoRow =
    ctx.registry.sessionStore.repos
      .listRepos(session.machineId)
      .find((row) => row.path === repoPath) ??
    ctx.registry.sessionStore.repos.listRepos().find((row) => row.path === repoPath)
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
function workflowCaller(ctx: Context): WorkflowCaller {
  const sessionId = ctx.capability.actorSessionId
  return sessionId
    ? {
        actor: { kind: 'session', id: sessionId },
        capability: ctx.capability,
        ...(ctx.overrideScope ? { overrideScope: true } : {}),
      }
    : { actor: { kind: 'operator', id: null }, protectedWrite: true }
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
          // Explicit workflow override; omitted = issue → repository → global default.
          workflowRevisionId: z.string().optional(),
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
      // Unified substrate (#237) [spec:SP-34d7 migration]: human chat sends
      // ride the substrate as OPERATOR — unwrapped, unclamped, ledgered.
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.sendText', () => {
          const { ok, queued, reason } = mods(ctx).messages.send(
            { kind: 'operator' },
            {
              to: { kind: 'session', id: input.sessionId },
              body: input.text,
              urgency: 'next-turn',
              lifecycle: 'wait',
            },
          )
          return {
            ok,
            ...(queued !== undefined ? { queued } : {}),
            ...(reason !== undefined ? { reason } : {}),
          }
        }),
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
      // Substrate-routed like sendText; lifecycle wake resurrects the parked
      // target (operator wakes are never cooldown-braked).
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'sessions.resumeAndSend', () => {
          const { ok, queued, reason } = mods(ctx).messages.send(
            { kind: 'operator' },
            {
              to: { kind: 'session', id: input.sessionId },
              body: input.text,
              urgency: 'next-turn',
              lifecycle: 'wake',
            },
          )
          return {
            ok,
            ...(queued !== undefined ? { queued } : {}),
            ...(reason !== undefined ? { reason } : {}),
          }
        }),
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
    // Read toolkit tiers 1–2 (#237) [spec:SP-34d7]: structured status (phase,
    // issue stage/todos, last commits, files touched, unacked count — NO
    // transcript text) and a bounded transcript window. The /trpc surface is
    // operator-authority; agents reach the same procs via the daemon relay's
    // scope-gated sessions arm. Every read is event-logged by the toolkit.
    status: t.procedure
      .input(z.object({ ref: z.string() }))
      .query(({ ctx, input }) =>
        mods(ctx).readToolkit.status(input.ref, ctx.capability.actorSessionId ?? 'operator'),
      ),
    read: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          turns: z.coerce.number().int().positive().optional(),
          cursor: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) =>
        mods(ctx).readToolkit.read(input, ctx.capability.actorSessionId ?? 'operator'),
      ),
    // Read toolkit tier 3 (#237) [spec:SP-34d7 read-toolkit]: server-side recap
    // since a watermark — repeated check-ins pay only for the delta (the
    // watermark persists per (reader, target)).
    recap: t.procedure
      .input(z.object({ sessionId: z.string(), since: z.string().optional() }))
      .query(({ ctx, input }) =>
        mods(ctx).readToolkit.recap(input, ctx.capability.actorSessionId ?? 'operator'),
      ),
    // Read toolkit tier 4 (#237) [spec:SP-34d7 read-toolkit]: the seance — a
    // question message (next-turn + wake, ack expected) + a bounded ack wait.
    // Authz/clamps live in the MessageGate, shared verbatim with the relay arm.
    ask: t.procedure
      .input(z.unknown())
      .mutation(
        ({ ctx, input }) =>
          mods(ctx).messageGate.dispatch(ctx.capability, ctx.overrideScope, 'ask', input)!,
      ),
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
        ctx.registry.modules.sessions.withMutation(input.mutationId, 'sessions.markUnread', () =>
          ctx.registry.modules.sessions.markSessionUnread(input.sessionId),
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
    list: t.procedure.query(({ ctx }) => ctx.registry.sessionStore.sessions.listPins()),
    set: t.procedure
      .input(z.object({ kind: PinKind, id: z.string(), pinned: z.boolean() }))
      .mutation(({ ctx, input }) => {
        try {
          ctx.registry.sessionStore.sessions.setPin(input.kind, input.id, input.pinned)
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return ctx.registry.sessionStore.sessions.listPins()
      }),
  }),
  snoozes: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.sessionStore.sessions.listSnoozes()),
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
          return ctx.registry.sessionStore.sessions.listSnoozes()
        }),
      ),
    clear: t.procedure
      .input(z.object({ sessionId: z.string(), mutationId: z.string().max(128).optional() }))
      .mutation(({ ctx, input }) =>
        mods(ctx).sessions.withMutation(input.mutationId, 'snoozes.clear', () => {
          mods(ctx).sessions.clearSnooze(input.sessionId)
          return ctx.registry.sessionStore.sessions.listSnoozes()
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
        z.object({
          threadId: z.string().default('global'),
          text: z.string().min(1).max(32_768),
          focus: UserFocus.optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.superagent.sendTurn(input)),
    // `send` is the same turn path (kept as the generic entry the panel uses).
    send: t.procedure
      .input(
        z.object({
          threadId: z.string().default('global'),
          text: z.string().min(1).max(32_768),
          focus: UserFocus.optional(),
        }),
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
    // Reset the thread's harness session — the next turn starts a fresh one
    // (recovery for a wedged/stale harness; keeps the thread + history).
    restart: t.procedure
      .input(z.object({ threadId: z.string().default('global') }))
      .mutation(({ ctx, input }) => ctx.superagent.restartThread(input)),
    // Ensure (or re-open) a btw thread for a chat session. The transcript seed /
    // re-open delta is prepended to the thread's next sendTurn.
    startBtw: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.superagent.startBtwTurn(input)),
    // Per-repo concierge intake (issue #64): ensure the repo's thread, then run
    // the message as a headless harness turn (digest seed on the first turn,
    // issue-event delta on re-entry). Returns the sendTurn ack + isNew.
    concierge: t.procedure
      .input(
        z.object({
          repoPath: z.string().min(1),
          text: z.string().min(1).max(32_768),
          focus: UserFocus.optional(),
        }),
      )
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
      .query(({ ctx, input }) =>
        searchAll(
          ctx.registry.sessionStore,
          { listSessions: () => mods(ctx).sessions.listSessions(), issues: ctx.registry.issues },
          input,
        ),
      ),
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
  accounts: t.router({
    // The Accounts & Keys hub (SP-6454): native CLI logins on this machine
    // (observed read-only) + managed API keys from settings. Read at call-time —
    // native identity/quota drifts, so it's never cached as truth.
    list: t.procedure.query(({ ctx }) => accountViews(mods(ctx).settings.getSettings())),
  }),
  tabs: t.router({
    listOrders: t.procedure.query(({ ctx }) => ctx.registry.sessionStore.sessions.listTabOrders()),
    setOrder: t.procedure
      .input(z.object({ worktree: z.string(), sessionIds: z.array(z.string()) }))
      .mutation(({ ctx, input }) => {
        try {
          ctx.registry.sessionStore.sessions.setTabOrder(input.worktree, input.sessionIds)
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return ctx.registry.sessionStore.sessions.listTabOrders()
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
        const { repositories } = await ctx.registry.modules.rpc.scanRepos(
          repoPaths,
          { includeHome: false, maxDepth: 0 },
          machineId ?? undefined,
        )
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
        ctx.registry.modules.rpc.scanRepos([input.path], {
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
  // reaches these instead of importing @podium/runtime/setup directly, which would pull node:fs
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
  // The issues surface is DERIVED from the command registry (#248
  // [spec:SP-3fe2]): one definition per command (modules/issues/registry.ts)
  // carries input schema, action/scope/target authz, and the handler; the
  // capability guard reads authz from the DEFINITION (no path-string parsing),
  // and the daemon relay + MCP dispatch run the SAME pipeline.
  issues: routerFromCommands(issueRegistry),
  // Advisory named lease locks [spec:SP-85d1] — same derivation pattern, over
  // the lock registry (role-gated only; no issue-scope targets).
  lock: lockRouterFromCommands(lockRegistry),
  // Unified agent messaging (#237) [spec:SP-34d7]: the `podium mail` surface.
  // Input validation + authz live in the MessageGate (shared verbatim with the
  // daemon relay arm); the gate stamps the sender from ctx.capability.
  messages: t.router({
    send: t.procedure
      .input(z.unknown())
      .mutation(
        ({ ctx, input }) =>
          mods(ctx).messageGate.dispatch(ctx.capability, ctx.overrideScope, 'send', input)!,
      ),
    // A mutation on the wire: the recipient's own inbox read consumes queued status.
    inbox: t.procedure
      .input(z.unknown())
      .mutation(
        ({ ctx, input }) =>
          mods(ctx).messageGate.dispatch(ctx.capability, ctx.overrideScope, 'inbox', input)!,
      ),
    show: t.procedure
      .input(z.unknown())
      .query(
        ({ ctx, input }) =>
          mods(ctx).messageGate.dispatch(ctx.capability, ctx.overrideScope, 'show', input)!,
      ),
    // The web ledger view (#237) [spec:SP-34d7 web]: per-issue / per-session
    // delivery ledger — pure read, operator-only (enforced in the gate).
    ledger: t.procedure
      .input(z.unknown())
      .query(
        ({ ctx, input }) =>
          mods(ctx).messageGate.dispatch(ctx.capability, ctx.overrideScope, 'ledger', input)!,
      ),
    reply: t.procedure
      .input(z.unknown())
      .mutation(
        ({ ctx, input }) =>
          mods(ctx).messageGate.dispatch(ctx.capability, ctx.overrideScope, 'reply', input)!,
      ),
    // Cross-harness subagents (#237) [spec:SP-34d7 cross-harness]: `podium
    // agent spawn/await`. The gate owns validation + authz; the child is a
    // full Podium session; await is BOUNDED (returns a snapshot, never hangs).
    spawnAgent: t.procedure
      .input(z.unknown())
      .mutation(
        ({ ctx, input }) =>
          mods(ctx).messageGate.dispatch(ctx.capability, ctx.overrideScope, 'spawnAgent', input)!,
      ),
    awaitAgent: t.procedure
      .input(z.unknown())
      .mutation(
        ({ ctx, input }) =>
          mods(ctx).messageGate.dispatch(ctx.capability, ctx.overrideScope, 'awaitAgent', input)!,
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
  workflows: t.router({
    list: t.procedure
      .input(workflowInputs.list)
      .query(({ ctx, input }) => mods(ctx).workflows.list(input, workflowCaller(ctx))),
    get: t.procedure
      .input(workflowInputs.get)
      .query(({ ctx, input }) => mods(ctx).workflows.get(input, workflowCaller(ctx))),
    create: t.procedure
      .input(workflowInputs.create)
      .mutation(({ ctx, input }) => mods(ctx).workflows.create(input, workflowCaller(ctx))),
    revise: t.procedure
      .input(workflowInputs.revise)
      .mutation(({ ctx, input }) => mods(ctx).workflows.revise(input, workflowCaller(ctx))),
    fork: t.procedure
      .input(workflowInputs.fork)
      .mutation(({ ctx, input }) => mods(ctx).workflows.fork(input, workflowCaller(ctx))),
    publish: t.procedure
      .input(workflowInputs.publish)
      .mutation(({ ctx, input }) => mods(ctx).workflows.publish(input, workflowCaller(ctx))),
    bindings: t.procedure
      .input(workflowInputs.bindings)
      .query(({ ctx, input }) => mods(ctx).workflows.bindings(input, workflowCaller(ctx))),
    assign: t.procedure
      .input(workflowInputs.assign)
      .mutation(({ ctx, input }) => mods(ctx).workflows.assign(input, workflowCaller(ctx))),
    profiles: t.procedure
      .input(workflowInputs.profiles)
      .query(({ ctx, input }) => mods(ctx).workflows.profiles(input, workflowCaller(ctx))),
    profileSave: t.procedure
      .input(workflowInputs.profileSave)
      .mutation(({ ctx, input }) => mods(ctx).workflows.profileSave(input, workflowCaller(ctx))),
    runs: t.procedure
      .input(workflowInputs.runs)
      .query(({ ctx, input }) => mods(ctx).workflows.runs(input, workflowCaller(ctx))),
    prime: t.procedure
      .input(workflowInputs.prime)
      .query(({ ctx, input }) => mods(ctx).workflows.prime(input, workflowCaller(ctx))),
    status: t.procedure
      .input(workflowInputs.status)
      .query(({ ctx, input }) => mods(ctx).workflows.status(input, workflowCaller(ctx))),
    checkpoint: t.procedure
      .input(workflowInputs.checkpoint)
      .mutation(({ ctx, input }) => mods(ctx).workflows.checkpoint(input, workflowCaller(ctx))),
    assignStep: t.procedure
      .input(workflowInputs.assignStep)
      .mutation(({ ctx, input }) => mods(ctx).workflows.assignStep(input, workflowCaller(ctx))),
    skip: t.procedure
      .input(workflowInputs.skip)
      .mutation(({ ctx, input }) => mods(ctx).workflows.skip(input, workflowCaller(ctx))),
    retry: t.procedure
      .input(workflowInputs.retry)
      .mutation(({ ctx, input }) => mods(ctx).workflows.retry(input, workflowCaller(ctx))),
    adopt: t.procedure
      .input(workflowInputs.adopt)
      .mutation(({ ctx, input }) => mods(ctx).workflows.adopt(input, workflowCaller(ctx))),
  }),
  // Approval broker [spec:SP-edbb] (#410): the operator decision surface. The
  // agent side (request/get) rides the issue relay, never this router.
  approvals: t.router({
    list: t.procedure.query(({ ctx }) => mods(ctx).approvals.listPending()),
    approve: t.procedure
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).approvals.approve(input.id)),
    deny: t.procedure
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => mods(ctx).approvals.deny(input.id)),
  }),
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

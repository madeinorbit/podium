import { presenceCommand } from '@podium/commands'
import { sessionHandoffInput } from '@podium/commands'
import {
  AgentKind,
  AutomationScheduleKind,
  AutomationSessionMode,
  isAgentKind,
  ResumeRef,
  WorkState,
} from '@podium/model'
import { agentSupportsCloud, clientSwitchTraceSchema, type FileReadResultMessage } from '@podium/protocol'
import { PodiumSettings } from '@podium/runtime'
import { loadConfig, resolveUpdateChannel } from '@podium/runtime/config'
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
import {
  readTelemetryState,
  resetInstallId,
  setConsent,
  shouldAskForConsent,
} from '@podium/telemetry'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { AccountConnectInput, accountViews, maskCredential } from './accounts'
import { clearPassword, hasPassword, setPassword, verifyPassword } from './auth-store'
import {
  type CloudAgentKind,
  type CloudRepoRequest,
  type CloudRuntimeProvider,
  CloudRuntimeUnavailableError,
  disabledCloudRuntimeProvider,
  toCloudAgentSourceSession,
} from './cloud-runtime'
import { getFeatureStates } from './features'
import { buildJoinCommand } from './hub/machines-join'
import {
  isValidCron,
  respectsScheduleFloor,
  SCHEDULE_FLOOR_MESSAGE,
} from './modules/automations/cron'
import { issueRegistry } from './modules/issues/registry'
import { routerFromCommands } from './modules/issues/trpc'
import { lockRegistry } from './modules/lock/registry'
import { lockRouterFromCommands } from './modules/lock/trpc'
import { specsInputs } from './modules/specs/service'
import { UserFocus } from './modules/superagent'
import type { RegistryModules } from './relay'
import { normalizeOriginUrl } from './repo-id'
import { browseDirectories } from './repo-registry'
import { isAllowedRoot } from './root-allowlist'
import { searchAll } from './search'

// The request Context, the shared `t` instance, and the ctx accessors live in
// ./trpc so the derived issues router (modules/issues/trpc.ts) shares them
// without a runtime cycle. Re-exported for existing import sites.
export { type Context, mods } from './trpc'

import type { AnyCommandContract } from '@podium/commands'
import { MAIL_COMMANDS, type MailProcName } from './modules/messages/registry'
import { visibleMachinesFor } from './modules/sessions/command-ctx'
import { PresenceRegistry, soleHumanPrincipal } from './modules/sessions/presence-registry'
/**
 * THE DERIVED SESSION SURFACE (POD-382).
 *
 * Every session-family MUTATION — presence class, command plane and handoff — is
 * produced from the contract tables by `modules/sessions/trpc.ts` and spread into
 * the four routers below. There is deliberately no `.mutation(` for a session
 * anywhere in this file, and `scripts/audit-session-commands.ts` fails the build if
 * one appears: a hand-written procedure beside a derived one is a second answer to
 * "how is this authorized", which is what the 3.2 split set out to end.
 *
 * `sessions.ask` is the one session write NOT built there: POD-729 owns its
 * contract (it reaches delivery, so the mail table governs it), and it is served
 * below through that family's own derivation — `mailMutation('ask')`. The session
 * surface manifest records it with source `mail`, so the audit still sees it.
 *
 * The reads are still written out. They have no contracts yet (POD-311's remaining
 * work) and the audit checks procedure TYPE rather than name, so a write cannot hide
 * among them by being called a query.
 */
import { presencePrincipal, sessionFamilyProcedures } from './modules/sessions/trpc'
import { workflowFamilyProcedures } from './modules/workflows/trpc'
import { type Context, mods, t } from './trpc'

/**
 * AGENT-MAIL DERIVATION (POD-729, the same join POD-380 applied to the presence
 * class).
 *
 * `mailMutation('send')` builds the tRPC procedure for a mail contract OUT OF
 * THE CONTRACT: its input schema is the contract's own instance — not a
 * restatement beside it and no longer `z.unknown()` — and its body is the
 * framework envelope: the exposure check, then dispatch into the one authz path.
 *
 * `z.unknown()` was not a small thing to remove. It meant the tRPC arm typed
 * nothing at all and shipped the payload to the gate for a second, private
 * parse; the CLIENT saw `unknown` at every call site, and a client sending a
 * malformed body learned about it from a thrown string rather than from a
 * validation error. One schema instance, read by both transports, is what ADR 3
 * D1 asks for.
 *
 * WHY TWO FUNCTIONS AND NOT ONE THAT BRANCHES. A single `mailProc` returning
 * `action === 'read' ? proc.query(run) : proc.mutation(run)` is what this was
 * first, and it typechecks perfectly in this package while DESTROYING the
 * client: `policy.action` is a union at the type level, so every procedure
 * inferred as `query | mutation` and `apps/web` lost `.query`/`.mutate` on all
 * nine. Splitting the verb into the function NAME is what keeps the inferred
 * router honest — and the derivation is not lost, because each helper CHECKS the
 * contract's action and refuses at module load if they disagree. The wire verb
 * and the authz action still cannot drift; the check just runs at boot instead
 * of in the type system.
 *
 * That distinction matters most for `messages.inbox`, which looks like a read
 * and is a `write` because it CONSUMES. A hand-written router is exactly where
 * that gets quietly "corrected" by someone who trusts the name.
 *
 * Deliberately NOT the full transport derivation POD-382 owns: the procedures
 * are still listed by name below, so the SHAPE of the router stays reviewable in
 * this diff. What is gone is every hand-written body.
 */
function mailContractFor(name: MailProcName, expected: 'read' | 'write'): AnyCommandContract {
  const { contract } = MAIL_COMMANDS[name]
  // A command this router serves must SAY it serves tRPC. Failing at module load
  // rather than at call time: a procedure that refuses everything at runtime is
  // the "green gate that stopped looking" failure mode, and it looks identical
  // to a procedure nobody happened to call.
  if (!contract.exposure.includes('trpc')) {
    throw new Error(`mailProc: ${contract.name} is not exposed on trpc`)
  }
  // THE DERIVATION, as a boot-time check. `mailQuery('inbox')` is a compile-time
  // no-op and a runtime crash, which is the right way round: a consuming read
  // served as a query would widen it to viewer-grade principals.
  if (contract.policy.action !== expected) {
    throw new Error(
      `mailProc: ${contract.name} declares action '${contract.policy.action}' but is served as a ${expected === 'read' ? 'query' : 'mutation'}`,
    )
  }
  return contract
}

function mailRun<Out>(name: MailProcName) {
  return ({ ctx, input }: { ctx: Context; input: unknown }): Promise<Out> =>
    // Non-null asserted because the exposure check already proved the dispatcher
    // will not answer `undefined` for this name on this transport.
    mods(ctx).messageGate.dispatch(
      ctx.capability,
      ctx.overrideScope,
      name,
      input,
      'trpc',
    )! as Promise<Out>
}

/** A mail contract whose policy action is `write`, served as a tRPC mutation. */
function mailMutation<Out = unknown>(name: MailProcName) {
  return t.procedure.input(mailContractFor(name, 'write').input).mutation(mailRun<Out>(name))
}

/** A mail contract whose policy action is `read`, served as a tRPC query. */
function mailQuery<Out = unknown>(name: MailProcName) {
  return t.procedure.input(mailContractFor(name, 'read').input).query(mailRun<Out>(name))
}

/**
 * THE DERIVED SESSION-FAMILY PROCEDURES (POD-382), built once at module load.
 *
 * Spread into the four session-family routers below. Building them here rather than
 * inline is what keeps `sessions`/`pins`/`snoozes`/`tabs` readable as the shape they
 * serve, while the CONTRACT TABLES decide the membership.
 */
const sessionFamily = sessionFamilyProcedures()

import type { PinState, SnoozeMap } from './store/types'

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

/** Scheduled-automation composer input (#470) [spec:SP-17db]. The cron is validated
 *  HERE (not only in the service) so an unparseable expression — or one below the
 *  explicit one-minute floor — comes back as a BAD_REQUEST the composer can render,
 *  never a 500.
 *  `repoPath: null` = a GLOBAL automation: it runs in the home directory, for
 *  cross-repo chores. */
const automationFields = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1).nullable().optional(),
  scheduleKind: AutomationScheduleKind.optional(),
  cron: z.string().nullable().optional(),
  runAt: z.string().datetime({ offset: true }).nullable().optional(),
  targetSessionId: z.string().min(1).nullable().optional(),
  agentKind: AgentKind,
  model: z.string().optional(),
  effort: z.string().optional(),
  prompt: z.string().min(1),
  enabled: z.boolean().optional(),
  sessionMode: AutomationSessionMode.optional(),
})

const automationInput = automationFields.superRefine((input, ctx) => {
  const scheduleKind = input.scheduleKind ?? 'cron'
  if (scheduleKind === 'cron') {
    if (!input.cron || !isValidCron(input.cron)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cron'],
        message: 'invalid cron expression — 5 fields: minute hour day month weekday',
      })
    } else if (!respectsScheduleFloor(input.cron)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cron'], message: SCHEDULE_FLOOR_MESSAGE })
    }
    if (input.runAt != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runAt'], message: 'not valid for cron' })
    }
  } else {
    if (input.cron != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cron'],
        message: 'not valid for one-off',
      })
    }
    if (!input.runAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runAt'],
        message: 'required for one-off',
      })
    }
  }
})
const automationPatch = automationFields.partial()

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
          sourceSession: toCloudAgentSourceSession({
            sessionId: session.sessionId,
            agent,
            resume: session.resume,
            cwd: session.cwd,
            ...(session.machineId ? { machineId: session.machineId } : {}),
          }),
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
    // ---- WRITES: THE DERIVED SURFACE (POD-382) ----
    //
    // create · resume · kill · handoff · continue · sendText · answerAskUserQuestion ·
    // resumeAndSend · hibernate · stop · resurrect · uploadImage · ask · rename ·
    // setArchived · markRead · markUnread · setIssueId · setWorkState, every one of
    // them built from its contract by modules/sessions/trpc.ts. Which commands exist
    // is the CONTRACT TABLE's answer now, not this literal's — including which
    // transports serve them, which is why `setDraft` is not here (it declares `ws`).
    ...sessionFamily.sessions,

    // ---- READS ----
    list: t.procedure.query(({ ctx }) => mods(ctx).sessions.listSessions()),
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
    //
    // THE ONE SESSION WRITE NOT BUILT BY `sessionFamilyProcedures()`, and the merge
    // is why. POD-382 had given `ask` a command-plane contract in order to delete the
    // last hand-written body; POD-729 landed first with `ask` cut over to the MAIL
    // table, because it reaches DELIVERY and a send path no contract governs is the
    // hole that cutover closed. Two contracts for one command is a fork, so the
    // duplicate was deleted and this stays the mail family's — derived from its
    // contract by `mailMutation`, recorded in the session-surface manifest with
    // source `mail` so the audit still refuses a hand-written one here.
    ask: mailMutation('ask'),
  }),
  sync: t.router({
    // Metadata-oplog catch-up (docs/spec/oplog-read-path.md): null cursor = bootstrap
    // snapshot; a valid cursor = the changes after it; a compacted/future cursor
    // falls back to snapshot. The client heals every WS (re)connect through this.
    changesSince: t.procedure
      .input(z.object({ cursor: z.number().int().nonnegative().nullable() }))
      .query(({ ctx, input }) =>
        mods(ctx).sessions.syncChangesSince(input.cursor, ctx.publicationAuthority),
      ),
  }),
  pins: t.router({
    // PER-USER STATE (POD-380): the list is the CALLER's pins, not the instance's.
    list: t.procedure.query(({ ctx }) =>
      ctx.registry.sessionStore.sessions.listPins(presencePrincipal(ctx).userId),
    ),
    ...sessionFamily.pins,
  }),
  snoozes: t.router({
    // PER-USER STATE (POD-380): the caller's snoozes.
    list: t.procedure.query(({ ctx }) =>
      ctx.registry.sessionStore.sessions.listSnoozes(presencePrincipal(ctx).userId),
    ),
    // set: until === null => "until next message"; ISO string => timed.
    ...sessionFamily.snoozes,
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
  // Switch-latency instrumentation [POD-701]: rolling server-side timings
  // (every rpc via the trpc.ts middleware + named internal phases) and the
  // client switch-trace ring. Always on; snapshot/reset are diagnostics.
  perf: t.router({
    snapshot: t.procedure.query(({ ctx }) => mods(ctx).perf.snapshot()),
    report: t.procedure.input(clientSwitchTraceSchema).mutation(({ ctx, input }) => {
      mods(ctx).perf.pushClientTrace(input)
      // Live visibility: one compact line per reported switch, with the three
      // slowest gaps between consecutive marks (offsets are relative to t0).
      const marks = [...input.marks].sort((a, b) => a.atMs - b.atMs)
      const gaps: { name: string; ms: number }[] = []
      let prevAt = 0
      for (const m of marks) {
        gaps.push({ name: m.name, ms: m.atMs - prevAt })
        prevAt = m.atMs
      }
      const slowest = gaps
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 3)
        .map((g) => `${g.name}+${Math.round(g.ms)}ms`)
        .join(' ')
      console.log(
        `[perf] switch ${input.sessionId.slice(0, 8)} mode=${input.mode} cold=${input.cold} ` +
          `total=${Math.round(input.totalMs)}ms${input.timedOut ? ' TIMEOUT' : ''}` +
          (slowest ? ` slowest: ${slowest}` : ''),
      )
      return { ok: true as const }
    }),
    reset: t.procedure.mutation(({ ctx }) => {
      mods(ctx).perf.reset()
      return { ok: true as const }
    }),
  }),
  // Experimental feature flags [spec:SP-f4b9] — same auth as settings.get.
  features: t.router({
    state: t.procedure.query(({ ctx }) =>
      getFeatureStates(mods(ctx).settings.getSettings(), loadConfig()),
    ),
  }),
  /**
   * Opt-in telemetry [spec:SP-f933] — Settings → Privacy's backing surface.
   *
   * Reads/writes config.json (D8), NOT the settings blob, so the web toggles and
   * `podium telemetry off` are the same switch. Self-persisting: each `set` lands
   * immediately rather than riding the settings Save button, because "I turned
   * telemetry off" must never be lost to an unsaved page.
   *
   * Same auth as settings.get (the /trpc guard = the operator).
   */
  telemetry: t.router({
    state: t.procedure.query(() => readTelemetryState(loadConfig())),
    set: t.procedure
      .input(
        z
          .object({
            usage: z.enum(['on', 'off']).optional(),
            crash: z.enum(['on', 'off']).optional(),
          })
          // At least one tier, so an empty call can't silently no-op.
          .refine((v) => v.usage !== undefined || v.crash !== undefined, {
            message: 'specify usage and/or crash',
          }),
      )
      .mutation(({ input }) => setConsent(input)),
    resetId: t.procedure.mutation(() => resetInstallId()),
    /** The example report the Privacy page shows. Rendered from the REAL emitter
     *  where one exists, so what the user is shown cannot drift from what is
     *  sent; falls back to the illustrative sample before anyone has opted in
     *  (there is no real report to show until then — by design). */
    preview: t.procedure.query(({ ctx }) => ctx.telemetry?.emitter.buildUsageReport() ?? null),
  }),
  accounts: t.router({
    // The Accounts & Keys hub (SP-6454): native CLI logins on this machine
    // (observed read-only) + managed credentials Podium holds. Read at call-time —
    // native identity/quota drifts, so it's never cached as truth.
    // NB: never returns a credential — only its masked `identity`.
    list: t.procedure.query(({ ctx }) =>
      accountViews(mods(ctx).settings.getSettings(), ctx.registry.sessionStore.accounts),
    ),
    connect: t.procedure
      // Rejects kind 'oauth' for non-anthropic providers — see AccountConnectInput.
      .input(AccountConnectInput)
      .mutation(({ ctx, input }) => {
        // A Claude setup-token is its own account, distinct from an Anthropic API key.
        const id = input.kind === 'oauth' ? 'managed:claude-oauth' : `managed:${input.provider}`
        ctx.registry.sessionStore.accounts.upsert({
          id,
          provider: input.provider,
          kind: input.kind,
          credential: input.credential,
          identity: maskCredential(input.credential),
          scope: 'role',
          createdAt: Date.now(),
        })
        // Only the id: the credential must never be echoed back to a client.
        return { id }
      }),
    disconnect: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
      ctx.registry.sessionStore.accounts.remove(input.id)
      return { ok: true as const }
    }),
  }),
  tabs: t.router({
    // PER-USER STATE (POD-380): the caller's saved orders.
    listOrders: t.procedure.query(({ ctx }) =>
      ctx.registry.sessionStore.sessions.listTabOrders(presencePrincipal(ctx).userId),
    ),
    ...sessionFamily.tabs,
  }),
  repos: t.router({
    list: t.procedure.query(({ ctx }) => ctx.repos.list()),
    // Full registered-repo rows incl. the human-facing prefix (#474) — the web's
    // source for the linkify prefix set and the prefix editor.
    listDetailed: t.procedure.query(({ ctx }) => ctx.registry.sessionStore.repos.listRepos()),
    // Change a repo's nice-id prefix (#474). Validation (^[A-Z]{2,5}$) and
    // server-wide uniqueness are enforced in the store; violations surface as
    // BAD_REQUEST with the store's message. Old refs stop resolving — UI warns.
    setPrefix: t.procedure
      .input(z.object({ path: z.string(), prefix: z.string(), machineId: z.string().optional() }))
      .mutation(({ ctx, input }) => {
        try {
          ctx.repos.setPrefix(input.path, input.prefix, input.machineId)
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return ctx.registry.sessionStore.repos.listRepos()
      }),
    // cwd → repo inference for the CLI: longest registered root that contains `path`.
    inferFromPath: t.procedure
      .input(z.object({ path: z.string() }))
      .query(({ ctx, input }) => ({ repoPath: ctx.repos.inferFromPath(input.path) ?? null })),
    add: t.procedure
      .input(
        z.object({
          path: z.string(),
          machineId: z.string().optional(),
          // Optional nice-id prefix override (#474); derived from the repo name when absent.
          prefix: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          await ctx.repos.add(input.path, input.machineId, input.prefix)
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
    // Browse a machine's directories for the repo picker (POD-814) [spec:SP-3701].
    // With `machineId` the listing comes from THAT machine's daemon — the only
    // filesystem the user means. Without it, the legacy server-local browse: kept
    // strictly for old clients that predate the machine-aware picker, which reads
    // the hub host's own disk (wrong tree, and empty-to-absent in mode=server).
    browse: t.procedure
      .input(
        z
          .object({
            path: z.string().optional(),
            includeHidden: z.boolean().optional(),
            machineId: z.string().optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        if (input?.machineId) {
          const res = await mods(ctx).rpc.browseDirs(
            input.path,
            {
              ...(input.includeHidden === undefined ? {} : { includeHidden: input.includeHidden }),
            },
            input.machineId,
          )
          if (!res.listing)
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: res.error ?? 'directory browse failed',
            })
          return res.listing
        }
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
    // depth and return candidates for the selection screen. machineId targets that
    // machine's daemon (POD-787); omitted → default machine (legacy behavior).
    scanFolder: t.procedure
      .input(
        z.object({
          path: z.string(),
          maxDepth: z.number().int().positive().optional(),
          machineId: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.modules.rpc.scanRepos(
          [input.path],
          {
            includeHome: false,
            maxDepth: input.maxDepth ?? 6,
          },
          input.machineId,
        ),
      ),
    // Tiered per-machine discovery (POD-787) [spec:SP-3701]: probes of other machines'
    // repo paths + shallow walks around known repos; `deep` adds the bounded $HOME
    // sweep. Origin matches are auto-registered; the rest come back as candidates.
    scanMachine: t.procedure
      .input(
        z.object({
          machineId: z.string(),
          deep: z.boolean().optional(),
          // The folder the user is browsing — scanned as an extra root ("scan
          // here", POD-855) [spec:SP-5eb6] alongside the always-on known-repo tiers.
          atPath: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => {
        if (!ctx.discovery)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'discovery unavailable' })
        return ctx.discovery.scan(input.machineId, {
          deep: input.deep ?? true,
          ...(input.atPath === undefined ? {} : { atPath: input.atPath }),
        })
      }),
    // Most recent finished discovery for a machine (e.g. the automatic connect scan),
    // so the picker can show results without re-scanning.
    lastMachineScan: t.procedure
      .input(z.object({ machineId: z.string() }))
      .query(({ ctx, input }) => ctx.discovery?.lastResult(input.machineId) ?? null),
  }),
  machines: t.router({
    // Registered machines (online flag + last-seen), shown in Settings → Machines and
    // the machine dropdown. Single-machine: just the one 'local' machine. CORE —
    // a node reads its own (and its hub-mirrored) fleet; only ADMITTING and
    // administering machines is the hub's job (hubProc below).
    // The spawn picker's source. Scoped to what THIS principal may see, with
    // its `use` decision attached, so a machine it cannot execute on is never
    // OFFERED (readiness §3.1.4 M5) and one it cannot see is simply absent.
    list: t.procedure.query(({ ctx }) => visibleMachinesFor(mods(ctx), ctx.capability)),
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
    pairingCode: hubProc
      .input(z.object({ copyAgentCredentials: z.boolean().optional() }).optional())
      .mutation(({ ctx, input }) => {
        const code = mods(ctx).machines.mintPairingCode({
          ...(input?.copyAgentCredentials ? { copyAgentCredentials: true } : {}),
        })
        const config = loadConfig()
        const publicUrl = config.publicUrl
        const channel = resolveUpdateChannel(config)
        return {
          code,
          joinCommand: publicUrl ? buildJoinCommand({ publicUrl, pairCode: code, channel }) : null,
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
        // Must stay the literal `process.env.PODIUM_APP_VERSION` read (build-bun --define);
        // the Machines panel compares each daemon's reported version against this. [POD-838]
        appVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
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
          /**
           * The web setup's telemetry answers [spec:SP-f933]. Rides THIS payload so
           * the wizard commits atomically — and because setting a password here
           * closes the /trpc guard, a follow-up telemetry call from the not-yet-
           * logged-in setup page would 401. Absent = not asked (host modes ask;
           * the embedded Settings → Machines reuse of this proc does not).
           */
          telemetry: z
            .object({ usage: z.enum(['on', 'off']), crash: z.enum(['on', 'off']) })
            .optional(),
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
        // After applySetup, so a telemetry write can never be lost to the config
        // round-trip that follows it. Honours the kill switches: an env that says
        // "do not track" wins over an answer the UI should not have collected.
        if (input.telemetry && shouldAskForConsent()) setConsent(input.telemetry)
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
  // Unified agent messaging (#237) [spec:SP-34d7]: the `podium mail` surface.
  //
  // DERIVED (POD-729). Every procedure below is built from its contract in
  // `@podium/commands` — input schema, wire verb and authz all come from the one
  // table, and the hand-written bodies that used to sit here (nine `z.unknown()`
  // procedures wrapping a stringly-typed dispatch) are DELETED. Input validation
  // and authz live in the MessageGate, shared VERBATIM with the daemon relay arm;
  // the gate stamps the sender from ctx.capability, never from payload.
  //
  // ZERO hand-written `.mutation(` in this router is the POD-424 gate criterion,
  // and `router.mail-derivation.test.ts` asserts it against this file's TEXT —
  // an audit that reads the source is the only kind that notices the tenth
  // procedure someone adds by hand next year.
  messages: t.router({
    send: mailMutation('send'),
    // A mutation on the wire, because the recipient's own inbox read CONSUMES
    // queued status. The contract says `write`; the verb follows the contract.
    inbox: mailMutation('inbox'),
    dismiss: mailMutation('dismiss'),
    show: mailQuery('show'),
    // Sender-queryable message lifecycle (#834) [POD-834 §04d]: "what happened to
    // msg X" — mayView-gated in the gate (sender/recipient/admin), a pure read.
    status: mailQuery('status'),
    // The web ledger view (#237) [spec:SP-34d7 web]: per-issue / per-session
    // delivery ledger. Own traffic for a member, cross-user at admin grade.
    ledger: mailQuery('ledger'),
    reply: mailMutation('reply'),
    // Cross-harness subagents (#237) [spec:SP-34d7 cross-harness]: `podium
    // agent spawn/await`. The child is a full Podium session; await is BOUNDED
    // (returns a snapshot, never hangs).
    spawnAgent: mailMutation('spawnAgent'),
    awaitAgent: mailMutation('awaitAgent'),
  }),
  // Git dock panel [POD-114] — read-only checkout inspection for the web
  // RightDock: working-tree status, recent commits, one file's diff. Same
  // repo-root allowlist gate as `files`; each query maps to a fixed lock-free
  // daemon repo op (never a shell string).
  git: t.router({
    status: t.procedure
      .input(z.object({ machineId: z.string().optional(), root: z.string() }))
      .query(({ ctx, input }) => {
        if (!isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return mods(ctx).rpc.repoOp('statusProbe', input.root, undefined, input.machineId)
      }),
    log: t.procedure
      .input(z.object({ machineId: z.string().optional(), root: z.string() }))
      .query(({ ctx, input }) => {
        if (!isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return mods(ctx).rpc.repoOp('logPanel', input.root, undefined, input.machineId)
      }),
    diffFile: t.procedure
      .input(z.object({ machineId: z.string().optional(), root: z.string(), path: z.string() }))
      .query(({ ctx, input }) => {
        if (!isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return mods(ctx).rpc.repoOp('diffFile', input.root, { path: input.path }, input.machineId)
      }),
  }),
  files: t.router({
    read: t.procedure
      .input(
        z.union([
          z.object({ sessionId: z.string(), path: z.string() }),
          z.object({ issueId: z.string(), artifactId: z.string(), path: z.string() }),
          z.object({ machineId: z.string().optional(), root: z.string(), path: z.string() }),
        ]),
      )
      .query(async ({ ctx, input }): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> => {
        // Artifact snapshots ([spec:SP-0fc9] #441) serve from the server-local
        // store — no daemon round-trip, no root allowlist (there is no root),
        // and no baseHash (snapshots are immutable, writes are rejected).
        if ('artifactId' in input) {
          const r = await mods(ctx).issueArtifacts.read(input.issueId, input.artifactId, input.path)
          return r
            ? { ok: true, path: input.path, content: r.bytes.toString('utf8') }
            : { ok: false, path: input.path, error: 'artifact file not found' }
        }
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
  /**
   * THE WORKFLOW SURFACE IS DERIVED (POD-732, the 3.10 cutover).
   *
   * Eighteen hand-written procedures — eleven of them `.mutation(` — are gone.
   * `workflowFamilyProcedures()` builds all of them from `WORKFLOW_CONTRACTS`
   * and `WORKFLOW_QUERIES`, so there is deliberately no procedure written out
   * here, and `scripts/audit-workflow-commands.ts` fails the build if one
   * appears.
   */
  workflows: t.router(workflowFamilyProcedures()),
  // Scheduled automations (#470) [spec:SP-17db]: the cron half of the Automations
  // tab. Operator-only, like the rest of this router — an automation spawns agent
  // sessions, so it is not an agent-reachable surface.
  automations: t.router({
    list: t.procedure.query(({ ctx }) => mods(ctx).automations.list()),
    create: t.procedure
      .input(automationInput)
      .mutation(({ ctx, input }) => mods(ctx).automations.create(input)),
    update: t.procedure
      .input(z.object({ id: z.string().min(1), patch: automationPatch }))
      .mutation(({ ctx, input }) => mods(ctx).automations.update(input.id, input.patch)),
    setEnabled: t.procedure
      .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
      .mutation(({ ctx, input }) => mods(ctx).automations.setEnabled(input.id, input.enabled)),
    remove: t.procedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(({ ctx, input }) => mods(ctx).automations.remove(input.id)),
    runs: t.procedure
      .input(z.object({ automationId: z.string().min(1), limit: z.number().int().optional() }))
      .query(({ ctx, input }) => mods(ctx).automations.runs(input.automationId, input.limit)),
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

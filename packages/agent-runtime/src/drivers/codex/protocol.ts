/**
 * THE PINNED codex app-server WIRE SHAPES (POD-1761 W6; plan §2).
 *
 * ---------------------------------------------------------------------------
 * THE BINARY DESCRIBES ITSELF, SO NOTHING HERE IS TRANSCRIBED FROM A DOCUMENT
 * ---------------------------------------------------------------------------
 *
 * W5 had to read opencode's shapes off a live `GET /doc` and found two of three
 * "repo-unconfirmed" endpoints had MOVED. Codex is a better position and the
 * difference is worth stating, because it changes what the fixtures are FOR:
 * `codex app-server generate-ts --out DIR` and `generate-json-schema --out DIR`
 * make the pinned binary emit its own complete protocol (ts-rs generated). So
 * the METHOD NAMES below are not guesses to be verified — they are copied from
 * what 0.147.0 says about itself, and `__fixtures__/protocol-pins.json` records
 * that every one of them exists there.
 *
 * What the generated bindings CANNOT tell you is behaviour, and that is what the
 * recorded frames in `./__fixtures__` are for. Four facts cost real time to
 * discover and are called out at their definitions below, because they are
 * invisible in the type definitions:
 *
 *   1. Responses OMIT `jsonrpc`. A client validating it rejects every reply.
 *   2. Handshake violations are SILENCE, not errors — and they poison the
 *      connection permanently.
 *   3. `turn/start`'s response lands BEFORE `turn/started`, and a steer in that
 *      window is refused. See {@link CODEX_METHODS}.
 *   4. Server→client request ids start at ZERO.
 *
 * ---------------------------------------------------------------------------
 * WHY ZOD, AND WHY NON-STRICT
 * ---------------------------------------------------------------------------
 *
 * Same argument as the opencode driver's: parsing rather than casting is what
 * makes the version gate mean something, and the objects are deliberately not
 * `.strict()` because Codex adds fields constantly (the live `requestApproval`
 * params carry `availableDecisions`, which the generated bindings for this
 * version do not even list). An ADDED field is not a breaking change; a removed
 * or renamed one is, and a non-strict object still catches those.
 *
 * The notification union is deliberately PARTIAL: 0.147.0 declares 71 server
 * notifications and this driver consumes ten. An arm we do not consume must be
 * IGNORED rather than rejected — {@link parseCodexNotification} returns `null`
 * for it, because a driver that threw on `fuzzyFileSearch/sessionUpdated` would
 * break every time upstream shipped a feature we do not use.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** A codex thread id (UUIDv7). UNBRANDED BY DECISION: this is Codex's identity
 *  for the conversation, not a Podium `SessionId`; the binding relates them. */
export const CodexThreadId = z.string().min(1)
export type CodexThreadId = z.infer<typeof CodexThreadId>

/** A codex turn id (UUIDv7). Carried on every turn-scoped notification and
 *  REQUIRED as a precondition by both `turn/steer` and `turn/interrupt`. */
export const CodexTurnId = z.string().min(1)
export type CodexTurnId = z.infer<typeof CodexTurnId>

/**
 * THE METHOD NAMES THIS DRIVER SPEAKS, pinned against 0.147.0's own bindings.
 *
 * Named as constants rather than written inline at each call site so that the
 * pin test can assert the whole set in one place, and so a rename upstream is a
 * one-line diff instead of a search. The plan warned that "Codex has renamed
 * approval methods before" and offered `sendUserTurn` as a known alternate for
 * `turn/start`: on 0.147.0 `sendUserTurn` does NOT exist and `turn/start` does,
 * so the alternate is recorded here as history rather than carried as a fallback
 * — a client that tried both would be guessing at which server it was talking
 * to, which is what the version gate exists to prevent.
 */
export const CODEX_METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  getAuthStatus: 'getAuthStatus',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadSetName: 'thread/name/set',
  threadFork: 'thread/fork',
  threadRead: 'thread/read',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const

/** Server→client REQUESTS: the approval inversion, and the novel machinery of
 *  this driver. Every one of these must be ANSWERED or the turn parks forever. */
export const CODEX_SERVER_REQUESTS = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  elicitation: 'mcpServer/elicitation/request',
} as const

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

/**
 * One inbound frame.
 *
 * `jsonrpc` IS OPTIONAL, AND THAT IS A MEASUREMENT. Codex 0.147.0 answers
 * `{"id":1,"result":{…}}` with no `jsonrpc` member at all — a client that
 * required it (as JSON-RPC 2.0 says it should) would reject every response the
 * server ever sends. Recorded in `__fixtures__/handshake.json`.
 *
 * The four arms are distinguished exactly as JSON-RPC prescribes: id + method =
 * a REQUEST from the server, id alone = a response, method alone = a
 * notification.
 */
export const CodexFrame = z.object({
  jsonrpc: z.string().optional(),
  /** Number in practice; a string is legal JSON-RPC and costs nothing to accept. */
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
})
export type CodexFrame = z.infer<typeof CodexFrame>

/** A JSON-RPC error answered by the server. A VALUE the driver branches on —
 *  `-32600` with a turn-id precondition message is an expected answer, not a
 *  crash. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    readonly method: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(`codex ${method} → ${code}: ${message}`)
    this.name = 'CodexRpcError'
  }

  /**
   * Did this fail because the turn we named is not the open one?
   *
   * BOTH SHAPES, because the two verbs word it differently and both are real:
   * `turn/steer` into a thread with no running turn answers "no active turn to
   * steer", while `turn/interrupt`/`turn/steer` with a STALE id answers
   * "expected active turn id X but found Y". Both mean the same thing to a
   * caller — the precondition moved — and both are recorded in
   * `__fixtures__/steer-interrupt.json` and `protocol-pins.json`.
   */
  get turnPreconditionFailed(): boolean {
    return (
      this.code === -32600 &&
      (this.message.includes('no active turn') || this.message.includes('expected active turn id'))
    )
  }
}

/** Thrown when a frame is not something this driver can make sense of at all. */
export class CodexProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexProtocolError'
  }
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * `initialize` params.
 *
 * `optOutNotificationMethods` IS THE WATCH-LEVEL KNOB, natively (spec §5). It
 * lives on `capabilities`, takes EXACT method names, and is the reason this
 * driver does not have to filter deltas in user space: at `coarse` the server
 * never sends them. What must never go on this list is anything the coarse
 * observation plane needs — `turn/completed` and `item/completed` above all,
 * since a turn fence that was opted out of is a session that never goes idle.
 * {@link DELTA_NOTIFICATIONS} is the closed set that may be suppressed.
 */
export interface CodexInitializeParams {
  clientInfo: { name: string; title?: string; version: string }
  capabilities: {
    experimentalApi: boolean
    requestAttestation: boolean
    optOutNotificationMethods?: readonly string[]
  }
}

/**
 * The ONLY notifications this driver ever opts out of.
 *
 * A CLOSED LIST, and closed on purpose: `optOutNotificationMethods` takes any
 * method name, so the failure mode of a typo or an over-eager addition is a
 * silently missing lifecycle event rather than an error. Deltas are the only
 * category that is safe to drop, because they are live-only by nature — every
 * fragment they carry is repeated in the `item/completed` that closes the item.
 */
export const DELTA_NOTIFICATIONS = [
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/plan/delta',
] as const

export const CodexInitializeResponse = z.object({
  userAgent: z.string(),
  codexHome: z.string(),
  platformFamily: z.string().optional(),
  platformOs: z.string().optional(),
})
export type CodexInitializeResponse = z.infer<typeof CodexInitializeResponse>

/**
 * `getAuthStatus` → the subscription-auth assertion the acceptance checklist
 * asks for.
 *
 * THE FIELD IS `authMethod`, NOT `auth_mode`. The plan guessed the latter; the
 * live response is `{authMethod:'chatgpt', authToken:null, requiresOpenaiAuth:
 * true}`. `'chatgpt'` is the ChatGPT subscription login stored in
 * `~/.codex/auth.json`; `'apikey'` means an inherited key won, which is exactly
 * the silent substitution the daemon's env stripping exists to prevent.
 */
export const CodexAuthStatus = z.object({
  authMethod: z.string().nullable().optional(),
  requiresOpenaiAuth: z.boolean().optional(),
})
export type CodexAuthStatus = z.infer<typeof CodexAuthStatus>

/** The auth mode that means "riding the ChatGPT subscription". */
export const CHATGPT_AUTH_METHOD = 'chatgpt'

// ---------------------------------------------------------------------------
// Threads and turns
// ---------------------------------------------------------------------------

/** Codex's own thread status. `active` + flags is the ONLY place the protocol
 *  says a session is blocked on a human: `activeFlags: ['waitingOnApproval']`. */
export const CodexThreadStatus = z.union([
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('notLoaded') }),
  z.object({ type: z.literal('systemError') }),
  z.object({ type: z.literal('active'), activeFlags: z.array(z.string()).default([]) }),
])
export type CodexThreadStatus = z.infer<typeof CodexThreadStatus>

/** The flag Codex sets while a server→client approval is outstanding. */
export const WAITING_ON_APPROVAL_FLAG = 'waitingOnApproval'

export const CodexThread = z.object({
  id: CodexThreadId,
  sessionId: z.string().optional(),
  forkedFromId: z.string().nullable().optional(),
  parentThreadId: z.string().nullable().optional(),
  preview: z.string().optional(),
  cwd: z.string().optional(),
  /** The rollout JSONL this thread persists to. Recorded in the binding journal
   *  because it is what makes `export()` byte-faithful for this family. */
  path: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  status: CodexThreadStatus.optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})
export type CodexThread = z.infer<typeof CodexThread>

export const CodexTurnStatus = z.enum(['completed', 'interrupted', 'failed', 'inProgress'])
export type CodexTurnStatus = z.infer<typeof CodexTurnStatus>

export const CodexTurnError = z.object({
  message: z.string(),
  codexErrorInfo: z.unknown().nullable().optional(),
  additionalDetails: z.string().nullable().optional(),
})

export const CodexTurn = z.object({
  id: CodexTurnId,
  items: z.array(z.unknown()).default([]),
  status: CodexTurnStatus,
  error: CodexTurnError.nullable().optional(),
  startedAt: z.number().nullable().optional(),
  completedAt: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
})
export type CodexTurn = z.infer<typeof CodexTurn>

/**
 * One item in a thread — Codex's v2 vocabulary.
 *
 * `type` IS THE DISCRIMINANT and the rest is left `unknown` here on purpose: the
 * union has eighteen arms on 0.147.0 and this driver renders a handful of them.
 * Narrowing happens in `./map.ts`, where each arm's fields are read with the
 * item's kind already known — so an arm nobody maps costs nothing and cannot
 * fail a parse.
 */
export const CodexThreadItem = z
  .object({ type: z.string(), id: z.string() })
  .passthrough()
export type CodexThreadItem = z.infer<typeof CodexThreadItem>

// ---------------------------------------------------------------------------
// Notifications — the ten arms this driver consumes
// ---------------------------------------------------------------------------

const threadScoped = { threadId: CodexThreadId }

export const CodexNotification = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('thread/started'),
    params: z.object({ thread: CodexThread }),
  }),
  z.object({
    method: z.literal('thread/status/changed'),
    params: z.object({ ...threadScoped, status: CodexThreadStatus }),
  }),
  z.object({
    method: z.literal('thread/tokenUsage/updated'),
    params: z.object({
      ...threadScoped,
      turnId: CodexTurnId.optional(),
      tokenUsage: z.object({
        total: z
          .object({
            totalTokens: z.number().optional(),
            inputTokens: z.number().optional(),
            outputTokens: z.number().optional(),
            cachedInputTokens: z.number().optional(),
          })
          .optional(),
        modelContextWindow: z.number().nullable().optional(),
      }),
    }),
  }),
  z.object({
    method: z.literal('turn/started'),
    params: z.object({ ...threadScoped, turn: CodexTurn }),
  }),
  z.object({
    method: z.literal('turn/completed'),
    params: z.object({ ...threadScoped, turn: CodexTurn }),
  }),
  z.object({
    method: z.literal('item/started'),
    params: z.object({
      ...threadScoped,
      turnId: CodexTurnId.optional(),
      item: CodexThreadItem,
      startedAtMs: z.number().optional(),
    }),
  }),
  z.object({
    method: z.literal('item/completed'),
    params: z.object({
      ...threadScoped,
      turnId: CodexTurnId.optional(),
      item: CodexThreadItem,
      completedAtMs: z.number().optional(),
    }),
  }),
  z.object({
    method: z.literal('item/agentMessage/delta'),
    params: z.object({
      ...threadScoped,
      turnId: CodexTurnId.optional(),
      itemId: z.string(),
      delta: z.string(),
    }),
  }),
  z.object({
    /** How an ask CLOSES — including when somebody else answered it. The id is
     *  the JSON-RPC request id of the server→client request. */
    method: z.literal('serverRequest/resolved'),
    params: z.object({
      threadId: CodexThreadId.optional(),
      requestId: z.union([z.number(), z.string()]),
    }),
  }),
  z.object({
    method: z.literal('error'),
    params: z.object({ message: z.string() }).passthrough(),
  }),
])
export type CodexNotification = z.infer<typeof CodexNotification>
export type CodexNotificationMethod = CodexNotification['method']

/** Every notification arm this driver folds. Exported so the fixture test can
 *  assert the union and the pin file agree. */
export const CODEX_NOTIFICATION_METHODS = [
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'serverRequest/resolved',
  'error',
] as const satisfies readonly CodexNotificationMethod[]

/**
 * Parse one notification frame, or `null` for an arm we do not consume.
 *
 * `null` RATHER THAN A THROW is the load-bearing choice. 0.147.0 emits
 * `hook/started`, `mcpServer/startupStatus/updated`, `account/rateLimits/updated`
 * and `deprecationNotice` during an ordinary turn — all observed live, none of
 * them this driver's business. Rejecting them would make every upstream feature
 * addition a driver outage.
 */
export function parseCodexNotification(frame: CodexFrame): CodexNotification | null {
  if (frame.method === undefined || frame.id !== undefined) return null
  const parsed = CodexNotification.safeParse({ method: frame.method, params: frame.params })
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// Server→client requests: the approval inversion
// ---------------------------------------------------------------------------

/**
 * What a command-execution approval asks.
 *
 * `availableDecisions` IS NOT IN THE GENERATED BINDINGS and is present on the
 * wire — recorded in `__fixtures__/approval-command.json`. It matters because it
 * is the ONLY honest source for whether an always-allow is on offer: the live
 * ask above listed `['accept', {acceptWithExecpolicyAmendment:…}, 'cancel']`,
 * with neither `acceptForSession` NOR `decline`. A driver that assumed the full
 * decision enum was always available would offer the user a button whose answer
 * the server rejects. See `permissionAsk` in ./map.ts.
 */
export const CodexCommandApprovalParams = z
  .object({
    threadId: CodexThreadId,
    turnId: CodexTurnId,
    itemId: z.string(),
    startedAtMs: z.number().optional(),
    reason: z.string().nullable().optional(),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    availableDecisions: z.array(z.unknown()).optional(),
  })
  .passthrough()
export type CodexCommandApprovalParams = z.infer<typeof CodexCommandApprovalParams>

export const CodexFileChangeApprovalParams = z
  .object({
    threadId: CodexThreadId,
    turnId: CodexTurnId,
    itemId: z.string(),
    startedAtMs: z.number().optional(),
    reason: z.string().nullable().optional(),
    grantRoot: z.string().nullable().optional(),
    availableDecisions: z.array(z.unknown()).optional(),
  })
  .passthrough()
export type CodexFileChangeApprovalParams = z.infer<typeof CodexFileChangeApprovalParams>

export const CodexPermissionsApprovalParams = z
  .object({
    threadId: CodexThreadId,
    turnId: CodexTurnId,
    itemId: z.string(),
    startedAtMs: z.number().optional(),
    cwd: z.string().optional(),
    reason: z.string().nullable().optional(),
    permissions: z.unknown().optional(),
  })
  .passthrough()
export type CodexPermissionsApprovalParams = z.infer<typeof CodexPermissionsApprovalParams>

/** The decisions this driver can send. `acceptForSession` is the always-allow;
 *  it is only sent when the ask's `availableDecisions` offered it. */
export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

/**
 * Is `decision` one this ask actually offered?
 *
 * The list mixes bare strings with single-key objects
 * (`{acceptWithExecpolicyAmendment:{…}}`), so membership is not `includes`. An
 * ask with NO `availableDecisions` at all is treated as offering the plain
 * decisions — the field is newer than the requests themselves, and refusing to
 * answer an ask that omits it would strand a session on a protocol detail.
 */
export function offersDecision(
  availableDecisions: readonly unknown[] | undefined,
  decision: CodexApprovalDecision,
): boolean {
  if (availableDecisions === undefined) return decision !== 'acceptForSession'
  return availableDecisions.some((entry) => entry === decision)
}

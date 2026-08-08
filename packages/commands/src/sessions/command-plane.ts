/**
 * COMMAND-PLANE SESSION CONTRACTS (POD-381, under POD-312).
 *
 * The session writes that COMMAND A PROCESS — create · resume · kill ·
 * hibernate · resurrect · sendText · resumeAndSend · answerAskUserQuestion ·
 * continue — as contracts: name, input schema, and the ADR 3 facets POD-380
 * landed on `CommandDef` (policy · exposure · offline · redaction) plus ADR 1's
 * conflict class. No handler code and no service imports: contracts are L1,
 * handlers are L3, and the join is the composition root's (POD-311 finding 1).
 *
 * The session-state class is POD-380's, in `session-commands.ts`. `sessions.handoff`
 * is POD-642's and is deliberately absent from both — its multi-leg
 * choreography across two machines earns its own contract.
 *
 * ## What makes this one class
 *
 * Every command here causes EXECUTION on a live daemon, and that single fact
 * decides two facets with nothing left to taste:
 *
 *  - `policy.machineVerb: 'use'`. Spawning, reattaching, typing into a PTY and
 *    killing a process are all the `use` verb (ADR 9 D6 M1) — a code-execution
 *    boundary on someone's hardware with THEIR ssh keys, git identity, dotfiles
 *    and private checkouts, never an ordinary visibility bit (M2). The session's
 *    own owner-or-grant gate still runs; ADR 3 Am1 D15.2 says neither
 *    substitutes for the other, which is why the verb is a second axis on the
 *    policy and not `resource: 'machine'`.
 *  - `offline: 'online-only'` follows from the verb by D18.3 — a queued
 *    execution command is a rights snapshot with a delayed fuse. With ONE
 *    documented exception; see `resumeAndSend`.
 *
 * ## The exception, and why the oracle beat the brief
 *
 * POD-381's brief says the command class is "never offline-enqueued". The
 * client oracle disagrees, and it is tagged must-not-change:
 * `packages/client-core/src/engine/outbox-coverage.oracle.test.ts` pins
 * `sessions.resumeAndSend` INSIDE the covered set and `sessions.sendText`
 * outside it ("live chat must fail fast rather than silently queue").
 *
 * The oracle is also right on the merits rather than merely older. D18.3's
 * hazard is a queued command minting a NEW process on hardware whose grant was
 * revoked — which is a spawn. `resumeAndSend` wakes an EXISTING session and
 * carries a stable `mutationId` the authority dedupes (ADR 3 D11.7); the
 * double-type hazard ADR 2 D11 names is bounded by D10/D11's inequality
 * (14d outbox age + ≥2d skew < 30d receipt retention), not by the delivery
 * class. And flipping it to `direct-only` would poison-drop entries a user
 * authored offline, which D9 invariant 1 forbids. Reported to the coordinator
 * as a brief error rather than resolved silently in either direction.
 */

import {
  AgentKind,
  ConversationIdField,
  IssueIdField,
  ResumeRef,
  SessionIdField,
} from '@podium/model'
import { z } from 'zod'
import type { CommandDef } from '../framework'
import { defineCommands } from '../framework'

/**
 * `mutationId` — the client Outbox stamps a stable one per entry and replays it
 * verbatim. It stays on the contract because it is part of the WIRE, but it is
 * NOT the handler's business: POD-312 makes idempotency framework-owned, and
 * `max(128)` matches the router's shipped bound exactly.
 */
const mutationId = z.string().max(128).optional()

/** Every existing-target lifecycle command takes exactly this. */
const targetInput = z.object({ sessionId: SessionIdField })

/** Both chat sends take exactly this — same bounds the router shipped. */
const sendInput = z.object({
  sessionId: SessionIdField,
  text: z.string().min(1).max(32_768),
  mutationId,
})

/**
 * The harness a session runs, and the durable conversation pointer — THE MODEL'S
 * INSTANCES, imported, not re-declared.
 *
 * Both were local copies here until POD-380's wire regeneration exposed the same
 * defect in its own contracts, and the class is worth naming because a copy is
 * invisible in every gate that would normally catch a schema change: enum
 * membership is compile-time, so a forked `z.enum` with identical members
 * parses, encodes and passes every golden case identically. Only instance
 * identity sees it, which is why `session-command-plane.test.ts` asserts these
 * with `toBe` against `@podium/model` rather than comparing accepted values.
 *
 * It also matters behaviourally here: the router previously validated
 * `sessions.create` with the model's `AgentKind`, so a local copy would have
 * been a silent second definition of what the tRPC surface accepts.
 */
const agentKind = AgentKind
const resumeRef = ResumeRef

/**
 * Every command in this file is an execution request against the session's
 * machine AND a write on the session itself.
 */
const executes: NonNullable<CommandDef['policy']> = {
  resource: 'session',
  scope: 'owner-or-grant',
  action: 'write',
  machineVerb: 'use',
}

/**
 * Spawn-shaped commands have no existing session target; the row gate is the
 * MACHINE's. `scope: 'owner-or-grant'` still names whose the RESULT is — a
 * created session is owned by the delegating human, or inherits its parent
 * issue's owner (ADR 9 D5 A4; readiness §3.1.2's inheritance-on-create item,
 * declared per class and this is the class).
 */
const spawns: NonNullable<CommandDef['policy']> = {
  resource: 'machine',
  scope: 'owner-or-grant',
  action: 'write',
  machineVerb: 'use',
}

/**
 * VISIBILITY CLASS, DECLARED PER CONTRACT (POD-382; ADR 9 D3/D4).
 *
 * Every command here writes SESSION state, which is the `personal` class — private
 * to the session's owner, shareable by grant. That is true even for the two
 * spawn-shaped commands whose `policy.resource` is the MACHINE: the machine is what
 * authorizes the request (`use`, owned compute), the session is what the command
 * writes, and readiness §3.1.4 M2 is the reason those must not be collapsed into
 * one bit. The audit checks the pair (`personal` state gated by a `machine`
 * resource is the declared shape for this whole class), so a command that ever
 * writes owned-compute state has to say so and be reviewed.
 */
const PERSONAL = 'personal' as const

/** The human seams: web + CLI over tRPC, plus the trusted in-process MCP. */
const OPERATOR: CommandDef['exposure'] = ['trpc', 'mcp']

/** Plus the daemon agent relay, for what agents may do to a peer session. */
const AGENT: CommandDef['exposure'] = ['trpc', 'mcp', 'relay', 'cli']

const PLACEMENT_DECISION =
  'Placement fails closed (§3.1.4 M5): an explicit machineId is gated BEFORE prepareSessionTarget, which may clone a repo onto the target — a side effect a denied principal must never cause. The IMPLICIT pick is gated too, by threading the principal’s use decision into MachinesService so agentCapabilityRejection refuses a denied machine in the same branch as an offline one. Unauthorized stays distinguishable from unreachable inside the see set (D18.5); outside it the machine is absent and reads exactly like a never-paired id.'

const createInput = z.object({
  agentKind: agentKind.optional(),
  cwd: z.string(),
  title: z.string().optional(),
  machineId: z.string().optional(),
  issueId: IssueIdField.optional(),
  workflowRevisionId: z.string().optional(),
  /** First user prompt for a fresh session. Argv-capable harnesses (claude/codex/
   *  grok) receive it on the launch command; others seed the composer draft.
   *  Mobile/web spawn must send this — resumeAndSend PTY type-in is not a
   *  substitute for Grok's first turn (POD-549). */
  initialPrompt: z.string().optional(),
  /** uuid-bounded: it feeds durableLabel → the systemd-run scope name. The uuid
   *  check is KEPT and the shared `SessionIdField` is piped in after it (POD-362):
   *  swapping `SessionIdField` for a bare `.brand<'SessionId'>()` here would be
   *  byte-identical and invisible to every fixture, so the shared instance has to
   *  be the one in the chain. */
  sessionId: z.string().uuid().pipe(SessionIdField).optional(),
  draftIssue: z.object({ repoPath: z.string(), issueId: IssueIdField.optional() }).optional(),
  mutationId,
})

const create: CommandDef = {
  input: createInput,
  action: 'write',
  policy: spawns,
  visibility: PERSONAL,
  exposure: OPERATOR,
  offline: 'online-only',
  redaction: { fields: [], note: 'a cwd and a harness name are not secrets' },
  conflict: 'cmd',
  decision: `${PLACEMENT_DECISION} Ownership on create is resolved from the principal, not the transport: an agent-created session is owned by its onBehalfOf HUMAN with the agent as actor (A4), and one spawned under an issue inherits THAT issue's owner and grants — otherwise sharing an issue does not share its work and retiring an agent orphans what it made. The draftIssue vessel resolves the same owner, so the low-friction start path produces an OWNED draft. No relay exposure: agents spawn through messages.spawnAgent, which carries its own budget and parent-scope rules.`,
}

const resumeInput = z.object({
  agentKind,
  cwd: z.string(),
  resume: resumeRef,
  conversationId: ConversationIdField,
  title: z.string().optional(),
  machineId: z.string().optional(),
})

const resume: CommandDef = {
  input: resumeInput,
  action: 'write',
  policy: spawns,
  visibility: PERSONAL,
  exposure: OPERATOR,
  offline: 'online-only',
  redaction: { fields: [] },
  conflict: 'cmd',
  decision: `${PLACEMENT_DECISION} A resume that lands on an EXISTING row keeps that row's original provenance and owner — a resume never rewrites who created a session — so the attribution stamped here is the fresh-spawn fallback only.`,
}

const kill: CommandDef = {
  input: targetInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: OPERATOR,
  offline: 'online-only',
  redaction: { fields: [] },
  conflict: 'cmd',
  decision:
    'Tombstones the row and signals ONLY the owning daemon. Not offline-eligible in either direction: the oracle has no outbox executor for it, and a queued kill would end a process the user has since resumed.',
}

const hibernate: CommandDef = {
  input: targetInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: OPERATOR,
  offline: 'online-only',
  redaction: { fields: [] },
  conflict: 'cmd',
  decision:
    'Refuses with a RETURNED reason rather than a throw (no resume ref, agent working, not running, unknown session) — POD-379 pins all four shapes, and the unknown-session one is what an INVISIBLE session must also produce once visibility is real.',
}

const resurrect: CommandDef = {
  input: targetInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: OPERATOR,
  offline: 'online-only',
  redaction: { fields: [] },
  conflict: 'cmd',
}

const sendText: CommandDef = {
  input: sendInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: AGENT,
  offline: 'online-only',
  redaction: {
    fields: [],
    note: 'the body is user-authored content already durable in the ledger and the transcript; redacting it here would hide it from the receipt that dedupes it',
  },
  conflict: 'cmd',
  decision:
    'DIRECT-ONLY, matching the outbox oracle: live chat must fail fast rather than silently queue. Routes AROUND controller gating on purpose — a chat send is an explicit user act, not a competing keyboard — and this contract does not change that: the gate it adds is `use` on the machine, never the controller. Identity on controllerId and take-control policy stay POD-1081’s.',
}

const resumeAndSend: CommandDef = {
  input: sendInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: AGENT,
  // See the file header: the ONE offline-eligible member of this class.
  offline: 'eligible',
  redaction: { fields: [] },
  conflict: 'cmd',
  decision:
    'OFFLINE-ELIGIBLE, against this issue’s brief and against a literal reading of ADR 3 Am1 D18.3, because the outbox oracle pins it in the covered set as must-not-change. D18.3 argues from a queued command minting a NEW process after a revoked grant — that is a spawn. This wakes an EXISTING session, carries a stable mutationId the authority dedupes (D11.7), and is bounded by D10/D11’s inequality rather than by its delivery class; making it direct-only would poison-drop user-authored work (D9 invariant 1). Escalated to the coordinator as a brief error rather than resolved silently.',
}

/**
 * One answer to one AskUserQuestion question.
 *
 * Claude's native menu always appends an Other entry after the agent-supplied
 * options (agents are told not to include Other themselves). Selecting it is
 * the free-text escape: type Other's digit (1-based `otherIndex` =
 * optionCount+1) to focus the free-text field, then the text, then Enter.
 * `optionIndices` is the existing digit path for listed options.
 *
 * `multiSelect` is the QUESTION's shape rather than the answer's, and it rides
 * along because the menu cannot be driven without it: a multi-select's digits
 * only toggle, so it takes a Tab to move on where a single-select advances
 * itself, and the server cannot tell the two apart from one pick (POD-609).
 */
const answerChoice = z.union([
  z.object({
    optionIndices: z.array(z.number().int().min(1).max(9)).min(1),
    multiSelect: z.boolean().optional(),
  }),
  z.object({
    freeText: z
      .string()
      .regex(/^[^\r\n]*$/, 'Free-text answers must be a single line')
      .trim()
      .min(1)
      .max(4_000),
    /** 1-based index of the native Other entry (= agent option count + 1). */
    otherIndex: z.number().int().min(1).max(9),
    multiSelect: z.boolean().optional(),
  }),
])

/**
 * Answer or skip a live AskUserQuestion menu.
 *
 * - `choices`: one entry per question, in order — either listed-option indices
 *   or free text via the native Other entry.
 * - `skip: true`: Esc, which cancels the whole dialog ("User declined to
 *   answer questions"). Mutually exclusive with `choices`.
 *
 * WHICH HUMAN answered stays unrepresentable on the wire (§3.1.3 A3).
 */
const answerInput = z
  .object({
    sessionId: SessionIdField,
    skip: z.literal(true).optional(),
    choices: z.array(answerChoice).min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.skip === true) {
      if (val.choices !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'skip cannot be combined with choices',
          path: ['choices'],
        })
      }
      return
    }
    if (val.choices === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'choices required unless skip is true',
        path: ['choices'],
      })
    }
  })

const answerAskUserQuestion: CommandDef = {
  input: answerInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: OPERATOR,
  offline: 'online-only',
  redaction: { fields: [] },
  conflict: 'cmd',
  decision:
    'WHICH HUMAN answered is server-authoritative (§3.1.3 A3): the input schema carries no identity field at all, so a payload-supplied answerer is not merely ignored — it is unrepresentable, and D7.1’s "payload identity is inert" holds by construction rather than by a check someone could delete. Typing into a live menu is the `use` verb even though it mutates nothing durable. Free-text rides the native Other entry (digit → text → Enter); skip is Esc — both are still keystrokes into a live PTY, never free text layered on top of an open menu.',
}

const continueSession: CommandDef = {
  input: targetInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: AGENT,
  offline: 'online-only',
  redaction: { fields: [] },
  conflict: 'cmd',
  decision:
    'Types the retry only when the agent phase is errored and the session is live; a parked target refuses, because a dead PTY would swallow it.',
}

/**
 * CLEAN END [spec:SP-9904] — stop the process, free the worktree, keep the branch.
 *
 * MIGRATED BY POD-382 FOR THE OPERATOR PATH ONLY, and the boundary is deliberate.
 * `sessions.stop` had two hand-written implementations that differed in ways
 * nobody chose: the tRPC procedure (no authorization of any kind beyond the
 * cookie, `force` discards a dirty tree, returns its refusal) and a ~50-line relay
 * arm (target taken from the CAPABILITY when no id is given — self-stop — an
 * issue-access gate, an issueless parent/`--outside-scope` rule, and a THROW on
 * refusal). This contract adopts the tRPC one, which is what the router served and
 * what POD-379 pinned for that transport, and adds the machine `use` gate that
 * path never had.
 *
 * The relay arm is therefore NOT exposed here and NOT deleted: its target
 * resolution, its gate and its error shape are three separate pinned behaviours,
 * and folding them in is the rest of POD-381's cutover, not this issue's. Because
 * `exposure` is default-closed and lists `trpc`/`mcp` only, the surviving arm is
 * visible as a residue the session-surface audit counts and names, rather than as
 * an exposure this contract silently claims to cover.
 */
const stopInput = z.object({ sessionId: SessionIdField, force: z.boolean().optional() })

const stop: CommandDef = {
  input: stopInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: OPERATOR,
  offline: 'online-only',
  redaction: { fields: [], note: 'a session id and a force flag are not secrets' },
  conflict: 'cmd',
  decision:
    'Adopts the OPERATOR path (router.ts): `force` discards a dirty tree and a refusal comes back as `{ok:false, reason}` rather than as a throw — both POD-379-pinned for tRPC. The agent/relay arm keeps its self-stop target resolution and its throwing refusal and is left in place, counted as a named residue by scripts/audit-session-commands.ts; it is the remainder of POD-381’s cutover. The `use` gate is NEW on this path: stopping a process is execution on the machine it runs on, and the tRPC route had no machine check at all.',
}

/**
 * PASTE AN IMAGE INTO A PROMPT — the daemon writes it under
 * `~/.podium/uploads/<sessionId>/` on the session's machine and hands back the
 * absolute path, because harnesses read images by path.
 *
 * A WRITE ON SOMEONE'S DISK, so it is the `use` verb and not a read: it is the
 * clearest small case of readiness §3.1.4 M2 — the bytes land on the machine
 * owner's filesystem, with their quota and their backups, and a principal who may
 * see a session on a machine it may not use must not be able to put files there.
 */
const uploadImageInput = z.object({
  sessionId: SessionIdField,
  filename: z.string().max(255),
  mimeType: z.string().max(100),
  /** ~7.5 MB decoded — the router's shipped bound, kept exactly. */
  dataBase64: z.string().max(10 * 1024 * 1024),
})

const uploadImage: CommandDef = {
  input: uploadImageInput,
  action: 'write',
  policy: executes,
  visibility: PERSONAL,
  exposure: ['trpc'],
  offline: 'online-only',
  redaction: {
    fields: ['dataBase64'],
    note: 'THE ONLY REDACTED FIELD IN THE SESSION FAMILY. A pasted screenshot is user content whose bytes must never reach a log line, an error message or a persisted mutation envelope — and at up to 10 MB of base64 it would also be the largest thing this instance ever logged. filename and mimeType stay: a redacted path is unsupportable.',
  },
  conflict: 'cmd',
  decision:
    'trpc ONLY. No relay exposure: an agent already writes files on its own machine directly, so a relayed upload would be a second, weaker way to put bytes on a machine it may not use. Bounds are the router’s verbatim; the daemon-timeout and daemon-error shapes are preserved by the handler (TIMEOUT when no daemon answers, INTERNAL_SERVER_ERROR with the daemon’s message) because POD-379 pins both.',
}

/**
 * `sessions.ask` — THE SEANCE — IS NOT IN THIS TABLE, and the absence is a decision.
 *
 * POD-382 briefly declared it here, because the tRPC procedure was still
 * hand-written and this issue had to delete it. While that work was in flight
 * POD-729 cut the whole agent-mail surface over to `@podium/commands` INCLUDING
 * `ask`, for the reason its own commit gives: `ask` reaches DELIVERY, so leaving it
 * out would have left a live send path no contract governs.
 *
 * Two contracts for one command is a vocabulary fork — the thing this programme
 * exists to end — so the duplicate was deleted rather than reconciled. `ask` is a
 * MESSAGES command, its contract is the mail table's, its schema is that
 * contract's instance, and the sessions router serves it through the mail
 * derivation (`mailMutation('ask')`). The session-surface manifest records it with
 * source `mail`, so the audit still sees it and still refuses a hand-written one.
 *
 * The one thing the merge did NOT carry over: POD-382's contract declared
 * `machineVerb: 'use'`, because a question is delivered at `lifecycle: 'wake'` and
 * waking a parked session starts a process on someone's machine. The mail contract
 * makes no such declaration. Reported to the coordinator rather than resolved here —
 * it is the mail family's call, and adding a gate to another issue's contract during
 * a merge is exactly how a policy change gets made by accident.
 */

/** `sessions.*` — the command plane (POD-381). Presence is POD-380's table. */
export const sessionCommandPlane = defineCommands('sessions', {
  answerAskUserQuestion,
  continue: continueSession,
  create,
  hibernate,
  kill,
  resume,
  resumeAndSend,
  resurrect,
  sendText,
  stop,
  uploadImage,
})

/** Every `sessions.<key>` in the command plane. */
export function commandPlaneNames(): string[] {
  return Object.keys(sessionCommandPlane.defs).map((key) => `sessions.${key}`)
}

/** Look one contract up by its bare def key; undefined when not in this class. */
export function commandPlaneContract(key: string): CommandDef | undefined {
  return (sessionCommandPlane.defs as Record<string, CommandDef>)[key]
}

/**
 * The input schemas, at their PRECISE types.
 *
 * `CommandDef.input` is a widened `ZodTypeAny`, which is right for a
 * heterogeneous table and useless for a tRPC procedure — a router built on the
 * widened field would infer `any` for every client call site. So the schemas are
 * exported here and the defs above reference these same INSTANCES.
 *
 * `session-command-plane.test.ts` asserts that identity with `toBe`, not with a
 * deep-equality check. A field swapped for a fresh `z.object({...})` with the
 * same keys is byte-identical on the wire and passes every value assertion; only
 * instance identity sees the drift.
 */
export const sessionCommandPlaneInputs = {
  answerAskUserQuestion: answerInput,
  continue: targetInput,
  create: createInput,
  hibernate: targetInput,
  kill: targetInput,
  resume: resumeInput,
  resumeAndSend: sendInput,
  resurrect: targetInput,
  sendText: sendInput,
  stop: stopInput,
  uploadImage: uploadImageInput,
} as const

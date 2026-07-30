/**
 * THE FOUR SCHEDULED-AUTOMATION WRITE CONTRACTS (POD-735, the 3.11 cutover) —
 * `automations.create · update · setEnabled · remove`.
 *
 * L1 DATA ONLY. Every handler lives with the automations feature in `apps/server`
 * (`modules/automations/service.ts`, unchanged by this issue) and is joined to its
 * contract at `modules/automations/registry.ts`. The two READS this surface also
 * serves — `list` and `runs` — are deliberately NOT here, the same split the
 * workflow and spec families made: `visibility` classifies what a command WRITES,
 * and a read writes nothing.
 *
 * The cron parser moved here WITH the contracts (`./cron`) rather than being left
 * in `apps/server`. It has to: the composer's guarantee is that an unparseable
 * expression — or one below the one-minute floor — comes back as a BAD_REQUEST it
 * can render rather than a 500, which means the cron validation is part of the
 * INPUT SCHEMA, and an L1 schema may not import an app. It is pure and
 * dependency-free, so the move is a relocation and not a re-specification; there
 * is still exactly one cron parser and `modules/automations/{service,decide}.ts`
 * import it from here.
 *
 * ---------------------------------------------------------------------------
 * THE CLASSIFICATION, WHICH IS THE POINT OF THIS FILE
 * ---------------------------------------------------------------------------
 *
 * `visibility: 'personal'` — READ OFF ADR 1's `automations-and-runs` row, not
 * copied from a neighbour and not arrived at by omission. That distinction matters
 * more here than anywhere else in this fleet, because `personal` is ALSO what ADR 9
 * D4's default-closed backstop answers for a row nobody ever classified:
 * `visibilityClassOf('never-heard-of-it')` returns `personal` too. So a test that
 * only compared the contract to `visibilityClassOf` would pass identically against
 * a matrix with the row DELETED. `contracts.test.ts` therefore binds to the
 * DECLARED row object and asserts the backstop's blindness explicitly rather than
 * leaning on it.
 *
 * The trap POD-351 found and POD-731 restated does not apply: an automation is a
 * first-class entity owned by its creator (ADR 9 D8 S6), not a per-user fact ABOUT
 * a shared entity like `readAt`, a snooze or a pin. `personal` here keys the row to
 * the person who owns the thing, which is what the row says.
 *
 * ---------------------------------------------------------------------------
 * `machineVerb: 'use'` WITH `resource: 'session'` — TWO GATES, NOT ONE
 * ---------------------------------------------------------------------------
 *
 * ARMING AN AUTOMATION IS SCHEDULING CODE EXECUTION ON THE SERVER'S MACHINE. That
 * is the whole of what an automation does: every occurrence mints an issue, spawns
 * an agent session in a working tree (or in the home directory, for the global
 * arm) and delivers a prompt to it. ADR 3 Amendment 1 D18.2 is explicit that `use`
 * is a CODE-EXECUTION boundary, and a member who may not `use` this machine must
 * not be able to launder execution onto it by leaving a cron behind — so the verb
 * is declared here, on the command that arms it, and not only where the scheduler
 * eventually spawns.
 *
 * The ROW gate is a different question and gets a different answer, which is
 * exactly the asymmetry `classificationErrors` records (POD-640's correction: a
 * verb does not imply a `machine` resource, because the resource names the ROW gate
 * and the verb names the EXECUTION gate — `sessions.sendText` is that shape too).
 * D2's closed vocabulary has no `automation` member, and the nearest TRUE member is
 * `session`: an automation is a standing instruction to mint sessions, and every
 * effect it has in the world is a session it spawned. That approximation is written
 * down here rather than hidden, the same way POD-731 wrote down `resource:
 * 'session'` for workflow runs; the real row gate is the automation's owner (ADR 9
 * D8 S6), which the schema cannot yet express because the `automations` table
 * carries NO CREATOR COLUMN — the matrix row names that absence as POD-364 §9.1's
 * inventory gap and it is not this issue's to close.
 *
 * ---------------------------------------------------------------------------
 * `online-only`, AND THE RECONCILIATION ADR 1 FORCES
 * ---------------------------------------------------------------------------
 *
 * ADR 1 §7's row reads "defs offline-eligible; fire needs server clock", and the
 * sibling workflow row reads the same way — POD-731 followed it and classified
 * workflow library CRUD `offline-eligible`. This family does NOT, and the divergence
 * is deliberate rather than an oversight, on three grounds:
 *
 *  1. ADR 3 Amendment 1 D18.3 is a HARD rule of the pack AS AMENDED — a contract
 *     whose policy requires `use` is `online-only` and must not list `outbox`. ADR 1
 *     §7's offline column predates it. A workflow definition is inert text until
 *     someone runs it; an ENABLED automation is not, which is why the same column
 *     produces different answers for the two rows.
 *  2. D18's own rejected-alternatives table names this shape precisely: "a queued
 *     execution command is a rights snapshot with a delayed fuse". An armed
 *     automation IS a delayed fuse — and the pack makes it safe by re-resolving the
 *     creator's rights LIVE at every fire (ADR 9 D8 S6), never by freezing a
 *     capability. Queuing the ARMING command would add a second, unfenced snapshot
 *     in front of the fenced one.
 *  3. Concretely, the one-off arm is not replay-safe. `runAt` is an ABSOLUTE
 *     timestamp and the service refuses one in the past, so a queued create drained
 *     after the moment passed fails with an error its author cannot act on; and the
 *     cron arm re-arms from the drain-time clock, so a replay schedules from an
 *     epoch the author never chose.
 *
 * Recorded per contract in `outboxReconciliation` rather than derived silently: the
 * lint agrees with the reasoning here, it did not supply it.
 *
 * ---------------------------------------------------------------------------
 * OPERATOR-ONLY, AS A DECLARATION
 * ---------------------------------------------------------------------------
 *
 * Automations spawn agent sessions, so the surface is not agent-reachable. Today
 * that is true by OMISSION — `RELAY_ALLOWED` in `modules/issues/relay-gate.ts` has
 * no `automations` key, so the relay refuses — and an omission is not a policy: the
 * day someone adds the key, nothing objects. {@link AutomationCommandContract}
 * makes it a field, `exposure` stays `['trpc']` (the one wired arm), and
 * `automation-cutover.audit.test.ts` drives the REAL relay gate to prove the
 * refusal, with a positive control so a gate that refuses everything cannot pass
 * for one that refuses this.
 */

import { AgentKind, AutomationScheduleKind, AutomationSessionMode } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'
import { isValidCron, respectsScheduleFloor, SCHEDULE_FLOOR_MESSAGE } from './cron'

// ---------------------------------------------------------------------------
// The family's contract shape
// ---------------------------------------------------------------------------

/**
 * A command contract plus the operator-only declaration.
 *
 * `true` is the only member, and that is on purpose: this is not a switch with an
 * agent-reachable setting on its other side. It is a claim that the contract is
 * served to the operator transport ALONE, checked in both directions by the
 * cutover audit — declared here and absent from the relay's allowlist, or absent
 * here and present there, are both findings.
 */
export interface AutomationCommandContract<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown>
  extends CommandContract<In, Out> {
  readonly operatorOnly: true
}

// ---------------------------------------------------------------------------
// Shared input pieces — THE SAME SCHEMA the shipped surface validates with, so
// the cutover is a move and not a re-specification.
// ---------------------------------------------------------------------------

/**
 * The composer's field set (#470) [spec:SP-17db], relocated from `router.ts`
 * byte-for-byte.
 *
 * `repoPath: null` (or absent) = a GLOBAL automation: it runs in the home
 * directory, for cross-repo chores. `targetSessionId` is an unbranded string here
 * exactly as it shipped — the service re-brands it with `asSessionId` after
 * trimming — and widening it to `SessionIdField` would be a re-specification this
 * issue is not allowed to make.
 */
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

/**
 * THE TWO SCHEDULE KINDS, cross-validated — including the one-off wake arm
 * (f3423088), whose four messages are part of the shipped surface and are
 * preserved verbatim.
 *
 * Which arm applies is decided by `scheduleKind ?? 'cron'`, so an omitted
 * `scheduleKind` is a CRON automation and needs an expression. The one-off arm
 * refuses a `cron` field ("not valid for one-off") and demands `runAt`
 * ("required for one-off"); the cron arm is the mirror image. The service
 * re-checks all of it (`validateSchedule`), because a schema is the edge and not
 * the invariant — this is the layer that turns a bad composer submission into a
 * BAD_REQUEST instead of a 500.
 */
export const automationCreateInput = automationFields.superRefine((input, ctx) => {
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

/**
 * The patch shape — every field optional, an absent field meaning "leave it".
 *
 * NO cross-field refinement, as it shipped, and the reason is worth stating
 * because the asymmetry looks like an oversight: a patch is applied ON TOP of the
 * stored row, so `{ cron: '0 9 * * *' }` on a one-off automation is a legal edit
 * whose validity depends on state this schema cannot see. `AutomationsService
 * .validateSchedule` decides it against the merged row, which is the only place
 * the question is answerable.
 */
export const automationPatchInput = automationFields.partial()

/** The id-addressed inputs. `min(1)` and unbranded, as they shipped. */
export const automationUpdateInput = z.object({
  id: z.string().min(1),
  patch: automationPatchInput,
})
export const automationSetEnabledInput = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
})
export const automationRemoveInput = z.object({ id: z.string().min(1) })

// ---------------------------------------------------------------------------
// Shared policy cells, so a repeated rule cannot drift between the four.
// ---------------------------------------------------------------------------

/**
 * The ONE wired arm. `router.ts`'s `automations` slice, which the Automations tab
 * calls directly. NOT `relay` (the agent transport — see the header), NOT `cli`
 * and NOT `mcp`: there is no `podium automation` verb and no automation tool, and
 * ADR 3 D3 serves a transport because a contract NAMES it.
 */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/** ADR 1's `automations-and-runs` row. Read the header before copying this onto
 *  anything — `personal` is also the backstop's answer for an unclassified row,
 *  which is why the test binds to the declared row and not to the lookup. */
const AUTOMATION_VISIBILITY: VisibilityClass = 'personal'

/**
 * ADR 3 D8 / Amendment 1 D16 and ADR 9 D5 A1 + D8 S6 — one rule, one sentence, on
 * all four, because a rule restated four times is four rules by the next issue.
 *
 * The half that is easy to omit is the one this family exists to carry: an
 * automation OUTLIVES the session that created it, so the interesting revocation
 * is not between call and apply, it is between apply and the hundredth fire. The
 * matrix row's recorded consequence — disabling the creator's ACCOUNT must stop
 * the automation — is a LIVE INTERSECTION at every fire and not a stored
 * capability, which is what makes it need no reaper and gives nobody a reaper to
 * forget.
 */
const REAUTHORIZATION =
  'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1): the caller’s own ' +
  'scope intersected with its human’s CURRENT rights, never a capability frozen when the automation ' +
  'was written. AND AT EVERY FIRE, which is the half that matters here — a scheduled automation is ' +
  'DELEGATED like the superagent (ADR 9 D8 S6), so it runs as its creator with that creator’s rights ' +
  'as they stand at the occurrence; disabling that account stops the automation by intersection, with ' +
  'no reaper to write and none to forget. A delegation that no longer resolves denies the write, and ' +
  'the denial is byte-identical to an unknown automation id (Amendment 1 D20.2).'

/**
 * `online-only` for all four. The full argument is in the file header; the
 * concrete replay hazard is restated here because a class is only auditable where
 * a reader will look for it.
 */
const AUTOMATION_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued, DIVERGING FROM ADR 1 §7’s "defs offline-eligible" column DELIBERATELY. ADR 3 ' +
    'Amendment 1 D18.3 is the pack as amended and is hard: a contract whose policy requires the `use` ' +
    'verb is online-only and may not list `outbox`. Arming an automation schedules unattended agent ' +
    'spawns on this machine, which is exactly D18’s rejected "queued execution command is a rights ' +
    'snapshot with a delayed fuse" — the fuse is legitimate here only because ADR 9 D8 S6 re-resolves ' +
    'the creator’s rights LIVE at every fire, and queuing the arming command would put a second, ' +
    'unfenced snapshot in front of the fenced one. Concretely replay-unsafe too: `runAt` is an ' +
    'absolute timestamp the service refuses in the past, so a drained one-off create fails with an ' +
    'error its author cannot act on, and a drained cron create arms from the drain clock rather than ' +
    'the one the author chose. ADR 3 D4 rule 4 also applies to the SPAWN side: the server’s durable ' +
    'outbox (`queueText`, the run’s mutationId) delivers an already-authorized online command to an ' +
    'unreachable agent and is not a client Outbox offline class.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * Reviewed, and the two candidates are NAMED rather than the list being left
 * empty by default.
 *
 * `prompt` is the operator's own instruction text to an agent — private prose,
 * and the one field of an automation whose content is theirs rather than
 * structural. `repoPath` is an absolute filesystem path into their machine, the
 * same shape POD-383 redacted on `superagent.sendTurn`'s focus paths. Neither is a
 * credential; both leak the layout or the intent of a private tree if a log
 * captures them.
 */
const AUTOMATION_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: ['prompt', 'repoPath'],
  outputPaths: ['prompt', 'repoPath'],
  note:
    'No credential, token or machine identity crosses this surface — `agentKind`, `model` and ' +
    '`effort` are selectors, not secrets, and the managed account a spawn may use is resolved ' +
    'server-side and never named here. Redaction-worthy but not secret: `prompt` is the operator’s ' +
    'private instruction prose and `repoPath` is an absolute path into their working tree. Both are ' +
    'echoed back on the row, so the output paths carry the same names as the input ones.',
}

/**
 * ADR 9 D5 A3 / Amendment 1 D17 — attribution is a PAIR, both halves stamped from
 * the transport principal.
 *
 * AND THE HONEST CAVEAT, which is the matrix row's own: `AutomationWire`,
 * `AutomationRunWire` and the `automations` table carry NO CREATOR TODAY (POD-364
 * §9.1's inventory gap), while D8 S6 requires one. This declares what the COMMAND
 * must carry to be authorized and audited; the ABSENCE in the schema is a
 * recorded finding, not something this contract can close. `reservedWireKeys` is
 * what POD-308 should freeze when it does.
 */
const AUTOMATION_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload. The pair is load-bearing for this ' +
    'family and not bookkeeping: ADR 9 D8 S6 runs every occurrence as the CREATING HUMAN, so "who ' +
    'owns this cron" is the question that decides whether it may still fire at all. Folding it into ' +
    '`name` or into the spawned session’s `spawnedBy: automation:<id>` string would answer it with a ' +
    'routing address, which Amendment 1 D17 forbids — and `spawnedBy` names the automation, not the ' +
    'person. THE COLUMN DOES NOT EXIST YET (POD-364 §9.1): this reserves the keys, it does not ' +
    'pretend the row already carries them.',
}

/**
 * Amendment 1 D20.2/D20.3 for the three id-addressed commands: an automation id
 * the caller may not see must fail exactly as an unknown one does.
 *
 * `distinguishesUnauthorizedFromUnreachable: false`, and readiness §3.1.4 M5 does
 * NOT pull the other way here — the carve-out is keyed on the machine being
 * NAMEABLE (POD-640's finding), and no automation command takes a machine
 * argument: every occurrence runs on the server host, so there is no set of
 * machines to probe by reading a refusal. The shipped service throws
 * `unknown automation: <id>` for a missing row and has no ownership arm to
 * distinguish it from yet; when the creator column lands, the not-yours refusal
 * must be made byte-identical to that one rather than a new message.
 */
const TARGETED_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'An automation id the caller may not see fails as `unknown automation: <id>`, identically to one ' +
    'that never existed (Amendment 1 D20.2). M5’s opposite pull does not reach this family: it is ' +
    'keyed on the caller being able to NAME a machine, and these commands carry no machine argument ' +
    '— every occurrence runs on the server host. TODAY the service has only the nonexistent arm, ' +
    'because the row carries no creator to check against (POD-364 §9.1); the obligation this records ' +
    'is that the ownership refusal, when it lands, reuses that message rather than minting a new one.',
}

/** `create` takes no target id — it mints one. Stated so "no id" and "nobody
 *  answered D20" cannot look alike. */
const UNTARGETED_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note:
    'Creates a new automation; the id is minted server-side (`aut_<uuid>`) and nothing caller-supplied ' +
    'names an existing row. `targetSessionId` is caller-supplied but is not this command’s TARGET — ' +
    'it names the session a later occurrence will wake, and its authorization is the spawn-time ' +
    'question the fire path asks, not an existence oracle this command answers.',
}

/**
 * ADR 9 D5 A4. A create mints the automation; the occurrences it later fires mint
 * an issue, a session and a run each, and those are the FIRE path's creations
 * rather than this command's — named here because a reader tracing "what does
 * enabling this cost me" should find them in one place.
 */
const CREATES_AN_AUTOMATION = {
  creates: ['automation'],
  owner: 'on-behalf-of-human',
  visibility: AUTOMATION_VISIBILITY,
  inheritanceOnCreate: 'on-behalf-of-human',
  note:
    'The automation is owned by the human the write is on behalf of — DECLARED, per the matrix row’s ' +
    '`inheritanceOnCreate: on-behalf-of-human`, and not inherited from any parent: a delegated ' +
    'schedule’s ceiling IS its human (ADR 9 D8 S6), the same shape as a superagent thread. Each later ' +
    'OCCURRENCE mints an automation-typed issue, a session and a run row; a run inherits its ' +
    'definition, so all three land on the same human without a second declaration.',
} as const

/** The three that write an EXISTING automation rather than minting one. */
const CREATES_NOTHING = {
  creates: [],
  note: 'Edits, arms/disarms or deletes an automation that already exists; mints no entity and moves no ownership. `remove` also cascades its run rows, which is a delete and not a creation.',
} as const

// ---------------------------------------------------------------------------
// automations.create
// ---------------------------------------------------------------------------

export const automationCreateContract = {
  name: 'automations.create',
  version: 1,
  operatorOnly: true,
  visibility: AUTOMATION_VISIBILITY,
  input: automationCreateInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      'Writing a schedule is a member’s act over their own content, so the role floor is `member` and ' +
      'the rows it may touch are its own (ADR 9 D8 S6: owner = the creating human). The EXECUTION ' +
      'gate is separate and is `machineVerb: "use"` — an enabled automation runs coding agents on ' +
      'this machine unattended, and a member without `use` must not acquire that by leaving a cron ' +
      'behind. `resource: "session"` is D2’s nearest true member for the row gate (there is no ' +
      '`automation` member) and is argued in the file header. No confirmation: a create is additive, ' +
      'reversible by `remove`, and DISABLED unless the composer explicitly enabled it.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: AUTOMATION_DELIVERY,
  redaction: AUTOMATION_REDACTION,
  ownership: CREATES_AN_AUTOMATION,
  attribution: AUTOMATION_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies AutomationCommandContract<typeof automationCreateInput>

// ---------------------------------------------------------------------------
// automations.update
// ---------------------------------------------------------------------------

export const automationUpdateContract = {
  name: 'automations.update',
  version: 1,
  operatorOnly: true,
  visibility: AUTOMATION_VISIBILITY,
  input: automationUpdateInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      '`create`’s gates exactly, on an existing row: the row gate is its owner and the execution gate ' +
      'is machine `use`, because a patch may change the PROMPT and the AGENT an occurrence runs — the ' +
      'edit that most obviously schedules new code — and may re-arm a disabled automation. No ' +
      'confirmation: an edit is not destructive and every schedule change re-arms from now rather ' +
      'than inheriting the old expression’s pending fire.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: AUTOMATION_DELIVERY,
  redaction: AUTOMATION_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: AUTOMATION_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies AutomationCommandContract<typeof automationUpdateInput>

// ---------------------------------------------------------------------------
// automations.setEnabled
// ---------------------------------------------------------------------------

/**
 * THE ARMING COMMAND, and the one whose classification is least optional.
 *
 * It is `update({ enabled })` in the service and could have been left to inherit
 * the update contract's reasoning. It gets its own because the question "may this
 * principal cause unattended execution on this machine" is answered HERE more
 * directly than anywhere else in the family: the whole payload is a boolean that
 * turns the fuse on.
 */
export const automationSetEnabledContract = {
  name: 'automations.setEnabled',
  version: 1,
  operatorOnly: true,
  visibility: AUTOMATION_VISIBILITY,
  input: automationSetEnabledInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      'The arming decision, and the clearest `use` in the family: `enabled: true` is the moment a ' +
      'schedule starts spawning agents on this machine unattended, so the execution gate is the whole ' +
      'content of the command. Still a member’s act over their own row — owning a schedule includes ' +
      'pausing and resuming it — and still no confirmation, because `enabled: false` is the SAFE ' +
      'direction and gating both arms equally would put friction on the stop button.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: AUTOMATION_DELIVERY,
  redaction: {
    ...AUTOMATION_REDACTION,
    inputPaths: [],
    note:
      'The input is an id and a boolean — neither is redaction-worthy. The OUTPUT is the whole ' +
      'automation row, so it carries `prompt` and `repoPath` back and they stay named there.',
  },
  ownership: CREATES_NOTHING,
  attribution: AUTOMATION_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies AutomationCommandContract<typeof automationSetEnabledInput>

// ---------------------------------------------------------------------------
// automations.remove
// ---------------------------------------------------------------------------

export const automationRemoveContract = {
  name: 'automations.remove',
  version: 1,
  operatorOnly: true,
  visibility: AUTOMATION_VISIBILITY,
  input: automationRemoveInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'confirm',
    rationale:
      'The one of the four that is not `confirmation: "none"`. Removal deletes the definition AND ' +
      'cascades every `automation_runs` row with it — the history that makes a quiet night ' +
      'explainable — and the matrix row’s tombstone column calls disable/delete a `cmd`. ADR 3 D2 ' +
      'puts a destructive write behind a confirmation, and `setEnabled(false)` is the non-destructive ' +
      'way to stop a schedule, so the confirmation costs nothing an operator needed. Still `write` ' +
      'and not `manage`: deleting your own schedule is not administering the instance. The execution ' +
      'gate stays declared because it is the same surface — a principal who may not `use` this ' +
      'machine has no business editing what runs on it, in either direction.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: AUTOMATION_DELIVERY,
  redaction: {
    ...AUTOMATION_REDACTION,
    inputPaths: [],
    outputPaths: [],
    note: 'An id in, `{ removed: boolean }` out. Nothing on either side is redaction-worthy, and the answer is deliberately the same for an id that never existed (Amendment 1 D20.2).',
  },
  ownership: CREATES_NOTHING,
  attribution: AUTOMATION_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies AutomationCommandContract<typeof automationRemoveInput>

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * The four WRITES, keyed by the proc name the wire already uses.
 *
 * `list` and `runs` are QUERIES and stay hand-written in `router.ts`: a contract's
 * `visibility` classifies what a command WRITES, and a read writes nothing. That
 * is the same line `modules/workflows/queries.ts` and `SPEC_CONTRACTS` draw, and
 * it is why the cutover audit checks for a hand-written `.mutation(` rather than
 * for an empty router.
 */
export const AUTOMATION_CONTRACTS = {
  create: automationCreateContract,
  update: automationUpdateContract,
  setEnabled: automationSetEnabledContract,
  remove: automationRemoveContract,
} as const

export type AutomationContractName = keyof typeof AUTOMATION_CONTRACTS

/** Sorted, so a table-driven consumer's order does not depend on declaration order. */
export const AUTOMATION_CONTRACT_NAMES = Object.keys(
  AUTOMATION_CONTRACTS,
).sort() as AutomationContractName[]

/** The queries this router also serves. Named here so the cutover audit can assert
 *  the derived surface is TOTAL — "every declared command and query is served, and
 *  nothing else is" needs both halves, and an unlisted query would read as a
 *  procedure nobody declared. */
export const AUTOMATION_QUERY_NAMES = ['list', 'runs'] as const

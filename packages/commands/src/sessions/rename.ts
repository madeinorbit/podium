/**
 * THE `session.rename` CONTRACT AND THE FIRST OPTIMISTIC REDUCER — POD-351.
 *
 * This is the walking skeleton's L1 half: the first contract to travel the whole
 * target path (model → contract → L3 handler joined at the composition root →
 * Authority commit → delta feed → Replica → UI, plus the offline path), and the
 * FIRST reducer ever to go through POD-372's port. POD-372 built the overlay
 * around a port with no implementations; POD-311 populates contracts and reducers
 * broadly. Both consume the shapes below, so the shapes are the deliverable —
 * anything single-operator-shaped that lands here is copied N times in Phase 3.
 *
 * ## Why rename, and why it stopped being a "pure scalar write"
 *
 * It was chosen as the lowest-risk scalar command in the product. It is not one,
 * and the drift refresh on this issue says so: [spec:SP-eb60] makes a HUMAN-set
 * name sovereign over an agent-set one, so the shipped service already REFUSES an
 * agent rename over a user-set name. That makes rename a BETTER skeleton, not a
 * worse one — it exercises POLICY rather than plumbing alone, and the accept /
 * reject-with-reason shape it forces is the same shape apply-time
 * re-authorization needs (ADR 3 D8). A skeleton whose only outcome was "it
 * worked" would have shipped a port with no failure path, and Phase 3 would have
 * copied that omission across every command.
 *
 * ## THE ONE TEMPLATE-LEVEL WARNING FOR POD-311
 *
 * `name` IS SHARED SESSION STATE, NOT PER-USER STATE. It stays a single shared
 * fact under expected-revision / single-writer arbitration. The per-user family —
 * `readAt`, snooze, pins, tab order, preferences, keyed `(userId, entityId)` — is
 * POD-1076's and is NOT modelled on this command (readiness §3.3). Copying this
 * contract for a per-user field would key a personal fact as a shared one and
 * make one user's write visible as another's; the visibility class below says
 * `personal`, and `per-user-state` is a different member for a reason.
 */

import type { z } from 'zod'
import type { CommandContract, OptimisticReducer } from '../contract'
import { sessionStateCommands } from './session-state-commands'

/**
 * The input, COMPOSED FROM THE SHIPPED CONTRACT'S SCHEMA INSTANCE rather than
 * restated.
 *
 * This is the strongest available form of the rule that keeps biting this run:
 * branding and composition are compile-time, so a restatement — `z.object({
 * sessionId: z.string(), name: z.string().max(120), mutationId })` — would be
 * byte-identical on the wire, parse identically, and pass every golden fixture
 * and every differential test. Only asserting the field IS the shared instance
 * (`toBe`) can see the drift. Here the two paths do not merely agree: they cannot
 * disagree, because there is one schema object and both read it.
 *
 * That property is load-bearing for this issue specifically. The shadow
 * comparison is only evidence about the HANDLERS if the two paths are known to be
 * parsing the same input; a divergence in the schemas would show up as a handler
 * divergence and be diagnosed in the wrong place.
 *
 * DIRECTION OF THE DEPENDENCY, and when it inverts: POD-380's table lives in
 * `@podium/protocol` until POD-311 folds it into this package. Until then this
 * file composes THAT instance. When POD-311 inverts it, the assertion in
 * `rename.test.ts` is what will fail if the fold silently forks the schema.
 *
 * THERE IS NO IDENTITY FIELD HERE AND THERE MUST NEVER BE ONE (ADR 3 D7 / ADR 9
 * D1). The principal is `(user, device, capability)` derived from the
 * AUTHENTICATED TRANSPORT ONLY, and reaches the handler as a separate argument. A
 * payload carrying `actor`, `onBehalfOf`, `userId`, `nameSource` or `capability`
 * is stripped by this schema and is inert — `rename.test.ts` asserts the strip
 * against the parsed output rather than trusting the absence of a field.
 */
export const sessionRenameInput = sessionStateCommands.defs.rename.input
export type SessionRenameInput = z.infer<typeof sessionRenameInput>

/**
 * THE WRITER-AUTHORIZATION OUTCOME — accept versus reject-with-reason.
 *
 * The reason this is a discriminated union on the contract rather than a `void`
 * with a thrown error: the refusal is a NORMAL, EXPECTED result of this command,
 * not an exception. The shipped service already models it that way ("refusal is a
 * returned reason, not a throw: the CLI prints it and the agent carries on"), and
 * the port POD-372/POD-311 consume has to carry the same shape or every consumer
 * invents its own.
 *
 * `nameSource` is on the ACCEPT arm because it is the observable proof of the
 * attribution pair: a human-issued rename yields `user`, an agent-delegated one
 * yields `agent`, and neither is readable from the payload. It is an OUTPUT here
 * and an INPUT nowhere — that asymmetry is the unforgeability, stated in the type.
 *
 * NOTE WHAT THE REJECT ARM DOES NOT CARRY: no owner, no grant list, no principal,
 * and no distinction between "you may not" and "it is not there". Those are the
 * §3.1.5 existence-oracle leak, and `errorConsistency` below closes it.
 */
export type SessionRenameOutcome =
  | { readonly ok: true; readonly name: string; readonly nameSource: 'user' | 'agent' }
  | { readonly ok: false; readonly reason: string; readonly name?: string }

/**
 * The reject reasons, as one exported table.
 *
 * They are constants and not inline strings because the shadow comparison
 * compares the legacy path's reason against the target path's, and a reason
 * assembled twice is a reason that drifts once. The two long ones reproduce the
 * shipped service's wording EXACTLY — they are user-visible strings the CLI
 * already prints, so this migration must not quietly reword them.
 */
export const RENAME_REJECTIONS = {
  namedByUser: (currentName: string): string =>
    `this session was named by the user ("${currentName}") — an agent cannot rename it`,
  empty: 'title is empty',
  /**
   * UNREACHABLE THROUGH THIS CONTRACT, and that is measured rather than assumed:
   * the input schema caps `name` at 120 and `MAX_AGENT_TITLE_LENGTH` is also 120,
   * so a value that parses cannot exceed the cap after a trim-and-collapse that
   * can only shorten it. It is kept — and exported — because the shipped service
   * still produces it for the OTHER entry point into the same field
   * (`sessions.title`, the agent CLI path, which does not parse this schema), and
   * deleting it here would fork the wording the day POD-311 migrates that command.
   *
   * The reducer therefore has NO branch for it, deliberately. A branch for an
   * unreachable case is a branch no test can kill, and `rename.test.ts` pins the
   * boundary (a 120-character name accepts on BOTH paths) instead of pretending
   * the case exists.
   */
  tooLong: (max: number): string =>
    `title exceeds ${max} characters — a session title is 3–5 words`,
} as const

/**
 * What the reducer needs off the authoritative row. Structural, and deliberately
 * NARROW: the reducer must be unable to read anything but the two fields the
 * arbitration turns on, so a later edit cannot reach an owner or a grant through
 * a wider type.
 */
interface RenameBase {
  readonly name?: string
  readonly nameSource?: 'user' | 'agent'
}

/**
 * The actor half of the authored attribution, by KIND only — never an id.
 *
 * The kinds are `ActorRef`'s (`packages/model/src/fields/attribution.ts`), which
 * is why the agent arm is `'agent'` and not `'agent-session'`: POD-1148 made the
 * Outbox's pair a narrowing of that one field schema instead of a second union,
 * and this reducer reads what the Outbox actually stored. It cannot IMPORT the
 * type — the reducer is handed `authored` as `unknown` on purpose, and the
 * direction lint keeps the Replica out of the Outbox module — so the coupling is
 * a string literal, and `rename.test.ts` builds its fixtures with the model's
 * `actorAgent` / `actorUser` constructors rather than with another hand-written
 * literal, so a rename of the arm reddens the test instead of passing quietly.
 */
type AuthoredKind = 'user' | 'agent' | undefined

const authoredKind = (authored: unknown): AuthoredKind => {
  const actor = (authored as { actor?: { kind?: unknown } } | undefined)?.actor
  return actor?.kind === 'agent' ? 'agent' : actor?.kind === 'user' ? 'user' : undefined
}

/**
 * THE FIRST OPTIMISTIC REDUCER (ADR 3 D6, POD-372's port).
 *
 * It answers exactly one question: what would this command do to this row? It is
 * a pure function of (base, command, authored) and it consults no principal, no
 * grant and no capability, because it is handed none.
 *
 * ## The three answers, and why the third one exists
 *
 *  - ACCEPT → `{ kind: 'value' }` with the projected row, including the
 *    `nameSource` the write will stamp. The client can derive this because the
 *    arbitration inputs are all on the row it already holds.
 *  - PREDICTED REFUSAL → `{ kind: 'rejected', reason }`, when an AGENT-authored
 *    rename lands on a row whose `nameSource` is `user`. This is the member
 *    POD-351 added to the port; without a real caller it would have been
 *    mechanism presence rather than coverage.
 *  - UNKNOWN → never. Every input to the decision is on the row, so this reducer
 *    has no `no-reducer` branch, and that is a fact about rename and not a
 *    template. POD-311: a command whose effect depends on server-side state the
 *    client does not hold MUST return `no-reducer` and show pending. Guessing is
 *    how an optimistic render becomes a lie.
 *
 * ## Why an agent gets a prediction at all when agents do not run a web replica
 *
 * Because the port is the product here, not this one call site. POD-311 populates
 * reducers for commands whose clients DO include delegated agents, and POD-372's
 * overlay is the surface a rejected write must reach. Wiring the arbitration on
 * the one command that already has it is what proves the path carries a refusal
 * end to end instead of dropping it.
 *
 * ## It predicts; it does not decide
 *
 * A prediction never removes the command from the outbox. The authority
 * re-authorizes live at every apply including replay (ADR 3 D8), and a concurrent
 * `name = ''` clears `nameSource` and makes a predicted-refused rename perfectly
 * applicable by the time it drains. A reducer that dropped the write would be the
 * Replica arbitrating, which ADR 1 D1 forbids.
 */
export const sessionRenameReducer: OptimisticReducer<SessionRenameInput> = ({
  input,
  local,
  authored,
}) => {
  const base = (local ?? undefined) as RenameBase | undefined
  const byAgent = authoredKind(authored) === 'agent'

  if (byAgent) {
    const norm = input.name.trim().replace(/\s+/g, ' ')
    // The agent path normalises and refuses, exactly as the service does. These
    // three branches are the arbitration; they read `base.nameSource` and nothing
    // about who is asking.
    if (!norm) return { kind: 'rejected', reason: RENAME_REJECTIONS.empty }
    if (base?.nameSource === 'user') {
      return { kind: 'rejected', reason: RENAME_REJECTIONS.namedByUser(base.name ?? '') }
    }
    return { kind: 'value', value: { ...(base ?? {}), name: norm, nameSource: 'agent' } }
  }

  // The human path: trim only, and clearing the name clears the source — an
  // unnamed session becomes namable by an agent again. A human rename is never
  // refused by the arbitration, because the arbitration exists to protect it.
  const clean = input.name.trim()
  return {
    kind: 'value',
    value: {
      ...(base ?? {}),
      name: clean,
      ...(clean ? { nameSource: 'user' } : { nameSource: undefined }),
    },
  }
}

/**
 * THE CONTRACT. Every facet is required, including the ones whose answer is
 * "none" — optionality is how a column silently stops being filled in.
 */
export const sessionRenameContract: CommandContract<
  typeof sessionRenameInput,
  SessionRenameOutcome
> = {
  name: 'sessions.rename',
  // PERSONAL (ADR 9 D3) — private to its owner, shareable by grant. What this
  // command writes is a session's curated `name`, which is SHARED session state
  // under single-writer arbitration.
  //
  // Explicitly NOT `per-user-state`, and the distinction is the one warning this
  // contract carries for POD-311: `readAt`, snooze, pins, tab order and preferences
  // are keyed (userId, entityId), never shared and non-grantable — POD-1076's
  // family. Copying this contract for one of those would key a personal fact as a
  // shared one and make one user's write visible as another's.
  visibility: 'personal',
  version: 1,
  input: sessionRenameInput,
  policy: {
    action: 'write',
    // A MEMBER renames their own session. An `admin` floor would be the
    // instance-wide-role mistake Amendment 1 D15 replaces: the row gate decides
    // WHICH sessions, and the account grade decides only what may be attempted.
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      'A session is PERSONAL (ADR 9 D3): private to its owner, shareable by grant. So authorization is owner/grant-aware and not role-only — a member with neither ownership of nor a grant on the session is refused at apply, and an unowned session fails CLOSED rather than reading as ambient (readiness §3.1.1 default-closed, §3.1.4 M4). confirmation is `none` because a rename crosses no scope boundary: `--outside-scope` confirms leaving an ISSUE subtree (ADR 3 D2), and reusing it here would turn a deliberate widening step into a general escalation.',
  },
  // DEFAULT-CLOSED. `trpc` is the web rename; `outbox` is the offline path this
  // issue exists to prove, and D3 rule 2 permits it only because the delivery
  // class below is offline-eligible.
  //
  // `relay` is deliberately ABSENT, and its absence is a decision rather than an
  // omission: POD-379 pins that the session-state writes have no agent path today. An
  // agent renames through `sessions.title`, which is a different command with its
  // own contract. Adding `relay` here would give every delegated agent a second,
  // unaudited route to the same field.
  exposure: ['trpc', 'outbox'],
  delivery: {
    class: 'offline-eligible',
    outboxReconciliation:
      "Enqueued in the client Outbox, matching POD-379's outbox oracle, which tags rename as one of the seven covered writes and pins that set as must-not-change. This is a CLIENT outbox and not the server's agent queue: ADR 3 D4 rule 4 keeps those two durabilities distinct, and rename never touches the second. The entry carries the attribution pair and NO capability (ADR 3 D8 / Amendment 1 D16) — `OutboxRecord` has nowhere to put one, which is what makes the no-snapshot rule structural here rather than remembered.",
    applyTimeReauthorization:
      "Re-authorized LIVE on every apply, including every outbox drain and every replay, by resolving the delegation chain rather than reading a snapshot: an agent's effective rights are its own scope INTERSECTED with its delegating human's CURRENT rights (readiness §3.1.3 A1, ADR 3 D8). The offline case is the one that bites and is the case this issue proves: a rename queued while online, whose principal then loses access to the session (or whose delegating human is revoked), is REFUSED at drain and never applied. The refusal is SURFACED to the user as a dead-lettered entry with a recovery plan (POD-316's reject-and-rebase, which readiness §3.3 makes a routine path under multi-user), never swallowed. Authorization runs BEFORE idempotency so a replay whose grant was revoked is refused rather than served from the dedup cache.",
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'Nothing sensitive in either direction. A session name is a label its owner chose to display, and the reject reason quotes only that same name back — a string the principal was already authorized to read, since the refusal is only reachable once the owner/grant check has passed. A principal who may not see the session gets the not-found no-op instead and learns nothing, including not the name.',
  },
  ownership: {
    // Rename MUTATES a session; it creates nothing. Written, not left off.
    creates: [],
    note: "Creates nothing, and changes no owner: renaming is a field write on an existing personal entity, so the session keeps its owner (its on-behalf-of human, ADR 9 D5 A4) and mints no identity. Note for POD-311: `name` is SHARED session state, not per-user state — it stays one fact under single-writer arbitration. The per-user family (readAt, snooze, pins, tab order, preferences) is POD-1076's, keyed (userId, entityId), and must NOT be modelled on this contract.",
  },
  attribution: {
    actor: 'from-capability',
    onBehalfOf: 'from-delegation',
    wirePlacement: 'separate-field',
    // The pair rides its OWN wire keys, distinct from any routing address. Frozen
    // here because a wire shape is cheap before the POD-308 cutover and expensive
    // after it, and because the Outbox already persists exactly this pair.
    reservedWireKeys: ['actor', 'onBehalfOf'],
    rationale:
      'ON THE WIRE, unlike sessions.handoff, because this pair has a downstream reader: the optimistic overlay needs the authored actor KIND to derive [spec:SP-eb60]\'s arbitration for a queued write, and an outbox entry that crossed a reload has no other source for it. Both halves are stamped from the authenticated transport and are inert in the payload (ADR 3 D7, Amendment 1 D17). The two are never collapsed: "which agent did this" and "which human was it for" are separate questions, and `nameSource` is the shipped feature that depends on the answer — a human-issued rename stamps `user`, an agent-delegated one stamps `agent` with the same human as on-behalf-of.',
  },
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    // M5's carve-out is for machine PLACEMENT, where unreachable must stay
    // distinguishable from unauthorized. Rename places no work on compute, so the
    // general D20.2 rule applies with no exception.
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'Renaming a session that is INVISIBLE to the principal fails IDENTICALLY to renaming a nonexistent id — both are the same silent no-op, produced by ONE code path rather than two branches a later edit could pull apart (the target resolver returns undefined for both, and the envelope treats absent-target and denied as the same answer). Divergent errors here would make the command an existence oracle: a caller could enumerate other people\'s session ids by watching which renames threw differently. This is readiness §3.1.5\'s rule arriving at a concrete site, and it is why this command does not throw a "forbidden" the way an issue command does.',
  },
  optimisticReducer: sessionRenameReducer,
  cli: { summary: 'Rename a session (the curated name slot).' },
}

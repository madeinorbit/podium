/**
 * THE `sessions.handoff` CONTRACT — POD-642 (3.2e), ADR 3 D1.
 *
 * Pure data and pure schemas. The handler is
 * `apps/server/src/modules/sessions/handoff/coordinator.ts`, joined at the
 * composition root: handlers need L3 services, so co-locating one here would make
 * an L1 package depend on L3 (POD-311's finding 1).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE REST OF THE SESSION COMMANDS.
 * `sessions.handoff` is the only session command that touches TWO machines and
 * moves a live agent between them, and every facet below is decided by that fact
 * rather than by the session it moves. POD-380 owns the presence table and POD-381
 * the rest of the command plane (both in `@podium/protocol` until POD-311 folds
 * that table into this package); this one is its own file by agreement with both,
 * so three authors never edit the same lines.
 *
 * WHAT IT IS AUTHORITATIVE FOR, and what it deliberately is not: this is the
 * DECLARATION. The enforcement lives in the handler and is tested there —
 * `oracle-handoff.test.ts` refuses on both machines, re-authorizes at two apply
 * points, and single-flights duplicate dispatch. A contract that declared
 * `machineVerb: 'use'` with nothing asserting it would be exactly the
 * mechanism-presence-is-not-coverage failure the review protocol names.
 */

import { HandoffManifestV1, SessionIdentity, SessionPlacement } from '@podium/model'
import { z } from 'zod'
import type { CommandContract } from '../contract'

/**
 * WHICH session, onto WHICH machine — and nothing else.
 *
 * Both fields are the SHARED schema INSTANCES, not fresh `z.string()`s. That
 * matters more than it looks: composition is compile-time (branding), so a
 * restatement is byte-identical on the wire and invisible to every golden fixture
 * — only asserting the field IS the shared instance sees it, which `handoff.test.ts`
 * does with `toBe`.
 *
 * `machineId` is `.unwrap()`ed because `SessionPlacement` has it optional (a
 * session may run wherever the server does) while a handoff without a target is
 * not a handoff. Same tightening idiom, and the same reasoning, as the three on
 * the handoff manifest.
 *
 * THERE IS NO IDENTITY FIELD HERE AND THERE MUST NEVER BE ONE (ADR 3 D7). The
 * principal comes from the authenticated transport and reaches the handler as a
 * separate argument; a forged `actor` / `onBehalfOf` / `capability` in this input
 * is stripped by this schema and is inert, which the oracle asserts against the
 * durable attribution record.
 */
export const sessionHandoffInput = z.object({
  sessionId: SessionIdentity.shape.sessionId,
  machineId: SessionPlacement.shape.machineId.unwrap(),
})
export type SessionHandoffInput = z.infer<typeof sessionHandoffInput>

/** Where the session lives now. `newCwd` is the worktree the import resolved on
 *  the target — a per-machine fact, and the one thing no caller can compute. */
export const sessionHandoffOutput = z.object({
  ok: z.literal(true),
  newCwd: z.string(),
})
export type SessionHandoffOutput = z.infer<typeof sessionHandoffOutput>

/**
 * The exportable harness kinds, from the manifest that owns the list rather than
 * restated. Not part of the input — a handoff names a session, not a harness — but
 * exported because the contract's own test asserts the refusal the handler owes an
 * unexportable session, and a second copy of the pair is how the two drift.
 */
export const EXPORTABLE_HARNESSES = HandoffManifestV1.shape.agentKind.options

export const sessionHandoffContract: CommandContract<
  typeof sessionHandoffInput,
  SessionHandoffOutput
> = {
  name: 'sessions.handoff',
  version: 1,
  input: sessionHandoffInput,
  // PERSONAL — the class of what this command WRITES, which is a session's
  // placement. Not `owned-compute`, even though `policy.resource` below is the
  // machine: the two fields answer different questions, and conflating them was a
  // mistake POD-382 made and reverted. What authorizes a handoff is compute
  // ownership at both endpoints (`machineVerb: 'use'`, a code-execution boundary —
  // readiness §3.1.4 M2); what it writes is the moved session, whose owner does not
  // change and whose visibility is its owner's. Declaring `owned-compute` here would
  // say a handoff writes machine state, which it does not.
  visibility: 'personal',
  policy: {
    action: 'write',
    // A MEMBER may hand off, not only an admin: moving your own session between
    // machines you may use is ordinary work, and the row gate below is what
    // decides WHICH machines those are. An `admin` floor here would be the
    // instance-wide-role mistake Amendment 1 D15 exists to end.
    roleFloor: 'member',
    // THE RESOURCE IS THE MACHINE, not the session. The session is what moves; what
    // authorization turns on is compute ownership at BOTH endpoints.
    resource: 'machine',
    confirmation: 'none',
    // `use`, and this command is the reason the verb exists. It is a
    // CODE-EXECUTION boundary, not a privacy one: landing a live agent on someone's
    // machine is arbitrary execution on their hardware with their SSH keys, git
    // identity, dotfiles, cloud CLI sessions and checked-out private repos
    // (readiness §3.1.4 M2). Declared once here; the handler asserts it on the
    // source, on the target, and again at each apply point.
    machineVerb: 'use',
    rationale:
      'Handoff is a `use` operation on the SOURCE (may I take this session off here?) and on the TARGET (may I run it there?), so its resource is `machine` even though its subject is a session. roleFloor is `member` because the row gate, not the account grade, decides which machines are reachable — an admin floor would re-introduce the instance-wide role D15 replaces. confirmation `none` because the grant IS the confirmation: `use` is owner-only until explicitly given, and a second prompt would suggest the grant was the weaker of the two checks.',
  },
  // DEFAULT-CLOSED, and `trpc` is not a placeholder: the web session menu is the
  // only surface that serves handoff today. No CLI verb and no MCP tool — and
  // deliberately NOT `relay`, because an agent asking to move itself onto another
  // person's machine is precisely the request that should need a human's grant
  // first, and `relay` would let it ask on its own authority.
  exposure: ['trpc'],
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never enqueued. ADR 3 Amendment 1 D18.3 makes online-only the only sound class for a machineVerb:use command, and handoff has no resumeAndSend-style exception: a replayed handoff would export a session from a machine it no longer lives on, and the multi-leg exchange (export, chunked read, chunked import, import, resume) needs two LIVE daemons for its four request/result pairs. It is therefore absent from `exposure`, which D3 rule 2 would refuse anyway.',
    applyTimeReauthorization:
      'Re-authorized TWICE inside one dispatch, not once at the edge. The pre-flight can take minutes (ensureTargetRepo may clone the repository) and the package then crosses the network in chunks, so both machines are re-checked immediately before the irreversible kill and the target again immediately before the import leg — the act that lands code on the target. A grant revoked mid-transfer is refused AT APPLY and rolls back to the source, with the source resurrected; the caller is told the refusal, not a success. This is ADR 3 D8 / Amendment 1 D16 on a command whose applies are minutes apart.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'Two caller-supplied ids in, one target-side worktree path out. Nothing sensitive: the bundle, its stage path and its manifest never cross this boundary — they move daemon-to-daemon through the handler. `newCwd` is a path on a machine the caller was just authorized to use, so it discloses nothing the grant did not.',
  },
  ownership: {
    // A handoff MOVES a session; it creates no entity. The absence is written
    // rather than left off, which is the whole point of the field being required.
    creates: [],
    note: "Creates nothing. A machine change is not an ownership change: the session keeps its owner (its on-behalf-of human, ADR 9 D5 A4) and no identity or token is minted for the transfer — the agent principal's lifecycle is its SessionBinding (POD-323/POD-644), which is exactly why delegation survives the move for free. The handler's oracle asserts this BY ABSENCE, over a diff of the whole persisted row, so a field the transfer starts writing has to be justified rather than merely noticed.",
  },
  attribution: {
    actor: 'from-capability',
    onBehalfOf: 'from-delegation',
    wirePlacement: 'not-on-the-wire',
    reservedWireKeys: [],
    rationale:
      'Recorded durably (a `session.handoff` event carrying actor, actorKind and onBehalfOf) rather than on the wire: nothing downstream of the command needs the pair in a frame, and a wire key nobody reads is a shape POD-308 would have to freeze for nothing. The pair is read off the transport capability through the shared `capabilityAttribution`, plus the actor KIND — because that helper collapses actorSessionId and actorUser into one slot, and "did a person or an agent move this session?" has to stay answerable (Amendment 1 D17).',
  },
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    // THE CARVE-OUT, and it is the one the framework's lint checks for: M5 needs
    // unauthorized to stay distinguishable from unreachable, while D20.2 needs
    // invisible to be indistinguishable from nonexistent. Both hold here because
    // `unauthorized` is only reachable INSIDE the see set.
    distinguishesUnauthorizedFromUnreachable: true,
    note: "Two caller-supplied ids and therefore two oracles to close. A sessionId that is absent or invisible throws this command's pinned `unknown session` — handoff is the one session write whose not-found path is a throw rather than `session not found`, pinned by POD-379, so the shared resolver's `absent` outcome maps onto it. A machineId that is invisible or never paired answers identically (`unknown machine '<id>'`), so the path cannot enumerate a colleague's fleet; a machine the principal CAN see but may not use says so, and one it may use but that is offline says `target machine is offline`. Denied, unreachable and nonexistent are three answers and only two of them may be told apart.",
  },
  cli: { summary: 'Move a resumable worktree session to another machine' },
  conflict: 'cmd',
  conflictRule:
    'ROW.handoffBundle declared rule: the transfer is one Authority commit that moves placement and retires the source, and a handoff of a session already mid-handoff is refused rather than interleaved',
}

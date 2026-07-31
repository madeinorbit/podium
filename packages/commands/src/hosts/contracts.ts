/**
 * THE ONE HOST-METRICS COMMAND — `hosts.memoryBreakdown`.
 *
 * "Who owns the used memory right now" for the Machines panel: the server derives
 * the roots (the target machine's registered repos plus their worktrees, which
 * often live OUTSIDE the repo path as siblings) and asks that machine's daemon to
 * walk them.
 *
 * ---------------------------------------------------------------------------
 * IT IS A MUTATION ON THE WIRE AND IT WRITES NOTHING — WHY THAT IS NOT A HIDDEN
 * WRITE, AND WHY IT STAYS A MUTATION ANYWAY
 * ---------------------------------------------------------------------------
 *
 * The audits in this phase check procedure TYPE precisely so that a write cannot
 * hide among reads by being called a query. This command is the mirror image and
 * deserves the same scrutiny in reverse: it is spelled `.mutation(`, it returns a
 * breakdown, and it persists nothing.
 *
 * It stays a mutation, for two reasons that are about honesty rather than
 * convenience. First, changing the verb would change the wire and break the
 * shipped web client, and a router cutover graded as behaviour-preserving may not
 * do that. Second, and more importantly, the verb is not wrong: this command
 * PLACES WORK ON SOMEONE ELSE'S HARDWARE — a `/proc` walk over derived roots on
 * the target machine's daemon — which is a code-execution boundary (readiness
 * §3.1.4 M2), not a read of server-held state. `machineVerb: 'use'` is the field
 * that says so, and it is why the command carries the same execution
 * classification as a spec write despite storing nothing.
 *
 * CLASSIFICATION: `owned-compute`, from ADR 1's `hostMetrics` row, which declares
 * exactly that (`visibility: 'owned-compute'`, `offline: 'observe-only'`). The
 * state it concerns is a machine's live memory, and ADR 9 D3 rule 3 scopes facts
 * about a machine to the machine.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

/** `trpc` alone — the Machines panel is the only caller. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/**
 * `machineId` absent means the server's own host, kept exactly as shipped. The
 * whole input is optional for the same reason: the procedure's `.input(…)` was
 * `.optional()`, and tightening it would refuse calls the current web client
 * makes.
 */
export const hostsMemoryBreakdownInput = z.object({ machineId: z.string().optional() }).optional()

export const hostsMemoryBreakdownContract = {
  name: 'hosts.memoryBreakdown',
  version: 1,
  visibility: 'owned-compute',
  input: hostsMemoryBreakdownInput,
  policy: {
    action: 'read',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'none',
    rationale:
      'ACTION `read` ON A WIRE MUTATION, and the mismatch is deliberate rather than an oversight. ' +
      'ADR 3 D2’s action grades WHAT THE COMMAND DOES TO STATE, and this one derives roots and asks ' +
      'a daemon to measure them — it stores nothing, changes nothing, and a second call returns a ' +
      'fresh answer rather than compounding the first. Grading it `write` to match the verb would ' +
      'put a diagnostic behind the same gate as a file write and would misreport this surface to ' +
      'every audit that reads the action column. The verb stays `mutation` because it is the shipped ' +
      'wire and because the command genuinely places work on owned compute; the two columns ' +
      'disagree honestly rather than one of them lying. `resource: machine` with `machineVerb: use` ' +
      'is where the real gate lives: a `/proc` walk is code execution on someone’s hardware ' +
      '(readiness §3.1.4 M2), which is exactly what `use` names — and NOT `see`, because reading a ' +
      'machine’s existence in a list is a weaker act than running a walk across its filesystem.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'NEVER queued, and the matrix row agrees independently (`offline: "observe-only"`). ADR 3 ' +
      'Amendment 1 D18.3 forbids queuing a command that executes on owned compute, and the reading ' +
      'is unusually clear here: a memory breakdown replayed after a drain window measures a moment ' +
      'nobody asked about. A dropped sample is the correct outcome, not a lost write.',
    applyTimeReauthorization:
      'Re-authorized live at apply against the delegation resolved at that moment (ADR 9 D5 A1), ' +
      'never a frozen capability. Losing `use` on the target machine between call and answer denies ' +
      'the walk — the grant is consulted per call rather than cached.',
  } satisfies DeliveryPolicy,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'THE OUTPUT IS THE SENSITIVE HALF and was reviewed as such: a memory breakdown names PROCESSES ' +
      'and the filesystem ROOTS they were attributed to, which together describe what a colleague is ' +
      'running and where their code lives. It is deliberately not redacted because it is the entire ' +
      'product of the command — a redacted breakdown shows nothing — and because reaching it ' +
      'requires `use` on the machine, which is a strictly stronger grant than seeing the machine ' +
      'exists. The protection is the gate, not the projection. Roots are derived SERVER-SIDE from ' +
      'the target machine’s own registered repos rather than taken from the caller, so this command ' +
      'cannot be pointed at an arbitrary path to probe it.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: [],
    note: 'Measures; stores nothing. Mints no entity and moves no ownership.',
  },
  attribution: {
    actor: 'from-capability',
    onBehalfOf: 'from-delegation',
    wirePlacement: 'separate-field',
    reservedWireKeys: ['actor', 'onBehalfOf'],
    rationale:
      'A PAIR EVEN THOUGH NOTHING DURABLE IS WRITTEN, unlike `perf` and `models` next door, and the ' +
      'difference is the machine. This command runs code on hardware someone owns, so who asked is ' +
      'an accountability fact regardless of whether a row records it — the grant it is checked ' +
      'against is per-principal, and a machine grant checked against an unstamped actor is not ' +
      'checked at all. `machineId` is a routing address and D17 forbids it doubling as the record.',
  } satisfies AttributionPolicy,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: true,
    note:
      'readiness §3.1.4 M5 WINS HERE and this is the family where the carve-out is most obviously ' +
      'right: `machineId` is caller-supplied and nameable, so M5’s hazard — iterating machines to ' +
      'learn which are online — is exactly the probe available, and yet collapsing the two answers ' +
      'would make owned compute unusable, since "you may not use this machine" and "this machine is ' +
      'offline" demand different actions from the operator. The shipped behaviour already ' +
      'distinguishes them: an unreachable daemon returns TIMEOUT ("no daemon answered the memory ' +
      'breakdown request"), which is a different refusal from a denied grant. D20.2 still governs ' +
      'everything inside a machine the caller may already use.',
  } satisfies ErrorConsistency,
} as const satisfies CommandContract<typeof hostsMemoryBreakdownInput>

export const HOST_CONTRACTS = { memoryBreakdown: hostsMemoryBreakdownContract } as const

export type HostContractName = keyof typeof HOST_CONTRACTS

export const HOST_CONTRACT_NAMES = Object.keys(HOST_CONTRACTS).sort() as HostContractName[]

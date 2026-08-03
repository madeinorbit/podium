/**
 * THE ONE FILE WRITE — `files.write`.
 *
 * The RightDock editor's save path. `read` and `list` on the same router stay
 * queries: a `visibility` class describes what a command WRITES.
 *
 * CLASSIFICATION: `owned-compute`, the same answer POD-385 reached for specs and
 * for the same ADR 9 D3 rule 3 — facts about a machine inherit the machine's
 * scoping. This writes bytes into a working tree on the machine hosting it, and
 * the shipped gate already authorizes exactly that way and nothing else
 * (`isAllowedRoot(repoRoots)` for the root form). The lint requires
 * `resource: 'machine'` for this class, which is the correct row gate here.
 *
 * ---------------------------------------------------------------------------
 * THE INPUT IS A UNION, AND BOTH ARMS ARE THE SAME COMMAND
 * ---------------------------------------------------------------------------
 *
 * A caller addresses the file either by `sessionId` (the session's own cwd is the
 * root) or by an explicit `root` + optional `machineId`. That is one command with
 * two addressing modes, not two commands: the same bytes land in the same place
 * under the same gate, and only the way the root is RESOLVED differs. Splitting
 * it would have created two contracts whose classifications must then be kept
 * identical by hand, which is the drift this phase exists to remove.
 *
 * THE UNION IS THE SHIPPED SCHEMA INSTANCE, transcribed rather than re-specified:
 * the same two members, the same optional `baseHash`. `baseHash` is the
 * optimistic-concurrency token the daemon compares before writing, and it stays
 * optional exactly as it shipped — making it required would be a wire change
 * wearing a safety improvement's clothes, and it belongs to whoever owns the
 * editor's conflict UX rather than to a router cutover.
 */

import { SessionIdField } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

/** `trpc` alone. The daemon-side write is reached THROUGH this procedure, not
 *  beside it; no CLI verb and no MCP tool names it. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

export const filesWriteInput = z.union([
  z.object({
    sessionId: SessionIdField,
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
])

export const filesWriteContract = {
  name: 'files.write',
  version: 1,
  visibility: 'owned-compute',
  input: filesWriteInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'none',
    rationale:
      'Writing bytes into a repository working tree is a write on OWNED COMPUTE, so it authorizes ' +
      'against the machine and nothing else — which is what the shipped procedure already does via ' +
      '`isAllowedRoot(repos.list())`. `use` and not `manage`: saving a file is working IN the ' +
      'checkout, the same verb as any other edit there, and it changes nothing about the machine ' +
      'itself. A member holding `use` may do it, matching specs. No confirmation even though this ' +
      'OVERWRITES an existing file: the caller is an editor whose user is looking at the buffer, ' +
      '`baseHash` already guards the lost-update case the daemon can actually detect, and git holds ' +
      'the previous bytes in a repository — which the root allowlist guarantees this is.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'NEVER queued. ADR 3 Amendment 1 D18.3: a command that executes on owned compute may not be ' +
      'replayed after the world has moved, and the concrete failure is sharp here — a repo root can ' +
      'be unregistered, renamed or absent from the host between enqueue and drain, at which point a ' +
      'queued save lands in the wrong tree or fails with an error the author cannot act on. Worse, ' +
      '`baseHash` is a point-in-time token: a drained write either clobbers edits made meanwhile or ' +
      'fails a conflict check the user has long stopped watching.',
    applyTimeReauthorization:
      'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1) and ' +
      're-checked against the machine’s repo registry — never a capability frozen at spawn. Losing ' +
      '`use` on the machine between call and apply denies the write; the root allowlist is consulted ' +
      'per call rather than cached per session.',
  } satisfies DeliveryPolicy,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'THE `content` FIELD IS ARBITRARY FILE BYTES and can therefore contain anything the user ' +
      'typed, including a credential they are pasting into a config file. It is deliberately NOT ' +
      'redacted, and the reasoning is that redaction here would be theatre: the content IS the ' +
      'command — a redacted `files.write` cannot write — and the bytes are going to a working tree ' +
      'the caller already holds `use` on, not to a log or a third party. What redaction protects ' +
      'against is a payload leaking into telemetry or an audit record; this surface writes to disk ' +
      'and records neither. `root` and `path` stay visible for the same reason specs keeps ' +
      '`repoPath`: they are the routing keys a refusal must name to be actionable.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: [],
    note:
      'Writes bytes into an existing working tree. A file created this way is a fact about the ' +
      'MACHINE hosting the repo (ADR 9 D3 rule 3) and is reachable by exactly whoever could already ' +
      'reach that checkout, so no entity is minted and no ownership moves.',
  },
  attribution: {
    actor: 'from-capability',
    onBehalfOf: 'from-delegation',
    wirePlacement: 'separate-field',
    reservedWireKeys: ['actor', 'onBehalfOf'],
    rationale:
      'Both halves from the transport principal, never from payload. As with specs the FILE records ' +
      'no writer — git is the authorship record — so this pair exists to authorize and audit the ' +
      'WRITE rather than to be persisted. `root`/`path`/`sessionId` are routing addresses, and ' +
      'Amendment 1 D17 forbids an address doubling as the accountability record.',
  } satisfies AttributionPolicy,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: true,
    note:
      'readiness §3.1.4 M5 over Amendment 1 D20.2 AT THE MACHINE BOUNDARY, and only there — the ' +
      'same split specs makes, and the shipped behaviour it is transcribed from: a root the machine ' +
      'does not register fails FORBIDDEN ("root is not a known repository path") while a registered ' +
      'root the daemon cannot reach fails as a transport error, because "not yours" and "not here" ' +
      'demand different actions. INSIDE a tree the caller may already use, D20.2 governs unchanged: ' +
      'an unwritable path and a nonexistent one fail alike and neither reveals anything across an ' +
      'ownership boundary, since the caller holds `use` on the whole checkout by then.',
  } satisfies ErrorConsistency,
  conflict: 'single-writer',
} as const satisfies CommandContract<typeof filesWriteInput>

export const FILE_CONTRACTS = { write: filesWriteContract } as const

export type FileContractName = keyof typeof FILE_CONTRACTS

export const FILE_CONTRACT_NAMES = Object.keys(FILE_CONTRACTS).sort() as FileContractName[]

/**
 * THE THREE SPEC (pspec v1) WRITE CONTRACTS — `specs.create · specs.save · specs.remove`.
 *
 * The smallest of the 3.3 families, so the bar POD-385 was given is that these are
 * COMPLETE AND CORRECTLY CLASSIFIED rather than that the migration is large.
 *
 * L1 DATA ONLY. The handler is `apps/server/src/modules/specs/service.ts` over the
 * pure file store in `apps/server/src/pspec.ts`, and it is UNCHANGED by this issue —
 * what moves here is the input vocabulary and the classification, joined at the
 * service. `packages/commands` may not import an app, so nothing below reaches the
 * filesystem.
 *
 * ---------------------------------------------------------------------------
 * THE CLASSIFICATION, WHICH IS THE POINT OF THIS FILE
 * ---------------------------------------------------------------------------
 *
 * `owned-compute`, NOT `personal`, and it is read off ADR 1's matrix rather than
 * copied from a neighbouring contract. POD-385 had to ADD that row
 * (`pspec-component`) because there was none: `visibilityClassOf` answered
 * `personal` from ADR 9 D4's default-closed backstop, which is the backstop firing
 * and not a declaration. `contracts.test.ts` asserts these three against the row, so
 * a future reclassification turns them RED instead of letting them quietly disagree.
 *
 * The reasoning, once, because all three write the same class: a pspec component is
 * an HTML file inside a registered repository's working tree, on the machine hosting
 * that repo. ADR 9 D3 rule 3 — facts about a machine inherit the machine's scoping —
 * covers it exactly as it covers repos, prefixes and worktrees. The shipped service
 * already authorizes this way and nothing else: `isAllowedRoot(repoRoots)`, the
 * machine's repo registry.
 *
 * A SPEC IS A SHARED ARTEFACT, which is the trap the brief named. `[spec:SP-xxxx]`
 * markers appear in code comments, issue titles and test names across the whole
 * tracker; a component is nobody's private document, and `personal` — the value that
 * would have arrived by copying a neighbour or by forgetting — would have been wrong
 * in the direction that matters.
 *
 * ---------------------------------------------------------------------------
 * EXPOSURE: `trpc · relay · cli`, AND `mcp` IS ABSENT ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * POD-311 found that the issue CLI and the in-process MCP tools are the SAME table
 * (`issue-mcp.ts` derives its tools from `ISSUE_COMMANDS`), collapsing two exposure
 * decisions into one. THAT IS NOT TRUE OF SPECS, and the difference is measured, not
 * assumed: `SPEC_COMMANDS` in `@podium/issue-client` is consumed by exactly one call
 * site, `apps/cli/src/spec-cli.ts`. No MCP provider derives anything from it — the
 * `podium` MCP surface composes the superagent's tools with `IssueToolProvider`, and
 * `IssueToolProvider` reads `ISSUE_COMMANDS` alone. There is no `spec_*` tool.
 *
 * So the two surfaces are ONE table for issues and TWO different answers for specs,
 * and ADR 3 D3's content is that a transport is served because a contract NAMES it.
 * Declaring `mcp` here would not open anything — nothing would dispatch it — but it
 * would make the field a decoration. `spec-surface.runtime.test.ts` checks the
 * declaration against real reach in BOTH directions, as POD-311 did: a CLI verb with
 * no `cli` tag and an `mcp` tag with no tool are both findings.
 */

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

// ---------------------------------------------------------------------------
// Shared input pieces — THE SAME OBJECTS the shipped surface validates with.
// ---------------------------------------------------------------------------

/**
 * Every spec command is addressed to a repository, and the path is the ROUTING
 * key the repo-root gate resolves. Declared once so the three cannot drift into
 * three slightly different notions of "which repo".
 */
const byRepo = { repoPath: z.string().min(1) }

/** The lifecycle a component's author sets by hand. `superseded` is how a losing
 *  decision is retired — the guide forbids deleting one — so it is part of the
 *  write vocabulary and not a derived state. */
export const SpecStatus = z.enum(['active', 'superseded', 'draft'])

// ---------------------------------------------------------------------------
// Shared policy cells, so a repeated rule cannot drift between the three.
// ---------------------------------------------------------------------------

/**
 * WHAT ACTUALLY SERVES A SPEC WRITE TODAY, measured (see the header).
 *
 * `trpc` — `apps/server/src/router.ts`'s `specs` slice, which the web UI's
 * `SpecsView` calls directly. `relay` — `relay.ts`'s `router === 'specs'` arm,
 * which is how `podium spec` reaches the server through the daemon. `cli` — the
 * `SPEC_COMMANDS` table, whose `create`/`update`/`remove` verbs map onto these
 * three procs. NOT `mcp`, and not `outbox`.
 */
const SERVED_ON: readonly TransportTag[] = ['trpc', 'relay', 'cli']

/** ADR 9 D3 rule 3 via the `pspec-component` matrix row. Read the header before
 *  copying this onto anything: it is a classification, not a template. */
const SPEC_VISIBILITY: VisibilityClass = 'owned-compute'

/**
 * ADR 3 D8 / Amendment 1 D16 and ADR 9 D5 A1 — the same sentence on all three,
 * because it is one rule and a rule restated three times is three rules by the
 * next issue.
 */
const REAUTHORIZATION =
  'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1): the agent’s own ' +
  'scope intersected with its human’s CURRENT rights and re-checked against the machine’s repo ' +
  'registry, never a capability frozen at spawn. Losing `use` on the machine between call and apply ' +
  'denies the write — the root allowlist is consulted per call, not cached per session.'

/**
 * ONLINE-ONLY, and the reason is the machine and not the shape of the data.
 *
 * A spec body is entity-shaped content and would look queueable, which is exactly
 * the reading ADR 3 Amendment 1 D18.3 forbids: these commands write files on
 * SOMEONE ELSE'S HARDWARE, so `machineVerb: 'use'` and `offline-eligible` are
 * mutually exclusive and `classificationErrors` enforces it. The concrete failure
 * the rule protects against is real here — the store refuses a write to a root that
 * is not present on this host, so a queued edit replayed after the repo moved,
 * was renamed or was unregistered would apply against a path that no longer means
 * what the author meant. There is also no client outbox path for specs to ride.
 */
const SPEC_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. ADR 3 Amendment 1 D18.3: a command that executes on owned compute may not be ' +
    'replayed after the world has moved — and a repo root can be unregistered, renamed or absent ' +
    'from this host between enqueue and drain, at which point the queued write either lands in the ' +
    'wrong tree or fails with an error the author cannot act on. ADR 3 D4 rule 4 also applies: the ' +
    'relay’s durable agent queue is a delivery mechanism for an already-authorized ONLINE command, ' +
    'not a client Outbox offline class, and `relay` exposure must not be read as the latter.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * Reviewed, and the answer is that nothing here is redacted — with the one path
 * that had to be considered named, so the empty list is a finding rather than a
 * default.
 *
 * `repoPath` is an absolute filesystem path on the caller's owned compute, which
 * is the strongest candidate. It stays unredacted because it is the ROUTING key
 * the gate's refusal has to name to be actionable ("root is not a known repository
 * path" is useless without it), and because ADR 1's matrix classes the row
 * `secret: 'public'` — the path is already visible to anyone holding `see` on the
 * machine, which is precisely the set that can reach these commands at all.
 * `body` is human decisions written as HTML: project content, never a credential.
 */
const SPEC_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'No credential, token or machine identity crosses this surface. `repoPath` was the one candidate ' +
    'and is deliberately NOT redacted: it is the routing key the repo-root refusal must name to be ' +
    'actionable, it is `secret: "public"` on ADR 1’s matrix, and it is already visible to everyone ' +
    'who can `see` the machine — the same set that can reach these commands. Spec bodies are ' +
    'author-written project decisions.',
}

/**
 * ADR 9 D5 A3 / Amendment 1 D17 — attribution is a PAIR, both halves stamped from
 * the transport principal.
 *
 * WORTH KNOWING, because it looks like a contradiction and is not: the pspec STORE
 * records neither half. A component file carries `id`, `title`, `parent`, `order`,
 * `status` and `updatedAt` and no writer identity at all, and the matrix row says so
 * (`attribution: not-applicable` on both). That is a statement about what the FILE
 * remembers; this is a statement about what the COMMAND must carry to be authorized
 * and audited. Git answers "who wrote this line"; the transport answers "who was
 * allowed to". Folding either into `repoPath` — the only address on the wire — is
 * exactly the substitution D17 forbids.
 */
const SPEC_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload. The pspec store itself records ' +
    'no writer (git is the authorship record), so this pair exists for authorization and audit of ' +
    'the WRITE, not to be persisted into the file — and `repoPath` is a routing address, which ' +
    'Amendment 1 D17 forbids doubling as the accountability record.',
}

/**
 * Amendment 1 D20.3 and readiness §3.1.4 M5, which pull in OPPOSITE directions —
 * and this is the family where M5 wins, which is why the value below is `true`
 * where every workflow and issue contract says `false`.
 *
 * D20.2 says invisible must fail as nonexistent. M5 carves out machine placement:
 * unauthorized must stay DISTINGUISHABLE from unreachable, because "you may not use
 * this machine" and "this machine is offline" demand different actions from the
 * caller and collapsing them makes owned compute unusable. `classificationErrors`
 * enforces the carve-out for `machineVerb: 'use'`.
 *
 * THE SHIPPED SERVICE ALREADY BEHAVES THIS WAY — this is transcribed from it, not
 * imposed on it: `requireRepoRoot` throws FORBIDDEN ("root is not a known
 * repository path") for a root the machine does not register, and
 * PRECONDITION_FAILED ("repository path does not exist on this machine") for one it
 * registers but cannot reach. Two refusals, two meanings, on purpose.
 *
 * D20.2 still governs the layer INSIDE a repo the caller may already use: an
 * unknown `id` and an unknown `parent` fail the same way, as a BAD_REQUEST from the
 * store, and reveal nothing across an ownership boundary because the caller holds
 * `use` on the whole tree by the time either is evaluated.
 */
const SPEC_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: true,
  note:
    'readiness §3.1.4 M5 over Amendment 1 D20.2 AT THE MACHINE BOUNDARY, and only there: a repo root ' +
    'the machine does not register fails FORBIDDEN while a registered root absent from this host ' +
    'fails PRECONDITION_FAILED, because "not yours" and "not here" need different responses. Inside ' +
    'a repo the caller may already use, D20.2 governs unchanged — an unknown component id and an ' +
    'unknown parent fail identically and neither confirms existence across an ownership boundary.',
}

/**
 * ADR 9 D5 A4's shape, with the one thing the framework cannot say written down.
 *
 * `CreationOwnership`'s populated branch admits exactly one `owner` literal,
 * `on-behalf-of-human`, so the field cannot express this row's actual owner rule —
 * which is `inherits from machine` (ADR 9 D3 rule 3), the same as every other
 * per-machine fact. `inheritanceOnCreate: 'parent'` IS the operative declaration
 * here and it means the machine: a new component is reachable by exactly whoever
 * could already reach the repo it was created in, and no per-component act changes
 * that. Reported to the coordinator rather than worked around by widening the type.
 */
const CREATES_A_COMPONENT = {
  creates: ['pspec-component'],
  owner: 'on-behalf-of-human',
  visibility: SPEC_VISIBILITY,
  inheritanceOnCreate: 'parent',
  note:
    'A new component inherits the MACHINE that hosts the repo it was written into (ADR 9 D3 rule 3 / ' +
    'matrix row `pspec-component`), which is what `inheritanceOnCreate: "parent"` records — the ' +
    '`owner` field admits one literal and cannot express an inherits-from-machine rule, so the ' +
    'inheritance column carries it. Nobody acquires or loses sight of a component by creating one.',
} as const

/** The two that write an EXISTING component rather than minting one. Stated, so
 *  "creates nothing" and "I forgot the field" cannot look alike. */
const CREATES_NOTHING = {
  creates: [],
  note: 'Edits or deletes a component that already exists; mints no entity and moves no ownership. The tree’s reachability is the machine’s and is unchanged by either.',
} as const

// ---------------------------------------------------------------------------
// specs.create
// ---------------------------------------------------------------------------

/** `podium spec create <parent-id> "<title>"`, and the web UI's new-component
 *  button. Byte-identical to the schema `modules/specs/service.ts` shipped. */
export const specsCreateInput = z.object({
  ...byRepo,
  title: z.string().min(1),
  parent: z.string(),
})

export const specsCreateContract = {
  name: 'specs.create',
  version: 1,
  visibility: SPEC_VISIBILITY,
  input: specsCreateInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'none',
    rationale:
      'Writing a new file into a repository working tree is a write on OWNED COMPUTE, so it ' +
      'authorizes against the machine and nothing else — which is what the shipped service already ' +
      'does via `isAllowedRoot(repoRoots)`. `use` and not `manage`: creating a component is working ' +
      'IN the repo, the same verb as touching any other file there, and it changes nothing about the ' +
      'machine itself. A member holding `use` may do it — there is no admin-grade arm, because a ' +
      'component is not substrate and carries no instance-wide effect. No confirmation: it is ' +
      'additive and reversible by `remove`.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: SPEC_DELIVERY,
  redaction: SPEC_REDACTION,
  ownership: CREATES_A_COMPONENT,
  attribution: SPEC_ATTRIBUTION,
  errorConsistency: SPEC_ERRORS,
  cli: {
    positional: ['parent', 'title'],
    summary: 'add a component: create <parent-id> "<title>" [--body <html>]',
  },
} as const satisfies CommandContract<typeof specsCreateInput>

// ---------------------------------------------------------------------------
// specs.save  (the CLI calls it `update`)
// ---------------------------------------------------------------------------

/**
 * `podium spec update <id> [--title …] [--status …] [--parent …] [--body …]`.
 *
 * ONE PROC FOR FIVE EDITS, deliberately kept as it ships: every field optional,
 * and an absent field means "leave it". Splitting it into a rename, a re-parent
 * and a body write would be a re-specification, and POD-385's acceptance criterion
 * is that behaviour is IDENTICAL.
 *
 * Note that `parent` here is a re-parent — the one edit that can restructure the
 * tree — and the store refuses a cycle. That refusal is the handler's and stays
 * the handler's; a contract may not encode a rule that needs to read other rows.
 */
export const specsSaveInput = z.object({
  ...byRepo,
  id: z.string().min(1),
  body: z.string().optional(),
  title: z.string().optional(),
  parent: z.string().optional(),
  order: z.number().optional(),
  status: SpecStatus.optional(),
})

export const specsSaveContract = {
  name: 'specs.save',
  version: 1,
  visibility: SPEC_VISIBILITY,
  input: specsSaveInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'none',
    rationale:
      'Same machine boundary as `create` and the same `use` verb: editing a component rewrites a file ' +
      'in the repo working tree. A member holding `use` may do it. No confirmation even though this ' +
      'is the proc that can OVERWRITE a recorded human decision — the guide’s rule is that a losing ' +
      'decision is marked `superseded` rather than deleted, and that is duty of care on the author, ' +
      'not an authorization gate the server can evaluate. Git holds the previous bytes either way.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: SPEC_DELIVERY,
  redaction: SPEC_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: SPEC_ATTRIBUTION,
  errorConsistency: SPEC_ERRORS,
  cli: {
    positional: ['id'],
    summary:
      'edit a component: update <id> [--title …] [--status active|draft|superseded] [--parent <id>] [--body <html> | --body-file <path>]',
  },
} as const satisfies CommandContract<typeof specsSaveInput>

// ---------------------------------------------------------------------------
// specs.remove
// ---------------------------------------------------------------------------

/** `podium spec remove <id>`. Leaf-only: the store refuses a component with
 *  children, so the tree cannot be orphaned by one call. */
export const specsRemoveInput = z.object({ ...byRepo, id: z.string().min(1) })

export const specsRemoveContract = {
  name: 'specs.remove',
  version: 1,
  visibility: SPEC_VISIBILITY,
  input: specsRemoveInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'confirm',
    rationale:
      'The machine boundary and the `use` verb are `create`’s; what differs is `confirmation: ' +
      '"confirm"`, the only one of the three that is not `none`. Removal unlinks the file — ADR 1’s ' +
      'row says `hard-delete`, with git and not a tombstone as the recovery path — and it deletes a ' +
      'recorded HUMAN DECISION, which the agent guide says to supersede rather than destroy. ADR 3 D2 ' +
      'puts destructive writes behind a confirmation, and this is the destructive one. Still `write` ' +
      'and not `manage`: deleting a file in a repo you may work in is not administering the machine.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: SPEC_DELIVERY,
  redaction: SPEC_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: SPEC_ATTRIBUTION,
  errorConsistency: SPEC_ERRORS,
  cli: {
    positional: ['id'],
    summary: 'delete a leaf component (children must be moved or deleted first)',
  },
} as const satisfies CommandContract<typeof specsRemoveInput>

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * The three WRITES, keyed by the proc name the wire already uses.
 *
 * The three READS this surface also serves — `list`, `get`, `search` — are
 * deliberately NOT here, the same split the workflow family made: POD-385's scope
 * is spec CRUD, they carry no ADR 3 D1 classification obligation a query does not
 * already meet through the repo-root gate, and inventing contracts for them would
 * have widened this diff past its issue. They stay hand-written in the service and
 * are authorized by the identical `requireRepoRoot` call.
 */
export const SPEC_CONTRACTS = {
  create: specsCreateContract,
  save: specsSaveContract,
  remove: specsRemoveContract,
} as const

export type SpecContractName = keyof typeof SPEC_CONTRACTS

/** Sorted so a table-driven consumer's order does not depend on declaration order. */
export const SPEC_CONTRACT_NAMES = Object.keys(SPEC_CONTRACTS).sort() as SpecContractName[]

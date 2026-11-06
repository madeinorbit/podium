# ADR 1 — Amendment 3: plain fields are last-writer-wins, per field

- **Status:** Accepted 2026-11-06 (the user's decision on POD-6241, option (a)).
- **Date:** 2026-11-06
- **Issues:** POD-6405 (issue fields as generic edits), POD-6406 (session fields as generic
  edits), under POD-6355 / POD-6241
- **Builds on:** ADR 12 D3 (generic synced edits: each record type declares each field's
  conflict rule)
- **Amends:** Amendment 1 D3/D10/D11 (the closed `field-LWW` inventory, and `archived` /
  `workState` at `exp-rev`)

## Context

ADR 12 D3 turns plain data commands into generic edits whose fields declare their own
conflict rule. The matrix declared the issue core, the issue description and the session
labels `exp-rev`, but the commands that write them never carried a revision: in practice
the last writer has always won. Declaring them `exp-rev` on the generic path would make
edits of *different* fields from two devices start conflicting where they never did.

## Decision

1. **Plain issue fields** move to a new matrix row, `issue-plain-fields`, at `field-LWW`:
   title, brief, acceptance, priority, type, assignee, due, defer, labels, archived,
   estimate, machine. Each field is its own independent group.
2. **The issue description** (`issue-document-fields`) is `field-LWW` until op-streams
   exist; it keeps its own row and its `op-stream` reservation.
3. **Session labels** (`session-labels`: name, archived, workState) are `field-LWW`, each
   field its own group. They stay shared session facts, and a label edit never moves the
   lifecycle's spec revision.
4. **Unchanged, still `exp-rev`:** issue stage and close, the parent link, the agent
   profile and defaults, `sortKey`, `parentBranch`, and the session lifecycle
   (`session-desired-state`).

The clock is the Authority-assigned event time at commit (Amendment 1 D3 condition 1);
client clocks never arbitrate. `FIELD_LWW_MEMBERS` in `packages/model` lists the rows,
and the matrix test holds the set closed.

## Consequences

- An edit of one plain field never conflicts with an edit of another; same-field edits
  resolve last-writer-wins, as they always did.
- Fields where a stale write is harmful keep `exp-rev`, and one device's queued edits of
  them chain onto each other's written revision (ADR 12, POD-6403).

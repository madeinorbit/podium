/** The spin-off-vs-subissue doctrine (POD-85), stated once and reused by every
 *  surface that instructs an agent about filing new work: the issue prime and
 *  bound-issue header (server reads.ts), the always-on system pointer
 *  (agent-bridge issue-system-pointer.ts), and the committed guide
 *  (docs/agents/podium-issues.md). Same single-source rule as ./titles and
 *  ./delegation — copies drift.
 *
 *  Why the litmus exists: the parent/child tree asserts CONTAINMENT ("the
 *  parent is not shippable until the child ships") and drives the subtask
 *  progress count. Work merely DISCOVERED while working on an issue is
 *  provenance, not containment — filing it as a child makes the tree lie.
 *  The `discovered-from` edge carries the provenance instead, and the sidebar
 *  renders it as the quiet ⤷ origin tick. */

/** Full form — rides the prime rules. */
export const SPINOFF_RULE =
  'Filing new work while attached to an issue, apply the litmus test: could your CURRENT issue close honestly, today, with the new work untouched? ' +
  'If YES it is a SPIN-OFF, not a subtask — when the human moves you onto it, `podium issue attach --spinoff "<title>" --confirm-rehome` ' +
  "(a new top-level issue with a `discovered-from` edge back; it never inflates the origin's subtask count). " +
  'If NO — the current issue cannot ship without it — it is decomposition: `podium issue attach --subissue "<title>" --confirm-rehome` (or `create --parent-id` for another agent). ' +
  'Discovered work you are NOT moving onto yourself stays a top-level `create` + `dep-add <new> <current> --type discovered-from` proposal.'

/** Compressed for the always-on system prompt (token-tight). */
export const SPINOFF_RULE_TERSE =
  'New work while on an issue — litmus: could the current issue close with it untouched? ' +
  'Yes → spin-off: `attach --spinoff "<title>" --confirm-rehome` (top-level + discovered-from edge). ' +
  'No (current issue cannot ship without it) → decomposition: `attach --subissue "<title>" --confirm-rehome`.'

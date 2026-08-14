# Settings updates surface — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §3.7, §6.3, §9.2
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** Update operation choreography; Channel defaults and target refresh.

**Goal:** Settings → Updates becomes the operator's view: operation history, channel
state in prose (never a raw precondition string), when targets were last checked, and a
manual "Check now".

**Owns:** `apps/web/src/features/settings/sections/updates.tsx`,
`apps/web/src/features/settings/MachinesPanel.tsx` (update-row copy alignment only),
matching tests. Server payloads already exist (`operations.history`, `fleet()`'s
`checkedAt`/outcome, `updates.checkNow`).

## Context

- Today's section (`sections/updates.tsx`): running/target version, per-machine state,
  channel buttons, env-override warning — but **no check button** and no history.
- Raw strings to banish from user sight: `No update target is configured.`,
  `No target: {reason}` — replace with prose per §6.3 ("Nothing published on `stable`
  yet", publisher public reasons rendered as sentences).
- Machines rows (`MachinesPanel.tsx:1383-1660`) keep their per-machine Apply (edge/stable
  machines are driven per-row, and the supervised label from the daemon-hardening issue
  should render as "managed by Podium Desktop", Apply disabled).

## Tasks

- [ ] **History list** — last operations (`operations.history({kind:'update'})`): target
  version, started/finished (relative + absolute on hover), outcome badge, duration;
  a failed row expands to the typed error's three layers with the operation id copyable.
  Empty state: one quiet sentence, no empty table.
- [ ] **Channel status** — per channel: current target (or prose reason), "checked N ago"
  from `checkedAt`, and a **Check now** button calling `updates.checkNow` with its
  rate-limit outcome rendered honestly ("checked just now"). The env-override warning
  stays.
- [ ] **Copy pass** — every server precondition surfaced here is prose; assert in tests
  that the literal `No update target is configured.` never renders (feed the state that
  used to produce it).
- [ ] **Machines rows** — supervised machines: label + disabled Apply with reason
  ("managed by Podium Desktop on this machine"); align row copy with §6.3 (places, what
  the user will notice). No behavioral change otherwise.

## Testing

happy-dom tests for the section states (history present/empty, channel ok/unavailable,
rate-limited check, supervised row). Gates: typecheck, focused tests, `bun run test`.
Runtime drive: open Settings → Updates against the branch app, screenshot, attach to
your issue.

## Acceptance

- "Did the update finish last night?" is answerable from Settings alone.
- No raw precondition/technical string reachable in the section; supervised machines
  cannot be Applied.

# Interaction feedback audit

Date: 2026-07-23

## Verdict

Podium does not lack interaction feedback everywhere. The shared `Button`, `Input`,
dialog, menu, and form patterns already cover much of hover, focus, disabled, and
busy feedback, and core create/save flows commonly change labels to `Creating…`,
`Saving…`, or similar. The problem is that the feedback language is fragmented:
many product surfaces bypass those primitives, so pointer hover is common while
press, keyboard-focus, pending, and completion feedback vary by feature.

The resulting experience often looks interactive but does not consistently feel
responsive. This is most visible in dense, repeated controls such as the shell
chrome, workflow editor, tray cards, context menus, file panels, tree rows, and
inline issue actions.

## Method

- Drove the isolated full-stack Playwright harness at desktop size.
- Inspected Tasks, Settings, New Task, and Workflows in the rendered app.
- Exercised pointer hover/down and keyboard tab order on visible controls.
- Reviewed shared control primitives and representative asynchronous mutations.
- Scanned production web source (tests excluded) for native buttons and async
  click handlers.

This is a representative product audit, not a claim that every conditional state
was rendered. Authentication/setup, populated task boards, active agent panels,
and destructive error paths still need coverage during implementation.

## What already works

- The shared `Button` defines hover, a focus-visible ring, an immediate pressed
  translation, disabled feedback, and destructive variants.
- Inputs and text areas expose focus, disabled, and invalid states.
- Task creation prevents invalid submission and changes `Create` to `Creating…`.
- Settings has dirty, saving, saved, and error messaging, including `Saving…` and
  `Saved ✓`.
- Issue mutations are busy-gated and errors are surfaced inline.
- Automation dialogs and security/repository settings commonly expose operation-
  specific pending labels.
- The tested Tasks surface gave most visible controls a hover change; hover is
  not the primary system-wide omission.

## Gaps and priorities

### P0 — one interaction-state contract

There are 209 native `<button>` sites across 58 production files, alongside 46
files importing the shared `Button`. Native buttons are sometimes justified, but
the split has produced inconsistent state coverage. An inline source scan found
only four raw button tags with an explicit focus style and one with an explicit
active style; class constants and stylesheet rules improve some of those numbers,
but the architectural gap remains.

Create one reusable pressable-state recipe for controls that cannot use `Button`,
and make `Button` the default. Every production control should have:

- rest, hover (where hover exists), pressed, focus-visible, disabled, and selected/
  expanded states as applicable;
- a visible response on pointer-down, not only after navigation or mutation;
- keyboard focus that uses Podium's visual language instead of relying on the
  browser's thin default outline;
- reduced-motion-safe transitions;
- no interaction that is discoverable only through hover on touch devices.

### P0 — operation feedback at the action origin

Twenty-eight production files contain visibly asynchronous click/submit patterns.
Many important flows already busy-gate correctly, but the treatment is not
consistent. For every async action:

- prevent duplicate submission;
- set `aria-busy` on the action or affected region;
- keep the control width stable while showing an operation-specific pending label
  or compact spinner;
- identify which action is pending instead of only disabling an entire panel;
- show success in place for local actions (copy, save, dismiss, assignment) and
  use a toast when the result is global or no longer visible;
- return actionable errors at the origin and preserve user input.

Fast optimistic interactions may skip a spinner, but still need immediate selected
or pressed feedback and rollback/error behavior.

### P1 — migrate the concentrated bespoke surfaces

Work through these cohorts rather than changing isolated buttons:

1. Shell chrome: top navigation, health/quota chips, sidebar collapse/rows,
   resizers, folded-column controls, and right rail.
2. Work management: issue cards/rows, inline issue fields and copy actions,
   context menus, dock sections, tree expand/add controls, and task dialog chips.
3. Human-in-the-loop: tray offer buttons, session links, ask-user cards, and
   superagent composer controls.
4. Editors and builders: Workflows (the clearest current gap), Specs,
   Automations, Git, and file save/close/mode controls.
5. Settings/setup: switches and selects need pointer feedback; inline autosave and
   explicit saves should share the same pending/saved/error vocabulary.

Representative examples observed at runtime:

- Workflows' `New workflow` and several editor actions are styled native buttons
  with no explicit hover/press/focus contract.
- Top navigation, right-rail cells, column-collapse controls, and health chips
  show hover/selected feedback but no deliberate pressed state.
- File-panel Save disables during a save and toasts afterward, but the icon itself
  does not reveal that saving is underway.
- Settings switches clearly show their value but have little pointer hover/press
  feedback and no pointer cursor.
- Menu implementations use multiple local `itemCls` recipes, making focus,
  pending, and destructive feedback dependent on the individual menu.
- Hover-revealed row actions need `focus-within` and coarse-pointer equivalents.

## Proposed implementation shape

1. Define and document the feedback contract in shared UI primitives. Add a
   reusable pressable recipe for semantic/custom controls, plus a standard inline
   pending indicator that preserves layout.
2. Add primitive tests for pointer, keyboard, disabled, expanded/selected,
   pending, reduced-motion, and coarse-pointer behavior.
3. Migrate the five surface cohorts above, deleting local state recipes where a
   shared primitive fits. Do not globally style every `button`; terminal keys,
   invisible dismiss layers, and deliberately native controls need explicit
   treatment.
4. Add a focused Playwright acceptance lane that performs real clicks and keyboard
   navigation on Tasks, one populated issue, Workflows, Settings, a tray action,
   and a file save. Delay representative mutations in the harness long enough to
   assert pending states, then assert success and error recovery.

## Acceptance criteria

- Every user-visible production control has intentional hover/touch, pressed,
  focus-visible, disabled, and selected/expanded feedback where applicable.
- Every user-triggered async mutation has duplicate-submit protection, a visible
  pending state at its origin, and observable success/error feedback.
- Icon-only controls retain accessible names and gain tooltips where meaning is
  not otherwise evident.
- Hover-revealed actions remain discoverable by keyboard and on coarse pointers.
- Feedback does not change layout, mask issue identity colors, interfere with
  terminal input, or animate when reduced motion is requested.
- Runtime Playwright coverage proves pointer-down feedback, keyboard focus,
  pending, success, and failure on the representative surfaces above at desktop
  and Pixel viewport sizes.
- `bun run test`, the web build, and the relevant E2E specs pass.


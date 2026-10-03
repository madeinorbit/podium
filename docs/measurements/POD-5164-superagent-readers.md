# Superagent thread and focus readers

2026-10-03. Desktop and phone Superagent inputs use the shared data layer behind
startup switches that default OFF. The enabled parent readers execute zero
legacy selectors or slice derivations, with the same rendered output and existing
mutation owner. This report covers the Superagent-owned inputs; the desktop
conversation child remains POD-5173's separately allocated work.

## Scope and ownership

The baseline is [POD-5082's reader inventory](POD-5082-legacy-reader-inventory.md),
Superagent table at lines 190–199. The legacy `superagentSlice` already has
`sourceEqual` at lines 79–80 of its slice module; it does not derive on unrelated
publishes. Both original `useSlice(superagentSlice)` sites depended on that
publisher. Desktop focus/session/event selectors and the phone's boot, session
and question readers are also switched here.

`superagent.ts` declares the principal-scoped thread source, ordered catalog,
active-thread/focus local, thread-to-session and origin-session relations,
numeric issue-event tail, question membership order and read-position context
before readers. It borrows the existing runtime's private RPC list, addressed
replica and cursor port. It creates no runtime, replica, outbox, RPC or mutation
owner. Thread indexes contain only resident private thread rows; building them
never loads session payloads. Unknown private ids never become addressed loads.

All row reads use `pool.row`. Missing source inputs return `LOADING`; demands
coalesce, and cold session requests join the existing batched loader. Session
context uses `sessionPanes.session`; question payloads use the existing
`NoticeSource`. The ordered membership summary preserves the phone's original
first asked question, including insertion order rather than lexical id order.
Numeric event ids retain the existing oldest-first, forty-event tail.

`PoolSources.ensure(key, entities, create)` reserves ownership during lazy
creation and shares one promise/source. The fixed keys are exported by their
source modules. Banners, Superagent and phone consumers ensure those sources
without a matrix of other screens' switches. A competing key still throws;
late results are disposed and failed creation releases its reservation. This
foundation landed first under POD-5339 at `1553f31f09` to unblock chat and board.

The existing read-position port supplies one imperative read at each visibility
edge to freeze the divider before pool attachment. Continuous cursor/event reads
use the pool, and advances retain the existing owner. Waiting to freeze from the
pooled cursor changed a real attachment fixture from 0 to a later hydrated 9;
that regression is explicitly rejected by a planted check.

Web uses `mobxSuperagent`, with optional `mobxSuperagentCheck`, over the shared
device pilot preference. Phone uses its existing app-wide device preference.
The mobile composition root latches hydrated UI state before children render;
later preference edits or principal rebuilds keep the app-load choice. OFF
builds no graph, while an enabled screen stays on pool hooks through attachment.

## Focused validation

Validation ran sequentially on flatblock in `~/podium-test-5164`, using its
checkout-local `.toolchain`, pinned Bun 1.4.2 and frozen local dependencies.
Runs waited for one-minute load at or below 8. No forced cache bypass or full
suite was used. The coordinator retained the broader click-speed gate.

The complete screen selection is green: **78 checks across nine files**
(source 9; web 36; mobile 33). The registration change's affected selection is
also green: **44 checks across eight files**, including existing registry,
notice and host tests plus five new ownership checks. These selections overlap;
they are focused results, not a whole-suite claim. Filtered graph, web and mobile
typechecks are green, with the final run reporting 17 successful tasks and 14
cache hits.

All **23 source/UI controls** fail at their named collected assertions, including
private addressing, active selection, unrelated-publication reuse, numeric
ordering, cursor updates, question order, cold indexes, disposal, differential
error detection, startup, owner actions and five registration guarantees.
Every plant is copied aside and restored with a byte-hash check. All **eight
browser controls** reject startup, selector, publisher, positive-control,
error, comparison, action and rendered-output faults. The operator cursor plant
produces one difference at `lastEventId`, then restoration returns to zero.

## Chromium evidence

Chromium **148.0.7778.96**, real StoreProvider, pool host and Superagent parent;
5,600 synthetic issues and 5,014 sessions. Four fresh pages run OFF/ON/ON/OFF
at source SHA `736dca42f70f3bb0b72adc737982936976a2a782`. The conversation child
is held fixed to isolate this allocated reader scope. Phone checks use its real
provider/host transition with platform rendering leaves replaced.

| Per arm | Legacy selector evaluations | Enabled selector evaluations | Legacy thread-slice derivations | Enabled legacy derivations | React commits, either arm |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 unrelated session updates | 120 | 0 | 0 | 0 | 0 |
| 10 relevant thread updates | 80 | 0 | 10 | 0 | 10 |

Both repetitions agree. Legacy `superagent.focus`, `.session` and `.events`
instrumentation names selector callback evaluations; `.events` does not count
the memoized feed projection as rerunning on every publish. The `superagent`
slice counter records actual derivations and demonstrates its existing guard.
Enabled arms have no Superagent legacy counters and zero selectors.

Rendered pane/control snapshots match exactly, including the frozen return
marker behavior. Both enabled differentials report **five row positions, zero
differences and zero pending loads**. Chromium observes clear and open-terminal
through the original API, then the same owner's selected session becomes
`synthetic-session-3`. There are no provider or browser errors. The final normal
capture follows restoration of every browser plant.

This is a count-only comparison. No latency, CPU-time, heap or speedup claim is
made, and no timing lease was held. The screenshots show the isolated synthetic
parent fixture, with its fixed conversation child.

## Operator replay and remaining readers

The ludovico-only replay opens the local database read-only, retains values in
memory and exports only counts and comparison positions. The final replay has
**one principal, six private threads, 5,321 sessions and 150 curated events**:
**46 row positions, zero differences and zero pending loads**. No asked questions
exist in that snapshot; question behavior is established by synthetic checks.
Ephemeral running flags are also covered by synthetic updates, not database rows.

The remaining desktop child reads are `ChatView.tsx:111` (draft), `:217`
(pending-interaction predicate), `:222` (issues), and
`use-chat-surface.ts:242` (actions/context including threads), `:660` (question),
plus its session/exit and composer issue consumers. They are known POD-5173
work, excluded from the scoped zero-reader assertion. Stable transport,
transcript, catalog and mutation ports keep their existing owners.

## Rollout and retirement

No operator default-ON date is recorded. Legacy branches and switches remain
available for the rollback window. POD-5174 owns retirement roughly one week
after the operator defaults the screen ON; this landing does not claim rollout
or legacy deletion. Browser PNGs, count JSON, numeric replay reports, focused
logs and control summaries are attached to the issue and are not committed.

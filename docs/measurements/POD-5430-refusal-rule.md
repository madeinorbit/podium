# POD-5430 — one refusal rule in the outbox (steps 1 and 2)

Spec: `docs/plans/pod-4286-optimism-and-refusals.md` §3 (R1, R3) and §6 steps 1–2.
Policy: `docs/adr/0003-command-security-amendment-2.md` (D23, awaiting the operator's
signature). Base: `integrate/4286-pilot` at `be1e10bd83` (POD-5429's typed refusals).
All runs on flatblock, 2026-10-03, synthetic data only.

## What changed

- **R1.** The kernel's partition scan stops only at an entry whose outcome is unknown
  (`sending`, `accepted`, `queued` and backing off). `applied`, `rejected`, `expired`,
  `dead-letter` and `cancelled` let the next entry go, for every command. Deleted:
  `OUTBOX_PARKED_YIELDS_PARTITION`, the `parkedYieldsPartition` port field and
  `yieldsWhenParked`.
- **R3.** A retry moves its entry to the back of its partition in the same durable write
  (a remove and a put of one id in one mutation). Edit already appended a new record.
- **Drain on release.** The app's queue starts a drain after a user discard and after an
  expiry sweep that parked something.
- **Recovery surface.** The header says nothing waits behind the refused change and a
  retry goes after the user's other changes. The web card has a Copy button for the
  author's text (the phone card's text is already selectable).
- The compatibility queue (`client-core/src/outbox.ts`) already behaved this way.

## Evidence

| Check | Unchanged base | This change |
|---|---|---|
| Kernel: POD-5415 sequence and R1/R3 cases (`refusal-releases-partition.test.ts`, 9) | 6 fail | 9 pass |
| App queue through `openKernelEngineOutbox` (`kernel-outbox.refusal-release.test.ts`, 3) | — | 3 pass |
| Phone, production Expo export, Pixel Chromium, one shared profile per arm (`expo-mobile-refused-rename-queue.browser.e2e.ts`) | fails: server title stays at A, rename B never sent | passes, pilot off and on |

Phone run, both pilot arms (this change): the requests sent were rename A (refused with a
synthetic 400), `issues.markRead`, rename B; the server holds rename B; the banner reads
"1 change needs review in Settings." with no queued line. On the base the same driver
failed at the server-title check, which is POD-5415.

Planted mistakes, each caught by at least one of the tests above (8 of 8): retry kept in
place (two call sites), the store keeping the old position on a move, discard without a
drain, expiry sweep without a drain, a refusal holding the rest of its pass, an aged head
holding the rest of its pass, and Copy sending the wrong text.

Focused set: 25 files, 422 tests green (sync outbox and store-fidelity on in-memory,
IndexedDB and mobile SQLite; client-core outbox and chat-send; web and mobile recovery).
Typecheck green for `@podium/sync`, `@podium/client-core`, `@podium/web`,
`@podium/mobile`. Biome clean on changed files; `lint:shadowing` and `lint:vitest-env`
clean; `lint:boundaries` fails identically on the base, on lines this change does not
touch.

Not affected: no MobX, pool or derivation code changed, so per-click derivation counts and
`tracking-counts.baseline.json` are untouched.

Notes:

- `apps/web/src/features/machines/outbox-recovery.test.tsx` failed 11 of 11 on the clean
  base ("useStore outside StoreProvider": it mocked only `@/app/store`). It now also mocks
  the store handle, and covers Copy.
- `apps/mobile/src/components/Notices.pool.test.tsx` "keeps chat, settings, dismiss and
  typed-answer actions…" fails on both the base and this change in interleaved runs.
- flatblock's Chromium needs `libasound.so.2`; the phone run used a copy extracted into a
  user directory (`LD_LIBRARY_PATH`), with no system change.

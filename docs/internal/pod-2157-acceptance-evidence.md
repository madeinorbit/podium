# POD-2157 — end-to-end acceptance: evidence

The acceptance drives POD-2194 and POD-2200 could not reach, run now that the box has disk
to build with. Their results are not repeated here: between them they already cover an
all-git update end to end with no pack, adoption across a coordinating-server restart with
the same operation id, single-flight in both arms, a stalled machine ageing on the step's own
timer, straggler reconciliation in four arms, the post-cancel case and the dirty-checkout
refusal.

- **Candidate:** `788d9b24c` (this branch, cut from integration tip `worktree-updater-spec`)
- **Date:** 2026-08-16
- **Host:** Linux x86_64, 8 cores, 23 GB memory (2–3 GB available throughout, swap full),
  13 GB disk free at the start

## Safety

Nothing touched the operator's default instance, state directory or checkout.

- Disposable named instance `pod2157`, state root `/home/mgw/src/other/podium-pod2157-state`,
  ports 18921 / 18922 / 18923, its own `PODIUM_AGENT_HOME`.
- Disposable checkout: `git clone --local --shared` at `/home/mgw/src/other/podium-pod2157`,
  so its `git fetch` reaches the local repository and never the operator's remote. Its
  `origin` was confirmed to be `/home/mgw/src/other/podium`.
- The served website is that checkout's own `apps/web/dist` (`PODIUM_WEB_DIR` left unset, so
  `desktopWebDir()` resolves relative to the running server module), which is disposable for
  the same reason the checkout is.
- `node_modules` was hardlink-copied (`cp -al`, 17 s) from a worktree whose `bun.lock` blob is
  identical (`b7e5677c`). No install, no measurable disk cost. Resolution was proved to land
  in the disposable checkout with `Bun.resolveSync`, not in the main one.
- Everything was removed afterwards; the disk returned is recorded at the end.

## What the trust boundaries allow, decided before driving

Two constants in the shipped code decide what a drive on this host can and cannot prove, and
they are stated up front so no result below is read as stronger than it is.

`packages/runtime/src/update-delivery.ts:273` picks the key each delivery is verified against:

```ts
const trustedPubkey = delivery === 'bundle' ? deps.pinnedPubkey : deps.pubkey
```

- **bundle** → the per-server key pinned at pairing, which the coordinating server MINTS
  itself (`readOrCreateUpdateSigningKey`). Fully drivable here, positive and negative arms.
- **feed** → `PODIUM_UPDATE_PUBKEY`, the production release key baked into the binary.
  `scripts/.podium-update-dev.key` — the gitignored private half — is ABSENT on this box, so
  no feed artifact produced here can be accepted by a compiled daemon. Only the fail-closed
  arms of feed delivery are drivable.

This matters most for the stable channel, because `resolveReleaseTarget` REFUSES a release
manifest offering any non-feed delivery. A stable target is therefore feed-only by
construction, and the last hop of a stable update cannot be completed on a host without the
production key. Where that boundary is reached it is named explicitly rather than papered
over.

## Instruments, all outside the product

No file under `apps/` or `packages/` was modified for any drive below.

<!-- INSTRUMENTS -->

## Results

<!-- RESULTS -->

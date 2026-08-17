# POD-2203 — an operation can clear a refusal (fixes POD-2201)

Found by the POD-2200 live acceptance drills (`pod-2200-all-git-drills-evidence.md`, section
"Found on the way"), which measured it at the API layer with the grant counter:

```
machine rejected:            updates.start → failed in 10 ms, 0 grants
                             updates.retry → failed in 10 ms, 0 grants  (the panel's Try again)
machine stuck after cancel:  updates.start → failed in  9 ms, 0 grants
```

## The defect, verified against the code

`machinesRunner.ensure` settled before it authorized:

```ts
const settled = settleMachines(operation, step, context)   // ← asked first
if (settled) return settled
…
context.updates.markAuthorized(details.channel)            // ← clears terminal states, never reached
context.updates.tick(details.channel)
```

`markAuthorized` has always cleared terminal machine states — "a deliberate Apply/Try again is
new authority" — but it sits below the settle, so the settle decided first and the clearing
never ran. Two things fed the settle a stale verdict:

1. **The plan carried it.** `placeOf` copied the machine's live convergence state into the
   planned place, so a machine whose last word was `rejected` — or that a cancel left `stuck` —
   was planned as a place that had *already failed*.
2. **The service still held it.** Even with the place clean, `projectMachines` reads the live
   fleet, so the verdict came back at the first projection.

The user-visible consequence is the one that matters: the panel offers **Try again**, Try again
is another operation, and the second operation failed exactly like the first. That is the dead
end §6.2 says the panel must not have, and it contradicts §7's retry semantics. The only escape
found on the drive was publishing a different target commit.

## The fix

- **A planned place is `pending`.** The plan is a statement of what this operation intends,
  made before it has said one word to any machine. The admission path
  (`admissibleDeferredPlaces`) and the projection already use exactly this vocabulary; the
  planner now agrees with them.
- **The runner forgets the verdicts of places it has not yet asked anything of**, before it
  settles — per place, and only while a place is still `pending`. A verdict given to *this*
  operation settles the step in the usual way.
- **One method for both retry routes.** `UpdatesService.clearMachineVerdicts(channel, ids?)`:
  `authorizeMachine` clears its own row, the operation clears the places it is waiting on, and
  `markAuthorized` keeps its channel-wide clear. The two routes now agree about what a retry
  means.

Untouched, deliberately: the reconciler's `terminal` refusal and POD-2105's
per-machine-per-target attempt cap. Background convergence still leaves a refusing machine
alone — what clears a verdict is a human deciding to try again, and one grant is issued per
decision.

## Evidence

Four tests in `apps/server/src/modules/updates/operation.test.ts`, all driven through the
engine and the real fleet bridge (no mocks of the thing under test):

| Test | Red before the fix |
|---|---|
| a new operation asks a machine that refused an earlier one again | `expected [ 'vmi' ] to deeply equal [ 'vmi', 'vmi' ]` — zero new grants |
| refusing the retry fails it, after exactly one new grant | `expected […] to have a length of 2 but got 1` |
| an operation started after a cancel asks the stuck machine again | `expected [ 'vmi' ] to deeply equal [ 'vmi', 'vmi' ]` |
| keeps the refusal THIS operation was given, across a re-entry | *(the loop guard — see below)* |

**Both halves proven load-bearing.** Removing the runner's clear: the three tests above go red
(the planner still skips a machine the service believes refused). Reverting `placeOf` to the
live convergence state: the same three go red.

**The loop guard proven able to fire.** The fourth test drives the real re-entry path — a
deferred machine reconnecting admits itself into the running step, and the bridge *returns* on
that path, so it is the runner's own settle that has to hold. With the clearing made
unconditional instead of per-place, it fails:
`expected [ 'vmi', 'laptop' ] to deeply equal [ 'vmi' ]` — the refusal erased and the wave
carried on.

## Gates

Run after the rebase onto `worktree-updater-spec` at `3a19d5584`.

- `apps/server/src/modules/updates/**` + `apps/server/src/modules/operations/**`: 17 files,
  489 tests, green (focused vitest, `PODIUM_TEST_WORKERS=1`).
- `apps/server/src/modules/fleet/authz.test.ts`: 65 tests, green.
- Scoped typecheck `turbo run typecheck --filter=@podium/server --concurrency=1`: 11/11
  successful (run at 2.2 GB available under the `updater-heavy-lane` lease; `@podium/server`
  executed on a cache miss, and the post-rebase re-run is a full cache hit because the rebase
  added only a docs commit).
- `bun run test:related` for the three changed files, A/B against the fork point: **identical
  failure sets** — 7 failing tests in 6 files at both `3a19d5584` (detached in-place checkout)
  and at this branch, in `issues`, `sessions`, `shipping` and the relay, none of them touching
  updates. Test counts 1864 → 1868: the four new tests, all passing.
- No new test *file*, so the server shard roster is unchanged.
- Nothing in `apps/web` changed. (Its reader already handles `pending` as a resting place; the
  old planned state `current` was read there as *converged*, so the panel briefly showed a
  fresh plan's places as done.)

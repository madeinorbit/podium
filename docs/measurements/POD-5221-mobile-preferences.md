# Mobile preferences on the pool

The phone's `usePersistedUiState`, `useCollapsed`, and `useCollapsedSet` now read
declared `pool.row('preference', key)` values when the existing mobile pilot is
enabled. The mobile host adds only `preferences: true` to its existing options,
which attaches POD-5161's preference source to the signed-in runtime's UI owner.
POD-4286 granted the hook, adapter, counter, test, evidence, and additive host scope.

The existing app-root switch remains default-off and latched for the app load.
The legacy implementations retain their subscriptions, defaults, and write timing.
The stable owner acquisition in `client/hooks.ts` is unchanged. Pool projections
memoize their readers and paint the parsed default while the host or demanded
rows load; they never fall back to a legacy hook reader during that interval.

Every write still goes through the existing routed UI owner. Single folds write
immediately. Fold sets paint their local intention immediately and defer the
write to the next macrotask. An immutable local intention snapshot holds the
fold through the shared source batch, then releases it so external writes and
rollback can paint. Superseded taps coalesce, unmount leaves the deferred write
intact, and a new UI owner gets a separate intention overlay.

## Reader and lifecycle evidence

The focused hook fixture uses the production `MobxPool`, preference source,
projection, and differential. Its four demanded keys load in one batch. The
comparison reports **0 differences, 0 pending, 4 positions**, with **0 legacy
hook reads**. An unrelated UI notification produces no hook render, and an
unchanged parent render builds no new projections. The legacy positive control
records nonzero reads and the original three hook subscriptions. A planted
row-value difference produces four differential mismatches.

The real mobile-provider case boots `MobileClientProvider` with its AsyncStorage
bridge, shared replica assembly, real SQLite file, durable outbox, StoreProvider,
and lazy mobile host. Platform network/storage edges and the cold-sync painting
boundary are replaced with offline fixtures. Saved values reload through the
initial null-pool to attached-pool transition. The three demanded keys have
**0 differences, 0 pending, 3 positions**, with **0 legacy hook reads**.
The next principal gets its own defaults and source. Old-owner writes do not
affect it, sign-out releases demanded rows, and the case records no React errors.
StrictMode and attachment-before-load are also covered in the hook fixture.

The saved-start fixture waits for the owner's two replicated fold commands to
enter its durable queue and flushes storage before restarting. The generic
sticky-prompts value is device-local. An immediate whole-app termination before
that enqueue completes is a different boundary from reloading saved preferences.

## Focused validation

All validation ran on flatblock in `~/podium-test-5221`, using checkout-local
Bun 1.4.2 and frozen isolated dependency links. Passing evidence covers **29
tests across four files**:

| File | Passing tests |
| --- | ---: |
| `hooks/mobile-preferences.test.tsx` | 16 |
| `hooks/useCollapsedSet.test.ts` | 6 |
| `client/mobile-pool.test.tsx` | 4 |
| `components/MobxPilotSetting.test.tsx` | 3 |

After rebasing onto POD-5347's shared projection fix, the 16 preference-hook
tests and all four real-provider tests passed together. The six existing fold
tests and three setting tests passed in the earlier combined command; their
assertions and product behavior were unchanged by the rebase. The initial
combined command had one failing new restart-fixture assertion, corrected by
waiting for the cold graph import and the correct two durable fold writes.
These are focused results.

The final composition also includes POD-5247's landed mobile notice registration;
the preference option remains a single additive field and keeps its summary
entries. All four real-provider tests passed again on that composed host.

`bun run typecheck -- --filter @podium/mobile` passed **14/14 tasks** again after
the shared projection rebase. Biome checked the eight hook/test files and the
new browser proof cleanly, plus a separate linter-only check on
the existing host file whose single granted option remains additive.
`lint:shadowing` and `lint:vitest-env` passed. The combined test run printed
module-suffix and act-environment warnings; the lifecycle-only run's explicit
React-error assertion is green.
The composed-host run also prints happy-dom fetch abort warnings during teardown
after the assertions. POD-5247 and POD-4286 received that fixture evidence.

Eight planted defects reached failing assertions and were restored:

| Planted defect | Assertion reached |
| --- | --- |
| Enabled hooks forced onto the legacy branch | Saved value appeared during the expected cold/loading default |
| Wrong pool preference value | Saved-value parsing differed |
| Optimistic intent omitted | Deferred fold did not paint before the write |
| Deferred write made synchronous | UI writer ran during the tap |
| Intent retained after persistence | No-op final tap blocked an external change |
| Overlay reused across UI owners | Previous principal's fold remained visible |
| Preference source option removed | Real-provider reload painted defaults instead of saved values |
| Memoized reader replaced by a fresh closure | Unchanged render rebuilt projections |

The reader-allocation control required the explicit projection count; rendered
value parity alone did not detect allocation churn. The source-registration
control was rerun after the restart fixture correction so its failure reaches
the intended saved-value assertion.

## Production phone web export

The isolated Pixel Chromium check exercises the saved pilot setting, a Backlog
fold, reload persistence, and return to the legacy path through the production
mobile export. It uses the harness's synthetic principal and blocks service
workers to read the candidate export directly.

The first browser lane stopped before executing an interaction because the
unrelated web export measured 1,801,906 raw eager bytes against its temporary
1,800,000-byte limit. POD-4286 adjusted the budget on the integration branch;
this issue changes no web budget. The first interaction run passed startup
switching but found an empty isolated task board; the test now seeds one
synthetic backlog task without starting an agent.

**The seeded production restart is red.** It fails before the fold interaction:
Metro reports `Requiring unknown module "2136"`, then constructing the shared
pool's issue object throws `Cannot set property id ... which has only a getter`.
The phone's production transform emits the `EntityModel` parameter property as
an assignment to `id`, while the issue prototype has a generated getter. The
trace is attached as `browser-errors.log`; no production fold-reload screenshot
or successful browser result is claimed.

POD-4286 assigned the shared export/construction fix to **POD-5370** and approved
landing this default-off preference migration with its passing focused and
real-provider evidence. Production restart acceptance with issues waits on that
fix. The reproduction command for its owner is:

```sh
PATH="$PWD/.toolchain:$PATH" LD_LIBRARY_PATH="$PWD/.toolchain/lib" PORT=15221 \
  bun run test:browser -- --suite expo-mobile-preferences --project=chromium-pixel
```

It runs from `~/podium-test-5221` on flatblock. The diagnostic candidate was
`84b92168d9`; its full log is `.artifacts/POD-5221/browser-errors.log`.

POD-4286 confirmed that the fixed web click-speed corpus does not exercise this
mobile-only step and should not be run or promoted for it.

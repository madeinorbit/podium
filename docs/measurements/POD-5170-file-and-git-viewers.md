# File and Git viewer reader migration

Measured 2026-10-02. Base: `integrate/4286-pilot 63aa99e9725bd19159e82f4a2fa75bf9aec45fff`.
Browser candidate: `19ba413b43`; Bun 1.4.2 and Chromium 148.0.7778.96 on flatblock,
in the private `~/podium-test-5170` checkout with its own `.toolchain` and dependency links.
The coordinator allocated this scope before implementation and accepted the plan.

## Result

All thirteen production reader sites in the allocated scope now acquire stable services
from the existing store owner. HTML, JSON and Markdown retain their existing reactive
file-mode hooks, which use the shared preference pool when `mobxPreferences=1`.
Diff wrapping uses the same preference hook. The preference switch still defaults OFF
and is latched once per application load; stable service access applies in both arms.

In a real Chromium comparison, both arms rendered matching file modes and contents.
The enabled arm ran zero legacy selectors, preference fallback reads and published-slice
derivations at mount and during each measured phase. Two hundred unrelated activity
events ran 5,000 selectors in the original arm and zero in the enabled arm. The saved
file-mode replay on ludovico reported zero differences for six saved tabs.

## Scope and baseline

The baseline evidence is the [parent reader inventory](POD-5082-legacy-reader-inventory.md#file-viewers-and-git-panels).
The locations below are its original production selector locations, rather than current line numbers.

| Original location | Existing services retained |
| --- | --- |
| `features/files/AssetFilePanel.tsx:35` | `httpOrigin` |
| `features/files/DownloadFileButton.tsx:29` | `httpOrigin` |
| `features/files/FileBrowserModal.tsx:32` | `listDir`, `openFileInWorktree` |
| `features/files/HtmlFilePanel.tsx:44` | `httpOrigin`, `readFileScoped`, routed UI writer |
| `features/files/JsonFilePanel.tsx:79` | routed UI writer |
| `features/files/MarkdownFilePanel.tsx:44` | routed UI writer |
| `features/files/MarkdownPreview.tsx:30` | `httpOrigin`, `openFile` |
| `features/files/OpenInBrowserButton.tsx:33` | `httpOrigin` |
| `features/files/WorktreeFileTree.tsx:182` | `listDir`, `openFileInWorktree`, `trpc` |
| `features/files/useFileDocument.ts:29` | `readFileScoped`, `writeFileScoped` |
| `features/git/DiffSheet.tsx:492` | `gitCommitDiffFile`, `gitDiffFile`, `readFileScoped` |
| `features/git/GitPanelView.tsx:107` | `gitCommitFiles`, `gitLog`, `gitStatus` |
| mobile `task-detail/GitReviewSection.tsx:42` | `gitDiffFile`, `gitStatus`, `readFileScoped` |

The web paths are under `apps/web/src`; mobile is under `apps/mobile/src/components`.
Production changes stay within those files. Fixtures and diagnostics stay in the file
feature directory, with focused test adaptations beside the components. No shared
runtime, pool, replica, outbox, schema, switch or action-owner file changes.

## Ownership and pool rules

`useStoreHandle().getSnapshot()` only acquires stable request methods, `httpOrigin`,
or the routed UI writer. Reactive preference values continue through
`usePersistedUiValue` / `usePersistedUiState`; components do not read their saved mode
from that snapshot. Read, write, open, list and Git calls retain the same owner,
machine/worktree/session/artifact scope and arguments. Save retains its original
base hash; artifacts remain immutable. Mode parsing, defaults, delayed hydration
and per-tab keys are unchanged.

This uses POD-5161's existing `preference` declaration in
`packages/client-graph/src/preference-schema.ts`, installed before any reads.
Each exact key is an on-demand scalar row. Relations and unloaded summaries are
explicitly empty because this screen does not enumerate unloaded records.
The shared `PreferenceSource` keeps only demanded keys and resident rows, returns
`LOADING` before its microtask load, and batches those loads. Both the reactive
hook and the diagnostic comparator read through `MobxPool.row('preference', key)`.
There is no extra application runtime or mutation owner. File and Git request
results remain in their existing component lifecycles.

The mobile app has no pool attachment yet. As directed by the coordinator,
`GitReviewSection` uses only stable service access; mobile pool data follows
POD-4976. It introduces no mobile preference or entity reads.

External browser, OS editor and terminal dispatch handlers did not change.
The existing download/open tests were included, and no additional external dispatch
interaction was needed. Browser work below measures the reader migration itself.

## Differential and focused checks

`file-viewer-check.ts` reuses the sidebar-check comparison contract. It compares
the four raw preference rows and resolved per-tab modes. Reports contain counts
and comparison positions; saved keys, paths and values stay in memory.

The unit matrix covers 600 HTML/JSON/Markdown tab positions plus four raw rows,
including absent, malformed, array and mixed valid/invalid maps, JSON split-mode
normalization, defaults and wrap state. Its first read reports four pending rows;
the initial load resolves all four in one batch.

Actual web components mount under the existing provider and attached pool, receive
late saved modes, mount file/tree/browser/Git/diff surfaces, then receive unrelated
activity. Store and preference counters stay zero, mounting writes no preferences,
and no file write occurs. A separate real-owner test verifies scoped file reads,
save content/base hash, and artifact write refusal. The mobile test verifies status,
diff, refresh and unrelated publication through the existing mobile provider.

Focused coverage comprises 58 tests in 12 files: the new pool tests; FileBrowserModal,
WorktreeFileTree, HtmlFilePanel, JsonFilePanel, MarkdownFilePanel, DownloadFileButton,
OpenInBrowserButton, GitPanelView, DiffSheet, shared preference latch tests, and
mobile GitReviewSection. Initial fixture failures were corrected; the five affected
web files reran green (23 tests). After the final fixture cleanup and planted controls,
the new web/mobile files reran green (7 tests). Unchanged files retain their successful
initial results. These are focused results, not a whole-suite or lean-gate result.

Commands use repository lanes from the checkout root:

```sh
bun run typecheck -- --filter=@podium/web --filter=@podium/mobile
bun run test:file -- <the twelve focused paths above>
bun run test:file -- <the five corrected web paths>
bun run test:file -- apps/web/src/features/files/file-viewer-pool.test.tsx apps/mobile/src/components/task-detail/GitReviewSection.test.tsx
```

Final affected typecheck: 17 successful tasks, 15 cached. Scoped Biome comparison
against the same base found 19 baseline diagnostics and 17 candidate diagnostics,
with no new diagnostics. The scoped lint command still exits nonzero on existing
findings; separately shippable cleanup is Proposed POD-5231, left unclaimed.

## Real browser measurement

The fixture mounts production components and real CodeMirror over one offline
StoreProvider, using 5,600 synthetic issues and 5,014 sessions. File and Git services
are bounded fixture methods; outbound network traffic is restricted to the local
fixture origin. The baseline restores the twelve original web reader files from
the base commit, then the candidate files are restored before the enabled arm.
Each run owns and stops only its own Vite/browser processes.

Foreground command: `bun --conditions=@podium/source apps/web/src/features/files/file-viewer-proof.ts`
with `--legacy` for the baseline. Both runs completed under the `bench:flatblock`
lease, which was released immediately afterward. Screenshots and raw synthetic
evidence are attached to the issue.

| Phase | Original selectors / fallback preference reads | Enabled selectors / fallback preference reads | Enabled legacy derivations | Enabled preference batches / rows loaded, cumulative |
| --- | --- | --- | --- | --- |
| Mount | 105 / 35 | 0 / 0 | 0 | 1 / 3 |
| 200 unrelated activity events | 5,000 / 0 | 0 / 0 | 0 | 1 / 3 |
| 20 rounds of file-mode changes | 1,800 / 960 | 0 / 0 | 0 | 41 / 123 |
| Open browser and diff utilities | 54 / 33 | 0 / 0 | 0 | 42 / 124 |

Only the three file-mode rows load initially; the diff wrap row loads when demanded.
Unrelated activity adds no preference load or React commit. The shared source still
receives 400 store subscriber wakes in that phase. Both arms make the same file/Git
requests: mount reads 5 files, lists once and makes 2 Git calls; utilities increase
those cumulative counts to 6, 2 and 3. Neither arm writes a file or reports a page error.
The enabled comparison has 7 positions, zero pending and zero differences; the
actual rendered snapshot also matches the original arm.

| Phase | Original / enabled browser task time (ms) | Original / enabled React commit time (ms) |
| --- | --- | --- |
| Mount | not sampled | 137.9 / 121.4 |
| Unrelated activity | 589.4 / 591.7 | 0 / 0 |
| Mode changes | 503.3 / 417.4 | 208.5 / 167.5 |
| Utilities | 97.4 / 79.0 | 56.0 / 48.3 |

These are single development-browser samples. They establish removed reader work
and preserved output; the activity timing is essentially unchanged and this is not
evidence of a general speedup.

## Saved-mode replay and planted controls

The authenticated `layout.get` replay ran only on ludovico. Operator data stays
in memory in a read-only diagnostic source; neither saved paths nor values leave
the machine. Final result: 6 saved tabs, 10 comparison positions, zero differences,
zero pending. Device-local diff wrapping is covered by the synthetic checks.

Every new check was given a deliberate fault; each exited 1 at its intended assertion.
All changed files were restored afterward, with a clean candidate diff verified.

| Check | Planted fault | Observed failure |
| --- | --- | --- |
| Mode matrix | Wrong pool preference value | 4 unexpected differences |
| Mounted web readers | Original `useFileDocument` selector restored | 147 legacy reads/derivations counted instead of zero |
| Save owner/base hash | Wrong hash passed to existing writer | Scoped write-argument assertion |
| Mobile readers | Snapshot selector restored | 22 selector/derivation counts instead of zero |
| Chromium enabled arm | Original `useFileDocument` selector restored | `Legacy file/Git reader executed during mount` |
| Saved-mode replay | Wrong pool preference value | 4 unexpected differences |

The browser fault run used `--counts-only`, which disables timing collection and
omits duration fields. It did not consume a timing lease.

## Rollout and retirement

The shared `mobxPreferences` startup switch is unchanged: default OFF, enabled
only by `mobxPreferences=1` for a fresh application load. The operator has not
defaulted this screen ON or set a rollout date in this task.
POD-5222 owns deleting the shared legacy preference arm and rollback switch about
one week after that recorded operator rollout date. There is no per-file legacy
selector arm left to retire. Mobile pool attachment remains with POD-4976.

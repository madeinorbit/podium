# Frame-bounded Kanban drag evidence

Recorded 2026-08-12 on the issue branch.

## Hermetic large-board profiler probe

The probe force-mounts 40 cards in each of the six stages (240 cards total), then drives 300 pointer samples representing five seconds at 60 samples per second while the pointer remains over one computed drop target.

Result:

```text
[POD-850 large board] mountedCards=240 pointerSamples=300 commits=3 expected=lifecycle+changed-drop-target
```

The three commits are the intended sparse publications: drag start, the first changed `{stage,index}` drop target, and drag end. Every pointer sample still updates the proxy transform imperatively, while hit testing runs through one `requestAnimationFrame` callback and identical drop targets do not publish React state.

Command: `bun run test:perf:frontend`

Result: 2 files passed, 10 tests passed.

The focused lifecycle coverage also renders the board under React StrictMode, whose effect rehearsal runs setup, cleanup, and setup again, then verifies a completed cross-stage drag still clears the proxy and drop line.

## Browser pointer boundary

The isolated Chromium harness pressed a real card, moved it across columns with pointer capture active, observed the portalled proxy and sorted drop line, released over In Progress, and verified:

- the issue moved from Backlog to In Progress;
- the pointer-generated click did not open the card;
- the proxy portal was removed after release.

Command: `bun run test:browser -- --suite kanban-drag-boundary --project=chromium-desktop`

Result: 1 passed.

The companion screenshot captures the proxy and insertion line while the pointer is held.

## Coherence gate

Command: `bun run test`

Result: workspace typecheck passed; 4 files and 72 tests passed.

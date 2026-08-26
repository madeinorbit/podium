# The boundary gate on the epic: what this branch added, and what it did not

`bun run lint:boundaries` is red on the agent-runtime epic branch, and POD-2820 was
filed because three `apps/server` files had started importing packages whose manifest
entries restrict their consumers to the machine host. This is the measurement that
framed the fix, and the record of what is left.

## The measurement

Both numbers come from `bun scripts/check-boundaries.ts` — the whole of
`lint:boundaries` — run on a clean tree, once per branch:

| tree | commit | NEW architecture-manifest lines | dependency-boundary lines |
| --- | --- | ---: | ---: |
| `main` | `206693584` | 21 | 43 |
| epic tip (before this fix) | `35c1d1efd` | 31 | 42 |

**MAIN IS ALREADY RED.** That is the fact the whole exercise turns on and it was not
known when the issue was written. The gate cannot reach exit 0 from this branch, because
21 of the lines it prints are inherited: ten harness-identity branches in
`apps/web/src/features/setup/FirstTaskActivation.tsx`, four in the mobile screens, one in
`apps/daemon/src/control/credentials.ts`, a `manifest-browser-reach` in
`VpsFirstActivation.tsx`, a `ui-storage-ownership` in `use-update-state.ts`, four
`manifest-layer` lines on `apps/daemon/src/shipping/fixtures/server-recovery-worker.ts`
(which the epic has since fixed), plus the console-ownership baseline in
`apps/web/e2e` and `apps/mobile/e2e`.

So the honest exit criterion is not "exit 0". It is: **the epic's violation set is a
subset of main's.** Nothing red is this branch's doing.

Comparing the two sets by rule and file, the epic added **fourteen** lines.

## The four this issue fixed

| rule | file | what it wanted |
| --- | --- | --- |
| `manifest-consumers` | `apps/server/…/turn-preview.ts` | `streamItemIdOf` from `packages/agent-runtime` |
| `declared-deps` | `apps/server/…/turn-preview.ts` | the same import, also undeclared |
| `manifest-consumers` | `apps/server/…/runtime-event-gate.ts` | `AgentStateEvent` from `packages/harness` |
| `manifest-consumers` | `apps/server/…/session-wiring.ts` | `initialAgentState` / `reduceAgentState` / `AgentStateEvent` |
| `manifest-layer` | `apps/daemon/src/claude-sdk-isolation.test.ts` | three parser primitives from `scripts/architecture-manifest.ts` |

Declaring `@podium/agent-runtime` in `apps/server/package.json` silences `declared-deps`
and immediately exposes `manifest-consumers` underneath — which is the rule that means
it. The declaration was missing because the import should not have been there.

**Route taken: remove the imports (a), not widen the manifest (b).** Widening was
available and would have been defensible on the face of it — the server does now
legitimately handle runtime frames. It was rejected because of what it costs: adding
`apps/server` to `packages/agent-runtime`'s consumer list buys the server the WHOLE of
agent-runtime, drivers included, and nothing then stands between `turn-preview.ts`
needing one identity function today and a server module calling `launch()` tomorrow. The
consumer list is a whole-package grant; it cannot express "this function and no other".
So the question became: what did each file actually need, and is that thing a host
capability at all?

None of them were.

**`streamItemIdOf` moved down to `packages/transcript`.** It is two lines of cursor
arithmetic over a `TranscriptItem`, and the codec it calls — `decodeCursor` /
`encodeCursor` — already lives in that package. It was filed on the contract because
that is where the event types it joins are defined, not because deriving the join needs
a machine. `@podium/agent-runtime` re-exports it by name, so the contract surface the
drivers see is unchanged. `apps/server` already declares and imports `@podium/transcript`
(`memory/lake.ts`, `memory/transcript-indexer.ts`); the package restricts no consumers,
and L4 → L2 points down.

**The agent-state fold joined `@podium/harness/metadata`.** That entrypoint exists for
exactly this class, and it already carries the module NEXT DOOR: `compareProviderCursor`
from `agent-state/causal.ts`, admitted in POD-335 as "harness-AGNOSTIC … merely FILED in
this package". `agent-state/reducer.ts` and `agent-state/types.ts` import two and three
TYPES from `@podium/model` respectively and nothing else. They are total functions over
plain data — `(state, event, now) -> state` — that name no process and cannot observe a
host. What made them look like a capability was their address, not their content.

The alternative to sharing the reducer was a second one: the daemon's here, the server's
re-derived over there. Two folds of one event type do not stay the same function, and
the drift renders as a session whose phase depends on which side you asked.

### Why the two halves went different ways

`@podium/agent-runtime/metadata` already exists, is already a declared open entrypoint,
and its own header names the server's runtime-frame projection as the case it was built
for. So the one-line fix for `turn-preview.ts` was on the table: add `streamItemIdOf`
there and declare `@podium/agent-runtime` in `apps/server/package.json`. It was not
taken, and the rule that decided both halves is the same one:

> Prefer the function's TRUE HOME. Use the open entrypoint when the current home already
> IS the true home.

For the agent-state fold, `packages/harness` is the true home — the events are produced
by harness observers, and no lower package has any business with the reducer. Nothing to
move; open the narrow door, which is exactly what POD-335 did for `compareProviderCursor`
in the same directory.

For `streamItemIdOf`, it is not. The function is `encodeCursor({...decodeCursor(c),
offset: 0})` with a fallback — a thin wrapper over two primitives that live in
`packages/transcript`, which `packages/agent-runtime` already depends on FOR THOSE
PRIMITIVES. It was written on the far side of an edge it was already reaching across.
Moving it costs nothing at the boundary (`apps/server` gains no new dependency at all,
where the entrypoint route would have added one on a capability-restricted package) and
the contract keeps its named surface through a re-export, so the drivers see no change.

POD-2820's brief guessed `packages/protocol` as the destination. Protocol cannot take it:
it is L1 browser-safe with `deps: ['packages/model']`, and the cursor codec is L2
node-only. `packages/transcript` is the nearest plane that can hold the function and that
the server may reach.

`manifest-open-entrypoint` still holds the surface shut: no `export *`, no
process-driving export name, no direct process-API import. The list grew by two
functions and one type, each named, which is the review checkpoint the entrypoint exists
to force.

**The SDK-isolation guard is now classified build tier.** `manifest-layer` said
"apps/daemon imports UP into scripts", which was true about the path and false about the
file. `apps/daemon/src/claude-sdk-isolation.test.ts` does not exercise the daemon: it
reads the repository, walking the static import graph from every daemon-hosting entry
point to prove the Claude Agent SDK never enters the daemon's address space. Its only
imports are node builtins, vitest, and `extractImports` / `stripComments` / `isTestFile`
from the architecture manifest — the same tools `scripts/check-boundaries.ts` uses for
the same work. The alternative to importing them is a second import-graph parser, which
that file's own header explains is how such a guard rots.

This reuses the decision `APP_BUILD_TIER_RE` already made for `apps/<x>/scripts/**`:
classify honestly rather than exempt falsely. It is a NAMED SET rather than a pattern —
`*.test.ts` under an app is the wrong shape to widen on — and a test refuses a named file
that does not exist on disk, so a dead entry cannot sit there reading as a live decision.

## The ten that are left, and why they are not here

Every remaining epic-introduced line is rule `harness-branching`:

```
apps/daemon/src/runtime/opencode-attach.ts  x9   (258, 259, 359, 364, 374, 378 x2, 415, 417)
apps/server/src/modules/sessions/inbox.ts   x1   (538)
```

They are POD-2821. One rule, one shape of fix — name the capability the string literal
stands in for and read it off the harness manifest — and that is a taxonomy decision
about `packages/harness` that wants to be made once by one agent rather than guessed at
in halves. The daemon's nine are the substantial part: a per-kind attach label, launch
command, env set and credential-strip set that want to become a client-terminal
descriptor on each manifest. The server's one looks like a one-line tidy-up and is not:
`submitVerification` is true for grok as well as claude-code, so deleting the literal
would widen a readiness requirement rather than relocate it.

## Reproducing

```
bun scripts/check-boundaries.ts            # this branch
git worktree add --detach /tmp/base main   # and again there
```

Compare by rule and file rather than by line, since a line number moves for reasons that
are not violations:

```
awk '/^NEW architecture/,/^These are not/' out.txt \
  | grep -oE '^\s+\[[a-z-]+\] [^: ]+' | sed 's/^ *//' | sort | uniq -c
```

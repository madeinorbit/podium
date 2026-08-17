# apps/web typecheck: green, and the proof it can still say no

POD-2208. Written by session POD-2208-B as an independent verification of the fix
committed by POD-2208-A in `050269f24`.

## What was wrong

`PodiumClientApi.sendTurn` (the hand-written client mirror in
`packages/client-core/src/api.ts`) declared:

```ts
agentKind?: AgentKind   // 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor' | 'shell'
```

while the server's contract (`packages/commands/src/superagent/contracts.ts`,
`superagentSendTurnInput`) declared:

```ts
agentKind: HarnessAgent.optional()   // the same five, MINUS 'shell'
```

Both enums are deliberate and both live in `packages/model/src/entities/agent.ts`,
which documents the distinction on the line that decides this issue:

> `HarnessAgent` — the non-interactive harness surfaces the daemon can drive
> (`AgentKind` minus `'shell'`).

So the mirror was **too wide**, not the contract too narrow. A turn runs a
harness; a shell is spawnable but is not a harness — no transcript, no resume,
no observer. `sessions.create` rightly keeps the wider `AgentKind`, because
spawning a shell session *is* a real thing.

The fix narrows the mirror to `HarnessAgent`. It is safe because it removes a
promise the server never honoured: any caller passing `agentKind: 'shell'` was
already being rejected by zod at runtime. A repo-wide search found **no caller
that passes `'shell'` to `sendTurn`**, so nothing working stops working. No cast
and no `ts-expect-error` was used.

## Why one mismatch produced ten errors

`apps/web` binds `Store<TApi>`'s parameter to the real `TRPCClient<AppRouter>`,
which must satisfy the `TApi extends PodiumClientApi` constraint. The `agentKind`
incompatibility made `TRPCClient` fail to satisfy `PodiumClientApi`, so every
site touching the store failed too — the `SliceDefinition<Store<PodiumClientApi>>`
vs `SliceDefinition<Store>` family in `derivation.ts`, `spawn-row.tsx`,
`use-unified-work.ts` and `CommandPalette.tsx` was downstream of the same single
cause, not a second bug.

## The honest count, and what makes it honest

A worktree with no `node_modules` lets Node resolution walk up out of
`.worktrees` into the **main checkout**, so `apps/web` typechecks against main's
copy of the shared packages and reports an inflated ~38 with fake
missing-export entries. This worktree has its own hardlinked tree, and
resolution was proven local before any count was taken:

- all 24 `node_modules/@podium/*` entries resolve to
  `<this worktree>/packages/…`, none to the main checkout;
- `Bun.resolveSync('react')` lands inside this worktree.

Only then: **10 errors in 6 files** — matching the brief's prediction exactly.

## Verification

`bunx turbo run typecheck --filter=@podium/web --concurrency=1`

- **16/16 tasks successful, exit 0**, with a **cache miss** on `@podium/web`, so
  the green was executed rather than replayed from a cached result.

An empty failure list is not a pass, so the gate was proven **armed**: a
deliberate `const probe: number = 'not a number'` in `apps/web/src` was caught
as `error TS2322`, named this worktree's own file, and exited 1. The probe was
then removed.

The lane can now say no. Every worker on this epic can gate on a green instead
of a byte-identical failure-set comparison, and saves a base run each.

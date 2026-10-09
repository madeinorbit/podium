# Remaining sidebar and phone membership work

Step 1 evidence only, measured after POD-5822 landed. Production code and existing tests are unchanged.

Pilot baseline: `a3177c8f1718ad4ec9de051397c2790df3de57db`. The POD-5822 branch is an ancestor of this tip.

## Source findings

The desktop still has keyed structural section/band/group projections in `worklist/sidebar.ts`. Phone lists now use `@lazy({ equals: compareShallow })`, but per-section filters and cross-section flattening remain in `worklist/mobile.ts`. Worktree ordering now belongs to addressed data queries; filter copies remain in `worklist/worktree.ts`. Exact callers and fresh structural/heartbeat measurements are being collected.

No old implementation is deleted, so old/new mutation proof does not apply to this evidence-only pass.

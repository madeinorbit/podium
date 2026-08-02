# POD-1384 verification — composition graph documents current

**Candidate:** `4b947e7d7f2034f8565f6c0e532c5d61c5cf6deb`
**Date:** 2026-08-02T11:37:09Z

## Freeze-candidate context

At `6fc75d094e8c7adde42654a9b2acff78fda95377` the committed docs were stale
(176 modules / 283 edges; 51 declarations). Disposable generation expected
178 modules / 286 edges / 0 cycles and 52 declarations / 0 forward deps
(166 insertions / 161 deletions).

Regeneration already landed as `7509f2b4` (`chore(composition): regenerate after POD-1316/POD-1350`).
This check re-ran generation against current HEAD and confirmed the committed docs are bit-identical.

## Commands (all exit 0)

```
$ bun scripts/server-composition-graph.ts --write
wrote docs/architecture/server-composition-graph.md
$ bun scripts/server-construction-order.ts --write
wrote docs/architecture/server-construction-order.md
$ git status --porcelain docs/architecture/server-composition-graph.md docs/architecture/server-construction-order.md
(empty porcelain = docs already current; write was a no-op relative to HEAD)

$ bun scripts/server-composition-graph.ts
composition graph is acyclic and current (178 modules)
$ bun scripts/server-construction-order.ts
server construction order is topological and current
$ bun scripts/reactions-ledger.ts
reactions ledger is current (25 reactions)
$ bun run audit:composition
composition graph is acyclic and current (178 modules)
server construction order is topological and current
reactions ledger is current (25 reactions)
```

## Document summaries

```
docs/architecture/server-composition-graph.md:Runtime modules: 178. Runtime edges: 286. Cycles: 0.
docs/architecture/server-construction-order.md:Verified constructor declarations: 52. Forward dependencies: 0. Deferred service closures: 0. Non-null late bindings: 0.
```

## Negative / structural tests preserved

```
bun test v1.3.14 (0d9b296a)

scripts/server-composition-graph.test.ts:
(pass) server composition runtime imports > form a total topological order [888.78ms]
(pass) server composition runtime imports > fails loudly on a runtime import cycle [0.33ms]

scripts/server-construction-order.test.ts:
(pass) server construction order audit > accepts dependencies on earlier declarations [10.30ms]
(pass) server construction order audit > rejects a future service hidden inside a thunk [0.54ms]
(pass) server construction order audit > rejects a deferred closure around an already-constructed service [0.19ms]
(pass) server construction order audit > rejects non-null assertions and property reads before assignment [4.08ms]

scripts/reactions-ledger.test.ts:
(pass) generated reactions ledger > contains every registered reaction and every operational declaration [16.04ms]

 7 pass
 0 fail
 394 expect() calls
Ran 7 tests across 3 files. [1476.00ms]
```

## Verdict

Both generated records are current at this candidate. All three generators exit 0 without `--write`.
Negative tests (cycle detection, deferred thunks, non-null late binding, reactions totality) still pass.

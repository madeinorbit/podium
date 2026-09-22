# harness/lint — the lint fence (POD-4563, L6a)

One ESLint plugin (`fence-plugin.mjs`), the same rules for every round-three
arm. The package config (`../../eslint.config.mjs`) applies it to every folder
under `arms/`; `bun run lint` in this package runs it (and the MobX arm's own
rules). `fence-lint.test.ts` runs in the package test lane: every rule fires on
a planted file and stays quiet on its clean twin, and the real `arms/` lint
clean.

## The manifest: `arms/<folder>/fence.json`

Every folder under `arms/` except the frozen round-two arms (`hand`, `mobx`)
must carry one — a new arm cannot skip the fence by omitting it
(`arm-manifest`). Paths are relative to the arm folder; an entry ending in `/`
names a folder.

```json
{
  "enumeration": ["visible.ts"],
  "tables": ["issues", "sessions", "worktrees"],
  "store": ["store.ts", "pool/"],
  "rows": ["react/row.tsx"]
}
```

- `enumeration` — EXACTLY ONE module: the visible-set builder, the only place
  a shared table may be enumerated. The arm's `README.md` must name it (the
  explicit allow-list the reviewer reads).
- `tables` — the names the arm's shared entity tables are reached by
  (`pool.issues`, `issues`, `pool['issues']`).
- `store` — the store and pool modules no component may import by value.
- `rows` — the row component modules (also caught as component files when
  they contain JSX).

Then add the arm to `harness/src/roster.ts`; `fences.test.tsx` requires the
roster and the manifests to name the same folders.

## Rules

| rule | fails on | why |
|---|---|---|
| `arm-manifest` | an arm folder with no or an invalid `fence.json`, more than one enumeration module, a README that does not name it | a fence an arm can opt out of is not a fence |
| `no-table-walk` | `.values()` `.keys()` `.entries()` `.forEach()` `for…of` `for…in` spread `Array.from` `Object.keys/values/entries` `new Map/Set(…)` over a declared table, outside the enumeration module | a whole-table walk costs the corpus, not the change; the K exercises' F foot-gun |
| `no-store-in-component` | a component file (JSX) or row module whose VALUE imports reach a store module, directly or through arm-local helpers (the chain is named); `import type` is fine | a row gets its `RowView` and nothing else (L1b addendum); a list gets the store through props |
| `row-component-module-scope` | `<RowShell component={…}>` / `createElement(RowShell, { component })` with an inline expression or a function-scope identifier | a closure is how a store gets into a row (L1b addendum); `RowShell` already throws on identity change |
| `no-wall-clock` | `Date.now` anywhere in `arms/` (tests and frozen arms too); `new Date()` / `Date()` with no argument outside tests | time is `SliceLocals.coarseNow` |
| `no-hidden-state` | module-scope `let`/`var`, module-scope `new Map/Set/WeakMap/WeakSet/Array`, module-scope `observable(…)`; `#private` class fields | untracked state (pitfall j), and state the copy sweep cannot reach |

## What the lint does not see

Syntactic only: an alias (`const t = pool.issues; for (const x of t)`) and a
walk over an arm's own per-row caches pass it. The runtime fences cover the
first (the reads fence counts every table iteration); walks over caches are a
review item. Closure-held state is invisible to the copy sweep
(`shared/src/instrument/reads.ts`) and also a review item.

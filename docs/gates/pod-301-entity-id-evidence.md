# POD-301 — branded ids everywhere: the detector, and the flip

**Status: COMPLETE.** Branch `issue/301-1-3-branded-ids-everywhere-flip-z-string`, four
commits on top of `issue/279-integration` at `0895e7d9`. This answers B1 of
`docs/gates/pod-423-phase-1-exit-gate.md`, which held Phase 1 open.

---

## 1. The instrument that did not exist

POD-423's finding was exact and is confirmed: `scripts/rearch-audit-baseline.json` had no
raw-string-id key and `scripts/rearch-audit.ts` had no detector. The zero POD-363 reported
was the `POD-361-EDGE-CAST` marker count — a different thing, genuinely zero.

`scripts/entity-id-audit.ts` is the detector. Three keys now exist in the baseline:

| Key | Before | After | Phase |
|---|---|---|---|
| `raw-string-entity-ids` | *(did not exist)* → 47 | **0** | POD-301 |
| `machine-id-unbranded-fields` | *(did not exist)* → 38 | 38 | POD-318 |
| `unbranded-by-decision-ids` | *(did not exist)* → 2 | 13 | POD-301 |

Deletion audit: **25 items / 186 sites → 28 items / 237 sites.** The item count rose because
three kinds of debt became measurable; every one of them may now only fall.

### It enumerates the concept, not one spelling

POD-423 measured 66 sites with a grep over eight field names and said plainly it could not
see a ninth. Neither half of this predicate is a literal list:

- **The vocabulary is derived** at runtime from `packages/model`'s `<Brand>IdField` exports.
  A field denotes a brand when its name IS or ENDS IN `<brand>Id`, so `targetSessionId`,
  `lastSessionId`, `sourceMachineId` and `deletedByIssueId` are in scope with nobody listing
  them. **Measured: 79 raw sites where the eight-name grep found 66.**
- **The position is scanned, not line-matched**, and classified per SITE into
  `zod-string` / `zod-branded` / `carveout-marker` / `db-column` / `ts-string` / `other`.

Both spellings of "an entity id field" are covered: a `<brand>Id` key at any depth, and a
bare `id:` on a declaration whose name denotes a brand.

### It can say NO — measured, not asserted

Four mutants, applied one at a time, each with match-count == 1 verified and the file hash
restored afterwards:

| Mutant | Result |
|---|---|
| Remove the qualified-name arm of `brandOfKey` | **2 tests fail** |
| Make the `UNBRANDED` excuse token case-insensitive | **1 test fails** |
| Set `MIN_ID_FIELD_SITES` to 0 | **1 test fails** |
| Stop classifying `*IdField` as branded | **1 test fails** (the live-tree anchor) |

Plus two structural refusals: `assertBrandsLoaded` throws on an empty vocabulary, and
`entityIdSites` throws when the population falls below 1800 (measured: 2567). The raw count
is free to fall to zero; the POPULATION is not, because every flipped site becomes a branded
one.

---

## 2. The flip: 47 → 0

**VANISHED versus MOVED, by arithmetic rather than assertion.** Because the detector
classifies the whole population, the two classes can be read against each other:

```
zod-string    79 →  43   (−36)
zod-branded  129 → 165   (+36)
population  2565 → 2567  (unchanged)
```

Every one of the 36 flipped sites is still present and is now counted as branded. None was
deleted, renamed out of reach, or excused. The other 11 of the original 47 were reclassified
as `UNBRANDED BY DECISION` in a separate commit, where the audit total was **273 before and
273 after** — a pure reclassification.

Validation is preserved exactly: a constrained field became
`z.string().min(1).max(256).pipe(XIdField)`, never a bare `XIdField`, because dropping a
`.max()` would be a behaviour change wearing a type change's clothes.

### What was deliberately NOT flipped

| Class | Count | Why |
|---|---|---|
| Machine ids | 38 | ADR 1 Amendment 2 D16.2 forbids adopting `MachineId` before POD-318 retires `local`/`__local__` — branding a sentinel launders it. Counted under POD-318 so the debt stays visible. |
| Harness/provider session ids | 13 | The PROVIDER's id space, not Podium's. `AgentObservation` declares branded `podiumSessionId` and raw `providerSessionId` on adjacent lines and that is correct. |
| Polymorphic ids | — | `workflowAssignInput.targetId`, `MessageRow.toId`: the entity is decided by a sibling `kind`, so branding at the declaration forces a false choice (POD-362, upheld). |
| `IssueComment.id` | 1 | POD-423 named it a defect. It is not: a comment has its own id space, and `IssueId` there would be a well-typed lie. |

---

## 3. Verification

| Lane | Result |
|---|---|
| `bun run typecheck --force` | **exit 0** — `23 successful, 23 total` / **`Cached: 0 cached`** |
| `bun run test` (full) | **exit 0** — **7704 passed**, 19 skipped, **0 failed**; + 1362 web |
| scripts lane (explicit) | **exit 0** — 20 files, **380 tests** |
| Wire goldens (both suites) | **exit 0** — **176 passed**; **no `.fixtures.ts` in the diff** |
| `rearch-audit` | exit 0 — 28 items, 237 sites, baseline exact |
| `check-boundaries` | exit 0 — **56 allowlisted, 0 new** |
| `check-no-nul-bytes` | exit 0 |
| `audit-{issue,session,workflow,fleet,mail,superagent}-commands` | **6/6 exit 0** |
| `representation-audit`, `change-row-audit` | exit 0 |
| `migration:check`, `migration:manifest --check` | exit 0 (no schema touched) |

The daemon-reconnect tests the brief named as load-flaky (POD-1184) passed in this run.

---

## 4. Two gate reds I caused, and fixed

1. **`check-boundaries`** — genuinely mine. `apps/janitor` gained an `@podium/model` import
   without declaring the dependency. Declared, `bun install` re-run.
2. **`audit-issue-commands`** — not a restatement but a REFLOW. One added import pushed
   `ISSUE_COMMAND_NAMES = Object.keys(ISSUE_CONTRACTS).sort()` past the line limit, biome
   split it across three lines with a magic trailing comma, and a line-anchored matcher read
   the intact derivation as a literal. Fixed at the matcher, because hand-formatting the
   declaration is undone by the next `bun run format`. **The relaxation does not cost the
   check its refusal:** `--probe` reports 11/11 planted fixtures found, and replacing the
   derivation with a real literal still fires and exits 1.

---

## 5. Limits — stated, because a grep audit is never sufficient

1. **Only zod field positions are ratcheted.** The same scan classifies **68 drizzle
   columns** and **725 hand-written TS members** and prints them under
   `bun scripts/entity-id-audit.ts --sites`, but neither is in a baseline key: a column is
   branded with drizzle's `$type<>()` and most TS members are `z.infer`-derived. **A zero
   here means "no zod schema declares a raw entity id", not "no raw entity id exists".**
2. **One composite-key residue survives, and it is a test double.**
   `packages/sync/src/mirror.test.ts`'s `FakeMirrorStore` keys its internal `Map` with
   `` `${machineId}\n${nativeId}` `` and filters with `startsWith`. Production adopted
   `machineScopedKey`/`resumeKey` at POD-362/363 — verified before this issue began — so the
   AC's "only the helpers' own implementation" holds for live code, but strictly this is a
   third hit and is reported rather than claimed clean.
3. **`scripts/` is typechecked by no lane.** The root `tsconfig.json` is solution-style
   (`"files": []`) and no config includes `scripts/`. The new detector was typechecked
   against an ad-hoc config, probed by injecting a deliberate error and confirming it was
   reported. This is a pre-existing gap, filed rather than fixed here.
4. **A brand can still be widened downstream.** The detector sees the declaration, not what
   a consumer does with the value.

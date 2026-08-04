# Update story, Phase 7: the expand-only migration gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce that migrations are additive, so rolling back one release never needs a down migration.

**Architecture:** One audit gate in the established `scripts/audit-*.ts` shape: it scans generated migration SQL for destructive DDL, holds a small explicit allowlist for the deliberate exceptions, and carries a `--probe` mode that proves every check can fire.

**Tech Stack:** TypeScript, Bun.

**Spec:** `docs/internal/superpowers/specs/2026-08-04-coherent-update-story-design.md`, §13.2. Gap item 18.

**Depends on:** nothing. Can run in parallel with any other phase. It is most valuable *early*, because every migration written before it lands is a migration it never checked.

## Global Constraints

- **Follow the existing gate idiom exactly.** See `scripts/audit-wire-adapters.ts`: a shebang, a docstring stating what the gate is for and why the thing it guards survives by default, the three modes (`bare` exits 1 on a finding, `--json`, `--probe`), and a `package.json` script entry.
- **`--probe` is mandatory, not optional polish.** A gate whose pass has never been distinguished from "the check could not fire" is not evidence. The probe must prove every individual check can say yes.
- **The allowlist holds SITES, not reasons.** Prose next to an exception goes stale and the gate never reads it. Every entry is a path plus a one-line justification that a reviewer must delete or re-justify when touching it.
- **This gate is about ROLLBACK, not about tidiness.** A forward migration that drops a column cannot be inverted; the data is gone. Expand-only is what makes a one-release rollback a plain binary swap.
- Run `bun run typecheck` and trust a cache hit.

---

## File Structure

**Created:**
- `scripts/audit-expand-only-migrations.ts`
- `scripts/audit-expand-only-migrations.test.ts`

**Modified:**
- `package.json` — an `audit:expand-only` script, and inclusion in whatever aggregate the other audits run under.
- `docs/data-and-upgrades.md` — document the policy the gate enforces.

---

## Task 1: The gate

**Files:**
- Create: `scripts/audit-expand-only-migrations.ts`, `.test.ts`

**Interfaces:**
- Produces: `findDestructiveDdl(sql: string): Array<{ statement: string; kind: 'drop-table' | 'drop-column' | 'rename' | 'table-rebuild' | 'not-null-without-default' }>`

**Why `not-null-without-default` is on the list:** adding a `NOT NULL` column with no default is additive in name only. It fails against existing rows, and where it succeeds, the *old* binary cannot insert without knowing the column, so the rollback breaks writes. It is a contract change wearing an `ADD COLUMN`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { findDestructiveDdl } from './audit-expand-only-migrations'

describe('findDestructiveDdl', () => {
  it('passes a plain additive column', () => {
    expect(findDestructiveDdl('ALTER TABLE machines ADD COLUMN app_version text;')).toEqual([])
  })

  it('passes several additive columns', () => {
    const sql = `ALTER TABLE machines ADD COLUMN a text;
ALTER TABLE machines ADD COLUMN b text;`
    expect(findDestructiveDdl(sql)).toEqual([])
  })

  it('passes a new table and a new index', () => {
    const sql = `CREATE TABLE t (id text PRIMARY KEY);
CREATE INDEX t_idx ON t (id);`
    expect(findDestructiveDdl(sql)).toEqual([])
  })

  it('catches DROP TABLE', () => {
    expect(findDestructiveDdl('DROP TABLE machines;')[0].kind).toBe('drop-table')
  })

  it('catches DROP COLUMN', () => {
    expect(findDestructiveDdl('ALTER TABLE machines DROP COLUMN app_version;')[0].kind).toBe(
      'drop-column',
    )
  })

  it('catches a RENAME', () => {
    expect(
      findDestructiveDdl('ALTER TABLE machines RENAME COLUMN a TO b;')[0].kind,
    ).toBe('rename')
  })

  it('catches the SQLite table-rebuild dance', () => {
    // drizzle emits this for changes SQLite cannot do in place. It is a full
    // rewrite wearing three innocent statements.
    const sql = `CREATE TABLE __new_machines (id text PRIMARY KEY);
INSERT INTO __new_machines SELECT id FROM machines;
DROP TABLE machines;
ALTER TABLE __new_machines RENAME TO machines;`
    expect(findDestructiveDdl(sql).map((f) => f.kind)).toContain('table-rebuild')
  })

  it('catches NOT NULL with no default, which is additive in name only', () => {
    // The old binary does not know the column, so it cannot insert. The rollback
    // breaks writes even though nothing was dropped.
    expect(
      findDestructiveDdl('ALTER TABLE machines ADD COLUMN k text NOT NULL;')[0].kind,
    ).toBe('not-null-without-default')
  })

  it('passes NOT NULL WITH a default', () => {
    expect(
      findDestructiveDdl("ALTER TABLE machines ADD COLUMN k text NOT NULL DEFAULT '';"),
    ).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(findDestructiveDdl('drop table machines;')[0].kind).toBe('drop-table')
  })

  it('ignores the words inside a comment', () => {
    expect(findDestructiveDdl('-- we will DROP TABLE machines one day\nSELECT 1;')).toEqual([])
  })

  it('ignores the words inside a string literal', () => {
    expect(
      findDestructiveDdl("INSERT INTO notes (body) VALUES ('DROP TABLE machines');"),
    ).toEqual([])
  })

  it('reports the offending statement so a human can see what it caught', () => {
    const f = findDestructiveDdl('ALTER TABLE machines DROP COLUMN app_version;')[0]
    expect(f.statement).toContain('DROP COLUMN')
  })

  it('reports every finding, not just the first', () => {
    const sql = `DROP TABLE a;
ALTER TABLE b DROP COLUMN c;`
    expect(findDestructiveDdl(sql)).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:unit -- scripts/audit-expand-only-migrations.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Implement**

Strip comments and string literals **first**, then match. Doing it the other way round produces a gate that fires on prose, which teaches everyone to add allowlist entries and quietly kills the gate.

Lead the file in the house style:

```ts
#!/usr/bin/env bun
/**
 * THE EXPAND-ONLY GATE for schema migrations.
 *
 *   bun run audit:expand-only            # the gate — exit 1 on any finding
 *   bun run audit:expand-only --json
 *   bun run audit:expand-only --probe    # prove every check can say YES
 *
 * WHY THIS EXISTS
 *
 * Podium's migrations are forward-only, and that is the right choice: a forward
 * migration that drops a column or coalesces rows CANNOT be inverted, because the
 * data is gone. A `down` that appears to work is a false comfort.
 *
 * What replaces it is discipline: additive changes ship in release N, and the
 * destructive contract step ships no earlier than N+1. Then rolling back one
 * release needs no down migration at all, because the older binary simply ignores
 * columns it does not know. That turns rollback into a plain binary swap, which
 * is the property the whole update story leans on.
 *
 * Discipline that nothing checks is a preference. This is the check.
 */
```

- [ ] **Step 4: Run to verify it passes**

Expected: PASS, all fourteen cases.

- [ ] **Step 5: Run the gate against the real migration history**

```bash
bun scripts/audit-expand-only-migrations.ts --json
```

**Expect findings.** This repository has migrations predating the policy, including table rebuilds. Do **not** loosen the checks to make history pass. Add the existing offenders to the allowlist with a one-line justification each, so the gate protects everything from here forward. A gate that only passes because its checks were weakened protects nothing.

- [ ] **Step 6: Implement `--probe`**

For each check kind, feed it a synthetic statement that must trip it, and fail if any check does not fire. This is what separates "the gate passed" from "the gate could not have failed".

- [ ] **Step 7: Wire it up**

Add `"audit:expand-only"` to `package.json` next to the other audits, and include it wherever the audit family runs in CI.

- [ ] **Step 8: Commit**

```bash
git add scripts/audit-expand-only-migrations.ts scripts/audit-expand-only-migrations.test.ts package.json
git commit -m "feat(gates): expand-only migration audit with a probe mode (POD-1670)"
```

---

## Task 2: Document the policy

**Files:**
- Modify: `docs/data-and-upgrades.md`

That document already explains forward-only migrations, downgrade protection, and the automatic pre-migration backups. Add the expand-and-contract policy and what it buys: a one-release rollback is a binary swap, needing no database work at all. Name the gate so a reader who trips it knows what it wants.

- [ ] **Step 1: Write it, then commit**

```bash
git add docs/data-and-upgrades.md
git commit -m "docs(upgrades): expand-only migration policy (POD-1670)"
```

---

## Verification for the whole phase

- [ ] `bun run typecheck`, `bun run test:unit` pass.
- [ ] `bun run audit:expand-only` exits 0 on the current tree (with the historical allowlist in place).
- [ ] `bun run audit:expand-only --probe` proves every check can fire.
- [ ] **Plant a violation and watch it fail.** Add a `DROP COLUMN` to a scratch migration, confirm the gate exits 1 and names it, then revert. A gate nobody has seen fail is not evidence.
- [ ] The allowlist contains only pre-existing migrations, each with a one-line justification. No entry was added to make a *new* migration pass.

---

## Out of scope, on purpose

- Rewriting any existing migration. History is allowlisted, not edited.
- Down migrations, which the spec rejects in §13.2.
- Automatic backup restore on rollback, which stays a documented human action.

# M4 — State-Directory Build Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every release attempt leaves a durable record under `<stateDir>/builds/<buildId>/` — what was approved, which Turbo hashes hit or missed, the client root digest, every platform artifact and signature, timings, and the outcome — and the publisher, retention sweep and feed read that record instead of `dist-bun/` in the live checkout.

**Architecture:** A small pure module `apps/server/src/modules/updates/build-record.ts` owns the record's path, schema, writes (atomic, append-outcome) and listing. The coordinator (`scripts/release.ts`) writes the client/turbo half of the record via a `--record <dir>` flag; `dev-bundle.ts` mints the `buildId` after the child returns and verification passed, moves artifacts into the record, and finalises the outcome. Retention walks `builds/*/manifest.json`. Timing JSONL moves into the record.

**Tech Stack:** Bun, TypeScript, vitest.

**Spec:** `docs/internal/superpowers/specs/2026-08-28-cached-release-build-design.md` §6, §11 M4. Requires M3 merged.

## Global Constraints

- `buildId` is minted only after `verifyClientBuild` passed and every platform compiled; it never appears in any Turbo-cached path or file.
- Records are written atomically (`write tmp` + `rename`), the outcome field only advances (`validated` → `signed` → `published`; any step may go to `failed:<step>`), and a record is never rewritten from scratch.
- Retention counts PUBLISHES (records), not files; a file a retained record names is never deleted.
- Scoped typecheck; commits with `Podium-Issue:` trailer.

---

### Task 1: `build-record.ts` — schema, paths, atomic write, list

**Files:**
- Create: `apps/server/src/modules/updates/build-record.ts`
- Test: `apps/server/src/modules/updates/build-record.test.ts`

**Interfaces:**
```ts
export type BuildOutcome = 'validated' | 'signed' | 'published' | `failed:${string}`
export interface BuildRecord {
  recordVersion: 1
  buildId: string                       // `${stamp}-${sha}` e.g. 20260828T131500Z-dc0a8cf
  approvedSha: string
  version: string
  platforms: string[]
  client: { rootDigest: string; sourceCommit: string; tasks: Record<string, { hash: string; cache: 'HIT' | 'MISS' }> }
  artifacts: Array<{ platform: string; file: string; size: number; digest: string; signature: string }>
  signingKeyFingerprint: string
  startedAt: string
  outcome: BuildOutcome
  outcomeAt: string
}
export function buildRecordDir(stateDir: string, buildId: string): string          // <stateDir>/builds/<buildId>
export function buildRecordPath(stateDir: string, buildId: string): string         // …/manifest.json
export function mintBuildId(stamp: string, sha: string): string
export function writeBuildRecord(stateDir: string, record: BuildRecord): void       // atomic; refuses to regress outcome
export function readBuildRecord(stateDir: string, buildId: string): BuildRecord | null
export function listBuildRecords(stateDir: string): BuildRecord[]                   // newest first by buildId
export function advanceOutcome(stateDir: string, buildId: string, outcome: BuildOutcome, at?: Date): BuildRecord
```

- [ ] **Step 1: Failing tests**

```ts
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { advanceOutcome, listBuildRecords, mintBuildId, readBuildRecord, writeBuildRecord, type BuildRecord } from './build-record'

const base = (id: string): BuildRecord => ({
  recordVersion: 1, buildId: id, approvedSha: 'dc0a8cf', version: '0.1.1-dev.15+dc0a8cf', platforms: ['linux-x86_64'],
  client: { rootDigest: 'a'.repeat(64), sourceCommit: 'dc0a8cf', tasks: { '@podium/web#build': { hash: 'h1', cache: 'HIT' }, '@podium/mobile#build': { hash: 'h2', cache: 'MISS' } } },
  artifacts: [], signingKeyFingerprint: 'fp', startedAt: '2026-08-28T13:15:00.000Z', outcome: 'validated', outcomeAt: '2026-08-28T13:15:30.000Z',
})

describe('build records', () => {
  it('mints <stamp>-<sha>', () => expect(mintBuildId('20260828T131500Z', 'dc0a8cf')).toBe('20260828T131500Z-dc0a8cf'))
  it('writes and reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-record-'))
    writeBuildRecord(dir, base('20260828T131500Z-dc0a8cf'))
    expect(readBuildRecord(dir, '20260828T131500Z-dc0a8cf')).toEqual(base('20260828T131500Z-dc0a8cf'))
    expect(existsSync(join(dir, 'builds', '20260828T131500Z-dc0a8cf', 'manifest.json.tmp'))).toBe(false)
  })
  it('advances outcome forward and refuses to regress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-record-'))
    writeBuildRecord(dir, base('x-1'))
    expect(advanceOutcome(dir, 'x-1', 'signed').outcome).toBe('signed')
    expect(advanceOutcome(dir, 'x-1', 'published').outcome).toBe('published')
    expect(() => advanceOutcome(dir, 'x-1', 'signed')).toThrow(/cannot move build x-1 from published back to signed/)
  })
  it('failed:<step> is terminal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-record-'))
    writeBuildRecord(dir, base('x-2'))
    advanceOutcome(dir, 'x-2', 'failed:sign')
    expect(() => advanceOutcome(dir, 'x-2', 'signed')).toThrow(/terminal/)
  })
  it('lists newest first and skips unreadable records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-record-'))
    writeBuildRecord(dir, base('20260828T130000Z-aaaaaaa'))
    writeBuildRecord(dir, base('20260828T131500Z-bbbbbbb'))
    expect(listBuildRecords(dir).map((r) => r.buildId)).toEqual(['20260828T131500Z-bbbbbbb', '20260828T130000Z-aaaaaaa'])
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts apps/server/src/modules/updates/build-record.test.ts`.

- [ ] **Step 3: Implement**

```ts
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ORDER: Record<Exclude<BuildOutcome, `failed:${string}`>, number> = { validated: 0, signed: 1, published: 2 }

export function buildRecordDir(stateDir: string, buildId: string): string { return join(stateDir, 'builds', buildId) }
export function buildRecordPath(stateDir: string, buildId: string): string { return join(buildRecordDir(stateDir, buildId), 'manifest.json') }
export function mintBuildId(stamp: string, sha: string): string { return `${stamp}-${sha}` }

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

export function writeBuildRecord(stateDir: string, record: BuildRecord): void {
  mkdirSync(buildRecordDir(stateDir, record.buildId), { recursive: true })
  const existing = readBuildRecord(stateDir, record.buildId)
  if (existing) assertForward(existing.buildId, existing.outcome, record.outcome)
  writeAtomic(buildRecordPath(stateDir, record.buildId), `${JSON.stringify(record, null, 2)}\n`)
}

export function readBuildRecord(stateDir: string, buildId: string): BuildRecord | null {
  try {
    const raw = JSON.parse(readFileSync(buildRecordPath(stateDir, buildId), 'utf8')) as BuildRecord
    return raw.recordVersion === 1 && raw.buildId === buildId ? raw : null
  } catch { return null }
}

export function listBuildRecords(stateDir: string): BuildRecord[] {
  let names: string[]
  try { names = readdirSync(join(stateDir, 'builds')) } catch { return [] }
  return names.sort().reverse().map((id) => readBuildRecord(stateDir, id)).filter((r): r is BuildRecord => r !== null)
}

function assertForward(buildId: string, from: BuildOutcome, to: BuildOutcome): void {
  if (from === to) return
  if (from.startsWith('failed:')) throw new Error(`build ${buildId} outcome ${from} is terminal`)
  if (to.startsWith('failed:')) return
  if (ORDER[to as keyof typeof ORDER] < ORDER[from as keyof typeof ORDER]) throw new Error(`cannot move build ${buildId} from ${from} back to ${to}`)
}

export function advanceOutcome(stateDir: string, buildId: string, outcome: BuildOutcome, at = new Date()): BuildRecord {
  const current = readBuildRecord(stateDir, buildId)
  if (!current) throw new Error(`no build record ${buildId}`)
  assertForward(buildId, current.outcome, outcome)
  const next = { ...current, outcome, outcomeAt: at.toISOString() }
  writeAtomic(buildRecordPath(stateDir, buildId), `${JSON.stringify(next, null, 2)}\n`)
  return next
}
```
(Declare the exported types above these functions exactly as in the Interfaces block.)

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — "updates: build record module".

---

### Task 2: The coordinator writes the client half (`--record <dir>`)

**Files:**
- Modify: `scripts/release.ts` (`RELEASE_OPTIONS` add `'--record': 'value'`; `prepareHeadlessCross` writes `<dir>/client.json`)
- Test: `scripts/release.test.ts`

**Interfaces:**
- `<record dir>/client.json` = `{ rootDigest, sourceCommit, version, tasks }` taken verbatim from the `ClientBuildEvidence` (M2 Task 4 shape). Written after evidence is minted, before any platform is packaged.

- [ ] **Step 1:** Test: `prepareHeadlessCross` with a stubbed `beginFreshClientPackagingSession` (the test file already stubs it — follow the existing pattern) and `--record <tmp>` produces `client.json` with the four fields and `tasks` keyed by the two task ids.
- [ ] **Step 2:** Implement: after `const session = await beginFreshClientPackagingSession([])`, if `recordDir` given: `mkdirSync(recordDir, { recursive: true }); writeFileSync(join(recordDir, 'client.json'), JSON.stringify({ rootDigest: session.clientRootDigest, sourceCommit: session.sourceCommit, version: session.version, tasks: session.taskHashes ? Object.fromEntries(Object.keys(session.taskHashes).map((t) => [t, { hash: session.taskHashes![t], cache: session.cache![t] }])) : {} }, null, 2) + '\n')`.
- [ ] **Step 3:** Run test + scoped typecheck. Commit — "release: record client evidence for the ledger".

---

### Task 3: The publisher mints the record and moves artifacts into it

**Files:**
- Modify: `apps/server/src/modules/updates/dev-bundle.ts` (`buildDevBundle`: artifact root, record minting; `defaultSpawnBuild`: pass `--record`; `BuiltDevBundle` gains `buildId`)
- Modify: `apps/server/src/modules/updates/dev-publisher-wiring.ts:560-600` (`publishToFeed` → `advanceOutcome(…, 'published')`)
- Test: `dev-bundle.test.ts`, `dev-publisher-wiring.test.ts`

- [ ] **Step 1: Failing test** in `dev-bundle.test.ts`:
```ts
it('writes a validated→signed build record naming every artifact', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'podium-state-'))
  const built = await buildDevBundle({ ...baseDeps, publisherStateDir: stateDir, platforms: ['linux-x86_64'], spawnBuild: async ({ artifacts, recordDir }) => { writeFileSync(join(recordDir, 'client.json'), JSON.stringify({ rootDigest: 'a'.repeat(64), sourceCommit: 'dc0a8cf', version: '0.1.1-dev.1+dc0a8cf', tasks: {} })); for (const a of artifacts) writeSigned(a.artifactPath) } })
  const record = readBuildRecord(stateDir, built.buildId)
  expect(record?.outcome).toBe('signed')
  expect(record?.artifacts.map((a) => a.platform)).toEqual(['linux-x86_64'])
  expect(existsSync(join(stateDir, 'builds', built.buildId, 'bundles', record!.artifacts[0]!.file))).toBe(true)
})
```
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** in `buildDevBundle`:
  - Before spawning: `const pendingDir = join(publisherStateDir, 'builds', `.pending-${stamp}-${sha}`)`; `mkdirSync(join(pendingDir, 'bundles'), { recursive: true })`. Artifact paths are now `join(pendingDir, 'bundles', artifactNames[i])`. `DevBuildSpawnContext` gains `recordDir: string` (= `pendingDir`); `defaultSpawnBuild` appends `'--record', ctx.recordDir`.
  - After the child returns and every `describe-artifact` step passed: `const buildId = mintBuildId(stamp, sha)`; `renameSync(pendingDir, buildRecordDir(publisherStateDir, buildId))`; read `client.json`; `writeBuildRecord(publisherStateDir, { recordVersion: 1, buildId, approvedSha: sha, version, platforms, client, artifacts: artifacts.map(a => ({ platform: a.platform, file: basename(a.path), size: a.size, digest: a.digest, signature: a.signature })), signingKeyFingerprint: devBundleKeyFingerprint(deps.signingKey), startedAt, outcome: 'signed', outcomeAt: now })`. (`validated` is the state between client verification and signing; the child signs in-process, so the first record the server writes is already `signed`. A child failure writes `outcome: 'failed:<step>'` from the caught error's step label and keeps the pending dir renamed to the buildId for forensics.)
  - `artifacts[].path` values are updated to the renamed location before returning `BuiltDevBundle` (now with `buildId`).
  - `devBundleDirectory(root)` callers: `readExistingDevBundle` (restore after restart) reads `listBuildRecords(stateDir)[0]` with `outcome === 'signed' | 'published'` and the same `approvedSha`, and returns its artifacts; `sweepDevBundles` is called with `dir = join(stateDir, 'builds')` in Task 4's new shape.
- [ ] **Step 4:** In `publishToFeed` after `publisher.publishFeed()` returns true: `advanceOutcome(stateDir(), current.buildId, 'published')`. `publisher.current()` must expose `buildId` (add to the descriptor type).
- [ ] **Step 5:** Run both test files + scoped typecheck. Commit — "updates: mint the build record and move artifacts into it".

---

### Task 4: Retention walks records

**Files:**
- Modify: `apps/server/src/modules/updates/dev-bundle.ts` (`rememberDevArtifact`, `seedPublisherStateFromArtifact`, `selectDevBundleSweep`, `sweepDevBundles`)
- Modify: `apps/server/src/modules/updates/dev-publisher-state.ts` (`retainedArtifacts: string[]` → `retainedBuilds: string[]`, with a one-time migration reading the old field)
- Test: `dev-bundle.test.ts` sweep tests, `dev-publisher-state.test.ts`

- [ ] **Step 1: Failing tests** — rewrite the existing sweep tests in terms of build ids: given records `b1..b4` (newest first) and `retain = 2`, the sweep removes the directories of `b3`, `b4` unless a record is `outcome: published` and referenced by the served manifest (`lastPublishedSha`), and never removes a `.pending-*` directory younger than 1 h. Add: `failed:*` records older than the retain window are removed.
- [ ] **Step 2: Implement** — `selectDevBundleSweep(records: BuildRecord[], { retain, protect: buildIds, referenced: buildIds })` returns build ids to remove; `sweepDevBundles(fs, stateDir, options)` removes `builds/<id>` recursively. `rememberDevArtifact` → `rememberDevBuild({ stateDir, buildId, retain })` returns retained ids; `seedPublisherStateFromArtifact` → `seedPublisherStateFromRecords(stateDir)` derives from `listBuildRecords`. Migrate persisted state: on read, if `retainedArtifacts` exists and `retainedBuilds` does not, set `retainedBuilds: []` and leave the old field (the old `dist-bun` files are outside the ledger and are cleaned up by hand once, documented in Task 6).
- [ ] **Step 3:** Run + commit — "updates: retention by build record".

---

### Task 5: Timing into the record; feed serves from the record

**Files:**
- Modify: `apps/server/src/modules/updates/dev-publisher-wiring.ts:267` (`outputDirectory`) — the timing sink becomes `join(stateDir(), 'builds', '.timing')` during the build and the file is moved into `builds/<buildId>/timing.jsonl` when the record is minted (Task 3 step; add the `renameSync`).
- Modify: the artifact-serving route (grep `dev-artifact-token` and `devBundleDirectory` in `apps/server/src`) to resolve `<stateDir>/builds/<buildId>/bundles/<file>` from `publisher.current()`.
- Test: the route's existing test; `release-build-timing.test.ts` for the new default dir.

- [ ] Implement, run, commit — "updates: serve and time from the build record".

---

### Task 6: `dist-bun/` retired as artifact root; docs; handoff

- [ ] `grep -rn "dist-bun" apps/server/src docs/updating-a-dev-instance.md docs/update-release-swaps.md` — every publisher-path hit now names the record dir; `dist-bun/` stays only for `scripts/` local builds and CI staging (`dist-bun/release`).
- [ ] `docs/updating-a-dev-instance.md`: the repair section's artifact selection reads `~/.podium/builds/<buildId>/bundles/…`; add a "Build records" subsection describing `manifest.json` fields and outcomes.
- [ ] One-time cleanup note for the publisher host: after the first successful record, delete stale `dist-bun/podium-headless-*` in the publisher's source root by hand.
- [ ] CI: `release.yml` passes `--record dist-bun/release/record` and uploads it with the assets (`actions/upload-artifact`).
- [ ] Scoped typechecks, the unit files above, `named-dev-release.integration.bun.test.ts` (heavy lease). After one real approval: `cat ~/.podium/builds/<id>/manifest.json` shows `outcome: published` and both task hashes. Attach it as the issue artifact.
- [ ] `podium issue update --stage review` + offer.

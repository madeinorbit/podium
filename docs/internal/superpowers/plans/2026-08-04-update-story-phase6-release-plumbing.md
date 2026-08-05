# Update story, Phase 6: release plumbing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a release emit everything the update story reads: a content digest per artifact, the changelog section for the version being cut, and the structured policy fields that replaced the prose marker.

**Architecture:** Three pure additions to the release helper, each independently testable. Digests turn one lockstep version number into an honest list of places. Changelog extraction turns `CHANGELOG.md` into the dialog's "What's new". `critical` and `minRequired` move policy out of prose and into fields.

**Tech Stack:** TypeScript, Bun, `scripts/release.ts`.

**Spec:** `docs/internal/superpowers/specs/2026-08-04-coherent-update-story-design.md`, §2.3, §8.3 and §10. Gap items 11, 12, 13.

**Depends on:** Phase 1 (POD-1695) for the `UpdateTarget` shape the manifest must satisfy. Independent of Phases 2 through 5 and can run alongside them once Phase 1 has landed.

## Global Constraints

- **The version stays a manual bump of root `package.json`.** This phase changes what a release *emits*, never what triggers one. `docs/update-release-swaps.md` documents `package.json` `"version"` as the single source of truth; that stays true.
- **Digests are a UX input, never a compatibility input.** They decide which places the dialog lists. Nothing may gate compatibility on them; that is the wire version and schema digest's job.
- **Policy is structured, never prose.** `critical` and `minRequired` are fields. Release notes stay prose for humans and are never parsed for policy.
- **Product-version lag never auto-blocks a store build.** `minRequired` for a mobile platform is raised by an operator only after the replacement is confirmed live in that store. Nothing in the release process may raise it automatically.
- **The manifest keeps its current shape for existing consumers.** `podium update` and the Tauri updater both read it today. Every field added is additive; nothing is renamed or retyped.
- Run `bun run typecheck` and trust a cache hit.

---

## File Structure

**Created:**
- `scripts/changelog.ts` — extract one version's section from `CHANGELOG.md`.
- `scripts/changelog.test.ts`
- `scripts/release-manifest.ts` — build the manifest object, pure, given prepared artifacts.
- `scripts/release-manifest.test.ts`

**Modified:**
- `scripts/release.ts:177-190` — emit the enriched manifest.
- `docs/update-release-swaps.md` — document the new fields and how an operator sets them.

---

## Task 1: Changelog extraction

**Files:**
- Create: `scripts/changelog.ts`, `scripts/changelog.test.ts`

**Interfaces:**
- Produces: `extractRelease(markdown: string, version: string): { summary: string } | null`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { extractRelease } from './changelog'

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Something not yet released.

## [0.4.2] - 2026-08-04

### Added

- Faster reconnects after a daemon restart.

### Fixed

- A stale bundle no longer reload-loops.

## [0.4.1] - 2026-07-30

### Fixed

- An older fix.
`

describe('extractRelease', () => {
  it('extracts the section for the requested version', () => {
    const r = extractRelease(CHANGELOG, '0.4.2')
    expect(r?.summary).toContain('Faster reconnects')
    expect(r?.summary).toContain('stale bundle')
  })

  it('stops at the next version heading', () => {
    expect(extractRelease(CHANGELOG, '0.4.2')?.summary).not.toContain('An older fix')
  })

  it('never returns the Unreleased section', () => {
    // Shipping "Unreleased" to users as their release notes would be a lie about
    // what they just installed.
    expect(extractRelease(CHANGELOG, '0.4.2')?.summary).not.toContain('not yet released')
  })

  it('returns null for a version with no section', () => {
    expect(extractRelease(CHANGELOG, '9.9.9')).toBeNull()
  })

  it('returns null rather than an empty summary for an empty section', () => {
    // The dialog omits the What's new affordance when notes are absent. An empty
    // string would render an empty section instead, which is worse than nothing.
    const empty = '# Changelog\n\n## [0.4.3] - 2026-08-05\n\n## [0.4.2] - 2026-08-04\n\n- A thing.\n'
    expect(extractRelease(empty, '0.4.3')).toBeNull()
  })

  it('tolerates a heading without a date', () => {
    expect(extractRelease('## [0.4.2]\n\n- A thing.\n', '0.4.2')?.summary).toContain('A thing')
  })

  it('tolerates a heading without brackets', () => {
    expect(extractRelease('## 0.4.2 - 2026-08-04\n\n- A thing.\n', '0.4.2')?.summary).toContain(
      'A thing',
    )
  })

  it('does not match a version that is a prefix of another', () => {
    const cl = '## [0.4.20]\n\n- Twenty.\n\n## [0.4.2]\n\n- Two.\n'
    expect(extractRelease(cl, '0.4.2')?.summary).toContain('Two')
    expect(extractRelease(cl, '0.4.2')?.summary).not.toContain('Twenty')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:unit -- scripts/changelog.test.ts`
Expected: FAIL, cannot resolve `./changelog`.

- [ ] **Step 3: Implement, 4: run to verify it passes, 5: commit**

```bash
git add scripts/changelog.ts scripts/changelog.test.ts
git commit -m "feat(release): extract a version's changelog section (POD-1670)"
```

---

## Task 2: Per-artifact digests in the manifest

**Files:**
- Create: `scripts/release-manifest.ts`, `.test.ts`
- Modify: `scripts/release.ts:177-190`

**Interfaces:**
- Produces: `buildManifest(input: { version: string; platforms: Array<{ target: string; url: string; signature: string; bytes: Uint8Array }>; notes: { summary: string } | null; critical: boolean; minRequired?: MinRequired; webDigest?: string }): object`

`createHash` is already imported in `release.ts`, so digesting costs nothing new.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { buildManifest } from './release-manifest'

const platforms = [
  {
    target: 'linux-x86_64',
    url: 'https://x.test/a.tgz',
    signature: 'sig',
    bytes: new Uint8Array([1, 2, 3]),
  },
]

describe('buildManifest', () => {
  it('keeps the shape existing consumers already read', () => {
    // `podium update` and the Tauri updater both read this today. Every addition
    // is additive; nothing may be renamed or retyped.
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false }) as never
    expect(m).toMatchObject({
      version: '0.4.2',
      platforms: { 'linux-x86_64': { url: 'https://x.test/a.tgz', signature: 'sig' } },
    })
  })

  it('adds a content digest per platform artifact', () => {
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false }) as never
    expect(m.platforms['linux-x86_64'].digest).toMatch(/^sha256-[A-Za-z0-9+/=]+$/)
  })

  it('produces the same digest for the same bytes and a different one otherwise', () => {
    const a = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false }) as never
    const b = buildManifest({ version: '0.4.3', platforms, notes: null, critical: false }) as never
    const c = buildManifest({
      version: '0.4.2',
      platforms: [{ ...platforms[0], bytes: new Uint8Array([9]) }],
      notes: null,
      critical: false,
    }) as never
    expect(a.platforms['linux-x86_64'].digest).toBe(b.platforms['linux-x86_64'].digest)
    expect(a.platforms['linux-x86_64'].digest).not.toBe(c.platforms['linux-x86_64'].digest)
  })

  it('carries the web digest so the dialog can tell a web-only release apart', () => {
    const m = buildManifest({
      version: '0.4.2',
      platforms,
      notes: null,
      critical: false,
      webDigest: 'sha256-web',
    }) as never
    expect(m.web).toEqual({ digest: 'sha256-web' })
  })

  it('carries notes when there are any', () => {
    const m = buildManifest({
      version: '0.4.2',
      platforms,
      notes: { summary: 'Faster reconnects.' },
      critical: false,
    }) as never
    expect(m.notes.summary).toBe('Faster reconnects.')
  })

  it('omits notes entirely when there are none, rather than emitting an empty object', () => {
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false }) as never
    expect(m.notes).toBeUndefined()
  })

  it('emits critical as a boolean field, never as a prose prefix', () => {
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: true }) as never
    expect(m.critical).toBe(true)
    expect(JSON.stringify(m)).not.toContain('CRITICAL:')
  })

  it('emits minRequired only when an operator set it', () => {
    const without = buildManifest({
      version: '0.4.2',
      platforms,
      notes: null,
      critical: false,
    }) as never
    expect(without.minRequired).toBeUndefined()

    const with_ = buildManifest({
      version: '0.4.2',
      platforms,
      notes: null,
      critical: false,
      minRequired: { mobile: { ios: '0.3.9' } },
    }) as never
    expect(with_.minRequired.mobile.ios).toBe('0.3.9')
  })

  it('never derives minRequired from the version being cut', () => {
    // Raising the floor strands users whose replacement has not shipped yet, and
    // for a store build that is irreversible. It is an operator decision, always.
    const m = buildManifest({
      version: '0.4.2',
      platforms,
      notes: null,
      critical: false,
    }) as never
    expect(m.minRequired).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails, 3: implement, 4: run to verify it passes**

- [ ] **Step 5: Wire it into `release.ts`**

Replace the inline manifest construction at `scripts/release.ts:177-190` with a call to `buildManifest`, reading the notes via `extractRelease` from Task 1 and `critical` / `minRequired` from explicit CLI flags. **Defaults: `critical` is false and `minRequired` is absent.** Neither may be inferred.

- [ ] **Step 6: Verify the existing consumers still work**

Run the existing headless update verification: `bash scripts/verify-headless-update.sh`. The manifest changed shape additively, and this is the script that proves `podium update` still parses it.

- [ ] **Step 7: Commit**

```bash
git add scripts
git commit -m "feat(release): per-artifact digests, notes, and structured policy fields (POD-1670)"
```

---

## Task 3: Document the operator's levers

**Files:**
- Modify: `docs/update-release-swaps.md`

Add a section covering, in an operator's terms:
- what `critical` does and when to set it;
- what `minRequired` does, per surface and per mobile platform, and **the rule that it is raised only after the replacement is confirmed live in the store**, because raising it strands users whose replacement has not shipped and a store release cannot be rolled back;
- that digests are emitted automatically and need no operator input;
- that release notes come from `CHANGELOG.md` and that an empty section means the dialog shows no "What's new", which is correct and not a bug.

- [ ] **Step 1: Write it, then commit**

```bash
git add docs/update-release-swaps.md
git commit -m "docs(release): the operator's update-policy levers (POD-1670)"
```

---

## Verification for the whole phase

- [ ] `bun run typecheck`, `bun run test:unit` pass.
- [ ] `bash scripts/verify-headless-update.sh` passes: the enriched manifest is still parsed by `podium update`.
- [ ] A dry-run release produces a manifest that validates against Phase 1's `UpdateTarget` schema. If it does not, one of the two is wrong and this is the moment to find out, not at a release.
- [ ] A release cut with no changelog section for its version emits no `notes` and does not fail.
- [ ] Neither `critical` nor `minRequired` appears unless explicitly passed.

---

## Out of scope, on purpose

- Changing what triggers a release. The manual `package.json` bump stays.
- The mobile store build itself, its blocking screen, and over-the-air JS updates. `minRequired`'s mobile shape is emitted here so it is ready; nothing consumes it until a store build exists.
- Desktop artifact publishing, which remains the manually triggered workflow in `docs/desktop-releases.md`.

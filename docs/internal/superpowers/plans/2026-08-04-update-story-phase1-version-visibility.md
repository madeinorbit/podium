# Update story, Phase 1: version visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every attached component's version visible to the server, publish the server's target descriptor on `/version`, and stop a newer-than-server client from reload-looping.

**Architecture:** Three seams, leaf first. The protocol package grows a peer *build report* on the existing permanent hello envelope, a *target descriptor* type, and a single shared `/version` parser that every consumer uses so two parsers cannot drift. The server publishes the descriptor and records each daemon's build report on the machine row (additive columns only). The daemon sends its build report and its delivery capabilities. Nothing acts on any of this yet: Phase 1 delivers observability, which is currently impossible, and the interfaces every later phase builds on.

**Tech Stack:** TypeScript, zod, drizzle (SQLite), vitest (run under Bun), React (web), Hono (server).

**Spec:** `docs/internal/superpowers/specs/2026-08-04-coherent-update-story-design.md`. This plan implements build-order steps 1 to 3 plus gap-list items 1, 2, 3, 10 and 19.

## Global Constraints

- **`/version` is a frozen contract.** Fields may be added, never removed, never retyped, never given new semantics. Every consumer treats every field as optional. **Absent is never a mismatch.** Unknown fields are ignored silently, never an error. (Spec §3.)
- **The product version is a label, never a compatibility check.** Only `WIRE_VERSION`, `MIN_SUPPORTED_VERSION` and `wireSchemaDigest` decide compatibility. (Spec §1.5, §2.1.)
- **Development builds have no semver.** Identity is `dev+<sha>`. Nothing may assume a parseable semver. (Spec §2.4.)
- **A build report is advisory, never authorization.** It is peer-asserted and unverified. It may be logged, displayed and used to compute drift. It may never grant, elevate or resolve identity. This mirrors the existing inertness rule for `PeerIdentityClaims` in `packages/protocol/src/handshake/envelope.ts`.
- **Migrations are expand-only.** Additive columns only; no destructive DDL in this phase. (Spec §13.2.)
- **The hello envelope is permanent, not a scaffold.** New fields go on `PeerHello` in `packages/protocol/src/handshake/envelope.ts`, never on the legacy `pair`/`hello` frames in `packages/protocol/src/messages/daemon-handshake.ts`, which are an expiring adapter.
- **Negotiation is role-blind.** No role name may appear in `packages/protocol/src/handshake/negotiation.ts`.
- **User-facing copy names places, not components.** "Your server", never "the headless bundle". (Spec §12.3.)
- **No em dashes in user-facing copy.**
- Run `bun run typecheck` and trust a cache hit. Never force a recompute.
- Unit tests run with `bun run test:unit`; web tests with `bun run test:web`.
- No fixed sleeps in tests. A `setTimeout` before an assertion is a bug in this repository's unit lane.

---

## File Structure

**Created:**
- `packages/protocol/src/update/target.ts` — the target descriptor and artifact-delivery schemas. One responsibility: what a server says its components should run.
- `packages/protocol/src/update/target.test.ts`
- `packages/protocol/src/update/server-version.ts` — the single shared `/version` payload parser, and the law of §3 expressed as code.
- `packages/protocol/src/update/server-version.test.ts`
- `packages/protocol/src/update/index.ts` — barrel.
- `apps/server/src/migrations/drizzle/<timestamp>_machine-build-report/` — additive columns on `machines`.

**Modified:**
- `packages/protocol/src/handshake/envelope.ts` — add `PeerBuild` and the optional `build` field on `PeerHello`.
- `packages/protocol/src/handshake/envelope.test.ts` (or `conformance.test.ts` if that is where envelope cases live) — back-compat and forward-compat cases.
- `packages/protocol/src/handshake/negotiation.ts` — add the delivery capability tokens to the known-caps surface.
- `packages/protocol/src/index.ts` — export the new `update/` barrel.
- `apps/server/src/server.ts:157-175` — `/version` gains `target` and `policy`.
- `apps/server/src/migrations/schema.ts:517` — `machines` gains the build-report columns.
- `apps/server/src/store/machines.ts` — a `setMachineBuild` writer and the read shape.
- `apps/server/src/store/types.ts` — the machine row type gains the build fields.
- `apps/server/src/modules/machines/service.ts` — expose build state on the machine read model.
- `apps/daemon/src/` (the dialer that constructs `PeerHello`) — send `build` and delivery caps.
- `apps/web/src/features/setup/version-guard.ts` — use the shared parser; add the newer-client case.
- `apps/web/src/features/setup/version-guard.test.ts` — newer-client cases.

Files that change together live together: everything about "what a server says should be running" is in `packages/protocol/src/update/`, not scattered across the handshake and the server.

---

## Task 1: The peer build report on the hello envelope

**Files:**
- Modify: `packages/protocol/src/handshake/envelope.ts`
- Test: `packages/protocol/src/handshake/envelope.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PeerBuild` (zod schema) and `type PeerBuild = { appVersion?: string; wireSchemaDigest?: string; installKind?: 'installed' | 'source' }`, passthrough.
  - `PeerHello.build?: PeerBuild`.
  - `DELIVERY_CAPS: readonly ['update.delivery.feed', 'update.delivery.bundle', 'update.delivery.git']`.

**Why `build` is a sibling of `claims`, not a member of it:** `PeerIdentityClaims` is the one place identity-shaped fields live so that "does anything read a claim?" is a grep with one answer. A build report is not identity, and putting it in `claims` would pollute that answer. It gets its own field with its own inertness rule.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/handshake/envelope.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DELIVERY_CAPS, PeerHello } from './envelope'

const baseHello = {
  type: 'peerHello' as const,
  v: 2,
  caps: [],
  credential: { kind: 'daemonSecret' as const, secret: 's' },
}

describe('PeerHello build report', () => {
  it('parses a hello with no build report (an older peer)', () => {
    const parsed = PeerHello.parse(baseHello)
    expect(parsed.build).toBeUndefined()
  })

  it('parses a full build report', () => {
    const parsed = PeerHello.parse({
      ...baseHello,
      build: { appVersion: '0.4.2', wireSchemaDigest: 'abc123', installKind: 'installed' },
    })
    expect(parsed.build).toEqual({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc123',
      installKind: 'installed',
    })
  })

  it('accepts a development identity, which is not a semver', () => {
    const parsed = PeerHello.parse({ ...baseHello, build: { appVersion: 'dev+9f3a1c2' } })
    expect(parsed.build?.appVersion).toBe('dev+9f3a1c2')
  })

  it('keeps unknown build fields instead of rejecting them (forward compatible)', () => {
    const parsed = PeerHello.parse({
      ...baseHello,
      build: { appVersion: '0.4.2', somethingNewerPeersSend: true },
    })
    expect(parsed.build?.appVersion).toBe('0.4.2')
  })

  it('rejects an installKind outside the closed set', () => {
    expect(() => PeerHello.parse({ ...baseHello, build: { installKind: 'wat' } })).toThrow()
  })

  it('names the three delivery capability tokens', () => {
    expect(DELIVERY_CAPS).toEqual([
      'update.delivery.feed',
      'update.delivery.bundle',
      'update.delivery.git',
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- packages/protocol/src/handshake/envelope.test.ts`
Expected: FAIL. `DELIVERY_CAPS` is not exported, and `parsed.build` does not exist.

- [ ] **Step 3: Write the implementation**

In `packages/protocol/src/handshake/envelope.ts`, add above `PeerHello`:

```ts
/**
 * What a peer reports about ITS OWN BUILD. Advisory, never authorization.
 *
 * This is peer-asserted and unverified, exactly like {@link PeerIdentityClaims},
 * and the same discipline applies for the same reason: it may be logged,
 * displayed, and used to compute update drift, and it may never grant, elevate,
 * or resolve a principal. It is a SIBLING of `claims` rather than a member of it
 * because a build is not identity, and folding it in would spoil the one-answer
 * grep that `claims` exists to provide.
 *
 * Passthrough on purpose: a newer peer that adds a field must not be refused by
 * an older acceptor. Every field is optional because an older peer sends none.
 *
 * `appVersion` is NOT a semver. A development build reports `dev+<sha>`, and
 * nothing may parse this field as a version number.
 */
export const PeerBuild = z
  .object({
    appVersion: z.string().optional(),
    wireSchemaDigest: z.string().optional(),
    installKind: z.enum(['installed', 'source']).optional(),
  })
  .passthrough()
export type PeerBuild = z.infer<typeof PeerBuild>

/**
 * Delivery methods a peer can accept bytes through. Announced as capability
 * tokens because `caps` is already the open, additive, intersection-returning
 * surface for exactly this, and the acceptor's reply then tells the peer which
 * of its offers the server will actually use.
 */
export const DELIVERY_CAPS = [
  'update.delivery.feed',
  'update.delivery.bundle',
  'update.delivery.git',
] as const
export type DeliveryCap = (typeof DELIVERY_CAPS)[number]
```

Then add the field to the `PeerHello` object, after `claims`:

```ts
  claims: PeerIdentityClaims.optional(),
  /** Advisory build report — see {@link PeerBuild}. Absent from older peers. */
  build: PeerBuild.optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- packages/protocol/src/handshake/envelope.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Run the surrounding handshake suite to prove nothing regressed**

Run: `bun run test:unit -- packages/protocol/src/handshake`
Expected: PASS. In particular the payload-inert strategy tests must still pass unchanged: adding `build` must not change any resolved principal.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/handshake/envelope.ts packages/protocol/src/handshake/envelope.test.ts
git commit -m "feat(protocol): advisory peer build report on the hello envelope (POD-1670)"
```

---

## Task 2: The target descriptor

**Files:**
- Create: `packages/protocol/src/update/target.ts`
- Create: `packages/protocol/src/update/target.test.ts`
- Create: `packages/protocol/src/update/index.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `UpdateArtifact` — discriminated union on `delivery`: `feed | bundle | git`.
  - `UpdateTarget` — `{ version, notes?, critical, minRequired?, artifacts }`, passthrough.
  - `type UpdateTarget`, `type UpdateArtifact`.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/update/target.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { UpdateTarget } from './target'

const feedTarget = {
  version: '0.4.2',
  artifacts: {
    headless: {
      delivery: 'feed',
      url: 'https://example.test/podium-headless-0.4.2.tar.gz',
      digest: 'sha256-aaa',
      signature: 'sig',
    },
  },
}

describe('UpdateTarget', () => {
  it('parses a feed-delivered target', () => {
    const t = UpdateTarget.parse(feedTarget)
    expect(t.artifacts.headless?.delivery).toBe('feed')
    expect(t.critical).toBe(false)
  })

  it('parses a server-hosted bundle target', () => {
    const t = UpdateTarget.parse({
      version: 'dev+9f3a1c2',
      artifacts: {
        headless: {
          delivery: 'bundle',
          url: 'https://server.test/update/headless.tar.gz',
          digest: 'sha256-bbb',
          signature: 'sig',
        },
      },
    })
    expect(t.artifacts.headless?.delivery).toBe('bundle')
  })

  it('parses a git target, which has a sha instead of a url', () => {
    const t = UpdateTarget.parse({
      version: 'dev+9f3a1c2',
      artifacts: {
        headless: { delivery: 'git', repo: '/home/u/src/podium', sha: '9f3a1c2' },
      },
    })
    expect(t.artifacts.headless).toEqual({
      delivery: 'git',
      repo: '/home/u/src/podium',
      sha: '9f3a1c2',
    })
  })

  it('rejects a feed artifact with no url', () => {
    expect(() =>
      UpdateTarget.parse({
        version: '0.4.2',
        artifacts: { headless: { delivery: 'feed', digest: 'd', signature: 's' } },
      }),
    ).toThrow()
  })

  it('carries release notes and a changelog link when they exist', () => {
    const t = UpdateTarget.parse({
      ...feedTarget,
      notes: { summary: 'Faster reconnects.', url: 'https://example.test/CHANGELOG.md#042' },
    })
    expect(t.notes?.summary).toBe('Faster reconnects.')
  })

  it('omits notes entirely when there are none', () => {
    expect(UpdateTarget.parse(feedTarget).notes).toBeUndefined()
  })

  it('carries a structured critical flag rather than a prose marker', () => {
    expect(UpdateTarget.parse({ ...feedTarget, critical: true }).critical).toBe(true)
  })

  it('carries per-surface and per-platform minimum required versions', () => {
    const t = UpdateTarget.parse({
      ...feedTarget,
      minRequired: { desktop: '0.4.0', mobile: { ios: '0.3.9', android: '0.4.0' } },
    })
    expect(t.minRequired?.mobile?.ios).toBe('0.3.9')
  })

  it('ignores unknown top-level fields instead of rejecting them', () => {
    expect(() => UpdateTarget.parse({ ...feedTarget, aFieldFromTheFuture: 1 })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- packages/protocol/src/update/target.test.ts`
Expected: FAIL, cannot resolve `./target`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/update/target.ts`:

```ts
/**
 * THE TARGET DESCRIPTOR — what a server says its attached components should run.
 *
 * AUTHORITY AND DELIVERY ARE SEPARATE AXES. The server is authority: it decides
 * the target. Delivery is how the bytes arrive, and it is pluggable per artifact
 * so the common case stays cheap (a public release feed) while on-premise,
 * air-gapped and development installs use the SAME authority, staging and
 * reporting with the server serving the bytes itself.
 *
 * `version` is a LABEL, never a compatibility check, and it is not necessarily a
 * semver: a development build reports `dev+<sha>`. Compatibility is decided only
 * by the wire version window and the schema digest.
 *
 * Passthrough at every level a newer server might extend, because this rides on
 * `/version`, which is a frozen contract: unknown fields are ignored, never an
 * error.
 */
import { z } from 'zod'

/** Bytes from a public release feed, signed with the release key. */
export const FeedArtifact = z.object({
  delivery: z.literal('feed'),
  url: z.string().min(1),
  digest: z.string().min(1),
  signature: z.string().min(1),
})

/**
 * Bytes hosted by the server itself, signed with a per-server key the peer
 * pinned at pairing. The authenticated socket is NOT accepted as a substitute
 * for signature verification; both apply.
 */
export const BundleArtifact = z.object({
  delivery: z.literal('bundle'),
  url: z.string().min(1),
  digest: z.string().min(1),
  signature: z.string().min(1),
})

/**
 * A checkout, not a download. Convergence is a fetch, checkout and restart.
 * Local development fast path only; there is nothing to sign because no bytes
 * cross a network boundary.
 */
export const GitArtifact = z.object({
  delivery: z.literal('git'),
  repo: z.string().min(1),
  sha: z.string().min(1),
})

export const UpdateArtifact = z.discriminatedUnion('delivery', [
  FeedArtifact,
  BundleArtifact,
  GitArtifact,
])
export type UpdateArtifact = z.infer<typeof UpdateArtifact>

/**
 * Release notes are PROSE FOR HUMANS. Policy never lives here: `critical` and
 * `minRequired` are structured fields, so nothing has to parse a marker out of a
 * changelog the way the desktop updater does today.
 */
export const UpdateNotes = z
  .object({
    summary: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough()
export type UpdateNotes = z.infer<typeof UpdateNotes>

/**
 * The floor below which a surface is BLOCKED rather than nagged. Keyed per
 * surface, and for mobile per platform, because iOS and Android reach users at
 * different times through review latency and staged rollout.
 *
 * Product-version lag never auto-blocks a store build. An operator raises these
 * only after confirming the replacement is live in the store, because blocking a
 * user whose replacement has not shipped strands them with no way out.
 */
export const MinRequired = z
  .object({
    desktop: z.string().optional(),
    web: z.string().optional(),
    mobile: z
      .object({ ios: z.string().optional(), android: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type MinRequired = z.infer<typeof MinRequired>

export const UpdateTarget = z
  .object({
    /** A LABEL. `0.4.2` on a channel, `dev+<sha>` in development. Never parsed as a semver. */
    version: z.string().min(1),
    notes: UpdateNotes.optional(),
    /** Structured, replacing the `CRITICAL:` prose marker in the desktop updater. */
    critical: z.boolean().default(false),
    minRequired: MinRequired.optional(),
    artifacts: z
      .object({
        headless: UpdateArtifact.optional(),
        desktop: UpdateArtifact.optional(),
        /** The web bundle is served, not fetched, so it carries a digest only. */
        web: z.object({ digest: z.string().min(1) }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough()
export type UpdateTarget = z.infer<typeof UpdateTarget>
```

Create `packages/protocol/src/update/index.ts`:

```ts
export * from './target'
```

Add to `packages/protocol/src/index.ts`, alongside the existing barrel exports:

```ts
export * from './update'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- packages/protocol/src/update/target.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS. A cache hit is evidence; do not force a recompute.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/update packages/protocol/src/index.ts
git commit -m "feat(protocol): update target descriptor with pluggable delivery (POD-1670)"
```

---

## Task 3: The shared `/version` parser and its conformance test

**Files:**
- Create: `packages/protocol/src/update/server-version.ts`
- Create: `packages/protocol/src/update/server-version.test.ts`
- Modify: `packages/protocol/src/update/index.ts`

**Interfaces:**
- Consumes: `UpdateTarget` from Task 2.
- Produces:
  - `ServerVersion` (zod schema) and `type ServerVersion`.
  - `parseServerVersion(raw: unknown): ServerVersion` — never throws on unknown fields, never throws on absent optional fields.
  - `type SkewVerdict = 'ok' | 'client-too-old' | 'client-too-new' | 'schema-skew'`
  - `classifySkew(server: ServerVersion, local: { wire: number; digest: string }): SkewVerdict`

**This task is the enforcement of the frozen-contract law.** Every other consumer must use this parser rather than reading `/version` inline, so the law is implemented once.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/update/server-version.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifySkew, parseServerVersion } from './server-version'

const full = {
  appVersion: '0.4.2',
  wireVersion: 2,
  minSupportedVersion: 1,
  wireSchemaDigest: 'abc123',
  instanceId: 'inst-1',
}

describe('parseServerVersion is a frozen contract', () => {
  it('ignores unknown fields instead of failing', () => {
    const v = parseServerVersion({ ...full, aFieldAddedNextYear: { nested: true } })
    expect(v.wireVersion).toBe(2)
  })

  // Every field individually absent. This is the law: absent is never a mismatch.
  for (const key of Object.keys(full)) {
    it(`parses a payload with '${key}' absent`, () => {
      const partial = { ...full } as Record<string, unknown>
      delete partial[key]
      expect(() => parseServerVersion(partial)).not.toThrow()
    })
  }

  it('parses a completely empty payload', () => {
    expect(() => parseServerVersion({})).not.toThrow()
  })

  it('parses a payload carrying a target descriptor', () => {
    const v = parseServerVersion({
      ...full,
      target: {
        version: '0.4.2',
        artifacts: {
          headless: { delivery: 'feed', url: 'https://x.test/a.tgz', digest: 'd', signature: 's' },
        },
      },
    })
    expect(v.target?.version).toBe('0.4.2')
  })

  it('drops a malformed target rather than failing the whole payload', () => {
    // A broken target must never cost the caller the version fields it needs to
    // tell the user what is wrong.
    const v = parseServerVersion({ ...full, target: { nonsense: true } })
    expect(v.wireVersion).toBe(2)
    expect(v.target).toBeUndefined()
  })
})

describe('classifySkew', () => {
  const local = { wire: 2, digest: 'abc123' }

  it('is ok on an exact match', () => {
    expect(classifySkew(parseServerVersion(full), local)).toBe('ok')
  })

  it('is ok when the server advertises no digest (an older server)', () => {
    const v = parseServerVersion({ ...full, wireSchemaDigest: undefined })
    expect(classifySkew(v, local)).toBe('ok')
  })

  it('is ok when the server advertises nothing at all', () => {
    expect(classifySkew(parseServerVersion({}), local)).toBe('ok')
  })

  it('reports client-too-old below the server minimum', () => {
    const v = parseServerVersion({ ...full, wireVersion: 3, minSupportedVersion: 3 })
    expect(classifySkew(v, local)).toBe('client-too-old')
  })

  it('reports client-too-new when this client is ahead of its server', () => {
    const v = parseServerVersion({ ...full, wireVersion: 1, minSupportedVersion: 1 })
    expect(classifySkew(v, local)).toBe('client-too-new')
  })

  it('reports schema-skew when the wire versions agree but the digests do not', () => {
    const v = parseServerVersion({ ...full, wireSchemaDigest: 'different' })
    expect(classifySkew(v, local)).toBe('schema-skew')
  })

  it('prefers the version verdict over the digest verdict', () => {
    // Both differ. The version answer is the actionable one.
    const v = parseServerVersion({ ...full, wireVersion: 1, wireSchemaDigest: 'different' })
    expect(classifySkew(v, local)).toBe('client-too-new')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- packages/protocol/src/update/server-version.test.ts`
Expected: FAIL, cannot resolve `./server-version`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/update/server-version.ts`:

```ts
/**
 * THE `/version` PAYLOAD, AND THE LAW THAT GOVERNS IT.
 *
 * `/version` is the one endpoint by which a peer too old to speak the wire
 * learns that it is too old. It therefore may never break:
 *
 *   - fields may be ADDED, never removed, never retyped, never given new meaning;
 *   - every consumer treats every field as OPTIONAL;
 *   - ABSENT IS NEVER A MISMATCH;
 *   - unknown fields are ignored silently, never an error.
 *
 * The third rule is the one that bites. A client that treated a missing
 * `wireSchemaDigest` as skew would reload-loop against every server predating
 * that field: a detector that fires on healthy pairs. Every optional field here
 * is optional for that reason, not for convenience.
 *
 * This parser exists so the law is implemented ONCE. No consumer may read
 * `/version` inline; two parsers would drift and only one of them would be right.
 */
import { z } from 'zod'
import { UpdateTarget } from './target'

export const ServerVersion = z
  .object({
    appVersion: z.string().optional(),
    wireVersion: z.number().int().optional(),
    minSupportedVersion: z.number().int().optional(),
    wireSchemaDigest: z.string().optional(),
    instanceId: z.string().optional(),
    feedScoping: z.string().optional(),
    /**
     * Parsed leniently: a malformed target must not cost the caller the version
     * fields it needs in order to tell the user what is wrong. A broken descriptor
     * degrades to "no descriptor", never to "no answer".
     */
    target: UpdateTarget.optional().catch(undefined),
  })
  .passthrough()
export type ServerVersion = z.infer<typeof ServerVersion>

/** Never throws. An unparseable payload degrades to "the server said nothing". */
export function parseServerVersion(raw: unknown): ServerVersion {
  const parsed = ServerVersion.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

/**
 * What this build should DO about the server it just read.
 *
 * `client-too-new` is the case that had no answer before: a client ahead of its
 * server gets a refusal that no reload can fix, because the client is genuinely
 * ahead. Reloading is the wrong action; telling the user their server is behind
 * is the right one.
 */
export type SkewVerdict = 'ok' | 'client-too-old' | 'client-too-new' | 'schema-skew'

export function classifySkew(
  server: ServerVersion,
  local: { wire: number; digest: string },
): SkewVerdict {
  const { wireVersion, minSupportedVersion, wireSchemaDigest } = server
  if (minSupportedVersion !== undefined && local.wire < minSupportedVersion) return 'client-too-old'
  if (wireVersion !== undefined && local.wire > wireVersion) return 'client-too-new'
  if (wireVersion !== undefined && local.wire < wireVersion) return 'client-too-old'
  if (wireSchemaDigest !== undefined && wireSchemaDigest !== local.digest) return 'schema-skew'
  return 'ok'
}
```

Add to `packages/protocol/src/update/index.ts`:

```ts
export * from './server-version'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- packages/protocol/src/update/server-version.test.ts`
Expected: PASS. The absent-field loop generates one case per field; all must pass.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/update
git commit -m "feat(protocol): shared /version parser and skew classification (POD-1670)"
```

---

## Task 4: The server publishes its target descriptor

**Files:**
- Modify: `apps/server/src/server.ts:157-175`
- Test: `apps/server/src/server.version.test.ts` (create)

**Interfaces:**
- Consumes: `UpdateTarget` from Task 2, `parseServerVersion` from Task 3.
- Produces: `/version` responses carrying `target`, built from a new injected dep `deps.updateTarget?: () => UpdateTarget | undefined`.

The descriptor is *injected*, not computed here, because Phase 4 replaces its source (a release manifest in production, a locally built bundle in development) without touching the route.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/server.version.test.ts`:

```ts
import { parseServerVersion } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { registerVersionRoute } from './server'

// `registerVersionRoute(app, deps)` is exported from ./server (apps/server/src/server.ts:132).
// It registers one GET route on a plain Hono app, so the whole harness is three lines.
import { Hono } from 'hono'

async function getVersion(updateTarget?: () => UpdateTarget | undefined) {
  const app = new Hono()
  registerVersionRoute(app, { instanceId: 'inst-1', updateTarget })
  const res = await app.request('/version')
  return { status: res.status, body: (await res.json()) as unknown }
}

describe('GET /version', () => {
  it('still returns the existing fields when no target is configured', async () => {
    const { status, body } = await getVersion()
    expect(status).toBe(200)
    const v = parseServerVersion(body)
    expect(v.wireVersion).toBeTypeOf('number')
    expect(v.minSupportedVersion).toBeTypeOf('number')
    expect(v.wireSchemaDigest).toBeTypeOf('string')
    expect(v.appVersion).toBeTypeOf('string')
    expect(v.instanceId).toBe('inst-1')
    expect(v.target).toBeUndefined()
  })

  it('publishes the target descriptor when one is configured', async () => {
    const { body } = await getVersion(() => ({
      version: '0.4.2',
      critical: false,
      artifacts: {
        headless: { delivery: 'feed', url: 'https://x.test/a.tgz', digest: 'd', signature: 's' },
      },
    }))
    const v = parseServerVersion(body)
    expect(v.target?.version).toBe('0.4.2')
    expect(v.target?.artifacts.headless?.delivery).toBe('feed')
  })

  it('reports a development identity as the target version', async () => {
    const { body } = await getVersion(() => ({
      version: 'dev+9f3a1c2',
      critical: false,
      artifacts: {},
    }))
    expect(parseServerVersion(body).target?.version).toBe('dev+9f3a1c2')
  })

  it('serves the version fields even when building the target throws', async () => {
    const { status, body } = await getVersion(() => {
      throw new Error('bundle build failed')
    })
    expect(status).toBe(200)
    const v = parseServerVersion(body)
    expect(v.wireVersion).toBeTypeOf('number')
    expect(v.target).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/server/src/server.version.test.ts`
Expected: FAIL. `updateTarget` is not a recognised dep and `target` is absent from the response.

- [ ] **Step 3: Write the implementation**

In `apps/server/src/server.ts`, add to the deps object type alongside `visibilityGrade`:

```ts
    /**
     * What this server says its attached components should run. Injected rather
     * than computed here: production reads a release manifest and development
     * builds a bundle from its own checkout, and neither belongs in a route.
     *
     * A throw is swallowed. `/version` is the endpoint a peer uses to find out
     * what is wrong, so it must answer even when the update machinery is the
     * thing that is broken.
     */
    updateTarget?: () => UpdateTarget | undefined
```

Replace the route body:

```ts
  app.get('/version', (c) => {
    let target: UpdateTarget | undefined
    try {
      target = deps.updateTarget?.()
    } catch {
      target = undefined
    }
    return c.json({
      wireVersion: WIRE_VERSION,
      minSupportedVersion: MIN_SUPPORTED_VERSION,
      wireSchemaDigest: wireSchemaDigest(),
      appVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
      instanceId: deps.instanceId,
      feedScoping: deps.visibilityGrade?.() ?? 'device-unscoped',
      ...(target ? { target } : {}),
    })
  })
```

Add the import: `import type { UpdateTarget } from '@podium/protocol'`.

Keep the existing `wireSchemaDigest` docstring where it is; it is still correct.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/server/src/server.version.test.ts`
Expected: PASS, all four cases.

- [ ] **Step 5: Run the server suite**

Run: `bun run test:unit -- apps/server/src`
Expected: PASS. `target` is additive, so every existing `/version` assertion must still hold.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/server.version.test.ts
git commit -m "feat(server): publish the update target descriptor on /version (POD-1670)"
```

---

## Task 5: The daemon sends its build report

**Files:**
- Modify: the daemon module that constructs `PeerHello` (find it with `rg -n "peerHello" apps/daemon/src`)
- Test: alongside that module

**Interfaces:**
- Consumes: `PeerBuild`, `DELIVERY_CAPS` from Task 1.
- Produces: `buildReport(env: NodeJS.ProcessEnv, installDir: string | undefined): PeerBuild` and `deliveryCaps(installKind: PeerBuild['installKind']): string[]`, both pure so they are testable without a socket, in the style of `apps/daemon/src/self-update.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/build-report.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildReport, deliveryCaps } from './build-report'

describe('buildReport', () => {
  it('reports the baked version for an installed build', () => {
    const r = buildReport({ PODIUM_APP_VERSION: '0.4.2' }, '/home/u/.local/share/podium')
    expect(r.appVersion).toBe('0.4.2')
    expect(r.installKind).toBe('installed')
  })

  it('reports a source run when there is no install dir', () => {
    const r = buildReport({ PODIUM_APP_VERSION: '0.4.2' }, undefined)
    expect(r.installKind).toBe('source')
  })

  it('reports dev when no version was baked in', () => {
    expect(buildReport({}, undefined).appVersion).toBe('dev')
  })

  it('always carries this build wire schema digest', () => {
    expect(buildReport({}, undefined).wireSchemaDigest).toBeTypeOf('string')
  })
})

describe('deliveryCaps', () => {
  it('offers feed and bundle for an installed build', () => {
    expect(deliveryCaps('installed')).toEqual([
      'update.delivery.feed',
      'update.delivery.bundle',
    ])
  })

  it('offers only git for a source run, which cannot swap a bundle', () => {
    expect(deliveryCaps('source')).toEqual(['update.delivery.git'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/daemon/src/build-report.test.ts`
Expected: FAIL, cannot resolve `./build-report`.

- [ ] **Step 3: Write the implementation**

Create `apps/daemon/src/build-report.ts`:

```ts
/**
 * What this daemon tells its server about itself. Pure, so it can be tested
 * without a socket, in the style of `./self-update.ts`.
 *
 * ADVISORY, NEVER AUTHORIZATION. The server may log this, show it, and compute
 * update drift from it. It may never grant anything on the strength of it.
 *
 * `appVersion` is not a semver. A source run reports `dev`, and a development
 * bundle reports `dev+<sha>`.
 */
import { type PeerBuild, wireSchemaDigest } from '@podium/protocol'

export function buildReport(
  env: NodeJS.ProcessEnv,
  installDir: string | undefined,
): PeerBuild {
  return {
    appVersion: env.PODIUM_APP_VERSION ?? 'dev',
    wireSchemaDigest: wireSchemaDigest(),
    // A source run has no install dir to swap, which is exactly the distinction
    // `decideOnProtocolMismatch` already draws when it refuses to self-update a
    // bun-launched daemon.
    installKind: installDir ? 'installed' : 'source',
  }
}

/**
 * Which delivery methods this daemon can actually accept bytes through. A source
 * run cannot swap an install directory it does not have, so it offers only the
 * checkout path. Offering a method you cannot perform would let the server plan
 * a wave that is guaranteed to fail.
 */
export function deliveryCaps(installKind: PeerBuild['installKind']): string[] {
  return installKind === 'source'
    ? ['update.delivery.git']
    : ['update.delivery.feed', 'update.delivery.bundle']
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/daemon/src/build-report.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Wire it into the hello**

The daemon does **not** construct `PeerHello` itself. It goes through `createHandshakeDialer(deps)` in `packages/protocol/src/handshake/dialer.ts`, whose `DialerDeps` has no build field. So:

1. Add `readonly build?: PeerBuild` to `DialerDeps`, and emit it in `hello()` with the conditional-spread idiom the file already uses for `peerRole` and `claims`, so an absent build stays an absent *key* rather than an explicit `undefined`:

```ts
  ...(deps.build === undefined ? {} : { build: deps.build }),
```

2. Pass `buildReport(...)` and the delivery caps from `apps/daemon/src/connection-state.ts`.

**Append the delivery caps, never replace them.** The dialer does `caps: [...offered]` and later `negotiateCapabilities(reply.caps, offered)`, so whatever the call site passes today is what the acceptor intersects against. Overwriting it silently stops offering capabilities that are negotiated today, and nothing fails loudly.

**The dialer is shared and role-blind** — it lives in the shared package because the contract is one contract, and `conformance.ts` runs the same scenarios against both ends. An optional `build` is fine there; nothing role-specific may follow it in, and a console dialer must remain able to send no build at all.

- [ ] **Step 6: Run the daemon and handshake suites**

Run: `bun run test:unit -- apps/daemon/src packages/protocol/src/handshake`
Expected: PASS.

Cover **both** skew directions, since a rollout produces both:

- **Old daemon, new server** — a hello with no `build` is accepted, and the machine reads `unreported`.
- **New daemon, old server** — a hello *carrying* `build` reaches an acceptor that has never heard of it. `PeerHello` is a plain `z.object`, so it strips unknown keys rather than rejecting. That should make this pass; prove it rather than assume it, because it is the likelier direction during a rollout.

Also add a payload-inert case for `build` alongside the existing ones in `strategies/*.test.ts`. Those pin that a hello claiming a different user, machine or agent changes nothing about the resolved principal. A build report is peer-asserted and unverified in exactly the same way, and a test there is what stops someone later reading it as authorization.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/build-report.ts apps/daemon/src/build-report.test.ts apps/daemon/src
git commit -m "feat(daemon): report build and delivery capabilities on the hello (POD-1670)"
```

---

## Task 6: The server records the build report

**Files:**
- Create: `apps/server/src/migrations/drizzle/<timestamp>_machine-build-report/migration.sql` (generated)
- Modify: `apps/server/src/migrations/schema.ts:517` (the `machines` table)
- Modify: `apps/server/src/store/machines.ts`, `apps/server/src/store/types.ts`
- Test: `apps/server/src/store/machines.build.test.ts` (create)

**Interfaces:**
- Consumes: `PeerBuild` from Task 1.
- Produces: `setMachineBuild(id: string, build: PeerBuild, caps: string[], at: string): void` on the machine store, and four new fields on the machine row type: `appVersion: string | null`, `wireSchemaDigest: string | null`, `installKind: string | null`, `deliveryCaps: string[]`.

**Expand-only.** Four nullable columns and one JSON column. No column is dropped, renamed or retyped. Existing rows read as "not yet reported", which is the truthful answer for a daemon that has not reconnected since the upgrade.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/store/machines.build.test.ts`. The existing store tests open an in-memory database with `new SessionStore(':memory:')` (see `apps/server/src/issues.ledger.test.ts`); follow that.

```ts
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../store'

const openTestStore = () => new SessionStore(':memory:')

describe('machine build report', () => {
  it('reads as unreported for a machine that never sent one', () => {
    const store = openTestStore()
    store.upsertMachine({ id: 'm1', name: 'box', hostname: 'box.local' })
    const m = store.getMachine('m1')
    expect(m?.appVersion).toBeNull()
    expect(m?.installKind).toBeNull()
    expect(m?.deliveryCaps).toEqual([])
  })

  it('records a reported build', () => {
    const store = openTestStore()
    store.upsertMachine({ id: 'm1', name: 'box', hostname: 'box.local' })
    store.setMachineBuild(
      'm1',
      { appVersion: '0.4.2', wireSchemaDigest: 'abc', installKind: 'installed' },
      ['update.delivery.feed', 'update.delivery.bundle'],
      '2026-08-04T00:00:00.000Z',
    )
    const m = store.getMachine('m1')
    expect(m?.appVersion).toBe('0.4.2')
    expect(m?.wireSchemaDigest).toBe('abc')
    expect(m?.installKind).toBe('installed')
    expect(m?.deliveryCaps).toEqual(['update.delivery.feed', 'update.delivery.bundle'])
  })

  it('overwrites a previous report on reconnect', () => {
    const store = openTestStore()
    store.upsertMachine({ id: 'm1', name: 'box', hostname: 'box.local' })
    store.setMachineBuild('m1', { appVersion: '0.4.1' }, [], '2026-08-04T00:00:00.000Z')
    store.setMachineBuild('m1', { appVersion: '0.4.2' }, [], '2026-08-04T01:00:00.000Z')
    expect(store.getMachine('m1')?.appVersion).toBe('0.4.2')
  })

  it('records a partial report from an older daemon', () => {
    const store = openTestStore()
    store.upsertMachine({ id: 'm1', name: 'box', hostname: 'box.local' })
    store.setMachineBuild('m1', { appVersion: '0.4.2' }, [], '2026-08-04T00:00:00.000Z')
    const m = store.getMachine('m1')
    expect(m?.appVersion).toBe('0.4.2')
    expect(m?.installKind).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/server/src/store/machines.build.test.ts`
Expected: FAIL, `setMachineBuild` is not a function.

- [ ] **Step 3: Add the columns to the schema**

In `apps/server/src/migrations/schema.ts`, inside `machines`, after `ownerUserId`:

```ts
  // BUILD REPORT (POD-1670). What the daemon last told us it is running.
  // ADVISORY: peer-asserted, unverified, never used to grant anything. Additive
  // and nullable because an existing row has simply not reported yet, and that
  // is the truthful answer until the daemon reconnects.
  appVersion: text('app_version'),
  wireSchemaDigest: text('wire_schema_digest'),
  installKind: text('install_kind'),
  deliveryCapsJson: text('delivery_caps_json'),
  buildReportedAt: text('build_reported_at'),
```

- [ ] **Step 4: Generate the migration**

Run: `bun run migration:new machine-build-report`

This diffs `schema.ts` against the last snapshot with `drizzle-kit generate`, emits a timestamped folder under `apps/server/src/migrations/drizzle/`, and regenerates `drizzle-manifest.generated.ts` that the runtime applier reads. Do not hand-number anything; drizzle timestamps the folder precisely so parallel branches do not collide.

Expected: a new directory whose `migration.sql` contains only `ALTER TABLE ... ADD COLUMN` statements. **Read it.** If it contains any `DROP`, `RENAME` or table rebuild, stop: that violates the expand-only constraint and means the schema edit was wrong.

Then run `bun run migration:check` (drizzle-kit's snapshot DAG check) and confirm it passes. That is what catches a second branch touching `machines` before merge rather than after.

- [ ] **Step 5: Write the store methods**

In `apps/server/src/store/types.ts`, add to the machine row type:

```ts
  appVersion: string | null
  wireSchemaDigest: string | null
  installKind: string | null
  deliveryCaps: string[]
  buildReportedAt: string | null
```

In `apps/server/src/store/machines.ts`, next to `setMachineInventory`:

```ts
  setMachineBuild(id: string, build: PeerBuild, caps: string[], at: string): void {
    this.db
      .prepare(
        'UPDATE machines SET app_version = ?, wire_schema_digest = ?, install_kind = ?, ' +
          'delivery_caps_json = ?, build_reported_at = ? WHERE id = ?',
      )
      .run(
        build.appVersion ?? null,
        build.wireSchemaDigest ?? null,
        build.installKind ?? null,
        JSON.stringify(caps),
        at,
        id,
      )
  }
```

And in the row-mapping function, alongside the existing `last_seen_at` mapping:

```ts
    appVersion: (r.app_version as string | null) ?? null,
    wireSchemaDigest: (r.wire_schema_digest as string | null) ?? null,
    installKind: (r.install_kind as string | null) ?? null,
    // A malformed or absent JSON column degrades to "no capabilities offered",
    // never to a throw: a bad row must not take down the machines list.
    deliveryCaps: parseCaps(r.delivery_caps_json as string | null),
    buildReportedAt: (r.build_reported_at as string | null) ?? null,
```

with, at module scope:

```ts
function parseCaps(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return []
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run test:unit -- apps/server/src/store/machines.build.test.ts`
Expected: PASS, all four cases.

- [ ] **Step 7: Call it from the handshake accept path**

Find where the machine row's `lastSeenAt` is written on a successful hello (`rg -n "lastSeenAt|last_seen_at" apps/server/src --glob '!migrations/*'`) and call `setMachineBuild` in the same place.

**The rule that needs a test:** a hello *without* a build report must leave the previous report untouched, not null it. An older daemon reconnecting would otherwise erase what a newer one already told us, and the machines list would flicker between reported and unreported depending on which daemon last connected.

```ts
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../store'

const openTestStore = () => new SessionStore(':memory:')

describe('build report on hello accept', () => {
  it('persists a report carried by the hello', () => {
    const store = openTestStore()
    store.upsertMachine({ id: 'm1', name: 'box', hostname: 'box.local' })
    recordHelloBuild(store, 'm1', {
      build: { appVersion: '0.4.2', installKind: 'installed' },
      caps: ['update.delivery.feed'],
      at: '2026-08-04T00:00:00.000Z',
    })
    expect(store.getMachine('m1')?.appVersion).toBe('0.4.2')
  })

  it('leaves an existing report untouched when a hello carries none', () => {
    const store = openTestStore()
    store.upsertMachine({ id: 'm1', name: 'box', hostname: 'box.local' })
    recordHelloBuild(store, 'm1', {
      build: { appVersion: '0.4.2' },
      caps: [],
      at: '2026-08-04T00:00:00.000Z',
    })
    recordHelloBuild(store, 'm1', { build: undefined, caps: [], at: '2026-08-04T01:00:00.000Z' })
    expect(store.getMachine('m1')?.appVersion).toBe('0.4.2')
  })
})
```

Implement `recordHelloBuild` next to the accept path:

```ts
/**
 * A hello with no build report says NOTHING about the build, which is not the
 * same as saying the build is unknown. An older daemon reconnecting must not
 * erase what a newer one already reported, so absence is a no-op.
 */
export function recordHelloBuild(
  store: { setMachineBuild: (id: string, b: PeerBuild, caps: string[], at: string) => void },
  machineId: string,
  hello: { build: PeerBuild | undefined; caps: string[]; at: string },
): void {
  if (!hello.build) return
  store.setMachineBuild(machineId, hello.build, hello.caps, hello.at)
}
```

- [ ] **Step 8: Run the migration and server suites**

Run: `bun run test:unit -- apps/server/src`
Expected: PASS, including the existing migration integrity and convergence tests.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/migrations apps/server/src/store apps/server/src/handshake
git commit -m "feat(server): persist the daemon build report on the machine row (POD-1670)"
```

---

## Task 7: Expose machine version state on the read model

**Files:**
- Modify: `apps/server/src/modules/machines/service.ts`
- Test: alongside it

**Interfaces:**
- Consumes: the machine row fields from Task 6.
- Produces: `appVersion`, `installKind`, `deliveryCaps`, `buildReportedAt` and a derived `versionState: 'unreported' | 'current' | 'behind' | 'ahead'` on the machine read model.

`versionState` is derived, never stored: a stored verdict would go stale the moment the server's own target moved.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { deriveVersionState } from './service'

describe('deriveVersionState', () => {
  it('is unreported when the machine has not said', () => {
    expect(deriveVersionState(null, '0.4.2')).toBe('unreported')
  })

  it('is unreported when this server has no target of its own', () => {
    expect(deriveVersionState('0.4.2', undefined)).toBe('unreported')
  })

  it('is current on an exact match', () => {
    expect(deriveVersionState('0.4.2', '0.4.2')).toBe('current')
  })

  it('is behind on any mismatch, without parsing either side as a semver', () => {
    expect(deriveVersionState('0.4.1', '0.4.2')).toBe('behind')
  })

  it('treats a development identity as a plain label', () => {
    expect(deriveVersionState('dev+aaa', 'dev+bbb')).toBe('behind')
    expect(deriveVersionState('dev+aaa', 'dev+aaa')).toBe('current')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/server/src/modules/machines`
Expected: FAIL, `deriveVersionState` is not exported.

- [ ] **Step 3: Write the implementation**

In `apps/server/src/modules/machines/service.ts`:

```ts
/**
 * Where this machine sits relative to what this server says it should run.
 *
 * DERIVED, NEVER STORED. A stored verdict goes stale the instant the server's
 * own target moves, and a stale verdict in a shared read box is how honest
 * callers end up reporting a number that was true an hour ago.
 *
 * Deliberately NOT a semver comparison. `appVersion` is a label and may be
 * `dev+<sha>`, which has no ordering. Anything that is not an exact match is
 * `behind`, because the server is authority: the machine should be running what
 * the server says, whatever that is. `ahead` is reserved for the delivery layer,
 * which is the only thing that can tell a downgrade from a mismatch.
 */
export type MachineVersionState = 'unreported' | 'current' | 'behind' | 'ahead'

export function deriveVersionState(
  reported: string | null,
  target: string | undefined,
): MachineVersionState {
  if (!reported || !target) return 'unreported'
  return reported === target ? 'current' : 'behind'
}
```

Then add the four persisted fields plus `versionState: deriveVersionState(m.appVersion, target)` to the machine read model that `service.ts` builds.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/server/src/modules/machines`
Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/machines
git commit -m "feat(server): derive machine version state on the read model (POD-1670)"
```

---

## Task 8: The web client stops reload-looping when it is ahead of its server

**Files:**
- Modify: `apps/web/src/features/setup/version-guard.ts`
- Test: `apps/web/src/features/setup/version-guard.test.ts`

**Interfaces:**
- Consumes: `parseServerVersion`, `classifySkew` from Task 3.
- Produces: `VersionCheck` gains `'server-behind'`.

**The bug this fixes:** the guard currently treats any `serverWire !== WIRE_VERSION` as a reason to hard-reload. When this client is *newer* than its server, reloading cannot possibly help, because the client is genuinely ahead. It burns both reloads and then reports a message telling the user to rebuild, which is the wrong instruction: the thing to move is the server.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/features/setup/version-guard.test.ts`:

```ts
it('does not reload when this client is ahead of its server', async () => {
  // Server on wire 1, this bundle on wire 2.
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ wireVersion: 1, minSupportedVersion: 1 })),
  )
  const result = await checkServerVersion('http://server.test')
  expect(result).toBe('server-behind')
  expect(reloadSpy).not.toHaveBeenCalled()
})

it('tells the user the server is behind, not that the build is stale', async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ wireVersion: 1, minSupportedVersion: 1 })),
  )
  await checkServerVersion('http://server.test')
  expect(reportSkewSpy).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('server') }),
  )
  expect(reportSkewSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('bun run build') }),
  )
})

it('does not burn a reload attempt on the server-behind path', async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ wireVersion: 1, minSupportedVersion: 1 })),
  )
  await checkServerVersion('http://server.test')
  expect(sessionStorage.getItem(WIRE_RELOAD_COUNTER_KEY)).toBeNull()
})

it('still hard-reloads when the server is ahead of this cached bundle', async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ wireVersion: 99, minSupportedVersion: 99 })),
  )
  expect(await checkServerVersion('http://server.test')).toBe('reloaded')
  expect(reloadSpy).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:web -- version-guard`
Expected: FAIL. The first case returns `'reloaded'` and the reload spy was called.

- [ ] **Step 3: Write the implementation**

In `version-guard.ts`, widen the result type and replace the inline parsing with the shared parser:

```ts
export type VersionCheck = 'ok' | 'reloaded' | 'blocked' | 'server-behind'
```

Replace the hand-rolled `ServerVersion` interface and the `tooOld` / `mismatch` / `schemaSkew` block with:

```ts
import { classifySkew, parseServerVersion, WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'

  let server: ReturnType<typeof parseServerVersion>
  try {
    const res = await fetch(`${httpOrigin}/version`)
    server = parseServerVersion(await res.json())
  } catch {
    return 'ok' // unreachable or non-JSON /version, proceed rather than block
  }

  const verdict = classifySkew(server, { wire: WIRE_VERSION, digest: wireSchemaDigest() })

  if (verdict === 'ok') {
    clearReloadCounter()
    return 'ok'
  }

  /**
   * This client is AHEAD of its server. A reload cannot fix that: the fresh
   * bundle would be just as far ahead. Reloading here would burn both attempts
   * and then tell the user to rebuild, which is the wrong instruction. The thing
   * to move is the server, so say so and leave the reload budget alone.
   */
  if (verdict === 'client-too-new') {
    reportSkew({
      source: 'boot-digest',
      severe: false,
      message:
        `Your server is running an older version of Podium than this app ` +
        `(wire ${server.wireVersion} against ${WIRE_VERSION}). Update your server to continue.`,
    })
    return 'server-behind'
  }
```

Leave everything below unchanged: the reload counter, `MAX_RELOADS`, the `blocked` branch and its two messages all still apply to the `client-too-old` and `schema-skew` verdicts.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:web -- version-guard`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Check every caller handles the new result**

Run: `rg -n "checkServerVersion" apps/web/src`
Every caller must handle `'server-behind'`. It behaves like `'blocked'` for control-flow purposes: the app proceeds, and the skew notice carries the message.

- [ ] **Step 6: Full check**

```bash
bun run typecheck
bun run test:unit && bun run test:web
bun run lint:boundaries
```

Expected: PASS. `lint:boundaries` matters because Task 8 adds a `@podium/protocol` import to the web bundle; confirm the new `update/` module pulls in no `node:` builtins, which would break the web build. `packages/protocol/src/update/` imports only `zod`, so this should hold, and the boundary lint is what proves it.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/setup
git commit -m "fix(web): tell the user their server is behind instead of reload-looping (POD-1670)"
```

---

## Verification for the whole phase

- [ ] `bun run typecheck` passes (a cache hit is evidence).
- [ ] `bun run test:unit`, `bun run test:web` pass.
- [ ] `bun run lint` passes, including `lint:boundaries`.
- [ ] Runtime check: start a server and a daemon, then `curl localhost:<port>/version` and confirm the payload parses and carries `target` when one is configured. Confirm the machine row shows a reported `appVersion` after the daemon connects. This subsystem's failure modes are invisible in unit tests alone.
- [ ] Back-compat check: connect a daemon built from the previous commit (no `build` field) and confirm the handshake still succeeds and the machine reads `unreported` rather than erroring.

---

## Remaining phases

Phase 1 is deliberately self-contained: at its end the server knows and displays what every attached component runs, and a newer-than-server client says something useful. Nothing acts on any of it yet.

The remaining spec sections are separate plans, written against the interfaces Phase 1 actually lands rather than against guesses about them. Each produces working software on its own.

| Phase | Scope | Spec sections | Gap items |
|---|---|---|---|
| 2 | Delivery abstraction, converge-to-target, health gate, rollback, bounded attempts, wave orchestration, disable the daily timer for attached daemons | §4, §6 | 4, 5, 6, 7, 8, 9 |
| 3 | The unified update dialog and its states | §12.1 to §12.3, §12.5 | 15 |
| 4 | Desktop bridge commands, ownership-claim fallback, structured `critical` | §7.4, §12.4 | 14, 16 |
| 5 | Development bundle build (on demand, debounced, lock-guarded) and `git` delivery | §9 | 17 |
| 6 | Release plumbing: per-artifact digests, changelog extraction, `minRequired` wiring | §2.3, §8.3, §10 | 11, 12, 13 |
| 7 | Expand-only migration audit gate | §13.2 | 18 |

Phase 2 depends on Phase 1's `UpdateArtifact` union and the persisted delivery capabilities. Phases 3 and 4 depend on Phase 2's per-machine convergence states. Phases 5, 6 and 7 are independent of each other and can run in parallel once Phase 2 has landed.

**Why these are not written out here:** their step-level detail depends on interfaces Phase 1 has not landed yet, and on files (the daemon connection state machine, the Tauri Rust sources) whose current shape should be read at the time rather than assumed. Writing bite-sized TDD steps against code that does not exist yet produces plausible fiction, and a plan with fiction in it is worse than a plan with an honest boundary.

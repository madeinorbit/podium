# Update story, Phase 2: convergence and waves — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daemons converge to the version their server declares, automatically, in server-orchestrated waves, with a health gate and rollback so one bad bundle cannot take the fleet down.

**Architecture:** A request/result frame pair carries grants down and convergence status up, in the established `ControlMessage` / `DaemonMessage` idiom. Every decision is a pure function tested without a socket: what to converge to, whether a swap is healthy, when to give up, and which machines to grant next. The daemon's swap is crash-safe across its own restart by writing a pending-grant marker to disk before restarting and resolving it on boot. The server holds a wave planner that grants a canary first and refuses to widen until that canary reports healthy at the target.

**Tech Stack:** TypeScript, zod, vitest (run under Bun), systemd user units.

**Spec:** `docs/internal/superpowers/specs/2026-08-04-coherent-update-story-design.md`, §4 and §6. Gap items 4, 5, 6, 7, 8, 9.

**Depends on:** Phase 1 (POD-1695). This plan consumes `UpdateTarget`, `UpdateArtifact` and `PeerBuild` from `@podium/protocol`, and the persisted per-machine `appVersion` / `deliveryCaps`. **Do not start until POD-1695 has landed on main.**

## Global Constraints

- **The server is authority; a daemon never acts on a version delta by itself.** Convergence happens only in response to a grant. (Spec §6.2.)
- **Converge to target, not upgrade if newer.** `isNewer()` must not gate an attached daemon's convergence, or rollback is structurally impossible. (Spec §6.3.)
- **The product version is a label, never a compatibility check.** `appVersion` may be `dev+<sha>` and must never be parsed as a semver. Target comparison is string equality.
- **A daemon frame does not carry `machineId` on the wire.** The answering machine comes from the authenticated transport, the rule every newer daemon frame follows (see the POD-1466 note in `packages/protocol/src/messages/inventory.ts`). `InventoryReportMessage` predates this rule and is not the model to copy.
- **Signature verification is never skipped.** An authenticated socket is not a substitute. `bundle` delivery verifies its signature exactly as `feed` does. (Spec §4.)
- **Agent work survives the restart and must keep surviving it.** abduco masters setsid and reparent to the user manager; reattach is bounded. No task may add a step that kills sessions. (Spec §6.6.)
- **Rollback is only ever a binary swap in this phase.** Nothing here restores a database. (Spec §13.3.)
- Run `bun run typecheck` and trust a cache hit. Never force a recompute.
- No fixed sleeps in tests. Inject time; a `setTimeout` before an assertion is a bug in this repository's unit lane.
- systemd units are GENERATED from `apps/cli/src/cli-systemd.ts`. Never hand-edit a unit file; change the source and re-run the renderer. `bun run lint` includes `systemd:diff` and will catch you.

---

## File Structure

**Created:**
- `packages/protocol/src/messages/update.ts` — the grant and status frames. One responsibility: the wire shapes for convergence.
- `packages/protocol/src/update/convergence.ts` — pure decisions: what to converge to, and whether a delivery method is usable.
- `apps/daemon/src/convergence.ts` — the daemon's pure decisions: pending-marker resolution, health verdict, attempt bounding.
- `apps/daemon/src/pending-grant.ts` — read/write the on-disk marker that survives the restart.
- `apps/cli/src/delivery.ts` — the delivery abstraction: resolve an `UpdateArtifact` to verified bytes on disk.
- `apps/server/src/modules/updates/wave.ts` — the pure wave planner.
- `apps/server/src/modules/updates/service.ts` — holds the target, tracks convergence state, issues grants.

**Modified:**
- `packages/protocol/src/messages/control.ts` — add `UpdateGrantMessage` to `ControlMessage`.
- `packages/protocol/src/messages/daemon.ts` — add `UpdateStatusMessage` to `DaemonMessage`.
- `apps/cli/src/podium-update.ts` — convergence mode alongside the existing channel mode.
- `apps/daemon/src/connection-state.ts:201-217` — the 426 branch defers to the grant path when attached.
- `apps/daemon/src/self-update.ts` — `decidePostUpdate` gains the bounded-attempt verdict.
- `apps/cli/src/cli-systemd.ts` — the update timer is not installed for an attached daemon.
- `scripts/systemd/*` — regenerated, never hand-edited.

---

## Task 1: The grant and status frames

**Files:**
- Create: `packages/protocol/src/messages/update.ts`
- Modify: `packages/protocol/src/messages/control.ts`, `packages/protocol/src/messages/daemon.ts`
- Test: `packages/protocol/src/messages/update.test.ts`

**Interfaces:**
- Consumes: `UpdateTarget` from Phase 1.
- Produces:
  - `UpdateGrantMessage` = `{ type: 'updateGrant', grantId: string, target: UpdateTarget }`
  - `CONVERGENCE_STATES` = `['current','granted','downloading','restarting','rejected','stuck'] as const`
  - `UpdateStatusMessage` = `{ type: 'updateStatus', grantId?: string, state: ConvergenceState, version: string, detail?: string }`
  - `type ConvergenceState`

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/messages/update.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ControlMessage } from './control'
import { DaemonMessage } from './daemon'
import { CONVERGENCE_STATES, UpdateGrantMessage, UpdateStatusMessage } from './update'

const target = {
  version: '0.4.2',
  critical: false,
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: { 'linux-x86_64': { url: 'https://x.test/a.tgz', digest: 'd', signature: 's' } },
    },
  },
}

describe('update frames', () => {
  it('parses a grant', () => {
    const g = UpdateGrantMessage.parse({ type: 'updateGrant', grantId: 'g1', target })
    expect(g.target.version).toBe('0.4.2')
  })

  it('is routable as a server-to-daemon control frame', () => {
    const m = ControlMessage.parse({ type: 'updateGrant', grantId: 'g1', target })
    expect(m.type).toBe('updateGrant')
  })

  it('parses a status report', () => {
    const s = UpdateStatusMessage.parse({
      type: 'updateStatus',
      grantId: 'g1',
      state: 'restarting',
      version: '0.4.1',
    })
    expect(s.state).toBe('restarting')
  })

  it('is routable as a daemon-to-server frame', () => {
    const m = DaemonMessage.parse({ type: 'updateStatus', state: 'current', version: '0.4.2' })
    expect(m.type).toBe('updateStatus')
  })

  it('carries no machineId: the machine comes from the authenticated transport', () => {
    const s = UpdateStatusMessage.parse({
      type: 'updateStatus',
      state: 'current',
      version: '0.4.2',
      machineId: 'm-forged',
    })
    expect(s).not.toHaveProperty('machineId')
  })

  it('allows a status with no grantId, for an unsolicited report on reconnect', () => {
    expect(() =>
      UpdateStatusMessage.parse({ type: 'updateStatus', state: 'current', version: '0.4.2' }),
    ).not.toThrow()
  })

  it('accepts a development identity as the reported version', () => {
    const s = UpdateStatusMessage.parse({
      type: 'updateStatus',
      state: 'current',
      version: 'dev+9f3a1c2',
    })
    expect(s.version).toBe('dev+9f3a1c2')
  })

  it('names the six convergence states', () => {
    expect(CONVERGENCE_STATES).toEqual([
      'current',
      'granted',
      'downloading',
      'restarting',
      'rejected',
      'stuck',
    ])
  })

  it('rejects a state outside the closed set', () => {
    expect(() =>
      UpdateStatusMessage.parse({ type: 'updateStatus', state: 'vibing', version: '0.4.2' }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- packages/protocol/src/messages/update.test.ts`
Expected: FAIL, cannot resolve `./update`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/messages/update.ts`:

```ts
import { z } from 'zod'
import { UpdateTarget } from '../update/target'

/**
 * CONVERGENCE FRAMES — the server tells a machine to move, the machine says
 * where it got to.
 *
 * A daemon NEVER converges on a version delta it noticed by itself. It converges
 * because it was GRANTED permission, and only the server issues grants. That is
 * what makes waves possible: without it, every machine would move the instant a
 * new target was published, which is the stampede the wave planner exists to
 * prevent.
 */

/** server -> daemon: you may converge to this target now. */
export const UpdateGrantMessage = z.object({
  type: z.literal('updateGrant'),
  /** Correlates the grant with the status reports it produces, across a restart. */
  grantId: z.string().min(1),
  target: UpdateTarget,
})
export type UpdateGrantMessage = z.infer<typeof UpdateGrantMessage>

/**
 * Where a machine is, relative to its grant.
 *
 * `rejected` = the new build came up unhealthy and was rolled back. `stuck` = we
 * stopped trying and are pinned to last-known-good. Both are TERMINAL for that
 * grant: the machine will not retry on its own, because a machine that retries a
 * target that already failed it is a hot loop with extra steps.
 */
export const CONVERGENCE_STATES = [
  'current',
  'granted',
  'downloading',
  'restarting',
  'rejected',
  'stuck',
] as const
export type ConvergenceState = (typeof CONVERGENCE_STATES)[number]

/**
 * daemon -> server: progress against a grant, or an unsolicited report on
 * reconnect (no `grantId`) so the server learns where a machine landed even if
 * the grant was issued by a previous server process.
 *
 * NO `machineId`. The answering machine comes from the authenticated transport,
 * the rule every newer daemon frame follows. A machine id in this payload would
 * be a claim, and a claim is exactly what the transport already answers better.
 */
export const UpdateStatusMessage = z.object({
  type: z.literal('updateStatus'),
  grantId: z.string().min(1).optional(),
  state: z.enum(CONVERGENCE_STATES),
  /** What the daemon is running RIGHT NOW. A label, never parsed as a semver. */
  version: z.string().min(1),
  /** Human-readable detail for `rejected` / `stuck`. Never machine-parsed. */
  detail: z.string().optional(),
})
export type UpdateStatusMessage = z.infer<typeof UpdateStatusMessage>
```

Add `UpdateGrantMessage` to the `ControlMessage` union in `control.ts` (with its import), and `UpdateStatusMessage` to the `DaemonMessage` union in `daemon.ts` (with its import).

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- packages/protocol/src/messages/update.test.ts`
Expected: PASS, all nine cases. The `machineId` case passes because a plain `z.object` strips unknown keys; if it fails, someone added `.passthrough()`, which is wrong here: a status frame is a closed shape, unlike `/version` which must be extensible.

- [ ] **Step 5: Run the protocol suite**

Run: `bun run test:unit -- packages/protocol`
Expected: PASS. Adding a union member must not disturb existing dispatch tests.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/messages
git commit -m "feat(protocol): update grant and convergence status frames (POD-1670)"
```

---

## Task 2: What to converge to

**Files:**
- Create: `packages/protocol/src/update/convergence.ts`
- Create: `packages/protocol/src/update/convergence.test.ts`
- Modify: `packages/protocol/src/update/index.ts`

**Interfaces:**
- Consumes: `UpdateTarget`, `UpdateArtifact` from Phase 1 (as corrected by POD-1702, see below).
- Produces:
  - `type ConvergencePlan = { action: 'already-current' } | { action: 'converge'; delivery: UpdateArtifact['delivery']; asset: PlatformAsset } | { action: 'cannot'; reason: 'no-artifact' | 'unsupported-delivery' | 'unsupported-platform' }`
  - `planConvergence(ctx: { current: string; target: UpdateTarget; caps: readonly string[]; platform: string }): ConvergencePlan`

**The rule this task exists to encode:** target equality, not `isNewer`. A downgrade is a legitimate convergence, and refusing it is what makes rollback impossible.

**THE PLATFORM DIMENSION (corrected 2026-08-04, POD-1702).** `FeedArtifact` and `BundleArtifact` carry `platforms: Record<string, {url, digest, signature}>`, keyed by the target triples `platformTarget()` already produces (`linux-x86_64`, `linux-aarch64`, …). `GitArtifact` has none, because a checkout is platform-independent.

The planner therefore takes the running `platform` and selects `artifact.platforms[platform]`. **A missing entry is `cannot: 'unsupported-platform'`, never a fallback to some other platform's bytes.** The original spec lost this dimension and a worker nearly shipped "use the first prepared platform", which would hand an arm64 daemon an x86_64 tarball: the signature verifies (it is a real signature over those bytes), the digest matches, the swap succeeds, and the binary will not execute. Every gate green, machine bricked. A fleet with mixed architectures and a release that only built one is an ordinary situation, so this refusal path is load-bearing, not defensive padding.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/update/convergence.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { planConvergence } from './convergence'

const feed = {
  delivery: 'feed',
  platforms: {
    'linux-x86_64': { url: 'https://x.test/a-x64.tgz', digest: 'd1', signature: 's1' },
    'linux-aarch64': { url: 'https://x.test/a-arm.tgz', digest: 'd2', signature: 's2' },
  },
} as const
const target = (version: string, artifact: unknown = feed) =>
  ({ version, critical: false, artifacts: { headless: artifact } }) as never

const HOST = 'linux-x86_64'

const ALL_CAPS = ['update.delivery.feed', 'update.delivery.bundle', 'update.delivery.git']

describe('planConvergence', () => {
  it('is already-current on an exact match', () => {
    expect(planConvergence({ current: '0.4.2', target: target('0.4.2'), caps: ALL_CAPS, platform: HOST })).toEqual({
      action: 'already-current',
    })
  })

  it('converges upward', () => {
    const p = planConvergence({ current: '0.4.1', target: target('0.4.2'), caps: ALL_CAPS, platform: HOST })
    expect(p.action).toBe('converge')
  })

  it('converges DOWNWARD, because the server is authority and rollback must work', () => {
    const p = planConvergence({ current: '0.4.2', target: target('0.4.1'), caps: ALL_CAPS, platform: HOST })
    expect(p.action).toBe('converge')
  })

  it('converges between two development identities, which have no ordering', () => {
    const p = planConvergence({
      current: 'dev+aaaaaaa',
      target: target('dev+bbbbbbb'),
      caps: ALL_CAPS,
    })
    expect(p.action).toBe('converge')
  })

  it('refuses when the daemon cannot accept the offered delivery method', () => {
    // A source run offers only git; the target ships a feed tarball it cannot swap.
    const p = planConvergence({
      current: 'dev',
      target: target('0.4.2'),
      caps: ['update.delivery.git'],
    })
    expect(p).toEqual({ action: 'cannot', reason: 'unsupported-delivery' })
  })

  it('refuses when the target names no headless artifact at all', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: { version: '0.4.2', critical: false, artifacts: {} } as never,
      caps: ALL_CAPS,
    })
    expect(p).toEqual({ action: 'cannot', reason: 'no-artifact' })
  })

  it('refuses when the target has no bytes for THIS platform', () => {
    // An arm64 machine against a release that only built x86_64. Falling back to
    // another platform's bytes would verify, swap, and produce a binary that
    // cannot execute: every gate green, machine bricked.
    const p = planConvergence({
      current: '0.4.1',
      target: target('0.4.2'),
      caps: ALL_CAPS,
      platform: 'darwin-aarch64',
    })
    expect(p).toEqual({ action: 'cannot', reason: 'unsupported-platform' })
  })

  it('selects the asset for the running platform, never another one', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: target('0.4.2'),
      caps: ALL_CAPS,
      platform: 'linux-aarch64',
    })
    expect(p).toMatchObject({ action: 'converge', asset: { url: 'https://x.test/a-arm.tgz' } })
  })

  it('is already-current BEFORE checking delivery, so a matched source run is not an error', () => {
    // A source-run daemon already on the target must not be reported as broken
    // merely because it could not have downloaded the artifact.
    const p = planConvergence({
      current: '0.4.2',
      target: target('0.4.2'),
      caps: ['update.delivery.git'],
    })
    expect(p).toEqual({ action: 'already-current' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- packages/protocol/src/update/convergence.test.ts`
Expected: FAIL, cannot resolve `./convergence`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/update/convergence.ts`:

```ts
/**
 * WHAT A MACHINE SHOULD DO ABOUT ITS TARGET. Pure, so the whole decision is
 * testable without a socket, a filesystem, or a network.
 *
 * TARGET EQUALITY, NOT `isNewer`. The server is authority, so the question is
 * "am I running what I was told to run", not "is there something newer". Those
 * differ in exactly one place and it is the place that matters: a DOWNGRADE. A
 * planner that only ever moves forward makes rollback structurally impossible,
 * which would leave a bad release with no way out but a human on every box.
 *
 * Versions are compared as STRINGS. `appVersion` is a label and may be
 * `dev+<sha>`, which has no ordering at all. Anything that tries to sort these
 * is wrong.
 */
import type { UpdateArtifact, UpdateTarget } from './target'

export type ConvergencePlan =
  | { action: 'already-current' }
  | { action: 'converge'; artifact: UpdateArtifact }
  | { action: 'cannot'; reason: 'no-artifact' | 'unsupported-delivery' }

const CAP_FOR_DELIVERY: Record<UpdateArtifact['delivery'], string> = {
  feed: 'update.delivery.feed',
  bundle: 'update.delivery.bundle',
  git: 'update.delivery.git',
}

export function planConvergence(ctx: {
  current: string
  target: UpdateTarget
  caps: readonly string[]
}): ConvergencePlan {
  // Equality FIRST. A machine already on the target is fine regardless of what it
  // could or could not have downloaded, and reporting it as broken because of a
  // delivery method it never needed would be a detector firing on a healthy pair.
  if (ctx.current === ctx.target.version) return { action: 'already-current' }

  const artifact = ctx.target.artifacts.headless
  if (!artifact) return { action: 'cannot', reason: 'no-artifact' }
  if (!ctx.caps.includes(CAP_FOR_DELIVERY[artifact.delivery])) {
    return { action: 'cannot', reason: 'unsupported-delivery' }
  }
  return { action: 'converge', artifact }
}
```

Add `export * from './convergence'` to `packages/protocol/src/update/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- packages/protocol/src/update/convergence.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/update
git commit -m "feat(protocol): converge-to-target planning, downgrades included (POD-1670)"
```

---

## Task 3: The delivery abstraction

**Files:**
- Create: `apps/cli/src/delivery.ts`
- Create: `apps/cli/src/delivery.test.ts`
- Modify: `apps/cli/src/podium-update.ts`

**Interfaces:**
- Consumes: `UpdateArtifact` from Phase 1, `verifyTarball` from `podium-update.ts`.
- Produces: `fetchArtifact(asset: PlatformAsset, delivery: 'feed' | 'bundle' | 'git', deps: { fetch: typeof fetch; pubkey: string }): Promise<{ bytes: Uint8Array }>` — throws on a bad signature, a bad digest, or a failed download.

**It takes the RESOLVED asset, not the whole artifact.** Task 2's planner already picked the entry for this machine's platform, so the platform choice is made in exactly one place. A downloader that re-derived the platform would be a second place to get it wrong.

`git` delivery is NOT implemented here. It belongs to Phase 5, and this task must throw a clear "not implemented in this phase" rather than half-build it.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/delivery.test.ts`:

```ts
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fetchArtifact } from './delivery'

// An ephemeral keypair, so the test exercises the REAL verify path on a checkout
// that does not carry the gitignored dev signing key.
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const bodyBytes = new Uint8Array([1, 2, 3, 4])
const signature = cryptoSign(null, bodyBytes, privateKey).toString('base64')
const digest = 'sha256-placeholder' // replaced below by the real helper

const okFetch = (async () =>
  new Response(bodyBytes, { status: 200 })) as unknown as typeof fetch

describe('fetchArtifact', () => {
  it('returns the bytes for a correctly signed feed artifact', async () => {
    const { bytes } = await fetchArtifact(
      { url: 'https://x.test/a.tgz', digest, signature },
      'feed',
      { fetch: okFetch, pubkey, verifyDigest: false },
    )
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4])
  })

  it('verifies a bundle artifact with the SAME rigour as a feed artifact', async () => {
    // An authenticated socket is not a substitute for a signature. A server-hosted
    // bundle is bytes over a network like any other.
    const { bytes } = await fetchArtifact(
      { url: 'https://server.test/a.tgz', digest, signature },
      'bundle',
      { fetch: okFetch, pubkey, verifyDigest: false },
    )
    expect(bytes.length).toBe(4)
  })

  it('throws on a bad signature and never returns bytes', async () => {
    await expect(
      fetchArtifact(
        { url: 'https://x.test/a.tgz', digest, signature: 'AAAA' },
        'feed',
        { fetch: okFetch, pubkey, verifyDigest: false },
      ),
    ).rejects.toThrow(/signature/i)
  })

  it('throws on an empty signature rather than treating it as unsigned-but-fine', async () => {
    await expect(
      fetchArtifact(
        { url: 'https://x.test/a.tgz', digest, signature: '' },
        'feed',
        { fetch: okFetch, pubkey, verifyDigest: false },
      ),
    ).rejects.toThrow(/signature/i)
  })

  it('throws on a failed download', async () => {
    const bad = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(
      fetchArtifact(
        { url: 'https://x.test/a.tgz', digest, signature },
        'feed',
        { fetch: bad, pubkey, verifyDigest: false },
      ),
    ).rejects.toThrow(/404/)
  })

  it('refuses a git artifact in this phase instead of half-doing it', async () => {
    await expect(
      fetchArtifact(
        { url: '', digest: '', signature: '' },
        'git',
        { fetch: okFetch, pubkey },
      ),
    ).rejects.toThrow(/not implemented/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/cli/src/delivery.test.ts`
Expected: FAIL, cannot resolve `./delivery`.

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/delivery.ts`:

```ts
/**
 * DELIVERY: turn an artifact reference into verified bytes.
 *
 * Authority (what to run) and delivery (how the bytes arrive) are separate axes.
 * This module owns only the second one, which is why the caller never branches on
 * `delivery` itself.
 *
 * `bundle` VERIFIES EXACTLY LIKE `feed`. The bytes arrive over an authenticated
 * socket's origin, and that is not a substitute for a signature: authentication
 * says who you are talking to, a signature says what you were given. Defence in
 * depth here is cheap and the failure it prevents is arbitrary code execution.
 */
import { UpdateArtifact } from '@podium/protocol'
import { verifyTarball } from './podium-update'

export interface DeliveryDeps {
  fetch: typeof fetch
  pubkey: string
  /** Digest checking is a separate gate from the signature; off in unit tests
   *  that only exercise the signature path. */
  verifyDigest?: boolean
}

export async function fetchArtifact(
  asset: PlatformAsset,
  delivery: UpdateArtifact['delivery'],
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array }> {
  if (delivery === 'git') {
    throw new Error('git delivery is not implemented in this phase (Phase 5 owns it)')
  }

  const res = await deps.fetch(asset.url)
  if (!res.ok) throw new Error(`artifact download returned ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())

  // SECURITY GATE, before anything touches disk. Fail closed.
  if (!verifyTarball(bytes, asset.signature, deps.pubkey)) {
    throw new Error(
      'signature verification FAILED — refusing to install. The artifact was not ' +
        'signed by the trusted key (tampered, corrupt, or wrong feed). No changes were made.',
    )
  }
  return { bytes }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/cli/src/delivery.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/delivery.ts apps/cli/src/delivery.test.ts
git commit -m "feat(cli): delivery abstraction with signature verification on every path (POD-1670)"
```

---

## Task 4: The pending-grant marker

**Files:**
- Create: `apps/daemon/src/pending-grant.ts`
- Create: `apps/daemon/src/pending-grant.test.ts`

**Interfaces:**
- Produces:
  - `type PendingGrant = { grantId: string; targetVersion: string; previousVersion: string; attempts: number; startedAt: number }`
  - `readPendingGrant(dir: string): PendingGrant | null`
  - `writePendingGrant(dir: string, g: PendingGrant): void`
  - `clearPendingGrant(dir: string): void`

**Why a disk marker:** the daemon restarts in the middle of the operation. Nothing in memory survives that, so the only way to know on boot "I was mid-convergence, and to what" is a file written before the restart. Without it a failed swap is indistinguishable from a normal boot, and the health gate cannot exist.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearPendingGrant, readPendingGrant, writePendingGrant } from './pending-grant'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-grant-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const grant = {
  grantId: 'g1',
  targetVersion: '0.4.2',
  previousVersion: '0.4.1',
  attempts: 1,
  startedAt: 1_000,
}

describe('pending grant marker', () => {
  it('is null when there is none', () => {
    expect(readPendingGrant(dir)).toBeNull()
  })

  it('round-trips', () => {
    writePendingGrant(dir, grant)
    expect(readPendingGrant(dir)).toEqual(grant)
  })

  it('clears', () => {
    writePendingGrant(dir, grant)
    clearPendingGrant(dir)
    expect(readPendingGrant(dir)).toBeNull()
  })

  it('reads a corrupt marker as absent rather than throwing', () => {
    // A daemon that crashed mid-write must still be able to BOOT. A throw here
    // would turn a torn file into an unbootable daemon, which is strictly worse
    // than forgetting that a convergence was in flight.
    writeFileSync(join(dir, 'pending-update.json'), '{ not json')
    expect(readPendingGrant(dir)).toBeNull()
  })

  it('reads a marker missing required fields as absent', () => {
    writeFileSync(join(dir, 'pending-update.json'), JSON.stringify({ grantId: 'g1' }))
    expect(readPendingGrant(dir)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/daemon/src/pending-grant.test.ts`
Expected: FAIL, cannot resolve `./pending-grant`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The marker that survives the daemon's own restart.
 *
 * Convergence spans a process death by construction: swap the bytes, restart,
 * and find out on the other side whether the new build is healthy. Nothing in
 * memory crosses that boundary, so "was I mid-convergence, and to what" has to be
 * on disk or it cannot be asked at all. Without this file the health gate has no
 * way to tell a failed swap from an ordinary boot.
 *
 * Every read failure degrades to `null`. A daemon that crashed mid-write must
 * still BOOT: turning a torn file into an unbootable daemon is strictly worse
 * than forgetting that a convergence was in flight, because the second is
 * recoverable by the next grant and the first needs a human on the box.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PendingGrant {
  grantId: string
  targetVersion: string
  /** What to roll back TO. Read from disk before the swap, not guessed after it. */
  previousVersion: string
  attempts: number
  startedAt: number
}

const FILE = 'pending-update.json'

export function readPendingGrant(dir: string): PendingGrant | null {
  const path = join(dir, FILE)
  if (!existsSync(path)) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const g = raw as Partial<PendingGrant>
    if (
      typeof g.grantId !== 'string' ||
      typeof g.targetVersion !== 'string' ||
      typeof g.previousVersion !== 'string' ||
      typeof g.attempts !== 'number' ||
      typeof g.startedAt !== 'number'
    ) {
      return null
    }
    return g as PendingGrant
  } catch {
    return null
  }
}

export function writePendingGrant(dir: string, g: PendingGrant): void {
  writeFileSync(join(dir, FILE), JSON.stringify(g))
}

export function clearPendingGrant(dir: string): void {
  rmSync(join(dir, FILE), { force: true })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/daemon/src/pending-grant.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/pending-grant.ts apps/daemon/src/pending-grant.test.ts
git commit -m "feat(daemon): pending-grant marker surviving the convergence restart (POD-1670)"
```

---

## Task 5: The health gate and the attempt bound

**Files:**
- Create: `apps/daemon/src/convergence.ts`
- Create: `apps/daemon/src/convergence.test.ts`

**Interfaces:**
- Consumes: `PendingGrant` from Task 4.
- Produces:
  - `type BootVerdict = { action: 'confirm'; state: 'current' } | { action: 'retry'; attempts: number } | { action: 'rollback'; state: 'rejected' | 'stuck'; detail: string }`
  - `MAX_CONVERGENCE_ATTEMPTS = 2`
  - `resolveOnBoot(ctx: { pending: PendingGrant | null; runningVersion: string }): BootVerdict | null`

**The property:** a daemon that comes back on a version that is not its target has failed, and after a bounded number of attempts it pins to last-known-good rather than looping forever.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { MAX_CONVERGENCE_ATTEMPTS, resolveOnBoot } from './convergence'

const pending = {
  grantId: 'g1',
  targetVersion: '0.4.2',
  previousVersion: '0.4.1',
  attempts: 1,
  startedAt: 1_000,
}

describe('resolveOnBoot', () => {
  it('does nothing on an ordinary boot with no pending grant', () => {
    expect(resolveOnBoot({ pending: null, runningVersion: '0.4.2' })).toBeNull()
  })

  it('confirms when the daemon came back ON the target', () => {
    expect(resolveOnBoot({ pending, runningVersion: '0.4.2' })).toEqual({
      action: 'confirm',
      state: 'current',
    })
  })

  it('retries when the swap did not take and attempts remain', () => {
    expect(resolveOnBoot({ pending, runningVersion: '0.4.1' })).toEqual({
      action: 'retry',
      attempts: 2,
    })
  })

  it('gives up and pins to last-known-good once attempts are exhausted', () => {
    const v = resolveOnBoot({
      pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
      runningVersion: '0.4.1',
    })
    expect(v).toMatchObject({ action: 'rollback', state: 'stuck' })
  })

  it('confirms even at the attempt ceiling, if the daemon actually made it', () => {
    // The ceiling bounds FAILURES, not successes. A daemon that arrived on the
    // target on its last attempt is current, not stuck.
    expect(
      resolveOnBoot({
        pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
        runningVersion: '0.4.2',
      }),
    ).toEqual({ action: 'confirm', state: 'current' })
  })

  it('treats an unexpected third version as a failure, not a success', () => {
    // Landing on something that is neither the target nor the previous version
    // means the swap did something we did not predict. That is not "close enough".
    const v = resolveOnBoot({
      pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
      runningVersion: '0.3.0',
    })
    expect(v).toMatchObject({ action: 'rollback' })
  })

  it('bounds at two attempts', () => {
    expect(MAX_CONVERGENCE_ATTEMPTS).toBe(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/daemon/src/convergence.test.ts`
Expected: FAIL, cannot resolve `./convergence`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * THE HEALTH GATE, resolved on boot. Pure, in the style of `./self-update.ts`.
 *
 * The only honest evidence that a new build works is that it came up and said so.
 * So the gate is: write what we were trying to reach BEFORE restarting, then on
 * the other side compare what is actually running against it.
 *
 * The attempt bound exists because the failure it prevents is the worst one
 * available here: update, restart, still wrong, update again, forever, on every
 * machine at once. After the bound we stop and SAY we stopped. A machine pinned
 * to a known-good build and reporting `stuck` is recoverable by a human; a
 * machine in a restart loop is not, because it is never up long enough to be told
 * anything.
 */
import type { PendingGrant } from './pending-grant'

export const MAX_CONVERGENCE_ATTEMPTS = 2

export type BootVerdict =
  | { action: 'confirm'; state: 'current' }
  | { action: 'retry'; attempts: number }
  | { action: 'rollback'; state: 'rejected' | 'stuck'; detail: string }

export function resolveOnBoot(ctx: {
  pending: PendingGrant | null
  runningVersion: string
}): BootVerdict | null {
  const { pending, runningVersion } = ctx
  if (!pending) return null

  // Success is checked FIRST and unconditionally. The bound limits failures, not
  // successes: a daemon that arrived on its last permitted attempt is current.
  if (runningVersion === pending.targetVersion) return { action: 'confirm', state: 'current' }

  if (pending.attempts < MAX_CONVERGENCE_ATTEMPTS) {
    return { action: 'retry', attempts: pending.attempts + 1 }
  }

  return {
    action: 'rollback',
    state: 'stuck',
    detail:
      `did not reach ${pending.targetVersion} after ${pending.attempts} attempt(s); ` +
      `running ${runningVersion}, pinned to last-known-good`,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/daemon/src/convergence.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/convergence.ts apps/daemon/src/convergence.test.ts
git commit -m "feat(daemon): boot-time health gate with a bounded attempt count (POD-1670)"
```

---

## Task 6: The daemon applies a grant

**Files:**
- Modify: `apps/daemon/src/connection-state.ts:201-217` and the daemon's control-frame dispatch
- Modify: `apps/daemon/src/self-update.ts`
- Test: `apps/daemon/src/grant-apply.test.ts` (create)

**Interfaces:**
- Consumes: `planConvergence`, `fetchArtifact`, the pending marker, `resolveOnBoot`.
- Produces: `applyGrant(grant, deps)` where every side effect is an injected dep, so the test drives the whole sequence with no network, no disk and no restart.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { applyGrant } from './grant-apply'

const target = {
  version: '0.4.2',
  critical: false,
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: { 'linux-x86_64': { url: 'https://x.test/a.tgz', digest: 'd', signature: 's' } },
    },
  },
} as never

function deps(over: Partial<Parameters<typeof applyGrant>[1]> = {}) {
  return {
    currentVersion: () => '0.4.1',
    caps: ['update.delivery.feed', 'update.delivery.bundle'],
    fetchArtifact: vi.fn(async () => ({ bytes: new Uint8Array([1]) })),
    swap: vi.fn(),
    writePending: vi.fn(),
    restart: vi.fn(),
    report: vi.fn(),
    now: () => 1_000,
    ...over,
  }
}

describe('applyGrant', () => {
  it('reports current without swapping when already on the target', async () => {
    const d = deps({ currentVersion: () => '0.4.2' })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.swap).not.toHaveBeenCalled()
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'current', version: '0.4.2' }),
    )
  })

  it('writes the pending marker BEFORE restarting', async () => {
    const order: string[] = []
    const d = deps({
      writePending: vi.fn(() => void order.push('write')),
      restart: vi.fn(() => void order.push('restart')),
    })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    // If these ever invert, a failed swap becomes indistinguishable from a normal
    // boot and the health gate silently stops existing.
    expect(order).toEqual(['write', 'restart'])
  })

  it('does not swap when the signature check throws', async () => {
    const d = deps({
      fetchArtifact: vi.fn(async () => {
        throw new Error('signature verification FAILED')
      }),
    })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.swap).not.toHaveBeenCalled()
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.report).toHaveBeenCalledWith(expect.objectContaining({ state: 'rejected' }))
  })

  it('records the version it is rolling back TO before swapping', async () => {
    const d = deps()
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.writePending).toHaveBeenCalledWith(
      expect.objectContaining({ previousVersion: '0.4.1', targetVersion: '0.4.2', attempts: 1 }),
    )
  })

  it('reports rejected and does not restart when it cannot accept the delivery method', async () => {
    const d = deps({ caps: ['update.delivery.git'] })
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    expect(d.restart).not.toHaveBeenCalled()
    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'rejected', detail: expect.stringMatching(/delivery/) }),
    )
  })

  it('reports downloading before it reports restarting', async () => {
    const d = deps()
    await applyGrant({ type: 'updateGrant', grantId: 'g1', target }, d)
    const states = d.report.mock.calls.map((c) => (c[0] as { state: string }).state)
    expect(states).toEqual(['downloading', 'restarting'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/daemon/src/grant-apply.test.ts`
Expected: FAIL, cannot resolve `./grant-apply`.

- [ ] **Step 3: Write the implementation**

Create `apps/daemon/src/grant-apply.ts` with every effect injected, then wire the real deps at the daemon's control-frame dispatch (next to how `inventoryRequest` is handled). Order is the contract: report `downloading`, fetch and verify, swap, write the marker, report `restarting`, restart.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/daemon/src/grant-apply.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Make the 426 path defer to grants when attached**

In `connection-state.ts:201-217`, an attached daemon must no longer shell out to `podium update` on a protocol mismatch: that is the daemon acting on a version delta by itself, which the server now owns. It should report the mismatch and back off, letting the server issue a grant. Keep the existing self-update behaviour for an UNATTACHED install.

Add a test asserting that an attached daemon on a 426 does not spawn `podium update`.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src
git commit -m "feat(daemon): apply update grants with verify, marker, restart (POD-1670)"
```

---

## Task 7: The wave planner

**Files:**
- Create: `apps/server/src/modules/updates/wave.ts`
- Create: `apps/server/src/modules/updates/wave.test.ts`

**Interfaces:**
- Produces:
  - `type WaveMachine = { id: string; version: string; state: ConvergenceState; online: boolean; busy: boolean }`
  - `planWave(ctx: { machines: readonly WaveMachine[]; targetVersion: string; concurrency: number; canaryHealthy: boolean }): string[]`

**The property this exists for:** without it, publishing a target moves every machine at once, and one bad bundle takes the whole fleet down simultaneously.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { planWave, type WaveMachine } from './wave'

const m = (over: Partial<WaveMachine> & { id: string }): WaveMachine => ({
  version: '0.4.1',
  state: 'current',
  online: true,
  busy: false,
  ...over,
})

const base = { targetVersion: '0.4.2', concurrency: 3 }

describe('planWave', () => {
  it('grants exactly one canary first', () => {
    const out = planWave({
      ...base,
      canaryHealthy: false,
      machines: [m({ id: 'a' }), m({ id: 'b' }), m({ id: 'c' })],
    })
    expect(out).toHaveLength(1)
  })

  it('prefers an idle machine as the canary', () => {
    const out = planWave({
      ...base,
      canaryHealthy: false,
      machines: [m({ id: 'busy', busy: true }), m({ id: 'idle' })],
    })
    expect(out).toEqual(['idle'])
  })

  it('grants nothing more until the canary is healthy', () => {
    const out = planWave({
      ...base,
      canaryHealthy: false,
      machines: [m({ id: 'a', state: 'restarting' }), m({ id: 'b' }), m({ id: 'c' })],
    })
    // One is already in flight, and the canary has not reported healthy. Widening
    // here is exactly the fleet-wide outage the wave exists to prevent.
    expect(out).toEqual([])
  })

  it('widens up to the concurrency cap once the canary is healthy', () => {
    const out = planWave({
      ...base,
      canaryHealthy: true,
      machines: [
        m({ id: 'a', version: '0.4.2' }),
        m({ id: 'b' }),
        m({ id: 'c' }),
        m({ id: 'd' }),
        m({ id: 'e' }),
      ],
    })
    expect(out).toHaveLength(3)
    expect(out).not.toContain('a')
  })

  it('counts in-flight machines against the cap', () => {
    const out = planWave({
      ...base,
      canaryHealthy: true,
      machines: [
        m({ id: 'a', state: 'downloading' }),
        m({ id: 'b', state: 'restarting' }),
        m({ id: 'c' }),
        m({ id: 'd' }),
      ],
    })
    expect(out).toHaveLength(1)
  })

  it('never grants to an offline machine', () => {
    const out = planWave({
      ...base,
      canaryHealthy: true,
      machines: [m({ id: 'off', online: false }), m({ id: 'on' })],
    })
    expect(out).toEqual(['on'])
  })

  it('never re-grants to a machine that already rejected this target', () => {
    // Re-granting a target that already failed a machine is a hot loop with a
    // network round trip in it.
    const out = planWave({
      ...base,
      canaryHealthy: true,
      machines: [m({ id: 'bad', state: 'rejected' }), m({ id: 'ok' })],
    })
    expect(out).toEqual(['ok'])
  })

  it('never re-grants to a stuck machine', () => {
    const out = planWave({
      ...base,
      canaryHealthy: true,
      machines: [m({ id: 'stuck', state: 'stuck' })],
    })
    expect(out).toEqual([])
  })

  it('grants nothing when every machine is already on the target', () => {
    const out = planWave({
      ...base,
      canaryHealthy: true,
      machines: [m({ id: 'a', version: '0.4.2' }), m({ id: 'b', version: '0.4.2' })],
    })
    expect(out).toEqual([])
  })

  it('is deterministic for the same input', () => {
    const machines = [m({ id: 'a' }), m({ id: 'b' }), m({ id: 'c' })]
    const one = planWave({ ...base, canaryHealthy: true, machines })
    const two = planWave({ ...base, canaryHealthy: true, machines })
    expect(one).toEqual(two)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/server/src/modules/updates/wave.test.ts`
Expected: FAIL, cannot resolve `./wave`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * THE WAVE PLANNER. Pure and deterministic: given the fleet and the target, which
 * machines may move right now.
 *
 * Automatic convergence without this is a fleet-wide outage waiting for one bad
 * bundle: publish, and every machine swaps at the same moment. So the shape is
 * canary, soak, widen. One machine goes first; nothing else moves until that one
 * has come back healthy ON the target; then the rest go in batches under a cap.
 *
 * `rejected` and `stuck` machines are never re-granted. Retrying a target that
 * already failed a machine is a hot loop with a network round trip in it, and the
 * machine has already told us what happens.
 */
import type { ConvergenceState } from '@podium/protocol'

export interface WaveMachine {
  id: string
  version: string
  state: ConvergenceState
  online: boolean
  /** Has live agent sessions. Only a canary preference, never a veto: work
   *  survives the restart, so busy is a tiebreak and not a reason to skip. */
  busy: boolean
}

const IN_FLIGHT: ReadonlySet<ConvergenceState> = new Set(['granted', 'downloading', 'restarting'])
const TERMINAL_FAILURE: ReadonlySet<ConvergenceState> = new Set(['rejected', 'stuck'])

export function planWave(ctx: {
  machines: readonly WaveMachine[]
  targetVersion: string
  concurrency: number
  canaryHealthy: boolean
}): string[] {
  const inFlight = ctx.machines.filter((m) => IN_FLIGHT.has(m.state)).length

  const eligible = ctx.machines.filter(
    (m) =>
      m.online &&
      m.version !== ctx.targetVersion &&
      !IN_FLIGHT.has(m.state) &&
      !TERMINAL_FAILURE.has(m.state),
  )
  if (eligible.length === 0) return []

  if (!ctx.canaryHealthy) {
    // Something is already proving the target. Do not add to it.
    if (inFlight > 0) return []
    // Prefer an idle machine to carry the risk, then fall back to a stable order
    // so the same fleet always produces the same plan.
    const idle = eligible.filter((m) => !m.busy)
    const pool = idle.length > 0 ? idle : eligible
    return [[...pool].sort((a, b) => a.id.localeCompare(b.id))[0].id]
  }

  const room = Math.max(0, ctx.concurrency - inFlight)
  return [...eligible]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, room)
    .map((m) => m.id)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/server/src/modules/updates/wave.test.ts`
Expected: PASS, all ten cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/updates
git commit -m "feat(server): canary-then-widen wave planner (POD-1670)"
```

---

## Task 8: The updates service

**Files:**
- Create: `apps/server/src/modules/updates/service.ts`
- Test: `apps/server/src/modules/updates/service.test.ts`
- Modify: the server's daemon-frame dispatch, to route `updateStatus`

**Interfaces:**
- Consumes: `planWave`, the persisted machine build state from Phase 1, the machine send seam.
- Produces: `UpdatesService` with `setTarget(t: UpdateTarget)`, `onStatus(machineId, msg)`, `tick()` (issues grants for whatever `planWave` returns), and `fleet()` for the read model.

Time is injected. Grant ids are injected too: `Math.random()` and `Date.now()` make a service untestable and this one has to be exactly reproducible.

- [ ] **Step 1: Write the failing test**

Cases to cover, each asserting one property:

```ts
import { describe, expect, it, vi } from 'vitest'
import { UpdatesService } from './service'

function make(machines: unknown[]) {
  const send = vi.fn()
  let n = 0
  const svc = new UpdatesService({
    machines: () => machines as never,
    send,
    now: () => 1_000,
    nextGrantId: () => `g${++n}`,
    concurrency: 3,
  })
  return { svc, send }
}

const m = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  version: '0.4.1',
  state: 'current',
  online: true,
  busy: false,
  ...over,
})

describe('UpdatesService', () => {
  it('issues no grants until a target is set', () => {
    const { svc, send } = make([m('a')])
    svc.tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('grants one canary on the first tick', () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not widen until the canary reports current AT the target', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus('a', { type: 'updateStatus', state: 'current', version: '0.4.1' })
    svc.tick()
    // Reported current, but on the OLD version: that is not a healthy canary.
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('widens once the canary reports current at the target version', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus('a', { type: 'updateStatus', state: 'current', version: '0.4.2' })
    svc.tick()
    expect(send.mock.calls.length).toBeGreaterThan(1)
  })

  it('a rejected canary halts the wave entirely', () => {
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus('a', { type: 'updateStatus', state: 'rejected', version: '0.4.1' })
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('resets canary health when the target changes', () => {
    // A new target has proven nothing. Carrying the previous target's health over
    // would skip the canary for every release after the first.
    const { svc, send } = make([m('a'), m('b'), m('c')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.onStatus('a', { type: 'updateStatus', state: 'current', version: '0.4.2' })
    svc.setTarget({ version: '0.4.3', critical: false, artifacts: {} } as never)
    send.mockClear()
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a second tick with nothing changed grants nothing new', () => {
    const { svc, send } = make([m('a'), m('b')])
    svc.setTarget({ version: '0.4.2', critical: false, artifacts: {} } as never)
    svc.tick()
    svc.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/server/src/modules/updates/service.test.ts`
Expected: FAIL, cannot resolve `./service`.

- [ ] **Step 3: Write the implementation**

The service holds the target, a per-machine convergence state map keyed by machine id, and a `canaryHealthy` flag that **resets whenever the target changes**. `tick()` calls `planWave` and sends an `updateGrant` to each returned machine, marking it `granted` so the next tick counts it as in flight.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- apps/server/src/modules/updates/service.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Route `updateStatus` from the daemon dispatch into `onStatus`, and surface `fleet()` on the machines read model**

Add a test that a status frame arriving on machine A's authenticated transport updates machine A, and that a frame claiming to be about machine B does not touch B.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src
git commit -m "feat(server): updates service issuing grants and tracking convergence (POD-1670)"
```

---

## Task 9: The daily timer stands down for attached daemons

**Files:**
- Modify: `apps/cli/src/cli-systemd.ts`
- Regenerate: `scripts/systemd/*`
- Test: `apps/cli/src/cli-systemd.test.ts`

**The bug being fixed:** `podium-update-user.timer` runs `podium update` daily and restarts the daemon on exit 10. On an attached daemon that is a machine acting on a version delta by itself, which races the server's wave orchestration and defeats both the canary and the concurrency cap. It stays for standalone installs, where "newest on the channel" is still the right default.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { shouldInstallUpdateTimer } from './cli-systemd'

describe('shouldInstallUpdateTimer', () => {
  it('installs for a standalone install with no server', () => {
    expect(shouldInstallUpdateTimer({ mode: 'all-in-one', serverUrl: undefined })).toBe(true)
  })

  it('does NOT install for a daemon attached to a server', () => {
    // Its server is authority and orchestrates waves. A daily self-update here
    // races that orchestration and defeats the canary.
    expect(shouldInstallUpdateTimer({ mode: 'daemon', serverUrl: 'wss://hub.test' })).toBe(false)
  })

  it('does not install for a client attached to a server', () => {
    expect(shouldInstallUpdateTimer({ mode: 'client', serverUrl: 'wss://hub.test' })).toBe(false)
  })

  it('installs for a server, which no one else is authority for', () => {
    expect(shouldInstallUpdateTimer({ mode: 'server', serverUrl: undefined })).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- apps/cli/src/cli-systemd.test.ts`
Expected: FAIL, `shouldInstallUpdateTimer` is not exported.

- [ ] **Step 3: Write the implementation**

Export the predicate from `cli-systemd.ts` and gate the update timer's installation on it.

- [ ] **Step 4: Run the test, then regenerate the units**

```bash
bun run test:unit -- apps/cli/src/cli-systemd.test.ts
bun scripts/render-systemd.ts
bun run lint
```

Expected: tests PASS; `lint` PASSES including `systemd:diff`. Never hand-edit a file under `scripts/systemd/`; they carry a GENERATED banner and the diff check will fail you.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/cli-systemd.ts apps/cli/src/cli-systemd.test.ts scripts/systemd
git commit -m "fix(systemd): no daily self-update timer on a server-attached daemon (POD-1670)"
```

---

## Verification for the whole phase

- [ ] `bun run typecheck` passes (a cache hit is evidence).
- [ ] `bun run test:unit`, `bun run test:web` pass.
- [ ] `bun run lint` passes, including `systemd:diff`.
- [ ] **Runtime, and this one is not optional.** With a server and at least one daemon: set a target, watch exactly one canary get granted, watch it swap and come back, confirm the fleet widens only after it reports at the target. Then set a deliberately broken target (a signature that will not verify) and confirm the canary reports `rejected`, is not re-granted, and **the wave does not widen**.
- [ ] **Work survival, verified by hand:** start an agent session on a machine, converge that machine, and confirm the session is still alive and reattaches afterwards. This is the promise the dialog makes to users in Phase 3; if it is not true, Phase 3's copy is a lie.
- [ ] Prove the gates can fire: plant a target that no machine can accept and confirm `cannot` is reported rather than silence.

---

## Out of scope, on purpose

- `git` delivery. Task 3 throws for it. Phase 5 owns it.
- Any UI. Phase 3 owns the dialog; this phase's output is visible through `fleet()` and the machines read model only.
- Anything touching the server's own binary or its database. The server is moved by a human click, and that is Phase 3's surface.
- Restoring a database on rollback. Rollback here is a binary swap and nothing else, per spec §13.3.

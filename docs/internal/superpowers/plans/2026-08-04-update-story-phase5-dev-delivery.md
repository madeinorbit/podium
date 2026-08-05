# Update story, Phase 5: development delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a development server distribute the code it is actually running, so a remote daemon on a dev stack can converge through the same path production uses, and so everyday development becomes the continuous test of the release mechanism.

**Architecture:** The dev server publishes a `dev+<sha>` target whose headless artifact is `bundle`-delivered from its own checkout. Building that bundle is expensive, so it is explicit or debounced, never per-commit, and it is guarded by a `podium lock` so two triggers cannot build at once. The machine that owns the checkout keeps the existing git-based redeploy, expressed as a `git` delivery target so it shares the same authority and reporting rather than being a second mechanism.

**Tech Stack:** TypeScript, Bun, `scripts/build-bun.ts`, `podium lock`, systemd path units.

**Spec:** `docs/internal/superpowers/specs/2026-08-04-coherent-update-story-design.md`, §9. Gap item 17.

**Depends on:** Phase 2 (POD-1696) for the delivery abstraction and convergence. **Do not start until it has landed on main.**

## Global Constraints

- **The development host is the live host.** A build here competes with the running server, the daemon, and every agent session on the box. Forced recomputes have starved this machine before. The build must be explicit or debounced, never triggered per commit, and never run twice concurrently.
- **`podium lock` is advisory and expires.** Default TTL is 2 minutes, which is shorter than a bundle build. Pass an explicit `--ttl` and renew, or the lock lapses mid-build and stops being a lock.
- **Development is not a channel.** `stable` and `edge` are channels; development is a different *identity* with no semver. Nothing may compare `dev+<sha>` against a semver or sort two of them.
- **The signature gate is not relaxed for development.** A dev bundle is signed with the development key and verified like any other. A path that skips verification in dev is a path that can be reached in production by a misconfiguration.
- **Do not weaken the production path to make dev fit.** If they diverge, dev is wrong.
- Run `bun run typecheck` and trust a cache hit. Never force a recompute; this is the machine that guidance exists for.
- No fixed sleeps in tests.

---

## File Structure

**Created:**
- `apps/server/src/modules/updates/dev-bundle.ts` — decide whether to build, and produce the `dev+<sha>` target. Pure decisions separated from the spawn.
- `apps/server/src/modules/updates/dev-bundle.test.ts`
- `apps/server/src/modules/updates/artifact-route.ts` — serve the built bundle and its signature.
- `apps/cli/src/delivery-git.ts` — `git` delivery: fetch, checkout, restart.

**Modified:**
- `apps/cli/src/delivery.ts` — `git` stops throwing and delegates to `delivery-git.ts`.
- `apps/server/src/server.ts` — mount the artifact route; wire `updateTarget` to the dev builder when running from source.

---

## Task 1: Deciding whether to build

**Files:**
- Create: `apps/server/src/modules/updates/dev-bundle.ts`, `.test.ts`

**Interfaces:**
- Produces:
  - `type BuildDecision = { build: false; reason: 'up-to-date' | 'debounced' | 'in-flight' | 'not-a-source-run' } | { build: true }`
  - `decideDevBuild(ctx: { isSourceRun: boolean; headSha: string; builtSha: string | null; lastAttemptAt: number | null; now: number; inFlight: boolean; debounceMs: number; explicit: boolean }): BuildDecision`

**The hazard this encodes:** a naive "rebuild when HEAD moves" on this repository rebuilds on every merge, from many parallel agents, on the machine that is also running everything.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { decideDevBuild } from './dev-bundle'

const base = {
  isSourceRun: true,
  headSha: 'aaa',
  builtSha: null as string | null,
  lastAttemptAt: null as number | null,
  now: 100_000,
  inFlight: false,
  debounceMs: 60_000,
  explicit: false,
}

describe('decideDevBuild', () => {
  it('builds when nothing has been built yet', () => {
    expect(decideDevBuild(base)).toEqual({ build: true })
  })

  it('does not build when the built bundle already matches HEAD', () => {
    expect(decideDevBuild({ ...base, builtSha: 'aaa' })).toEqual({
      build: false,
      reason: 'up-to-date',
    })
  })

  it('does not build a second time while one is in flight', () => {
    // Two concurrent bun compiles on the machine that is also running the server
    // and every agent session is exactly the starvation this guards against.
    expect(decideDevBuild({ ...base, inFlight: true })).toEqual({
      build: false,
      reason: 'in-flight',
    })
  })

  it('debounces a rapid series of merges', () => {
    expect(decideDevBuild({ ...base, builtSha: 'old', lastAttemptAt: 90_000 })).toEqual({
      build: false,
      reason: 'debounced',
    })
  })

  it('builds once the debounce window has passed', () => {
    expect(decideDevBuild({ ...base, builtSha: 'old', lastAttemptAt: 30_000 })).toEqual({
      build: true,
    })
  })

  it('an explicit request bypasses the debounce', () => {
    // A human asking for it now is not a merge storm.
    expect(
      decideDevBuild({ ...base, builtSha: 'old', lastAttemptAt: 99_999, explicit: true }),
    ).toEqual({ build: true })
  })

  it('an explicit request still does not stack on an in-flight build', () => {
    expect(
      decideDevBuild({ ...base, builtSha: 'old', explicit: true, inFlight: true }),
    ).toEqual({ build: false, reason: 'in-flight' })
  })

  it('an explicit request still does nothing when already up to date', () => {
    expect(decideDevBuild({ ...base, builtSha: 'aaa', explicit: true })).toEqual({
      build: false,
      reason: 'up-to-date',
    })
  })

  it('never builds on an installed (non-source) server', () => {
    // An installed server has no checkout to build from. It follows a channel.
    expect(decideDevBuild({ ...base, isSourceRun: false, explicit: true })).toEqual({
      build: false,
      reason: 'not-a-source-run',
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:unit -- apps/server/src/modules/updates/dev-bundle.test.ts`
Expected: FAIL, cannot resolve `./dev-bundle`.

- [ ] **Step 3: Implement**

Order matters and the tests pin it: `not-a-source-run`, then `up-to-date`, then `in-flight`, then `debounced`, then build. Lead the file with why:

```ts
/**
 * WHETHER TO BUILD A DEVELOPMENT BUNDLE.
 *
 * The development host is the LIVE host: the server, the daemon and every agent
 * session share it. A `bun build --compile` here competes with all of them, and
 * this repository merges many parallel branches a day, so "rebuild when HEAD
 * moves" would mean rebuilding constantly on the one machine that can least
 * afford it.
 *
 * So: never per-commit. Explicit, or debounced, and never two at once. Pure, so
 * the policy is a table of tests rather than a judgement call at a call site.
 */
```

- [ ] **Step 4: Run to verify it passes**

Expected: PASS, all nine cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/updates
git commit -m "feat(server): development bundle build policy (POD-1670)"
```

---

## Task 2: Building and publishing the dev target

**Files:**
- Modify: `apps/server/src/modules/updates/dev-bundle.ts`
- Create: `apps/server/src/modules/updates/artifact-route.ts`

**Interfaces:**
- Produces:
  - `buildDevBundle(deps): Promise<{ version: string; path: string; digest: string; signature: string }>`
  - `devTarget(built): UpdateTarget` with a `bundle`-delivered headless artifact pointing at this server's own artifact route.

- [ ] **Step 1: Take the lock properly**

Wrap the build in `podium lock acquire podium:dev-bundle --ttl 15m`, and **renew it** while the build runs. The default 2 minute TTL is shorter than a `bun build --compile`, so a default-TTL lock lapses mid-build and silently stops excluding anything. Release immediately when done.

- [ ] **Step 2: Write the failing test**

Cover, with the build spawn injected so no test compiles anything:
- the version is `dev+<short sha>`;
- the artifact is `bundle`-delivered and its url points at this server's artifact route;
- the artifact carries a real signature produced by the dev key;
- a build failure leaves the previous target in place rather than publishing a broken one;
- the lock is acquired before the build starts and released after it finishes, including on failure.

- [ ] **Step 3: Implement, run, commit**

```bash
git add apps/server/src/modules/updates
git commit -m "feat(server): build and serve a signed development bundle (POD-1670)"
```

---

## Task 3: The artifact route

**Files:**
- Create: `apps/server/src/modules/updates/artifact-route.ts`
- Modify: `apps/server/src/server.ts`

Serves the built bundle bytes. Requires the same authentication every other machine-facing route requires: an unauthenticated artifact endpoint on a dev box is a file server for whatever the machine can reach.

- [ ] **Step 1: Write the failing test**

Cover: an authenticated machine gets the bytes; an unauthenticated request is refused; a request for a version that is not the current build is refused rather than serving a stale file; the response is byte-identical to what was signed.

The last one matters most. If the served bytes and the signed bytes can ever differ, every daemon rejects the update and the failure looks like a signing bug rather than a serving bug.

- [ ] **Step 2: Implement, run, commit**

```bash
git add apps/server/src
git commit -m "feat(server): authenticated artifact route for bundle delivery (POD-1670)"
```

---

## Task 4: `git` delivery

**Files:**
- Create: `apps/cli/src/delivery-git.ts`, `.test.ts`
- Modify: `apps/cli/src/delivery.ts`

**Interfaces:**
- Produces: `convergeViaGit(artifact: { repo: string; sha: string }, deps: { run: (cmd: string, args: string[]) => { status: number | null; stdout: string } }): { ok: true } | { ok: false; reason: string }`

**Hard safety requirement:** this runs `git` in a checkout that may contain agent worktrees and uncommitted work. It must **fetch and check out the sha**, and it must **refuse when the working tree is dirty** rather than discarding someone's work. A convergence mechanism that can eat uncommitted changes is worse than no convergence mechanism.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { convergeViaGit } from './delivery-git'

const runner = (results: Record<string, { status: number; stdout?: string }>) =>
  vi.fn((_cmd: string, args: string[]) => {
    const key = args[args.indexOf('-C') + 2] ?? args[0]
    return { status: results[key]?.status ?? 0, stdout: results[key]?.stdout ?? '' }
  })

describe('convergeViaGit', () => {
  it('refuses when the working tree is dirty', () => {
    // This checkout may hold agent worktrees and uncommitted work. Discarding it
    // to converge would be strictly worse than not converging.
    const run = runner({ status: { status: 0, stdout: ' M some/file.ts' } })
    const r = convergeViaGit({ repo: '/src/podium', sha: 'abc' }, { run })
    expect(r).toEqual({ ok: false, reason: 'dirty-working-tree' })
  })

  it('never runs a destructive command on the refusal path', () => {
    const run = runner({ status: { status: 0, stdout: ' M f.ts' } })
    convergeViaGit({ repo: '/src/podium', sha: 'abc' }, { run })
    const all = run.mock.calls.flatMap((c) => c[1] as string[]).join(' ')
    expect(all).not.toMatch(/reset|clean|--hard|--force/)
  })

  it('fetches before checking out', () => {
    const run = runner({ status: { status: 0, stdout: '' } })
    convergeViaGit({ repo: '/src/podium', sha: 'abc' }, { run })
    const order = run.mock.calls.map((c) => (c[1] as string[]).find((a) => !a.startsWith('-')))
    expect(order.indexOf('fetch')).toBeLessThan(order.indexOf('checkout'))
  })

  it('reports failure when the sha does not exist after fetching', () => {
    const run = vi.fn((_c: string, args: string[]) => ({
      status: args.includes('checkout') ? 1 : 0,
      stdout: '',
    }))
    expect(convergeViaGit({ repo: '/src/podium', sha: 'nope' }, { run })).toEqual({
      ok: false,
      reason: 'checkout-failed',
    })
  })

  it('succeeds on a clean tree with a reachable sha', () => {
    const run = runner({ status: { status: 0, stdout: '' } })
    expect(convergeViaGit({ repo: '/src/podium', sha: 'abc' }, { run })).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run to verify it fails, 3: implement, 4: run to verify it passes**

Then remove the `not implemented` throw from `delivery.ts` and delegate.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src
git commit -m "feat(cli): git delivery, refusing to converge over a dirty tree (POD-1670)"
```

---

## Verification for the whole phase

- [ ] `bun run typecheck`, `bun run test:unit` pass.
- [ ] **Runtime, the point of the whole phase:** a remote daemon attached to a dev server converges to `dev+<sha>` through the real download, verify and swap path. This is what makes everyday development the continuous test of the release mechanism.
- [ ] **The build does not stampede:** trigger it from several merges in quick succession and confirm exactly one build runs.
- [ ] **The lock actually holds:** confirm the TTL outlives a real build. Time a build first; if it exceeds the TTL you chose, the lock lapses mid-build and is not doing its job.
- [ ] **`git` delivery refuses a dirty tree** on a real checkout with an uncommitted file. Confirm nothing was discarded.
- [ ] The signature gate is not bypassed anywhere in the dev path: tamper with a served bundle and confirm the daemon rejects it.

---

## Out of scope, on purpose

- Any change to channel behaviour for installed servers.
- Building the desktop or web artifacts in dev. Only the headless bundle, which is what a remote daemon needs.
- Making the dev bundle available to anything other than daemons attached to that server.

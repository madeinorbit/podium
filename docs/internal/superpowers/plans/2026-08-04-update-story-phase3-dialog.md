# Update story, Phase 3: the update dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One update dialog, shared by web, desktop webview and mobile, that speaks in places rather than components: what version is available, where it will be applied, and what the user will notice.

**Architecture:** The content of the dialog is a pure function of four inputs (this build, the server's `/version`, the fleet's convergence state, and which surface we are on). That function is where every copy rule and every "which places are actually touched" decision lives, so all of it is testable without rendering anything. The component is a thin renderer over it with one action backend per surface, feature-detected. The existing service-worker toast stops being a separate prompt and becomes one input to this model.

**Tech Stack:** React, Base UI + shadcn, Tailwind v4, vitest + happy-dom.

**Spec:** `docs/internal/superpowers/specs/2026-08-04-coherent-update-story-design.md`, §12.1 to §12.3 and §12.5. Gap item 15.

**Depends on:** Phase 1 (POD-1695) for `parseServerVersion`, `classifySkew` and `UpdateTarget`; Phase 2 (POD-1696) for the fleet convergence state. **Do not start until both have landed on main.**

## Global Constraints

**Read before writing any UI:** `apps/web/PRODUCT.md` (strategy, positioning, brand personality) and `apps/web/DESIGN.md` (the Superade theme, "The Podium" north star, carved-not-floating elevation, the agent-state motion grammar, plus machine-readable tokens in its YAML frontmatter). Both are required reading per the repository's own instructions before designing or restyling any web UI surface. Invoke the `impeccable` skill for the visual work.

**The copy rules, verbatim from the spec. These are testable and they are tested:**

- **There is only Podium.** One product, one version, running in places. The user does not model "the daemon" or "the web bundle" and must never be asked to.
- **Name places, not components.** "Your server", never "the headless bundle".
- **Say what the user will notice, per place, including when the answer is nothing.**
- **When no place the user is looking at needs a restart, say "no restart needed" explicitly.**
- **Only list places that are actually being touched**, decided by per-artifact digests.
- **Never promise more than the mechanism guarantees.** "Your sessions keep running" is true because abduco masters survive the daemon restart; do not extend the promise past that.
- **No em dashes in user-facing copy.**

**Other constraints:**

- The dialog must render on a surface whose Tauri bridge is absent. Feature-detect `window.__PODIUM_DESKTOP__` through `nativeDesktopBridge()` in both directions; the desktop install command does not exist until Phase 4 and its absence must degrade gracefully, not throw.
- `appVersion` is a label and may be `dev+<sha>`. Never sort it, never semver-parse it, never render it as "newer than".
- Changed UI and interaction behaviour requires **runtime verification**, not only unit tests. This is repository policy and Task 7 enforces it.
- Run `bun run typecheck` and trust a cache hit.
- No fixed sleeps in tests.

---

## File Structure

**Created:**
- `apps/web/src/features/updates/update-view.ts` — the pure content model. Every copy rule and place decision lives here.
- `apps/web/src/features/updates/update-view.test.ts`
- `apps/web/src/features/updates/UpdateDialog.tsx` — the renderer.
- `apps/web/src/features/updates/UpdateDialog.test.tsx`
- `apps/web/src/features/updates/use-update-state.ts` — gathers the four inputs.

**Modified:**
- `apps/web/src/app/UpdatePrompt.tsx` — becomes an input to the model rather than its own toast.
- `apps/web/src/features/settings/sections/updates.tsx` — gains version and fleet state beside the channel selector.
- `apps/web/src/features/setup/version-guard.ts` — its `server-behind` verdict (Phase 1) becomes a dialog state.

---

## Task 1: The places model

**Files:**
- Create: `apps/web/src/features/updates/update-view.ts`, `.test.ts`

**Interfaces:**
- Produces:
  - `type PlaceKind = 'this-app' | 'server' | 'machines'`
  - `type Place = { kind: PlaceKind; label: string; effect: string }`
  - `type UpdateView = { state: 'none' } | { state: 'available' | 'required'; version: string; places: Place[]; notes?: { summary?: string; url?: string }; restartNote: string; reason?: string } | { state: 'in-progress'; version: string; done: number; total: number } | { state: 'failed'; detail: string }`
  - `describeUpdate(input: UpdateInput): UpdateView`

`UpdateInput` = `{ localVersion: string; server: ServerVersion; surface: 'web' | 'desktop-all-in-one' | 'desktop-remote' | 'mobile'; serverName?: string; fleet: { total: number; behind: number; converging: number; failed: number }; touched: { app: boolean; server: boolean; machines: boolean }; skew: SkewVerdict }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { describeUpdate } from './update-view'

const base = {
  localVersion: '0.4.1',
  server: { appVersion: '0.4.1', target: { version: '0.4.2', critical: false, artifacts: {} } },
  surface: 'web' as const,
  serverName: 'ludovico',
  fleet: { total: 3, behind: 3, converging: 0, failed: 0 },
  touched: { app: true, server: true, machines: true },
  skew: 'ok' as const,
}

describe('describeUpdate', () => {
  it('is none when everything is already on the target', () => {
    const v = describeUpdate({
      ...base,
      localVersion: '0.4.2',
      server: { appVersion: '0.4.2', target: { version: '0.4.2', critical: false, artifacts: {} } },
      fleet: { total: 3, behind: 0, converging: 0, failed: 0 },
      touched: { app: false, server: false, machines: false },
    } as never)
    expect(v.state).toBe('none')
  })

  it('names places, never components', () => {
    const v = describeUpdate(base as never)
    const text = JSON.stringify(v)
    expect(text).not.toMatch(/headless|bundle|daemon|artifact|tarball/i)
    expect(text).toMatch(/This app/)
    expect(text).toMatch(/Your server/)
  })

  it('names the server so the user knows WHICH server', () => {
    const v = describeUpdate(base as never)
    const server = (v as { places: { kind: string; label: string }[] }).places.find(
      (p) => p.kind === 'server',
    )
    expect(server?.label).toContain('ludovico')
  })

  it('pluralises machines and says they are not interrupted', () => {
    const v = describeUpdate(base as never)
    const machines = (v as { places: { kind: string; label: string; effect: string }[] }).places.find(
      (p) => p.kind === 'machines',
    )
    expect(machines?.label).toBe('3 machines')
    expect(machines?.effect).toMatch(/not be interrupted/i)
  })

  it('says "1 machine" for exactly one', () => {
    const v = describeUpdate({
      ...base,
      fleet: { total: 1, behind: 1, converging: 0, failed: 0 },
    } as never)
    const machines = (v as { places: { kind: string; label: string }[] }).places.find(
      (p) => p.kind === 'machines',
    )
    expect(machines?.label).toBe('1 machine')
  })

  it('omits a place that is not being touched', () => {
    // A server-only release must not tell the user their app is updating.
    const v = describeUpdate({
      ...base,
      touched: { app: false, server: true, machines: false },
    } as never)
    const kinds = (v as { places: { kind: string }[] }).places.map((p) => p.kind)
    expect(kinds).toEqual(['server'])
  })

  it('says no restart is needed when nothing the user is looking at restarts', () => {
    const v = describeUpdate({
      ...base,
      touched: { app: false, server: false, machines: true },
    } as never)
    expect((v as { restartNote: string }).restartNote).toMatch(/no restart needed/i)
  })

  it('promises sessions keep running, and promises nothing more', () => {
    const v = describeUpdate(base as never)
    const note = (v as { restartNote: string }).restartNote
    expect(note).toMatch(/sessions keep running/i)
    expect(note).not.toMatch(/no downtime|instant|seamless|zero/i)
  })

  it('uses no em dashes anywhere in user-facing text', () => {
    expect(JSON.stringify(describeUpdate(base as never))).not.toContain('—')
  })

  it('carries release notes when the target has them', () => {
    const v = describeUpdate({
      ...base,
      server: {
        appVersion: '0.4.1',
        target: {
          version: '0.4.2',
          critical: false,
          artifacts: {},
          notes: { summary: 'Faster reconnects.', url: 'https://x.test/CHANGELOG.md' },
        },
      },
    } as never)
    expect((v as { notes?: { url?: string } }).notes?.url).toBe('https://x.test/CHANGELOG.md')
  })

  it('omits the notes affordance entirely when there are none', () => {
    expect((describeUpdate(base as never) as { notes?: unknown }).notes).toBeUndefined()
  })

  it('is required, not available, for a critical target', () => {
    const v = describeUpdate({
      ...base,
      server: { appVersion: '0.4.1', target: { version: '0.4.2', critical: true, artifacts: {} } },
    } as never)
    expect(v.state).toBe('required')
  })

  it('is required when this client is outside the wire window', () => {
    const v = describeUpdate({ ...base, skew: 'client-too-old' } as never)
    expect(v.state).toBe('required')
  })

  it('tells the user to move the SERVER when this client is ahead of it', () => {
    const v = describeUpdate({ ...base, skew: 'client-too-new' } as never)
    expect(v.state).toBe('required')
    expect((v as { reason?: string }).reason).toMatch(/server/i)
    expect((v as { reason?: string }).reason).not.toMatch(/rebuild|reload/i)
  })

  it('folds the whole desktop all-in-one stack into one place', () => {
    // The server lives inside the shell there, so listing it separately would ask
    // the user to reason about a distinction that does not exist for them.
    const v = describeUpdate({ ...base, surface: 'desktop-all-in-one' } as never)
    const kinds = (v as { places: { kind: string }[] }).places.map((p) => p.kind)
    expect(kinds).not.toContain('server')
    expect(kinds).toContain('this-app')
  })

  it('reports progress while a wave is running', () => {
    const v = describeUpdate({
      ...base,
      fleet: { total: 3, behind: 1, converging: 2, failed: 0 },
    } as never)
    expect(v).toMatchObject({ state: 'in-progress', done: 0, total: 3 })
  })

  it('reports failure when a machine gave up', () => {
    const v = describeUpdate({
      ...base,
      fleet: { total: 3, behind: 0, converging: 0, failed: 1 },
      touched: { app: false, server: false, machines: false },
    } as never)
    expect(v.state).toBe('failed')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:web -- update-view`
Expected: FAIL, cannot resolve `./update-view`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/features/updates/update-view.ts`. Lead the file with the principle, because every future edit to it will be tempted to violate it:

```ts
/**
 * WHAT THE UPDATE DIALOG SAYS. Pure, so every copy rule is a test and not a code
 * review.
 *
 * THERE IS ONLY PODIUM. From the user's side there is one product with one
 * version, and it runs in PLACES: this app, their server, their machines. They do
 * not model a daemon or a web bundle and must never be asked to. So this module
 * turns internal component facts into places and effects, and the words
 * "headless", "bundle", "daemon" and "artifact" never reach a screen.
 *
 * The second rule is honesty about what the user will NOTICE, per place,
 * including when the answer is nothing. "Your sessions keep running" is a fact:
 * abduco masters survive the daemon restart and the daemon reattaches on boot.
 * It is the strongest promise the mechanism supports, and nothing here may
 * promise more than that.
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:web -- update-view`
Expected: PASS, all seventeen cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/updates
git commit -m "feat(web): update view model, places not components (POD-1670)"
```

---

## Task 2: Which places are actually touched

**Files:**
- Modify: `apps/web/src/features/updates/update-view.ts`
- Create: `apps/web/src/features/updates/touched.ts`, `.test.ts`

**Interfaces:**
- Produces: `computeTouched(ctx: { localDigests: { app?: string }; target: UpdateTarget; fleetBehind: number; serverBehind: boolean }): { app: boolean; server: boolean; machines: boolean }`

**Why this exists:** the release train bumps the version for every artifact, so a desktop-only fix would otherwise prompt everybody. Digests are what turn one number into an honest list of places.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { computeTouched } from './touched'

const target = (over: Record<string, unknown> = {}) =>
  ({
    version: '0.4.2',
    critical: false,
    artifacts: { web: { digest: 'web-new' }, ...over },
  }) as never

describe('computeTouched', () => {
  it('touches the app when the web digest differs', () => {
    const t = computeTouched({
      localDigests: { app: 'web-old' },
      target: target(),
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(true)
  })

  it('does NOT touch the app when the digest is identical, even though the version moved', () => {
    // This is the whole point of digests: a release that did not change this
    // artifact must not prompt this user.
    const t = computeTouched({
      localDigests: { app: 'web-new' },
      target: target(),
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(false)
  })

  it('treats an unknown local digest as touched, failing toward telling the user', () => {
    // Silence about an update the user needs is worse than one extra prompt.
    const t = computeTouched({
      localDigests: {},
      target: target(),
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(true)
  })

  it('does not touch the app when the target advertises no web digest', () => {
    const t = computeTouched({
      localDigests: { app: 'web-old' },
      target: { version: '0.4.2', critical: false, artifacts: {} } as never,
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(false)
  })

  it('touches machines only when some machine is behind', () => {
    expect(
      computeTouched({
        localDigests: { app: 'web-new' },
        target: target(),
        fleetBehind: 0,
        serverBehind: false,
      }).machines,
    ).toBe(false)
    expect(
      computeTouched({
        localDigests: { app: 'web-new' },
        target: target(),
        fleetBehind: 2,
        serverBehind: false,
      }).machines,
    ).toBe(true)
  })

  it('touches the server only when the server is behind its own target', () => {
    expect(
      computeTouched({
        localDigests: { app: 'web-new' },
        target: target(),
        fleetBehind: 0,
        serverBehind: true,
      }).server,
    ).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails, 3: implement, 4: run to verify it passes**

Run: `bun run test:web -- touched`

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/updates
git commit -m "feat(web): digest-gated place selection so one number is an honest list (POD-1670)"
```

---

## Task 3: The dialog

**Files:**
- Create: `apps/web/src/features/updates/UpdateDialog.tsx`, `.test.tsx`

**Interfaces:**
- Consumes: `UpdateView` from Task 1.
- Produces: `<UpdateDialog view={UpdateView} actions={UpdateActions} />` where `UpdateActions = { reload?: () => void; installApp?: () => Promise<void>; updateServer?: () => Promise<void> }`, every member optional and feature-detected.

- [ ] **Step 1: Read the design system**

Read `apps/web/PRODUCT.md` and `apps/web/DESIGN.md` in full, then invoke the `impeccable` skill. Do not skip this. The dialog is a first-class product surface and the repository governs its look through those two files.

- [ ] **Step 2: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateDialog } from './UpdateDialog'

const available = {
  state: 'available' as const,
  version: '0.4.2',
  places: [
    { kind: 'this-app' as const, label: 'This app', effect: 'will restart, about 5 seconds' },
    { kind: 'server' as const, label: 'Your server (ludovico)', effect: 'will briefly reconnect' },
  ],
  restartNote: 'Your sessions keep running. Everything will be where you left it.',
}

describe('UpdateDialog', () => {
  it('renders nothing in the none state', () => {
    const { container } = render(<UpdateDialog view={{ state: 'none' }} actions={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('leads with the version, as one Podium', () => {
    render(<UpdateDialog view={available} actions={{}} />)
    expect(screen.getByText(/Podium 0\.4\.2 is available/i)).toBeInTheDocument()
  })

  it('lists every place with its effect', () => {
    render(<UpdateDialog view={available} actions={{}} />)
    expect(screen.getByText(/This app/)).toBeInTheDocument()
    expect(screen.getByText(/will restart, about 5 seconds/)).toBeInTheDocument()
    expect(screen.getByText(/Your server \(ludovico\)/)).toBeInTheDocument()
  })

  it('is dismissible when available', () => {
    render(<UpdateDialog view={available} actions={{}} />)
    expect(screen.getByRole('button', { name: /later/i })).toBeInTheDocument()
  })

  it('is NOT dismissible when required', () => {
    render(
      <UpdateDialog
        view={{ ...available, state: 'required', reason: 'Your server is behind this app.' }}
        actions={{}}
      />,
    )
    expect(screen.queryByRole('button', { name: /later/i })).toBeNull()
  })

  it('shows the reason on a required update', () => {
    render(
      <UpdateDialog
        view={{ ...available, state: 'required', reason: 'Your server is behind this app.' }}
        actions={{}}
      />,
    )
    expect(screen.getByText(/Your server is behind this app/)).toBeInTheDocument()
  })

  it('offers What is new only when notes exist', () => {
    render(<UpdateDialog view={available} actions={{}} />)
    expect(screen.queryByRole('link', { name: /what's new/i })).toBeNull()
    render(
      <UpdateDialog
        view={{ ...available, notes: { url: 'https://x.test/CHANGELOG.md' } }}
        actions={{}}
      />,
    )
    expect(screen.getByRole('link', { name: /what's new/i })).toBeInTheDocument()
  })

  it('does not offer an action whose backend is absent on this surface', () => {
    // No Tauri bridge means no install command. The button must not exist rather
    // than exist and throw.
    render(<UpdateDialog view={available} actions={{ reload: vi.fn() }} />)
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
  })

  it('runs the action it does offer', async () => {
    const updateServer = vi.fn()
    render(<UpdateDialog view={available} actions={{ updateServer }} />)
    screen.getByRole('button', { name: /update/i }).click()
    expect(updateServer).toHaveBeenCalled()
  })

  it('shows wave progress in the in-progress state', () => {
    render(
      <UpdateDialog
        view={{ state: 'in-progress', version: '0.4.2', done: 1, total: 3 }}
        actions={{}}
      />,
    )
    expect(screen.getByText(/1 of 3/)).toBeInTheDocument()
  })

  it('shows the detail in the failed state', () => {
    render(<UpdateDialog view={{ state: 'failed', detail: 'ludovico did not come back' }} actions={{}} />)
    expect(screen.getByText(/ludovico did not come back/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run to verify it fails, 4: implement, 5: run to verify it passes**

Run: `bun run test:web -- UpdateDialog`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/updates
git commit -m "feat(web): the update dialog, one component across surfaces (POD-1670)"
```

---

## Task 4: The service-worker toast becomes an input

**Files:**
- Modify: `apps/web/src/app/UpdatePrompt.tsx`
- Create: `apps/web/src/features/updates/use-update-state.ts`

**The change:** `UpdatePrompt.tsx` currently raises its own sonner toast ("New version available" / Reload / Later) on `needRefresh`. Two prompts for one fact teaches users to dismiss both. Its `needRefresh` signal and its `reload` action become inputs to the one dialog; the toast goes.

Keep the parts that are load-bearing and easy to lose: the 60 second `registration.update()` poll, the `visibilitychange` refresh (the decisive check for an installed PWA returning to the foreground), and the robust reload that listens for `controllerchange` with a 2 second fallback for a tab the new worker never claims.

- [ ] **Step 1: Write the failing test**

Assert that `needRefresh` produces an `available` view whose only touched place is this app, that the reload action is wired through, and that no sonner toast is raised. Then implement.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): fold the service-worker prompt into the update dialog (POD-1670)"
```

---

## Task 5: The server-update action

**Files:**
- Modify: the setup/updates tRPC router, `apps/web/src/features/updates/use-update-state.ts`

**Interfaces:**
- Produces: a mutation that asks the server to converge itself to its own target, and a query for the fleet state from Phase 2's `fleet()`.

This is the one human decision in the whole design. Everything downstream is automatic, so this button is where authority actually moves.

- [ ] **Step 1: Write the failing test, then implement**

Cover: the mutation is refused when no target is configured; it is refused when the server is already on its target; a successful call moves the dialog to `in-progress`; a failure moves it to `failed` with the detail.

- [ ] **Step 2: Commit**

```bash
git add apps/server/src apps/web/src
git commit -m "feat(server): converge-this-server action behind the update dialog (POD-1670)"
```

---

## Task 6: Settings shows version and fleet

**Files:**
- Modify: `apps/web/src/features/settings/sections/updates.tsx`

Today this section offers only the channel selector. Add the running version, the target, and per-machine version state from Phase 1's read model, so a user can answer "what is everything on?" without opening the dialog. Keep the channel selector as it is.

- [ ] **Step 1: Write the failing test, then implement, then commit**

```bash
git add apps/web/src/features/settings
git commit -m "feat(web): version and fleet state in update settings (POD-1670)"
```

---

## Task 7: Runtime verification

Unit tests cannot tell you a dialog is right. Repository policy requires runtime verification for changed UI and interaction behaviour, and this phase is nothing but changed interaction behaviour.

- [ ] **Step 1: Drive the real app**

Use the `run` skill to launch the app. Produce screenshots of, at minimum:
1. `available` with all three places listed.
2. `available` with only the server touched, proving a server-only release does not claim the app is updating.
3. The `no restart needed` variant.
4. `required` showing no Later button.
5. `in-progress` with wave progress.
6. `failed`.

- [ ] **Step 2: Check the copy on screen, not in the test**

Read every rendered string against the copy rules in Global Constraints. In particular: no component nouns, no em dashes, and the promise is exactly "sessions keep running" and no stronger.

- [ ] **Step 3: Attach the screenshots to the issue**

Save them under a durable path in the repository (not a scratchpad, which does not render) and attach each with `podium issue artifact <id> --add <path> --title "…"`. The issue's artifact list is how the human reviews this after the chat scrolls away.

- [ ] **Step 4: Commit**

```bash
git add docs/design apps/web/src
git commit -m "docs(update): runtime verification screenshots for the update dialog (POD-1670)"
```

---

## Verification for the whole phase

- [ ] `bun run typecheck` passes.
- [ ] `bun run test:web`, `bun run test:unit` pass.
- [ ] `bun run lint` passes.
- [ ] Screenshots of all six states exist and are attached to the issue.
- [ ] The dialog renders correctly with no Tauri bridge present (plain browser) and does not throw when the desktop install command is absent.
- [ ] No sonner update toast remains; there is exactly one update surface.

---

## Out of scope, on purpose

- **The Tauri commands and the native fallback.** Phase 4 owns them. Here the desktop install action is feature-detected and simply absent, which is the correct behaviour until Phase 4 lands.
- The mobile blocking screen for store builds. Not applicable while mobile is served as web.
- Changing what the server or daemons actually do. Phase 2 owns convergence; this phase only shows and triggers it.

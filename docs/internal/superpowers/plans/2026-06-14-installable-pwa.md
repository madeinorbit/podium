# Installable PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Podium web app installable to the home screen on mobile, with instant cold start and one-tap update detection when a redeploy lands — staying on the web, no native app.

**Architecture:** Add `vite-plugin-pwa` to `apps/web`. The deployed host stops running the Vite *dev* server and instead `vite build`s a content-hashed bundle served by `vite preview` (whose existing config already carries the backend proxy + allowedHosts). Workbox precaches the shell (instant cold start) while leaving `/trpc`, `/health`, `/client`, `/daemon` network-only (live data/WS). A small `UpdatePrompt` React component uses the `virtual:pwa-register/react` hook to surface a "New version — Reload" toast, and proactively calls `registration.update()` on a 60s interval and on app foreground so an installed PWA notices a redeploy.

**Tech Stack:** Vite 8, React 19, `vite-plugin-pwa`, `@vite-pwa/assets-generator` (Workbox under the hood), bun workspaces, vitest, systemd (user units).

**Spec:** `docs/superpowers/specs/2026-06-14-installable-pwa-design.md`

**Deviation from spec (deliberate):** The spec listed WS-reconnect as a third update-check trigger. The store exposes no top-level reconnect signal (connection health is per-daemon-host), so wiring that would add new store coupling. The 60s interval + foreground (`visibilitychange`) checks already catch a redeploy promptly, so v1 ships those two and defers WS-reconnect. Noted here so it's a conscious choice.

---

## File map

| File | Responsibility | Change |
| --- | --- | --- |
| `apps/web/package.json` | declares the two new dev deps | modify |
| `apps/web/public/icon.svg` | single source image for all generated icons | create |
| `apps/web/pwa-assets.config.ts` | icon/apple-touch/favicon generation preset | create |
| `apps/web/vite.config.ts` | registers `VitePWA` (manifest, workbox, pwaAssets, prompt) | modify |
| `apps/web/index.html` | iOS standalone meta + matching `theme-color` | modify |
| `apps/web/src/vite-env.d.ts` | type refs for the PWA virtual modules | modify |
| `apps/web/src/UpdatePrompt.tsx` | the update toast + proactive update checks | create |
| `apps/web/src/AppShell.tsx` | always mounts `<UpdatePrompt />` | modify |
| `apps/web/src/styles.css` | `.update-toast` styling | modify |
| `apps/web/test/pwa.structure.test.ts` | structure tests for the wiring above | create |
| `scripts/systemd/podium-web.service` | `dev` → `build` + `preview` | modify |
| `scripts/systemd/README.md` | topology note: built PWA, not dev server | modify |

Notes for the engineer:
- The web app is served **in production by the Vite process** — there is no separate web server. Today that's `vite` (dev); this plan switches the deployed host to `vite build` + `vite preview`. **Local development stays `bun run --filter @podium/web dev` (HMR, no service worker).**
- The repo's `scripts/systemd/*.service` files are the *source* copies; the live units live in `~/.config/systemd/user/`. **Do not restart the live service during implementation** — it redeploys from `main` on merge (see that README). This branch only edits the source copy.
- Tests run from the repo root: `bun run test` (`vitest run --passWithNoTests`). Type check: `bun run --filter @podium/web typecheck`. The existing web tests are *source-string* structure tests (`apps/web/test/shell.structure.test.ts`) — match that idiom; they never `import` the components, so vitest never has to resolve the `virtual:pwa-register/*` modules.

---

## Task 1: Add dependencies, the source icon, and the asset-generation config

**Files:**
- Modify: `apps/web/package.json` (via `bun add`)
- Create: `apps/web/public/icon.svg`
- Create: `apps/web/pwa-assets.config.ts`

- [ ] **Step 1: Install the two dev dependencies**

```bash
cd apps/web && bun add -D vite-plugin-pwa@latest @vite-pwa/assets-generator@latest
```

Expected: both land in `apps/web/package.json` `devDependencies`. If bun reports a peer-dependency conflict with `vite@^8`, that is the one real compatibility risk — install the newest `vite-plugin-pwa` that lists Vite 8 as a peer and record the chosen version in the commit message. Do not downgrade Vite.

- [ ] **Step 2: Create the source app icon**

Create `apps/web/public/icon.svg` — a simple amber lectern glyph on the app's dark background. Placeholder; swap for a real logo anytime. Shapes sit inside the maskable safe zone (centered ~80%).

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Podium">
  <rect width="512" height="512" rx="96" fill="#0e0e12"/>
  <g fill="#f59e0b">
    <path d="M150 150 L362 178 L362 236 L150 208 Z"/>
    <rect x="240" y="208" width="32" height="120"/>
    <rect x="176" y="328" width="160" height="34" rx="8"/>
  </g>
</svg>
```

- [ ] **Step 3: Create the asset-generation config**

Create `apps/web/pwa-assets.config.ts`. The `minimal2023Preset` emits `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`, `apple-touch-icon-180x180.png`, and a transparent `favicon.ico`; `headLinkOptions.preset: '2023'` injects the apple-touch-icon + favicon `<link>` tags at build time.

```ts
import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: minimal2023Preset,
  images: ['public/icon.svg'],
})
```

- [ ] **Step 4: Verify the icon generator runs end to end**

```bash
cd apps/web && bunx @vite-pwa/assets-generator --preset minimal-2023 public/icon.svg
```

Expected: it prints generated PNG sizes (64/192/512/maskable/apple-touch) and a favicon with no error. This is a dry run to prove the source SVG is valid — the real generation happens via the plugin during `vite build`. Delete any stray generated PNGs it dropped into `public/` afterward (the plugin emits them to `dist/` at build time, so they must not be committed):

```bash
cd apps/web && git clean -f public/ && git status --short
```

Expected: only `public/icon.svg` and `pwa-assets.config.ts` remain untracked.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/public/icon.svg apps/web/pwa-assets.config.ts
# also stage the lockfile that bun updated:
git add bun.lock 2>/dev/null || git add bun.lockb 2>/dev/null || true
git commit -m "feat(web): add vite-plugin-pwa deps, source app icon, asset config"
```

---

## Task 2: Register VitePWA in the Vite config

**Files:**
- Modify: `apps/web/vite.config.ts`
- Test: `apps/web/test/pwa.structure.test.ts`

- [ ] **Step 1: Write the failing structure test**

Create `apps/web/test/pwa.structure.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readWeb = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('installable PWA wiring', () => {
  it('vite config registers vite-plugin-pwa with a prompt update flow', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain('VitePWA')
    expect(cfg).toContain("registerType: 'prompt'")
    expect(cfg).toContain('devOptions: { enabled: false }')
    expect(cfg).toContain('pwaAssets')
  })

  it('the service worker falls back to the shell but never shadows the live API/WS routes', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain("navigateFallback: '/index.html'")
    expect(cfg).toContain('navigateFallbackDenylist')
    expect(cfg).toContain('/^\\/trpc/')
    expect(cfg).toContain('/^\\/daemon/')
  })

  it('manifest declares a standalone dark app', () => {
    const cfg = readWeb('vite.config.ts')
    expect(cfg).toContain("name: 'Podium'")
    expect(cfg).toContain("display: 'standalone'")
    expect(cfg).toContain("theme_color: '#0e0e12'")
    expect(cfg).toContain("background_color: '#0e0e12'")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test -- apps/web/test/pwa.structure.test.ts
```

Expected: FAIL — `vite.config.ts` does not yet contain `VitePWA`.

- [ ] **Step 3: Add the import**

In `apps/web/vite.config.ts`, add the plugin import directly under the existing `import { defineConfig } from 'vite'` line:

```ts
import { VitePWA } from 'vite-plugin-pwa'
```

- [ ] **Step 4: Add the `plugins` array as the first key in `defineConfig({...})`**

Insert this as the first property inside the `defineConfig({` object (immediately before `resolve: {`):

```ts
  plugins: [
    VitePWA({
      registerType: 'prompt',
      // Generate icons + apple-touch-icon + favicon from one source SVG
      // (see pwa-assets.config.ts); inject head links + manifest icons.
      pwaAssets: { config: true },
      manifest: {
        name: 'Podium',
        short_name: 'Podium',
        description: 'Podium — agent workspace',
        theme_color: '#0e0e12',
        background_color: '#0e0e12',
        display: 'standalone',
        start_url: '/',
      },
      workbox: {
        // Precache the built shell so an installed app cold-starts instantly.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // SPA fallback for navigations — but never shadow the live API/WS
        // routes, which must always reach the backend through the proxy.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/trpc/, /^\/health/, /^\/client/, /^\/daemon/],
      },
      // Keep the service worker out of `npm run dev` (it fights HMR); it only
      // ships in the built bundle served by `vite preview`.
      devOptions: { enabled: false },
    }),
  ],
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun run test -- apps/web/test/pwa.structure.test.ts
```

Expected: PASS (all three `it` blocks in this describe).

- [ ] **Step 6: Commit**

```bash
git add apps/web/vite.config.ts apps/web/test/pwa.structure.test.ts
git commit -m "feat(web): register vite-plugin-pwa (manifest, workbox, prompt update)"
```

---

## Task 3: iOS standalone meta + virtual-module types

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/vite-env.d.ts`
- Test: `apps/web/test/pwa.structure.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

Append this `it` block inside the existing `describe('installable PWA wiring', ...)` in `apps/web/test/pwa.structure.test.ts`:

```ts
  it('index.html carries the iOS standalone meta + matching theme-color', () => {
    const html = readWeb('index.html')
    expect(html).toContain('name="theme-color" content="#0e0e12"')
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"')
    expect(html).toContain('apple-mobile-web-app-status-bar-style')
    expect(html).toContain('name="apple-mobile-web-app-title" content="Podium"')
  })
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun run test -- apps/web/test/pwa.structure.test.ts
```

Expected: FAIL on the new `index.html` assertions.

- [ ] **Step 3: Add the meta tags**

In `apps/web/index.html`, insert these lines inside `<head>`, immediately after the existing `<meta name="description" ... />` block (before `<title>`). `apple-touch-icon` and `favicon` links are injected automatically by `pwaAssets`, so do **not** add them by hand.

```html
    <meta name="theme-color" content="#0e0e12" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Podium" />
```

- [ ] **Step 4: Add virtual-module type references**

Replace the contents of `apps/web/src/vite-env.d.ts` with:

```ts
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/info" />

declare module '*.css'
```

(`vite-plugin-pwa/react` types the `virtual:pwa-register/react` module used in Task 4; `info` types `virtual:pwa-info`. `vite-env.d.ts` is already under the tsconfig `include`, so a triple-slash ref is enough — no `tsconfig.json` change.)

- [ ] **Step 5: Run the test + typecheck to verify they pass**

```bash
bun run test -- apps/web/test/pwa.structure.test.ts
bun run --filter @podium/web typecheck
```

Expected: tests PASS; typecheck PASS (no error about missing `virtual:pwa-register/react`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/index.html apps/web/src/vite-env.d.ts apps/web/test/pwa.structure.test.ts
git commit -m "feat(web): iOS standalone meta + PWA virtual-module types"
```

---

## Task 4: The UpdatePrompt component + mount it in AppShell

**Files:**
- Create: `apps/web/src/UpdatePrompt.tsx`
- Modify: `apps/web/src/AppShell.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/test/pwa.structure.test.ts` (extend)

- [ ] **Step 1: Add the failing tests**

Append a new `describe` block to `apps/web/test/pwa.structure.test.ts`:

```ts
describe('update prompt', () => {
  it('UpdatePrompt uses the SW registration to detect and apply new builds', () => {
    const src = readWeb('src/UpdatePrompt.tsx')
    expect(src).toContain("from 'virtual:pwa-register/react'")
    expect(src).toContain('useRegisterSW')
    expect(src).toContain('onRegisteredSW')
    expect(src).toContain('registration.update()')
    expect(src).toContain('visibilitychange')
    expect(src).toContain('updateServiceWorker(true)')
  })

  it('AppShell always mounts the update prompt', () => {
    const src = readWeb('src/AppShell.tsx')
    expect(src).toContain('UpdatePrompt')
    expect(src).toContain('<UpdatePrompt')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun run test -- apps/web/test/pwa.structure.test.ts
```

Expected: FAIL — `src/UpdatePrompt.tsx` does not exist.

- [ ] **Step 3: Create the component**

Create `apps/web/src/UpdatePrompt.tsx`:

```tsx
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

// How often an open tab asks the service worker to look for a freshly
// deployed build. A redeploy restarts the web service, which serves a new
// content-hashed shell; this poll is how a long-lived tab notices.
const UPDATE_CHECK_MS = 60_000

export function UpdatePrompt(): JSX.Element | null {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      registrationRef.current = registration
      setInterval(() => void registration.update(), UPDATE_CHECK_MS)
    },
  })

  // The decisive check for an installed PWA: the moment it returns to the
  // foreground, ask the SW whether a new build shipped while it was hidden.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void registrationRef.current?.update()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  if (!needRefresh) return null
  return (
    <div className="update-toast" role="status">
      <span>New version available</span>
      <button type="button" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button
        type="button"
        className="update-toast-dismiss"
        onClick={() => setNeedRefresh(false)}
      >
        Later
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Mount it in AppShell**

In `apps/web/src/AppShell.tsx`, add the import after the other local imports (e.g. after the `Sidebar` import):

```tsx
import { UpdatePrompt } from './UpdatePrompt'
```

Then replace the entire `if (appError) { ... }` early-return **and** the final `return ( ... )` of `AppShell` (the current lines 34–54) with a single return that always renders `<UpdatePrompt />`:

```tsx
  return (
    <>
      <UpdatePrompt />
      {appError ? (
        <AppErrorPage
          title="Podium could not connect"
          message={appError}
          onRetry={() => setAppError(null)}
        />
      ) : (
        <ErrorBoundary
          resetKey={config.wsClientUrl}
          onRetry={() => setAppError(null)}
          onError={setAppError}
        >
          <StoreProvider config={config} onFatalError={setAppError}>
            <AppBody isMobile={isMobile} />
          </StoreProvider>
        </ErrorBoundary>
      )}
    </>
  )
```

- [ ] **Step 5: Add the toast styling**

Append to `apps/web/src/styles.css`:

```css
.update-toast {
  position: fixed;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
  background: var(--panel-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--r);
  color: var(--fg-bright);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  font-size: 14px;
}
.update-toast button {
  background: var(--accent);
  color: #1a1205;
  border: 0;
  border-radius: var(--r);
  padding: 6px 12px;
  font-weight: 600;
  cursor: pointer;
}
.update-toast .update-toast-dismiss {
  background: transparent;
  color: var(--dim);
  font-weight: 500;
}
```

- [ ] **Step 6: Run tests + typecheck**

```bash
bun run test -- apps/web/test/pwa.structure.test.ts
bun run --filter @podium/web typecheck
```

Expected: the `update prompt` describe PASSES; typecheck PASSES (`useRegisterSW` is typed via the Task 3 reference).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/UpdatePrompt.tsx apps/web/src/AppShell.tsx apps/web/src/styles.css apps/web/test/pwa.structure.test.ts
git commit -m "feat(web): update-available toast with proactive SW update checks"
```

---

## Task 5: Switch the deployed web service from dev server to built preview

**Files:**
- Modify: `scripts/systemd/podium-web.service`
- Modify: `scripts/systemd/README.md`

- [ ] **Step 1: Edit the service unit**

In `scripts/systemd/podium-web.service`:

Change the `Description` line to:

```
Description=Podium web (built PWA via vite preview, app origin :55556; TLS :55555 via tailscale serve)
```

Replace the comment + `ExecStart` block (current lines 13–15) with a build-then-serve pair. `ExecStartPre` builds the content-hashed PWA bundle (incl. the service worker + generated icons); `ExecStart` serves `dist/` with the same proxy + allowedHosts the dev server used (from `vite.config.ts`'s `preview` block):

```
# Built PWA: `vite build` emits the content-hashed shell + service worker to
# dist/, then `vite preview` serves it on :55556 (proxy + allowedHosts from
# vite.config.ts preview block). A redeploy reruns the build, so the new build
# hash is what drives the in-app update prompt. If the build fails, the unit
# fails and `Restart=always` retries — the site is briefly down during the
# build (seconds), the accepted v1 tradeoff.
ExecStartPre=/home/user/.local/bin/bun run --filter @podium/web build
ExecStart=/home/user/.local/bin/bun run --filter @podium/web preview
```

Leave `Restart=always`, `RestartSec=2`, `WorkingDirectory`, and the `Environment=` lines unchanged.

- [ ] **Step 2: Update the topology note in the README**

In `scripts/systemd/README.md`, update the wording that describes `podium-web` as a "Vite dev server" to reflect a built PWA served by `vite preview`. Specifically:
- Line ~12: change "`podium-web` (Vite dev server) binds **:55556**" → "`podium-web` (built PWA via `vite preview`) binds **:55556**".
- Line ~31 ("Why the web restart is part of redeploy: a long-lived Vite dev server's module …"): replace with the build-based reason:

```
Why the web restart is part of redeploy: the web service `vite build`s the
content-hashed PWA bundle at start, so restarting it on a HEAD move is what
produces a new build (and the new build hash the in-app update prompt detects).
Note: the running app's service worker is the source of truth for installed
clients — they pick up the new build via the "New version — Reload" prompt.
```

- [ ] **Step 3: Sanity-check the unit file has no dev server reference left**

```bash
grep -n "dev" scripts/systemd/podium-web.service
```

Expected: no match for the old `... @podium/web dev` ExecStart (only `daemon`/unrelated words if any). The serve command is now `build` + `preview`.

- [ ] **Step 4: Commit**

```bash
git add scripts/systemd/podium-web.service scripts/systemd/README.md
git commit -m "feat(deploy): serve web as built PWA (vite build + preview) instead of dev server"
```

> Do not run `systemctl` here. The live unit is re-installed from this source copy when the branch lands (see `scripts/systemd/README.md`); that is where `daemon-reload` + `restart` happen.

---

## Task 6: Full build verification + acceptance

**Files:** none (verification only).

- [ ] **Step 1: Produce a real build and confirm the PWA artifacts**

```bash
bun run --filter @podium/web build
ls apps/web/dist | grep -E '^(sw\.js|manifest\.webmanifest|registerSW\.js)$'
ls apps/web/dist | grep -E 'pwa-192x192\.png|pwa-512x512\.png|apple-touch-icon-180x180\.png'
```

Expected: `sw.js` and `manifest.webmanifest` are present; the three icon PNGs are present. If `manifest.webmanifest` is missing, the plugin did not register — recheck Task 2.

- [ ] **Step 2: Confirm the manifest content**

```bash
cat apps/web/dist/manifest.webmanifest
```

Expected: JSON with `"name":"Podium"`, `"display":"standalone"`, `"theme_color":"#0e0e12"`, and an `icons` array containing 192 + 512 entries (injected by `pwaAssets`).

- [ ] **Step 3: Confirm the API routes are denied from the SW fallback**

```bash
grep -o 'navigateFallbackDenylist' apps/web/dist/sw.js || grep -rno 'trpc' apps/web/dist/workbox-*.js | head
```

Expected: the precache/denylist config is present in the generated SW bundle (the exact symbol may be minified; the point is the build embedded the denylist — if Step 1 produced `sw.js`, this is informational).

- [ ] **Step 4: Run the whole suite + typecheck + lint**

```bash
bun run test
bun run --filter @podium/web typecheck
bun run lint
```

Expected: all green. In particular `apps/web/test/shell.structure.test.ts` (untouched) and `apps/web/test/pwa.structure.test.ts` pass.

- [ ] **Step 5: Local preview smoke test (optional, on the dev host)**

```bash
bun run --filter @podium/web preview
```

Then from another shell: `curl -sS http://localhost:55556/manifest.webmanifest | head -c 200` should return the manifest JSON, and `curl -sSI http://localhost:55556/sw.js` should be `200`. Stop the preview when done. (Service-worker *registration* needs the HTTPS `:55555` origin — verified by the manual device check below, not by curl.)

- [ ] **Step 6: Manual device acceptance (the real bar — do this on the phone)**

On merge/deploy, from `https://podium-host.example.com:55555` on an iPhone:
1. Safari → Share → **Add to Home Screen** → confirm the Podium icon + name appear.
2. Launch from the home screen → app opens **standalone** (no Safari chrome), live agents/terminals connect as normal.
3. Background the app, trigger a redeploy (land a trivial commit to `main`), reopen the app → within a foreground check the **"New version available — Reload"** toast appears → tap **Reload** → app reloads into the new build.

- [ ] **Step 7: Clean up any build output**

```bash
git status --short
```

Expected: no tracked changes from the build (`apps/web/dist/` must be git-ignored; if it is not, add it to `.gitignore` in this step and commit that one-line change).

---

## Self-review (completed by plan author)

- **Spec coverage:** install-to-home-screen → Tasks 1–3 (icons, manifest, iOS meta); update detection → Tasks 2 + 4 (prompt registerType + UpdatePrompt); instant cold start → Task 2 workbox precache; serve change → Task 5; testing/acceptance → Tasks 2/3/4 structure tests + Task 6 build + device checks. WS-reconnect trigger intentionally deferred (documented at top).
- **Placeholder scan:** none — every code/config block is concrete; the only "optional" steps (5/5, 6/5) are clearly marked and not required for correctness.
- **Type/name consistency:** `UpdatePrompt` (component), `useRegisterSW` / `updateServiceWorker` / `needRefresh` / `onRegisteredSW` (match the `virtual:pwa-register/react` API), `registration.update()`, `.update-toast` / `.update-toast-dismiss` (CSS ↔ JSX class names), `#0e0e12` theme/background used identically in manifest, `theme-color` meta, and the icon SVG.

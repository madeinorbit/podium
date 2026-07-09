# Installable PWA for Podium (mobile app-mode)

**Date:** 2026-06-14
**Status:** Approved design — ready for implementation plan

## Goal

Let the Podium web app be used "as an app" on mobile while staying on the web.
Three concrete capabilities, in priority order:

1. **Install to home screen** — standalone window (no browser chrome), app icon,
   theme color, splash background.
2. **Update detection** — when a redeploy lands, the running app detects it and
   offers a one-tap reload.
3. **Instant cold start** — the app shell launches from cache instead of a cold
   network fetch.

Out of scope: push notifications (separate, larger project), per-device iOS
splash images, offline editing of agent/terminal state (the app is inherently a
live connection to the backend).

## Approach (decided)

**Approach B: production build + `vite-plugin-pwa`, served by `vite preview`.**

Rejected alternative — Approach A (hand-rolled `sw.js` + `/version` endpoint on
the existing Vite *dev* server): keeps the deploy untouched but requires caching
a non-content-hashed dev-server module graph with manual invalidation. Wanting
*instant cold start with correct updates* is exactly Workbox's job, so we take
the standard path and accept a build step.

## Current state (what we're changing)

- `apps/web` is served in production by the **Vite dev server** (`vite`, no build,
  no `dist`) via `scripts/systemd/podium-web.service`. Redeploy = `systemctl
  restart` on `.git/logs/HEAD` change.
- `vite.config.ts` already defines a `preview` block with the same proxy
  (`/trpc`, `/health`, `/client`, `/daemon`), `allowedHosts`, `:55556`,
  `strictPort` as the dev `server` block. **We reuse it as-is.**
- Primary URL is HTTPS (`https://podium-host.example.com:55555`, tailscale
  serve → Vite `:55556`). HTTPS is a **secure context**, which a service worker
  requires. The plain `:55556` http fallback will not register a SW — acceptable.
- No `public/` dir, no manifest, no icons, no service worker today.
- `/health` returns plain `ok`; nothing exposes a build/version signal — and with
  Approach B we don't need one (the Workbox precache hash is the version).

## Components

### 1. Build + serve mode

- Add dev deps to `apps/web`: `vite-plugin-pwa`, `@vite-pwa/assets-generator`.
- `vite.config.ts`: register `VitePWA({ ... })` (config in §3/§4). Set
  `devOptions.enabled: false` so the SW does **not** run under `npm run dev` (it
  would fight HMR). Local dev is unchanged (`vite`, HMR).
- `scripts/systemd/podium-web.service`: change the serve command from `vite`
  (dev) to **`vite build` then `vite preview`**.
  - Implementation detail for the plan: prefer a single wrapper (npm script or
    `scripts/host.ts`-adjacent) `vite build && vite preview` as `ExecStart`, OR
    `ExecStartPre=vite build` + `ExecStart=vite preview`. The plan picks one;
    requirement is: build completes before preview binds `:55556`, and the unit
    fails cleanly (not a half-served stale dist) if build fails.
- `apps/web/package.json`: keep `dev` = `vite` (HMR, unchanged); `build` and
  `preview` already exist and are what the service uses.

### 2. App icon

- Author one source `apps/web/icons/icon.svg` — a simple Podium glyph
  (placeholder, swap for a real logo later). `@vite-pwa/assets-generator`
  produces from it: `pwa-192x192.png`, `pwa-512x512.png`, a maskable variant,
  and `apple-touch-icon-180x180.png`.
- Generated assets land where the plugin serves them (project `public/`-equivalent
  per plugin config); the plan wires the assets-generator preset and the manifest
  `icons` array to match.

### 3. Manifest + iOS meta

- `VitePWA.manifest`: `name: "Podium"`, `short_name: "Podium"`,
  `display: "standalone"`, `theme_color`, `background_color`, `start_url: "/"`,
  `icons` (192, 512, maskable). Theme/background colors pulled from the app's
  existing CSS palette (`apps/web/src/styles.css`) so the splash matches.
- `index.html` `<head>` additions for iOS (Safari ignores most of the manifest):
  - `<meta name="mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
    (chosen to match the existing `viewport-fit=cover` full-bleed layout)
  - `<meta name="apple-mobile-web-app-title" content="Podium">`
  - `<link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png">`
- Keep the existing `viewport` meta unchanged.

### 4. Caching strategy (Workbox, via plugin)

- **Precache** (instant cold start): the built, content-hashed shell — JS, CSS,
  `index.html`, `manifest.webmanifest`, icons — via the plugin's default
  `globPatterns`.
- **Live, never cached**: `/trpc`, `/health`, `/client`, `/daemon`. WebSockets
  bypass the SW `fetch` handler already; for the HTTP routes set
  `workbox.navigateFallback: "/index.html"` with
  `navigateFallbackDenylist: [/^\/trpc/, /^\/health/, /^\/client/, /^\/daemon/]`
  and add **no** runtime caching entries for them (NetworkOnly by omission).
- Net effect: shell from cache, all data from network.

### 5. Update detection

- `registerType: 'prompt'`. Consume `virtual:pwa-register` in a new small unit
  `apps/web/src/UpdatePrompt.tsx`, rendered inside `AppShell`.
  - On `onNeedRefresh`: show a non-blocking toast — "New version — Reload".
    Tap → `updateSW(true)` (skipWaiting + reload).
  - `onOfflineReady`: no UI (avoid noise) or a one-shot subtle confirmation; plan
    decides, default to silent.
- **Proactive checks** so a backgrounded, installed app notices a redeploy. Call
  the registration's `update()`:
  - on `document.visibilitychange` → `visible`,
  - on WebSocket reconnect (hook into the existing reconnect path in the socket
    layer / `store.tsx` — see the WS reconnect work, ping/pong + backoff),
  - on a 60s interval while visible.
- The Workbox precache hash is the version signal; no backend `/version` route.

## Data flow

```
redeploy (HEAD moves)
  → systemd restart podium-web → vite build (new hashed shell) → vite preview
  → running client: registration.update() (on focus / WS reconnect / 60s tick)
  → new SW downloaded & installed, enters "waiting"
  → onNeedRefresh fires → UpdatePrompt toast
  → user taps Reload → updateSW(true) → skipWaiting + navigate → new shell active
```

Cold start (already installed):
```
launch from home screen → SW serves precached shell instantly
  → app boots, opens WS/tRPC to backend (network) → live data
```

## Error handling / edge cases

- **SW vs HMR:** `devOptions.enabled: false` keeps the SW out of `npm run dev`.
- **Secure context:** SW only registers over HTTPS `:55555`; plain `:55556` http
  silently has no SW. Expected.
- **Redeploy serving gap:** `vite build` runs before `vite preview` binds, so the
  site is briefly unavailable during the build (seconds), and a failed build =
  failed unit (`Restart=always` retries). Accepted for v1. Future mitigation
  (out of scope): build to a temp dir + atomic swap so the old dist keeps serving
  until the new build succeeds.
- **Stale cache after deploy:** handled — Workbox installs the new SW in the
  background and prompts; precache is keyed by build hash.
- **iOS install UX:** no `beforeinstallprompt` on iOS Safari; install is the
  manual Share → "Add to Home Screen". v1 relies on the native browser UI (an
  optional one-time iOS hint is a possible follow-up, not in v1).

## Testing

- **Build smoke test:** after `vite build`, assert `dist/sw.js` and
  `dist/manifest.webmanifest` exist (and an icon). Add to the web test suite.
- **Existing guard:** `apps/web/test/shell.structure.test.ts` and the rest of the
  suite stay green.
- **Unit:** the `UpdatePrompt` decision logic (given `onNeedRefresh` →
  toast-visible state; tap → `updateSW` called). Keep the `virtual:pwa-register`
  import behind a thin seam so it's mockable in vitest.
- **Manual acceptance (device, the real bar):** install to home screen on iOS
  from the `:55555` HTTPS URL → launches standalone with icon → trigger a redeploy
  → update toast appears → tap reloads into the new build. Optionally verify with
  the committed Playwright harness that the preview build registers a SW and links
  the manifest.

## Open items for the plan

- Exact systemd `ExecStart` shape (wrapper script vs `ExecStartPre`), and whether
  `scripts/systemd/README.md` topology notes need updating.
- Final `theme_color` / `background_color` hex from `styles.css`.
- Whether `onOfflineReady` shows anything (default: silent).

import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { mobileRedirectLocation, NAVIGATION_FALLBACK_DENYLIST } from './mobile-routing'

// Hosts permitted by Vite's host check, comma-separated via PODIUM_ALLOWED_HOSTS. localhost and
// IP-literal hosts are always allowed by Vite, so plain `localhost` dev needs nothing here; the
// default keeps the maintainer's tailscale node working for the live instance.
const allowedHosts =
  process.env.PODIUM_ALLOWED_HOSTS?.split(',')
    .map((h) => h.trim())
    .filter(Boolean) ?? []

// The app origin binds :55556 (plain http). `tailscale serve` terminates TLS on :55555 and
// proxies here, so the primary URL is https://<host>:55555 — a secure context, which the
// mobile clipboard/paste API requires — with http://<host>:55556 as a plain fallback. It
// proxies the API + WebSockets to the backend (relay + agent daemon) on localhost, so the
// browser talks to one origin and the web app derives its ws:// + tRPC URLs from
// window.location (see src/trpc.ts serverConfig); the TLS hop is transparent to that, and
// HMR is left at its default (client derives host/port/proto from location, correct for both).
// PODIUM_PORT must match scripts/host.ts (both default to 18787 — an uncommon internal port).
const BACKEND_PORT = process.env.PODIUM_PORT ?? '18787'
// The web origin's port. Override with PODIUM_WEB_PORT when 55556 is taken (strictPort means
// Vite hard-fails rather than silently picking another port).
const WEB_PORT = Number(process.env.PODIUM_WEB_PORT ?? 55556)
const BACKEND = `http://localhost:${BACKEND_PORT}`
const BACKEND_WS = `ws://localhost:${BACKEND_PORT}`
const MOBILE_INDEX = fileURLToPath(new URL('../mobile/dist/index.html', import.meta.url))
const proxy = {
  '/health': { target: BACKEND, changeOrigin: true },
  // The update story reads these frozen server contracts directly. Keep them on the
  // same backend origin in source-mode Vite, just as the production server does.
  '/version': { target: BACKEND, changeOrigin: true },
  '/podium-build.json': { target: BACKEND, changeOrigin: true },
  '/trpc': { target: BACKEND, changeOrigin: true },
  // Backend HTTP route that streams sandboxed file bytes (e.g. markdown-preview
  // relative images). Same-origin from the browser, so it must reach the backend.
  '/files': { target: BACKEND, changeOrigin: true },
  // Backend setup/config route the SetupGate probes (GET) and SetupView saves (POST).
  // Same-origin fetch from the browser, so it must reach the backend rather than the SPA.
  '/setup': { target: BACKEND, changeOrigin: true },
  // Login endpoints: LoginGate probes /auth/status; login/logout set the session cookie.
  // MUST reach the backend, or a set password locks everyone out (login can't get a cookie).
  '/auth': { target: BACKEND, changeOrigin: true },
  '/client': { target: BACKEND_WS, ws: true, changeOrigin: true },
  '/daemon': { target: BACKEND_WS, ws: true, changeOrigin: true },
  // The Expo SPA is served by the backend. Without this proxy, Vite's own SPA
  // fallback returns the desktop index for /mobile in the live source setup.
  '/mobile': { target: BACKEND, changeOrigin: true },
}

function mobileEntryRedirectPlugin(): Plugin {
  const redirect = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    const location = mobileRedirectLocation(
      req.url,
      req.headers['user-agent'],
      existsSync(MOBILE_INDEX),
    )
    if (!location) return next()
    res.statusCode = 302
    res.setHeader('Location', location)
    res.end()
  }
  return {
    name: 'podium-mobile-entry-redirect',
    // Both source-mode Vite and built preview sit in front of the backend.
    configureServer(server) {
      server.middlewares.use(redirect)
    },
    configurePreviewServer(server) {
      server.middlewares.use(redirect)
    },
  }
}

export default defineConfig(({ mode }) => {
  /**
   * A DEVELOPMENT BUILD (`bun run build:dev`, i.e. `vite build --mode development`)
   * is the built bundle made readable. It exists because the BUILT bundle — not the
   * dev server — is what a local live instance serves, so a crash there arrived as
   * "Minified React error #185; visit https://react.dev/errors/185" over a stack of
   * `Xr`/`qr`/`Os` with no way back to a component [POD-1954].
   *
   * Three things have to line up for that to read properly, and source maps alone
   * are only one of them:
   *   - `mode: 'development'` resolves react-dom's DEVELOPMENT build, which is what
   *     carries the FULL error text ("Maximum update depth exceeded…") plus the
   *     dev-only warnings. No source map can recover that sentence — it is not in
   *     the production bundle to begin with.
   *   - `minify: false` keeps function and component names, so both the JS stack
   *     and React's component stack name real components.
   *   - `sourcemap: true` (linked) lets DevTools resolve frames interactively.
   */
  const isDevBuild = mode === 'development'

  return {
    plugins: [
      mobileEntryRedirectPlugin(),
      react(),
      tailwindcss(),
      VitePWA({
        /**
         * NO SERVICE WORKER IN A DEVELOPMENT BUILD. Two reasons, either
         * sufficient: an unminified bundle is ~6.5 MB, over the precache ceiling
         * below, and workbox turns that into a `PLUGIN_ERROR` at closeBundle
         * which fails the build AFTER the artefacts are written — so it fails by
         * exit code while looking like it worked. And a precaching service worker
         * is the wrong thing to sit in front of a build you are rebuilding to
         * debug, which is the same reason `devOptions` keeps it out of the dev
         * server.
         *
         * `disable` rather than dropping the plugin from the list: the app imports
         * `virtual:pwa-register/react` (src/app/pwa-register.ts), and without the
         * plugin present that specifier does not resolve and the build dies. The
         * disabled plugin still serves it, as a stub.
         */
        disable: isDevBuild,
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
          // The main app chunk has grown past workbox's 2 MiB default; without a
          // higher ceiling SW generation throws and fails the whole build. Give
          // headroom so the shell still precaches (POD-292).
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          // SPA fallback for navigations — but never shadow the live API/WS routes,
          // the Expo mobile SPA under /mobile, or the `/` and `/desktop` entry
          // redirects. See NAVIGATION_FALLBACK_DENYLIST for why each is on the list.
          navigateFallback: '/index.html',
          navigateFallbackDenylist: NAVIGATION_FALLBACK_DENYLIST,
        },
        // Keep the service worker out of `npm run dev` (it fights HMR); it only
        // ships in the built bundle served by `vite preview`.
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // Resolve workspace source directly so a freshly pulled desktop checkout does not
        // depend on a previously generated node_modules/@podium/model symlink.
        '@podium/commands': fileURLToPath(
          new URL('../../packages/commands/src/index.ts', import.meta.url),
        ),
        '@podium/composer': fileURLToPath(
          new URL('../../packages/composer/src/index.ts', import.meta.url),
        ),
        // [POD-796] Model reaches the bundle at RUNTIME — `protocol/messages/sync.ts`
        // imports the `IssueProjection` zod schema as a VALUE for the feed's
        // 'issueProjection' arm — so it needs the same treatment as the others.
        //
        // Not redundant with `conditions: ['@podium/source']` below, for the same
        // reason protocol is aliased despite having that condition: the condition
        // only chooses an entry point AFTER resolution finds the package, and a
        // checkout with no local @podium symlink resolves by walking UP the
        // filesystem — straight into a sibling checkout's node_modules, where the
        // source condition faithfully resolves MAIN's src. The build exits 0 and
        // bundles code that is not the code under review [POD-746]. Verify with the
        // bundle-content grep, never the exit code.
        '@podium/model': fileURLToPath(
          new URL('../../packages/model/src/index.ts', import.meta.url),
        ),
        '@podium/protocol': fileURLToPath(
          new URL('../../packages/protocol/src/index.ts', import.meta.url),
        ),
        // Subpath alias must precede the bare-package one — the bare alias also
        // prefix-matches subpath imports and would resolve them to a path INSIDE
        // index.ts (`.../index.ts/terminal-view`), which fails at build time.
        '@podium/terminal-client/terminal-view': fileURLToPath(
          new URL('../../packages/terminal-client/src/terminal-view.ts', import.meta.url),
        ),
        '@podium/terminal-client': fileURLToPath(
          new URL('../../packages/terminal-client/src/index.ts', import.meta.url),
        ),
      },
      conditions: ['@podium/source'],
      // apps/mobile pins react-dom 19.2.3, which bun hoists to the repo root;
      // without dedupe, root-hoisted libs (base-ui, testing-library) resolve that
      // copy while our sources get 19.2.7 and react-dom hard-errors on mismatch.
      dedupe: ['react', 'react-dom'],
    },
    // Source maps ship with EVERY build, as `hidden` (POD-1658): the `.map` files land
    // in dist, but no `//# sourceMappingURL=` comment is emitted, so no browser ever
    // fetches them and end users are never served a byte of our sources. That is enough
    // for the job they exist to do — a CDP CPU profile carries raw file:line:col call
    // frames and is resolved OFFLINE against dist/*.map by
    // docs/agents/pod-1658/resolve-profile.mjs, which needs the map on disk and nothing
    // in the page. Without this, top self-time frames read `ure`/`dre`/`ese` and a
    // profile of the real bundle cannot be acted on.
    //
    // Set PODIUM_SOURCEMAP=linked when you want Chrome/Firefox DevTools to resolve the
    // bundle interactively (breakpoints, the DevTools performance panel): that emits the
    // reference comment, and the maps then WILL be fetched by anyone who opens DevTools.
    // Use it on a local build, never on one you hand to someone else.
    //
    // A development build always links them — see `isDevBuild` above.
    //
    // `vite build` EMPTIES dist, so each build deletes the map the last crash report
    // needs. The `build` script therefore copies every emitted map into a retained
    // store (apps/web/.sourcemaps, last 10 builds, POD-1957) right after this runs —
    // scripts/archive-web-sourcemaps.ts. That step only ever reads dist, so nothing
    // here changes, nothing new is served, and the maps stay `hidden`.
    build: {
      sourcemap: isDevBuild || process.env.PODIUM_SOURCEMAP === 'linked' ? true : 'hidden',
      ...(isDevBuild ? { minify: false as const } : {}),
    },
    /**
     * `--mode development` ALONE DOES NOT GIVE YOU DEVELOPMENT REACT. Vite pins
     * the `process.env.NODE_ENV` replacement to `production` for every `build`,
     * whatever the mode — mode drives which `.env` file loads, not this. React
     * picks its build off exactly this string, so without the override a dev-mode
     * build still bundles react-dom.production and still reports "Minified React
     * error #185" with no error text, which is the whole thing this mode exists to
     * fix. Verify by grepping the built bundle for "Maximum update depth exceeded";
     * an exit code proves nothing here.
     */
    define: {
      'process.env.NODE_ENV': JSON.stringify(isDevBuild ? 'development' : 'production'),
    },
    server: { host: '0.0.0.0', port: WEB_PORT, strictPort: true, allowedHosts, proxy },
    preview: { host: '0.0.0.0', port: WEB_PORT, strictPort: true, allowedHosts, proxy },
  }
})

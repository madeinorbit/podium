# Hosting the web app on a separate host

Podium normally serves its own clients: one origin answers the API, the web app
and the phone web app. A deployment can instead put the UI on its own host —
`app.example.com` for the two client bundles, `api.example.com` for this server,
with no client bytes in the server image at all. This page is what that costs and
what it requires. The keys themselves are documented in
[configuration.md](configuration.md); this is the shape they belong to.

## The one rule: same site

The two hosts must share a **registrable domain**. `app.example.com` and
`api.example.com` do; `podium.pages.dev` and `api.example.com` do not.

That is not a preference. The session cookie is set by the API host, host-only,
`HttpOnly`, `SameSite=Lax`. Same-site is exactly the condition under which a
browser attaches a `Lax` cookie to what a page asks for — every credentialed
`fetch`, and the WebSocket upgrade with it. Put the UI on a different *site* and
the cookie is dropped on the first authenticated call: login appears to succeed
and nothing after it works.

Two hostname families look like subdomains and are not. `*.pages.dev` and
`*.workers.dev` are on the [public suffix list], so `podium.pages.dev` is a site
of its own — cross-site with any `example.com` API. A preview or staging app host
has to live under the same domain as the API it talks to.

[public suffix list]: https://publicsuffix.org

Truly cross-site hosting is not supported. It would need `SameSite=None; Secure`
on the cookie, a CSRF token or origin check on every state-changing route (`Lax`
no longer does that work), and an answer for third-party cookie blocking in
Safari and Chrome — which pushes a browser session onto bearer tokens, a path
`/auth/login` deliberately closes to any request carrying an `Origin` header.

## What to set on the API server

```sh
PODIUM_PUBLIC_URL=https://api.example.com
PODIUM_APP_URL=https://app.example.com
PODIUM_ALLOWED_ORIGINS=https://app.example.com
PODIUM_TRUSTED_PROXY_HOPS=1        # if TLS is terminated in front of you
```

`PODIUM_ALLOWED_ORIGINS` is the trust statement: the exact origins that may make
credentialed cross-origin calls and open browser WebSockets. Exact means exact —
scheme, host and port all compared, no wildcards, no patterns. `https://` in the
list never admits `http://`, and a neighbouring port is a different origin. It is
read once at boot.

Keep it to **one entry per API instance**. The list can hold more, and every
extra entry is another origin that may drive this server with an operator's
cookie attached. A staging app host belongs in front of a staging API.

`PODIUM_APP_URL` is where a browser is sent when it asks this server for a page
it does not have: `/`, `/desktop`, `/mobile` and `/mobile/*` redirect there on a
server with no web bundle. A server that *has* a bundle keeps serving it. It is
also advertised on `/version` and `/setup/config`, which is how the desktop shell
learns where the UI lives.

`PODIUM_TRUSTED_PROXY_HOPS=1` is not optional behind a TLS-terminating proxy
(Fly, a load balancer, nginx). Without it the server cannot tell that the request
arrived over HTTPS, so the session cookie is set **without `Secure`**. Chrome
will still accept it, so login looks fine — but the bearer-over-HTTPS guard and
the WebSocket principal resolver both refuse a request they cannot prove was
secure, and the failure surfaces far from its cause. The default is 1 only for a
loopback bind; a server bound to `0.0.0.0` must say so.

## What the app host must serve

- The web bundle at `/` and the phone export under `/mobile/`, which is the base
  the phone export is already built for.
- `window.__PODIUM_SERVER__ = "https://api.example.com"` as the **first** element
  of `<head>` in both shells. The web client reads it at module evaluation of its
  entry chunk, so a script placed later in `<head>` is already too late.
- `window.__PODIUM_SAME_SITE__ = true` in the phone shell. Without it the phone
  web app ignores the injected origin and talks to its own page origin, which on
  the app host serves no API. It is a build-time declaration on purpose: deciding
  "same site" in the page means deriving a registrable domain from a hostname,
  and being wrong there sends credentials to a host that merely looks like a
  neighbour.
- Hashed assets as `public, max-age=31536000, immutable`, and everything else —
  `index.html`, the service worker, the manifest — as `no-cache`.
- An SPA fallback per tree: unmatched paths serve the web `index.html`, unmatched
  paths under `/mobile/` serve the phone one. Serve the API's own prefixes
  (`/trpc`, `/auth`, `/files`, `/client`, `/daemon`, `/setup`, `/readiness`,
  `/version`, `/health`, `/mcp`) as 404 rather than HTML, so a stray relative
  fetch fails loudly instead of parsing a page as JSON.

## Reproducing it locally

`localtest.me` and every subdomain resolve to `127.0.0.1`, and it is not a public
suffix — so two hosts under it are same-site exactly the way production is.
`localhost` subdomains are not a substitute: browsers special-case `localhost`,
and so does this server's own origin policy.

```sh
PODIUM_HOST=127.0.0.1 PODIUM_ALLOWED_ORIGINS=http://app.localtest.me:55556 podium serve
bun run --filter @podium/web dev            # PODIUM_ALLOWED_HOSTS=app.localtest.me
open 'http://app.localtest.me:55556/?server=http://api.localtest.me:18787'
```

`?server=` is the development override and always wins over anything a build
injected.

`apps/server/src/cross-origin-app-host.integration.test.ts` drives this shape end
to end — preflight, login, cookie, tRPC, `/files`, `/version`, socket upgrade —
and is the fastest way to see the contract this page describes.

## When it does not work

The server logs one `cross-origin request refused` line per distinct origin,
host and reason, at `warn`. A refused origin is otherwise invisible from the
server side: the CORS response simply carries no allow-origin header and the
socket upgrade is a bare 403, both of which a browser reports as an unspecific
network error.

| Symptom | Usually |
|---|---|
| Login returns 200, every later call is 401 | The two hosts are not same-site, so the cookie is dropped |
| The browser reports a network/CORS error on `/auth/login` | The app origin is not in `PODIUM_ALLOWED_ORIGINS`, or differs by scheme or port |
| The socket never opens, everything else works | Same, on the WebSocket plane — check the 403 and the log line |
| It works in Chrome over HTTP and fails over HTTPS | `PODIUM_TRUSTED_PROXY_HOPS` is unset behind the proxy, so the cookie lacks `Secure` |
| The phone web app at `/mobile/` talks to the app host | The shell is missing `__PODIUM_SAME_SITE__` |

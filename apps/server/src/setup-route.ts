import type { ServerReadiness } from '@podium/model'
import { loadConfig, resolveSetting } from '@podium/runtime/config'
import type { Hono } from 'hono'

/**
 * Read-only setup status. The web SetupGate + desktop shell probe this to decide whether to
 * show onboarding. WRITES go through the `setup.*` tRPC procedures (complete / join / connect)
 * — one authenticated surface for every setup mutation — so there is no POST here.
 *
 * SECURITY: this route is unauthenticated by design (it must answer before login exists), so
 * it must never echo the config back. The readiness projection it forwards is the only config
 * fact allowed through, and `stale` forwards field NAMES rather than values for that reason. The config can hold credentials — `upstream.token` (a
 * hub-minted long-lived client-session token) and `pairCode` — which would otherwise be
 * readable by anyone who can reach the URL. Only setup-gating fields leave this route;
 * authenticated readers use the `setup.info` tRPC procedure. The local launcher capability
 * is transport metadata, deliberately separate from the shared readiness state.
 */
export function registerSetupRoute(
  app: Hono,
  opts: { readiness: () => ServerReadiness; localSetupDefault?: boolean },
): void {
  app.get('/setup/config', (c) => {
    const config = loadConfig()
    const readiness = opts.readiness()
    const required = readiness.state === 'unconfigured' || readiness.state === 'activation_pending'
    if (readiness.state === 'unconfigured' && opts.localSetupDefault === true) {
      c.header('X-Podium-Local-Setup', 'all-in-one')
    }
    const mode = resolveSetting('mode', config)
    const appUrl = resolveSetting('appUrl', config)
    return c.json({
      needsSetup: required,
      mode: mode.value ?? null,
      // WHICH LAYER answered (PDM-26). The web SetupView skips the mode step on
      // 'env': offering a choice the deployment already made is a dead control
      // on the one screen a first-time operator has no context to read it on.
      modeSource: mode.source,
      /**
       * Where the UI actually lives (PDM-26). This route is what a browser
       * pointed at an API-only origin reaches BEFORE it has a page, so it is
       * the earliest honest place to say "not here, there". Omitted entirely
       * when absent — a self-hosted server serves its own UI and has nothing to
       * add. Non-secret: it is a public address, and the redirects below already
       * hand it to anyone who asks.
       */
      ...(appUrl.value ? { appUrl: appUrl.value } : {}),
      state: readiness.state,
      reason: readiness.reason,
      dataPlane: readiness.dataPlane,
      // The plane split and the stale field NAMES (POD-2766). Both are already
      // public on /readiness and neither is a secret — `stale` carries config
      // KEYS, never their values, which is what keeps it safe on an
      // unauthenticated route while still letting the blocked screen say what it
      // is waiting on.
      ...(readiness.controlPlane ? { controlPlane: readiness.controlPlane } : {}),
      ...(readiness.stale?.length ? { stale: readiness.stale } : {}),
    })
  })
}

/**
 * THE ONBOARDING AGENT AND READY SCREENS, REAL, IN A BROWSER (POD-1225).
 *
 * `bunx vite --config vite.setup.config.ts` in apps/web, then open
 * `/setup-harness.html#agent` or `#first-task`.
 *
 * The new-VPS step is here too (POD-1288), one hash per answer the channel query
 * can give: `#vps-reading` (still unanswered), `#vps-edge`, `#vps-stable` (the
 * channel with nothing published on it) and `#vps-unread` (the query failed).
 * `#vps-restarting` and `#vps-restart-required` (POD-1292) carry it past the
 * moment its connection became durable — the two states that used to be one
 * error box telling the user to quit the app by hand. `#connected` (POD-1323) is
 * the step AFTER that restart: the screen a desktop lands on once it is a client
 * of the server it just set up.
 * In a worktree, run `bun install` there first — otherwise vite follows the
 * workspace symlinks and renders the MAIN checkout's `@podium/*` sources.
 */

import { createRoot } from 'react-dom/client'
import type { Trpc } from '@/app/trpc'
import { FirstTaskActivation } from '@/features/setup/FirstTaskActivation'
import { OnboardingWizard } from '@/features/setup/OnboardingWizard'
import type { ShellRestart } from '@/features/setup/restart-shell'
import type { ConfirmedVpsActivation } from '@/features/setup/use-vps-activation'
import { VpsFirstActivation } from '@/features/setup/VpsFirstActivation'
import { vpsIntroState } from '@/features/setup/vps-activation'
import '@/index.css'
import '@/styles.css'

const hash = window.location.hash.slice(1)

/** The one thing each VPS variant invents: what `setup.channel` answers, and when. */
function vpsTrpc(): Trpc {
  const answer = (): Promise<unknown> => {
    if (hash === 'vps-unread') return Promise.reject(new Error('server is restarting'))
    if (hash === 'vps-reading') return new Promise(() => {})
    return Promise.resolve({ channel: hash === 'vps-stable' ? 'stable' : 'edge' })
  }
  return Object.assign(() => undefined, {
    setup: {
      channel: { query: answer },
      connect: { mutate: async () => undefined },
    },
  }) as unknown as Trpc
}

const vps: ConfirmedVpsActivation = {
  state: vpsIntroState('vps-choice'),
  ready: true,
  saving: false,
  error: null,
  persist: async (next) => next,
  // What the real server answers once `setup.connect` has flipped its mode: it is
  // activation-pending from that instant, and refuses every non-setup call.
  clear: async () => {
    throw new Error('server_not_ready')
  },
}

/**
 * A hook that never settles parks the handoff on "restarting" — the shell is
 * leaving. One that reports a refusal moves it to the button. Both are what the
 * shipping code renders; the channel variants never reach either.
 */
const onConfigured = async (): Promise<ShellRestart> =>
  hash === 'vps-restart-required' ? 'unavailable' : new Promise<ShellRestart>(() => {})

const root = document.getElementById('root')
if (root) {
  root.style.minHeight = '100vh'
  // The VPS answers ready: these variants are about the steps AROUND the probe.
  if (hash.startsWith('vps')) {
    window.fetch = (async () =>
      new Response(JSON.stringify({ state: 'ready', reason: null, dataPlane: 'available' }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
  }
  createRoot(root).render(
    hash === 'connected' ? (
      <OnboardingWizard
        route="server-connected"
        onRouteChange={() => {}}
        onComplete={() => {}}
        onConnectionConfigured={onConfigured}
        onEnterVps={async () => {}}
        trpc={vpsTrpc()}
        vps={vps}
      />
    ) : hash.startsWith('vps') ? (
      <VpsFirstActivation
        trpc={vpsTrpc()}
        vps={vps}
        onRouteChange={() => {}}
        onConfigured={onConfigured}
      />
    ) : (
      <FirstTaskActivation
        route={hash === 'first-task' ? 'first-task' : 'agent'}
        onRouteChange={() => {}}
        onComplete={() => {}}
      />
    ),
  )
}

/**
 * THE ONBOARDING AGENT AND READY SCREENS, REAL, IN A BROWSER (POD-1225).
 *
 * `bunx vite --config vite.setup.config.ts` in apps/web, then open
 * `/setup-harness.html#agent` or `#first-task`.
 *
 * The new-VPS step is here too (POD-1288), one hash per answer the channel query
 * can give: `#vps-reading` (still unanswered), `#vps-edge`, `#vps-stable` (the
 * channel with nothing published on it) and `#vps-unread` (the query failed).
 * In a worktree, run `bun install` there first — otherwise vite follows the
 * workspace symlinks and renders the MAIN checkout's `@podium/*` sources.
 */

import { createRoot } from 'react-dom/client'
import type { Trpc } from '@/app/trpc'
import { FirstTaskActivation } from '@/features/setup/FirstTaskActivation'
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
  clear: async () => {},
}

const root = document.getElementById('root')
if (root) {
  root.style.minHeight = '100vh'
  createRoot(root).render(
    hash.startsWith('vps') ? (
      <VpsFirstActivation
        trpc={vpsTrpc()}
        vps={vps}
        onRouteChange={() => {}}
        onConfigured={async () => {}}
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

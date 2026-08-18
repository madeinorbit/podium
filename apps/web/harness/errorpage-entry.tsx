/**
 * EVERY SCREEN PODIUM SHOWS INSTEAD OF YOUR WORK, REAL, IN A BROWSER.
 *
 * POD-1298 built this to answer one question — does the disclosure LOOK like a
 * control at rest — which no jsdom test can see. POD-1304 turned the four
 * stopped-Podium screens into one composition, so the harness now renders the
 * whole set: `?case=` picks one, and the same real CSS, real `<details>` and
 * real fonts ship in it.
 *
 * `?bare=1` renders the crash case with the chevron stripped back out — the
 * positive control, reproducing the label the crash screen shipped with. If the
 * two shots look the same, the harness is blind and its verdict means nothing.
 */
import { createRoot } from 'react-dom/client'
import { AppErrorPage } from '@/app/AppErrorPage'
import { ReplicaFailureScreen } from '@/app/ReplicaFailureScreen'
import { SetupUnreachable } from '@/features/setup/SetupUnreachable'
import type { ReplicaFailure } from '@/lib/replica-failure'
import '@/index.css'
import '@/styles.css'

const DETAIL = `TypeError: Cannot read properties of undefined (reading 'kind')
    at SessionRow (SessionRow.tsx:118:21)
    at renderWithHooks (react-dom.js:11121:18)`

const params = new URLSearchParams(window.location.search)
const bare = params.has('bare')
const which = params.get('case') ?? 'crash'
const ORIGIN = 'http://workshop.local:18787'

/** The old screen, byte for byte, for an honest before/after. */
function LegacyReplicaScreen(): React.JSX.Element {
  return (
    <main className="flex min-h-full items-center justify-center bg-background p-6">
      <section className="w-[min(440px,100%)]">
        <div className="h-[2px] w-6 rounded-full bg-primary" />
        <h1 className="mt-[18px] mb-0 text-[23px] leading-[1.25] font-medium tracking-[-0.02em] text-balance text-foreground">
          Podium could not open its private replica
        </h1>
        <p className="mt-2.5 mb-0 text-sm text-muted-foreground">
          authenticated account is unavailable
        </p>
        <div className="mt-[22px] flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            Reload interface
          </button>
        </div>
      </section>
    </main>
  )
}

function replica(cause: ReplicaFailure): React.JSX.Element {
  return (
    <ReplicaFailureScreen
      cause={cause}
      detail="authenticated account is unavailable"
      httpOrigin={ORIGIN}
      win={{ location: { reload: () => {}, href: '/' } }}
    />
  )
}

const CASES: Record<string, () => React.JSX.Element> = {
  legacy: () => <LegacyReplicaScreen />,
  crash: () => (
    <AppErrorPage
      title={'The interface stopped.\nYour agents did not.'}
      eyebrow="Interface / crashed"
      trace={{ from: 'agents', to: 'this window' }}
      fields={[
        { label: 'Agents', value: 'still running' },
        { label: 'Your work', value: 'safe on the host' },
        { label: 'This window', value: 'needs a reload', tone: 'fault' },
      ]}
      detail={DETAIL}
      onRetry={() => {}}
      retryLabel="Try rendering again"
      win={{ location: { reload: () => {}, href: '/' } }}
    />
  ),
  disconnected: () => (
    <AppErrorPage
      title={'Podium lost its\nline to the server.'}
      eyebrow="Connection / dropped"
      message="Your board is open on the host and your agents are still running there; this window just cannot reach it. The exact fault is below."
      detail="WebSocket closed before the connection was established"
      trace={{ from: 'this browser', to: 'server' }}
      fields={[{ label: 'Server', value: ORIGIN }]}
      retryLabel="Reconnect"
      onRetry={() => {}}
      win={{ location: { reload: () => {}, href: '/' } }}
    />
  ),
  unreachable: () => <SetupUnreachable httpOrigin={ORIGIN} onRetry={() => {}} />,
  'signed-out': () => replica({ kind: 'signed-out' }),
  starting: () =>
    replica({
      kind: 'server-starting',
      readiness: { state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' },
    }),
  restarting: () =>
    replica({
      kind: 'server-starting',
      readiness: { state: 'activation_pending', reason: 'restart_required', dataPlane: 'blocked' },
    }),
  'no-account': () => replica({ kind: 'account-missing' }),
  insecure: () => replica({ kind: 'auth-insecure' }),
  refused: () => replica({ kind: 'auth-refused', status: 502 }),
  intercepted: () => replica({ kind: 'auth-intercepted' }),
  offline: () => replica({ kind: 'offline-unknown' }),
  ambiguous: () => replica({ kind: 'offline-ambiguous', count: 2 }),
  storage: () => replica({ kind: 'replica-blocked' }),
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div data-bare={bare ? '1' : '0'} data-case={which}>
    {(CASES[which] ?? CASES.crash)()}
  </div>,
)

// The control: pull the chevron out of the DOM after mount, leaving the label
// exactly as bare as it was before POD-1298. React commits after this module
// finishes, and a single rAF landed before the commit on the first run — so
// keep taking it out until it stops coming back.
if (bare) {
  window.setInterval(() => document.querySelector('summary svg')?.remove(), 16)
}

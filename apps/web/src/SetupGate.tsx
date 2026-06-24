import { type ReactNode, useEffect, useState } from 'react'
import { SetupView } from './SetupView'
import { serverConfig } from './trpc'

type Phase = 'loading' | 'setup' | 'ready'

/** Desktop shell exposes a restart hook so a mode change re-runs the shell (re-reads config);
 *  a web reload alone would keep the same shell process. Browser → plain reload. */
function onSetupSaved(): void {
  const restart = (window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__
  if (restart) restart()
  else window.location.reload()
}

/** Gates the app on setup: shows SetupView until a deployment mode is configured. */
export function SetupGate({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading')
  const httpOrigin = serverConfig(window.location).httpOrigin

  useEffect(() => {
    let alive = true
    fetch(`${httpOrigin}/setup/config`)
      .then((r) => r.json())
      .then((d: { needsSetup: boolean }) => alive && setPhase(d.needsSetup ? 'setup' : 'ready'))
      .catch(() => alive && setPhase('ready')) // a backend without the route → don't block the app
    return () => {
      alive = false
    }
  }, [httpOrigin])

  if (phase === 'loading') return null
  if (phase === 'setup')
    return <SetupView httpOrigin={httpOrigin} onSaved={onSetupSaved} />
  return <>{children}</>
}

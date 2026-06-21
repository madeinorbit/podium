import { type ReactNode, useEffect, useState } from 'react'
import { SetupView } from './SetupView'
import { serverConfig } from './trpc'

type Phase = 'loading' | 'setup' | 'ready'

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
    return <SetupView httpOrigin={httpOrigin} onSaved={() => window.location.reload()} />
  return <>{children}</>
}

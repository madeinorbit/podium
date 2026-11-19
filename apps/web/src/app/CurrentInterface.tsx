import { type ReactNode, useEffect, useState } from 'react'
import { repairInterfaceOnBoot } from '@/lib/boot-interface'
import { forceReload } from '@/lib/force-reload'
import { serverConfig } from './trpc'

/** The check precedes every authenticated or signed-out screen. */
export function CurrentInterface({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<'checking' | 'ready' | 'reloading' | 'failed'>('checking')
  const [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    void repairInterfaceOnBoot(serverConfig(window.location).httpOrigin)
      .then((answer) => {
        if (!alive) return
        setState(answer)
        if (answer === 'reloading')
          timer = setTimeout(() => {
            setError('The interface update did not finish. Please retry.')
            setState('failed')
          }, 10000)
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setState('failed')
      })
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  if (state === 'ready') return children
  if (state === 'failed')
    return (
      <div role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => void forceReload('boot-interface-retry')}>
          Retry
        </button>
      </div>
    )
  return <div className="app-loading" role="status" aria-label="Loading Podium" />
}

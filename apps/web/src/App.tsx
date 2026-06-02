import { type MountedSession, mountSession } from '@podium/terminal-client'
import { useEffect, useRef } from 'react'

export function App(): JSX.Element {
  const termRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = termRef.current
    const bar = barRef.current
    if (!term || !bar) return
    const params = new URLSearchParams(globalThis.location.search)
    const server = params.get('server') ?? `ws://${globalThis.location.hostname}:8787`
    const session: MountedSession = mountSession(term, {
      url: `${server}/client`,
      toolbarEl: bar,
      test: params.get('test') === '1',
    })
    return () => session.dispose()
  }, [])

  return (
    <div>
      <div id="term" ref={termRef} />
      <div id="toolbar" ref={barRef} />
    </div>
  )
}

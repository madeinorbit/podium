import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { parseServer } from './trpc'
import { StoreProvider } from './store'
import { ConnectScreen } from './ConnectScreen'
import { Sidebar } from './Sidebar'
import { Workspace } from './Workspace'
import { MobileApp } from './MobileApp'

function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}

export function AppShell(): JSX.Element {
  const fromUrl = parseServer(window.location.search)
    ? new URLSearchParams(window.location.search).get('server')
    : null
  const [origin, setOrigin] = useState<string | null>(fromUrl)
  const isMobile = useIsMobile()

  if (!origin) return <ConnectScreen onConnect={setOrigin} />
  return (
    <StoreProvider origin={origin}>
      {isMobile ? (
        <MobileApp />
      ) : (
        <div className="desktop-shell">
          <Sidebar />
          <Workspace />
        </div>
      )}
    </StoreProvider>
  )
}

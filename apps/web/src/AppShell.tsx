import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { ConnectScreen } from './ConnectScreen'
import { MobileApp } from './MobileApp'
import { Sidebar } from './Sidebar'
import { StoreProvider } from './store'
import { parseServer } from './trpc'
import { Workspace } from './Workspace'

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

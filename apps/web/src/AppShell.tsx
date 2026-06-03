import { useState } from 'react'
import type { JSX } from 'react'
import { parseServer } from './trpc'
import { StoreProvider } from './store'
import { ConnectScreen } from './ConnectScreen'
import { Sidebar } from './Sidebar'
import { Workspace } from './Workspace'

export function AppShell(): JSX.Element {
  const fromUrl = parseServer(window.location.search)
    ? new URLSearchParams(window.location.search).get('server')
    : null
  const [origin, setOrigin] = useState<string | null>(fromUrl)

  if (!origin) return <ConnectScreen onConnect={setOrigin} />
  return (
    <StoreProvider origin={origin}>
      <div className="desktop-shell">
        <Sidebar />
        <Workspace />
      </div>
    </StoreProvider>
  )
}

import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { AppErrorPage } from './AppErrorPage'
import { ConnectScreen } from './ConnectScreen'
import { ErrorBoundary } from './ErrorBoundary'
import { MobileApp } from './MobileApp'
import { OnboardingWizard } from './OnboardingWizard'
import { Sidebar } from './Sidebar'
import { StoreProvider, useStore } from './store'
import { parseServer, parseServerOrigin } from './trpc'
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
  const [appError, setAppError] = useState<string | null>(null)
  const isMobile = useIsMobile()

  const changeServer = useCallback(() => {
    setAppError(null)
    setOrigin(null)
  }, [])

  const connect = useCallback((nextOrigin: string) => {
    setAppError(null)
    setOrigin(nextOrigin)
  }, [])

  if (!origin) return <ConnectScreen onConnect={connect} />

  if (!parseServerOrigin(origin)) {
    return (
      <AppErrorPage
        title="Invalid relay server"
        message="Enter a ws:// or wss:// relay server URL."
        onChangeServer={changeServer}
      />
    )
  }

  if (appError) {
    return (
      <AppErrorPage
        title="Podium could not connect"
        message={appError}
        onRetry={() => setAppError(null)}
        onChangeServer={changeServer}
      />
    )
  }

  return (
    <ErrorBoundary
      resetKey={origin}
      onRetry={() => setAppError(null)}
      onChangeServer={changeServer}
      onError={setAppError}
    >
      <StoreProvider origin={origin} onFatalError={setAppError}>
        <AppBody isMobile={isMobile} />
      </StoreProvider>
    </ErrorBoundary>
  )
}

function AppBody({ isMobile }: { isMobile: boolean }): JSX.Element {
  const { repos, reposLoaded } = useStore()
  const [dismissed, setDismissed] = useState(false)

  // First run: the registry is genuinely empty (not just still loading). Show the
  // onboarding scan flow. Adding repos makes it non-empty; dismissing skips to the
  // empty workspace, where "+ Add repo" reopens the same flow.
  if (reposLoaded && repos.length === 0 && !dismissed) {
    return <OnboardingWizard onDismiss={() => setDismissed(true)} />
  }

  if (isMobile) return <MobileApp />
  return (
    <div className="desktop-shell">
      <Sidebar />
      <Workspace />
    </div>
  )
}

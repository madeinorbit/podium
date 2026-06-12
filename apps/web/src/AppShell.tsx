import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AppErrorPage } from './AppErrorPage'
import { ErrorBoundary } from './ErrorBoundary'
import { HomeView } from './HomeView'
import { MobileApp } from './MobileApp'
import { OnboardingWizard } from './OnboardingWizard'
import { Sidebar } from './Sidebar'
import { StoreProvider, useStore } from './store'
import { serverConfig } from './trpc'
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
  // Relay endpoints are always resolved automatically — never typed by the user.
  // serverConfig() derives same-origin ws:// + tRPC URLs from window.location (the
  // host server proxies /client + /trpc to the backend), and honors an explicit
  // `?server=ws://host:port` URL override for connecting to a remote relay.
  const [config] = useState(() => serverConfig(window.location))
  const [appError, setAppError] = useState<string | null>(null)
  const isMobile = useIsMobile()

  if (appError) {
    return (
      <AppErrorPage
        title="Podium could not connect"
        message={appError}
        onRetry={() => setAppError(null)}
      />
    )
  }

  return (
    <ErrorBoundary
      resetKey={config.wsClientUrl}
      onRetry={() => setAppError(null)}
      onError={setAppError}
    >
      <StoreProvider config={config} onFatalError={setAppError}>
        <AppBody isMobile={isMobile} />
      </StoreProvider>
    </ErrorBoundary>
  )
}

function AppBody({ isMobile }: { isMobile: boolean }): JSX.Element {
  const { repos, reposLoaded, view } = useStore()
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
      {view === 'home' ? <HomeView /> : <Workspace />}
    </div>
  )
}

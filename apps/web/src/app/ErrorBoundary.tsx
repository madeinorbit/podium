import { createLogger } from '@podium/logger'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportCrash } from '@podium/client-core/logging'
import { AppErrorPage, formatAppError } from './AppErrorPage'

const log = createLogger('web:boundary')

/**
 * Catches RENDER crashes (a component threw during render/effects) and shows an
 * honest "the UI crashed" page. Deliberately NOT funneled into AppShell's
 * connection-error state: a crash loop (e.g. React #185, maximum update depth)
 * used to surface as "Podium could not connect" even though the connection was
 * fine — the fallback must say what actually happened.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode
    resetKey: string
    onRetry?: () => void
    onError?: (message: string) => void
  },
  { message: string | null }
> {
  override state = { message: null }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: formatAppError(error) }
  }

  /**
   * The component stack is the ONLY thing here that the error itself does not
   * carry, and it is the thing that says WHICH card blew up. It used to be
   * dropped on the floor with `_info` — a crash report reading "Cannot read
   * properties of undefined" with a minified JS stack and no component names is
   * a report you cannot act on
   * [spec: 2026-08-11-logging-strategy-design, "Crash capture"].
   */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? undefined
    log.error(formatAppError(error), { err: error, componentStack })
    reportCrash(error, { source: 'error-boundary', ...(componentStack ? { componentStack } : {}) })
    this.props.onError?.(formatAppError(error))
  }

  override componentDidUpdate(prevProps: Readonly<{ resetKey: string }>): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.message) {
      this.setState({ message: null })
    }
  }

  override render(): ReactNode {
    if (this.state.message) {
      return (
        <AppErrorPage
          title="Podium crashed"
          message={`The Podium interface hit an error while rendering: ${this.state.message}`}
          onRetry={() => {
            // Reset the boundary itself (resetKey only clears on a config change),
            // then let the owner reset whatever state it keeps.
            this.setState({ message: null })
            this.props.onRetry?.()
          }}
        />
      )
    }
    return this.props.children
  }
}

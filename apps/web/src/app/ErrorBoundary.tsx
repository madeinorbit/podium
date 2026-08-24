import { reportCrash } from '@podium/client-core/logging'
import { createLogger } from '@podium/logger'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { checkServedAssets } from '@/features/setup/version-guard'
import { AppErrorPage, formatAppError } from './AppErrorPage'
import { looksLikeChunkLoadFailure } from './chunk-load-failure'
import { serverConfig } from './trpc'

const log = createLogger('web:boundary')

/**
 * Ask the server whether it has swapped the website out from under this page.
 *
 * Injected so the test can answer without a network, and defaulted here rather
 * than threaded through `AppShell` so every boundary — including any added later
 * — gets the behaviour without a prop nobody remembers to pass.
 */
export type AssetsReplacedProbe = () => Promise<boolean>

const askTheServer: AssetsReplacedProbe = async () =>
  (await checkServedAssets(serverConfig(window.location).httpOrigin)) === 'replaced'

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
    /** Injected for the test; production asks the real server. */
    probeAssetsReplaced?: AssetsReplacedProbe
  },
  { message: string | null; assetsReplaced: boolean }
> {
  override state: { message: string | null; assetsReplaced: boolean } = {
    message: null,
    assetsReplaced: false,
  }

  private alive = true

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: formatAppError(error) }
  }

  override componentWillUnmount(): void {
    this.alive = false
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
    const message = formatAppError(error)
    log.error(message, { err: error, componentStack })
    reportCrash(error, { source: 'error-boundary', ...(componentStack ? { componentStack } : {}) })
    this.props.onError?.(message)

    /**
     * A CHUNK THAT WOULD NOT LOAD IS A QUESTION, NOT AN ANSWER (POD-2721).
     *
     * The crash the human hit was a lazily-imported route whose file the server
     * had deleted during an update. Presenting that as "the interface stopped"
     * beside a bug-report console is technically true and useless: nothing is
     * broken, the app simply moved, and the reload button on that page is the
     * whole fix — it is just not labelled as one.
     *
     * What this must NOT do is treat the failure itself as permission to act. A
     * chunk can also fail because the network blinked, or because the server has
     * a real asset-serving bug — and a page that reloaded on any chunk 404 would
     * hide that bug behind a loop nobody can break out of, which is exactly the
     * bill POD-2608 already paid. So the failure only earns a QUESTION, put to
     * the one party that can answer it: is what you are serving still what I am
     * running? Only a yes changes the screen, and even then it changes the words
     * and the button — it never reloads by itself.
     */
    if (!looksLikeChunkLoadFailure(message)) return
    const probe = this.props.probeAssetsReplaced ?? askTheServer
    void probe()
      .then((replaced) => {
        if (replaced && this.alive) this.setState({ assetsReplaced: true })
      })
      .catch(() => {
        // An unanswerable question leaves the honest crash page in place.
      })
  }

  override componentDidUpdate(prevProps: Readonly<{ resetKey: string }>): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.message) {
      this.setState({ message: null, assetsReplaced: false })
    }
  }

  override render(): ReactNode {
    if (this.state.message) {
      /**
       * The server has confirmed it is serving a different build. Say THAT — an
       * app that moved, not an app that broke — and make the reload the point of
       * the screen rather than the recovery from a bug report.
       */
      if (this.state.assetsReplaced) {
        return (
          <AppErrorPage
            title={'Podium was updated.\nThis page is the old one.'}
            eyebrow="Interface / replaced"
            message={
              <>
                The server is now serving a different build of Podium, so part of this page could
                not be loaded.{' '}
                <strong style={{ fontWeight: 600, color: 'var(--text-strong, var(--foreground))' }}>
                  Nothing has gone wrong and nothing has been lost
                </strong>{' '}
                — reload to pick up the build the server is serving.
              </>
            }
            trace={{ from: 'this page', to: 'the server’s build' }}
            fields={[
              { label: 'Agents', value: 'still running' },
              { label: 'Your work', value: 'safe on the host' },
              { label: 'This page', value: 'a replaced build', tone: 'fault' },
            ]}
            detail={`A code file this page asked for is no longer on the server: ${this.state.message}`}
          />
        )
      }
      return (
        <AppErrorPage
          // The headline carries the reassurance, because the operator's real
          // question is "did I just lose the work?" and the answer is no. The
          // error itself is evidence, not the news [POD-1004].
          title={'The interface stopped.\nYour agents did not.'}
          eyebrow="Interface / crashed"
          // The console carries the reassurance as facts rather than as more
          // prose, because "did I just lose the work?" is answered by a list of
          // what is still standing, and only the last line is the bad news.
          trace={{ from: 'agents', to: 'this window' }}
          fields={[
            { label: 'Agents', value: 'still running' },
            { label: 'Your work', value: 'safe on the host' },
            { label: 'This window', value: 'needs a reload', tone: 'fault' },
          ]}
          detail={`The Podium interface hit an error while rendering: ${this.state.message}`}
          retryLabel="Try rendering again"
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

import { reportCrash } from '@podium/client-core/logging'
import { createLogger } from '@podium/logger'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { checkServedAssets } from '@/features/setup/version-guard'
import { patienceFor, waitForServerAnswer } from '@/lib/chunk-recovery'
import type { ServedAssetsAnswer } from '@/lib/served-assets'
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
 *
 * It answers the FULL verdict now, not a boolean (POD-2762). The boolean was the
 * bug: `replaced` and `unreachable` both collapsed to "not replaced", so a page
 * whose server was restarting got the same screen as a page that had genuinely
 * broken, and the screen said the interface had stopped when it had not.
 */
export type AssetsProbe = () => Promise<ServedAssetsAnswer>

const askTheServer: AssetsProbe = () => checkServedAssets(serverConfig(window.location).httpOrigin)

/**
 * What this screen is about. Four situations that look identical from inside a
 * `componentDidCatch` and could hardly need more different responses.
 */
type Situation =
  /** A component threw. The honest crash page. */
  | 'crashed'
  /** The server is up and serving different bytes: the assets moved. Reload. */
  | 'assets-replaced'
  /** Nothing answered. The server is restarting; wait for it. */
  | 'server-restarting'
  /** It came back, and this page still needs a reload to pick the surface up. */
  | 'server-returned'

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
    probeAssets?: AssetsProbe
    /** Injected for the test; production waits on the real clock. */
    waitForServer?: typeof waitForServerAnswer
  },
  { message: string | null; situation: Situation }
> {
  override state: { message: string | null; situation: Situation } = {
    message: null,
    situation: 'crashed',
  }

  private alive = true

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: formatAppError(error) }
  }

  override componentWillUnmount(): void {
    this.alive = false
  }

  private show(situation: Situation): void {
    if (this.alive) this.setState({ situation })
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
     *
     * AND THE QUESTION HAS THREE ANSWERS, NOT TWO (POD-2762). The third is
     * silence, and silence used to be filed under "no". A server mid-handover
     * cannot say whether it replaced anything, because it is not running — so a
     * page that clicked Settings two seconds before a restart got the crash
     * screen for a condition that resolves itself. Silence now means WAIT: the
     * screen says the server is restarting, the page keeps asking, and what it
     * says next depends on what comes back. A server that returns with different
     * bytes lands on the reload offer after all; one that returns with the same
     * bytes leaves this page needing nothing but a reload to finish what it was
     * doing.
     */
    if (!looksLikeChunkLoadFailure(message)) return
    const probe = this.props.probeAssets ?? askTheServer
    const waitFor = this.props.waitForServer ?? waitForServerAnswer
    void probe()
      .then(async (answer) => {
        if (!this.alive) return
        if (answer === 'replaced') {
          this.show('assets-replaced')
          return
        }
        // `ok` and `unknown` are a server with an opinion, and its opinion is
        // that nothing has moved. That leaves a genuine fault, and the honest
        // crash page is the right screen for it.
        if (answer !== 'unreachable') return
        this.show('server-restarting')
        const returned = await waitFor(
          {
            askServer: probe,
            wait: (ms) => new Promise((resolve) => void window.setTimeout(resolve, ms)),
            now: () => Date.now(),
            importUrl: () => Promise.reject(new Error('not used by the boundary')),
          },
          patienceFor({}),
        )
        if (!this.alive) return
        // GAVE UP IS NOT A NEW CLAIM. If the server never came back, this page
        // knows nothing it did not know at the start, so it falls back to the
        // honest crash page rather than inventing a diagnosis.
        if (returned === 'gave-up') this.show('crashed')
        else if (returned === 'replaced') this.show('assets-replaced')
        else this.show('server-returned')
      })
      .catch(() => {
        // An unanswerable question leaves the honest crash page in place.
      })
  }

  override componentDidUpdate(prevProps: Readonly<{ resetKey: string }>): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.message) {
      this.setState({ message: null, situation: 'crashed' })
    }
  }

  override render(): ReactNode {
    if (!this.state.message) return this.props.children
    const { message, situation } = this.state

    /**
     * The server has confirmed it is serving a different build. Say THAT — an
     * app that moved, not an app that broke — and make the reload the point of
     * the screen rather than the recovery from a bug report.
     */
    if (situation === 'assets-replaced') {
      return (
        <AppErrorPage
          title={'Podium was updated.\nThis page is the old one.'}
          eyebrow="Interface / replaced"
          message={
            <>
              The server is now serving a different build of Podium, so part of this page could not
              be loaded.{' '}
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
          detail={`A code file this page asked for is no longer on the server: ${message}`}
        />
      )
    }

    /**
     * NOTHING IS WRONG YET. The server is not answering, which during an update
     * is the ordinary middle of a handover rather than a fault — so this screen
     * says what is happening and that it is being waited out, and it is the one
     * screen here that is `pending`: the trace breathes instead of alarming.
     *
     * The reload button is still present, because an escape hatch that vanishes
     * exactly when someone wants it is not a design. It is simply not the thing
     * being recommended: pressing it while the server is down produces a browser
     * error page, and the copy says so by saying the page is already handling it.
     */
    if (situation === 'server-restarting') {
      return (
        <AppErrorPage
          title={'Podium’s server is restarting.\nThis page is waiting for it.'}
          eyebrow="Interface / reconnecting"
          pending
          message={
            <>
              A part of the interface could not be fetched because the server is not answering —
              which is what an update looks like from in here.{' '}
              <strong style={{ fontWeight: 600, color: 'var(--text-strong, var(--foreground))' }}>
                Nothing has gone wrong and nothing has been lost
              </strong>
              . This page keeps asking, and will say when the server is back.
            </>
          }
          trace={{ from: 'this page', to: 'the server' }}
          fields={[
            { label: 'Agents', value: 'still running' },
            { label: 'Your work', value: 'safe on the host' },
            { label: 'The server', value: 'not answering yet' },
          ]}
          reassurance="Reconnecting automatically — no need to press anything."
          detail={`A code file this page asked for could not be fetched: ${message}`}
        />
      )
    }

    /**
     * It came back, and it is serving the same build it always was — so this
     * page is not stale, it is merely INCOMPLETE: the one thing it went to fetch
     * never arrived, and the browser will not re-fetch a URL it has already
     * recorded as failed. One reload finishes what the click started.
     */
    if (situation === 'server-returned') {
      return (
        <AppErrorPage
          title={'Podium’s server is back.\nThis page needs one reload.'}
          eyebrow="Interface / reconnected"
          message={
            <>
              The server is answering again and is serving the same build this page is running.{' '}
              <strong style={{ fontWeight: 600, color: 'var(--text-strong, var(--foreground))' }}>
                Nothing has gone wrong and nothing has been lost
              </strong>{' '}
              — the part that failed to load while the server was away cannot be retried in place,
              so reload to pick it up.
            </>
          }
          trace={{ from: 'this page', to: 'the server' }}
          fields={[
            { label: 'Agents', value: 'still running' },
            { label: 'Your work', value: 'safe on the host' },
            { label: 'The server', value: 'answering again' },
          ]}
          detail={`A code file this page asked for could not be fetched while the server was away: ${message}`}
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
        detail={`The Podium interface hit an error while rendering: ${message}`}
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
}

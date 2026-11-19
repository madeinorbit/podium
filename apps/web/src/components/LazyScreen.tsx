import {
  Component,
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
} from 'react'
import { looksLikeChunkLoadFailure } from '@/app/chunk-load-failure'
import { retryOnOnline } from '@/app/preload-error-recovery'
import { retryChunkImport, throughRestarts } from '@/lib/chunk-recovery'
import { WaitingForServer } from './WaitingForServer'

type ScreenModule<Props extends object> = { default: ComponentType<Props> }
type ScreenLoader<Props extends object> = () => Promise<ScreenModule<Props>>

/** Keep code-fetch failures inside their screen; render bugs still reach the app boundary. */
class ScreenBoundary<Props extends object> extends Component<
  {
    load: ScreenLoader<Props>
    screen: LazyExoticComponent<ComponentType<Props>>
    screenProps: Props
  },
  {
    failure: { error: unknown } | null
    screen: LazyExoticComponent<ComponentType<Props>>
  }
> {
  override state = { failure: null as { error: unknown } | null, screen: this.props.screen }
  private cancelOnline?: () => void
  private attempts = 0

  static getDerivedStateFromError(error: unknown) {
    return { failure: { error } }
  }

  override componentDidCatch(error: unknown): void {
    if (looksLikeChunkLoadFailure(error instanceof Error ? error.message : String(error))) {
      this.cancelOnline = retryOnOnline(this.retry)
    }
  }

  override componentWillUnmount(): void {
    this.cancelOnline?.()
  }

  private retry = (): void => {
    const failure = this.state.failure
    if (!failure) return
    this.cancelOnline?.()
    const attempt = ++this.attempts
    // React.lazy remembers a rejection too. A new lazy type and a fresh native
    // module URL are both needed to recover without replacing the document.
    const screen = lazy(() => retryChunkImport(this.props.load, failure.error, attempt))
    this.setState({ failure: null, screen })
  }

  override render(): ReactNode {
    const { failure, screen: Screen } = this.state
    if (failure) {
      const { error } = failure
      if (!looksLikeChunkLoadFailure(error instanceof Error ? error.message : String(error))) {
        throw error
      }
      return (
        <div
          className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
          role="status"
          data-offline-screen
        >
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted-foreground">
            <p className="text-sm">This screen is not available offline.</p>
            <p className="text-sm">It will open when your connection returns.</p>
            <button type="button" className="text-sm underline" onClick={this.retry}>
              Try again
            </button>
          </div>
        </div>
      )
    }
    return (
      <Suspense fallback={<WaitingForServer className="flex min-h-0 min-w-0 flex-1" />}>
        <Screen {...this.props.screenProps} />
      </Suspense>
    )
  }
}

export function lazyScreen<Props extends object>(load: ScreenLoader<Props>): ComponentType<Props> {
  const screen = lazy(() => throughRestarts(load))
  return function LazyScreen(props: Props) {
    return <ScreenBoundary load={load} screen={screen} screenProps={props} />
  }
}

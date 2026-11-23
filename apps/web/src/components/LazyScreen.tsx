import {
  Component,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
  lazy as reactLazy,
} from 'react'
import { looksLikeChunkLoadFailure } from '@/app/chunk-load-failure'
import { retryOnOnline } from '@/app/preload-error-recovery'
import { retryChunkImport, throughRestarts } from '@/lib/chunk-recovery'
import { lazy } from '@/lib/lazy-surface'

type OfflineFrame<Props> = (content: ReactNode, props: Props) => ReactNode

/** Keep code-fetch failures inside their screen; render bugs still reach the app boundary. */
class ScreenBoundary<Module, Props extends object> extends Component<
  {
    load: () => Promise<Module>
    select: (module: Module) => ComponentType<Props>
    screen: LazyExoticComponent<ComponentType<Props>>
    screenProps: Props
    offlineFrame?: OfflineFrame<Props>
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
    // Both React.lazy and the native module map remember a rejection. Select
    // the named export AFTER recovery, including a cache-busted native import.
    const screen = reactLazy(() =>
      retryChunkImport(this.props.load, failure.error, attempt).then((module) => ({
        default: this.props.select(module),
      })),
    )
    this.setState({ failure: null, screen })
  }

  override render(): ReactNode {
    const { failure, screen: Screen } = this.state
    if (failure) {
      const { error } = failure
      if (!looksLikeChunkLoadFailure(error instanceof Error ? error.message : String(error))) {
        throw error
      }
      const content = (
        <div
          className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
          role="status"
          data-offline-screen
        >
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted-foreground">
            <p className="text-sm">This screen is not available offline.</p>
            <p className="text-sm">It will open when your connection returns.</p>
            <button data-pressable type="button" className="text-sm underline" onClick={this.retry}>
              Try again
            </button>
          </div>
        </div>
      )
      return this.props.offlineFrame?.(content, this.props.screenProps) ?? content
    }
    return <Screen {...this.props.screenProps} />
  }
}

export function lazyScreen<Module, Props extends object>(
  load: () => Promise<Module>,
  select: (module: Module) => ComponentType<Props>,
  offlineFrame?: OfflineFrame<Props>,
): ComponentType<Props> {
  const screen = lazy(() => throughRestarts(load).then((module) => ({ default: select(module) })))
  return function LazyScreen(props: Props) {
    return (
      <ScreenBoundary
        load={load}
        select={select}
        screen={screen}
        screenProps={props}
        offlineFrame={offlineFrame}
      />
    )
  }
}

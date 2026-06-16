import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { formatAppError } from './AppErrorPage'

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

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
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
        <main className="flex min-h-full items-center justify-center bg-background p-5">
          <section className="w-[min(520px,100%)] rounded-md border border-border bg-card p-5 text-card-foreground">
            <div className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">ERROR</div>
            <h1 className="my-2 text-[22px] font-medium text-foreground">Podium could not start</h1>
            <p className="m-0 [overflow-wrap:anywhere] text-muted-foreground">{this.state.message}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {this.props.onRetry && (
                <Button type="button" onClick={this.props.onRetry}>
                  Retry
                </Button>
              )}
            </div>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}

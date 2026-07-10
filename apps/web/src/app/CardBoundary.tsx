import { Component, type ErrorInfo, type ReactNode } from 'react'
import { formatAppError } from './AppErrorPage'

/**
 * A narrow error boundary for a single repeated item (a session / issue /
 * superagent card). A render throw from one malformed item degrades THAT card to a
 * compact inline notice instead of bubbling to the app-level ErrorBoundary and
 * blanking the whole UI with "Podium could not start". The failure is logged, never
 * silent. `resetKey` (typically the item's id) clears the error when the item
 * changes, so a transient bad value recovers on the next update.
 */
export class CardBoundary extends Component<
  { children: ReactNode; resetKey?: string; label?: string },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    console.warn(`[podium] ${this.props.label ?? 'card'} failed to render:`, formatAppError(error))
  }

  override componentDidUpdate(prev: Readonly<{ resetKey?: string }>): void {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="rounded-md border border-warning/40 bg-card px-3 py-2 text-[12px] text-muted-foreground">
          This item couldn’t be displayed.
        </div>
      )
    }
    return this.props.children
  }
}

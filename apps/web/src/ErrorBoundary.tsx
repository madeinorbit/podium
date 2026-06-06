import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AppErrorPage, formatAppError } from './AppErrorPage'

export class ErrorBoundary extends Component<
  {
    children: ReactNode
    resetKey: string
    onRetry?: () => void
    onChangeServer?: () => void
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
        <AppErrorPage
          message={this.state.message}
          onRetry={this.props.onRetry}
          onChangeServer={this.props.onChangeServer}
        />
      )
    }
    return this.props.children
  }
}

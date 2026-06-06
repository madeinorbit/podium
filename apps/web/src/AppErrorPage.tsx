import type { JSX } from 'react'

export function formatAppError(error: unknown, fallback = 'Something went wrong'): string {
  const message = rawErrorMessage(error)
  if (message?.includes('No procedure found on path "discovery.scanRepos"')) {
    return 'This relay server is running an older Podium backend that does not support repo discovery. Restart the relay from this branch, or connect to a matching relay server.'
  }
  return message ?? fallback
}

function rawErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return null
}

export function AppErrorPage({
  title = 'Podium could not start',
  message,
  onRetry,
  onChangeServer,
}: {
  title?: string
  message: string
  onRetry?: () => void
  onChangeServer?: () => void
}): JSX.Element {
  return (
    <main className="app-error-page">
      <section className="app-error-panel">
        <div className="label">ERROR</div>
        <h1>{title}</h1>
        <p>{message}</p>
        <div className="app-error-actions">
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          )}
          {onChangeServer && (
            <button type="button" className="secondary" onClick={onChangeServer}>
              Change server
            </button>
          )}
        </div>
      </section>
    </main>
  )
}

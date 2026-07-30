import type { JSX } from 'react'
import { Button } from '@/components/ui/button'

export function formatAppError(error: unknown, fallback = 'Something went wrong'): string {
  const message = rawErrorMessage(error)
  if (message?.includes('No procedure found on path "discovery.')) {
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
}: {
  title?: string
  message: string
  onRetry?: () => void
}): JSX.Element {
  return (
    <main className="flex min-h-full items-center justify-center bg-background p-5">
      <section className="w-[min(520px,100%)] rounded-md border border-border bg-card p-5">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">ERROR</div>
        <h1 className="my-2 text-[22px] font-medium text-foreground">{title}</h1>
        <p className="m-0 text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {onRetry && (
            <Button type="button" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      </section>
    </main>
  )
}

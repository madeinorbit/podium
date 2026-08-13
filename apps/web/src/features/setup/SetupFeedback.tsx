import { AlertCircle, LoaderCircle } from 'lucide-react'
import type { JSX, ReactNode } from 'react'

export function SetupError({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.07] px-3 py-2.5 text-xs leading-5 text-foreground"
    >
      <AlertCircle className="mt-0.5 size-4 flex-none text-destructive" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function SetupBusyOverlay({
  title,
  detail,
}: {
  title: string
  detail: string
}): JSX.Element {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-6 backdrop-blur-[2px]">
      <div
        role="status"
        aria-live="polite"
        className="flex max-w-sm items-center gap-3 rounded-xl border border-border-strong bg-popover px-4 py-3.5 shadow-lg"
      >
        <LoaderCircle className="size-5 flex-none animate-spin text-primary" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</p>
        </div>
      </div>
    </div>
  )
}

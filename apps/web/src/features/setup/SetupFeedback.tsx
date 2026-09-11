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
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 p-6">
      <div
        role="status"
        aria-live="polite"
        className="flex w-full max-w-[456px] items-start gap-[15px] rounded-[13px] bg-muted px-[22px] py-5 shadow-popover ring-1 ring-border-strong"
      >
        <LoaderCircle
          className="mt-0.5 size-[22px] flex-none animate-spin text-ring motion-reduce:animate-none"
          aria-hidden="true"
        />
        <div>
          <p className="text-[15px] leading-[1.2] font-semibold text-foreground">{title}</p>
          <p className="mt-[7px] text-[13px] leading-[1.55] text-muted-foreground">{detail}</p>
        </div>
      </div>
    </div>
  )
}

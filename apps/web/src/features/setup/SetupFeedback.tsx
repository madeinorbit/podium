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
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#15171b]/70 p-6">
      <div
        role="status"
        aria-live="polite"
        className="flex w-full max-w-[456px] items-start gap-[15px] rounded-[13px] bg-[#252a31] px-[22px] py-5 shadow-[0_30px_70px_-18px_rgba(0,0,0,.85),inset_0_0_0_1px_#3a4049]"
      >
        <LoaderCircle
          className="mt-0.5 size-[22px] flex-none animate-spin text-[#d9b477] motion-reduce:animate-none"
          aria-hidden="true"
        />
        <div>
          <p className="text-[15px] leading-[1.2] font-semibold text-[#f2f3f5]">{title}</p>
          <p className="mt-[7px] text-[13px] leading-[1.55] text-[#9ba1ab]">{detail}</p>
        </div>
      </div>
    </div>
  )
}

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { PodiumLogo } from '@/lib/icons/PodiumLogo'

const BUILD_STAMP_FILE = 'podium-build.json'

export interface AboutPodiumProps {
  open: boolean
  onClose: () => void
  httpOrigin?: string
}

/**
 * The macOS About Podium screen. Quiet, compact, and the same wordmark the
 * splash uses — version, one line of purpose, nothing else.
 */
export function AboutPodium({ open, onClose, httpOrigin }: AboutPodiumProps): JSX.Element {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const origin = httpOrigin ?? (typeof window === 'undefined' ? '' : window.location.origin)
    const stamp = `${origin.replace(/\/$/, '')}/${BUILD_STAMP_FILE}`
    void fetch(stamp)
      .then((response) => (response.ok ? response.json() : null))
      .then((raw: unknown) => {
        if (cancelled) return
        const value = raw && typeof raw === 'object' ? (raw as { appVersion?: unknown }) : null
        setVersion(typeof value?.appVersion === 'string' ? value.appVersion : 'dev')
      })
      .catch(() => {
        if (!cancelled) setVersion('dev')
      })
    return () => {
      cancelled = true
    }
  }, [httpOrigin, open])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        data-testid="about-podium"
        className="w-[min(22rem,calc(100vw-2rem))] sm:max-w-[22rem]"
        showCloseButton
      >
        <div className="flex flex-col items-center gap-4 px-2 pt-5 pb-2 text-center">
          <PodiumLogo height={22} />
          <DialogTitle className="sr-only">About Podium</DialogTitle>
          <p className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {version ?? '…'}
          </p>
          <DialogDescription className="max-w-[18rem] text-[12px] leading-[1.5]">
            Mission control for coding agents.
          </DialogDescription>
          <p className="text-[11px] text-muted-foreground">© {new Date().getFullYear()}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

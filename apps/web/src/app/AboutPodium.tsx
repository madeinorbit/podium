import type { JSX } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { PodiumLogo } from '@/lib/icons/PodiumLogo'
import { pageBuildVersion } from '@/lib/logging/build-version'

export interface AboutPodiumProps {
  open: boolean
  onClose: () => void
  /** Override for tests. Defaults to {@link pageBuildVersion}. */
  version?: string
}

/**
 * The macOS About Podium ADE screen. Quiet, compact, and the same wordmark the
 * splash uses — version, one line of purpose, nothing else.
 */
export function AboutPodium({ open, onClose, version }: AboutPodiumProps): JSX.Element {
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
          <DialogTitle className="sr-only">About Podium ADE</DialogTitle>
          <p className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {version ?? pageBuildVersion()}
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

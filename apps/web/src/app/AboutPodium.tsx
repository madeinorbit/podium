import type { JSX } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { PodiumMark } from '@/lib/icons/PodiumMark'
import { pageBuildVersion } from '@/lib/logging/build-version'

export interface AboutPodiumProps {
  open: boolean
  onClose: () => void
  /** Override for tests. Defaults to {@link pageBuildVersion}. */
  version?: string
}

/**
 * The macOS About Podium ADE screen. Quiet, compact, and built the way the
 * platform's own About panel is: the Dock icon, the product name, what it is,
 * then the facts.
 *
 * It shows the app MARK, not the wordmark — About's job is to confirm which
 * thing you are running, and the tile is the object the operator recognises
 * from the Dock and the ⌘-Tab switcher.
 *
 * Two lines under the name, and they are different jobs. "Agentic Development
 * Environment" is the shell's mono micro-label (WORK / FILES) doing what it
 * always does — naming the thing above it — and here it also spells out the
 * ADE in the name. "Ship more, better" is the slogan and gets the only ink at
 * body weight. Version and copyright sit below a hairline: facts, not
 * identity, and nothing in the identity block competes with them.
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
        <div className="flex flex-col items-center px-2 pt-6 pb-3 text-center">
          <PodiumMark size={72} />
          <DialogTitle className="shell-type-column-title mt-4 font-semibold text-text-strong">
            Podium ADE
          </DialogTitle>
          {/* The shell's mono micro-label, one ink tier up from `--label`: this
            line is content, not chrome, and #8f8d85 on Paper is 3.2:1. */}
          <DialogDescription className="shell-type-micro mt-1.5 font-mono font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Agentic Development Environment
          </DialogDescription>
          <p className="mt-4 text-[13px] leading-none font-medium text-foreground">
            Ship more, better
          </p>
          {/* The dialog's own ring, turned inward — `--hairline-soft` is one
            step off panel ink (#24272d on #23262d) and simply does not exist
            in the dark theme, which is the signature one. */}
          <div className="mt-5 w-full border-foreground/10 border-t pt-3">
            <p className="font-mono text-[11px] tabular-nums text-text-dim">
              {version ?? pageBuildVersion()}
            </p>
            <p className="mt-1 text-[11px] text-text-faint">© {new Date().getFullYear()}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

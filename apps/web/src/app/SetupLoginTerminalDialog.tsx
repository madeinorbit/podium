import type { SessionId } from '@podium/model'
import type { JSX } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AgentPanel } from '@/features/terminal/AgentPanel'

export function SetupLoginTerminalDialog({
  sessionId,
  onClose,
}: {
  sessionId: SessionId | null
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog
      open={sessionId !== null}
      onOpenChange={(open) => !open && onClose()}
      // NOT MODAL, ON PURPOSE (POD-1307). A native CLI login finishes OUTSIDE this
      // terminal: the harness hands its authorization URL to the browser shim, and
      // BrowserOpenOverlay answers with the confirm toast and the pending-login card
      // that takes the localhost callback paste-back. Both of those render in the app
      // tree and the toaster portal — i.e. outside this popup — and a modal Base UI
      // dialog marks every other body child `inert`, which no z-index can outrank. So
      // the one dialog whose whole job is a login was the one place the login handoff
      // could not be clicked. Non-modal keeps them live; the backdrop still shields the
      // wizard behind it.
      modal={false}
      // …and with modality off, an outside press is no longer the dialog's to consume:
      // clicking "Open" on the browser toast would otherwise dismiss the terminal the
      // user is signing in through. Closing stays on the X and Escape.
      disablePointerDismissal
    >
      <DialogContent className="flex h-[min(680px,calc(100dvh-2rem))] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]">
        <DialogHeader className="flex-none border-b border-border px-4 py-3 pr-12">
          <DialogTitle>Finish agent sign-in</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Complete sign-in here, then close this window. Setup stays right where you left it.
          </p>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {sessionId && <AgentPanel sessionId={sessionId} active showHeader={false} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

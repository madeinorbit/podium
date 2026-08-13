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
    <Dialog open={sessionId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(680px,calc(100dvh-2rem))] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]">
        <DialogHeader className="flex-none border-b border-border px-4 py-3 pr-12">
          <DialogTitle>Finish agent sign-in</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Complete sign-in here, then close this window. Setup stays right where you left it.
          </p>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {sessionId && <AgentPanel sessionId={sessionId} active />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

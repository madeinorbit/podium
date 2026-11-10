import { useClientRuntime } from '@podium/client-core/react'
import { observer } from '@podium/client-graph/react'
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useShellActions } from './shell-data'

/**
 * One-time opt-in shown the first time the user clicks Continue on an errored
 * agent. Either choice records `promptDismissed: true` so it never re-appears;
 * "Enable" also flips the global `autoContinue.enabled` switch on.
 */
export const AutoContinueDialog = observer(function AutoContinueDialog(): JSX.Element | null {
  const { setPreferences, closeAutoContinuePrompt } = useShellActions()
  const autoContinuePromptSessionId = useClientRuntime().autoContinueDialog.sessionId
  const [pendingAction, setPendingAction] = useState<'dismiss' | 'enable' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = pendingAction !== null
  const open = autoContinuePromptSessionId !== null

  const finish = async (enable: boolean) => {
    if (busy) return
    setPendingAction(enable ? 'enable' : 'dismiss')
    setError(null)
    try {
      // My settings record (POD-6673): queued, shown at once, on every device.
      // A dismissal leaves `enabled` as it is.
      await setPreferences({
        ...(enable ? { 'autoContinue.enabled': true } : {}),
        'autoContinue.promptDismissed': true,
      })
      closeAutoContinuePrompt()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save this preference. Try again.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  if (!open) return null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void finish(false)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Auto-continue when agents error?</DialogTitle>
          <DialogDescription>
            Podium just re-sent “continue”. Want it to do that automatically whenever an agent stops
            on a retryable error (rate limit, server error)? It retries on an increasing delay — up
            to 5 minutes between tries — until the agent recovers.
          </DialogDescription>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">
          Heads up: this can keep an agent running indefinitely and consuming tokens with no one
          watching. You can turn it off anytime in Settings → Agents.
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            pending={pendingAction === 'dismiss'}
            pendingLabel="Saving…"
            onClick={() => void finish(false)}
          >
            Not now
          </Button>
          <Button
            disabled={busy}
            pending={pendingAction === 'enable'}
            pendingLabel="Enabling…"
            onClick={() => void finish(true)}
          >
            Enable auto-continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

import { shallowEqual } from '@podium/client-core/store'
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
import { useStoreSelector } from './store'

/**
 * One-time opt-in shown the first time the user clicks Continue on an errored
 * agent. Either choice records `promptDismissed: true` so it never re-appears;
 * "Enable" also flips the global `autoContinue.enabled` switch on.
 */
export function AutoContinueDialog(): JSX.Element | null {
  const { trpc, autoContinuePromptSessionId, closeAutoContinuePrompt } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      autoContinuePromptSessionId: s.autoContinuePromptSessionId,
      closeAutoContinuePrompt: s.closeAutoContinuePrompt,
    }),
    shallowEqual,
  )
  const [busy, setBusy] = useState(false)
  const open = autoContinuePromptSessionId !== null

  const finish = async (enable: boolean) => {
    setBusy(true)
    try {
      const current = await trpc.settings.get.query()
      await trpc.settings.set.mutate({
        ...current,
        autoContinue: {
          enabled: enable ? true : current.autoContinue.enabled,
          promptDismissed: true,
        },
      })
    } catch {
      // Best-effort: a failed write just means the popup may show again later.
    }
    setBusy(false)
    closeAutoContinuePrompt()
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
          watching. You can turn it off anytime in Settings → New sessions.
        </p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void finish(false)}>
            Not now
          </Button>
          <Button disabled={busy} onClick={() => void finish(true)}>
            Enable auto-continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

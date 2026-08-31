import { Popover } from '@base-ui/react/popover'
import { Smartphone, X } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { DeferredMobileHandoffQr } from './DeferredMobileHandoffQr'
import { useFocusedHandoffSessionId, useHasFirstTask, useMobileHandoffUrl } from './mobile-handoff'

/**
 * "ON YOUR PHONE" — the status strip's right end (POD-1320, design 1a).
 *
 * It passes the strip's admission test the same way the update affordance does:
 * window-scoped, stated nowhere else, and a fact about this instance rather than
 * instruction — a phone is a device, like the host and the working count beside
 * it. It takes the slot the "⌘K commands" hint used to occupy, which failed
 * that test and was removed with POD-365.
 *
 * OPENS ON CLICK, NEVER HOVER. The strip lies under the pointer's travel all
 * day; a sheet that appears while you reach for the prompt well is a jump scare.
 * Click again, press Esc, or click anywhere outside to put it away — Base UI's
 * popover owns all three, so there is no dismissal logic here to get wrong.
 */
export function MobileHandoffChip(): JSX.Element | null {
  const trpc = useStoreSelector((s) => s.trpc)
  const httpOrigin = useStoreSelector((s) => s.httpOrigin)
  const sessionId = useFocusedHandoffSessionId()
  const url = useMobileHandoffUrl(trpc, httpOrigin, sessionId)
  const hasFirstTask = useHasFirstTask()
  const [open, setOpen] = useState(false)
  // Before the first task there is nothing on a phone to watch, so the chip
  // would be an ad in a status bar. Same gate as the sidebar card.
  if (!hasFirstTask || !url) return null
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="status-strip-phone"
        data-testid="mobile-handoff-chip"
        aria-label="On your phone"
      >
        <Smartphone aria-hidden="true" className="size-3" />
        On your phone
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="isolate z-50">
          <Popover.Popup
            className="mobile-handoff-sheet"
            data-testid="mobile-handoff-sheet"
            // A pointer-opened sheet leaves focus on the chip: pulling it onto
            // the × paints a keyboard focus ring nobody asked for, on the one
            // control you did not press. A keyboard-opened sheet still takes
            // focus, which is the whole point of opening it that way.
            initialFocus={(openType) => (openType === 'keyboard' ? undefined : false)}
          >
            <div className="mobile-handoff-sheet-head">
              <Popover.Title className="mobile-handoff-sheet-title">
                Open on your phone
              </Popover.Title>
              <Popover.Close className="mobile-handoff-sheet-close" aria-label="Close">
                <X aria-hidden="true" className="size-3.5" />
              </Popover.Close>
            </div>
            <div className="mobile-handoff-sheet-body">
              <DeferredMobileHandoffQr url={url} size={92} />
              <div className="mobile-handoff-sheet-copy">
                <p>Point your phone's camera at the code to carry on with your tasks there.</p>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

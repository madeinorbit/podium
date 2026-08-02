/**
 * The two shapes every properties row is built from: a labelled row, and the
 * full-width ghost button used as a `PropertyMenu` trigger. Split out of
 * issue-page-properties.tsx (POD-646) so the property stack, the relations
 * block and the sessions block can each be their own module without either
 * importing the others for chrome.
 */
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'

/** One labeled row in the properties sidebar: a fixed-width label + a value cell. */
export function PropertyRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="w-20 shrink-0 pt-1 text-[12px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** The full-width ghost button used as a PropertyMenu trigger (shows the current
 *  value; the whole cell is clickable). Forwards ref + injected props so Base UI's
 *  `DropdownMenuTrigger render={…}` can wire the open handler onto the button. */
export const TriggerButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof Button> & { testId?: string }
>(({ children, testId, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    size="sm"
    data-testid={testId}
    className="h-7 w-full justify-start gap-1.5 px-2 font-normal text-[13px]"
    {...props}
  >
    {children}
  </Button>
))
TriggerButton.displayName = 'TriggerButton'

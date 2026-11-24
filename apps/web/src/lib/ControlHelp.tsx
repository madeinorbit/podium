import { type ComponentProps, forwardRef, type ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** Disabled controls still explain their value and how to make a choice. */
export function ControlHelp({
  help,
  disabled = false,
  children,
}: {
  help: string
  disabled?: boolean
  children: ReactElement
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        {disabled ? (
          <TooltipTrigger render={<span className="inline-flex min-w-0" />}>
            {children}
          </TooltipTrigger>
        ) : (
          <TooltipTrigger render={children} />
        )}
        <TooltipContent side="top" className="max-w-[20rem] text-left">
          {help}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** For menus that merge their events and ref into a custom trigger. */
export const HelpButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<'button'> & { help: string }
>(function HelpButton({ help, ...props }, ref) {
  return (
    <ControlHelp help={help} disabled={props.disabled}>
      <button {...props} ref={ref} aria-description={help} />
    </ControlHelp>
  )
})

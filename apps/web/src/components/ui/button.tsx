import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // btn-primary-rim gives the fill a silhouette where it needs one (the
        // yellow primary on Superade's light paper, POD-372). It resolves to
        // --primary-rim, unset outside Superade and therefore transparent —
        // painting into the border the base class already reserves, so there is
        // no layout change in any preset. It is a plain unlayered rule in
        // index.css, not a `border-[…]` utility: the base class's
        // `border-transparent` is the same specificity and wins on source order.
        default: 'btn-primary-rim bg-primary text-primary-foreground hover:bg-primary/80',
        outline:
          'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-8',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  pending = false,
  pendingLabel,
  children,
  disabled,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Locks the action, exposes its busy state, and swaps in a width-stable label. */
    pending?: boolean
    pendingLabel?: ReactNode
  }) {
  return (
    <ButtonPrimitive
      {...props}
      data-slot="button"
      data-pressable
      data-pending={pending || undefined}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className={cn(buttonVariants({ variant, size, className }))}
    >
      {pendingLabel !== undefined ? (
        <span className="inline-grid items-center justify-items-center">
          <span
            aria-hidden={pending || undefined}
            className={cn(
              'col-start-1 row-start-1 inline-flex items-center gap-inherit',
              pending && 'invisible',
            )}
          >
            {children}
          </span>
          <span
            aria-hidden={!pending || undefined}
            className={cn(
              'col-start-1 row-start-1 inline-flex items-center gap-1.5',
              !pending && 'invisible',
            )}
          >
            <span className="spb" aria-hidden="true" />
            {pendingLabel}
          </span>
        </span>
      ) : pending ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="spb" aria-hidden="true" />
          Working…
        </span>
      ) : (
        children
      )}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }

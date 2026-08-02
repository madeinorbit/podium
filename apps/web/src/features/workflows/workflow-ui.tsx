/**
 * The primitives every workflow subcomponent shares (POD-647): the empty state,
 * the labelled field, the status pill class, and the ONE button that dispatches
 * a command contract.
 *
 * `CommandButton` is where the write path and the rights predicate meet. It
 * takes a `WorkflowCommand` from `workflow-commands.ts` rather than a callback,
 * so an affordance cannot exist without an entry in that table — which is what
 * makes "what does this surface write, and what does each write require"
 * answerable by reading the table instead of the JSX.
 */
import type { ComponentProps, JSX, ReactElement } from 'react'
import { cloneElement, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { WorkflowCommand, WorkflowRights } from './workflow-commands'

export function Empty({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function statusClass(status: string): string {
  if (status === 'complete') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'blocked') return 'bg-destructive/10 text-destructive'
  if (status === 'active') return 'bg-primary/10 text-primary'
  return 'bg-muted text-muted-foreground'
}

export function Field({
  label,
  children,
}: {
  label: string
  children: ReactElement<{ id?: string }>
}): JSX.Element {
  const id = useId()
  return (
    <div className="block text-xs font-medium">
      <label htmlFor={id} className="mb-1.5 block text-muted-foreground">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  )
}

export type Dispatch = <TInput>(
  command: WorkflowCommand<TInput>,
  input: TInput,
) => Promise<boolean>

/**
 * Dispatch one command contract on click.
 *
 * NOT OFFERED IS NOT THE SAME AS NOT RIGHT NOW. `command.enabledBy(rights)`
 * decides whether the affordance exists at all; `disabled` is the state-machine
 * or form answer ("no step to skip", "name is empty"). Keeping them apart is
 * what stops "you may not" and "not yet" from rendering as the same greyed
 * button.
 *
 * The in-flight lock is a re-entrancy guard, not a retry: a denial resolves the
 * promise and releases the lock without re-sending.
 */
export function CommandButton<TInput>({
  command,
  input,
  rights,
  dispatch,
  disabled,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, 'onClick' | 'children'> & {
  command: WorkflowCommand<TInput>
  input: () => TInput
  rights: WorkflowRights
  dispatch: Dispatch
  children?: React.ReactNode
}): JSX.Element | null {
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  if (!command.enabledBy(rights)) return null
  const invoke = async (): Promise<void> => {
    if (lock.current) return
    lock.current = true
    setPending(true)
    try {
      await dispatch(command, input())
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  return (
    <Button
      {...props}
      aria-describedby="workflow-action-feedback"
      data-command={command.id}
      disabled={disabled}
      pending={pending}
      pendingLabel={command.pendingLabel}
      onClick={() => void invoke()}
    >
      {children ?? command.label}
    </Button>
  )
}

/**
 * An entity the principal cannot see behind, rendered as what it is: an OPAQUE
 * REFERENCE. Not a spinner (§3.1.2's loading-forever defect) and not a
 * strikethrough (rendering not-visible as removed, which the scoped feed makes a
 * lie). The id shows because the id is the part that is real.
 */
export function OpaqueReference({ id, kind }: { id: string; kind: string }): JSX.Element {
  return (
    <span
      data-opaque-reference={id}
      title="You do not have access to this item."
      className={cn(
        'rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground',
      )}
    >
      {kind} {id} · no access
    </span>
  )
}

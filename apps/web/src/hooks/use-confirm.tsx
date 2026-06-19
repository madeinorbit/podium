import type { JSX, ReactNode } from 'react'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export interface ConfirmOptions {
  title: string
  /** Body text — the "why are you being asked" line. */
  description?: string
  /** Confirm-button label (e.g. "Close anyway"). Default "Confirm". */
  confirmLabel?: string
  /** Cancel-button label. Default "Cancel". */
  cancelLabel?: string
  /** Style the confirm button as a destructive action (red). Default true —
   *  the guard fronts a kill/archive, which are destructive. */
  destructive?: boolean
}

/** Imperative confirm: resolves true on confirm, false on cancel/dismiss. One
 *  shared dialog instance backs every call site (see ConfirmProvider). */
export type Confirm = (options: ConfirmOptions) => Promise<boolean>

const Ctx = createContext<Confirm | null>(null)

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

/**
 * Provides a single app-wide confirmation dialog driven imperatively via
 * `useConfirm()`. Every kill/archive guard (#115) routes through this one
 * instance rather than each call site rendering its own AlertDialog, so the
 * copy and behaviour stay consistent.
 */
export function ConfirmProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  // The promise resolver for the open dialog; settled exactly once, then cleared
  // so a backdrop-dismiss after a button click can't double-resolve.
  const settleRef = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback<Confirm>((options) => {
    return new Promise<boolean>((resolve) => {
      settleRef.current = resolve
      setPending({ ...options, resolve })
    })
  }, [])

  const settle = (ok: boolean) => {
    const resolve = settleRef.current
    settleRef.current = null
    setPending(null)
    resolve?.(ok)
  }

  const open = pending !== null

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <AlertDialog
        open={open}
        // Closing via Escape / backdrop / a Close button resolves false unless a
        // button already settled it (settleRef cleared).
        onOpenChange={(next) => {
          if (!next && settleRef.current) settle(false)
        }}
      >
        {pending && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{pending.title}</AlertDialogTitle>
              {pending.description && (
                <AlertDialogDescription>{pending.description}</AlertDialogDescription>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => settle(false)}>
                {pending.cancelLabel ?? 'Cancel'}
              </AlertDialogCancel>
              <AlertDialogAction
                variant={pending.destructive === false ? 'default' : 'destructive'}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? 'Confirm'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </Ctx.Provider>
  )
}

export function useConfirm(): Confirm {
  const confirm = useContext(Ctx)
  if (!confirm) throw new Error('useConfirm outside ConfirmProvider')
  return confirm
}

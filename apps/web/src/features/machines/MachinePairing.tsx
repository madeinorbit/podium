import type { MachineWire } from '@podium/model'
import { CheckCircle2, ChevronDown } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface MachinePairingProps {
  pairingCode: string | null
  joinCommand: string | null
  publicUrl?: string | null
  loading: boolean
  error: string | null
  podiumManaged: boolean
  recommendServer: boolean
  makeServerAfterPair: boolean
  newMachine: Pick<MachineWire, 'id' | 'name'> | null
  onManagedChange: (managed: boolean) => void
  onMakeServerAfterPairChange: (value: boolean) => void
  onChangeUrl?: () => void
  onReviewPairedMachine: () => void
  /** Guided VPS copy and hierarchy; the generic Settings surface keeps its full controls. */
  variant?: 'default' | 'vps'
}

/**
 * Route-neutral pairing presentation. Protocol calls and live machine detection stay in
 * the caller's controller; Settings and onboarding can render the same waiting, error,
 * command, and paired-for-review states inside their own shells.
 */
export function MachinePairing(props: MachinePairingProps): JSX.Element {
  const hasDetails = props.pairingCode !== null
  const guidedVps = props.variant === 'vps'

  return (
    <div className="min-w-0 space-y-3">
      {props.error && (
        <div
          className={cn(
            'rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2',
            guidedVps && 'rounded-[11px] px-4 py-3',
          )}
          role="alert"
        >
          <p className={cn('settings-label text-destructive', guidedVps && 'text-[13.5px]')}>
            Could not create a pairing command
          </p>
          <p className={cn('settings-prose mt-1', guidedVps && 'text-[13px] leading-[1.5]')}>
            {props.error}
          </p>
        </div>
      )}
      {props.loading && !hasDetails && (
        <div
          className={cn(
            'rounded-md border border-border bg-muted/30 px-3 py-2',
            guidedVps &&
              'rounded-[11px] border-0 bg-[#1b1e24] px-4 py-3 shadow-[inset_0_0_0_1px_#2f343d]',
          )}
          role="status"
          aria-live="polite"
        >
          <p className={cn('settings-label', guidedVps && 'text-[13.5px] text-[#f2f3f5]')}>
            {guidedVps ? 'Generating a secure VPS command…' : 'Generating pairing code…'}
          </p>
          <p className={cn('settings-prose mt-1', guidedVps && 'text-[13px] text-[#9ba1ab]')}>
            Preparing a secure, one-use command for the other machine.
          </p>
        </div>
      )}
      {props.pairingCode && !props.joinCommand && !props.loading && (
        <div
          className={cn(
            'rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2',
            guidedVps &&
              'rounded-[12px] border-0 bg-[#2a251a] px-5 py-4 shadow-[inset_0_0_0_1px_#594a25]',
          )}
          role="status"
        >
          <p className={cn('settings-label', guidedVps && 'text-[14px] text-[#f2f3f5]')}>
            {guidedVps ? 'Connect this Podium to the VPS first' : 'Server URL needed'}
          </p>
          <p
            className={cn(
              'settings-prose mt-1',
              guidedVps && 'max-w-[650px] text-[13.5px] leading-[1.5] text-[#b9bec6]',
            )}
          >
            {guidedVps
              ? 'The current transfer method needs one temporary address that the VPS can reach. After it connects, you review moving the shared Podium server there.'
              : 'Finish network setup to get a one-line join command.'}
          </p>
          {props.onChangeUrl && (
            <Button
              type="button"
              variant={guidedVps ? 'ghost' : 'outline'}
              size="sm"
              className={cn(
                'mt-2',
                guidedVps &&
                  '-ml-2 h-8 px-2 text-[13px] font-semibold text-[#d9b477] hover:bg-[#d9b477]/10 hover:text-[#e8ca97]',
              )}
              onClick={props.onChangeUrl}
            >
              {guidedVps ? 'Set up the connection' : 'Set server URL'}
            </Button>
          )}
        </div>
      )}
      {props.pairingCode && (
        <PairingCodeDisplay
          code={props.pairingCode}
          joinCommand={props.joinCommand}
          publicUrl={props.publicUrl}
          onChangeUrl={props.onChangeUrl}
          podiumManaged={props.podiumManaged}
          onManagedChange={props.onManagedChange}
          recommendServer={props.recommendServer}
          makeServerAfterPair={props.makeServerAfterPair}
          onMakeServerAfterPairChange={props.onMakeServerAfterPairChange}
          pairedMachine={props.newMachine}
          onReviewPairedMachine={props.onReviewPairedMachine}
          busy={props.loading}
          variant={props.variant}
        />
      )}
    </div>
  )
}

export interface PairingCodeDisplayProps {
  code: string
  joinCommand: string | null
  publicUrl?: string | null
  onChangeUrl?: () => void
  podiumManaged: boolean
  onManagedChange: (managed: boolean) => void
  recommendServer: boolean
  makeServerAfterPair: boolean
  onMakeServerAfterPairChange: (value: boolean) => void
  pairedMachine: Pick<MachineWire, 'id' | 'name'> | null
  onReviewPairedMachine: () => void
  busy?: boolean
  variant?: 'default' | 'vps'
}

/** Pairing details shared by shells that present their own loading and error treatment. */
export function PairingCodeDisplay({
  code,
  joinCommand,
  publicUrl,
  onChangeUrl,
  podiumManaged,
  onManagedChange,
  recommendServer,
  makeServerAfterPair,
  onMakeServerAfterPairChange,
  pairedMachine,
  onReviewPairedMachine,
  busy = false,
  variant = 'default',
}: PairingCodeDisplayProps): JSX.Element {
  const [copyFeedback, setCopyFeedback] = useState<'copied' | 'failed' | null>(null)
  const copyAttempt = useRef(0)
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    copyAttempt.current += 1
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current)
    copyFeedbackTimer.current = null
    setCopyFeedback(null)

    return () => {
      copyAttempt.current += 1
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current)
    }
  }, [code, joinCommand])

  const copy = (): void => {
    if (!joinCommand) return
    const attempt = ++copyAttempt.current
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current)
    copyFeedbackTimer.current = null
    setCopyFeedback(null)

    const clipboard = navigator.clipboard
    if (!clipboard) {
      setCopyFeedback('failed')
      return
    }

    try {
      void clipboard.writeText(joinCommand).then(
        () => {
          if (attempt !== copyAttempt.current) return
          setCopyFeedback('copied')
          copyFeedbackTimer.current = setTimeout(() => {
            if (attempt === copyAttempt.current) setCopyFeedback(null)
            copyFeedbackTimer.current = null
          }, 2_000)
        },
        () => {
          if (attempt === copyAttempt.current) setCopyFeedback('failed')
        },
      )
    } catch {
      if (attempt === copyAttempt.current) setCopyFeedback('failed')
    }
  }

  const guidedVps = variant === 'vps'

  return (
    <div
      className={cn('min-w-0 space-y-3', guidedVps && 'space-y-5')}
      aria-busy={busy || undefined}
    >
      {publicUrl && (
        <div className="flex flex-col gap-1">
          <span
            className={cn(
              'settings-micro uppercase tracking-wide',
              guidedVps && 'font-mono text-[10px] tracking-[0.16em] text-[#8a9099]',
            )}
          >
            {guidedVps ? 'Connection address' : 'Server URL this code points at'}
          </span>
          <div className="flex items-start gap-2">
            <code
              className={cn(
                'min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-[13px]',
                guidedVps &&
                  'rounded-[10px] bg-[#1b1e24] px-3 py-2 text-[#d7dae0] shadow-[inset_0_0_0_1px_#2f343d]',
              )}
            >
              {publicUrl}
            </code>
            {onChangeUrl && (
              <Button
                type="button"
                variant={guidedVps ? 'ghost' : 'outline'}
                size="sm"
                className={cn(
                  'flex-none',
                  guidedVps && 'text-[#d9b477] hover:bg-[#d9b477]/10 hover:text-[#e8ca97]',
                )}
                onClick={onChangeUrl}
              >
                Change…
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <span
          className={cn(
            'settings-micro uppercase tracking-wide',
            guidedVps && 'font-mono text-[10px] tracking-[0.16em] text-[#8a9099]',
          )}
        >
          {guidedVps ? 'Secure pairing code' : 'Pairing code'}
        </span>
        <code
          className={cn(
            'block rounded bg-muted px-2 py-1 font-mono text-[13.5px] tracking-widest',
            guidedVps &&
              'rounded-[10px] bg-[#1b1e24] px-4 py-3 text-[15px] text-[#f2f3f5] shadow-[inset_0_0_0_1px_#2f343d]',
          )}
        >
          {code}
        </code>
      </div>
      {guidedVps ? (
        <div className="overflow-hidden rounded-[12px] bg-[#1b1e24] shadow-[inset_0_0_0_1px_#2f343d]">
          <div className="flex gap-3 px-4 py-4">
            <CheckCircle2
              size={18}
              className="mt-0.5 flex-none text-[#d9b477]"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-[13.5px] leading-[1.4] font-semibold text-[#f2f3f5]">
                Ready for an always-on Podium server
              </p>
              <p className="mt-1 text-[13px] leading-[1.55] text-[#9ba1ab]">
                Podium will manage its own tools on the VPS. After it connects, you review moving
                shared server state there; projects, running agents, and logins stay where they are.
              </p>
            </div>
          </div>
          <details className="group border-t border-[#2f343d]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[12.5px] font-semibold text-[#a8adb6] hover:text-[#f2f3f5] [&::-webkit-details-marker]:hidden">
              Advanced VPS options
              <ChevronDown
                size={16}
                className="transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="space-y-3 border-t border-[#2b2f37] px-4 py-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[#d9b477]"
                  checked={podiumManaged}
                  disabled={busy}
                  onChange={(event) => onManagedChange(event.currentTarget.checked)}
                />
                <span className="flex flex-col gap-1">
                  <span className="text-[13px] font-semibold text-[#e6e8ec]">
                    Let Podium manage agent tools on this VPS
                  </span>
                  <span className="text-[12.5px] leading-[1.5] text-[#8a9099]">
                    Keep this on unless you already install and update the supported agent CLIs on
                    this VPS yourself.
                  </span>
                </span>
              </label>
              {recommendServer && (
                <label className="flex items-start gap-3 border-t border-[#2b2f37] pt-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-[#d9b477]"
                    checked={makeServerAfterPair}
                    disabled={busy}
                    onChange={(event) => onMakeServerAfterPairChange(event.currentTarget.checked)}
                  />
                  <span className="flex flex-col gap-1">
                    <span className="text-[13px] font-semibold text-[#e6e8ec]">
                      Move the Podium server here after pairing
                    </span>
                    <span className="text-[12.5px] leading-[1.5] text-[#8a9099]">
                      Keep this on for an always-on setup. Turn it off only to use the VPS as an
                      agent worker while this machine remains the server.
                    </span>
                  </span>
                </label>
              )}
            </div>
          </details>
        </div>
      ) : (
        <>
          <label className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={podiumManaged}
              disabled={busy}
              onChange={(event) => onManagedChange(event.currentTarget.checked)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="settings-label">Podium-managed machine</span>
              <span className="settings-prose">
                When off, mark this machine as shared and keep native logins local.
              </span>
            </span>
          </label>
          {recommendServer && (
            <label className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-[12px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={makeServerAfterPair}
                disabled={busy}
                onChange={(event) => onMakeServerAfterPairChange(event.currentTarget.checked)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-foreground">Recommended: make this the server</span>
                <span className="text-[11px] text-muted-foreground">
                  If this is an always-on VPS, make it the server. Your current machine keeps its
                  agent sessions but stops hosting the shared Podium state.
                </span>
              </span>
            </label>
          )}
        </>
      )}
      {pairedMachine && (
        <div
          className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-2.5 py-2 text-[12px]"
          role="status"
          aria-live="polite"
        >
          <span className="min-w-0 flex-1 text-muted-foreground">
            <strong className="text-foreground">{pairedMachine.name}</strong> is paired, and the
            server reports it is ready for transfer review.
          </span>
          <Button
            type="button"
            size="sm"
            className="flex-none"
            disabled={busy}
            onClick={onReviewPairedMachine}
          >
            Review transfer
          </Button>
        </div>
      )}
      <div className={cn('flex flex-col gap-1.5', guidedVps && 'gap-2')}>
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'settings-micro uppercase tracking-wide',
              guidedVps && 'font-mono text-[10px] tracking-[0.16em] text-[#8a9099]',
            )}
          >
            {guidedVps ? 'Command to run on the VPS' : 'Command to run on the other machine'}
          </span>
          {joinCommand && (
            <Button
              type="button"
              size="sm"
              className={cn(
                'flex-none',
                guidedVps && 'bg-[#d9b477] text-[#191308] hover:bg-[#e8ca97]',
              )}
              disabled={busy}
              onClick={copy}
            >
              {copyFeedback === 'copied'
                ? 'Copied'
                : copyFeedback === 'failed'
                  ? 'Try copy again'
                  : 'Copy command'}
            </Button>
          )}
        </div>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {copyFeedback === 'copied'
            ? 'Command copied to clipboard.'
            : copyFeedback === 'failed'
              ? 'Could not copy command. Select and copy it manually.'
              : ''}
        </span>
        {joinCommand ? (
          <code
            className={cn(
              'block max-w-full overflow-x-auto whitespace-nowrap rounded-md border bg-muted px-2.5 py-2 font-mono text-[12px] leading-relaxed text-muted-foreground [scrollbar-width:thin]',
              guidedVps &&
                'rounded-[10px] border-0 bg-[#1b1e24] px-4 py-3 text-[12.5px] text-[#d7dae0] shadow-[inset_0_0_0_1px_#2f343d]',
            )}
            title={joinCommand}
          >
            {joinCommand}
          </code>
        ) : (
          <p className={cn('settings-prose', guidedVps && 'text-[13px] text-[#8a9099]')}>
            {guidedVps
              ? 'Available after this Podium has a connection address the VPS can reach.'
              : 'Finish setup to get a one-line join command.'}
          </p>
        )}
      </div>
      <p className={cn('settings-micro', guidedVps && 'text-[12px] text-[#6f757f]')}>
        {guidedVps
          ? 'The command expires after one use or 1 hour.'
          : 'The code expires after one use or 1 hour.'}
      </p>
    </div>
  )
}

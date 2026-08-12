import type { MachineWire } from '@podium/model'
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

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
}

/**
 * Route-neutral pairing presentation. Protocol calls and live machine detection stay in
 * the caller's controller; Settings and onboarding can render the same waiting, error,
 * command, and paired-for-review states inside their own shells.
 */
export function MachinePairing(props: MachinePairingProps): JSX.Element {
  const hasDetails = props.pairingCode !== null

  return (
    <div className="min-w-0 space-y-3">
      {props.error && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
          role="alert"
        >
          <p className="settings-label text-destructive">Could not create a pairing command</p>
          <p className="settings-prose mt-1">{props.error}</p>
        </div>
      )}
      {props.loading && !hasDetails && (
        <div
          className="rounded-md border border-border bg-muted/30 px-3 py-2"
          role="status"
          aria-live="polite"
        >
          <p className="settings-label">Generating pairing code…</p>
          <p className="settings-prose mt-1">
            Preparing a secure, one-use command for the other machine.
          </p>
        </div>
      )}
      {props.pairingCode && !props.joinCommand && !props.loading && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2" role="status">
          <p className="settings-label">Server URL needed</p>
          <p className="settings-prose mt-1">
            Finish network setup to get a one-line join command.
          </p>
          {props.onChangeUrl && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={props.onChangeUrl}
            >
              Set server URL
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
}: PairingCodeDisplayProps): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    if (!joinCommand) return
    void navigator.clipboard.writeText(joinCommand).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    })
  }

  return (
    <div className="min-w-0 space-y-3" aria-busy={busy || undefined}>
      {publicUrl && (
        <div className="flex flex-col gap-1">
          <span className="settings-micro uppercase tracking-wide">
            Server URL this code points at
          </span>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-[13px]">
              {publicUrl}
            </code>
            {onChangeUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-none"
                onClick={onChangeUrl}
              >
                Change…
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className="settings-micro uppercase tracking-wide">Pairing code</span>
        <code className="block rounded bg-muted px-2 py-1 font-mono text-[13.5px] tracking-widest">
          {code}
        </code>
      </div>
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
              If this is an always-on VPS, make it the server. Your current machine keeps its agent
              sessions but stops hosting the shared Podium state.
            </span>
          </span>
        </label>
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
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="settings-micro uppercase tracking-wide">
            Command to run on the other machine
          </span>
          {joinCommand && (
            <Button type="button" size="sm" className="flex-none" disabled={busy} onClick={copy}>
              {copied ? 'Copied' : 'Copy command'}
            </Button>
          )}
        </div>
        {joinCommand ? (
          <code
            className="block max-w-full overflow-x-auto whitespace-nowrap rounded-md border bg-muted px-2.5 py-2 font-mono text-[12px] leading-relaxed text-muted-foreground [scrollbar-width:thin]"
            title={joinCommand}
          >
            {joinCommand}
          </code>
        ) : (
          <p className="settings-prose">Finish setup to get a one-line join command.</p>
        )}
      </div>
      <p className="settings-micro">The code expires after one use or 1 hour.</p>
    </div>
  )
}

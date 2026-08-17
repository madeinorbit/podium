// This app-level surface composes settings, setup, and machine capabilities.

import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import { asMachineId } from '@podium/model'
import type { MachineWire, UpdateChannel } from '@podium/model/browser'
import { ChevronLeft } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Store, useStoreSelector } from '@/app/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useMachinePairing } from '@/features/machines/machine-pairing'
import {
  SERVER_TRANSFER_CONFIRMATION,
  type ServerTransferDisplayState,
  type ServerTransferStatusController,
  type ServerTransferStatusSnapshot,
  transferDisplayState,
  transferErrorMessage,
  useServerTransfer,
  useServerTransferStatus,
} from '@/features/machines/server-transfer'
import { sourceUnavailableProse } from '@/features/settings/sections/updates-view'
import { NetworkStep } from '@/features/setup/network-step'
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { machineNeedsUpdate, useServerAppVersion } from '@/lib/version-skew'

const SERVER_TRANSFER_PHASES = [
  { key: 'preparing', label: 'Preparing' },
  { key: 'copying', label: 'Copying' },
  { key: 'validating', label: 'Validating' },
  { key: 'switching', label: 'Switching' },
  { key: 'connected', label: 'Connected' },
] as const

function transferPhaseIndex(state: ServerTransferDisplayState): number {
  return SERVER_TRANSFER_PHASES.findIndex((phase) => phase.key === state)
}

/**
 * The progress vocabulary is intentionally UI-sized rather than a restatement of
 * every journal vertex. In particular, source-fenced/committing both render as
 * Switching and only a proof-backed committed status renders Connected.
 */
export function ServerTransferProgress({
  state,
  targetName,
  detail,
}: {
  state: ServerTransferDisplayState
  targetName: string
  detail?: string
}): JSX.Element {
  const current = transferPhaseIndex(state)

  if (state === 'commit-uncertain') {
    return (
      <div
        className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2"
        role="alert"
      >
        <p className="settings-label text-warning!">Connection could not be confirmed</p>
        <p className="settings-prose">
          {detail ??
            `${targetName} may already be serving. Keep the old server stopped, check the target, and do not retry the transfer.`}
        </p>
      </div>
    )
  }

  if (state === 'aborted') {
    return (
      <div className="space-y-1 rounded-md border border-destructive/30 px-3 py-2" role="alert">
        <p className="settings-label text-destructive!">Transfer stopped safely</p>
        <p className="settings-prose">
          {detail ??
            `The current server is still active. Resolve the reported problem before trying ${targetName} again.`}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <ol
        className="grid grid-cols-5 gap-1"
        aria-label={`Server transfer progress for ${targetName}`}
      >
        {SERVER_TRANSFER_PHASES.map((phase, index) => {
          const complete = index < current || state === 'connected'
          const active = index === current
          return (
            <li
              key={phase.key}
              className={cn(
                'rounded border px-1.5 py-2 text-center text-[11px]',
                complete && 'border-success/30 bg-success/5 text-foreground',
                active && state !== 'connected' && 'border-primary/40 bg-primary/5 text-foreground',
                !complete && !active && 'border-border text-muted-foreground',
              )}
              aria-current={active ? 'step' : undefined}
              data-transfer-phase={phase.key}
              data-transfer-state={complete ? 'complete' : active ? 'active' : 'pending'}
            >
              {phase.label}
            </li>
          )
        })}
      </ol>
      <p className="settings-prose">
        {state === 'connected'
          ? `${targetName} proved it is serving and the previous server reconnected as a daemon.`
          : `${SERVER_TRANSFER_PHASES[current]?.label ?? 'Preparing'} server transfer…`}
      </p>
    </div>
  )
}

export type { ServerTransferStatusSnapshot }
export { SERVER_TRANSFER_CONFIRMATION }

/** One machine's server-side convergence, as the fleet read model reports it. */
export interface MachineConvergence {
  state: ConvergenceRowState
  detail?: string
}

const CONVERGENCE_POLL_MS = 1_000

/**
 * Convergence for every row, owned by the panel rather than the row.
 *
 * It is read from the server, so a row shows its progress no matter who started
 * the update — this row's Apply, the global update dialog, or a wave that was
 * already running before this page loaded. One read on mount answers "is
 * anything converging right now?"; polling continues only while something is.
 */
function useFleetConvergence(trpc: Store['trpc']): {
  rows: ReadonlyMap<string, MachineConvergence>
  refresh: () => void
} {
  const [rows, setRows] = useState<ReadonlyMap<string, MachineConvergence>>(() => new Map())
  const [nonce, setNonce] = useState(0)
  const active = [...rows.values()].some((row) => CONVERGENCE_IN_FLIGHT.has(row.state))

  useEffect(() => {
    let cancelled = false
    const read = async (): Promise<void> => {
      try {
        const fleet = await trpc.updates.fleet.query()
        if (cancelled) return
        const next = new Map<string, MachineConvergence>()
        for (const machine of fleet.allMachines ?? fleet.machines ?? []) {
          next.set(machine.id, {
            state: machine.state as ConvergenceRowState,
            ...(machine.detail ? { detail: machine.detail } : {}),
          })
        }
        setRows(next)
      } catch {
        // A failed fleet read is not a failed update. Keep the last snapshot.
      }
    }
    void read()
    if (!active) return
    const timer = window.setInterval(() => void read(), CONVERGENCE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, nonce, trpc])

  return { rows, refresh: () => setNonce((value) => value + 1) }
}

/**
 * Settings → Machines panel.
 * Lists registered machines with inline rename + revoke, and an "Add machine"
 * flow that mints a pairing code and shows the daemon command to run.
 */
export function MachinesPanel({
  showOwnershipTransfer = false,
}: {
  /** Dormant until multi-user machine ownership ships. */
  showOwnershipTransfer?: boolean
} = {}): JSX.Element {
  const { machines, trpc, setSettingsTab } = useStoreSelector(
    (s) => ({ machines: s.machines, trpc: s.trpc, setSettingsTab: s.setSettingsTab }),
    shallowEqual,
  )
  const [now, setNow] = useState(() => Date.now())
  const [addOpen, setAddOpen] = useState(false)
  const [recommendServer, setRecommendServer] = useState(false)
  const [makeServerAfterPair, setMakeServerAfterPair] = useState(false)
  const [serverTransferTarget, setServerTransferTarget] = useState<MachineWire | null>(null)

  // [spec:SP-3701] Hosting affordances (desktop shell, client mode only). A device that
  // paired before gets the inline "Enable" action on its own machine row; the standalone
  // card is for never-paired devices only.
  const hosting = useEnableHosting(trpc)
  const thisMachineId = nativeDesktopBridge()?.machineId
  const alreadyPaired = thisMachineId != null && machines.some((m) => m.id === thisMachineId)
  // Per-machine "Find repos" (POD-787): opens the scan flow preset to that machine.
  const [findReposFor, setFindReposFor] = useState<string | null>(null)

  // The server's own build version — the reference each daemon's reported version is
  // compared against for the "update available" badge [POD-838].
  const serverAppVersion = useServerAppVersion(trpc)
  const transferStatus = useServerTransferStatus(trpc)
  const transferTargetEligibility = new Map(
    transferStatus.snapshot?.targetEligibility.map((target) => [target.targetMachineId, target]) ??
      [],
  )
  const eligibleTransferTargets = new Set(
    [...transferTargetEligibility.values()]
      .filter((target) => target.eligible)
      .map((target) => target.targetMachineId),
  )
  const unsupportedTransferTargets = new Set(
    [...transferTargetEligibility.values()]
      .filter((target) => target.eligible === false && target.reason === 'unsupported')
      .map((target) => target.targetMachineId),
  )
  const pairing = useMachinePairing({
    trpc,
    machines,
    isNewMachineEligible: (machine) => eligibleTransferTargets.has(machine.id),
  })
  const activeTransferMachine =
    machines.find((machine) => machine.id === transferStatus.snapshot?.transfer?.targetMachineId) ??
    null
  const sourceMachine =
    machines.find((machine) => machine.id === transferStatus.snapshot?.sourceMachineId) ?? null
  const convergence = useFleetConvergence(trpc)
  const newlyPairedMachine = makeServerAfterPair ? pairing.newMachine : null

  // Tick so relative times stay fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const openAddMachine = (): void => {
    const shouldRecommendServer = machines.length === 1
    pairing.watchForNewMachine()
    setRecommendServer(shouldRecommendServer)
    setMakeServerAfterPair(shouldRecommendServer)
    setAddOpen(true)
    void pairing.mint()
  }

  // Jump to Settings → Network to change the server's reachable URL.
  const goChangeUrl = (): void => {
    setAddOpen(false)
    setSettingsTab('network')
  }

  const closeAddMachine = useCallback((): void => {
    setAddOpen(false)
    pairing.reset()
    setRecommendServer(false)
    setMakeServerAfterPair(false)
  }, [pairing.reset])

  return (
    <div className="py-3">
      {addOpen ? (
        // ONE LAYER: pairing is a sub-flow of the Settings sheet, so it takes the
        // sheet's own body and offers a way back rather than stacking a dialog on
        // a dialog. It also inherits the pane's scrolling, which is what a fixed,
        // centred popup could never do on a short window.
        <AddMachineFlow
          onBack={closeAddMachine}
          intro={
            pairing.pairingCode && !pairing.joinCommand && !pairing.loading
              ? 'This server needs a reachable URL before it can pair a machine — set that up here.'
              : 'Run the command below on the other machine. It installs the three supported agents and copies existing native logins from one of your online machines.'
          }
        >
          {pairing.error && (
            <p className="settings-prose text-destructive!" role="alert">
              {pairing.error}
            </p>
          )}
          {pairing.loading && (
            <p className="settings-prose flex items-center gap-2">
              <span className="spb" aria-hidden="true" />
              Generating pairing code…
            </p>
          )}
          {pairing.pairingCode && pairing.joinCommand && (
            <PairingCodeDisplay
              code={pairing.pairingCode}
              joinCommand={pairing.joinCommand}
              publicUrl={pairing.publicUrl}
              onChangeUrl={goChangeUrl}
              podiumManaged={pairing.podiumManaged}
              onManagedChange={(managed) => void pairing.mint({ podiumManaged: managed })}
              recommendServer={recommendServer}
              makeServerAfterPair={makeServerAfterPair}
              onMakeServerAfterPairChange={setMakeServerAfterPair}
              pairedMachine={newlyPairedMachine}
              onNewCode={() => void pairing.mint({ podiumManaged: pairing.podiumManaged })}
              minting={pairing.loading}
              onReviewPairedMachine={() => {
                if (newlyPairedMachine) {
                  closeAddMachine()
                  setServerTransferTarget(newlyPairedMachine)
                }
              }}
            />
          )}
          {pairing.pairingCode && !pairing.joinCommand && !pairing.loading && (
            // No publicUrl yet ⇒ the server can't build a join command. Let the user set up
            // reachability right here (same flow as the CLI / first-run setup), then re-mint —
            // which now returns a full one-line join command.
            <NetworkStep
              embedded
              trpc={trpc}
              onSaved={() => void pairing.mint({ podiumManaged: pairing.podiumManaged })}
            />
          )}
        </AddMachineFlow>
      ) : (
        <>
          {/* No wrap: the action belongs to the heading's line at every width —
              wrapped, it lands under the paragraph and reads as part of it. */}
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="settings-h">Machines</h3>
              <p className="settings-prose mt-1">
                Every machine running a Podium daemon that has paired with this server. Sessions
                from all machines appear together in your workspace.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="flex-none"
              onClick={openAddMachine}
            >
              Add machine
            </Button>
          </div>

          {hosting && !alreadyPaired && <HostThisDeviceCard hosting={hosting} />}

          {activeTransferMachine && !serverTransferTarget && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-hairline-soft bg-muted/20 p-3.5">
              <div className="min-w-0 flex-1">
                <ServerTransferProgress
                  state={
                    transferDisplayState(transferStatus.snapshot?.transfer ?? null) ?? 'preparing'
                  }
                  targetName={activeTransferMachine.name}
                  detail={transferErrorMessage(transferStatus.snapshot?.transfer ?? null)}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-none"
                onClick={() => setServerTransferTarget(activeTransferMachine)}
              >
                View transfer
              </Button>
            </div>
          )}

          {machines.length === 0 ? (
            <p className="settings-prose rounded-lg border border-hairline-soft bg-muted/20 p-3.5">
              No machines paired yet. Click "Add machine" to get started.
            </p>
          ) : (
            // The run, not a stack of cards: one hairline between machines, the
            // same list grammar Connected devices uses two tabs away.
            <div className="divide-y divide-border border-y border-border">
              {machines.map((m) => (
                <MachineRow
                  key={m.id}
                  machine={m}
                  now={now}
                  trpc={trpc}
                  isThisMachine={m.id === thisMachineId}
                  onTransferServer={
                    eligibleTransferTargets.has(m.id) ? () => setServerTransferTarget(m) : null
                  }
                  serverTransferUnsupported={unsupportedTransferTargets.has(m.id)}
                  showOwnershipTransfer={showOwnershipTransfer}
                  // Inline "Enable": only on this device's own row, only while it is offline
                  // (online means the daemon is already running) [spec:SP-3701].
                  hosting={m.id === thisMachineId && !m.online ? hosting : null}
                  onFindRepos={m.online ? () => setFindReposFor(m.id) : null}
                  serverAppVersion={serverAppVersion}
                  convergence={convergence.rows.get(m.id) ?? null}
                  onConvergenceChanged={convergence.refresh}
                />
              ))}
            </div>
          )}
        </>
      )}

      {serverTransferTarget && (
        <ServerTransferDialog
          machine={serverTransferTarget}
          sourceName={sourceMachine?.name ?? 'the current server'}
          status={transferStatus}
          trpc={trpc}
          open
          onOpenChange={(open) => {
            if (!open) setServerTransferTarget(null)
          }}
        />
      )}

      {findReposFor && (
        <RepoScanFlow
          initialMachineId={asMachineId(findReposFor)}
          onClose={() => setFindReposFor(null)}
          onDone={() => setFindReposFor(null)}
        />
      )}
    </div>
  )
}

/**
 * The pairing sub-flow, as a takeover of the Settings pane body.
 *
 * A dialog over the sheet would be the second modal layer the sheet tier forbids
 * — two backdrops, two owners of Escape — and, being `fixed` and centred, it hung
 * off both edges of a short window with nothing able to scroll it. Here the pane
 * scrolls, and Escape means "back to the list" rather than "throw the whole
 * Settings sheet away mid-pairing".
 */
function AddMachineFlow({
  onBack,
  intro,
  children,
}: {
  onBack: () => void
  intro: string
  children: ReactNode
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Capture phase, and `preventDefault` rather than `stopPropagation`: the
      // sheet's own Escape handler is a window listener registered before this
      // one, and it stands down for an already-defaulted event.
      event.preventDefault()
      onBack()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onBack])

  return (
    <section className="settings-section-enter" aria-labelledby="add-machine-heading">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2.5 mb-3 text-muted-foreground"
        onClick={onBack}
      >
        <ChevronLeft data-icon="inline-start" aria-hidden="true" />
        Back to machines
      </Button>
      <h3 id="add-machine-heading" className="settings-h">
        Add a machine
      </h3>
      <p className="settings-prose mt-1">{intro}</p>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  )
}

/** State + action shared by the standalone card and the inline row button. [spec:SP-3701] */
interface EnableHosting {
  busy: boolean
  error: string | null
  enable: () => Promise<void>
}

/**
 * [spec:SP-3701] The one-click "host sessions on this device" flow: mint a pairing code on
 * this hub, hand it to the shell (which flips the local config to daemon mode), restart.
 * Returns null outside a client-mode desktop shell — the only place hosting can be enabled.
 */
function useEnableHosting(trpc: Store['trpc']): EnableHosting | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bridge = nativeDesktopBridge()
  if (bridge?.launchMode !== 'client' || !bridge.enableHosting) return null
  const enableHosting = bridge.enableHosting

  const enable = async () => {
    setBusy(true)
    setError(null)
    try {
      const { code } = await trpc.machines.pairingCode.mutate()
      await enableHosting(code)
      // Relaunch so the shell re-reads the config and spawns the daemon. Keep `busy` set on
      // success — the app is about to go away; re-enabling the button would invite a
      // double-enroll. The config IS already flipped at this point, so if restart is missing
      // or refused (older shells didn't grant process.restart to remote pages), tell the
      // user to relaunch manually instead of hanging on "Enabling…".
      const restart = (window as unknown as { __PODIUM_RESTART__?: () => unknown })
        .__PODIUM_RESTART__
      try {
        if (!restart) throw new Error('no restart hook')
        await Promise.resolve(restart())
      } catch {
        setBusy(false)
        setError('Hosting enabled — quit and reopen the app to finish pairing.')
      }
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return { busy, error, enable }
}

/**
 * [spec:SP-3701] Standalone hosting card, shown ONLY when this device never paired before —
 * a previously-paired device gets the inline "Enable" action on its machine row instead.
 */
export function HostThisDeviceCard({ hosting }: { hosting: EnableHosting }): JSX.Element {
  const { busy, error, enable } = hosting
  return (
    <div className="mb-3 flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="settings-label">This device</div>
        <p className="settings-prose mt-1">
          {error ?? 'Run sessions on this computer too. The app will restart to pair it.'}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="flex-none"
        disabled={busy}
        onClick={() => void enable()}
      >
        {busy ? 'Enabling…' : 'Host sessions on this device'}
      </Button>
    </div>
  )
}

function PairingCodeDisplay({
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
  onNewCode,
  minting,
}: {
  code: string
  joinCommand: string | null
  publicUrl?: string | null
  onChangeUrl?: () => void
  podiumManaged: boolean
  onManagedChange: (managed: boolean) => void
  recommendServer: boolean
  makeServerAfterPair: boolean
  onMakeServerAfterPairChange: (value: boolean) => void
  pairedMachine: MachineWire | null
  onReviewPairedMachine: () => void
  /** Mint a fresh code and join command for the same options. */
  onNewCode: () => void
  minting: boolean
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    if (!joinCommand) return
    void navigator.clipboard.writeText(joinCommand).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    // min-w-0: a long, unbreakable URL or token must wrap inside the pane rather
    // than push the whole column past its measure.
    <div className="min-w-0 space-y-5">
      {/* THE OPTIONS COME FIRST because they re-mint the command underneath
          them: a choice offered after the thing it changes is a choice made
          twice. */}
      <div className="space-y-2">
        {/* A control that names itself and then explains itself: the same
            label-over-prose pair a settings Row makes, so this checkbox reads at
            the sheet's scale rather than a size of its own. */}
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline-soft bg-muted/20 px-3 py-2.5 transition-colors hover:border-border">
          <input
            type="checkbox"
            className="mt-1"
            checked={podiumManaged}
            onChange={(event) => onManagedChange(event.currentTarget.checked)}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="settings-label">Podium-managed machine</span>
            <span className="settings-prose">
              When off, mark this machine as shared and keep native logins local.
            </span>
          </span>
        </label>
        {recommendServer && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-1"
              checked={makeServerAfterPair}
              onChange={(event) => onMakeServerAfterPairChange(event.currentTarget.checked)}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="settings-label">Recommended: make this the server</span>
              <span className="settings-prose">
                If this is an always-on VPS, make it the server. Your current machine keeps its
                agent sessions but stops hosting the shared Podium state.
              </span>
            </span>
          </label>
        )}
      </div>

      <div className="min-w-0 space-y-2">
        {publicUrl && (
          // Which URL the join code points at — the #1 thing that goes wrong (a
          // throwaway tunnel URL). It sits above the command because it is what
          // the command will dial. One click to change it in Settings → Network.
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="settings-micro flex-none">Server URL this code points at</span>
            <code className="settings-value min-w-0 break-all">{publicUrl}</code>
            {onChangeUrl && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="flex-none text-muted-foreground"
                onClick={onChangeUrl}
              >
                Change…
              </Button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="settings-label">Command to run on the other machine</span>
          {joinCommand && (
            <Button type="button" size="sm" className="flex-none" onClick={copy}>
              {copied ? 'Copied' : 'Copy command'}
            </Button>
          )}
        </div>
        {joinCommand ? (
          // Meant to be copied, not read: keep it to a single line on a carved surface that
          // scrolls horizontally, so a long install command can't balloon and dominate the
          // pane. The Copy button above is the real affordance; `title` exposes the full text.
          <code
            className="block max-w-full overflow-x-auto whitespace-nowrap rounded-md border border-hairline-soft bg-muted px-2.5 py-2 font-mono text-[12px] leading-relaxed text-muted-foreground [scrollbar-width:thin]"
            title={joinCommand}
          >
            {joinCommand}
          </code>
        ) : (
          <p className="settings-prose">Finish setup to get a one-line join command.</p>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="settings-micro">Pairing code</span>
          <code className="settings-value tracking-[0.16em]">{code}</code>
          <span className="settings-micro" aria-hidden="true">
            ·
          </span>
          <span className="settings-micro">The code expires after one use or 1 hour.</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={minting}
            onClick={onNewCode}
          >
            New code
          </Button>
        </div>
      </div>

      {/* The end of the flow: still waiting, or paired. One line, never both. */}
      {pairedMachine ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-success/30 bg-success/5 px-3 py-2.5"
          role="status"
        >
          <span className="settings-prose min-w-0 flex-1">
            <strong className="font-medium text-foreground">{pairedMachine.name}</strong> is paired,
            and the server reports it is ready for transfer review.
          </span>
          <Button type="button" size="sm" className="flex-none" onClick={onReviewPairedMachine}>
            Review transfer
          </Button>
        </div>
      ) : (
        joinCommand && (
          <p className="settings-prose flex items-center gap-2" role="status">
            <span className="spb" aria-hidden="true" />
            Waiting for the machine to run the command…
          </p>
        )
      )}
    </div>
  )
}

function ServerTransferDialog({
  machine,
  sourceName,
  status,
  trpc,
  open,
  onOpenChange,
}: {
  machine: MachineWire
  sourceName: string
  status: ServerTransferStatusController
  trpc: Store['trpc']
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = open ?? internalOpen
  const transfer = useServerTransfer({
    trpc,
    targetMachineId: machine.id,
    status,
    active: isOpen,
  })

  const setDialogOpen = (next: boolean): void => {
    if (onOpenChange) onOpenChange(next)
    else setInternalOpen(next)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setDialogOpen}>
      <DialogContent showCloseButton className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Move the server from {sourceName} to {machine.name}?
          </DialogTitle>
          <DialogDescription>
            Portable shared state moves to {machine.name}; repositories, native credentials, and
            running sessions stay on their machines. {sourceName} remains the server until the copy
            validates, then reconnects to the new public URL as a daemon.
          </DialogDescription>
        </DialogHeader>

        {transfer.showProgress ? (
          <ServerTransferProgress
            state={transfer.displayState ?? 'preparing'}
            targetName={machine.name}
            detail={transferErrorMessage(transfer.transfer)}
          />
        ) : (
          <div className="flex flex-col gap-3 text-[13px]">
            <label htmlFor="server-transfer-url" className="flex flex-col gap-1">
              <span className="text-muted-foreground">New public URL</span>
              <Input
                id="server-transfer-url"
                value={transfer.publicUrl}
                onChange={(event) => transfer.setPublicUrl(event.currentTarget.value)}
                aria-label="New public URL"
                placeholder="https://podium.example.com"
                autoComplete="url"
              />
              <span className="text-[11px] text-muted-foreground">
                Podium clients will reconnect to this HTTP(S) address after the target proves it is
                serving.
              </span>
            </label>
            <label htmlFor="server-transfer-confirmation" className="flex flex-col gap-1">
              <span className="text-muted-foreground">
                Type <strong>{SERVER_TRANSFER_CONFIRMATION}</strong> to confirm
              </span>
              <Input
                id="server-transfer-confirmation"
                value={transfer.confirmation}
                onChange={(event) => transfer.setConfirmation(event.currentTarget.value)}
                aria-label="Server transfer confirmation"
                autoComplete="off"
              />
            </label>
            {transfer.publicUrl.trim() !== '' && !transfer.urlIsValid && (
              <p className="settings-prose text-destructive!" role="alert">
                Enter a complete HTTP or HTTPS public URL.
              </p>
            )}
            {(transfer.error || status.error || transferErrorMessage(transfer.transfer)) && (
              <p className="settings-prose text-destructive!" role="alert">
                {transfer.error ?? status.error ?? transferErrorMessage(transfer.transfer)}
              </p>
            )}
          </div>
        )}
        {transfer.showProgress && (transfer.error || status.error) && (
          <p className="settings-prose text-destructive!" role="alert">
            {transfer.error ?? status.error}
          </p>
        )}

        <DialogFooter showCloseButton>
          {!transfer.showProgress && (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!transfer.canStart}
              onClick={() => void transfer.start()}
            >
              Transfer server
            </Button>
          )}
          {transfer.displayState === 'commit-uncertain' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={transfer.checkingTarget}
              onClick={() => void transfer.checkTarget()}
            >
              {transfer.checkingTarget ? 'Checking…' : 'Check target'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MachineRow({
  machine,
  now,
  trpc,
  isThisMachine = false,
  hosting = null,
  onFindRepos = null,
  onTransferServer = null,
  serverTransferUnsupported = false,
  showOwnershipTransfer = false,
  serverAppVersion = null,
  convergence = null,
  onConvergenceChanged = () => {},
}: {
  machine: MachineWire
  now: number
  trpc: Store['trpc']
  /** [spec:SP-3701] True when this row is the device the app is running on. */
  isThisMachine?: boolean
  /** [spec:SP-3701] Set only when this offline row can be enabled as a host from here. */
  hosting?: EnableHosting | null
  /** POD-787: open the repo scan flow preset to this (online) machine. */
  onFindRepos?: (() => void) | null
  /** Open the server-transfer confirmation for this online target. */
  onTransferServer?: (() => void) | null
  /** The online target cannot transfer until its Podium wire version matches the server. */
  serverTransferUnsupported?: boolean
  /** Keep the implemented multi-user ownership flow dormant until that product ships. */
  showOwnershipTransfer?: boolean
  /** POD-838: the server's own build version; null while unknown. */
  serverAppVersion?: string | null
  /** This machine's server-side convergence, or null when it is not converging. */
  convergence?: MachineConvergence | null
  /** Ask the panel to re-read the fleet now. */
  onConvergenceChanged?: () => void
}): JSX.Element {
  const [name, setName] = useState(machine.name)
  const [editing, setEditing] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)
  // POD-1495 transfer dialog: the recipient's account name, the typed-name
  // confirmation, and the server's refusal when there is one.
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [recipientId, setRecipientId] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [transferError, setTransferError] = useState<string | null>(null)

  // Sync incoming name changes from server broadcast.
  useEffect(() => {
    if (!editing) setName(machine.name)
  }, [machine.name, editing])

  const commitRename = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === machine.name) {
      setName(machine.name)
      setEditing(false)
      return
    }
    setRenaming(true)
    try {
      await trpc.machines.rename.mutate({ id: machine.id, name: trimmed })
    } finally {
      setRenaming(false)
      setEditing(false)
    }
  }

  // POD-838/POD-1873: surface skew against this machine's selected channel target.
  const daemonVersion = machine.inventory?.podiumVersion
  const needsUpdate = machineNeedsUpdate(machine, serverAppVersion)
  const updateTargetVersion =
    machine.targetVersion !== undefined ? machine.targetVersion : serverAppVersion

  const revoke = async () => {
    setRevoking(true)
    try {
      await trpc.machines.revoke.mutate({ id: machine.id })
    } finally {
      setRevoking(false)
      setRevokeOpen(false)
    }
  }

  /**
   * POD-1495 — TRANSFER IS OFFERED ONLY TO THE CURRENT OWNER, and the panel
   * learns that from the server rather than guessing.
   *
   * `machine.owned` is the viewer-relative answer the projection attaches
   * (`MachineWire.owned`), computed by the SAME predicate the transfer gate
   * refuses with. So the three refusals POD-1480 proves are all unreachable
   * from here rather than re-implemented: a manage grantee sees no control
   * (owned=false → FORBIDDEN never happens), an unowned machine offers none
   * (owned=false; adopting one is POD-1494's different act), and a machine the
   * caller cannot see is not in this list at all — which is why the row says
   * NOTHING about transfer when `owned` is false. Rendering a disabled "you
   * cannot transfer this" would leak, in the one case where the server answers
   * absent-shaped, exactly the existence it refuses to confirm.
   *
   * `=== true` and not truthiness: absent means NOT EVALUATED, and the closed
   * reading of "not evaluated" is no.
   */
  const mayTransfer = showOwnershipTransfer && machine.owned === true

  const transfer = async () => {
    const recipient = recipientId.trim()
    if (!recipient) return
    setTransferring(true)
    setTransferError(null)
    try {
      await trpc.machines.transferOwnership.mutate({ id: machine.id, newOwnerUserId: recipient })
      setTransferOpen(false)
      setRecipientId('')
      setConfirmName('')
    } catch (e) {
      // THE SERVER'S OWN MESSAGE, verbatim. A friendlier rewrite here would have
      // to decide what an unknown recipient or a self-transfer MEANS, and every
      // such decision discloses more than the refusal it replaces.
      setTransferError(e instanceof Error ? e.message : String(e))
    } finally {
      setTransferring(false)
    }
  }

  return (
    <div className="py-4">
      {/* IDENTITY LEFT, ACTIONS RIGHT. The row used to be one wrap of eleven
          equal-weight items — dot, name, two pills, hostname, version, badge,
          timestamp and four buttons — so nothing led and the buttons landed in a
          different place on every row. Now the machine names itself on one line,
          says what it is on a second in machine voice, and every action sits in
          one cluster on the same right edge. */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {/* Online/offline dot */}
          <span
            role="img"
            className={cn(
              'mt-[7px] size-1.5 flex-none rounded-full',
              machine.online ? 'bg-success' : 'bg-muted-foreground/40',
            )}
            title={machine.online ? 'Online' : 'Offline'}
            aria-label={machine.online ? 'Online' : 'Offline'}
          />

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {/* Name — inline editable */}
              {editing ? (
                <Input
                  className="h-7 w-full max-w-[22rem] px-1.5"
                  value={name}
                  autoFocus
                  disabled={renaming}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') {
                      setName(machine.name)
                      setEditing(false)
                    }
                  }}
                  aria-label="Machine name"
                />
              ) : (
                <button
                  data-pressable
                  type="button"
                  className="settings-label min-w-0 cursor-text truncate text-left hover:underline"
                  title="Click to rename"
                  onClick={() => setEditing(true)}
                >
                  {machine.name}
                </button>
              )}

              {isThisMachine && (
                <Badge variant="outline" className="h-4 flex-none px-1.5 text-[11px]">
                  this machine
                </Badge>
              )}

              {/* Only the exception is worth a pill: "Podium-managed" was on every
                  row, and a badge every row carries says nothing. */}
              {machine.podiumManaged === false && (
                <Badge variant="outline" className="h-4 flex-none px-1.5 text-[11px]">
                  shared
                </Badge>
              )}

              {needsUpdate && (
                <Badge
                  variant="warning"
                  className="h-4 flex-none px-1.5 text-[11px]"
                  title={`This machine runs Podium ${daemonVersion}; its selected update target is ${updateTargetVersion}.`}
                >
                  update available
                </Badge>
              )}
            </div>

            {/* The machine's own voice: what it is, what it runs, when it was last
                here — one line, mono where the value is a machine's. */}
            <div className="settings-micro mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5">
              <span className="min-w-0 truncate font-mono" title={machine.hostname}>
                {machine.hostname}
              </span>
              {daemonVersion && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono" title={`Podium ${daemonVersion} on this machine`}>
                    {daemonVersion}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {machine.online ? 'Online' : `Last seen ${relativeTime(machine.lastSeenAt, now)}`}
              </span>
              {serverTransferUnsupported && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-warning">Same version required</span>
                </>
              )}
              {hosting?.error && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="min-w-0 truncate text-destructive" title={hosting.error}>
                    {hosting.error}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 sm:flex-none sm:justify-end">
          {/* Discover this machine's repos (POD-787) */}
          {onFindRepos && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="flex-none text-muted-foreground"
              onClick={onFindRepos}
            >
              Find repos
            </Button>
          )}

          {/* Enable hosting on this (offline, previously paired) device [spec:SP-3701] */}
          {hosting && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-none"
              disabled={hosting.busy}
              onClick={() => void hosting.enable()}
            >
              {hosting.busy ? 'Enabling…' : 'Enable'}
            </Button>
          )}

          {(onTransferServer || serverTransferUnsupported) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-none"
              disabled={serverTransferUnsupported}
              title={
                serverTransferUnsupported
                  ? 'Update this machine to the same Podium version as the server first.'
                  : undefined
              }
              onClick={onTransferServer ?? undefined}
            >
              Make server
            </Button>
          )}

          {/* Transfer ownership — OWNER ONLY (POD-1495); see `mayTransfer` above. */}
          {mayTransfer && (
            <Dialog
              open={transferOpen}
              onOpenChange={(open) => {
                setTransferOpen(open)
                // Reopening starts clean: a half-typed recipient left over from an
                // abandoned attempt is the wrong thing to have next to a Transfer button.
                if (!open) {
                  setRecipientId('')
                  setConfirmName('')
                  setTransferError(null)
                }
              }}
            >
              <DialogTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="flex-none text-muted-foreground"
                  />
                }
              >
                Transfer
              </DialogTrigger>
              <DialogContent showCloseButton>
                <DialogHeader>
                  <DialogTitle>Transfer ownership?</DialogTitle>
                  <DialogDescription>
                    <strong>{machine.name}</strong> ({machine.hostname}) becomes theirs. They get to
                    see, use and manage it; you lose all three the moment you confirm. You will not
                    be able to undo this or transfer it back — only the new owner can.
                    <br />
                    <br />
                    Everyone you have shared this machine with loses their access too: every share
                    on <strong>{machine.name}</strong> is dropped, and the new owner decides who
                    gets it back.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 text-[13.5px]">
                  <label htmlFor="ownership-recipient" className="flex flex-col gap-1">
                    <span className="text-muted-foreground">New owner's account name</span>
                    <Input
                      id="ownership-recipient"
                      value={recipientId}
                      autoFocus
                      disabled={transferring}
                      placeholder="the account they sign in with"
                      onChange={(e) => setRecipientId(e.target.value)}
                      aria-label="New owner's account name"
                    />
                  </label>
                  <label htmlFor="ownership-name" className="flex flex-col gap-1">
                    <span className="text-muted-foreground">
                      Type <strong>{machine.name}</strong> to confirm
                    </span>
                    <Input
                      id="ownership-name"
                      value={confirmName}
                      disabled={transferring}
                      onChange={(e) => setConfirmName(e.target.value)}
                      aria-label="Type the machine name to confirm"
                    />
                  </label>
                  {transferError && (
                    <p className="settings-prose text-destructive!" role="alert">
                      {transferError}
                    </p>
                  )}
                </div>
                <DialogFooter showCloseButton>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={
                      transferring ||
                      recipientId.trim() === '' ||
                      confirmName.trim() !== machine.name
                    }
                    onClick={() => void transfer()}
                  >
                    {transferring ? 'Transferring…' : 'Transfer ownership'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}

          {/* Revoke */}
          <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
            <DialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  // Quiet until you reach for it. Revoke is on every row, and three
                  // red words down the right edge were the loudest thing in a pane
                  // whose actual signal is which machine needs an update.
                  className="flex-none text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                />
              }
            >
              Revoke
            </DialogTrigger>
            <DialogContent showCloseButton>
              <DialogHeader>
                <DialogTitle>Revoke machine?</DialogTitle>
                <DialogDescription>
                  "<strong>{machine.name}</strong>" ({machine.hostname}) will be disconnected and
                  will need to re-pair to reconnect. Any sessions running on it will continue until
                  they finish.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter showCloseButton>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={revoking}
                  onClick={() => void revoke()}
                >
                  {revoking ? 'Revoking…' : 'Revoke'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {machine.podiumManaged !== false && (
        <MachineUpdateControls
          machine={machine}
          trpc={trpc}
          convergence={convergence}
          onApplied={onConvergenceChanged}
        />
      )}
    </div>
  )
}

const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
  dev: 'Development',
  edge: 'Edge',
  stable: 'Stable',
}

type ConvergenceRowState =
  | 'current'
  | 'granted'
  | 'downloading'
  | 'restarting'
  | 'rejected'
  | 'stuck'

const CONVERGENCE_IN_FLIGHT: ReadonlySet<ConvergenceRowState> = new Set([
  'granted',
  'downloading',
  'restarting',
])

/**
 * What the operator sees while a grant is in flight. Deliberately coarse: the
 * server reports a machine phase, not transferred bytes, so this must not imply
 * byte-level progress it cannot know.
 */
const CONVERGENCE_PROGRESS_LABELS: Record<string, string> = {
  granted: 'Starting update…',
  downloading: 'Downloading update…',
  restarting: 'Restarting…',
}

/** The outcome vocabulary the machine row speaks, keyed off the server's verdict. */
export function describeApplyOutcome(
  outcome: { result: string; state?: string; reason?: string; version?: string },
  machineName: string,
): { tone: 'progress' | 'ok' | 'error'; message: string } {
  switch (outcome.result) {
    case 'granted':
      return { tone: 'progress', message: `Updating ${machineName} to ${outcome.version}…` }
    case 'already-current':
      return { tone: 'ok', message: `${machineName} is already up to date.` }
    case 'in-flight':
      return {
        tone: 'progress',
        message: `${machineName} is already updating. Wait for it to finish.`,
      }
    case 'offline':
      return {
        tone: 'error',
        message: `${machineName} is not connected. Bring it online, then apply again.`,
      }
    case 'unknown-machine':
      return { tone: 'error', message: `${machineName} is no longer paired with this server.` }
    case 'no-target':
      return {
        tone: 'error',
        message: outcome.reason
          ? `No update is available for ${machineName}: ${outcome.reason}`
          : `No update is available for ${machineName} on its selected update source.`,
      }
    default:
      return { tone: 'error', message: `Podium could not start the update on ${machineName}.` }
  }
}

/** Radix Select has no null value, so "no pin" needs a token of its own. */
const FLEET_DEFAULT_VALUE = '__fleet__'

/**
 * A channel choice changes only this machine's durable update authority. Applying
 * is deliberately separate: it issues one convergence grant after the selected
 * authority has resolved a concrete trusted target.
 */
function MachineUpdateControls({
  machine,
  trpc,
  convergence,
  onApplied,
}: {
  machine: MachineWire
  trpc: Store['trpc']
  /** This machine's server-side convergence, or null when it is not converging. */
  convergence: MachineConvergence | null
  /** Ask the panel to poll now, so the row shows progress without a delay. */
  onApplied: () => void
}): JSX.Element {
  // The PIN (null = follows the fleet default), not the resolved channel. POD-1882.
  const [channel, setChannel] = useState<UpdateChannel | null>(
    machine.updateChannelOverride ?? null,
  )
  const [targetVersion, setTargetVersion] = useState<string | null>(machine.targetVersion ?? null)
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    machine.targetUnavailableReason ?? null,
  )
  const developing = useFeature('podium-development')
  const [changingChannel, setChangingChannel] = useState(false)
  const [applying, setApplying] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<string | null>(null)
  // Convergence for this row is SERVER state, read by the panel. The local
  // `applying` flag only covers the mutation round trip; deriving progress from
  // it alone made the row look idle the instant the grant was issued, and lost
  // it entirely on reload or when the global dialog started the update.
  const converging = convergence !== null && CONVERGENCE_IN_FLIGHT.has(convergence.state)
  const rowState = convergence?.state ?? null
  // An outcome is only OURS to announce once this row has actually watched an
  // update happen — it applied one, or it saw this machine in flight. Without
  // that, the first fleet snapshot of an idle, already-current machine would
  // make every row claim a completion nobody asked for.
  const watching = useRef(false)

  useEffect(() => {
    setChannel(machine.updateChannelOverride ?? null)
    setTargetVersion(machine.targetVersion ?? null)
    setUnavailableReason(machine.targetUnavailableReason ?? null)
  }, [machine.updateChannelOverride, machine.targetVersion, machine.targetUnavailableReason])

  // Report the transition OUT of an in-flight state once, whoever started it.
  useEffect(() => {
    const state = convergence?.state ?? null
    if (state !== null && CONVERGENCE_IN_FLIGHT.has(state)) {
      watching.current = true
      return
    }
    if (state === null || !watching.current) return
    watching.current = false
    if (state === 'rejected' || state === 'stuck') {
      setUpdateStatus(null)
      setUpdateError(
        convergence?.detail
          ? `${machine.name} could not finish the update: ${convergence.detail}`
          : `${machine.name} could not finish the update. Try applying it again.`,
      )
    } else if (state === 'current') {
      setUpdateError(null)
      setUpdateStatus(`${machine.name} is up to date.`)
    }
  }, [convergence?.state, convergence?.detail, machine.name])

  const adoptMachine = (machines: readonly MachineWire[]): boolean => {
    const updated = machines.find((candidate) => candidate.id === machine.id)
    if (!updated) return false
    setChannel(updated.updateChannelOverride ?? null)
    setTargetVersion(updated.targetVersion ?? null)
    setUnavailableReason(updated.targetUnavailableReason ?? null)
    return true
  }

  const chooseChannel = async (nextChannel: UpdateChannel | null): Promise<void> => {
    if (nextChannel === channel || changingChannel || busy) return
    setChangingChannel(true)
    setUpdateError(null)
    setUpdateStatus(null)
    try {
      const machines = await trpc.machines.setUpdateChannel.mutate({
        id: machine.id,
        channel: nextChannel,
      })
      if (!adoptMachine(machines)) {
        setUpdateError('The machine disappeared while its update source was changing.')
      }
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error))
    } finally {
      setChangingChannel(false)
    }
  }

  const applyUpdate = async (): Promise<void> => {
    if (busy || changingChannel || supervised || !machine.online || !targetVersion) return
    setApplying(true)
    setUpdateError(null)
    setUpdateStatus(null)
    try {
      const result = await trpc.machines.applyUpdate.mutate({ id: machine.id })
      adoptMachine(result.machines)
      const said = describeApplyOutcome(result.outcome, machine.name)
      if (said.tone === 'error') setUpdateError(said.message)
      else setUpdateStatus(said.message)
      if (said.tone === 'progress') {
        // This row now owns an update in flight, so it may announce how that
        // update ends even if convergence completes between two polls.
        watching.current = true
        onApplied()
      }
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error))
    } finally {
      setApplying(false)
    }
  }

  const alreadyCurrent =
    targetVersion !== null && machine.appVersion !== null && machine.appVersion === targetVersion
  /**
   * This daemon lives inside the signed Podium Desktop bundle, which owns its
   * bytes (POD-2099, spec §4). No wave delivers to it and no Apply here ever
   * could: the shell update is the only thing that moves it. Offering the button
   * anyway was the dead end §6.1 bans — a control whose only outcome is a
   * refusal the user cannot act on.
   */
  const supervised = machine.supervised === true
  const targetLabel = targetVersion ? `Target ${targetVersion}` : 'Target unavailable'
  // Busy spans the whole act: the mutation round trip AND the convergence it
  // authorized. The action stays disabled for both.
  const busy = applying || converging
  const retryable = rowState === 'rejected' || rowState === 'stuck'
  const progressLabel =
    (rowState ? CONVERGENCE_PROGRESS_LABELS[rowState] : undefined) ?? 'Starting update…'

  return (
    // A quiet third line under the machine it belongs to, indented to the name's
    // own column and separated by air rather than by a second rule — the run's
    // hairlines already say where one machine ends.
    <div
      className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 pl-4"
      data-machine-update-controls={machine.id}
    >
      {/* Sentence case, not a tracked mono eyebrow: this label repeats once per
          machine, and a caps rule shouted down the whole list. */}
      <span className="settings-micro flex-none">Update source</span>
      {/* POD-1882: choosing a SOURCE PER MACHINE is a Podium-development affordance,
          so the control hides with the flag. What the machine is actually on stays
          readable either way — the Target chip below never hides, and Settings →
          Updates discloses every machine that is pinned away from the fleet default,
          so an override can never become invisible by turning the flag off. */}
      {supervised ? (
        <span className="flex-none settings-micro" data-machine-supervised={machine.id}>
          Managed by Podium Desktop
        </span>
      ) : developing ? (
        <Select
          value={channel ?? FLEET_DEFAULT_VALUE}
          disabled={changingChannel || busy}
          onValueChange={(value) =>
            void chooseChannel(value === FLEET_DEFAULT_VALUE ? null : (value as UpdateChannel))
          }
        >
          <SelectTrigger
            size="sm"
            className="w-[152px] flex-none"
            aria-label={`Update channel for ${machine.name}`}
          >
            <SelectValue>
              {channel === null ? 'Fleet default' : UPDATE_CHANNEL_LABELS[channel]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* First, and the only one that is not a pin: it hands the machine back. */}
            <SelectItem value={FLEET_DEFAULT_VALUE}>Fleet default</SelectItem>
            <SelectItem value="dev">Development</SelectItem>
            <SelectItem value="edge">Edge</SelectItem>
            <SelectItem value="stable">Stable</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <span className="flex-none settings-micro" data-machine-update-source={machine.id}>
          {channel === null
            ? 'Fleet default'
            : `${UPDATE_CHANNEL_LABELS[channel]} (pinned for this machine)`}
        </span>
      )}

      {/* A known target is a fact, not an alert: it reads in machine voice like
          the version beside the machine's name, and only takes a badge when
          there is nothing to report. */}
      {targetVersion ? (
        // One element, not a sans word wrapping a mono span: the version string
        // is asserted verbatim elsewhere, and a nested node would answer to it.
        <span className="settings-micro flex-none">{targetLabel}</span>
      ) : (
        <Badge variant="warning" className="h-4 flex-none px-1.5 text-[11px]">
          {targetLabel}
        </Badge>
      )}
      {busy && (
        <span
          className="settings-micro flex flex-none items-center gap-1.5"
          role="status"
          data-machine-update-progress={machine.id}
        >
          <span className="spb" aria-hidden="true" />
          {progressLabel}
        </span>
      )}

      {/* The action keeps one place in the row. Anything that can appear or
          disappear — reasons, errors, progress — lives on its own line below,
          so a click never moves the button out from under the pointer. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto flex-none"
        disabled={
          busy ||
          changingChannel ||
          supervised ||
          !machine.online ||
          !targetVersion ||
          alreadyCurrent
        }
        aria-busy={busy}
        aria-label={`Apply update to ${machine.name}`}
        title={
          supervised
            ? `Managed by Podium Desktop on this machine — it updates when the app does.`
            : !machine.online
              ? 'This machine must be online to apply its selected target.'
              : (unavailableReason ?? undefined)
        }
        onClick={() => void applyUpdate()}
      >
        {busy ? 'Applying…' : alreadyCurrent ? 'Current' : retryable ? 'Try again' : 'Apply'}
      </Button>

      {(supervised || unavailableReason || updateError || updateStatus) && (
        // min-w-0 as well as basis-full: a flex item's automatic minimum is its
        // min-content width, and these lines are `truncate` (nowrap), so without
        // it the longest reason set the row's width and ran off the pane.
        <div className="flex min-w-0 basis-full flex-col gap-0.5">
          {/* The reason a disabled control is disabled belongs on the page, not
              only in a title attribute nobody hovers. */}
          {supervised && (
            <span className="min-w-0 settings-micro">
              Managed by Podium Desktop on this machine — it updates when the app does.
            </span>
          )}
          {unavailableReason && (
            <span
              className="min-w-0 truncate settings-micro text-warning!"
              title={unavailableReason}
            >
              {/* §6.3: an internal precondition is never shown as an error. The
                  server's reason is a real fact about this deployment, so it is
                  kept — inside a sentence, after a frame that says what it means
                  for this machine. */}
              {sourceUnavailableProse(
                channel === null ? 'its update source' : UPDATE_CHANNEL_LABELS[channel],
                unavailableReason,
              )}
            </span>
          )}
          {updateError && (
            <span className="min-w-0 settings-micro text-destructive!" role="alert">
              {updateError}
            </span>
          )}
          {updateStatus && (
            <span className="min-w-0 settings-micro text-success!" role="status">
              {updateStatus}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

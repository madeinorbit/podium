import { asMachineId } from '@podium/model'
import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import type { MachineWire, UpdateChannel } from '@podium/model/browser'
import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Store, useStoreSelector } from '@/app/store'
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
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import { NetworkStep } from '@/features/setup/SetupView'
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

type ServerTransferPhase = (typeof SERVER_TRANSFER_PHASES)[number]['key']
type ServerTransferDisplayState = ServerTransferPhase | 'aborted' | 'commit-uncertain'

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
        <p className="settings-label text-warning">Connection could not be confirmed</p>
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
        <p className="settings-label text-destructive">Transfer stopped safely</p>
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

export const SERVER_TRANSFER_CONFIRMATION = 'TRANSFER SERVER'

export type ServerTransferStatusSnapshot = Awaited<
  ReturnType<Store['trpc']['machines']['serverTransferStatus']['query']>
>

const SERVER_TRANSFER_POLL_MIN_MS = 1_000
const SERVER_TRANSFER_POLL_MAX_MS = 5_000

function serverTransferPollDelay(
  snapshot: ServerTransferStatusSnapshot | null,
  failures: number,
): number {
  if (failures > 0) {
    return Math.min(
      SERVER_TRANSFER_POLL_MAX_MS,
      SERVER_TRANSFER_POLL_MIN_MS * 2 ** Math.min(failures, 3),
    )
  }
  if (!snapshot?.transfer) return SERVER_TRANSFER_POLL_MAX_MS
  const state = transferDisplayState(snapshot.transfer)
  return state === 'connected' || state === 'aborted'
    ? SERVER_TRANSFER_POLL_MAX_MS
    : SERVER_TRANSFER_POLL_MIN_MS
}

function useServerTransferStatus(trpc: Store['trpc']): {
  snapshot: ServerTransferStatusSnapshot | null
  error: string | null
  refresh: () => Promise<ServerTransferStatusSnapshot | null>
} {
  const [snapshot, setSnapshot] = useState<ServerTransferStatusSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<ServerTransferStatusSnapshot | null> => {
    try {
      const next = await trpc.machines.serverTransferStatus.query()
      setSnapshot(next)
      setError(null)
      return next
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [trpc])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (failures: number): Promise<void> => {
      const next = await refresh()
      if (cancelled) return
      const nextFailures = next ? 0 : failures + 1
      timer = setTimeout(() => void poll(nextFailures), serverTransferPollDelay(next, nextFailures))
    }
    void poll(0)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  return { snapshot, error, refresh }
}

function transferDisplayState(
  transfer: ServerTransferStatusSnapshot['transfer'],
): ServerTransferDisplayState | null {
  if (!transfer) return null
  if (transfer.state === 'commit-uncertain' || transfer.phase === 'commit-uncertain') {
    return 'commit-uncertain'
  }
  if (transfer.state === 'aborted' || transfer.phase === 'aborted') return 'aborted'
  if (transfer.state === 'committed' || transfer.phase === 'connected') {
    return transfer.targetProof && transfer.sourceConnected ? 'connected' : 'switching'
  }
  return transfer.phase
}

function transferErrorMessage(
  transfer: ServerTransferStatusSnapshot['transfer'],
): string | undefined {
  return transfer && 'error' in transfer ? transfer.error?.message : undefined
}

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
  const [code, setCode] = useState<string | null>(null)
  const [joinCommand, setJoinCommand] = useState<string | null>(null)
  const [publicUrl, setPublicUrl] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [addLoading, setAddLoading] = useState(false)
  const [podiumManaged, setPodiumManaged] = useState(true)
  const [makeServerAfterPair, setMakeServerAfterPair] = useState(false)
  const [pairingBaselineIds, setPairingBaselineIds] = useState<Set<string>>(() => new Set())
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
  const activeTransferMachine =
    machines.find((machine) => machine.id === transferStatus.snapshot?.transfer?.targetMachineId) ??
    null
  const sourceMachine =
    machines.find((machine) => machine.id === transferStatus.snapshot?.sourceMachineId) ?? null
  const convergence = useFleetConvergence(trpc)
  const newlyPairedMachine = makeServerAfterPair
    ? (machines.find(
        (machine) => !pairingBaselineIds.has(machine.id) && eligibleTransferTargets.has(machine.id),
      ) ?? null)
    : null

  // Tick so relative times stay fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const mintCode = async (managed = podiumManaged) => {
    setPodiumManaged(managed)
    setAddLoading(true)
    setAddError(null)
    try {
      const [r, info] = await Promise.all([
        trpc.machines.pairingCode.mutate({ copyAgentCredentials: true, podiumManaged: managed }),
        trpc.setup.info.query(),
      ])
      setCode(r.code)
      setJoinCommand(r.joinCommand)
      setPublicUrl(info.publicUrl)
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddLoading(false)
    }
  }

  const openAddMachine = (): void => {
    setPairingBaselineIds(new Set(machines.map((machine) => machine.id)))
    setMakeServerAfterPair(machines.length === 1)
    setAddOpen(true)
    void mintCode(podiumManaged)
  }

  // Jump to Settings → Network to change the server's reachable URL.
  const goChangeUrl = (): void => {
    setAddOpen(false)
    setSettingsTab('network')
  }

  return (
    <div className="py-3">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="settings-h">Machines</h3>
          <p className="settings-prose mt-1">
            Every machine running a Podium daemon that has paired with this server. Sessions from
            all machines appear together in your workspace.
          </p>
        </div>
        <Dialog
          open={addOpen}
          onOpenChange={(o) => {
            setAddOpen(o)
            if (!o) {
              setCode(null)
              setJoinCommand(null)
              setAddError(null)
              setMakeServerAfterPair(false)
              setPairingBaselineIds(new Set())
            }
          }}
        >
          <DialogTrigger
            render={<Button variant="outline" size="sm" type="button" onClick={openAddMachine} />}
          >
            Add machine
          </DialogTrigger>
          <DialogContent showCloseButton className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add a machine</DialogTitle>
              <DialogDescription>
                {code && !joinCommand && !addLoading
                  ? 'This server needs a reachable URL before it can pair a machine — set that up here.'
                  : 'Run the command below on the other machine. It installs the three supported agents and copies existing native logins from one of your online machines.'}
              </DialogDescription>
            </DialogHeader>
            {addError && <p className="settings-prose text-destructive">{addError}</p>}
            {addLoading && <p className="settings-prose">Generating pairing code…</p>}
            {code && joinCommand && (
              <PairingCodeDisplay
                code={code}
                joinCommand={joinCommand}
                publicUrl={publicUrl}
                onChangeUrl={goChangeUrl}
                podiumManaged={podiumManaged}
                onManagedChange={(managed) => void mintCode(managed)}
                recommendServer={pairingBaselineIds.size === 1}
                makeServerAfterPair={makeServerAfterPair}
                onMakeServerAfterPairChange={setMakeServerAfterPair}
                pairedMachine={newlyPairedMachine}
                onReviewPairedMachine={() => {
                  if (newlyPairedMachine) {
                    setAddOpen(false)
                    setServerTransferTarget(newlyPairedMachine)
                  }
                }}
              />
            )}
            {code && !joinCommand && !addLoading && (
              // No publicUrl yet ⇒ the server can't build a join command. Let the user set up
              // reachability right here (same flow as the CLI / first-run setup), then re-mint —
              // which now returns a full one-line join command.
              <NetworkStep embedded trpc={trpc} onSaved={() => void mintCode(podiumManaged)} />
            )}
            {code && joinCommand && (
              <DialogFooter showCloseButton>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={addLoading}
                  onClick={() => void mintCode(podiumManaged)}
                >
                  New code
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>
        {serverTransferTarget && (
          <ServerTransferDialog
            machine={serverTransferTarget}
            sourceName={sourceMachine?.name ?? 'the current server'}
            status={transferStatus.snapshot}
            statusError={transferStatus.error}
            refreshStatus={transferStatus.refresh}
            trpc={trpc}
            open
            onOpenChange={(open) => {
              if (!open) setServerTransferTarget(null)
            }}
          />
        )}
      </div>

      {hosting && !alreadyPaired && <HostThisDeviceCard hosting={hosting} />}

      {activeTransferMachine && !serverTransferTarget && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-border px-3 py-2">
          <ServerTransferProgress
            state={transferDisplayState(transferStatus.snapshot?.transfer ?? null) ?? 'preparing'}
            targetName={activeTransferMachine.name}
            detail={transferErrorMessage(transferStatus.snapshot?.transfer ?? null)}
          />
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
        <p className="settings-prose py-2">
          No machines paired yet. Click "Add machine" to get started.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
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
    // min-w-0: the dialog is a CSS grid, whose items default to min-width:auto — without this a
    // long, unbreakable URL/token pushes the whole popup wider than its max-width.
    <div className="min-w-0 space-y-3">
      {publicUrl && (
        // Show which URL the join code points at — the #1 thing that goes wrong (a throwaway
        // tunnel URL). One click to change it in Settings → Network.
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
      {/* A control that names itself and then explains itself: the same
          label-over-prose pair a settings Row makes, so this checkbox reads at
          the sheet's scale rather than a size of its own. */}
      <label className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={podiumManaged}
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
        >
          <span className="min-w-0 flex-1 text-muted-foreground">
            <strong className="text-foreground">{pairedMachine.name}</strong> is paired, and the
            server reports it is ready for transfer review.
          </span>
          <Button type="button" size="sm" className="flex-none" onClick={onReviewPairedMachine}>
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
            <Button type="button" size="sm" className="flex-none" onClick={copy}>
              {copied ? 'Copied' : 'Copy command'}
            </Button>
          )}
        </div>
        {joinCommand ? (
          // Meant to be copied, not read: keep it to a single line on a carved surface that
          // scrolls horizontally, so a long install command can't balloon and dominate the
          // dialog. The Copy button above is the real affordance; `title` exposes the full text.
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

function ServerTransferDialog({
  machine,
  sourceName,
  status,
  statusError,
  refreshStatus,
  trpc,
  open,
  onOpenChange,
}: {
  machine: MachineWire
  sourceName: string
  status: ServerTransferStatusSnapshot | null
  statusError: string | null
  refreshStatus: () => Promise<ServerTransferStatusSnapshot | null>
  trpc: Store['trpc']
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false)
  const [publicUrl, setPublicUrl] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [awaitingStatus, setAwaitingStatus] = useState(false)
  const [checkingTarget, setCheckingTarget] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)
  const isOpen = open ?? internalOpen
  const transfer = status?.transfer?.targetMachineId === machine.id ? status.transfer : null
  const transferState = transfer?.state
  const displayState = transferDisplayState(transfer)
  const showProgress = (displayState !== null && displayState !== 'aborted') || awaitingStatus

  useEffect(() => {
    if (!isOpen || (transferState && transferState !== 'aborted')) return
    setPublicUrl('')
    setConfirmation('')
    setAwaitingStatus(false)
    setTransferError(null)
    setCheckingTarget(false)
  }, [isOpen, transferState])

  const setDialogOpen = (next: boolean): void => {
    if (onOpenChange) onOpenChange(next)
    else setInternalOpen(next)
  }

  const urlIsValid = (() => {
    try {
      const parsed = new URL(publicUrl.trim())
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== ''
    } catch {
      return false
    }
  })()

  const startTransfer = async (): Promise<void> => {
    const url = publicUrl.trim()
    if (!urlIsValid || confirmation !== SERVER_TRANSFER_CONFIRMATION) return
    setAwaitingStatus(true)
    setTransferError(null)
    try {
      await trpc.machines.transferServer.mutate({
        targetMachineId: machine.id,
        publicUrl: url,
        confirmation: SERVER_TRANSFER_CONFIRMATION,
      })
      // The mutation response is only an acknowledgement. Connected is rendered
      // exclusively from the read-only status proof polled by the parent.
      await refreshStatus()
    } catch (cause) {
      const latest = await refreshStatus()
      const durable = latest?.transfer?.targetMachineId === machine.id ? latest.transfer : null
      if (!durable) {
        setAwaitingStatus(false)
        setTransferError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }

  const checkTarget = async (): Promise<void> => {
    if (!transfer || displayState !== 'commit-uncertain' || checkingTarget) return
    setCheckingTarget(true)
    setTransferError(null)
    try {
      await trpc.machines.transferServer.mutate({
        targetMachineId: machine.id,
        publicUrl: transfer.publicUrl,
        confirmation: SERVER_TRANSFER_CONFIRMATION,
      })
    } catch (cause) {
      // Keep rendering the durable uncertain state. A failed inspection is not
      // evidence that promotion aborted or that retrying the transfer is safe.
      setTransferError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      await refreshStatus()
      setCheckingTarget(false)
    }
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

        {showProgress ? (
          <ServerTransferProgress
            state={displayState ?? 'preparing'}
            targetName={machine.name}
            detail={transferErrorMessage(transfer)}
          />
        ) : (
          <div className="flex flex-col gap-3 text-[13px]">
            <label htmlFor="server-transfer-url" className="flex flex-col gap-1">
              <span className="text-muted-foreground">New public URL</span>
              <Input
                id="server-transfer-url"
                value={publicUrl}
                onChange={(event) => setPublicUrl(event.currentTarget.value)}
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
                value={confirmation}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
                aria-label="Server transfer confirmation"
                autoComplete="off"
              />
            </label>
            {publicUrl.trim() !== '' && !urlIsValid && (
              <p className="settings-prose text-destructive" role="alert">
                Enter a complete HTTP or HTTPS public URL.
              </p>
            )}
            {(transferError || statusError || transferErrorMessage(transfer)) && (
              <p className="settings-prose text-destructive" role="alert">
                {transferError ?? statusError ?? transferErrorMessage(transfer)}
              </p>
            )}
          </div>
        )}
        {showProgress && (transferError || statusError) && (
          <p className="settings-prose text-destructive" role="alert">
            {transferError ?? statusError}
          </p>
        )}

        <DialogFooter showCloseButton>
          {!showProgress && (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!urlIsValid || confirmation !== SERVER_TRANSFER_CONFIRMATION}
              onClick={() => void startTransfer()}
            >
              Transfer server
            </Button>
          )}
          {displayState === 'commit-uncertain' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={checkingTarget}
              onClick={() => void checkTarget()}
            >
              {checkingTarget ? 'Checking…' : 'Check target'}
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
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-[13.5px]">
      {/* Online/offline dot */}
      <span
        role="img"
        className={cn(
          'flex-none size-1.5 rounded-full',
          machine.online ? 'bg-success' : 'bg-muted-foreground/40',
        )}
        title={machine.online ? 'Online' : 'Offline'}
        aria-label={machine.online ? 'Online' : 'Offline'}
      />

      {/* Name — inline editable */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            className="h-6 px-1.5 text-[13.5px]"
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
            className="cursor-text truncate text-left text-foreground hover:underline"
            title="Click to rename"
            onClick={() => setEditing(true)}
          >
            {machine.name}
          </button>
        )}
      </div>

      {isThisMachine && (
        <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground uppercase tracking-wide">
          this machine
        </span>
      )}

      <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground uppercase tracking-wide">
        {machine.podiumManaged === false ? 'shared' : 'Podium-managed'}
      </span>

      {/* Hostname */}
      <span
        className="hidden max-w-[140px] flex-none truncate settings-micro sm:block"
        title={machine.hostname}
      >
        {machine.hostname}
      </span>

      {/* Daemon build version + skew badge [POD-838] */}
      {daemonVersion && (
        <span
          className="settings-micro hidden flex-none sm:block"
          title={`Podium ${daemonVersion} on this machine`}
        >
          {daemonVersion}
        </span>
      )}
      {needsUpdate && (
        <span
          className="flex-none rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning uppercase tracking-wide"
          title={`This machine runs Podium ${daemonVersion}; its selected update target is ${updateTargetVersion}.`}
        >
          update available
        </span>
      )}

      {/* Last seen */}
      <span className="settings-micro flex-none">
        {machine.online ? 'now' : relativeTime(machine.lastSeenAt, now)}
      </span>

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
        <>
          {hosting.error && (
            <span
              className="max-w-[24ch] truncate settings-micro text-destructive"
              title={hosting.error}
            >
              {hosting.error}
            </span>
          )}
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
        </>
      )}

      {(onTransferServer || serverTransferUnsupported) && (
        <>
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
          {serverTransferUnsupported && (
            <span className="settings-micro flex-none text-warning">Same version required</span>
          )}
        </>
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
                see, use and manage it; you lose all three the moment you confirm. You will not be
                able to undo this or transfer it back — only the new owner can.
                <br />
                <br />
                Everyone you have shared this machine with loses their access too: every share on{' '}
                <strong>{machine.name}</strong> is dropped, and the new owner decides who gets it
                back.
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
                <p className="settings-prose text-destructive" role="alert">
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
                  transferring || recipientId.trim() === '' || confirmName.trim() !== machine.name
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
              className="flex-none text-destructive hover:text-destructive hover:bg-destructive/10"
            />
          }
        >
          Revoke
        </DialogTrigger>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Revoke machine?</DialogTitle>
            <DialogDescription>
              "<strong>{machine.name}</strong>" ({machine.hostname}) will be disconnected and will
              need to re-pair to reconnect. Any sessions running on it will continue until they
              finish.
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
    if (busy || changingChannel || !machine.online || !targetVersion) return
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
  const targetLabel = targetVersion ? `Target ${targetVersion}` : 'Target unavailable'
  // Busy spans the whole act: the mutation round trip AND the convergence it
  // authorized. The action stays disabled for both.
  const busy = applying || converging
  const retryable = rowState === 'rejected' || rowState === 'stuck'
  const progressLabel =
    (rowState ? CONVERGENCE_PROGRESS_LABELS[rowState] : undefined) ?? 'Starting update…'

  return (
    <div
      className="flex basis-full flex-wrap items-center gap-2 border-t border-border/60 pt-2"
      data-machine-update-controls={machine.id}
    >
      <span className="settings-micro flex-none uppercase tracking-wide">Update source</span>
      {/* POD-1882: choosing a SOURCE PER MACHINE is a Podium-development affordance,
          so the control hides with the flag. What the machine is actually on stays
          readable either way — the Target chip below never hides, and Settings →
          Updates discloses every machine that is pinned away from the fleet default,
          so an override can never become invisible by turning the flag off. */}
      {developing ? (
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

      <span
        className={cn(
          'flex-none rounded px-1.5 py-0.5 text-[11px]',
          targetVersion ? 'bg-muted text-muted-foreground' : 'bg-warning/15 text-warning',
        )}
      >
        {targetLabel}
      </span>
      {busy && (
        <span
          className="flex-none settings-micro text-muted-foreground"
          role="status"
          data-machine-update-progress={machine.id}
        >
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
        disabled={busy || changingChannel || !machine.online || !targetVersion || alreadyCurrent}
        aria-busy={busy}
        aria-label={`Apply update to ${machine.name}`}
        title={
          !machine.online
            ? 'This machine must be online to apply its selected target.'
            : (unavailableReason ?? undefined)
        }
        onClick={() => void applyUpdate()}
      >
        {busy ? 'Applying…' : alreadyCurrent ? 'Current' : retryable ? 'Try again' : 'Apply'}
      </Button>

      {(unavailableReason || updateError || updateStatus) && (
        <div className="flex basis-full flex-col gap-0.5">
          {unavailableReason && (
            <span
              className="min-w-0 truncate settings-micro text-warning"
              title={unavailableReason}
            >
              {unavailableReason}
            </span>
          )}
          {updateError && (
            <span className="min-w-0 settings-micro text-destructive" role="alert">
              {updateError}
            </span>
          )}
          {updateStatus && (
            <span className="min-w-0 settings-micro text-success" role="status">
              {updateStatus}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

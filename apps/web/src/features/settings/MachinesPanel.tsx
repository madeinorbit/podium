import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import type { MachineWire, UpdateChannel } from '@podium/model'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
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
import { cn } from '@/lib/utils'
import { machineNeedsUpdate, useServerAppVersion } from '@/lib/version-skew'

/**
 * Settings → Machines panel.
 * Lists registered machines with inline rename + revoke, and an "Add machine"
 * flow that mints a pairing code and shows the daemon command to run.
 */
export function MachinesPanel(): JSX.Element {
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
  const newlyPairedMachine = makeServerAfterPair
    ? (machines.find(
        (machine) =>
          !pairingBaselineIds.has(machine.id) && machine.online && machine.owned === true,
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
                recommendServer={machines.length === 1}
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
            trpc={trpc}
            open
            onOpenChange={(open) => {
              if (!open) setServerTransferTarget(null)
            }}
          />
        )}
      </div>

      {hosting && !alreadyPaired && <HostThisDeviceCard hosting={hosting} />}

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
                m.online && m.id !== thisMachineId ? () => setServerTransferTarget(m) : null
              }
              // Inline "Enable": only on this device's own row, only while it is offline
              // (online means the daemon is already running) [spec:SP-3701].
              hosting={m.id === thisMachineId && !m.online ? hosting : null}
              onFindRepos={m.online ? () => setFindReposFor(m.id) : null}
              serverAppVersion={serverAppVersion}
            />
          ))}
        </div>
      )}

      {findReposFor && (
        <RepoScanFlow
          initialMachineId={findReposFor}
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
              For a Mac all-in-one, pair a VPS first, then review moving the server and its portable
              state to it.
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
            <strong className="text-foreground">{pairedMachine.name}</strong> is online and ready to
            review as the server.
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
  trpc,
  open,
  onOpenChange,
}: {
  machine: MachineWire
  trpc: Store['trpc']
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false)
  const [publicUrl, setPublicUrl] = useState('')
  const [loadingInfo, setLoadingInfo] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [transferError, setTransferError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'committed' | 'uncertain' | null>(null)
  const isOpen = open ?? internalOpen

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setTransferError(null)
    setOutcome(null)
    setConfirmName('')
    setLoadingInfo(true)
    void trpc.setup.info
      .query()
      .then((info) => {
        if (!cancelled) setPublicUrl(info.publicUrl ?? '')
      })
      .catch((error) => {
        if (!cancelled) {
          setPublicUrl('')
          setTransferError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingInfo(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, trpc])

  const setDialogOpen = (next: boolean): void => {
    if (onOpenChange) onOpenChange(next)
    else setInternalOpen(next)
  }

  const transfer = async (): Promise<void> => {
    const url = publicUrl.trim()
    if (!url || confirmName.trim() !== machine.name) return
    setTransferring(true)
    setTransferError(null)
    try {
      const result = await trpc.machines.transferServer.mutate({
        targetMachineId: machine.id,
        publicUrl: url,
        confirmation: true,
      })
      const reply = result as { state?: string; error?: string }
      if (reply.state === 'committed') {
        setOutcome('committed')
        setConfirmName('')
      } else {
        setOutcome('uncertain')
        setTransferError(
          reply.error ??
            'The target did not prove promotion. Do not retry until the target is inspected.',
        )
      }
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : String(error))
    } finally {
      setTransferring(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setDialogOpen}>
      {open === undefined && (
        <DialogTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-none"
              disabled={!machine.online || machine.owned !== true}
            />
          }
        >
          Make server
        </DialogTrigger>
      )}
      <DialogContent showCloseButton className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Make {machine.name} the server?</DialogTitle>
          <DialogDescription>
            Podium copies only portable server state to this machine. It stays a daemon until every
            file validates; the current server remains in place if staging fails. Promotion can only
            finish after the target proves it became the server.
          </DialogDescription>
        </DialogHeader>
        {outcome === 'committed' ? (
          <p
            className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-[12px]"
            role="status"
          >
            Transfer committed. {machine.name} is taking over and this server will reconnect as a
            daemon.
          </p>
        ) : (
          <div className="flex flex-col gap-3 text-[13px]">
            <label htmlFor="server-transfer-url" className="flex flex-col gap-1">
              <span className="text-muted-foreground">Reachable server URL</span>
              <Input
                id="server-transfer-url"
                value={publicUrl}
                disabled={transferring || loadingInfo}
                onChange={(event) => setPublicUrl(event.currentTarget.value)}
                aria-label="Reachable server URL"
                placeholder="https://podium.example.com"
              />
              <span className="text-[11px] text-muted-foreground">
                Keep this stable URL if clients should reconnect without another setup.
              </span>
            </label>
            <label htmlFor="server-transfer-name" className="flex flex-col gap-1">
              <span className="text-muted-foreground">
                Type <strong>{machine.name}</strong> to confirm
              </span>
              <Input
                id="server-transfer-name"
                value={confirmName}
                disabled={transferring}
                onChange={(event) => setConfirmName(event.currentTarget.value)}
                aria-label="Type the target machine name to confirm"
              />
            </label>
            {transferError && (
              <p className="text-destructive text-[12px]" role="alert">
                {transferError}
              </p>
            )}
          </div>
        )}
        {outcome === 'uncertain' && (
          <p className="text-[12px] text-warning">
            The source has stopped before it could prove the final handoff. Inspect the target and
            transfer journal before retrying.
          </p>
        )}
        <DialogFooter showCloseButton>
          {outcome !== 'committed' && (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={
                transferring ||
                loadingInfo ||
                publicUrl.trim() === '' ||
                confirmName.trim() !== machine.name
              }
              onClick={() => void transfer()}
            >
              {transferring ? 'Transferring...' : 'Transfer server'}
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
  serverAppVersion = null,
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
  /** POD-838: the server's own build version; null while unknown. */
  serverAppVersion?: string | null
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

  // POD-838: surface protocol skew — see machineNeedsUpdate for the rules.
  const daemonVersion = machine.inventory?.podiumVersion
  const needsUpdate = machineNeedsUpdate(machine, serverAppVersion)

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
  const mayTransfer = machine.owned === true

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
          title={`This machine runs Podium ${daemonVersion}; the server is on ${serverAppVersion}. Update the daemon (podium update).`}
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

      {onTransferServer && machine.owned === true && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-none"
          onClick={onTransferServer}
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

      {machine.podiumManaged !== false && <MachineUpdateControls machine={machine} trpc={trpc} />}
    </div>
  )
}

const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
  dev: 'Development',
  edge: 'Edge',
  stable: 'Stable',
}

/**
 * A channel choice changes only this machine's durable update authority. Applying
 * is deliberately separate: it issues one convergence grant after the selected
 * authority has resolved a concrete trusted target.
 */
function MachineUpdateControls({
  machine,
  trpc,
}: {
  machine: MachineWire
  trpc: Store['trpc']
}): JSX.Element {
  const [channel, setChannel] = useState<UpdateChannel>(machine.updateChannel ?? 'stable')
  const [targetVersion, setTargetVersion] = useState<string | null>(machine.targetVersion ?? null)
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    machine.targetUnavailableReason ?? null,
  )
  const [changingChannel, setChangingChannel] = useState(false)
  const [applying, setApplying] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<string | null>(null)

  useEffect(() => {
    setChannel(machine.updateChannel ?? 'stable')
    setTargetVersion(machine.targetVersion ?? null)
    setUnavailableReason(machine.targetUnavailableReason ?? null)
  }, [machine.updateChannel, machine.targetVersion, machine.targetUnavailableReason])

  const adoptMachine = (machines: readonly MachineWire[]): boolean => {
    const updated = machines.find((candidate) => candidate.id === machine.id)
    if (!updated) return false
    setChannel(updated.updateChannel ?? 'stable')
    setTargetVersion(updated.targetVersion ?? null)
    setUnavailableReason(updated.targetUnavailableReason ?? null)
    return true
  }

  const chooseChannel = async (nextChannel: UpdateChannel): Promise<void> => {
    if (nextChannel === channel || changingChannel || applying) return
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
    if (applying || changingChannel || !machine.online || !targetVersion) return
    setApplying(true)
    setUpdateError(null)
    setUpdateStatus(null)
    try {
      const result = await trpc.machines.applyUpdate.mutate({ id: machine.id })
      adoptMachine(result.machines)
      if (result.grantedMachineIds.includes(machine.id)) {
        setUpdateStatus(`Update authorized for ${machine.name}.`)
      } else {
        setUpdateError('The coordinator did not issue a new update grant for this machine.')
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

  return (
    <div
      className="flex basis-full flex-wrap items-center gap-2 border-t border-border/60 pt-2"
      data-machine-update-controls={machine.id}
    >
      <span className="settings-micro flex-none uppercase tracking-wide">Update source</span>
      <Select
        value={channel}
        disabled={changingChannel || applying}
        onValueChange={(value) => void chooseChannel(value as UpdateChannel)}
      >
        <SelectTrigger
          size="sm"
          className="w-[132px] flex-none"
          aria-label={`Update channel for ${machine.name}`}
        >
          <SelectValue>{UPDATE_CHANNEL_LABELS[channel]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="dev">Development</SelectItem>
          <SelectItem value="edge">Edge</SelectItem>
          <SelectItem value="stable">Stable</SelectItem>
        </SelectContent>
      </Select>

      <span
        className={cn(
          'flex-none rounded px-1.5 py-0.5 text-[11px]',
          targetVersion ? 'bg-muted text-muted-foreground' : 'bg-warning/15 text-warning',
        )}
      >
        {targetLabel}
      </span>
      {unavailableReason && (
        <span
          className="min-w-0 max-w-[48ch] flex-1 truncate settings-micro text-warning"
          title={unavailableReason}
        >
          {unavailableReason}
        </span>
      )}
      {updateError && (
        <span className="min-w-0 flex-1 settings-micro text-destructive" role="alert">
          {updateError}
        </span>
      )}
      {updateStatus && (
        <span className="min-w-0 flex-1 settings-micro text-success" role="status">
          {updateStatus}
        </span>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="flex-none"
        disabled={
          applying || changingChannel || !machine.online || !targetVersion || alreadyCurrent
        }
        aria-label={`Apply update to ${machine.name}`}
        title={
          !machine.online
            ? 'This machine must be online to apply its selected target.'
            : (unavailableReason ?? undefined)
        }
        onClick={() => void applyUpdate()}
      >
        {applying ? 'Applying…' : alreadyCurrent ? 'Current' : 'Apply'}
      </Button>
    </div>
  )
}

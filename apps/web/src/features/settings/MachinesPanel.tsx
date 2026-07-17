import { shallowEqual } from '@podium/client-core/store'
import type { MachineWire } from '@podium/protocol'
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
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import { NetworkStep } from '@/features/setup/SetupView'
import { relativeTime } from '@/lib/home'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { cn } from '@/lib/utils'

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

  // [spec:SP-3701] Hosting affordances (desktop shell, client mode only). A device that
  // paired before gets the inline "Enable" action on its own machine row; the standalone
  // card is for never-paired devices only.
  const hosting = useEnableHosting(trpc)
  const thisMachineId = nativeDesktopBridge()?.machineId
  const alreadyPaired = thisMachineId != null && machines.some((m) => m.id === thisMachineId)
  // Per-machine "Find repos" (POD-787): opens the scan flow preset to that machine.
  const [findReposFor, setFindReposFor] = useState<string | null>(null)

  // Tick so relative times stay fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const mintCode = async () => {
    setAddLoading(true)
    setAddError(null)
    try {
      const [r, info] = await Promise.all([
        trpc.machines.pairingCode.mutate(),
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

  // Jump to Settings → Network to change the server's reachable URL.
  const goChangeUrl = (): void => {
    setAddOpen(false)
    setSettingsTab('network')
  }

  return (
    <div className="py-3">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="font-medium text-[13px] text-foreground">Machines</h3>
          <p className="mt-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
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
            }
          }}
        >
          <DialogTrigger
            render={
              <Button variant="outline" size="sm" type="button" onClick={() => void mintCode()} />
            }
          >
            Add machine
          </DialogTrigger>
          <DialogContent showCloseButton>
            <DialogHeader>
              <DialogTitle>Add a machine</DialogTitle>
              <DialogDescription>
                {code && !joinCommand && !addLoading
                  ? 'This server needs a reachable URL before it can pair a machine — set that up here.'
                  : 'Run the command below on the other machine to pair it with this Podium server.'}
              </DialogDescription>
            </DialogHeader>
            {addError && <p className="text-destructive text-xs">{addError}</p>}
            {addLoading && (
              <p className="text-muted-foreground text-xs">Generating pairing code…</p>
            )}
            {code && joinCommand && (
              <PairingCodeDisplay
                code={code}
                joinCommand={joinCommand}
                publicUrl={publicUrl}
                onChangeUrl={goChangeUrl}
              />
            )}
            {code && !joinCommand && !addLoading && (
              // No publicUrl yet ⇒ the server can't build a join command. Let the user set up
              // reachability right here (same flow as the CLI / first-run setup), then re-mint —
              // which now returns a full one-line join command.
              <NetworkStep embedded trpc={trpc} onSaved={() => void mintCode()} />
            )}
            {code && joinCommand && (
              <DialogFooter showCloseButton>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={addLoading}
                  onClick={() => void mintCode()}
                >
                  New code
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {hosting && !alreadyPaired && <HostThisDeviceCard hosting={hosting} />}

      {machines.length === 0 ? (
        <p className="py-2 text-[12px] text-muted-foreground">
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
              // Inline "Enable": only on this device's own row, only while it is offline
              // (online means the daemon is already running) [spec:SP-3701].
              hosting={m.id === thisMachineId && !m.online ? hosting : null}
              onFindRepos={m.online ? () => setFindReposFor(m.id) : null}
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
        <div className="text-[13px] text-foreground">This device</div>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
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
}: {
  code: string
  joinCommand: string | null
  publicUrl?: string | null
  onChangeUrl?: () => void
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
    <div className="min-w-0 space-y-2">
      {publicUrl && (
        // Show which URL the join code points at — the #1 thing that goes wrong (a throwaway
        // tunnel URL). One click to change it in Settings → Network.
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Server URL this code points at
          </span>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-[12px]">
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
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          Pairing code
        </span>
        <code className="block rounded bg-muted px-2 py-1 font-mono text-[13px] tracking-widest">
          {code}
        </code>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          Command to run on the other machine
        </span>
        {joinCommand ? (
          <div className="flex items-start gap-2">
            <code className="flex-1 break-all rounded bg-muted px-2 py-1.5 text-[11px] leading-relaxed">
              {joinCommand}
            </code>
            <Button type="button" variant="outline" size="sm" className="flex-none" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            Finish setup to get a one-line join command.
          </p>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The code expires after one use or 10 minutes.
      </p>
    </div>
  )
}

function MachineRow({
  machine,
  now,
  trpc,
  isThisMachine = false,
  hosting = null,
  onFindRepos = null,
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
}): JSX.Element {
  const [name, setName] = useState(machine.name)
  const [editing, setEditing] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)

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

  const revoke = async () => {
    setRevoking(true)
    try {
      await trpc.machines.revoke.mutate({ id: machine.id })
    } finally {
      setRevoking(false)
      setRevokeOpen(false)
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
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
            className="h-6 px-1.5 text-[13px]"
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
        <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
          this machine
        </span>
      )}

      {/* Hostname */}
      <span
        className="hidden flex-none max-w-[140px] truncate text-muted-foreground text-[12px] sm:block"
        title={machine.hostname}
      >
        {machine.hostname}
      </span>

      {/* Last seen */}
      <span className="flex-none text-muted-foreground/70 text-[11px]">
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
              className="max-w-[24ch] truncate text-[11px] text-destructive"
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
    </div>
  )
}

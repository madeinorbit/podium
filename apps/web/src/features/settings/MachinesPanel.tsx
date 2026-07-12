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
import { NetworkStep } from '@/features/setup/SetupView'
import { relativeTime } from '@/lib/home'
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

      {machines.length === 0 ? (
        <p className="py-2 text-[12px] text-muted-foreground">
          No machines paired yet. Click "Add machine" to get started.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {machines.map((m) => (
            <MachineRow key={m.id} machine={m} now={now} trpc={trpc} />
          ))}
        </div>
      )}
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
}: {
  machine: MachineWire
  now: number
  trpc: Store['trpc']
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

import type { PodiumMode } from '@podium/core'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'

const MODES: { id: PodiumMode; title: string; blurb: string; needsServer: boolean }[] = [
  {
    id: 'all-in-one',
    title: 'All-in-one (this computer)',
    blurb: 'Run the server + agent daemon here.',
    needsServer: false,
  },
  {
    id: 'daemon',
    title: 'Daemon → external server',
    blurb: 'Contribute this machine to a server elsewhere.',
    needsServer: true,
  },
  {
    id: 'client',
    title: 'Client → external server',
    blurb: 'Just connect to a server running elsewhere.',
    needsServer: true,
  },
  {
    id: 'server',
    title: 'Server only',
    blurb: 'Run the relay here; daemons live elsewhere.',
    needsServer: false,
  },
]

export function SetupView({
  httpOrigin,
  onSaved,
}: {
  httpOrigin: string
  onSaved: () => void
}): ReactNode {
  const [mode, setMode] = useState<PodiumMode>('all-in-one')
  const [serverUrl, setServerUrl] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needsServer = MODES.find((m) => m.id === mode)?.needsServer ?? false
  // Only daemon mode pairs a fresh machine; client mode just connects.
  const needsPair = mode === 'daemon'

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const body = needsServer
        ? needsPair
          ? { mode, serverUrl, pairCode }
          : { mode, serverUrl }
        : { mode }
      const res = await fetch(`${httpOrigin}/setup/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`setup failed (${res.status})`)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-5">
      <section className="flex w-[min(520px,100%)] flex-col gap-4 rounded-md border border-border bg-card p-5">
        <div>
          <h1 className="m-0 text-[22px] font-medium text-foreground">Welcome to Podium</h1>
          <p className="mt-1 mb-0 text-muted-foreground">How should this install run?</p>
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          {MODES.map((m) => (
            <label
              key={m.id}
              htmlFor={`mode-${m.id}`}
              className={`flex cursor-pointer gap-3 rounded-md border p-3 ${
                mode === m.id ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <input
                type="radio"
                name="mode"
                value={m.id}
                id={`mode-${m.id}`}
                checked={mode === m.id}
                onChange={() => setMode(m.id)}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <strong className="text-[13px] font-medium text-foreground">{m.title}</strong>
                <span className="text-xs text-muted-foreground">{m.blurb}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {needsServer && (
          <div className="flex flex-col gap-1">
            <label htmlFor="server-url" className="text-xs text-muted-foreground">
              Server URL
            </label>
            <input
              id="server-url"
              type="text"
              placeholder="ws://host:18787"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground"
            />
          </div>
        )}
        {needsPair && (
          <div className="flex flex-col gap-1">
            <label htmlFor="pair-code" className="text-xs text-muted-foreground">
              Pairing code
            </label>
            <input
              id="pair-code"
              type="text"
              placeholder="from the server's Machines settings"
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground"
            />
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save & start'}
          </Button>
        </div>
      </section>
    </main>
  )
}

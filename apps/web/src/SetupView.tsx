import type { PodiumMode } from '@podium/core'
import { type ReactNode, useState } from 'react'

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
    <div className="setup-view">
      <h1>Welcome to Podium</h1>
      <p>How should this install run?</p>
      <fieldset>
        {MODES.map((m) => (
          <div key={m.id} className="mode-option">
            <input
              type="radio"
              name="mode"
              value={m.id}
              id={`mode-${m.id}`}
              checked={mode === m.id}
              onChange={() => setMode(m.id)}
            />
            <label htmlFor={`mode-${m.id}`}>
              <strong>{m.title}</strong>
              <span className="blurb">{m.blurb}</span>
            </label>
          </div>
        ))}
      </fieldset>
      {needsServer && (
        <div>
          <label htmlFor="server-url">Server URL</label>
          <input
            id="server-url"
            type="text"
            placeholder="ws://host:18787"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </div>
      )}
      {needsPair && (
        <div>
          <label htmlFor="pair-code">Pairing code</label>
          <input
            id="pair-code"
            type="text"
            placeholder="from the server's Machines settings"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value)}
          />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save & start'}
      </button>
    </div>
  )
}

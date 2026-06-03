import { useState } from 'react'
import type { JSX } from 'react'

export function ConnectScreen({ onConnect }: { onConnect: (origin: string) => void }): JSX.Element {
  const [draft, setDraft] = useState('ws://localhost:8787')
  return (
    <div className="connect">
      <h1>Podium</h1>
      <label>
        <span>Relay server</span>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <button type="button" onClick={() => onConnect(draft)}>Connect</button>
    </div>
  )
}

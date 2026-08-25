/**
 * THE SHELL'S KEYBOARD, IN A REAL BROWSER (POD-1532).
 *
 * The unit tests dispatch synthetic KeyboardEvents, which prove the ROUTING but
 * not the delivery: whether a WebKit webview — the engine the Linux shell runs
 * on — hands `Ctrl+W`, `Ctrl+,` and `Ctrl+Alt+F` to the page at all, or eats
 * them the way the macOS menu bar eats an unclaimed accelerator. That is the
 * boundary this change is about, and it is not one a jsdom test can answer.
 *
 * So this mounts the REAL `DesktopMenuHost` behind a faked `__PODIUM_DESKTOP__`
 * bridge, publishes stub handlers for the commands whose owners live deeper in
 * the app (the workspace's Close Tab, the focused panel's two session
 * commands), and writes down every command that fires. `?platform=linux` (the
 * default) or `?platform=macos` picks the modifier grammar.
 *
 * The FAKE TERMINAL is not decoration. Off Apple the shell's chords are the
 * terminal's control codes, and the rule that keeps `Ctrl+B` as tmux's prefix
 * only holds if a real focus inside `.xterm` is seen by a real listener.
 *
 * NO `index.css`. The shell's stylesheet pulls font packages that are not
 * installed in every worktree, and this page has nothing to measure — the
 * styles below are inline and only need to make the readout legible.
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopMenuHost } from '@/app/DesktopMenuHost'
import {
  commandShortcutLabel,
  DESKTOP_COMMANDS,
  installDesktopCommandHook,
} from '@/app/desktop-commands'

const params = new URLSearchParams(window.location.search)
const platform = params.get('platform') === 'macos' ? 'macos' : 'linux'
;(globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__ = {
  platform,
  minimize: () => Promise.resolve(),
  toggleMaximize: () => Promise.resolve(),
  close: () => Promise.resolve(),
}

const SURFACE = {
  background: '#0e0e12',
  color: '#e7e7ea',
  font: '13px/1.5 ui-sans-serif, system-ui, sans-serif',
}
const HEADING = { fontSize: 13, fontWeight: 600, margin: '0 0 8px' }
const ROW = { display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0' }
const BOX = {
  minHeight: 120,
  margin: 0,
  padding: 8,
  border: '1px solid #33333c',
  borderRadius: 6,
  fontFamily: 'monospace',
}
const TERMINAL = {
  ...BOX,
  minHeight: 90,
  marginTop: 8,
  background: '#000',
  color: '#5ee07a',
  outlineOffset: 2,
}

/** One row of either readout. The counter is the key: the same command fires
 *  and the same chord arrives more than once, and the list index would move
 *  entries under React as the log grows. */
interface Entry {
  n: number
  text: string
}

let counter = 0
const entry = (text: string): Entry => ({ n: ++counter, text })

function Harness(): JSX.Element {
  const [log, setLog] = useState<Entry[]>([])
  const [delivered, setDelivered] = useState<Entry[]>([])
  // Stable across renders, so the hook-publishing effect below can run once.
  const fired = useCallback((id: string): void => setLog((prev) => [...prev, entry(id)]), [])

  // DELIVERY IS A SEPARATE FACT FROM DISPATCH, and it is the one only a real
  // engine can answer: whether WebKit hands `Ctrl+W` to the page or keeps it,
  // the way the macOS menu bar keeps an accelerator no item claims. A command
  // may legitimately decline (`Close Tab` with no tab open) — that shows up as
  // a delivery with no matching row under `Fired`, which is exactly the
  // distinction worth being able to see.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      const mods = [
        event.ctrlKey ? 'Ctrl' : '',
        event.metaKey ? 'Super' : '',
        event.altKey ? 'Alt' : '',
        event.shiftKey ? 'Shift' : '',
      ].filter(Boolean)
      if (event.key === 'Control' || event.key === 'Meta') return
      setDelivered((prev) => [...prev, entry([...mods, event.key.toUpperCase()].join('+'))])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The commands whose real owners are the workspace and the focused session
  // panel. Publishing them here is what the harness stands in for.
  useEffect(() => {
    const stubs = (['close-tab', 'focus-session-prompt', 'toggle-session-view'] as const).map(
      (id) =>
        installDesktopCommandHook(id, () => {
          fired(id)
        }),
    )
    return () => {
      for (const uninstall of stubs) uninstall()
    }
  }, [fired])

  return (
    <div style={{ ...SURFACE, display: 'flex', gap: 24, minHeight: '100vh', padding: 24 }}>
      <DesktopMenuHost
        openSettings={() => fired('open-settings')}
        toggleLeftSidebar={() => fired('toggle-left-sidebar')}
        toggleFlightDeck={() => fired('toggle-flight-deck')}
        toggleRightSidebar={() => fired('toggle-right-sidebar')}
      />
      <section style={{ width: 340 }}>
        <h1 style={HEADING}>Commands on {platform}</h1>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="chord-table">
          {DESKTOP_COMMANDS.map((command) => (
            <li key={command.id} style={ROW} data-command={command.id}>
              <span>{command.label}</span>
              <span style={{ fontFamily: 'monospace', opacity: 0.75 }} data-chord={command.id}>
                {commandShortcutLabel(command.id) ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section style={{ flex: 1 }}>
        <h2 style={HEADING}>Fired</h2>
        <ol style={BOX} data-testid="fired">
          {log.map((row) => (
            <li key={row.n}>{row.text}</li>
          ))}
        </ol>
        <h2 style={HEADING}>Delivered to the page</h2>
        <ol style={BOX} data-testid="delivered">
          {delivered.map((row) => (
            <li key={row.n}>{row.text}</li>
          ))}
        </ol>
        <h2 style={HEADING}>Fake terminal (click to focus)</h2>
        {/* A textarea, because xterm's own focus target is one: the guard reads
            `closest('.xterm')` from the FOCUSED element, and a div that merely
            looks like a terminal would not be focused by a click the way the
            real thing is. */}
        <textarea
          className="xterm"
          style={TERMINAL}
          data-testid="terminal"
          aria-label="Fake terminal"
          readOnly
          value="$ the control range belongs to this box"
        />
      </section>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)

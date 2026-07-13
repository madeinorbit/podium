import { Box, Text, useApp, useStdin } from 'ink'
import { useCallback, useEffect, useReducer, useState } from 'react'
import type { InputEvent } from './events.js'
import { formatEvent } from './events.js'
import { useInkSource } from './sources/ink.js'
import { attachRawSource } from './sources/raw.js'
import type { Mode } from './sources/types.js'

const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h'
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l'
const ANYMOTION_ON = '\x1b[?1003h'
const ANYMOTION_OFF = '\x1b[?1003l'
const MAX_LOG = 500
const MODES: Mode[] = ['raw', 'ink', 'both']
/** Deterministic Ctrl+Y OSC 52 payload; e2e specs assert it reaches the clipboard. */
export const OSC52_PAYLOAD = 'keyecho osc52 payload'

type LogAction = { type: 'add'; e: InputEvent } | { type: 'clear' }

function logReducer(state: InputEvent[], action: LogAction): InputEvent[] {
  if (action.type === 'clear') return []
  const next = state.length >= MAX_LOG ? state.slice(state.length - MAX_LOG + 1) : state
  return [...next, action.e]
}

export function App({ mode: initialMode, lock }: { mode: Mode; lock: boolean }) {
  const { stdin, setRawMode } = useStdin()
  const { exit } = useApp()
  const [mode, setMode] = useState<Mode>(initialMode)
  const [anyMotion, setAnyMotion] = useState(false)
  const [log, dispatch] = useReducer(logReducer, [])

  const primary: 'raw' | 'ink' = mode === 'ink' ? 'ink' : 'raw'

  const handleHotkey = useCallback(
    (e: InputEvent) => {
      if (lock || e.source !== primary || e.kind !== 'key') return
      if (e.ctrl && e.name === 'q') exit()
      else if (e.name === 'f2') setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length] as Mode)
      else if (e.name === 'f3') setAnyMotion((v) => !v)
      else if (e.name === 'f4') dispatch({ type: 'clear' })
      // Emit an OSC 52 clipboard write, the way an agent's "copy to clipboard"
      // does — lets e2e specs assert the sequence survives the full PTY chain.
      else if (e.ctrl && e.name === 'y')
        process.stdout.write(`\x1b]52;c;${Buffer.from(OSC52_PAYLOAD).toString('base64')}\x07`)
    },
    [lock, primary, exit],
  )

  const emit = useCallback(
    (e: InputEvent) => {
      dispatch({ type: 'add', e })
      handleHotkey(e)
    },
    [handleHotkey],
  )

  // Raw source + raw mode + mouse enable, when the mode includes raw.
  useEffect(() => {
    setRawMode(true)
    const wantsRaw = mode === 'raw' || mode === 'both'
    let detach = () => {}
    // Re-assert mouse tracking on every resize, the way real TUIs do on SIGWINCH.
    // A one-shot enable at startup can be lost when a fresh Podium session attaches:
    // the bytes reach xterm while it is still settling its grid (open → fit → resize →
    // clear), so the mode-set does not stick. The controller's fit resize then gives us
    // a SIGWINCH to re-enable onto a now-stable terminal. (Bracketed paste survives
    // without this only because Ink re-emits it on every render.)
    const enableMouse = (): boolean => process.stdout.write(MOUSE_ON)
    if (wantsRaw) {
      enableMouse()
      process.stdout.on('resize', enableMouse)
      detach = attachRawSource(stdin, emit)
    }
    return () => {
      detach()
      if (wantsRaw) {
        process.stdout.off('resize', enableMouse)
        process.stdout.write(MOUSE_OFF)
      }
    }
  }, [mode, stdin, setRawMode, emit])

  useEffect(() => {
    process.stdout.write(anyMotion ? ANYMOTION_ON : ANYMOTION_OFF)
  }, [anyMotion])

  useInkSource(emit, mode === 'ink' || mode === 'both')

  const rows = (process.stdout.rows ?? 24) - 4
  const visible = log.slice(Math.max(0, log.length - rows))

  return (
    <Box flexDirection="column">
      <Text>
        keyecho · mode=<Text color="cyan">{mode}</Text> · mouse=
        {anyMotion ? 'all-motion' : 'click+drag'} · {lock ? 'LOCKED' : 'hotkeys on'} · events=
        {log.length}
      </Text>
      <Box flexDirection="column">
        {visible.map((e) => (
          <Text key={`${e.seq}-${e.source}`} color={e.source === 'raw' ? 'green' : 'magenta'}>
            {formatEvent(e)}
          </Text>
        ))}
      </Box>
      {!lock && (
        <Text dimColor>Ctrl+Q quit · F2 mode · F3 mouse-motion · F4 clear · Ctrl+Y osc52</Text>
      )}
    </Box>
  )
}

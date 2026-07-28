import { keySequence, type MountedSession, type SpecialKey } from '@podium/terminal-client'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { useEffect, useState } from 'react'
import { ArrowSwipeKey } from './ArrowSwipeKey'
import { useVoiceInput } from './use-voice-input'

export interface MobileTerminalKeyboardTheme {
  bar: string
  card: string
  border: string
  muted: string
  accent: string
  onAccent: string
  danger: string
  fontFamily?: string
}

export interface MobileTerminalKeyboardProps {
  mountedRef: RefObject<MountedSession | null>
  toolbarRef: RefObject<HTMLDivElement | null>
  ready: boolean
  hidden?: boolean
  voiceIcon?: ReactNode
  theme?: MobileTerminalKeyboardTheme
}

/**
 * The complete pre-redesign mobile terminal accessory, now shared with Expo:
 * submit/newline/paste/voice, the accelerated swipe D-pad, and the terminal
 * client's scrollable key groups with one-shot Ctrl.
 */
export function MobileTerminalKeyboard({
  mountedRef,
  toolbarRef,
  ready,
  hidden = false,
  voiceIcon,
  theme,
}: MobileTerminalKeyboardProps) {
  const voice = useVoiceInput((text) => mountedRef.current?.connection.sendInput(`${text} `))
  const keyboardOpen = useSoftKeyboardOpen()
  const inactive = !ready || hidden
  const sendKey = (key: SpecialKey) => {
    mountedRef.current?.connection.sendInput(keySequence(key))
  }
  const vars = theme
    ? ({
        '--mtk-bar': theme.bar,
        '--mtk-card': theme.card,
        '--mtk-border': theme.border,
        '--mtk-muted': theme.muted,
        '--mtk-accent': theme.accent,
        '--mtk-on-accent': theme.onAccent,
        '--mtk-danger': theme.danger,
        '--mtk-font': theme.fontFamily ?? 'ui-monospace, Menlo, monospace',
        '--kb-open': keyboardOpen ? 1 : 0,
      } as CSSProperties)
    : ({ '--kb-open': keyboardOpen ? 1 : 0 } as CSSProperties)

  return (
    <div className="mobile-terminal-keyboard" style={vars} aria-hidden={inactive || undefined}>
      <style>{MOBILE_TERMINAL_KEYBOARD_CSS}</style>
      <div
        className={inactive ? 'key-actions kb-hidden' : 'key-actions'}
        onPointerDown={(event) => event.preventDefault()}
      >
        <button
          data-pressable
          type="button"
          className="key-act key-submit"
          title="Submit — send the prompt (Enter)"
          aria-label="Submit — send the prompt (Enter)"
          onClick={() => mountedRef.current?.connection.sendInput('\r')}
        >
          ⏎ Submit
        </button>
        <button
          data-pressable
          type="button"
          className="key-act"
          title="Newline — insert a line break without submitting (Option+Enter)"
          aria-label="Newline — insert a line break without submitting (Option+Enter)"
          onClick={() => mountedRef.current?.connection.sendInput('\x1b\r')}
        >
          Newline
        </button>
        <button
          data-pressable
          type="button"
          className="key-act"
          title="Paste — insert clipboard text at the prompt"
          aria-label="Paste — insert clipboard text at the prompt"
          onClick={() => void mountedRef.current?.view.requestPaste()}
        >
          Paste
        </button>
        <ArrowSwipeKey onFire={sendKey} />
        {voice.supported ? (
          <button
            data-pressable
            type="button"
            className={voice.listening ? 'key-mic active' : 'key-mic'}
            title={voice.listening ? 'Stop voice input' : 'Voice input — speaks into the terminal'}
            aria-label={
              voice.listening ? 'Stop voice input' : 'Voice input — speaks into the terminal'
            }
            onClick={voice.toggle}
          >
            {voiceIcon ?? '🎙'}
          </button>
        ) : null}
      </div>
      <div ref={toolbarRef} className={inactive ? 'toolbar kb-hidden' : 'toolbar'} />
    </div>
  )
}

function useSoftKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => setOpen(window.innerHeight - viewport.height > 100)
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  return open
}

const MOBILE_TERMINAL_KEYBOARD_CSS = `
.mobile-terminal-keyboard { flex: 0 0 auto; min-width: 0; }
.mobile-terminal-keyboard .toolbar {
  display: flex; flex-shrink: 0; align-items: center; gap: 5px;
  padding: 4px 8px calc(8px + (1 - var(--kb-open, 0)) * env(safe-area-inset-bottom, 0px));
  background: var(--mtk-bar, var(--bar)); border-top: 1px solid var(--mtk-border, var(--hairline-soft));
  overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain; touch-action: pan-x; scrollbar-width: none;
}
.mobile-terminal-keyboard .toolbar::-webkit-scrollbar { display: none; }
.mobile-terminal-keyboard .toolbar .key {
  flex: 0 0 auto; min-width: 32px; height: 30px; padding: 0 9px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--mtk-card, var(--card)); border: 1px solid var(--mtk-border, var(--hairline-bar));
  border-radius: 6px; color: var(--mtk-muted, var(--muted-foreground));
  font: 11px / 1 var(--mtk-font, var(--font-mono, ui-monospace, monospace));
  font-variant-numeric: tabular-nums; cursor: pointer; user-select: none;
  -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
  touch-action: manipulation; transition: background 0.06s ease;
}
.mobile-terminal-keyboard .toolbar .key:active,
.mobile-terminal-keyboard .toolbar .key.mod.armed {
  background: var(--mtk-accent, var(--primary)); border-color: var(--mtk-accent, var(--primary));
  color: var(--mtk-on-accent, var(--attention-foreground));
}
.mobile-terminal-keyboard .toolbar .key-sep {
  flex: 0 0 auto; align-self: center; width: 1px; height: 18px; margin: 0 2px;
  background: var(--mtk-border, var(--hairline-bar));
}
.mobile-terminal-keyboard .key-actions {
  display: flex; flex-shrink: 0; align-items: center; gap: 5px; padding: 6px 8px 2px;
  background: var(--mtk-bar, var(--bar)); border-top: 1px solid var(--mtk-border, var(--hairline-bar));
}
.mobile-terminal-keyboard .key-actions:not(:has(.key-mic)) { padding-right: 48px; }
.mobile-terminal-keyboard .key-actions.kb-hidden,
.mobile-terminal-keyboard .toolbar.kb-hidden { display: none; }
.mobile-terminal-keyboard .key-act {
  flex: 1 1 0; min-width: 0; height: 30px; display: inline-flex;
  align-items: center; justify-content: center; background: var(--mtk-card, var(--card));
  border: 1px solid var(--mtk-border, var(--hairline-bar)); border-radius: 6px;
  color: var(--mtk-muted, var(--muted-foreground)); font: inherit; font-size: 12px;
  cursor: pointer; user-select: none; -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
}
.mobile-terminal-keyboard .key-act.key-submit { color: #e8c477; }
.mobile-terminal-keyboard .key-act:active {
  background: var(--mtk-accent, var(--primary)); border-color: var(--mtk-accent, var(--primary));
  color: var(--mtk-on-accent, var(--attention-foreground));
}
.mobile-terminal-keyboard .key-mic {
  flex: 0 0 auto; width: 36px; height: 30px; display: inline-flex;
  align-items: center; justify-content: center; background: var(--mtk-card, var(--card));
  border: 1px solid var(--mtk-border, var(--hairline-bar)); border-radius: 6px;
  color: var(--mtk-muted, var(--muted-foreground)); cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.mobile-terminal-keyboard .key-mic.active {
  color: var(--mtk-danger, var(--destructive)); border-color: var(--mtk-danger, var(--destructive));
  animation: mobile-terminal-voice-pulse 1.2s ease-in-out infinite;
}
@keyframes mobile-terminal-voice-pulse { 50% { opacity: 0.35; } }
`

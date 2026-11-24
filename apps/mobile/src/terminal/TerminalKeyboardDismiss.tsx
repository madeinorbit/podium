import type { RefObject } from 'react'

/** The terminal page keeps its own input row after hiding WKWebView's accessory. */
export function TerminalKeyboardDismiss({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>
}) {
  return (
    <button
      data-pressable
      type="button"
      className="key-act terminal-hide-keyboard"
      title="Hide Keyboard"
      aria-label="Hide Keyboard"
      // Safari also synthesizes mousedown after the row's guarded pointerdown.
      // Keep xterm focused until activation, then explicitly end editing.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() =>
        containerRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.blur()
      }
      style={{
        flex: '0 0 36px',
        width: 36,
        height: 30,
        padding: 0,
        position: 'relative',
        zIndex: 2,
      }}
    >
      {/* Match the other keycaps while keeping a 44pt touch target in the row's gaps. */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: 44,
          height: 44,
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* DOM drawing of the keyboard.chevron.compact.down convention. */}
        <svg
          aria-hidden="true"
          focusable="false"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2" y="3" width="20" height="12" rx="2" />
          <path d="M6 7h.01M10 7h.01M14 7h.01M18 7h.01M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 12h8M9 19l3 2 3-2" />
        </svg>
      </span>
    </button>
  )
}

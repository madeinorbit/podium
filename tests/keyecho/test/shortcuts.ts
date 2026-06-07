export interface Shortcut {
  name: string
  bytes: string // raw bytes as a latin1 string
  expectLabel: string // expected raw-source label substring
}

export const SHORTCUTS: Shortcut[] = [
  { name: 'enter', bytes: '\r', expectLabel: 'Enter' },
  { name: 'ctrl-j-newline', bytes: '\n', expectLabel: 'Ctrl+J' },
  { name: 'alt-enter', bytes: '\x1b\r', expectLabel: 'Alt+Enter' },
  { name: 'shift-enter', bytes: '\x1b[27;2;13~', expectLabel: 'Shift+Enter' },
  { name: 'ctrl-c', bytes: '\x03', expectLabel: 'Ctrl+C' },
  { name: 'ctrl-d', bytes: '\x04', expectLabel: 'Ctrl+D' },
  { name: 'escape', bytes: '\x1b', expectLabel: 'Escape' },
  { name: 'up', bytes: '\x1b[A', expectLabel: 'Up' },
  { name: 'down', bytes: '\x1b[B', expectLabel: 'Down' },
  { name: 'left', bytes: '\x1b[D', expectLabel: 'Left' },
  { name: 'right', bytes: '\x1b[C', expectLabel: 'Right' },
  { name: 'shift-tab', bytes: '\x1b[Z', expectLabel: 'Shift+Tab' },
  { name: 'tab', bytes: '\t', expectLabel: 'Tab' },
  { name: 'ctrl-r', bytes: '\x12', expectLabel: 'Ctrl+R' },
  { name: 'ctrl-l', bytes: '\x0c', expectLabel: 'Ctrl+L' },
  { name: 'ctrl-u', bytes: '\x15', expectLabel: 'Ctrl+U' },
  { name: 'ctrl-k', bytes: '\x0b', expectLabel: 'Ctrl+K' },
  { name: 'ctrl-w', bytes: '\x17', expectLabel: 'Ctrl+W' },
  { name: 'ctrl-a', bytes: '\x01', expectLabel: 'Ctrl+A' },
  { name: 'ctrl-e', bytes: '\x05', expectLabel: 'Ctrl+E' },
  { name: 'backspace', bytes: '\x7f', expectLabel: 'Backspace' },
  { name: 'home', bytes: '\x1b[H', expectLabel: 'Home' },
  { name: 'end', bytes: '\x1b[F', expectLabel: 'End' },
  { name: 'pageup', bytes: '\x1b[5~', expectLabel: 'PageUp' },
  { name: 'pagedown', bytes: '\x1b[6~', expectLabel: 'PageDown' },
  { name: 'bang', bytes: '!', expectLabel: '!' },
  { name: 'slash', bytes: '/', expectLabel: '/' },
  { name: 'at', bytes: '@', expectLabel: '@' },
  { name: 'hash', bytes: '#', expectLabel: '#' },
  { name: 'wheel-up', bytes: '\x1b[<64;5;5M', expectLabel: 'wheelUp' },
  { name: 'wheel-down', bytes: '\x1b[<65;5;5M', expectLabel: 'wheelDown' },
  { name: 'mouse-click', bytes: '\x1b[<0;12;3M', expectLabel: 'Mouse left press @ (12,3)' },
]

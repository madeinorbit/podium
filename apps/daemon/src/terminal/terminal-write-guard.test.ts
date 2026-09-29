import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE TERMINAL WRITE GUARD (POD-4888).
 *
 * The foreign-write counter is only worth anything if no byte reaches a
 * session's terminal without passing it. It sits in ONE place — the
 * Terminal's `write`/`writeBase64` (`terminal.ts`), the only code that touches
 * the attachment's own write calls. This test inventories every write-shaped
 * call in production daemon code and pins each one with what it writes to, so
 * a new one fails here until someone says which it is:
 *
 * - `terminal` — a call on a Terminal: counted by the Terminal itself.
 * - `the-counted-call` — the Terminal's own call into the attachment, the one
 *   place under the counter.
 * - anything else — a named non-terminal sink (a file, a journal, a screen
 *   emulator, a headless engine's stdin).
 *
 * A new write into a terminal that does not go through a Terminal is exactly
 * what this refuses: route it through `Terminal.write`/`writeBase64` (or
 * `writeHeadedInput`) instead of adding it here.
 *
 * Keyed by the call's source line, not its line number, so unrelated edits do
 * not trip it.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..')

/** Every write-shaped call: `.write(`, `?.write(`, `.writeBytes(`, `.writeBase64(`. */
const WRITE_CALL = /(?:\?\.|\.)\s*(?:write|writeBytes|writeBase64)\s*(?:\?\.)?\(/

type Sink =
  | 'terminal'
  | 'the-counted-call'
  | 'screen emulator'
  | 'file handle'
  | 'journal'
  | 'headless engine stdin (no pty)'

const INVENTORY: Record<string, Sink> = {
  'terminal/terminal.ts: this.attachment.writeBytes(data)': 'the-counted-call',
  'terminal/terminal.ts: this.attachment.write(dataBase64)': 'the-counted-call',
  "terminal/headed-input.ts: terminal.writeBase64(Buffer.from(bytes, 'utf8').toString('base64'))":
    'terminal',
  'control/native-terminal-input.ts: bridge.write(bytes)': 'terminal',
  'control/legacy-terminal-input.ts: bridge.write(bytes)': 'terminal',
  'control/session.ts: if (msg.hard && terminal) terminal.write(CTRL_L)': 'terminal',
  'runtime/opencode-attach.ts: for (const data of buffered) started.write(data)': 'terminal',
  'runtime/opencode-attach.ts: terminal.write(data)': 'terminal',
  // The harness terminal driver's only way in: its TerminalTransport, adapted
  // here onto the session's Terminal (POD-4785).
  "runtime/host.ts: terminal.writeBase64(dataBase64, role === 'message' ? MESSAGE_WRITE : undefined),":
    'terminal',
  'composer-sync.ts: if (this.ownsScreen) this.screen.write(data)': 'screen emulator',
  'terminal-screen-observer.ts: if (ownsScreen) screenReader.write(data)': 'screen emulator',
  'handoff-package.ts: await handle.write(input.data, 0, input.data.length, input.offset)':
    'file handle',
  'server-transfer.ts: const result = await handle.write(data, written, data.length - written, offset + written)':
    'file handle',
  'shipping/journal.ts: return this.write({ request, result })': 'journal',
  'shipping/journal.ts: return this.write({': 'journal',
  'shipping/journal.ts: return this.write({ ...existing, acknowledgedAt: at })': 'journal',
  'session/engines.ts: journal.write({ ...facts, ...(address !== undefined ? { address } : {}) })':
    'journal',
  'session/engines.ts: write: (data) => session.connection.write(data),':
    'headless engine stdin (no pty)',
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts')) yield full
  }
}

/** Production daemon source: not a test, a fixture, or a test-support generation. */
function isProduction(rel: string): boolean {
  return (
    !rel.endsWith('.test.ts') &&
    !rel.endsWith('.gen1.ts') &&
    !rel.split('/').some((part) => part === 'fixtures' || part === 'test-support')
  )
}

function writeCalls(): string[] {
  const found: string[] = []
  for (const path of walk(SRC)) {
    const rel = relative(SRC, path).split('\\').join('/')
    if (!isProduction(rel)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const code = line.trim()
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue
      if (WRITE_CALL.test(code)) found.push(`${rel}: ${code}`)
    }
  }
  return found
}

describe('terminal write guard (POD-4888)', () => {
  it('every write-shaped call in daemon code is inventoried: none reaches a terminal around the counter', () => {
    const found = writeCalls()
    const unknown = found.filter((call) => !(call in INVENTORY))
    // A new call here is either a Terminal call (add it as `terminal`) or a
    // sink that is not a terminal (name it). A direct write to an attachment,
    // a host connection or a pty process is neither: route it through the
    // Terminal so the foreign-write counter sees it.
    expect(unknown).toEqual([])
    // A stale entry means the inventory no longer describes the code.
    const gone = Object.keys(INVENTORY).filter((call) => !found.includes(call))
    expect(gone).toEqual([])
  })

  it('only the Terminal touches the attachment’s own write calls', () => {
    const counted = writeCalls().filter((call) => INVENTORY[call] === 'the-counted-call')
    expect(counted.every((call) => call.startsWith('terminal/terminal.ts: '))).toBe(true)
    expect(counted).toHaveLength(2)
  })

  it('only the message typist may tag a write as a message’s own', () => {
    const users: string[] = []
    for (const path of walk(SRC)) {
      const rel = relative(SRC, path).split('\\').join('/')
      if (!isProduction(rel)) continue
      if (readFileSync(path, 'utf8').includes('MESSAGE_WRITE')) users.push(rel)
    }
    expect(users.sort()).toEqual(['runtime/host.ts', 'terminal/foreign-writes.ts'])
  })

  it('the pattern sees a write the inventory has never heard of', () => {
    // Armed check: a bypass shaped like the ones the guard exists for matches.
    expect(WRITE_CALL.test('attachment.writeBytes(bytes)')).toBe(true)
    expect(WRITE_CALL.test('owned.terminal?.attachment.write(b64)')).toBe(true)
    expect(WRITE_CALL.test('conn.write(data).catch(() => {})')).toBe(true)
    expect(WRITE_CALL.test('host.bridge(id)?.writeBase64(x)')).toBe(true)
  })
})

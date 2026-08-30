import { randomBytes } from 'node:crypto'
import { Terminal } from '@xterm/headless'

type Provider = 'claude' | 'codex' | 'grok' | 'opencode'

interface OutputMessage {
  type?: string
  sessionId?: string
  data?: string
  frames?: string[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function setupAction(provider: Provider, screen: string): string | undefined {
  if (provider === 'claude' && screen.includes('Yes, I trust this folder')) return '\r'
  if (
    provider === 'codex' &&
    /Do you trust the contents of this directory\?/i.test(screen) &&
    /Yes, (?:proceed|continue)/i.test(screen)
  ) {
    return '1\r'
  }
  if (
    provider === 'grok' &&
    screen.includes("Don't ask me again") &&
    screen.includes('Type your answer here')
  ) {
    return 'X'
  }
  return undefined
}

/** Visible-composer proof shared by headed startup and headless native attach. */
export class TerminalProbe {
  readonly #terminals = new Map<string, Terminal>()

  reset(sessionId: string): void {
    this.#terminals.get(sessionId)?.dispose()
    this.#terminals.set(
      sessionId,
      new Terminal({ cols: 100, rows: 30, scrollback: 1_000, allowProposedApi: true }),
    )
  }

  onMessage(raw: { toString(): string }): void {
    let message: OutputMessage
    try {
      message = JSON.parse(raw.toString()) as OutputMessage
    } catch {
      return
    }
    if (!message.sessionId) return
    const terminal = this.#terminals.get(message.sessionId)
    if (!terminal) return
    const encoded =
      message.type === 'outputFrame' && message.data
        ? [message.data]
        : message.type === 'agentFrameBatch' && message.frames
          ? message.frames
          : []
    for (const frame of encoded) terminal.write(Buffer.from(frame, 'base64').toString('utf8'))
  }

  #screen(sessionId: string): string {
    const terminal = this.#terminals.get(sessionId)
    if (!terminal) return ''
    const buffer = terminal.buffer.active
    let text = ''
    for (let row = buffer.baseY; row < buffer.baseY + terminal.rows; row += 1) {
      text += `${buffer.getLine(row)?.translateToString(true) ?? ''}\n`
    }
    return text
  }

  async waitForInput(
    provider: Provider,
    sessionId: string,
    send: (bytes: string) => void,
    timeoutMs: number,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs
    const probes: string[] = []
    let nextProbeAt = 0
    let setupHandled = false
    while (Date.now() < deadline) {
      const screen = this.#screen(sessionId)
      if (!setupHandled) {
        const action = setupAction(provider, screen)
        if (action !== undefined) {
          setupHandled = true
          send(action)
          await sleep(100)
          continue
        }
      }
      const accepted = probes.find((probe) => screen.includes(probe))
      if (accepted && (provider !== 'grok' || /Enter\s*:send/i.test(screen))) {
        send(provider === 'grok' ? '\x01\x0b' : '\x15')
        return Date.now()
      }
      if (screen.trim() && Date.now() >= nextProbeAt) {
        const marker = Array.from(randomBytes(24), (byte) => (byte & 1 ? '.' : '_')).join('')
        probes.push(marker)
        send(marker)
        nextProbeAt = Date.now() + 1_000
      }
      await sleep(100)
    }
    throw new Error(
      `native composer did not accept a visible probe within ${timeoutMs} ms; screen: ${this.#screen(sessionId).slice(-4_000)}`,
    )
  }

  async waitForText(sessionId: string, expected: string, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.#screen(sessionId).includes(expected)) return Date.now()
      await sleep(50)
    }
    throw new Error('native screen did not render ' + expected + ' within ' + timeoutMs + ' ms')
  }

  dispose(sessionId: string): void {
    this.#terminals.get(sessionId)?.dispose()
    this.#terminals.delete(sessionId)
  }

  close(): void {
    for (const terminal of this.#terminals.values()) terminal.dispose()
    this.#terminals.clear()
  }
}

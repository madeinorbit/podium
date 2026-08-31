/**
 * THE PANE'S WAITING SENTENCES, AS ONE PURE DECISION (POD-393 / POD-1613).
 *
 * Four waits, four sentences, at most one on screen at a time — the web pane
 * documents each in place. The mapping lives here because TWO renderers speak
 * it now: the react-native-web pane and the native pane's DOM component (which
 * renders the same words in plain HTML inside its webview). Copy that lived in
 * two render trees would drift; a shared decision cannot.
 *
 * Order is the contract:
 *   1. Not connected            → "Connecting terminal…"   (the socket's wait)
 *   2. Spawn unconfirmed        → "Starting agent…"        (the SERVER's wait —
 *      naming the attach here would describe a step that has not begun)
 *   3. Attach not confirmed     → "Attaching terminal…"
 *   4. Attached, PTY silent     → "Attached — no output yet…" (the CHILD's wait:
 *      `outputSeen` is the server's durable "has this PTY ever spoken", so this
 *      is a fact, not a guess from an empty screen [POD-385])
 *   5. Otherwise                → nothing; the terminal is the affordance.
 */
export interface TerminalStatusInput {
  connected: boolean
  spawnPending: boolean
  ready: boolean
  outputSeen: boolean
}

export function terminalStatusLine(input: TerminalStatusInput): string | null {
  if (!input.connected) return 'Connecting terminal…'
  if (input.spawnPending) return 'Starting agent…'
  if (!input.ready) return 'Attaching terminal…'
  if (!input.outputSeen) return 'Attached — no output yet…'
  return null
}

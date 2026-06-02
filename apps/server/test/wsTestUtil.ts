import WebSocket from 'ws'

export function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Returns the WebSocket immediately so listeners can be registered before open. */
export function connectWs(url: string): { ws: WebSocket; opened: Promise<void> } {
  const ws = new WebSocket(url)
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, opened }
}

export function waitMessage<T>(
  ws: WebSocket,
  parse: (raw: string) => T,
  pred: (msg: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('waitMessage: timed out'))
    }, timeoutMs)
    function onMessage(raw: WebSocket.RawData): void {
      let msg: T
      try {
        msg = parse(raw.toString())
      } catch {
        return
      }
      if (pred(msg)) {
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(msg)
      }
    }
    ws.on('message', onMessage)
  })
}

export async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

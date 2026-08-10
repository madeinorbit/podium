type WireData = string | Buffer | ArrayBuffer | Uint8Array

interface EdgePeer {
  upstream?: WebSocket
  queued: string[]
  path: string
  targetAttempted: boolean
}

const backends = ['source', 'target'] as const
const textOf = (value: WireData): string =>
  typeof value === 'string' ? value : Buffer.from(value as ArrayBuffer).toString('utf8')

async function proxyHttp(request: Request): Promise<Response> {
  const incoming = new URL(request.url)
  let lastError: unknown
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
  for (const backend of backends) {
    try {
      const headers = new Headers(request.headers)
      headers.delete('host')
      const response = await fetch(
        `http://${backend}:18787${incoming.pathname}${incoming.search}`,
        {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
          redirect: 'manual',
        },
      )
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      lastError = error
    }
  }
  return new Response(`no transfer backend available: ${String(lastError)}\n`, { status: 503 })
}

function connect(
  peer: import('bun').ServerWebSocket<EdgePeer>,
  backend: 'source' | 'target',
): void {
  if (backend === 'target') peer.data.targetAttempted = true
  const upstream = new WebSocket(`ws://${backend}:18787${peer.data.path}`)
  peer.data.upstream = upstream
  let opened = false
  upstream.addEventListener('open', () => {
    opened = true
    for (const frame of peer.data.queued.splice(0)) upstream.send(frame)
  })
  upstream.addEventListener('message', (event) => peer.send(textOf(event.data as WireData)))
  upstream.addEventListener('error', () => {
    if (!opened && !peer.data.targetAttempted) connect(peer, 'target')
    else peer.close()
  })
  upstream.addEventListener('close', () => {
    if (!opened && !peer.data.targetAttempted) connect(peer, 'target')
    else peer.close()
  })
}

const server = Bun.serve<EdgePeer>({
  hostname: '0.0.0.0',
  port: 18787,
  fetch(request, server) {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const url = new URL(request.url)
      if (
        server.upgrade(request, {
          data: { queued: [], path: `${url.pathname}${url.search}`, targetAttempted: false },
        })
      ) {
        return undefined
      }
      return new Response('websocket upgrade failed', { status: 500 })
    }
    return proxyHttp(request)
  },
  websocket: {
    open(peer) {
      connect(peer, 'source')
    },
    message(peer, message) {
      const raw = textOf(message as WireData)
      if (peer.data.upstream?.readyState === WebSocket.OPEN) peer.data.upstream.send(raw)
      else peer.data.queued.push(raw)
    },
    close(peer) {
      peer.data.upstream?.close()
    },
  },
})

console.log(
  `[transfer-fixture:edge] stable endpoint listening on ${server.hostname}:${server.port}`,
)
await new Promise(() => {})

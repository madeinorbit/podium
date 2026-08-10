import { writeFileSync } from 'node:fs'

type WireData = string | Buffer | ArrayBuffer | Uint8Array

interface ProxyPeer {
  upstream?: WebSocket
  queued: string[]
}

const scenario = process.env.PODIUM_TRANSFER_SCENARIO
if (!scenario) throw new Error('PODIUM_TRANSFER_SCENARIO is required')

const textOf = (value: WireData): string =>
  typeof value === 'string' ? value : Buffer.from(value as ArrayBuffer).toString('utf8')

const server = Bun.serve<ProxyPeer>({
  hostname: '0.0.0.0',
  port: 18789,
  fetch(request, server) {
    if (server.upgrade(request, { data: { queued: [] } })) return undefined
    return new Response('server-transfer control proxy\n')
  },
  websocket: {
    open(downstream) {
      const upstream = new WebSocket('ws://source:18787/daemon')
      downstream.data.upstream = upstream
      upstream.addEventListener('open', () => {
        for (const frame of downstream.data.queued.splice(0)) upstream.send(frame)
      })
      upstream.addEventListener('message', (event) => {
        const raw = textOf(event.data as WireData)
        let frame: { type?: string; manifestDigest?: string } = {}
        try {
          frame = JSON.parse(raw) as typeof frame
        } catch {
          // Non-JSON frames are forwarded byte-for-byte below.
        }
        if (scenario === 'precommit-abort' && frame.type === 'serverTransferValidateRequest') {
          frame.manifestDigest = '0'.repeat(64)
          writeFileSync('/coord/validation-digest-corrupted', `${Date.now()}\n`)
          downstream.send(JSON.stringify(frame))
          return
        }
        downstream.send(raw)
      })
      upstream.addEventListener('close', () => downstream.close())
      upstream.addEventListener('error', () => downstream.close())
    },
    message(downstream, message) {
      const raw = textOf(message as WireData)
      let frame: { type?: string; operation?: string } = {}
      try {
        frame = JSON.parse(raw) as typeof frame
      } catch {
        // Non-JSON frames are forwarded byte-for-byte below.
      }
      if (
        scenario === 'lost-commit-reply' &&
        frame.type === 'serverTransferResult' &&
        frame.operation === 'promote'
      ) {
        writeFileSync('/coord/promote-reply-dropped', `${Date.now()}\n`)
        downstream.data.upstream?.close()
        downstream.close()
        return
      }
      const upstream = downstream.data.upstream
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(raw)
      else downstream.data.queued.push(raw)
    },
    close(downstream) {
      downstream.data.upstream?.close()
    },
  },
})

console.log(
  `[transfer-fixture:control-proxy] ${scenario} listening on ${server.hostname}:${server.port}`,
)
await new Promise(() => {})

import { existsSync, writeFileSync } from 'node:fs'

type WireData = string | Buffer | ArrayBuffer | Uint8Array

interface ProxyPeer {
  upstream?: WebSocket
  queued: string[]
}

const scenario = process.env.PODIUM_TRANSFER_SCENARIO
if (!scenario) throw new Error('PODIUM_TRANSFER_SCENARIO is required')

const textOf = (value: WireData): string =>
  typeof value === 'string' ? value : Buffer.from(value as ArrayBuffer).toString('utf8')

const mark = (name: string, body = `${Date.now()}\n`): void => {
  writeFileSync(`/coord/${name}`, body)
}

async function waitFor(name: string): Promise<void> {
  while (!existsSync(`/coord/${name}`)) await Bun.sleep(25)
}

function json(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function comparablePromote(frame: Record<string, unknown>): string {
  const { requestId: _requestId, ...identity } = frame
  return JSON.stringify(identity)
}

let heldFirstChunk = false
let corruptedValidation = false
let droppedPromoteRequest = false
let droppedPromoteReply = false
let firstPromote: string | undefined
let heldMidstageReply = false
let sawRestartPrepare = false

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
      const restartDownstream = (): void => {
        if (downstream.readyState !== WebSocket.OPEN) return
        downstream.close(1012, 'upstream source restarting')
      }
      downstream.data.upstream = upstream
      upstream.addEventListener('open', () => {
        for (const frame of downstream.data.queued.splice(0)) upstream.send(frame)
      })
      upstream.addEventListener('message', (event) => {
        const raw = textOf(event.data as WireData)
        const frame = json(raw)
        const type = frame.type

        if (type === 'serverTransferPrepareRequest' && heldMidstageReply) {
          sawRestartPrepare = true
        }
        if (
          type === 'serverTransferChunkRequest' &&
          !heldFirstChunk &&
          (scenario === 'g1' || scenario === 'g2' || scenario === 'g6' || scenario === 'g9')
        ) {
          heldFirstChunk = true
          mark('first-success-chunk-held')
          void waitFor('release-stage-chunk').then(() => downstream.send(raw))
          return
        }
        if (scenario === 'g7' && type === 'serverTransferValidateRequest' && !corruptedValidation) {
          corruptedValidation = true
          frame.manifestDigest = '0'.repeat(64)
          mark('validation-digest-corrupted')
          downstream.send(JSON.stringify(frame))
          return
        }
        if (type === 'serverTransferAcknowledgeRequest' && scenario === 'g5') {
          if (existsSync('/coord/source-commit-before-ack')) mark('ack-after-commit')
        }
        if (type === 'serverTransferPromoteRequest') {
          if (scenario === 'g10') mark('promote-observed')
          if (scenario === 'g3' && !existsSync('/coord/release-promote')) {
            mark('promote-request-held')
            void waitFor('release-promote').then(() => downstream.send(raw))
            return
          }
          if (scenario === 'g4b') {
            const comparable = comparablePromote(frame)
            if (!droppedPromoteRequest) {
              droppedPromoteRequest = true
              firstPromote = comparable
              mark('promote-request-dropped', `${comparable}\n`)
              upstream.send(
                JSON.stringify({
                  type: 'serverTransferResult',
                  requestId: frame.requestId,
                  transferId: frame.transferId,
                  operation: 'promote',
                  ok: false,
                  state: 'uncertain',
                  manifestDigest: frame.manifestDigest,
                  error: 'promotion request dropped by acceptance proxy',
                  errorCode: 'uncertain-commit',
                }),
              )
              return
            }
            if (firstPromote === comparable) mark('promote-replay-identical')
          }
        }
        downstream.send(raw)
      })
      upstream.addEventListener('close', restartDownstream)
      upstream.addEventListener('error', restartDownstream)
    },
    message(downstream, message) {
      const raw = textOf(message as WireData)
      const frame = json(raw)
      if (
        scenario === 'g4a' &&
        frame.type === 'serverTransferResult' &&
        frame.operation === 'promote' &&
        !droppedPromoteReply
      ) {
        droppedPromoteReply = true
        mark('promote-reply-dropped')
        return
      }
      if (
        scenario === 'g8' &&
        frame.type === 'serverTransferResult' &&
        frame.operation === 'chunk' &&
        !heldMidstageReply
      ) {
        heldMidstageReply = true
        mark('midstage-reply-held')
        return
      }
      if (
        scenario === 'g8' &&
        sawRestartPrepare &&
        frame.type === 'serverTransferResult' &&
        frame.operation === 'prepare' &&
        typeof frame.receivedBytes === 'number' &&
        frame.receivedBytes > 0
      ) {
        mark('resume-received-bytes', `${frame.receivedBytes}\n`)
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

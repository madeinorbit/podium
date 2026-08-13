import { createInterface } from 'node:readline'
import { asMachineId } from '@podium/model'
import { ShippingJobRequestMessage } from '@podium/protocol'
import { ShippingExecutionPlane } from '../executor'

const [journalDir, rawMachineId] = process.argv.slice(2)
if (!journalDir || !rawMachineId) throw new Error('missing daemon RPC worker arguments')

const plane = new ShippingExecutionPlane(journalDir, asMachineId(rawMachineId))
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })

for await (const line of lines) {
  const request = ShippingJobRequestMessage.parse(JSON.parse(line))
  const result = plane.handle(request)
  process.stdout.write(
    `${JSON.stringify({ type: 'shippingJobResult', requestId: request.requestId, ...result })}\n`,
  )
}

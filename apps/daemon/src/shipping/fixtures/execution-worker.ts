import { asMachineId } from '@podium/model'
import { ShippingJobRequestMessage } from '@podium/protocol'
import { ShippingExecutionPlane } from '../executor'

const [journalDir, machineId, encoded] = process.argv.slice(2)
if (!journalDir || !machineId || !encoded) throw new Error('missing shipping worker arguments')

const request = ShippingJobRequestMessage.parse(
  JSON.parse(Buffer.from(encoded, 'base64url').toString()),
)
const result = new ShippingExecutionPlane(journalDir, asMachineId(machineId)).handle(request)
process.stdout.write(`${JSON.stringify(result)}\n`)

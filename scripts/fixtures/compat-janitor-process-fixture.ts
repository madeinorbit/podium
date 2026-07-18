import { readFileSync, writeFileSync } from 'node:fs'
import { MAINTENANCE_PROTOCOL_VERSION } from '../../packages/protocol/src/maintenance'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

const schemaVersion = readFileSync(required('PODIUM_ACCEPTANCE_SCHEMA_FILE'), 'utf8').trim()
const response = await fetch(`${required('PODIUM_ACCEPTANCE_SERVER_URL')}/maintenance/handshake`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${required('PODIUM_ACCEPTANCE_TOKEN')}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
    schemaVersion,
    generationId: `compat-${process.pid}`,
  }),
})
const reply = (await response.json()) as { status?: string }
if (reply.status === 'incompatible') process.exit(78)
if (reply.status !== 'ready') process.exit(1)
writeFileSync(required('PODIUM_ACCEPTANCE_READY_FILE'), `${schemaVersion}:${process.pid}`)
await new Promise(() => {})

/** Real server boot without a supervisor enrolling another host in the fixture. */
import { startServer } from '../../apps/server/src/server'
const server = await startServer({ port: Number(process.env.PODIUM_PORT), host: '127.0.0.1' })
process.once('SIGTERM', async () => { await server.close(); process.exit(0) })

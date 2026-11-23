/** Process fixture for installation ownership. No server, data, identity or network. */
import {
  acquireInstallationLease,
  registerInstallationStateRoot,
} from '../../packages/runtime/src/installation-lease'

const [install, state] = process.argv.slice(2)
if (!install || !state) throw new Error('installation usage fixture needs explicit paths')
const lease = acquireInstallationLease(install, false, 10_000)
registerInstallationStateRoot(lease, state)
process.once('exit', () => lease.release())
console.log('installation usage ready')
setInterval(() => {}, 1000)

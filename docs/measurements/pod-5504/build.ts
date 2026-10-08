/** Single web build using the repository's admission, fingerprint and Turbo recipe. */
import { join, resolve } from 'node:path'
const root = resolve(process.argv[2] ?? process.cwd())
process.env.PATH = join(root, '.toolchain/bin') + ':' + process.env.PATH
const { readCensus, admissionRefusal, turboEnv, decideForce } = await import(join(root, 'scripts/typecheck.ts'))
const { turboBuildCommandFor, stampCommandFor } = await import(join(root, 'scripts/build-clients.ts'))
const census = readCensus(root)
const refusal = admissionRefusal(census, 'build')
if (refusal) throw new Error(refusal)
const env = { ...turboEnv(root, census), PATH: process.env.PATH }
const decision = decideForce(process.argv.slice(3), env)
if (decision.error) throw new Error(decision.error)
if (decision.reason) console.error('Measurement cache exception: ' + decision.reason)
const build = Bun.spawn(turboBuildCommandFor(root, ['@podium/web'], decision.reason ? [...decision.forwardArgs.filter(arg => arg !== '--force'), '--cache='] : decision.forwardArgs), { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit'] })
if (await build.exited !== 0) throw new Error('Production web build failed')
const stamp = Bun.spawn(stampCommandFor(root, 'apps/web/dist'), { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit'] })
if (await stamp.exited !== 0) throw new Error('Production web stamp failed')

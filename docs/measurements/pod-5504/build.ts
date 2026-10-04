/** Single web build using the repository's admission, fingerprint and Turbo recipe. */
import { join } from 'node:path'
const root = process.cwd()
const { readCensus, admissionRefusal, turboEnv } = await import(join(root, 'scripts/typecheck.ts'))
const { turboBuildCommandFor, stampCommandFor } = await import(join(root, 'scripts/build-clients.ts'))
const census = readCensus(root)
const refusal = admissionRefusal(census, 'build')
if (refusal) throw new Error(refusal)
const env = { ...turboEnv(root, census), PATH: process.env.PATH }
const build = Bun.spawn(turboBuildCommandFor(root, ['@podium/web'], []), { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit'] })
if (await build.exited !== 0) throw new Error('Production web build failed')
const stamp = Bun.spawn(stampCommandFor(root, 'apps/web/dist'), { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit'] })
if (await stamp.exited !== 0) throw new Error('Production web stamp failed')

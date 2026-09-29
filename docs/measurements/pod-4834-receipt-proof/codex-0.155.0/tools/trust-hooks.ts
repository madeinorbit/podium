// SCRATCH HOME ONLY: marks the logging hooks written by setup-home.sh trusted, using the hashes
// Codex itself reports through `hooks/list` (0.155.0's app-server ignores
// --dangerously-bypass-hook-trust: every hook listed `trustStatus: "untrusted"` and none ran).
import { appendFileSync } from 'node:fs'
import { CODEX_HOME, init, startServer, WORK } from './appserver.ts'

const srv = startServer('trust')
await init(srv)
const res = await srv.call('hooks/list', { cwds: [WORK] })
let toml = ''
for (const h of res.result.data[0].hooks) toml += `\n[hooks.state."${h.key}"]\ntrusted_hash = "${h.currentHash}"\n`
appendFileSync(`${CODEX_HOME}/config.toml`, toml)
srv.child.kill('SIGTERM')
await srv.exited
console.log(`trusted ${res.result.data[0].hooks.length} hooks`)

// Smoke: idle turn, then a TOOLSLEEP turn, to learn the tool Codex offers and check hooks fire.
import { init, mark, startServer, text, turnDone, WORK } from './appserver.ts'

const srv = startServer()
await init(srv)
const t = await srv.call('thread/start', { cwd: WORK })
const threadId = t.result.thread.id
mark('hooks/list', await srv.call('hooks/list', { cwds: [WORK] }))
mark('send S1', { clientUserMessageId: 'our_S1' })
const r1 = await srv.call('turn/start', { threadId, clientUserMessageId: 'our_S1', input: text('Say ALPHA') })
await srv.waitFor(turnDone(r1.result.turn.id))
mark('send tool', { clientUserMessageId: 'our_tool' })
const r2 = await srv.call('turn/start', { threadId, clientUserMessageId: 'our_tool', input: text('TOOLSLEEP please') })
await srv.waitFor(turnDone(r2.result.turn.id), 40000)
srv.child.kill('SIGTERM')
await srv.exited

// App-server scenarios (POD-4863). Usage (through run.sh): bun as-scenarios.ts <scenario>
// Every send is preceded by a mark carrying our clientUserMessageId, so timeline.ts can anchor on it.
import { execSync } from 'node:child_process'
import { init, mark, note, sleep, startServer, text, turnDone, WORK, type Srv } from './appserver.ts'

const scenario = process.argv[2]
const T = (s: string) => text(s)

async function open(tag = 'srv') {
  const srv = startServer(tag)
  await init(srv)
  return srv
}
async function newThread(srv: Srv) {
  const t = await srv.call('thread/start', { cwd: WORK })
  return t.result.thread.id as string
}
async function start(srv: Srv, threadId: string, id: string, body: string) {
  mark(`send ${id} turn/start`, { clientUserMessageId: id, text: body.length > 200 ? `${body.slice(0, 200)}…(${body.length})` : body })
  const r = await srv.call('turn/start', { threadId, clientUserMessageId: id, input: T(body) })
  mark(`reply ${id}`, r)
  return r
}
async function steer(srv: Srv, threadId: string, turnId: string, id: string, body: string) {
  mark(`send ${id} turn/steer`, { clientUserMessageId: id, text: body })
  const r = await srv.call('turn/steer', { threadId, expectedTurnId: turnId, clientUserMessageId: id, input: T(body) })
  mark(`reply ${id}`, r)
  return r
}
async function queueAdd(srv: Srv, threadId: string, id: string, body: string) {
  mark(`send ${id} thread/queue/add`, { clientUserMessageId: id, text: body })
  const r = await srv.call('thread/queue/add', { threadId, clientUserMessageId: id, input: T(body) })
  mark(`reply ${id}`, r)
  return r
}
const idle = (srv: Srv, ms = 30000) => srv.waitFor((f) => f.method === 'thread/status/changed' && f.params?.status?.type === 'idle', ms)
async function readThread(srv: Srv, threadId: string, label: string) {
  const r = await srv.call('thread/read', { threadId, includeTurns: true })
  mark(`thread/read ${label}`, r)
  const q = await srv.call('thread/queue/list', { threadId })
  mark(`thread/queue/list ${label}`, q)
  return r
}
async function stop(srv: Srv, sig: NodeJS.Signals = 'SIGTERM') {
  // `codex` is a Node wrapper; SIGKILL must hit the native binary it spawned, or the native
  // process just sees stdin close and shuts down gracefully.
  const native = sig === 'SIGKILL' ? execSync(`pgrep -P ${srv.child.pid}`).toString().trim().split(/\s+/).map(Number) : []
  mark(`kill app-server ${sig}`, { wrapper: srv.child.pid, native })
  for (const p of native) process.kill(p, 'SIGKILL')
  srv.child.kill(sig)
  await srv.exited
  mark('app-server exited')
}
async function reopen(threadId: string) {
  const srv = await open('srv2')
  mark('resume', await srv.call('thread/resume', { threadId }))
  await readThread(srv, threadId, 'after restart')
  return srv
}

switch (scenario) {
  // S3: busy streaming text (no tool call); a second message arrives by each of the three verbs.
  case 's3-turnstart':
  case 's3-steer':
  case 's3-queue':
  case 's2-queue': {
    const srv = await open()
    const th = await newThread(srv)
    const busy = scenario === 's2-queue' ? 'TOOLSLEEP busy' : 'SLOWTEXT busy'
    const r = await start(srv, th, 'our_busy', busy)
    const turnId = r.result.turn.id
    await srv.waitFor(note('turn/started'))
    await sleep(2500)
    if (scenario === 's3-turnstart') await start(srv, th, 'our_second', 'second while busy')
    if (scenario === 's3-steer') await steer(srv, th, turnId, 'our_second', 'second while busy')
    if (scenario.endsWith('queue')) await queueAdd(srv, th, 'our_second', 'second while busy')
    await srv.waitFor(turnDone(turnId), 40000)
    await sleep(3000)
    await readThread(srv, th, 'end')
    await stop(srv)
    break
  }
  // S4: interrupt while busy (text / tool), then send. Variant with a queued item pending.
  case 's4-text':
  case 's4-tool':
  case 's4-queued': {
    const srv = await open()
    const th = await newThread(srv)
    const r = await start(srv, th, 'our_busy', scenario === 's4-tool' ? 'TOOLSLEEP busy' : 'SLOWTEXT busy')
    const turnId = r.result.turn.id
    await srv.waitFor(note('turn/started'))
    await sleep(2500)
    if (scenario === 's4-queued') await queueAdd(srv, th, 'our_queued', 'queued before interrupt')
    await sleep(500)
    mark('send interrupt')
    mark('reply interrupt', await srv.call('turn/interrupt', { threadId: th, turnId }))
    await srv.waitFor(turnDone(turnId), 20000)
    await sleep(1500)
    await readThread(srv, th, 'after interrupt')
    if (scenario !== 's4-queued') {
      const r2 = await start(srv, th, 'our_after', 'after interrupt')
      await srv.waitFor(turnDone(r2.result.turn.id))
    } else await sleep(4000)
    await idle(srv, 5000).catch(() => {})
    await readThread(srv, th, 'end')
    await stop(srv)
    break
  }
  // S5 (queue verb only; turn/start and turn/steer repeats are POD-4835's): the same id twice.
  case 's5-queue': {
    const srv = await open()
    const th = await newThread(srv)
    const r = await start(srv, th, 'our_busy', 'TOOLSLEEP busy')
    await srv.waitFor(note('turn/started'))
    await sleep(1000)
    await queueAdd(srv, th, 'our_dup', 'same id twice')
    await queueAdd(srv, th, 'our_dup', 'same id twice')
    await srv.waitFor(turnDone(r.result.turn.id), 40000)
    await sleep(4000)
    await readThread(srv, th, 'end')
    await stop(srv)
    break
  }
  // S6: restart after sends. (a) settled turn; (b) queued item and an acked steer pending at kill.
  case 's6-settled': {
    const srv = await open()
    const th = await newThread(srv)
    const r = await start(srv, th, 'our_one', 'first message')
    await srv.waitFor(turnDone(r.result.turn.id))
    await sleep(500)
    await stop(srv)
    const srv2 = await reopen(th)
    const r2 = await start(srv2, th, 'our_two', 'after restart')
    await srv2.waitFor(turnDone(r2.result.turn.id))
    await readThread(srv2, th, 'end')
    await stop(srv2)
    break
  }
  case 's6-pending-term':
  case 's6-pending-kill': {
    const sig = scenario.endsWith('kill') ? 'SIGKILL' : 'SIGTERM'
    const srv = await open()
    const th = await newThread(srv)
    const r = await start(srv, th, 'our_busy', 'TOOLSLEEP busy')
    await srv.waitFor(note('turn/started'))
    await sleep(1500)
    await queueAdd(srv, th, 'our_queued', 'queued at kill')
    await steer(srv, th, r.result.turn.id, 'our_steer', 'steer at kill')
    await sleep(1000)
    await stop(srv, sig)
    const srv2 = await reopen(th)
    await sleep(6000)
    await readThread(srv2, th, 'after 6s')
    await stop(srv2)
    break
  }
  // S7: text changes between what we send and what Codex records / sends to the model.
  case 's7': {
    const srv = await open()
    const th = await newThread(srv)
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const cases: [string, string][] = [
      ['our_ws', '  leading and trailing spaces  \n\n'],
      ['our_crlf', 'line1\r\nline2\n\n\nline5\ttab'],
      ['our_long', long],
      ['our_unicode', 'nfc:é nfd:é emoji:\u{1F469}‍\u{1F469}‍\u{1F467} rtl:שלום zwsp:[​] bom:[﻿] nbsp:[ ]'],
      ['our_ctrl', 'ctrl:[\u0007][\u001b[31m] nul-free end'],
      ['our_empty_ws', '   '],
    ]
    for (const [id, body] of cases) {
      const r = await start(srv, th, id, body)
      if (r.result) await srv.waitFor(turnDone(r.result.turn.id))
    }
    await readThread(srv, th, 'end')
    await stop(srv)
    break
  }
  // S10: explicit error replies; model HTTP 400; process killed right after it took a message.
  case 's10-errors': {
    const srv = await open()
    const th = await newThread(srv)
    mark('send our_err_thread turn/start (unknown thread)')
    mark('reply our_err_thread', await srv.call('turn/start', { threadId: '00000000-0000-0000-0000-000000000000', clientUserMessageId: 'our_err_thread', input: T('bad thread') }))
    mark('send our_err_steer_idle turn/steer (no active turn)')
    mark('reply our_err_steer_idle', await srv.call('turn/steer', { threadId: th, expectedTurnId: 'nope', clientUserMessageId: 'our_err_steer_idle', input: T('steer idle') }))
    mark('send our_err_input turn/start (malformed input)')
    mark('reply our_err_input', await srv.call('turn/start', { threadId: th, clientUserMessageId: 'our_err_input', input: [{ type: 'bogus' }] }))
    const r = await start(srv, th, 'our_busy', 'TOOLSLEEP busy')
    await srv.waitFor(note('turn/started'))
    await sleep(1000)
    mark('send our_err_steer_wrong turn/steer (wrong expectedTurnId)')
    mark('reply our_err_steer_wrong', await srv.call('turn/steer', { threadId: th, expectedTurnId: 'wrong-turn', clientUserMessageId: 'our_err_steer_wrong', input: T('steer wrong turn') }))
    await srv.waitFor(turnDone(r.result.turn.id), 40000)
    const r4 = await start(srv, th, 'our_http400', 'HTTP400 please')
    await srv.waitFor(turnDone(r4.result.turn.id), 60000)
    await sleep(1000)
    await readThread(srv, th, 'end')
    await stop(srv)
    break
  }
  case 's10-kill-on-reply':
  case 's10-kill-on-item': {
    const srv = await open()
    const th = await newThread(srv)
    const r0 = await start(srv, th, 'our_first', 'first message')
    await srv.waitFor(turnDone(r0.result.turn.id))
    if (scenario === 's10-kill-on-reply') {
      mark('send our_killed turn/start')
      srv.send({ jsonrpc: '2.0', id: 900, method: 'turn/start', params: { threadId: th, clientUserMessageId: 'our_killed', input: T('killed right after the reply') } })
      await srv.waitFor((f) => f.id === 900 && !f.method)
    } else {
      mark('send our_killed turn/start')
      srv.send({ jsonrpc: '2.0', id: 900, method: 'turn/start', params: { threadId: th, clientUserMessageId: 'our_killed', input: T('SLOWTEXT killed right after the item') } })
      await srv.waitFor((f) => f.method === 'item/completed' && f.params?.item?.clientId === 'our_killed')
    }
    await stop(srv, 'SIGKILL')
    const srv2 = await reopen(th)
    await sleep(3000)
    await readThread(srv2, th, 'after 3s')
    await stop(srv2)
    break
  }
  default:
    throw new Error(`unknown scenario ${scenario}`)
}

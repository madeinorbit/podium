import {
  Chat,
  REPO,
  login,
  mutate,
  now,
  primeTerminalTui,
  sessionRow,
  wait,
} from '../pod-2777/rig'

const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const SPINUP_MS = Number(process.env.P2777_SPINUP_MS ?? 90_000)
const log = (s: string) => console.log(s)

await login()
const created = await mutate('sessions.create', { cwd: REPO, agentKind: 'codex' })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created).slice(0, 600)}`)

const chat = new Chat(sid)
try {
  log(`SESSION ${sid}`)
  await wait(READY_MS)
  log(`ROW BEFORE OPEN ${JSON.stringify(await sessionRow(sid))}`)
  await chat.open()
  await wait(1_000)
  const beforePrime = chat.screenBytes
  log(`SCREEN BEFORE PRIME bytes=${beforePrime} tail=${JSON.stringify(chat.screenTail(800))}`)
  const primed = await primeTerminalTui(chat, sid)
  await wait(2_000)
  const afterPrime = chat.screenBytes
  log(`PRIMING ${primed.length > 0 ? primed.join('; ') : 'nothing to clear'}`)
  log(`SCREEN AFTER PRIME bytes=${afterPrime} delta=${afterPrime - beforePrime} tail=${JSON.stringify(chat.screenTail(800))}`)

  const prompt =
    'Write the exact token MAIN-A3-LIVE-7KQ4 first, then count from 1 to 400. Put each number on its own line and after each number write one full sentence about that number. Do not use tools and do not summarize. Write every line.'
  const promptAt = now()
  await mutate('sessions.sendText', { sessionId: sid, text: prompt })
  log(`PROMPT_SENT at=${promptAt}`)

  const samples: { at: number; phase: string; bytes: number; chars: number; tail: string }[] = []
  let controlAt: number | undefined
  let previousBytes = afterPrime
  let previousChars = chat.assistantText().length
  const deadline = now() + SPINUP_MS
  while (now() < deadline) {
    await wait(500)
    const row = await sessionRow(sid)
    const sample = {
      at: now() - promptAt,
      phase: row?.agentState?.phase ?? 'unknown',
      bytes: chat.screenBytes - afterPrime,
      chars: chat.assistantText().length,
      tail: chat.screenTail(300),
    }
    samples.push(sample)
    const grew = chat.screenBytes > previousBytes || chat.assistantText().length > previousChars
    const modal = /Hooks need review|Press t to trust all|Set it up|Not now/i.test(sample.tail)
    if (grew && sample.phase === 'working' && sample.at >= 1_000 && !modal) {
      controlAt = sample.at
      log(`CONTROL FIRED at=${sample.at}ms phase=${sample.phase} ptyDelta=${sample.bytes} assistantChars=${sample.chars}`)
      log(`CONTROL TAIL ${JSON.stringify(sample.tail)}`)
      break
    }
    previousBytes = chat.screenBytes
    previousChars = chat.assistantText().length
    if (samples.length % 10 === 0) {
      log(`SAMPLE at=${sample.at}ms phase=${sample.phase} ptyDelta=${sample.bytes} assistantChars=${sample.chars}`)
    }
  }

  if (controlAt === undefined) {
    const last = samples.at(-1)
    log(
      `CONTROL DID NOT FIRE phase=${last?.phase ?? 'unknown'} ptyDelta=${last?.bytes ?? 0} assistantChars=${last?.chars ?? 0} samples=${samples.length}`,
    )
    log(`CONTROL LAST TAIL ${JSON.stringify(last?.tail ?? chat.screenTail(800))}`)
    throw new Error('control did not fire')
  }

  const beforeInterruptBytes = chat.screenBytes
  const beforeInterruptChars = chat.assistantText().length
  const interruptAt = now()
  const interrupt = await mutate('sessions.interrupt', { sessionId: sid })
  log(`INTERRUPT_SENT at=${interruptAt - promptAt}ms response=${JSON.stringify(interrupt.result?.data ?? interrupt.error ?? null)}`)
  await wait(6_000)
  const afterA = { bytes: chat.screenBytes, chars: chat.assistantText().length, row: await sessionRow(sid) }
  await wait(6_000)
  const afterB = { bytes: chat.screenBytes, chars: chat.assistantText().length, row: await sessionRow(sid) }
  const stopped = afterB.bytes <= afterA.bytes + 200 && afterB.chars === afterA.chars
  const marked = chat.items.some((item) => item.event === 'interrupt')
  log(`AFTER_6S phase=${afterA.row?.agentState?.phase ?? 'unknown'} ptyDelta=${afterA.bytes - beforeInterruptBytes} assistantDelta=${afterA.chars - beforeInterruptChars}`)
  log(`AFTER_12S phase=${afterB.row?.agentState?.phase ?? 'unknown'} ptyDelta=${afterB.bytes - beforeInterruptBytes} assistantDelta=${afterB.chars - beforeInterruptChars}`)
  log(`RESULT control=FIRED stopped=${stopped} transcriptInterrupt=${marked} frames=${chat.previews.length} items=${chat.items.length}`)
  log(`FINAL_ROW ${JSON.stringify(afterB.row)}`)
} finally {
  await chat.close().catch(() => {})
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
}

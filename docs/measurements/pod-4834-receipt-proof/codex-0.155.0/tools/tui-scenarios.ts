// Codex TUI scenarios (POD-4863). Usage (through run.sh): bun tui-scenarios.ts <scenario>
// Every send is a `send <id> Enter` (or `Tab`) mark; delays in results.md are measured from it.
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { count, key, kill, launch, mark, paste, R, screen, sleep, submit, type, waitLog } from './tui.ts'

const scenario = process.argv[2]
const hooks = () => count('hooks.jsonl')
/** Wait for the next hook event `ev` after the current hook count. */
async function nextHook(ev: string, from: number, ms = 30000) {
  return waitLog('hooks.jsonl', new RegExp(`"ev":"${ev}"`), ms, from)
}
async function boot(args: string[] = []) {
  launch(args)
  await waitLog('hooks.jsonl', /"ev":"SessionStart"/, 20000).catch(() => {})
  await sleep(2500)
  screen('booted')
}
async function turnIdle(label: string, prompt: string) {
  const h = hooks()
  await submit(prompt, label)
  await nextHook('Stop', h)
  await sleep(500)
}
function nativePids(): number[] {
  const out = execSync(`ps -eo pid,ppid,comm`).toString()
  const rows = out.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/))
  const pane = Number(execSync(`tmux display-message -p -t pod4863-${process.pid} '#{pane_pid}'`).toString().trim())
  const kids = (p: number): number[] => rows.filter((r) => Number(r[1]) === p).flatMap((r) => [Number(r[0]), ...kids(Number(r[0]))])
  return [pane, ...kids(pane)]
}

switch (scenario) {
  // S1 idle, S5 the same text twice idle, S8 timestamps.
  case 't-idle': {
    await boot()
    await turnIdle('alpha', 'ALPHA idle')
    await turnIdle('same1', 'SAME text twice')
    await turnIdle('same2', 'SAME text twice')
    screen('end')
    break
  }
  // S2 busy in a tool / S3 busy streaming text: Enter while busy (x2, to see merging), then Tab.
  case 't-busy-tool':
  case 't-busy-text': {
    await boot()
    const h = hooks()
    await submit(scenario === 't-busy-tool' ? 'TOOLSLEEP busy' : 'SLOWTEXT busy', 'busy')
    await nextHook('UserPromptSubmit', h)
    await sleep(1500)
    await submit('GAMMA typed while busy', 'gamma')
    await sleep(400)
    await submit('DELTA typed while busy', 'delta')
    await sleep(700)
    screen('after two Enters while busy')
    type('EPSILON tabbed while busy', 'type epsilon')
    await sleep(600)
    key('Tab', 'send epsilon Tab')
    await sleep(700)
    screen('after Tab while busy')
    // Wait for everything to drain: 3 turns at most, then quiet.
    for (let i = 0; i < 40; i++) {
      await sleep(1000)
      const s = screen(`poll ${i}`)
      if (i > 14 && !/Working|esc to interrupt/.test(s)) break
    }
    screen('end')
    break
  }
  // S4 interrupt while busy (Escape), with a pending Enter-steer and a Tab-queued message, then send.
  case 't-interrupt-tool':
  case 't-interrupt-text': {
    await boot()
    const h = hooks()
    await submit(scenario === 't-interrupt-tool' ? 'TOOLSLEEP busy' : 'SLOWTEXT busy', 'busy')
    await nextHook('UserPromptSubmit', h)
    await sleep(1500)
    await submit('GAMMA pending steer', 'gamma')
    await sleep(500)
    type('EPSILON tab queued', 'type epsilon')
    await sleep(600)
    key('Tab', 'send epsilon Tab')
    await sleep(700)
    screen('before Escape')
    key('Escape', 'send interrupt Escape')
    await sleep(3000)
    screen('after Escape')
    await sleep(6000)
    screen('after Escape +9s')
    await turnIdle('after', 'AFTER interrupt')
    await sleep(3000)
    screen('end')
    break
  }
  // S6 restart: a settled turn and a Tab-queued message held at exit; quit cleanly, resume --last.
  case 't-restart-quit':
  case 't-restart-kill': {
    await boot()
    await turnIdle('one', 'ONE before restart')
    const h = hooks()
    await submit('TOOLSLEEP busy', 'busy')
    await nextHook('PreToolUse', h)
    await sleep(500)
    await submit('GAMMA pending steer at exit', 'gamma')
    await sleep(500)
    type('EPSILON tab queued at exit', 'type epsilon')
    await sleep(600)
    key('Tab', 'send epsilon Tab')
    await sleep(800)
    screen('before exit')
    if (scenario === 't-restart-quit') {
      key('C-c', 'send ctrl-c 1')
      await sleep(400)
      key('C-c', 'send ctrl-c 2')
      await sleep(400)
      key('C-c', 'send ctrl-c 3')
      await sleep(3000)
      screen('after ctrl-c')
    } else {
      const pids = nativePids()
      mark('kill -9 codex', { pids })
      for (const p of pids.slice(1)) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {}
      }
      await sleep(1500)
    }
    kill()
    await sleep(1000)
    await boot(['resume', '--last'])
    await sleep(12000)
    screen('after resume +12s')
    await turnIdle('two', 'TWO after resume')
    screen('end')
    break
  }
  // S7 text changes: trailing spaces, a multi-line paste, a long paste, unicode.
  case 't-text': {
    await boot()
    await turnIdle('ws', '  lead and trail spaces  ')
    let h = hooks()
    paste('pasted line1\n\n  line3 indented\nline4\ttab\n', 'paste multiline')
    await sleep(800)
    key('Enter', 'send multiline Enter')
    await nextHook('Stop', h)
    await sleep(500)
    h = hooks()
    paste(Array.from({ length: 400 }, (_, i) => `long ${i} ${'y'.repeat(30)}`).join('\n'), 'paste long')
    await sleep(1500)
    screen('long paste in box')
    key('Enter', 'send long Enter')
    await nextHook('Stop', h, 40000)
    await sleep(500)
    h = hooks()
    paste('nfc:é nfd:é emoji:\u{1F469}‍\u{1F469}‍\u{1F467} rtl:שלום zwsp:[​] nbsp:[ ]', 'paste unicode')
    await sleep(800)
    key('Enter', 'send unicode Enter')
    await nextHook('Stop', h)
    await sleep(500)
    screen('end')
    break
  }
  // S9 entries nobody typed: /compact, a slash command, hook feedback (UserPromptSubmit
  // additionalContext and a Stop block), plus two submits 30 ms apart from two tmux clients.
  case 't-untyped': {
    await boot()
    await turnIdle('one', 'ONE first')
    await submit('/status', 'status')
    await sleep(2000)
    screen('after /status')
    key('Escape', 'close status')
    await sleep(500)
    let h = hooks()
    await submit('/compact', 'compact')
    await nextHook('PostCompact', h, 30000)
    await sleep(3000)
    screen('after /compact')
    // hook feedback: FEEDBACK marker makes UPS add context and Stop block once
    writeFileSync(`${R}/log/.feedback-on`, '1')
    await turnIdle('fb', 'FEEDBACK please')
    await sleep(2000)
    screen('after feedback turn')
    require('node:fs').rmSync(`${R}/log/.feedback-on`, { force: true })
    // two submits close together: text typed, then two Enters from separate tmux clients.
    h = hooks()
    type('RACE-A first', 'type race-a')
    await sleep(600)
    key('Enter', 'send race-a Enter')
    await sleep(30)
    type('RACE-B second', 'type race-b')
    await sleep(600)
    key('Enter', 'send race-b Enter')
    await sleep(8000)
    screen('end')
    break
  }
  // S10 errors: a model HTTP 400 reply, then codex killed right after a submit, then resume.
  case 't-errors': {
    await boot()
    let h = hooks()
    await submit('HTTP400 please', 'http400')
    await sleep(8000)
    screen('after http400')
    h = hooks()
    await submit('SLOWTEXT killed after submit', 'killed')
    await nextHook('UserPromptSubmit', h)
    await sleep(300)
    const pids = nativePids()
    mark('kill -9 codex', { pids })
    for (const p of pids.slice(1)) {
      try {
        process.kill(p, 'SIGKILL')
      } catch {}
    }
    await sleep(1000)
    kill()
    await boot(['resume', '--last'])
    await sleep(8000)
    screen('after resume')
    break
  }
  // S10 kill before the record: codex killed ~30 ms after Enter, before its rollout entry.
  case 't-kill-early': {
    await boot()
    await turnIdle('one', 'ONE first')
    type('SLOWTEXT killed early', 'type killed')
    await sleep(600)
    const pids = nativePids()
    key('Enter', 'send killed Enter')
    await sleep(30)
    mark('kill -9 codex', { pids })
    for (const p of pids.slice(1)) {
      try {
        process.kill(p, 'SIGKILL')
      } catch {}
    }
    await sleep(1000)
    kill()
    await boot(['resume', '--last'])
    await sleep(6000)
    screen('after resume')
    break
  }
  // S9 order: while busy, a person Tab-queues P1, then the daemon Enter-submits D1 (and D2 650 ms
  // after a new turn's Enter). Then a background terminal finishing: does anything get injected?
  case 't-order': {
    await boot()
    let h = hooks()
    await submit('TOOLSLEEP busy', 'busy')
    await nextHook('PreToolUse', h)
    type('P1 person tab-queued first', 'type p1')
    await sleep(600)
    key('Tab', 'send p1 Tab')
    await sleep(300)
    await submit('D1 daemon enter second', 'd1')
    await sleep(12000)
    screen('after order')
    h = hooks()
    await submit('SLOWTEXT race-a', 'race-a')
    await sleep(50)
    await submit('RACE-B right after', 'race-b')
    await sleep(14000)
    screen('after race')
    h = hooks()
    await submit('TOOLBG start a background terminal', 'bg')
    await nextHook('Stop', h, 30000)
    await sleep(12000)
    screen('after bg')
    break
  }
  default:
    throw new Error(`unknown scenario ${scenario}`)
}
kill()

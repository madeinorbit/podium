// Drives the REAL codex TUI in a 180x45 tmux pane (unique session name) with the scratch
// CODEX_HOME, marks every keystroke's time into FRAMES_LOG (as `mark` rows, so timeline.ts
// merges them), and snapshots the screen at chosen moments into <run>/log/screens.txt.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

export const R = process.env.R!
const FRAMES_LOG = process.env.FRAMES_LOG!
export const TMUX = `pod4863-${process.pid}`
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const mark = (label: string, extra: unknown = {}) =>
  appendFileSync(FRAMES_LOG, `${JSON.stringify({ at: Date.now(), dir: 'mark', label, extra })}\n`)
const tmux = (...a: string[]) => execFileSync('tmux', a).toString()

export function launch(args: string[] = []) {
  const env = [`HOME=${R}/home`, `CODEX_HOME=${R}/home/.codex`, 'FAKE_KEY=dummy-not-a-key', `HOOK_LOG=${process.env.HOOK_LOG}`, 'TERM=xterm-256color']
  const cmd = `cd ${R}/work && exec env ${env.join(' ')} codex --dangerously-bypass-hook-trust ${args.join(' ')}`
  mark('launch codex', { args })
  tmux('new-session', '-d', '-s', TMUX, '-x', '180', '-y', '45', cmd)
}
export function screen(label: string) {
  let s: string
  try {
    s = tmux('capture-pane', '-p', '-t', TMUX)
  } catch {
    s = '(no pane: the codex process has exited)\n'
  }
  appendFileSync(`${R}/log/screens.txt`, `\n===== ${Date.now()} ${label}\n${s}`)
  return s
}
/** Literal text, no Enter. */
export function type(text: string, label = `type ${JSON.stringify(text).slice(0, 80)}`) {
  mark(label)
  tmux('send-keys', '-t', TMUX, '-l', text)
}
/** A named key (Enter, Escape, Tab, C-c, ...). */
export function key(k: string, label = `key ${k}`) {
  mark(label)
  tmux('send-keys', '-t', TMUX, k)
}
/** Bracketed paste of arbitrary text (what a terminal does for a paste). */
export function paste(text: string, label = 'paste') {
  const f = `${R}/log/.paste`
  require('node:fs').writeFileSync(f, text)
  tmux('load-buffer', '-b', TMUX, f)
  mark(label, { len: text.length })
  tmux('paste-buffer', '-p', '-b', TMUX, '-t', TMUX)
}
export function kill() {
  mark('kill tmux session')
  try {
    tmux('kill-session', '-t', TMUX)
  } catch {}
}
export function panePid(): number {
  return Number(tmux('display-message', '-p', '-t', TMUX, '#{pane_pid}').trim())
}
const lines = (f: string) => (existsSync(`${R}/log/${f}`) ? readFileSync(`${R}/log/${f}`, 'utf8').split('\n').filter(Boolean) : [])
/** Wait until a log line (after `from` lines) matches. */
export async function waitLog(f: string, re: RegExp, ms = 30000, from = 0) {
  const t = Date.now() + ms
  while (Date.now() < t) {
    const l = lines(f).slice(from)
    if (l.some((x) => re.test(x))) return true
    await sleep(25)
  }
  mark(`waitLog timeout ${f} ${re}`)
  return false
}
export const count = (f: string) => lines(f).length
export async function waitScreen(re: RegExp, ms = 20000) {
  const t = Date.now() + ms
  while (Date.now() < t) {
    if (re.test(tmux('capture-pane', '-p', '-t', TMUX))) return true
    await sleep(100)
  }
  screen(`waitScreen timeout ${re}`)
  return false
}
/** Type text, pause (the TUI treats an Enter inside a fast burst as part of a paste), Enter.
 *  The Enter mark is the send time every delay is measured from. */
export async function submit(text: string, id: string, pauseMs = 600) {
  type(text, `type ${id}`)
  await sleep(pauseMs)
  key('Enter', `send ${id} Enter`)
}

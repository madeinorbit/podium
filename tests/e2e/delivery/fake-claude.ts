/**
 * A CLAUDE-SHAPED AGENT THAT WRITES DOWN EVERY PROMPT IT WAS GIVEN (POD-4779).
 *
 * The delivery chain ends at one irreversible act: bytes typed into an agent's
 * terminal and submitted. Whether a message was typed once, twice or never is a
 * fact only the agent can report, so this double is the oracle's ground truth.
 * It is deliberately NOT a mock of the daemon's expectations: it behaves the way
 * Claude Code behaves at the boundary the daemon sees, and nothing more.
 *
 *  - A raw TTY with a quiet `> ` screen, so the drain's settle detector sees it
 *    go idle (the same screen `resume-send-delivery.e2e.test.ts` proved works).
 *  - Bracketed paste is content; a CR outside a paste submits the composer; an
 *    empty submit is ignored, exactly like the real TUI — so the driver's
 *    submit-verification CR nudges never manufacture a prompt.
 *  - Each submit is one turn: `UserPromptSubmit` hook, a user entry in the
 *    transcript, `turnMs` of "work", an assistant entry, then `Stop`. Turns run
 *    one at a time, in submit order.
 *  - Hooks go to the daemon's fixed hook port and are NOT retried: a hook fired
 *    while the daemon is dead is lost, as it is for the real CLI.
 *  - The transcript is at Claude's own layout,
 *    `<home>/.claude/projects/<slug(cwd)>/<nativeId>.jsonl`.
 *
 * Every submit is appended to `<recordDir>/<podiumSessionId>.jsonl` BEFORE the
 * hook fires, fsynced, so a crash anywhere later cannot hide a typed prompt.
 *
 * Environment (the daemon passes its own environment through to the agent):
 *   PODIUM_SESSION_ID              set by the daemon for every agent process
 *   PODIUM_TEST_DELIVERY_DIR       where records and per-session controls live
 *   PODIUM_TEST_DELIVERY_HOOK_PORT the daemon's fixed hook ingest port
 *   PODIUM_TEST_DELIVERY_HOME      the throwaway home holding `.claude/`
 *
 * Two per-session control files, each a bare number re-read at every submit:
 *  - `<recordDir>/<podiumSessionId>.turn-ms` — how long each turn "works", so a
 *    lane can keep an agent busy while messages queue behind it;
 *  - `<recordDir>/<podiumSessionId>.hook-delay-ms` — how long after the submit
 *    the agent shows ANY sign of having taken it (hook and transcript entry
 *    alike). That gap is the one window in which nobody but the agent knows the
 *    prompt was typed: a daemon killed inside it is the ambiguous case.
 */
export const FAKE_CLAUDE_SOURCE = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const dir = process.env.PODIUM_TEST_DELIVERY_DIR
const hookPort = process.env.PODIUM_TEST_DELIVERY_HOOK_PORT
const home = process.env.PODIUM_TEST_DELIVERY_HOME
const podiumSessionId = process.env.PODIUM_SESSION_ID || 'unknown-session'
if (!dir || !hookPort || !home) {
  process.stderr.write('fake-claude: PODIUM_TEST_DELIVERY_{DIR,HOOK_PORT,HOME} are required\n')
  process.exit(2)
}

const argv = process.argv.slice(2)
if (argv[0] === '--version') {
  process.stdout.write('2.1.999 (Claude Code)\n')
  process.exit(0)
}
const resumeAt = argv.indexOf('--resume')
const nativeId = resumeAt >= 0 && argv[resumeAt + 1] ? argv[resumeAt + 1] : crypto.randomUUID()
const cwd = process.cwd()
const projectDir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(projectDir, { recursive: true })
const transcriptPath = path.join(projectDir, nativeId + '.jsonl')
const recordPath = path.join(dir, podiumSessionId + '.jsonl')
const turnMsPath = path.join(dir, podiumSessionId + '.turn-ms')
const hookDelayPath = path.join(dir, podiumSessionId + '.hook-delay-ms')

function durableAppend(file, line) {
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, line + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function record(entry) {
  durableAppend(recordPath, JSON.stringify({ ...entry, pid: process.pid, nativeId, at: Date.now() }))
}

function control(file, fallback) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isFinite(n) && n >= 0 ? n : fallback
  } catch {
    return fallback
  }
}

function hook(event, extra) {
  const body = JSON.stringify({
    session_id: nativeId,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: event,
    ...extra,
  })
  return fetch('http://127.0.0.1:' + hookPort + '/hooks/' + podiumSessionId, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5000),
  }).then(
    (res) => record({ t: 'hook', event, status: res.status }),
    (err) => record({ t: 'hook', event, lost: String(err && err.message ? err.message : err) }),
  )
}

let turnSeq = 0
function transcriptEntry(role, text) {
  turnSeq += 1
  const at = new Date().toISOString()
  const uuid = crypto.randomUUID()
  const message = role === 'user'
    ? { role: 'user', content: text }
    : { role: 'assistant', content: [{ type: 'text', text }] }
  durableAppend(transcriptPath, JSON.stringify({ type: role, uuid, sessionId: nativeId, timestamp: at, cwd, message }))
}

const turns = []
let working = false
async function runTurns() {
  if (working) return
  working = true
  while (turns.length > 0) {
    const prompt = turns.shift()
    const hookDelay = control(hookDelayPath, 0)
    if (hookDelay > 0) await new Promise((resolve) => setTimeout(resolve, hookDelay))
    await hook('UserPromptSubmit', { prompt })
    transcriptEntry('user', prompt)
    await new Promise((resolve) => setTimeout(resolve, control(turnMsPath, 200)))
    transcriptEntry('assistant', 'ok')
    await hook('Stop', {})
  }
  working = false
}

function submit(text) {
  const prompt = text.trim()
  if (!prompt) return
  record({ t: 'submit', prompt })
  turns.push(prompt)
  void runTurns()
}

record({ t: 'boot', argv })
process.stdout.write('\x1b[2J\x1b[H> ')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
let pending = ''
let composer = ''
let inPaste = false
process.stdin.on('data', (buf) => {
  const chunk = Buffer.from(buf).toString('utf8')
  if (chunk === '\x03') process.exit(0)
  pending += chunk
  for (;;) {
    if (inPaste) {
      const end = pending.indexOf(PASTE_END)
      if (end < 0) {
        composer += pending
        pending = ''
        return
      }
      composer += pending.slice(0, end)
      pending = pending.slice(end + PASTE_END.length)
      inPaste = false
      continue
    }
    if (pending.startsWith(PASTE_START)) {
      pending = pending.slice(PASTE_START.length)
      inPaste = true
      continue
    }
    if (pending.length === 0) return
    // A partial paste marker at the tail: wait for the rest of it.
    if (PASTE_START.startsWith(pending)) return
    const ch = pending[0]
    if (ch === '\x1b') {
      // Any other escape sequence (Esc, CSI keys) is a key press, not text.
      const csi = /^\x1b\[[0-9;?]*[ -\/]*[@-~]/.exec(pending)
      pending = pending.slice(csi ? csi[0].length : 1)
      continue
    }
    pending = pending.slice(1)
    if (ch === '\r' || ch === '\n') {
      const text = composer
      composer = ''
      submit(text)
    } else if (ch === '\x15') {
      composer = ''
    } else if (ch === '\x7f') {
      composer = composer.slice(0, -1)
    } else {
      composer += ch
    }
  }
})
`

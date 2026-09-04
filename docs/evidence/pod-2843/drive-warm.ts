/**
 * POD-2843 — absorb claude-code's FIRST-RUN GATES before any measurement runs.
 *
 *   bun docs/evidence/pod-2843/drive-warm.ts
 *
 * WHY THIS EXISTS, AND IT IS NOT HOUSEKEEPING.
 *
 * An isolated agent home is a first-run home, and claude-code puts modal,
 * keyboard-driven gates in front of a first-run session. Two were hit while
 * building this rig, on version 2.1.231:
 *
 *   1. the folder-trust dialog ("Is this a project you created or one you
 *      trust?"), shown before the first turn in an unseen cwd;
 *   2. the auto-mode setup wizard ("Set up auto mode for your environment?"),
 *      which opened AFTER the first turn completed.
 *
 * Each one swallows a typed prompt and writes no transcript turn, so a send
 * into one produces the exact signature of the bug this rig exists to measure:
 * typed, no user turn, row left queued, session reporting `idle`. The second is
 * the more dangerous of the two — it appears only after the first turn, so a
 * drive that checks "did my first send land?" as its positive control passes
 * the control and then measures the wizard.
 *
 * Enumerating the flags that gate each modal would date instantly, so this does
 * not try. It drives a real session through SEVERAL turns and requires the LAST
 * one to land: whatever gates exist get absorbed by the earlier turns, and the
 * final turn is the proof that nothing is holding the composer any more.
 *
 * Run once after drive-up.sh, and again after any claude-code upgrade.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const HOST = process.env.PODIUM_HOST ?? '127.0.0.1'
const PORT = process.env.PODIUM_PORT ?? '19877'
const BASE = `http://${HOST}:${PORT}`
const PASSWORD = process.env.PODIUM_PASSWORD ?? 'p2843'
const DRIVE_BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2843'
const AGENT_HOME = `${process.env.PODIUM_RIG_STATE_ROOT ?? `${DRIVE_BASE}/state`}/agent-home`
if (PORT === '19797' || PORT === '3000') throw new Error(`refusing to drive port ${PORT}`)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString()

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
const trpc = async (path: string, body: unknown) =>
  (await (
    await fetch(`${BASE}/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    })
  ).json()) as { result?: { data?: unknown }; error?: { message?: string } }
const trpcQuery = async (path: string, input: unknown) =>
  (await (
    await fetch(`${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, {
      headers: { cookie },
    })
  ).json()) as { result?: { data?: Record<string, unknown> } }

const jsonlHasUserTurn = (needle: string): boolean => {
  const root = join(AGENT_HOME, '.claude', 'projects')
  if (!existsSync(root)) return false
  for (const dir of readdirSync(root)) {
    const full = join(root, dir)
    if (!statSync(full).isDirectory()) continue
    for (const f of readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue
      let text: string
      try {
        text = readFileSync(join(full, f), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (!line.includes(needle)) continue
        try {
          if ((JSON.parse(line) as { type?: string }).type === 'user') return true
        } catch {
          /* partial tail line */
        }
      }
    }
  }
  return false
}

const created = (await trpc('sessions.create', {
  cwd: `${DRIVE_BASE}/repo`,
  agentKind: 'claude-code',
})) as { result?: { data?: { sessionId?: string } } }
const sid = created.result?.data?.sessionId
if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created)}`)
console.log(`[${stamp()}] warm-up session ${sid}`)
await wait(30_000)

/** THREE, not one. Gate (1) fires before the first turn and gate (2) after it,
 *  so only a third send is typed at a composer that has survived both. */
const TURNS = 3
let landed = false
for (let i = 1; i <= TURNS; i++) {
  const needle = `pod2843-warm-${process.pid}-${i}`
  await trpc('sessions.sendText', {
    sessionId: sid,
    text: `Reply with exactly this word and nothing else: ${needle}`,
  })
  const until = Date.now() + 120_000
  landed = false
  while (Date.now() < until) {
    await wait(1_000)
    if (jsonlHasUserTurn(needle)) {
      landed = true
      break
    }
  }
  console.log(`[${stamp()}] warm turn ${i}/${TURNS}: ${landed ? 'landed' : 'DID NOT LAND'}`)
  // Settle to idle so the next send is not merely queued behind a running turn.
  const idleBy = Date.now() + 120_000
  while (Date.now() < idleBy) {
    const m = await trpcQuery('sessions.status', { ref: sid })
    if (m.result?.data?.phase === 'idle') break
    await wait(2_000)
  }
}

await trpc('sessions.stop', { sessionId: sid }).catch(() => undefined)

if (!landed) {
  console.error(
    `\nWARM-UP FAILED: the last of ${TURNS} sends never became a user turn. Something is ` +
      `holding this CLI's composer that more turns will not clear — read the pane before ` +
      `running any arm, because every arm will now measure it.`,
  )
  process.exit(2)
}
console.log(`\nagent home is warm: send ${TURNS} of ${TURNS} landed with no gate in the way.`)

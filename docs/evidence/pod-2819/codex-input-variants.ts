/**
 * WHAT DOES `codex app-server` ACTUALLY ACCEPT AS PROMPT INPUT?
 *
 * POD-2777's matrix scored codex `attach` FAIL on the headless driver and PASS
 * on its PTY — the epic's only cell where headless was WORSE than what ships
 * today. The headless driver refused a text file with a typed `unsupported`
 * reading "Codex accepts image attachments only", which is the contract working
 * IF the declaration is true. This script is how that was settled, and it runs
 * with NO PODIUM IN THE LOOP AT ALL: a child `codex app-server`, raw JSON-RPC,
 * so nothing here can be an artefact of a driver, a daemon or a rig.
 *
 *   bun docs/evidence/pod-2819/codex-input-variants.ts            # every arm
 *   bun docs/evidence/pod-2819/codex-input-variants.ts enumerate  # just arm 0
 *
 * THE CONTROLS
 *
 * `enumerate` is the whole argument for the declaration and it is a NEGATIVE
 * control by construction: it sends an input variant that does not exist and
 * lets the SERVER name the set it does accept. That is codex describing itself
 * in its own words — not a reading of documentation, not a schema someone
 * generated once and left to rot beside a moving binary.
 *
 * `reply` is the positive control for every arm below it, and it is the same
 * one POD-2777's attach probe uses: a plain send on this transport having
 * already answered. Without it, "the agent did not produce the secret" and
 * "nothing here is alive" are the same reading.
 *
 * Every file arm carries a NEGATIVE control too: the secret exists only in the
 * bytes of the staged file. An agent can agree that it sees a file without
 * reading one; it cannot produce those bytes without having read them.
 *
 * EACH ARM GETS ITS OWN cwd AND ITS OWN STAGING DIR. The first version shared
 * one directory and an agent that went looking answered one arm with the
 * NEIGHBOURING arm's secret — a false positive that looked exactly like a pass.
 *
 * THE STAGING DIR IS OUTSIDE THE THREAD'S cwd, deliberately, because that is
 * where Podium stages: `<stateDir>/uploads/<sessionId>/`. An arm that staged
 * inside the workspace would measure an easier question than the product asks.
 *
 * `thread/start` IS CALLED THE WAY THE DRIVER CALLS IT — `cwd` and nothing else,
 * no sandbox or approval override — so the sandbox posture under test is the
 * product's, not this script's. That matters: an earlier run forced
 * `sandbox: workspace-write` and hit this box's `use_legacy_landlock` config,
 * which crashes the sandbox helper and reads exactly like "the agent could not
 * read the attachment".
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { digitsPng } from '../pod-2777/nonce-png.ts'

const BASE = process.env.CX2819_BASE ?? '/tmp/pod-2819-variants'
const TURN_MS = Number(process.env.CX2819_TURN_MS ?? 180_000)

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const waiters: Array<(m: Record<string, any>) => boolean> = []
child.stdout.on('data', (d: Buffer) => {
  buf += d.toString()
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg: Record<string, any>
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k]?.(msg)) waiters.splice(k, 1)
  }
})
child.stderr.on('data', () => {})

let nextId = 1
const write = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`)
function call(method: string, params?: unknown): Promise<any> {
  const id = nextId++
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), TURN_MS)
    waiters.push((m) => {
      if (m.id !== id) return false
      clearTimeout(t)
      if (m.error) rej(new Error(JSON.stringify(m.error)))
      else res(m.result)
      return true
    })
    write({ jsonrpc: '2.0', id, method, params })
  })
}

async function turn(threadId: string, input: unknown[]) {
  const items: any[] = []
  const done = new Promise<void>((res) => {
    waiters.push((m) => {
      if (m.method === 'item/completed' && m.params?.threadId === threadId) {
        items.push(m.params.item)
        return false
      }
      if (
        (m.method === 'turn/completed' || m.method === 'turn/failed') &&
        m.params?.threadId === threadId
      ) {
        res()
        return true
      }
      return false
    })
  })
  await call('turn/start', { threadId, input })
  await Promise.race([done, new Promise((r) => setTimeout(r, TURN_MS))])
  return {
    text: items
      .filter((i) => i?.type === 'agentMessage')
      .map((i) => String(i.text ?? ''))
      .join('\n')
      .trim(),
    itemTypes: items.map((i) => i?.type),
    userMessage: items.find((i) => i?.type === 'userMessage'),
  }
}

/** One arm's own world: a cwd it can see and a staging dir it cannot, holding
 *  only this arm's bytes. */
function world(name: string) {
  const root = `${BASE}/${name}`
  rmSync(root, { recursive: true, force: true })
  mkdirSync(`${root}/cwd`, { recursive: true })
  mkdirSync(`${root}/uploads`, { recursive: true })
  return { cwd: `${root}/cwd`, uploads: `${root}/uploads` }
}

const only = process.argv.slice(2)
const want = (n: string) => only.length === 0 || only.includes(n)
const results: any[] = []

await call('initialize', {
  clientInfo: { name: 'podium-pod-2819', title: 'Podium POD-2819 probe', version: '0.0.0' },
  capabilities: { experimentalApi: true, requestAttestation: false },
})
write({ jsonrpc: '2.0', method: 'initialized' })

const newThread = async (cwd: string) => {
  const r = await call('thread/start', { cwd })
  return { id: r.thread.id as string, model: r.model as string }
}

const PROMPT = 'The attached file contains a secret word. Reply with exactly that secret word and nothing else.'

// -- 0. THE NEGATIVE CONTROL: let the server enumerate its own accepted set ---
if (want('enumerate')) {
  const w = world('enumerate')
  const th = await newThread(w.cwd)
  let said = 'NO ERROR — the server accepted a variant that is not in its schema'
  try {
    await call('turn/start', {
      threadId: th.id,
      input: [{ type: 'localFile', path: `${w.cwd}/nothing.txt` }],
    })
  } catch (err) {
    said = String(err)
  }
  results.push({
    arm: 'enumerate (negative control)',
    accepted: /expected one of/.test(said),
    reading: said,
  })
}

// -- 1. THE POSITIVE CONTROL: a plain send answers ---------------------------
if (want('reply')) {
  const w = world('reply')
  const th = await newThread(w.cwd)
  const r = await turn(th.id, [
    {
      type: 'text',
      text: 'Reply with exactly PODIUM-2819-CONTROL and nothing else. Do not use any tools.',
      text_elements: [],
    },
  ])
  results.push({
    arm: 'reply (positive control)',
    model: th.model,
    pass: r.text.includes('PODIUM-2819-CONTROL'),
    answer: r.text,
  })
}

// -- 2. A TEXT FILE, three vehicles ------------------------------------------
const FILE_ARMS = [
  {
    id: 'mention',
    secret: 'FILESECRET-MENTION1',
    build: (p: string) => [
      { type: 'mention', name: 'secret.txt', path: p },
      { type: 'text', text: PROMPT, text_elements: [] },
    ],
  },
  {
    id: 'path-text',
    secret: 'FILESECRET-PATHTXT2',
    build: (p: string) => [{ type: 'text', text: `${p}\n${PROMPT}`, text_elements: [] }],
  },
  {
    id: 'mention+path-text',
    secret: 'FILESECRET-BOTH3',
    build: (p: string) => [
      { type: 'mention', name: 'secret.txt', path: p },
      { type: 'text', text: `${p}\n${PROMPT}`, text_elements: [] },
    ],
  },
]
for (const arm of FILE_ARMS) {
  if (!want(arm.id)) continue
  const w = world(arm.id)
  const file = `${w.uploads}/secret.txt`
  writeFileSync(file, `A note staged by Podium.\nThe secret word is ${arm.secret}\n`)
  const th = await newThread(w.cwd)
  const r = await turn(th.id, arm.build(file))
  results.push({
    arm: arm.id,
    secret: arm.secret,
    staged: file,
    pass: r.text.includes(arm.secret),
    answer: r.text.slice(0, 300),
    itemTypes: r.itemTypes,
    userMessage: r.userMessage,
  })
}

// -- 3. AN IMAGE, and how legible POD-2777's nonce actually is ---------------
//
// `localImage` is what the driver already sent, so this arm is not asking
// whether the wire shape is right — it is asking what a MISS means. Repeat it:
// a per-digit agreement rate far above 1-in-10 is the image arriving, whatever
// the exact-match verdict says.
if (want('image')) {
  const trials = Number(process.env.CX2819_IMAGE_TRIALS ?? 4)
  for (let t = 0; t < trials; t++) {
    const w = world(`image-${t}`)
    const secret = String(100_000 + ((t * 137_911 + 39_671) % 900_000))
    const png = `${w.uploads}/nonce.png`
    writeFileSync(png, digitsPng(secret))
    const th = await newThread(w.cwd)
    const r = await turn(th.id, [
      { type: 'localImage', path: png },
      {
        type: 'text',
        text: 'This image contains a 6-digit number in large black blocky digits. Reply with exactly those six digits and nothing else. Do not use any tools.',
        text_elements: [],
      },
    ])
    const got = (r.text.match(/\d{6}/) ?? [''])[0]
    const agree = [...secret].filter((d, i) => d === got[i]).length
    results.push({
      arm: `localImage trial ${t + 1}`,
      secret,
      answer: r.text.slice(0, 120),
      digitsRead: got,
      digitsAgreeing: agree,
      pass: got === secret,
    })
  }
}

for (const r of results) {
  const verdict = r.pass === undefined ? (r.accepted ? 'OK  ' : 'BAD ') : r.pass ? 'PASS' : 'FAIL'
  console.error(
    `${verdict}  ${r.arm}${r.secret ? `  want=${r.secret}` : ''}${r.digitsRead !== undefined ? ` got=${r.digitsRead} agreeing=${r.digitsAgreeing}/6` : r.answer ? ` got=${String(r.answer).replace(/\n/g, ' ').slice(0, 70)}` : ''}`,
  )
  if (r.reading) console.error(`      ${r.reading}`)
}
console.log(JSON.stringify(results, null, 2))
child.kill()
process.exit(0)

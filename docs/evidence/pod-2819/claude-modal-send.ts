/**
 * WHAT HAPPENS TO A TURN SENT WHILE CLAUDE'S AUTO-MODE MODAL IS UP?
 *
 * This is the mechanism behind POD-2777's `claude / attach` FAIL, isolated from
 * attachments entirely. Claude's environment-onboarding dialog ("Set up auto
 * mode for your environment?") arrives PARTWAY THROUGH a session, after the
 * first turn has already answered. The next injected turn goes into the dialog
 * instead of the composer, its Enter picks the highlighted option, and the
 * prompt is gone — while `sessions.sendText` answered `{ok:true,
 * disposition:'delivered'}`.
 *
 * A message reported delivered and then silently dropped is a product question,
 * not a rig one, and this epic has the machinery to answer it: the terminal
 * driver refuses a send into `needs_user` without a post-ESC, and
 * `packages/harness/src/agent-state/claude-screen.ts` classifies this exact
 * dialog as `needs_user`. So either the classifier does not see this screen, or
 * it does and the refusal does not reach the caller. This says which.
 *
 *   bun docs/evidence/pod-2819/claude-modal-send.ts <cwd>
 *
 * NO PRIMING, DELIBERATELY. Every other probe here clears the modal first
 * because it wants to measure something else. This one wants the modal.
 *
 * THE CONTROL is the same as everywhere: a plain send having already answered,
 * so a silent second turn cannot be confused with a session that was never
 * alive. The modal is confirmed ON SCREEN in the moment before the second send
 * — a send into a screen that had already cleared would measure nothing, the
 * same way interrupting nothing always looks like success.
 */

import { randomUUID } from 'node:crypto'
import { Chat, login, mutate, sessionRow, until, untilText, wait } from '../pod-2777/rig'

const cwd = process.argv[2]
if (!cwd) {
  console.error('usage: claude-modal-send.ts <cwd>')
  process.exit(2)
}
const label = process.env.POD2819_ARM ?? `port ${process.env.PODIUM_PORT ?? '?'}`
const nonce = (tag: string) => `${tag}-${randomUUID().slice(0, 6).toUpperCase()}`
const line = (k: string, v: unknown) => console.log(`   ${k.padEnd(20)} ${String(v)}`)
const AUTO_MODE = /Set ?up ?auto ?mode ?for ?your ?environment/i

await login()
const created = await mutate('sessions.create', { cwd, agentKind: 'claude-code' })
const sid = created.result?.data?.sessionId as string
console.log(`\n=== claude / send into the auto-mode modal — ${label} ===`)
line('SESSION', sid)
await wait(25_000)
const bound = await until(sid, (r) => Boolean(r?.driverId) || r?.status === 'live', 90_000, 1_000)
line('BOUND DRIVER', bound.row?.driverId ?? '(none — no runtime contract on this build)')

const chat = new Chat(sid)
await chat.open()

// -- the control -------------------------------------------------------------
const hello = nonce('PODIUM')
const before0 = chat.assistantText().length
await mutate('sessions.sendText', {
  sessionId: sid,
  text: `Reply with exactly this word and nothing else: ${hello}. Do not use any tools.`,
})
const replied = await untilText(chat, (t) => t.slice(before0).includes(hello), 180_000)
line('CONTROL', replied.ok ? `FIRED — replied in ${replied.ms}ms` : 'DID NOT FIRE')
if (!replied.ok) {
  console.log('   REFUSED — no working send to compare against.')
  process.exit(0)
}

// -- wait for the modal, and refuse to measure without it --------------------
let sawModal = false
for (let i = 0; i < 40; i++) {
  if (AUTO_MODE.test(chat.screenTail(4_000))) {
    sawModal = true
    break
  }
  await wait(3_000)
}
const rowAtModal = await sessionRow(sid)
line('MODAL ON SCREEN', sawModal ? 'yes' : 'no — it never appeared in 120s')
line('PHASE AT THAT MOMENT', rowAtModal?.agentState?.phase ?? '(none)')
line('INTERACTION VISIBLE', JSON.stringify(rowAtModal?.agentState?.needs ?? null).slice(0, 120))
const asks = await mutate('interactions.list', { sessionId: sid })
line('INTERACTIONS.LIST', JSON.stringify(asks.result?.data ?? asks.result ?? null).slice(0, 200))
if (!sawModal) {
  console.log('   REFUSED — the modal never appeared, so a send here measures the ordinary path.')
  process.exit(0)
}

// -- the send under test -----------------------------------------------------
const marker = nonce('AFTERMODAL')
const before = chat.assistantText().length
const sent = await mutate('sessions.sendText', {
  sessionId: sid,
  text: `Reply with exactly this word and nothing else: ${marker}. Do not use any tools.`,
})
line('SEND ANSWERED', JSON.stringify(sent.result?.data ?? sent.error ?? null).slice(0, 200))
const landed = await untilText(chat, (t) => t.slice(before).includes(marker), 120_000)
line('MARKER CAME BACK', landed.ok ? `yes, after ${landed.ms}ms` : 'no')

const refused = JSON.stringify(sent.result?.data ?? {}).includes('refus')
console.log('')
if (landed.ok) {
  console.log('   THE MODAL DID NOT EAT IT — the turn reached claude anyway.')
} else if (refused) {
  console.log('   REFUSED HONESTLY — the send said it did not deliver, and it did not.')
  console.log('   That is the contract working: a caller can tell.')
} else {
  console.log('   DELIVERED AND LOST — the send reported success and the turn never')
  console.log('   reached claude. A caller cannot tell this from a turn that ran.')
}
process.exit(0)

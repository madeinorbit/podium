/**
 * POD-3069 A1c adapter for drivers whose stamped process is wrapped.
 *
 * This keeps POD-3044's sequence intact: prove an alive send, read the daemon
 * instance stamp plus the session stamp, SIGKILL the exact session owner,
 * send to the dead session, and follow an accepted nonce for the full delayed
 * window. Claude's PTY has two abduco transport processes around one Claude
 * executable, so the stock single-process guard would refuse a valid Claude
 * reading before the kill. For that terminal backend the session owner is the
 * uniquely stamped `abduco -n` master; the attach client and Claude leaf are
 * transport/command descendants, not the durable session owner.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { basename } from 'node:path'

import {
  AGENT_KIND,
  Chat,
  REPO,
  login,
  mutate,
  nonce,
  now,
  sessionRow,
  settle,
  until,
  wait,
} from '../pod-2777/rig'
import { isA1cTypedRefusal, scoreA1c } from '../pod-2777/scorer-contracts'

const harness = process.argv[2] ?? ''
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const DEAD_OUTCOME_MS = Number(process.env.P2777_A1C_OUTCOME_MS ?? 120_000)

if (!['claude', 'grok', 'opencode'].includes(harness)) {
  throw new Error(`expected claude, grok, or opencode; received ${JSON.stringify(harness)}`)
}

const log = (line: string) => console.log(line)

interface StampedProcess {
  pid: number
  ppid: number
  comm: string
  exe: string
  cwd: string
  cmd: string
  startTicks: string
  instanceUuid: string
  sessionId: string
}

function processEnvironment(pid: number): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const equals = entry.indexOf('=')
      if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1)
    }
  } catch {}
  return env
}

function processStartTicks(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    return close < 0 ? '' : stat.slice(close + 2).trim().split(/\s+/)[19] ?? ''
  } catch {
    return ''
  }
}

function stampedProcesses(instanceUuid: string, sessionId: string): StampedProcess[] {
  const rows: StampedProcess[] = []
  if (!instanceUuid || !sessionId) return rows
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    const env = processEnvironment(pid)
    if (env.PODIUM_INSTANCE_UUID !== instanceUuid || env.PODIUM_SESSION_ID !== sessionId) continue
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      rows.push({
        pid,
        ppid: Number(readFileSync(`/proc/${pid}/stat`, 'utf8').slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2).trim().split(/\s+/)[1] ?? 0),
        comm: readFileSync(`/proc/${pid}/comm`, 'utf8').trim(),
        exe: readlinkSync(`/proc/${pid}/exe`),
        cwd: readlinkSync(`/proc/${pid}/cwd`),
        cmd: cmd.replace(/\s+/g, ' ').slice(0, 180),
        startTicks: processStartTicks(pid),
        instanceUuid,
        sessionId,
      })
    } catch {}
  }
  return rows.filter((row) => row.startTicks)
}

function instanceStamp(): { uuid: string; source: string } {
  const stateRoot = process.env.PODIUM_RIG_STATE_ROOT ?? ''
  try {
    const marker = JSON.parse(readFileSync(`${stateRoot}/instance.json`, 'utf8')) as {
      instanceId?: unknown
      instanceUuid?: unknown
    }
    if (
      marker.instanceId === process.env.PODIUM_INSTANCE &&
      typeof marker.instanceUuid === 'string' &&
      marker.instanceUuid
    ) {
      return { uuid: marker.instanceUuid, source: `${stateRoot}/instance.json` }
    }
  } catch {}
  return { uuid: '', source: '(missing)' }
}

function isTargetSessionProcess(row: StampedProcess): boolean {
  const comm = row.comm.toLowerCase()
  const exeName = basename(row.exe).toLowerCase()
  if (harness === 'claude') {
    return (comm === 'abduco' || exeName === 'abduco') && /(?:^\s|\s)-n\s/.test(row.cmd)
  }
  if (harness === 'grok') return comm === 'grok' || exeName === 'grok' || exeName === 'grok-acp'
  return comm === 'opencode' || exeName === 'opencode'
}

function sameProcess(a: StampedProcess, b: StampedProcess): boolean {
  return a.pid === b.pid && a.startTicks === b.startTicks
}

let sessionId = ''
let chat: Chat | undefined
let verdict: 'PASS' | 'FAIL' | 'REFUSED' = 'REFUSED'

try {
  await login()
  log('='.repeat(78))
  log(`A1c  send to a DEAD session   harness=${harness}`)
  log('method           POD-3044 sequence; executable-level selection within exact UUID+session stamp')
  log('delayed window   120s when the dead send is accepted')
  log('='.repeat(78))

  const created = await mutate('sessions.create', { cwd: REPO, agentKind })
  sessionId = created.result?.data?.sessionId as string | undefined ?? ''
  if (!sessionId) {
    log(`sessions.create FAILED: ${JSON.stringify(created).slice(0, 500)}`)
  } else {
    log(`session ${sessionId}`)
    await wait(READY_MS)
    await wait(READY_MS)
    const bound = await until(sessionId, (row) => Boolean(row?.driverId), 90_000, 1_000)
    const boundRow = bound.row ?? (await sessionRow(sessionId))
    log(`product driver   ${boundRow?.driverId ?? '(none)'} family=${boundRow?.driverFamily ?? '(none)'}`)

    const expected =
      harness === 'claude'
        ? ['claude-pty', 'terminal']
        : harness === 'grok'
          ? ['grok-acp', 'server']
          : ['opencode-server', 'server']
    if (boundRow?.driverId !== expected[0] || boundRow?.driverFamily !== expected[1]) {
      log(`REFUSED — expected ${expected[0]}/${expected[1]}, received ${boundRow?.driverId ?? '(none)'}/${boundRow?.driverFamily ?? '(none)'}`)
    } else {
      chat = new Chat(sessionId)
      await chat.open('chat')
      await settle(sessionId)

      const aliveWord = nonce('ALIVE')
      const aliveSend = await mutate('sessions.sendText', {
        sessionId,
        text: `Reply with exactly this word and nothing else: ${aliveWord}. Do not use any tools.`,
      })
      const aliveOk = await (async () => {
        const deadline = now() + 90_000
        while (now() < deadline) {
          if (chat?.assistantText().includes(aliveWord)) return true
          await wait(1_000)
        }
        return false
      })()
      log(`CONTROL          live send answered: ${aliveOk}`)
      log(`live send return  ${JSON.stringify(aliveSend.result?.data ?? aliveSend.error ?? null).slice(0, 300)}`)

      if (!aliveOk) {
        log('REFUSED — the positive live-send control did not fire.')
      } else {
        const stamp = instanceStamp()
        const before = stampedProcesses(stamp.uuid, sessionId)
        const candidates = before.filter(isTargetSessionProcess)
        log(`target stamp     uuid=${stamp.uuid || '(missing)'} source=${stamp.source}`)
        log(`stamped chain    ${before.length} exact UUID+session process(es)`)
        for (const row of before) {
          log(`  stamped pid=${row.pid} ppid=${row.ppid} comm=${row.comm} exe=${row.exe} cwd=${row.cwd} cmd=${row.cmd}`)
        }
        log(
          `target selector   ${harness === 'claude' ? 'durable abduco -n session owner' : 'harness executable name'}; candidates=${candidates.length}`,
        )

        if (!stamp.uuid || candidates.length !== 1) {
          log('REFUSED — exact stamped harness-child attribution was not unique.')
        } else {
          const target = candidates[0]
          let killSent = false
          let killError = ''
          try {
            process.kill(target.pid, 'SIGKILL')
            killSent = true
          } catch (error) {
            killError = String(error)
          }
          const goneDeadline = now() + 15_000
          let targetGone = false
          while (now() < goneDeadline) {
            targetGone = !stampedProcesses(stamp.uuid, sessionId).some((row) => sameProcess(row, target))
            if (targetGone) break
            await wait(250)
          }
          const deadRow = await sessionRow(sessionId)
          const after = stampedProcesses(stamp.uuid, sessionId)
          const deadConfirmed = killSent && targetGone
          log(`SIGKILL target   pid=${target.pid} start=${target.startTicks} sent=${killSent}${killError ? ` error=${killError}` : ''}`)
          log(`after child kill  row status=${deadRow?.status ?? '(row gone entirely)'}`)
          log(`exact PID gone   ${targetGone}; remaining stamped PIDs=${after.map((row) => row.pid).join(',') || '(none)'}`)
          log(`dead confirmed   ${deadConfirmed}`)

          const deadWord = nonce('AFTERDEATH')
          const deadSend = await mutate('sessions.sendText', {
            sessionId,
            text: `Reply with exactly this word and nothing else: ${deadWord}.`,
          })
          const data = deadSend.result?.data as Record<string, unknown> | undefined
          const errorMessage = String(deadSend.error?.message ?? deadSend.error?.json?.message ?? '')
          const reason = String(data?.reason ?? data?.disposition ?? '')
          const disposition = String(data?.disposition ?? '')
          const typedRefusal = isA1cTypedRefusal({
            ok: data?.ok,
            hasError: Boolean(deadSend.error),
            reason,
            disposition,
            errorMessage,
          })
          const accepted =
            data?.ok === true ||
            data?.queued === true ||
            disposition === 'queued' ||
            disposition === 'delivered' ||
            disposition === 'accepted'
          const delayedDelivered = accepted
            ? await (async () => {
                const deadline = now() + DEAD_OUTCOME_MS
                while (now() < deadline) {
                  if (chat?.assistantText().includes(deadWord)) return true
                  await wait(Math.min(1_000, deadline - now()))
                }
                return false
              })()
            : false
          log(`send to dead     ${JSON.stringify(data ?? deadSend.error ?? null).slice(0, 400)}`)
          log(`typed refusal    ${typedRefusal}${typedRefusal ? ` — reason=${JSON.stringify(reason || errorMessage.slice(0, 140))}` : ''}`)
          log(`accepted         ${accepted}`)
          log(`delayed outcome  ${accepted ? `${delayedDelivered ? 'DELIVERED' : 'LOST'} after <=${Math.round(DEAD_OUTCOME_MS / 1000)}s` : 'not applicable (refused before acceptance)'}`)
          verdict = scoreA1c({
            controlFired: aliveOk,
            deadConfirmed,
            typedRefusal,
            accepted,
            delayedDelivered,
          })
          log(`A1c ${verdict}`)
        }
      }
    }
  }
} finally {
  await chat?.close().catch(() => {})
  if (sessionId) await mutate('sessions.kill', { sessionId }).catch(() => {})
}

process.exitCode = verdict === 'PASS' ? 0 : 1

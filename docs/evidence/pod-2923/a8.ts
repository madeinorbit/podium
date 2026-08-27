/**
 * POD-2923 A8 — Codex logged-out spawn and safe post-login binding check.
 *
 * The credential is an existing fixture copied into this named rig by
 * drive-up.sh. It is moved aside and restored; this probe never creates a
 * credential and never performs operator OAuth. The restored credential is the
 * same safe post-login control used by the successful Grok A8 drive.
 *
 * Pass criterion:
 *   a logged-out spawn exposes a working login path, and the next fresh
 *   session after login binds the Codex server driver.
 *
 * The first control proves that this rig can bind codex-app-server while the
 * credential is present. The logged-out control is read from product state
 * (session condition/requested-vs-actual driver/account readout), not inferred
 * from moving a file. The post-login control is a fresh binding receipt after
 * restoring the fixture credential and restarting the daemon.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'

import {
  AGENT_KIND,
  Chat,
  REPO,
  login,
  mutate,
  query,
  sessionRow,
  until,
  wait,
  primeTerminalTui,
} from '../pod-2777/rig'

const log = (line: string) => console.log(line)
const stateRoot = process.env.P2777_STATE_ROOT
const driveBase = process.env.PODIUM_DRIVE_BASE
const repo = process.env.PODIUM_DRIVE_REPO ?? process.cwd()
const credential = stateRoot ? `${stateRoot}/agent-home/.codex/auth.json` : ''
const parked = credential ? `${credential}.a8-parked` : ''
const agentKind = AGENT_KIND.codex
const readyMs = Number(process.env.P2777_READY_MS ?? 25_000)
const bindMs = 90_000
const restartScript = `${repo}/docs/evidence/pod-2923/restart-daemon.sh`

type RawRow = Record<string, any>

type Spawned = {
  label: string
  sid: string
  row?: RawRow
  chat: Chat
}

function currentPin(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
  return String(result.stdout ?? '').trim()
}

function filePin(name: string): string {
  if (!driveBase) return '(no drive base)'
  try {
    return readFileSync(`${driveBase}/${name}`, 'utf8').trim()
  } catch {
    return `(missing ${name})`
  }
}

function bundlePin(): string {
  try {
    const stamp = JSON.parse(readFileSync(`${repo}/apps/web/dist/podium-build.json`, 'utf8'))
    return String(stamp.sourceSha ?? '(no sourceSha)')
  } catch {
    return '(missing web stamp)'
  }
}

function pinSnapshot(): string {
  return [
    `HEAD=${currentPin()}`,
    `server.sha=${filePin('server.sha')}`,
    `daemon.sha=${filePin('daemon.sha')}`,
    `web.sourceSha=${bundlePin()}`,
  ].join(' ')
}

function rowFields(row: RawRow | undefined): string {
  if (!row) return 'row=(missing)'
  return [
    `driver=${row.driverId ?? '(none)'}`,
    `requested=${row.requestedDriverId ?? '(none)'}`,
    `family=${row.driverFamily ?? '(none)'}`,
    `status=${row.status ?? '(none)'}`,
    `condition=${row.condition ?? '(none)'}`,
    `error=${row.agentState?.error?.class ?? '(none)'}`,
  ].join(' ')
}

function restartDaemon(label: string): void {
  const result = spawnSync('bash', [restartScript], {
    cwd: repo,
    env: process.env,
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  log(`${label} daemon restart exit=${result.status ?? '(signal)'}\n${output}`)
  if (result.status !== 0) throw new Error(`${label} daemon restart failed`)
  log(`${label} pins after restart: ${pinSnapshot()}`)
}

async function spawnAndRead(label: string): Promise<Spawned | undefined> {
  const spawnPin = currentPin()
  log(`${label} spawn-time HEAD=${spawnPin}`)
  const created = await mutate('sessions.create', { cwd: REPO, agentKind })
  const sid = created.result?.data?.sessionId as string | undefined
  if (!sid) {
    log(`${label} sessions.create FAILED ${JSON.stringify(created).slice(0, 800)}`)
    return undefined
  }

  await wait(readyMs)
  const bound = await until(
    sid,
    (row) => Boolean(row?.driverId) || row?.status === 'exited',
    bindMs,
    1_000,
  )
  const row = (bound.row ?? (await sessionRow(sid))) as RawRow | undefined
  const chat = new Chat(sid)
  await chat.open('native')
  await wait(10_000)
  log(`${label} sid=${sid} ${rowFields(row)}`)
  log(`${label} native attached=${JSON.stringify(chat.attached ?? null)} screenBytes=${chat.screenBytes}`)
  log(`${label} screen tail:\n${chat.screenTail(2_400) || '(empty)'}`)
  return { label, sid, row, chat }
}

async function dispose(spawned: Spawned | undefined): Promise<void> {
  if (!spawned) return
  await spawned.chat.close().catch(() => {})
  await mutate('sessions.kill', { sessionId: spawned.sid }).catch(() => {})
}

function productLoggedOut(row: RawRow | undefined, accounts: unknown, machines: unknown): boolean {
  const accountText = JSON.stringify(accounts)
  const machineText = JSON.stringify(machines)
  return Boolean(
    row?.condition === 'logged-out' ||
      (row?.requestedDriverId && row.requestedDriverId !== row.driverId) ||
      row?.agentState?.error?.class ||
      /"loginRequired"\s*:\s*true/.test(accountText) ||
      /"state"\s*:\s*"out"/.test(machineText),
  )
}

function loginPathVisible(screen: string): boolean {
  return /log[ -]?in|not logged|sign[ -]?in|authenticate|api key|device code|browser|credential|unauthori[sz]ed/i.test(
    screen,
  )
}

async function main(): Promise<number> {
  await login()
  log('='.repeat(78))
  log('A8 logged-out spawn harness=codex')
  log('criterion: login path visible while logged out; fresh post-login session binds codex-app-server/server')
  log(`credential=${credential}`)
  log(`credential present at start=${Boolean(credential && existsSync(credential))}`)
  if (credential && existsSync(credential)) {
    const stat = statSync(credential)
    log(`credential mtime=${stat.mtime.toISOString()} size=${stat.size}`)
  }
  log(`initial pins: ${pinSnapshot()}`)

  if (!stateRoot || !driveBase || !credential || !existsSync(credential)) {
    log('A8 REFUSED — the logged-in credential control is unavailable; no credential was created.')
    return 2
  }
  if (existsSync(parked)) {
    log(`A8 REFUSED — stale parked credential already exists at ${parked}`)
    return 2
  }

  let control: Spawned | undefined
  let loggedOut: Spawned | undefined
  let postLogin: Spawned | undefined
  let moved = false

  try {
    // Positive control: this must fire before the credential is moved.
    control = await spawnAndRead('CONTROL logged-in')
    const controlFired =
      Boolean(control?.row?.driverId) &&
      control?.row?.driverId === 'codex-app-server' &&
      control?.row?.driverFamily === 'server'
    log(`CONTROL logged-in codex-app-server/server=${controlFired}`)
    if (control) {
      const primed = await primeTerminalTui(control.chat, control.sid)
      log(`CONTROL Codex TUI primer actions=${primed.length ? primed.join(' | ') : '(none)'}`)
    }
    await dispose(control)
    control = undefined
    if (!controlFired) {
      log('A8 REFUSED — the positive control did not bind codex-app-server/server.')
      log('The logged-out demotion cannot be distinguished from a rig that was never authenticated.')
      return 2
    }

    // Measurement: move the existing fixture credential, then restart the
    // daemon so this spawn cannot reuse a driver/account state cached before
    // the product became logged out.
    renameSync(credential, parked)
    moved = true
    log(`AUTH OFF moved existing credential to ${parked}`)
    restartDaemon('AUTH OFF')

    loggedOut = await spawnAndRead('LOGGED OUT')
    const accounts = await query('accounts.list', {})
    const machines = await query('machines.list', {})
    const accountData = accounts.result?.data ?? null
    const machineData = machines.result?.data ?? null
    const row = loggedOut?.row
    const screen = loggedOut?.chat.screenTail(8_000) ?? ''
    const productState = productLoggedOut(row, accountData, machineData)
    const loginPath = loginPathVisible(screen)
    const loggedOutControl = Boolean(row?.driverId || loggedOut?.chat.screenBytes > 0) && productState
    log('')
    log('LOGGED OUT product surfaces')
    log(`  control fired (session driver or native bytes)=${Boolean(row?.driverId || loggedOut?.chat.screenBytes > 0)}`)
    log(`  product logged-out state=${productState}`)
    log(`  login path visible on native terminal=${loginPath}`)
    log(`  row=${JSON.stringify(row ?? null)}`)
    log(`  accounts.list=${JSON.stringify(accountData).slice(0, 2_000)}`)
    log(`  machines.list=${JSON.stringify(machineData).slice(0, 2_000)}`)
    log(`  full login-screen sample=${JSON.stringify(screen)}`)
    if (!loggedOutControl) {
      log('A8 REFUSED — the product did not expose a logged-out state after the credential was moved.')
      log('Moving a file alone is not evidence that the product noticed the transition.')
      return 2
    }
    if (!loginPath) {
      log('A8 FAIL — product declared logged out, but the native terminal did not expose a login path.')
      return 1
    }
    await dispose(loggedOut)
    loggedOut = undefined

    // Safe post-login control: restore the exact existing fixture credential,
    // restart the daemon, and require a fresh server-family binding receipt.
    renameSync(parked, credential)
    moved = false
    log(`AUTH ON restored existing credential to ${credential}`)
    restartDaemon('AUTH ON')
    postLogin = await spawnAndRead('POST-LOGIN')
    const postControl = Boolean(postLogin?.row?.driverId && postLogin?.row?.driverFamily)
    const postServer =
      postLogin?.row?.driverId === 'codex-app-server' && postLogin?.row?.driverFamily === 'server'
    log(`POST-LOGIN binding control fired=${postControl} codex-app-server/server=${postServer}`)
    if (!postControl) {
      log('A8 REFUSED — the fresh post-login session had no binding receipt.')
      return 2
    }
    if (!postServer) {
      log('A8 FAIL — the fresh post-login session did not land on codex-app-server/server.')
      return 1
    }

    log('')
    log('A8 PASS — logged-out Codex exposed a native login path, and a fresh session after restoring the existing credential bound codex-app-server/server.')
    log('LIMIT — no operator OAuth was performed; credential restoration is the safe post-login binding control and does not claim external provider authentication.')
    log(`final pins: ${pinSnapshot()}`)
    return 0
  } finally {
    await dispose(control)
    await dispose(loggedOut)
    await dispose(postLogin)
    if (moved && existsSync(parked)) {
      renameSync(parked, credential)
      log(`CLEANUP restored credential to ${credential}`)
    }
  }
}

try {
  const exitCode = await main()
  process.exitCode = exitCode
} catch (error) {
  log(`A8 ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 2
}

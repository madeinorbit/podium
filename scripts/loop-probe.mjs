// Black-box event-loop responsiveness prober for Podium.
//
// Triangulates THREE signals at 10 Hz so we can tell host-scheduling stalls
// apart from in-process loop blocking, and server apart from daemon:
//
//   own_lag_ms    — THIS process's event-loop delay (monitorEventLoopDelay).
//                   The control: if this spikes too, the HOST scheduler is the
//                   culprit (CPU oversubscription), not anyone's JS.
//   server_rtt_ms — WS ping->pong to :18787/client. Pure JS-loop round trip on
//                   the coordinating server. Spikes here w/o own_lag spikes =>
//                   server event loop is BLOCKED by sync JS work.
//   daemon_rtt_ms — HTTP GET to the daemon hook server :45777. JS-loop round
//                   trip on the daemon. Spikes here => daemon loop blocked.
//
// Safe & non-invasive: opens one client WS (announces presence:invisible so it
// does NOT suppress the user's push notifications) and only sends pings; the
// daemon probe is a trivial GET. No input is sent to any real session.
//
//   bun loop-probe.mjs <durationSec> <csvPath>

import { monitorEventLoopDelay } from 'node:perf_hooks'

const DURATION_S = Number(process.argv[2] ?? 240)
const CSV = process.argv[3] ?? '/tmp/loop-probe.csv'
const SERVER_WS = 'ws://127.0.0.1:18787/client'
const DAEMON_URL = 'http://127.0.0.1:45777/'
const TICK_MS = 100
const STALL_MS = 250 // sample is a "stall" above this

import { appendFileSync, writeFileSync } from 'node:fs'
writeFileSync(CSV, 'iso,elapsed_ms,own_lag_ms,server_rtt_ms,daemon_rtt_ms\n')

const t0 = performance.now()
const wall0 = Date.now()
const nowMs = () => performance.now() - t0
const iso = () => new Date(wall0 + nowMs()).toISOString()

// --- own loop lag (the control) ---
const h = monitorEventLoopDelay({ resolution: 10 })
h.enable()
let ownLagWindowMaxNs = 0
// sample the histogram frequently so a single stall is attributed to the right
// 100ms bucket rather than smeared across a 1s window.
const ownTimer = setInterval(() => {
  // h.max is cumulative-since-reset; we reset each tick to get a per-tick max.
  ownLagWindowMaxNs = h.max
  h.reset()
}, TICK_MS)
ownTimer.unref?.()

// --- server WS ping/pong (one ping outstanding at a time) ---
let ws
let wsOpen = false
let pingSentAt = null
let lastServerRtt = ''
const serverSamples = []
function connectWs() {
  ws = new WebSocket(SERVER_WS)
  ws.onopen = () => {
    wsOpen = true
    try { ws.send(JSON.stringify({ type: 'presence', visible: false })) } catch {}
  }
  ws.onmessage = (ev) => {
    let txt = ev.data
    if (typeof txt !== 'string') return // ignore non-text broadcasts
    // cheap check before JSON.parse to avoid burning our own loop on big frames
    if (txt.length > 40 || txt.indexOf('pong') === -1) return
    try {
      if (JSON.parse(txt).type === 'pong' && pingSentAt != null) {
        const rtt = performance.now() - pingSentAt
        lastServerRtt = rtt.toFixed(1)
        serverSamples.push(rtt)
        pingSentAt = null
      }
    } catch {}
  }
  ws.onclose = () => { wsOpen = false; pingSentAt = null; setTimeout(connectWs, 500) }
  ws.onerror = () => { try { ws.close() } catch {} }
}
connectWs()

// --- daemon HTTP probe (sequential, self-paced) ---
const daemonSamples = []
let lastDaemonRtt = ''
let daemonRunning = true
async function daemonLoop() {
  while (daemonRunning) {
    const start = performance.now()
    try {
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 5000)
      await fetch(DAEMON_URL, { signal: ctrl.signal }).then((r) => r.arrayBuffer()).catch(() => {})
      clearTimeout(to)
      const rtt = performance.now() - start
      lastDaemonRtt = rtt.toFixed(1)
      daemonSamples.push(rtt)
    } catch { lastDaemonRtt = '' }
    const elapsed = performance.now() - start
    if (elapsed < TICK_MS) await new Promise((r) => setTimeout(r, TICK_MS - elapsed))
  }
}
daemonLoop()

// --- main tick: send ping, record a CSV row, print 1Hz summary ---
const ownSamples = []
let secBucket = []
let lastSecLog = 0
const mainTimer = setInterval(() => {
  // fire a fresh ping only if the previous one already ponged; otherwise the
  // outstanding ping is mid-stall and its eventual RTT will capture the gap.
  if (wsOpen && pingSentAt == null) {
    pingSentAt = performance.now()
    try { ws.send(JSON.stringify({ type: 'ping' })) } catch { pingSentAt = null }
  }
  const ownLagMs = ownLagWindowMaxNs / 1e6
  ownSamples.push(ownLagMs)
  appendFileSync(CSV, `${iso()},${nowMs().toFixed(0)},${ownLagMs.toFixed(1)},${lastServerRtt},${lastDaemonRtt}\n`)
  secBucket.push({ own: ownLagMs, srtt: lastServerRtt, drtt: lastDaemonRtt })

  const el = nowMs()
  if (el - lastSecLog >= 1000) {
    lastSecLog = el
    const owns = secBucket.map((x) => x.own)
    const ownMax = owns.length ? Math.max(...owns) : 0
    const sMax = Math.max(0, ...serverSamples.slice(-10))
    const dMax = Math.max(0, ...daemonSamples.slice(-10))
    const flag = ownMax > STALL_MS || sMax > STALL_MS || dMax > STALL_MS ? '  <-- STALL' : ''
    console.log(
      `[${(el / 1000).toFixed(0)}s] own_lag_max=${ownMax.toFixed(0)}ms  server_rtt_max=${sMax.toFixed(0)}ms  daemon_rtt_max=${dMax.toFixed(0)}ms${flag}`,
    )
    secBucket = []
  }
}, TICK_MS)

function pct(arr, p) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
function summarize(name, arr) {
  if (!arr.length) return `${name}: no samples`
  const over = arr.filter((x) => x > STALL_MS)
  return `${name}: n=${arr.length} p50=${pct(arr, 50).toFixed(0)} p99=${pct(arr, 99).toFixed(0)} max=${Math.max(...arr).toFixed(0)}ms  stalls>${STALL_MS}ms=${over.length} (${((100 * over.length) / arr.length).toFixed(1)}%)`
}

function finish() {
  daemonRunning = false
  clearInterval(mainTimer)
  clearInterval(ownTimer)
  try { ws.close() } catch {}
  console.log('\n================ PROBE SUMMARY ================')
  console.log(`duration=${(nowMs() / 1000).toFixed(0)}s  tick=${TICK_MS}ms  stall_threshold=${STALL_MS}ms`)
  console.log(summarize('own_loop_lag', ownSamples))
  console.log(summarize('server_ws_rtt', serverSamples))
  console.log(summarize('daemon_http_rtt', daemonSamples))
  // worst 8 server & daemon RTTs with rough correlation to own-lag
  const worstServer = [...serverSamples].sort((a, b) => b - a).slice(0, 8).map((x) => x.toFixed(0))
  const worstDaemon = [...daemonSamples].sort((a, b) => b - a).slice(0, 8).map((x) => x.toFixed(0))
  console.log(`worst server RTTs (ms): ${worstServer.join(', ')}`)
  console.log(`worst daemon RTTs (ms): ${worstDaemon.join(', ')}`)
  console.log(`CSV: ${CSV}`)
  console.log('==============================================')
  process.exit(0)
}
setTimeout(finish, DURATION_S * 1000)
process.on('SIGTERM', finish)
process.on('SIGINT', finish)

/**
 * THE DAEMON, AS ITS OWN OPERATING-SYSTEM PROCESS (POD-2056).
 *
 * ---------------------------------------------------------------------------
 * WHY tests/e2e NEEDED THIS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Every e2e in this directory starts its daemon with an in-process
 * `startDaemon()`. That is right for almost everything they assert — but it
 * makes one whole class of claim untestable, because an in-process daemon
 * cannot DIE. `close()` unwinds; a crash does not. The difference matters
 * exactly where the daemon's recovery lives: `adopt()` exists so a supervisor
 * that came back finds the session processes that outlived it, and you cannot
 * write that test against a daemon you politely asked to stop.
 *
 * So this file is the daemon as the operating system runs it: a real pid, a
 * real parent-child relationship with the agent processes it spawns, and a real
 * SIGKILL available to whoever wants to take it away without warning.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not reap sessions on SIGTERM. `close({ reapSessions: false })` is the
 * default the daemon already ships, and honouring it here is load-bearing
 * rather than incidental: a harness that tore the agent down on its way out
 * would make every restart lane trivially green by removing the thing being
 * restarted onto. A graceful stop and a crash must leave the SAME survivors —
 * only the daemon goes.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS CONFIGURED
 * ---------------------------------------------------------------------------
 *
 * One JSON file, named on argv. NOT environment variables, and not flags:
 * `DaemonOptions` is a nested record, and a harness that flattened it into
 * `PODIUM_E2E_DAEMON_HOOKS_PORT`-shaped names would have invented a second,
 * lossy encoding of a type the daemon already exports. Anything in
 * `DaemonOptions` that survives `JSON.stringify` can be passed; the function
 * seams (`launch`, `restartAfterUpdate`) deliberately cannot, and a lane that
 * needs one wants an in-process daemon instead.
 *
 * Run it the way the other standalone e2e entries are run:
 *   bun --conditions=@podium/source tests/e2e/daemon-process.ts <config.json>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { addSink, createConsoleSink } from '@podium/logger'
import { startDaemon } from '../../apps/daemon/src/daemon'
import type { DaemonOptions } from '../../apps/daemon/src/daemon-options'

/** Everything `DaemonOptions` holds that crosses a process boundary as JSON. */
export type SerializableDaemonOptions = Omit<
  DaemonOptions,
  'localLink' | 'onBlocked' | 'launch' | 'workerClient' | 'reconnectTimers' | 'restartAfterUpdate' | 'restartAfterTransfer' | 'retireAfterTransfer'
>

export interface DaemonProcessConfig {
  options: SerializableDaemonOptions
  /**
   * Written with this process's pid once `startDaemon` has RESOLVED.
   *
   * The pid is on the parent's side already — what the file adds is the
   * ordering. A harness that raced ahead on `spawn()` alone would send its
   * first frame at a daemon that has not finished its handshake, and the
   * failure would surface later as an unexplained timeout somewhere else.
   */
  readyFile: string
}

const configPath = process.argv[2]
if (!configPath) {
  throw new Error('usage: daemon-process.ts <config.json>')
}

const config = JSON.parse(readFileSync(configPath, 'utf8')) as DaemonProcessConfig

/**
 * A SINK, BECAUSE NOTHING ELSE INSTALLS ONE.
 *
 * `@podium/logger` dispatches to registered sinks and ships with none — the
 * process that boots the daemon decides where its records go, and `startDaemon`
 * deliberately does not. In-process e2e lanes never noticed, because their
 * daemon logs into the same test process that could inspect it directly.
 *
 * Across a process boundary that is no longer true: the parent can only read
 * what this child WRITES, so without this line every `daemon.output()` in every
 * lane is an empty string that reads like "the daemon said nothing" — which is
 * a claim, and a wrong one. The level still comes from `PODIUM_LOG` /
 * `PODIUM_LOG_LEVEL`, so a lane that wants the daemon's reasoning asks for it
 * rather than paying for a firehose by default.
 */
addSink(createConsoleSink())

const daemon = await startDaemon(config.options as DaemonOptions)
writeFileSync(config.readyFile, String(process.pid), { mode: 0o600 })

const stop = (): void => {
  // `reapSessions` is omitted, not passed as false, so this path stays whatever
  // the daemon's own default is. If that default ever changes, this harness
  // should change with it rather than pin an opinion the product does not hold.
  void daemon.close().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

// Nothing else keeps this process alive: the daemon's own timers are unref'd on
// purpose (a pending tick must never hold shutdown up), so without this the
// process would exit the moment the handshake settled.
await new Promise(() => {})

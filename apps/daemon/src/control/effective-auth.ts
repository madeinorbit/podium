/**
 * WHAT THE HARNESS SAYS IT AUTHENTICATED WITH (credential management §9
 * "Launching", epic plan Task 10).
 *
 * A harness picks its own credential from several places, and a wrong pick
 * still produces a working session that bills someone else. So once a harness
 * process for a session has started, the daemon asks the harness itself, with
 * that process's exact environment, which login it is on (its manifest's
 * `authStatusProbe`), and sends the answer to the server as `sessionAuth`.
 *
 * For a credential delivered in a variable, the daemon also says whether the
 * harness read exactly the value the session's access delivered: the comparison
 * happens here, and only its yes or no leaves the machine. A harness without a
 * status command, or one that fails or hangs, reports `unknown`. Nothing here
 * can fail or delay the session.
 */

import {
  type HarnessAuthStatusProbe,
  type LoginProbeExec,
  manifestFor,
  runHarnessStatusCommand,
} from '@podium/harness'
import type { AgentKind } from '@podium/model'
import type { AccessField, SessionAuthMessage } from '@podium/protocol'

export type SessionAuthReport = Omit<SessionAuthMessage, 'type' | 'sessionId'>

/**
 * The environment the harness process actually has: the child's layered over
 * the daemon's own (as the process host spreads it), with the child's strip
 * list removed. A competing key in the daemon's environment is gone here
 * exactly when it is gone from the session's process.
 */
export function sessionProcessEnvironment(
  daemonEnv: Readonly<Record<string, string | undefined>>,
  child: { env: Readonly<Record<string, string>>; strip: readonly string[] },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(daemonEnv)) if (value !== undefined) env[key] = value
  Object.assign(env, child.env)
  for (const key of child.strip) delete env[key]
  return env
}

export async function readEffectiveAuth(i: {
  agentKind: AgentKind
  executable: string
  env: Readonly<Record<string, string>>
  access?: AccessField | undefined
  probe?: HarnessAuthStatusProbe | undefined
  run?: LoginProbeExec
}): Promise<SessionAuthReport> {
  const probe = i.probe ?? manifestFor(i.agentKind)?.inventory.authStatusProbe
  if (!probe) return { method: 'unknown' }
  let reported: ReturnType<HarnessAuthStatusProbe['classify']>
  try {
    const run = i.run ?? runHarnessStatusCommand
    reported = probe.classify(await run([i.executable, ...probe.args], probe.timeoutMs, i.env))
  } catch {
    return { method: 'unknown' }
  }
  const delivery = i.access?.delivery
  const source = reported.sourceVariable
  return {
    method: reported.method,
    ...(source ? { source } : {}),
    ...(delivery?.kind === 'env' && source && reported.method !== 'unknown'
      ? { delivered: source === delivery.variable && i.env[source] === delivery.secret }
      : {}),
    ...(reported.email || reported.fingerprint
      ? {
          identity: {
            ...(reported.email ? { email: reported.email } : {}),
            ...(reported.fingerprint ? { fingerprint: reported.fingerprint } : {}),
          },
        }
      : {}),
  }
}

/**
 * Ask in the background and send the answer as `sessionAuth`. Never throws and
 * never delays the session: a failed read sends nothing, and the session keeps
 * whatever it last reported.
 */
export function reportEffectiveAuth(
  ctx: { send(message: SessionAuthMessage): void },
  i: {
    sessionId: SessionAuthMessage['sessionId']
    agentKind: AgentKind
    executable: string
    env: Readonly<Record<string, string>>
    access: AccessField | undefined
  },
): void {
  void readEffectiveAuth(i)
    .then((report) => ctx.send({ type: 'sessionAuth', sessionId: i.sessionId, ...report }))
    .catch(() => undefined)
}

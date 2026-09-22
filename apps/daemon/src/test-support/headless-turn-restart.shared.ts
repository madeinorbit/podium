/**
 * What BOTH daemon generations of the POD-4614 restart test build, so the
 * turn generation 2 receives is byte-for-byte the turn generation 1 started:
 * the fixture harness registered, a snapshot pointing its executable at the
 * stand-in, and one hosted turn through the session layer's engine hold with
 * the daemon's own env composition.
 */
import { fixtureManifest } from '@podium/harness/adapters/fixture'
import { registerTestManifest, type ResolvedHarnessInventory } from '@podium/harness'
import {
  type HeadlessTurnSpec,
  type HostedTurnIdentity,
  runHostedHeadlessTurn,
} from '@podium/harness/driver/host'
import { asAccountId, asSessionId, type HarnessAgent } from '@podium/model'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { headlessTurnEnv } from '../control/session-env.js'
import type { SessionEngineScope } from '../session/engines.js'
import { testHarnessSnapshot } from './harness-snapshot.js'

export const FIXTURE_AGENT = 'fixture' as HarnessAgent

/** The stand-in `fixture-agent exec --session-id <id> <prompt>`: records its
 *  pid and HOME, says something on stderr, blocks until released, answers. */
export const FIXTURE_AGENT_SCRIPT = `#!/bin/sh
echo "$$" >> "$FIXTURE_INCARNATIONS"
printf '%s\\n' "$HOME" > "$FIXTURE_HOME_RECEIPT"
echo "fixture working" >&2
while [ ! -f "$FIXTURE_RELEASE" ]; do sleep 0.05; done
for last; do :; done
printf 'fixture answer: %s\\n' "$last"
: > "$FIXTURE_DONE"
`

export interface RestartTurnFiles {
  incarnations: string
  homeReceipt: string
  release: string
  done: string
}

export function registerFixtureHarness(): () => void {
  return registerTestManifest(fixtureManifest)
}

export function fixtureSnapshot(stand: string): ResolvedHarnessInventory {
  const snapshot = testHarnessSnapshot()
  ;(snapshot.executables as Map<string, { kind: string; path: string; generation: number }>).set(
    FIXTURE_AGENT,
    { kind: FIXTURE_AGENT, path: stand, generation: 1 },
  )
  return snapshot
}

export function restartTurn(input: {
  sessionId: string
  turnId: string
  cwd: string
  agentHome: string
  files: RestartTurnFiles
  snapshot: ResolvedHarnessInventory
}): { spec: HeadlessTurnSpec; identity: HostedTurnIdentity; label: string } {
  const sessionId = asSessionId(input.sessionId)
  const identity: HostedTurnIdentity = {
    sessionId,
    turnId: input.turnId,
    requestDigest: 'e'.repeat(64),
    accountId: asAccountId('native:fixture:restart'),
  }
  const label = `podium-${input.sessionId}`
  return {
    identity,
    label,
    spec: {
      agent: FIXTURE_AGENT,
      accountId: identity.accountId,
      requestDigest: identity.requestDigest,
      cwd: input.cwd,
      prompt: 'survive the restart',
      sessionUuid: `uuid-${input.sessionId}`,
      timeoutMs: 120_000,
      durableLabel: label,
      // The instance-owned env, built on the command environment as the
      // headless driver's `sessionEnv` port builds it.
      env: {
        ...input.snapshot.commandEnvironment.env,
        HOME: input.agentHome,
        FIXTURE_INCARNATIONS: input.files.incarnations,
        FIXTURE_HOME_RECEIPT: input.files.homeReceipt,
        FIXTURE_RELEASE: input.files.release,
        FIXTURE_DONE: input.files.done,
      },
    },
  }
}

export function runRestartTurn(
  engines: SessionEngineScope,
  turn: { spec: HeadlessTurnSpec; identity: HostedTurnIdentity },
  snapshot: ResolvedHarnessInventory,
  events: HeadlessTurnEvent[] = [],
) {
  return runHostedHeadlessTurn(
    {
      owner: engines,
      childEnv: (invocation) =>
        headlessTurnEnv({
          agent: turn.spec.agent,
          ...(turn.spec.env ? { specEnv: turn.spec.env } : {}),
          ...invocation,
          commandEnv: snapshot.commandEnvironment.env,
        }),
    },
    { spec: turn.spec, identity: turn.identity, snapshot, emit: (event) => events.push(event) },
  )
}

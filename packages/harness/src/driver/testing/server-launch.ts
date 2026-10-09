/**
 * A {@link ServerFamilyLaunch} from the handful of facts a family test names.
 *
 * Server families start from the contract's whole SessionSpec; a test that
 * only cares about a directory, a model or a first prompt builds one here
 * rather than restating the spec's required declarations each time.
 */

import type { SessionId } from '@podium/model'
import type { AgentInstruction } from '@podium/protocol'
import type { ServerFamilyLaunch } from '../families/server-family.js'
import type { AcceptedDriverId } from '../families.js'

export function serverFamilyLaunch(input: {
  sessionId: SessionId
  harness?: string
  driverId?: AcceptedDriverId
  cwd: string
  model?: string
  effort?: string
  env?: Readonly<Record<string, string>>
  initialPrompt?: string
  instructions?: readonly AgentInstruction[]
}): ServerFamilyLaunch {
  const driverId: AcceptedDriverId = input.driverId ?? 'claude-sdk'
  return {
    sessionId: input.sessionId,
    spec: {
      harness: input.harness ?? 'test-harness',
      selection: {
        auth: 'unknown',
        platform: process.platform,
        available: [driverId],
        preference: driverId,
        role: 'interactive',
      },
      workdir: input.cwd,
      model: {
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
      },
      instructions: input.instructions
        ? {
            supported: true,
            value: { instructions: input.instructions, reprimeOnCompaction: false },
          }
        : { supported: false, reason: 'test launch carries no instructions' },
      mcpServers: { supported: false, reason: 'test launch carries no MCP configuration' },
      ...(input.env ? { env: input.env } : {}),
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
    },
  }
}

/** The credential commands on the plain path (ADR 12 D8). Routes: `trpc.ts`. */

import { asUserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { codexAuthorizerFor } from '../../codex-machine'
import { definePlainFamily } from '../plain-command/declare'
import { CREDENTIAL_COMMANDS_TRPC, type CredentialsState } from './commands'
import { assembleCodexServerAiMarker, type CodexServerAiMarker } from './server-ai-status'

export const CREDENTIALS_PLAIN_FAMILY = definePlainFamily({
  family: 'credentials',
  service: (state): CredentialsState => ({
    store: state.store,
    callerUserId: asUserId(state.caller.userId),
    health: state.modules.credentialHealth,
    chatgpt: state.modules.chatgptPlan,
    signIn: state.modules.homeSignIn,
    native: {
      store: state.store,
      machineService: state.modules.machines,
      nativeLogin: state.modules.nativeLogin,
      loginPropagation: state.modules.loginPropagation,
      machineStanding: async () => await state.privateAccess.machineStanding(),
    },
    resolveServerAi: async (): Promise<CodexServerAiMarker | undefined> => {
      if (!state.users) return undefined
      try {
        const viewer = asUserId(state.caller.userId)
        const role = resolveRole(await state.modules.settings.getSettingsFor(viewer), 'background')
        const authorize = await codexAuthorizerFor(
          { users: state.users, machines: state.modules.machines },
          viewer,
        )
        return assembleCodexServerAiMarker({
          role,
          authorize,
          listings: await state.modules.machines.listMachines(),
          isOnline: (id) => state.modules.machines.hasDaemon(id),
          defaultMachineId: await state.modules.machines.defaultMachine().catch(() => undefined),
          lastError: state.modules.issues.gitWorkflow.backgroundLastError(),
        })
      } catch {
        return undefined
      }
    },
  }),
  commands: CREDENTIAL_COMMANDS_TRPC,
})

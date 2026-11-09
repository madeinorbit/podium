import type { Commands } from '../src/commands'
import type { ChatCommands } from '../src/conversation/sends'
import type { RuntimeRoot } from '../src/runtime-root/root'

const read = (object: object | undefined, key: string): any =>
  object ? Reflect.get(object, key) : undefined

/** Test-only root for historical snapshot fixtures; no product adapter exists. */
export function fixtureRoot<T extends object>(
  owner: T,
): T & { readonly root: RuntimeRoot; batch(fn: () => void): void } {
  if (read(owner, 'root')) return owner as T & { root: RuntimeRoot; batch(fn: () => void): void }
  const access = () => read(owner, 'access') ?? read(owner, 'getSnapshot')?.() ?? owner
  const stop = (id: string, opts?: { force?: boolean }) =>
    opts?.force === undefined
      ? read(access(), 'endSession')?.(id)
      : read(access(), 'endSession')?.(id, opts.force)
  const commands = {
    sessions: {
      get spawnDraftAgent() {
        return read(access(), 'spawnDraftAgent')
      },
      get launch() {
        return read(access(), 'launchSession')
      },
      get spawnIssueAgent() {
        return read(access(), 'spawnIssueAgent')
      },
      get killSession() {
        return read(access(), 'killSession')
      },
      get continueSession() {
        return read(access(), 'continueSession')
      },
      get hibernate() {
        return read(access(), 'hibernateSession')
      },
      get stop() {
        return stop
      },
      get interrupt() {
        return read(access(), 'interruptTurn')
      },
      get configure() {
        return read(access(), 'configureSession')
      },
      get handoff() {
        return read(access(), 'handoffSession')
      },
      get resume() {
        return read(access(), 'resurrectSession')
      },
      get answer() {
        return read(access(), 'answerSession')
      },
      get archive() {
        return read(access(), 'archiveSession')
      },
      get startIssueSession() {
        return read(access(), 'startIssueSession')
      },
      get issueAction() {
        return read(access(), 'issueAction')
      },
      get startBtw() {
        return read(access(), 'startBtw')
      },
      get dismissEffect() {
        return read(access(), 'dismissEffect')
      },
      get rename() {
        return read(access(), 'renameSession')
      },
      get markRead() {
        return read(access(), 'markSessionRead')
      },
      get markUnread() {
        return read(access(), 'markSessionUnread')
      },
      get setWorkState() {
        return read(access(), 'setWorkState')
      },
      get snooze() {
        return read(access(), 'setSnooze')
      },
      get clearSnooze() {
        return read(access(), 'clearSnooze')
      },
      get setSessionDraft() {
        return read(access(), 'setSessionDraft')
      },
    },
    issues: {
      get update() {
        return read(access(), 'updateIssue')
      },
      get archive() {
        return read(access(), 'archiveIssue')
      },
      get delete() {
        return read(access(), 'deleteIssue')
      },
      get close() {
        return read(access(), 'closeIssue')
      },
      get defer() {
        return read(access(), 'deferIssue')
      },
      get undefer() {
        return read(access(), 'undeferIssue')
      },
      get restore() {
        return read(access(), 'restoreIssue')
      },
      get setLabels() {
        return read(access(), 'setIssueLabels')
      },
      get setPlacement() {
        return read(access(), 'setIssuePlacement')
      },
      get setTucked() {
        return read(access(), 'setIssueTucked')
      },
      get markRead() {
        return read(access(), 'markIssueRead')
      },
      get markUnread() {
        return read(access(), 'markIssueUnread')
      },
      get dismissOffer() {
        return read(access(), 'dismissOffer')
      },
    },
    files: {
      get read() {
        return read(access(), 'readFileScoped')
      },
      get list() {
        return read(access(), 'listDir')
      },
      get status() {
        return read(access(), 'gitStatus')
      },
      get log() {
        return read(access(), 'gitLog')
      },
      get diff() {
        return read(access(), 'gitDiffFile')
      },
      get write() {
        return read(access(), 'writeFileScoped')
      },
      get commitFiles() {
        return read(access(), 'gitCommitFiles')
      },
      get commitDiffFile() {
        return read(access(), 'gitCommitDiffFile')
      },
    },
    preferences: {
      get setPinned() {
        return read(access(), 'setPinned')
      },
      get setTabOrder() {
        return read(access(), 'setTabOrder')
      },
      get setPreferences() {
        return read(access(), 'setPreferences')
      },
      get setInstancePreferences() {
        return read(access(), 'setInstancePreferences')
      },
    },
    automations: {
      get decideApproval() {
        return read(access(), 'decideApproval')
      },
      get setSubscriptionEnabled() {
        return read(access(), 'setSubscriptionEnabled')
      },
      get removeSubscription() {
        return read(access(), 'removeSubscription')
      },
    },
    threads: {
      get setBackend() {
        return read(access(), 'setSuperagentBackend')
      },
    },
    get records() {
      return read(access(), 'records')
    },
  } as Commands
  const chatSends = {
    get sendChat() {
      return read(access(), 'sendChat')
    },
    get chatSendsFor() {
      return read(access(), 'chatSendsFor')
    },
    get discardChat() {
      return read(access(), 'discardChat')
    },
  } as ChatCommands
  const root = {
    commands,
    chatSends,
    get api() {
      return read(access(), 'trpc')
    },
    get replica() {
      return read(owner, 'replica') ?? read(access(), 'replica')
    },
    get httpOrigin() {
      return read(access(), 'httpOrigin')
    },
    get live() {
      return read(owner, 'live')
    },
    services: {
      connection: {
        get hub() {
          return read(owner, 'hub') ?? read(access(), 'hub')
        },
      },
      outbox: {
        get queue() {
          return read(owner, 'outbox')
        },
        get recovery() {
          return read(access(), 'recoverOutbox')
        },
      },
    },
  }
  Object.defineProperty(owner, 'root', { configurable: true, value: root })
  if (!read(owner, 'batch'))
    Object.defineProperty(owner, 'batch', {
      configurable: true,
      value: (fn: () => void) => (read(access(), 'batchGesture') ?? ((fn: () => void) => fn()))(fn),
    })
  return owner as T & { root: RuntimeRoot; batch(fn: () => void): void }
}

/** Provider-free suites retain their original command spies and data. */
export function fixtureRuntimeHooks(readOwner: () => unknown) {
  const owner = () => {
    const value = readOwner()
    if (!value || typeof value !== 'object') throw new Error('Fixture owner is not ready')
    return fixtureRoot(value)
  }
  const root = () => owner().root
  const access = () => read(owner(), 'access') ?? owner()
  return {
    useClientRuntime: owner,
    useCommands: () => root().commands,
    useChatSends: () => root().chatSends,
    useRequestClient: () => root().api,
    useHttpOrigin: () => root().httpOrigin,
    useReplica: () => root().replica,
    useSocketHub: () => root().services.connection.hub,
    useUi: () => read(owner(), 'ui') ?? access(),
    useDeviceState: () => read(owner(), 'deviceState') ?? read(access(), 'uiState'),
    useDrafts: () => read(owner(), 'drafts'),
  }
}

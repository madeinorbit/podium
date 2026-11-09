import type { PodiumClientApi } from '../src/api'
import type { Commands } from '../src/commands'
import type { ChatCommands } from '../src/conversation/sends'
import type { RuntimeRoot } from '../src/runtime-root/root'

/** Test oracle names only. Production callers use command families. */
export interface ReferenceCommandAccess<TApi extends PodiumClientApi = PodiumClientApi> {
spawnDraftAgent: Commands<TApi>['sessions']['spawnDraftAgent']
launchSession: Commands<TApi>['sessions']['launch']
spawnIssueAgent: Commands<TApi>['sessions']['spawnIssueAgent']
killSession: Commands<TApi>['sessions']['killSession']
continueSession: Commands<TApi>['sessions']['continueSession']
hibernateSession: Commands<TApi>['sessions']['hibernate']
endSession: (id: Parameters<Commands<TApi>['sessions']['stop']>[0], force?: boolean) => ReturnType<Commands<TApi>['sessions']['stop']>
interruptTurn: Commands<TApi>['sessions']['interrupt']
configureSession: Commands<TApi>['sessions']['configure']
handoffSession: Commands<TApi>['sessions']['handoff']
resurrectSession: Commands<TApi>['sessions']['resume']
answerSession: Commands<TApi>['sessions']['answer']
archiveSession: Commands<TApi>['sessions']['archive']
startIssueSession: Commands<TApi>['sessions']['startIssueSession']
issueAction: Commands<TApi>['sessions']['issueAction']
startBtw: Commands<TApi>['sessions']['startBtw']
dismissEffect: Commands<TApi>['sessions']['dismissEffect']
renameSession: Commands<TApi>['sessions']['rename']
markSessionRead: Commands<TApi>['sessions']['markRead']
markSessionUnread: Commands<TApi>['sessions']['markUnread']
setWorkState: Commands<TApi>['sessions']['setWorkState']
setSnooze: Commands<TApi>['sessions']['snooze']
clearSnooze: Commands<TApi>['sessions']['clearSnooze']
setSessionDraft: Commands<TApi>['sessions']['setSessionDraft']
updateIssue: Commands<TApi>['issues']['update']
archiveIssue: Commands<TApi>['issues']['archive']
deleteIssue: Commands<TApi>['issues']['delete']
closeIssue: Commands<TApi>['issues']['close']
deferIssue: Commands<TApi>['issues']['defer']
undeferIssue: Commands<TApi>['issues']['undefer']
restoreIssue: Commands<TApi>['issues']['restore']
setIssueLabels: Commands<TApi>['issues']['setLabels']
setIssuePlacement: Commands<TApi>['issues']['setPlacement']
setIssueTucked: Commands<TApi>['issues']['setTucked']
markIssueRead: Commands<TApi>['issues']['markRead']
markIssueUnread: Commands<TApi>['issues']['markUnread']
dismissOffer: Commands<TApi>['issues']['dismissOffer']
readFileScoped: Commands<TApi>['files']['read']
listDir: Commands<TApi>['files']['list']
gitStatus: Commands<TApi>['files']['status']
gitLog: Commands<TApi>['files']['log']
gitDiffFile: Commands<TApi>['files']['diff']
writeFileScoped: Commands<TApi>['files']['write']
gitCommitFiles: Commands<TApi>['files']['commitFiles']
gitCommitDiffFile: Commands<TApi>['files']['commitDiffFile']
setPinned: Commands<TApi>['preferences']['setPinned']
setTabOrder: Commands<TApi>['preferences']['setTabOrder']
setPreferences: Commands<TApi>['preferences']['setPreferences']
setInstancePreferences: Commands<TApi>['preferences']['setInstancePreferences']
decideApproval: Commands<TApi>['automations']['decideApproval']
setSubscriptionEnabled: Commands<TApi>['automations']['setSubscriptionEnabled']
removeSubscription: Commands<TApi>['automations']['removeSubscription']
setSuperagentBackend: Commands<TApi>['threads']['setBackend']
sendChat: ChatCommands['sendChat']
chatSendsFor: ChatCommands['chatSendsFor']
discardChat: ChatCommands['discardChat']
trpc: TApi
replica: RuntimeRoot['replica']
hub: RuntimeRoot['services']['connection']['hub']
httpOrigin: string
recoverOutbox: RuntimeRoot['services']['outbox']['recovery']
records: Commands<TApi>['records']
}

export function referenceCommandAccess<TApi extends PodiumClientApi>(root: RuntimeRoot<TApi>): ReferenceCommandAccess<TApi> {
 const commands = root.commands
 return {
spawnDraftAgent: commands.sessions.spawnDraftAgent,
launchSession: commands.sessions.launch,
spawnIssueAgent: commands.sessions.spawnIssueAgent,
killSession: commands.sessions.killSession,
continueSession: commands.sessions.continueSession,
hibernateSession: commands.sessions.hibernate,
endSession: (id, force) => commands.sessions.stop(id, {force}),
interruptTurn: commands.sessions.interrupt,
configureSession: commands.sessions.configure,
handoffSession: commands.sessions.handoff,
resurrectSession: commands.sessions.resume,
answerSession: commands.sessions.answer,
archiveSession: commands.sessions.archive,
startIssueSession: commands.sessions.startIssueSession,
issueAction: commands.sessions.issueAction,
startBtw: commands.sessions.startBtw,
dismissEffect: commands.sessions.dismissEffect,
renameSession: commands.sessions.rename,
markSessionRead: commands.sessions.markRead,
markSessionUnread: commands.sessions.markUnread,
setWorkState: commands.sessions.setWorkState,
setSnooze: commands.sessions.snooze,
clearSnooze: commands.sessions.clearSnooze,
setSessionDraft: commands.sessions.setSessionDraft,
updateIssue: commands.issues.update,
archiveIssue: commands.issues.archive,
deleteIssue: commands.issues.delete,
closeIssue: commands.issues.close,
deferIssue: commands.issues.defer,
undeferIssue: commands.issues.undefer,
restoreIssue: commands.issues.restore,
setIssueLabels: commands.issues.setLabels,
setIssuePlacement: commands.issues.setPlacement,
setIssueTucked: commands.issues.setTucked,
markIssueRead: commands.issues.markRead,
markIssueUnread: commands.issues.markUnread,
dismissOffer: commands.issues.dismissOffer,
readFileScoped: commands.files.read,
listDir: commands.files.list,
gitStatus: commands.files.status,
gitLog: commands.files.log,
gitDiffFile: commands.files.diff,
writeFileScoped: commands.files.write,
gitCommitFiles: commands.files.commitFiles,
gitCommitDiffFile: commands.files.commitDiffFile,
setPinned: commands.preferences.setPinned,
setTabOrder: commands.preferences.setTabOrder,
setPreferences: commands.preferences.setPreferences,
setInstancePreferences: commands.preferences.setInstancePreferences,
decideApproval: commands.automations.decideApproval,
setSubscriptionEnabled: commands.automations.setSubscriptionEnabled,
removeSubscription: commands.automations.removeSubscription,
setSuperagentBackend: commands.threads.setBackend,
...root.chatSends,
records: commands.records,
trpc: root.api, replica: root.replica, hub: root.services.connection.hub, httpOrigin: root.httpOrigin, recoverOutbox: root.services.outbox.recovery,
}
}

/**
 * @podium/process/screen — terminal-screen concerns (P2a door, P2c filled).
 *
 * What a process is showing: the `DurableAttachment` wrapper (framing and
 * OSC title scan), the title scanner itself, the cgroup
 * resource helpers the scope monitor reads, POSIX shell quoting for `sh -c`
 * paths, the headless screen model, the 1049
 * screen-mode tracker, the old-server reopen policy, and `TerminalScreen` —
 * one model, size, mode and title per session, surviving detach/reattach while
 * attachments come and go.
 */

export {
  type CgroupSample,
  cgroupPathForControlGroup,
  cgroupPathForPid,
  cgroupRoot,
  controlGroupQueryArgv,
  parseCgroupKeyed,
  parseCgroupPressure,
  parseCgroupScalar,
  parseProcCgroup,
  readCgroupPressure,
  readCgroupSample,
  sessionScopeCgroupPath,
  sliceChainPath,
  userManagerCgroupBase,
} from './cgroup.js'
export { createTitleScanner, type TitleScanner } from './osc-title.js'
export {
  decideReopenScreen,
  type ReopenDecision,
  type ReopenInputs,
} from './reopen-policy.js'
export { type ScreenMode, ScreenModeTracker } from './screen-mode.js'
export { createHeadlessScreen, type HeadlessScreen, type ScreenReader } from './screen-model.js'
export {
  type AgentFrame,
  type AgentPicture,
  type DurableAttachment,
  type SpawnOptions,
  wrapPty,
} from './session.js'
export { shellQuote } from './shell-quote.js'
export {
  snapshotFirstFrame,
  TerminalScreen,
  type TerminalScreenAttachment,
  type TerminalScreenFrame,
  type TerminalScreenOptions,
} from './terminal-screen.js'

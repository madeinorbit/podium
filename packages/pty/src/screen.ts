/**
 * @podium/process/screen — terminal-screen concerns (P2a door, P2c filled).
 *
 * What a process is showing: the `DurableAttachment` wrapper (framing and
 * OSC title scan), the title scanner itself, the cgroup
 * resource helpers the scope monitor reads, POSIX shell quoting for `sh -c`
 * attach paths, the alt-screen stripper, the headless screen model, the 1049
 * screen-mode tracker, the reopen policy, and `TerminalScreen` — the one
 * screen per session that owns the applied size, the byte log, one screen
 * model, the mode and the repaint policy, surviving detach/reattach while
 * attachments come and go.
 */

export { createAltScreenStripper } from './alt-screen-stripper.js'
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
  type DurableAttachment,
  type SpawnOptions,
  wrapPty,
} from './session.js'
export { shellQuote } from './shell-quote.js'
export {
  snapshotFirstFrame,
  TERMINAL_SCREEN_BYTE_LOG_BYTES,
  TerminalScreen,
  type TerminalScreenAttachment,
  type TerminalScreenFrame,
  type TerminalScreenOptions,
  type TerminalScreenReopenOptions,
} from './terminal-screen.js'

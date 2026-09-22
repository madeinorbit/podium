/**
 * @podium/process/screen — terminal-screen concerns (P2a door, P2c filled).
 *
 * What a process is showing: the `DurableAttachment` wrapper (framing, redraw,
 * OSC title scan, geometry tracking), the title scanner itself, the cgroup
 * resource helpers the scope monitor reads, POSIX shell quoting for `sh -c`
 * attach paths, the alt-screen stripper, the headless screen model, the 1049
 * screen-mode tracker, the reopen policy, and `TerminalScreen` — the one
 * screen per session that owns the applied size, the byte log, one screen
 * model, the mode and the repaint policy, surviving detach/reattach while
 * attachments come and go.
 */

export {
  type SpawnOptions,
  type AgentFrame,
  type DurableAttachment,
  withHardRepaint,
  wrapPty,
} from './session.js'
export { type TitleScanner, createTitleScanner } from './osc-title.js'
export {
  cgroupRoot,
  type CgroupSample,
  parseCgroupScalar,
  parseCgroupKeyed,
  parseProcCgroup,
  cgroupPathForPid,
  readCgroupSample,
  controlGroupQueryArgv,
  cgroupPathForControlGroup,
  sliceChainPath,
  userManagerCgroupBase,
  sessionScopeCgroupPath,
  parseCgroupPressure,
  readCgroupPressure,
} from './cgroup.js'
export { shellQuote } from './shell-quote.js'
export { createAltScreenStripper } from './alt-screen-stripper.js'
export { type ScreenReader, createHeadlessScreen } from './screen-model.js'
export { type ScreenMode, ScreenModeTracker } from './screen-mode.js'
export {
  type ReopenInputs,
  type ReopenDecision,
  decideReopenScreen,
} from './reopen-policy.js'
export {
  TERMINAL_SCREEN_BYTE_LOG_BYTES,
  snapshotFirstFrame,
  type TerminalScreenFrame,
  type TerminalScreenAttachment,
  type TerminalScreenOptions,
  type TerminalScreenReopenOptions,
  TerminalScreen,
} from './terminal-screen.js'

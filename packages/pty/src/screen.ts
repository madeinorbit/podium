/**
 * @podium/process/screen — terminal-screen concerns (P2a door).
 *
 * What a process is showing: the `AgentSession` wrapper (framing, redraw,
 * OSC title scan, geometry tracking), the title scanner itself, the cgroup
 * resource helpers the scope monitor reads, POSIX shell quoting for `sh -c`
 * attach paths, and the alt-screen stripper (defined in `abduco.ts` today;
 * P2c moves it here — it is already exported from this door so the move
 * changes no importer).
 */

export {
  type SpawnOptions,
  type AgentFrame,
  type AgentSession,
  withHardRepaint,
  spawnAgent,
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
export { createAltScreenStripper } from './abduco.js'

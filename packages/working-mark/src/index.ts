/**
 * @podium/working-mark: the animated working mark.
 *
 *   import { tetra } from '@podium/working-mark/designs'   // one design: only it is bundled
 *   import { WorkingMark } from '@podium/working-mark/react'
 *   <WorkingMark design={tetra} size={12} />
 *
 * Plain DOM: `createWorkingMark(tetra, { size: 12 }).element`. All designs, for pickers: '@podium/working-mark/all'.
 */
export { assembleApng } from './apng'
export { dotsAt, period, restingPicture, type Sheet, sheetOf, smoothFps } from './frames'
export {
  canShareCanvas,
  createWorkingMark,
  DEFAULT_FPS,
  mountWorkingMark,
  pauseWorkingMarksWhenIdle,
  refreshWorkingMarks,
  resolveMethod,
  setWorkingMarksPaused,
  type WorkingMarkHandle,
  type WorkingMarkMethod,
  type WorkingMarkOptions,
  workingMarkBox,
  workingMarkMethods,
} from './mark'
export type { Design, Dot, Picture, Pose, StillDot } from './types'

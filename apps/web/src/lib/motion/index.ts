/**
 * Motion grammar primitives (.design/specs/motion.md): the braille spinner and
 * the counting timer are the only permanent motion (only while an agent
 * computes); every phase change is a one-shot morph; stillness = "needs you".
 * CSS lives alongside these primitives in `src/lib/motion/motion.css`; the
 * phase mapping (`motionPhase`) and `formatClock` are shared via
 * @podium/client-core viewmodels.
 */
export { BrailleSpinner } from './BrailleSpinner'
export { PhaseTimer } from './PhaseTimer'
export { StatusBadge, type StatusBadgeKind } from './StatusBadge'
export { usePhaseMorph } from './usePhaseMorph'

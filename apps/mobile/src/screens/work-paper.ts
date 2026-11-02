import { adaptiveColor } from '../theme/platform-colors'

/** Work's Paper content ground; native navigation materials remain system-owned. */
export const workPaper = {
  ground: adaptiveColor('#f2f1ed', '#000000', '#f2f1ed', '#000000'),
  ink: adaptiveColor('#1d1c19', '#ffffff', '#151411', '#ffffff'),
  secondary: adaptiveColor('#5f5d55', '#a8a8af', '#46443e', '#c8c8ce'),
  tertiary: adaptiveColor('#706e67', '#94949c', '#5f5d55', '#b0b0b8'),
  separator: adaptiveColor(
    'rgba(95,93,85,0.22)',
    'rgba(84,84,88,0.65)',
    'rgba(95,93,85,0.5)',
    '#74747c',
  ),
  fill: adaptiveColor('#e8e6e0', '#1c1c1e', '#dedbd3', '#2c2c2e'),
} as const

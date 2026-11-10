import { adaptiveColor } from '../theme/platform-colors'

/** Work's grouped ground and cards (system grouped background values);
 * native navigation materials remain system-owned. */
export const workPaper = {
  ground: adaptiveColor('#f2f2f7', '#000000', '#ebebf0', '#000000'),
  card: adaptiveColor('#ffffff', '#1c1c1e', '#ffffff', '#2c2c2e'),
  ink: adaptiveColor('#000000', '#ffffff', '#000000', '#ffffff'),
  secondary: adaptiveColor('#5c5c63', '#a1a1a8', '#46464c', '#c8c8ce'),
  tertiary: adaptiveColor('#6c6c73', '#8a8a92', '#55555b', '#b0b0b8'),
  separator: adaptiveColor(
    'rgba(60,60,67,0.22)',
    'rgba(84,84,88,0.65)',
    'rgba(60,60,67,0.5)',
    '#74747c',
  ),
  fill: adaptiveColor('#e5e5ea', '#2c2c2e', '#d8d8de', '#3a3a3c'),
} as const

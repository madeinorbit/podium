import { ASCII_COVERAGE } from './podium-ascii'

export const RAMP = ' .`\'^",:;!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'

export const ASCII_WORDMARK = ASCII_COVERAGE.map(
  (line) =>
    `${[...line]
      .map((cell) => {
        const value = parseInt(cell, 16)
        return value === 0
          ? ' '
          : RAMP.charAt(Math.max(1, Math.round((value / 15) * (RAMP.length - 1))))
      })
      .join('')}\n`,
).join('')

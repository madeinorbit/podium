#!/usr/bin/env bun
/**
 * Renders the PODIUM wordmark as a terminal banner for `install.sh`, from the SAME
 * coverage grid the web login screen / ASCII loader draw (apps/web/src/features/setup/
 * podium-ascii.ts). Half-block characters pack two grid rows into one text row, so the
 * 96x22 grid lands as 11 crisp lines that fit an 80-column terminal.
 *
 * Regenerate after the wordmark changes:
 *   bun scripts/render-install-banner.ts        # print the banner
 *   bun scripts/render-install-banner.ts --check  # diff it against install.sh
 * then paste the output into the `banner()` heredoc in install.sh.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASCII_COLS, ASCII_COVERAGE, ASCII_ROWS } from '../apps/web/src/features/setup/podium-ascii'

/** Output width in characters. 68 keeps the widest line inside an 80-column terminal. */
const COLS = 68
/** Coverage above this fraction inks a half-cell. Tuned so the italic stems stay solid. */
const THRESHOLD = 0.45

const coverage = (x: number, y: number): number => {
  const row = ASCII_COVERAGE[y]
  if (!row) return 0
  return Number.parseInt(row[x] ?? '0', 16) / 15
}

/** Mean coverage of grid row `y` over the fractional column span of output column `i`. */
const spanCoverage = (y: number, i: number): number => {
  const scale = ASCII_COLS / COLS
  const from = i * scale
  const to = (i + 1) * scale
  let sum = 0
  let weight = 0
  for (let x = Math.floor(from); x < Math.ceil(to); x++) {
    const w = Math.min(x + 1, to) - Math.max(x, from)
    sum += coverage(x, y) * w
    weight += w
  }
  return weight > 0 ? sum / weight : 0
}

export function renderBanner(): string[] {
  const lines: string[] = []
  for (let y = 0; y + 2 <= ASCII_ROWS; y += 2) {
    let line = ''
    for (let i = 0; i < COLS; i++) {
      const top = spanCoverage(y, i) > THRESHOLD
      const bottom = spanCoverage(y + 1, i) > THRESHOLD
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines.filter((l) => l.trim() !== '')
}

const banner = renderBanner()

if (process.argv.includes('--check')) {
  const script = readFileSync(join(import.meta.dir, '..', 'install.sh'), 'utf8')
  const missing = banner.filter((l) => !script.includes(l))
  if (missing.length > 0) {
    console.error('install.sh banner is out of date; regenerate with:')
    console.error('  bun scripts/render-install-banner.ts')
    process.exit(1)
  }
  console.log('install.sh banner matches the wordmark.')
} else {
  console.log(banner.join('\n'))
}

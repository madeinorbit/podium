import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/**
 * The Podium app icon — the mark on its tile, not the wordmark ({@link
 * PodiumLogo}). This is the thing the operator already knows from the Dock,
 * so About shows exactly it.
 *
 * Sourced from `/icon.svg` rather than a bundled copy under `src/`: that file
 * is the master the browser tab and the whole PNG set are rasterised from
 * (apps/web/public/icon.svg), and everything under `public/` is copied
 * verbatim into the dist the desktop shell loads. A fourth committed cut of
 * the same art is a fourth thing to forget when the mark changes.
 *
 * The art is FULL BLEED — the platforms mask their own shape over it — so the
 * corner has to be applied here. 22.4% is Apple's icon-grid radius
 * (180 ÷ 824 on the macOS cut), which keeps the About tile reading as the
 * same object as the one in the Dock. The inset hairline is the dialog's own
 * ring: the icon's ground starts at #232019 (bisque, POD-1427), within a hair
 * of panel ink, and without a rim its top-left corner dissolves into the sheet.
 */
export function PodiumMark({
  size = 72,
  className,
}: {
  size?: number
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'block flex-none overflow-hidden rounded-[22.4%] ring-1 ring-foreground/10 ring-inset',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <img src="/icon.svg" alt="" width={size} height={size} className="block size-full" />
    </span>
  )
}

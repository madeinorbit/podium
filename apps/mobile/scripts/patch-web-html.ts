/**
 * Post-export patch for the web build (runs after `expo export -p web`).
 *
 * Expo's `single` (SPA) output ignores app/+html.tsx, so everything the shipped
 * index.html needs in order to behave like an installed app is injected here:
 *
 *  - viewport: `viewport-fit=cover` exposes the safe-area env() insets. The
 *    former `maximum-scale=1` is GONE — it only existed to suppress iOS's input
 *    auto-zoom on sub-16px fields, and the type scale now starts at 17px
 *    (POD-366), so the pinch-zoom accessibility cost bought nothing.
 *  - install metadata: manifest, apple-touch-icon, standalone capability and
 *    the per-device launch images, all produced by ./generate-web-icons.ts.
 *    Without these, Add to Home Screen produces a Safari bookmark.
 *  - first-paint background: the navy is painted by the document itself so a
 *    cold launch never flashes white before the bundle boots.
 *  - browser tells: long-press selection, the callout menu and Safari's
 *    rubber-band are disabled at the root. Selection is handed back to
 *    transcript prose via [data-selectable] so agent output stays copyable.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const file = join(import.meta.dir, '..', 'dist', 'index.html')
const html = readFileSync(file, 'utf8')

const viewport = 'width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover'

/** Every iPhone the launch images cover; must match generate-web-icons.ts. */
const LAUNCH: [number, number, number][] = [
  [750, 1334, 2],
  [828, 1792, 2],
  [1125, 2436, 3],
  [1170, 2532, 3],
  [1179, 2556, 3],
  [1206, 2622, 3],
  [1260, 2736, 3],
  [1284, 2778, 3],
  [1290, 2796, 3],
  [1320, 2868, 3],
]

// Safari only honours an apple-touch-startup-image whose media query matches
// the device exactly; anything unmatched falls back to a white launch flash.
const startupImages = LAUNCH.map(([w, h, ratio]) => {
  const media =
    `(device-width: ${w / ratio}px) and (device-height: ${h / ratio}px) ` +
    `and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)`
  return `    <link rel="apple-touch-startup-image" media="${media}" href="/mobile/icons/launch-${w}x${h}.png" />`
}).join('\n')

const head = `
    <link rel="manifest" href="/mobile/manifest.webmanifest" />
    <link rel="apple-touch-icon" sizes="180x180" href="/mobile/icons/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Podium" />
    <meta name="theme-color" content="#0a0f1c" />
    <meta name="color-scheme" content="dark" />
${startupImages}
    <style id="podium-shell">
      /* Painted before the bundle boots — a cold launch must not flash white. */
      html, body { background-color: #0a0f1c; }
      /* Safari rubber-bands the document behind an app whose root is
         overflow:hidden, which reads as "the page is loose". */
      html, body { overscroll-behavior: none; }
      /* Long-press must not raise the selection magnifier or the callout menu
         over a card. Prose opts back in below. */
      body {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
      [data-selectable], [data-selectable] * {
        -webkit-user-select: text;
        user-select: text;
        -webkit-touch-callout: default;
      }
    </style>`

let patched = html.replace(
  /<meta name="viewport" content="[^"]*"/,
  `<meta name="viewport" content="${viewport}"`,
)
if (patched === html) throw new Error('patch-web-html: viewport meta not found in dist/index.html')

const beforeHead = patched
patched = patched.replace('</head>', `${head}\n  </head>`)
if (patched === beforeHead) throw new Error('patch-web-html: </head> not found in dist/index.html')

writeFileSync(file, patched)
console.log('patched viewport, install metadata and shell styles in dist/index.html')

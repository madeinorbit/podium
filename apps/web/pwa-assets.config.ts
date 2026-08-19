import { defineConfig } from '@vite-pwa/assets-generator/config'

/**
 * Rasterises public/icon-browser.svg into the unmasked browser/PWA icon set at
 * build time.
 * None of the output is committed — vite-plugin-pwa runs this on every build and
 * injects the head links.
 *
 * This is `minimal2023Preset` with each platform-masked slot removed. The
 * generator applies one source to every asset type, but these outputs need
 * different cuts:
 *
 *  - transparent + favicon: icon-browser.svg owns a rounded frame with
 *    transparent corners, because browsers and `purpose: any` surfaces display
 *    the pixels without imposing a platform mask.
 *  - apple: NOT GENERATED HERE. public/icon.svg remains full bleed and is
 *    rasterised by scripts/generate-maskable-icon.ts into the committed Apple
 *    touch PNG linked from index.html.
 *  - maskable: NOT GENERATED HERE. See below.
 *
 * WHY THE MASKABLE SLOT IS EMPTY [POD-1109]. It used to be the full-bleed cut at
 * `padding: 0.15` over the ground's mid stop, and that shipped the Android home
 * screen a mark inside a visible border. Two things compounded:
 *
 *   - `padding` is TOTAL, not per-side — `extractAssetSize` resizes to
 *     `size * (1 - padding)`, so the art landed at 85% of 512, composited
 *     centred on the flat background colour.
 *   - the source owns a GRADIENT ground. Insetting it over a flat colour does not
 *     read as padding, it reads as a band around a smaller tile, because those
 *     are two different fills. Moving the flat colour from Race Navy onto the
 *     9a mid stop [POD-1108] narrowed the mismatch but could not remove it.
 *
 * The fix is the one the 9a set already draws for this exact slot: a safe-zone
 * cut, with the plane raised and the letter stepped down, rather than the whole
 * tile shrunk into the crop. public/icon-maskable.svg is web's copy of that cut
 * (mobile renders the same art from apps/mobile/assets/icon-maskable.svg), and
 * it goes in FULL BLEED — the art already carries its own safe-zone margin, so
 * any padding here would put the border back.
 *
 * Neither special cut can be a second entry in `images`: the generator applies
 * one source to every asset type (`images` is a flat list) and
 * `defaultAssetName` keys outputs by TYPE (`pwa-`, `maskable-icon-`,
 * `apple-touch-icon-`), so a second image overwrites the first rather than
 * specialising a slot. So the maskable leaves the generator entirely — an
 * empty `sizes` is how a slot is switched off, since `resolveMaskableIcons`
 * iterates `sizes` — and is rasterised to the committed
 * public/icon-maskable-512.png by scripts/generate-maskable-icon.ts, then named
 * directly in the manifest by vite.config.ts. The same script writes the
 * full-bleed Apple touch icon from public/icon.svg.
 *
 * Because vite.config.ts now declares `manifest.icons` itself, this generator no
 * longer injects the icons array at all — vite-plugin-pwa only overrides it when
 * the manifest has no `icons` key (or when `overrideManifestIcons` is set, which
 * it must not be). Any transparent size added here needs adding there too.
 */
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    transparent: {
      sizes: [64, 192, 512],
      favicons: [[48, 'favicon.ico']],
      padding: 0,
    },
    maskable: {
      sizes: [],
    },
    apple: {
      sizes: [],
    },
  },
  images: ['public/icon-browser.svg'],
})

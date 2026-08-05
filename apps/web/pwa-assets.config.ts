import { defineConfig } from '@vite-pwa/assets-generator/config'

/**
 * Rasterises public/icon.svg into the installed-app icon set at build time.
 * None of the output is committed — vite-plugin-pwa runs this on every build and
 * injects the head links and the manifest icon entries.
 *
 * This is `minimal2023Preset` with the padding taken off [POD-421]. That preset
 * leaves `padding` at its 0.3 default for the maskable and apple assets, and the
 * fill behind that padding defaults to WHITE — so a mark drawn full bleed came
 * out shrunk to 40% of the frame inside a white square, and an iPhone home
 * screen showed a small dark tile floating in white. The source is already a
 * square that owns its own background (see the note in icon.svg), so:
 *
 *  - transparent / apple: no padding, the art fills the frame. iOS masks its own
 *    squircle over the apple icon, so shipping corners of our own would put the
 *    icon in a visible frame.
 *  - maskable: Android crops to a circle inscribed in the middle 80%, and the
 *    yellow bar runs close enough to the bottom corners to clip. This one keeps
 *    a padding — over Race Navy rather than white, so the inset does not read as
 *    a border.
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
      sizes: [512],
      padding: 0.15,
      resizeOptions: { background: '#0a0f1c' },
    },
    apple: {
      sizes: [180],
      padding: 0,
      resizeOptions: { background: '#0a0f1c' },
    },
  },
  images: ['public/icon.svg'],
})

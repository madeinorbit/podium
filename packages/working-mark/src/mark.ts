/**
 * Drawing a working mark in the browser, the cheapest way measured for the engine it runs in
 * (docs/measurements/POD-5558-working-mark-spike.md, "The final table").
 *
 * - `image` (what `auto` picks in every browser): one animated PNG per design, size, frame rate, colour and pixel
 *   density, built in the page from the design's own frames; every mark of a design shows the same image. The
 *   browser steps it by itself, draws only when the picture changes, and leaves it idle off screen, in skipped
 *   `content-visibility` rows and under `display: none`: no animation for the page to run, no visibility logic,
 *   and none of WebKit's frozen-animation bug (301745). Measured with 32 marks at 15 fps: Safari +11 to +14 points
 *   of one core over static marks, Chrome +13 to +14; flat to 256 marks; typing at static's level.
 * - `canvas` (WebKit only; elsewhere it falls back to `image`): one canvas per design painted into every mark through
 *   `-webkit-canvas()`, redrawn only when the picture changes and only while a mark is in view (an
 *   IntersectionObserver). In Safari it costs the same as the image at 12–15 fps and stays flat with many marks.
 * - `still`: the resting picture, never moving.
 *
 * Reduced motion shows the resting picture whatever the method, and so does `setWorkingMarksPaused(true)` (see
 * `pauseWorkingMarksWhenIdle`). The mark is drawn in its host's CSS `color` unless a colour is given.
 */
import { assembleApng } from './apng'
import { restingPicture, type Sheet, sheetOf, smoothFps } from './frames'
import type { Design, Picture } from './types'

/** How a mark is drawn. `auto` is the measured best for this browser. */
export type WorkingMarkMethod = 'auto' | 'image' | 'canvas' | 'still'

export interface WorkingMarkOptions {
  /** The mark's height in CSS px (its font size: designs are drawn in em). Default 12. */
  size?: number
  /** Frames per second, or 'smooth' for the design's own lowest smooth rate (20–40). Default 15. */
  fps?: number | 'smooth'
  /** Default 'auto'. */
  method?: WorkingMarkMethod
  /** A CSS colour; default the host's computed `color`. */
  color?: string
}

/** 15 fps: in the final table the animated image costs a third less in Safari than at 30, and still reads as motion. */
export const DEFAULT_FPS = 15

const hasDom = (): boolean => typeof document !== 'undefined' && typeof window !== 'undefined'
type CssCanvasDocument = Document & {
  getCSSCanvasContext?: (
    type: '2d',
    name: string,
    w: number,
    h: number,
  ) => CanvasRenderingContext2D | null
}
/** WebKit's `-webkit-canvas()`: one canvas painted into many elements' backgrounds. */
export const canShareCanvas = (): boolean =>
  hasDom() && typeof (document as CssCanvasDocument).getCSSCanvasContext === 'function'

/** The methods worth offering in this browser; the first is what `auto` picks. */
export function workingMarkMethods(): readonly Exclude<WorkingMarkMethod, 'auto'>[] {
  return canShareCanvas() ? ['image', 'canvas', 'still'] : ['image', 'still']
}

/** What a method really draws here. */
export function resolveMethod(
  method: WorkingMarkMethod = 'auto',
): Exclude<WorkingMarkMethod, 'auto'> {
  if (method === 'still') return 'still'
  if (method === 'canvas' && canShareCanvas()) return 'canvas'
  return 'image'
}

/** The host's box: square, or today's 0.66 × 1 cell for the tall designs. */
export function workingMarkBox(design: Design, size = 12): { width: number; height: number } {
  return { width: design.tall ? Math.round(size * 0.66) : size, height: size }
}

// ---------- pictures ----------

const dprNow = (): number => Math.max(1, Math.round((window.devicePixelRatio || 1) * 4) / 4)

function cellCanvas(
  sh: Sheet,
  px: number,
  color: string,
  dots: Picture,
  dpr: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sh.cellW * dpr)
  canvas.height = Math.round(sh.cellH * dpr)
  const g = canvas.getContext('2d')
  if (!g) return canvas
  g.fillStyle = color
  for (const [x, y, rx, ry, o] of dots) {
    g.globalAlpha = o
    g.beginPath()
    g.ellipse(
      (x * px - sh.left) * dpr,
      (y * px - sh.top) * dpr,
      rx * px * dpr,
      ry * px * dpr,
      0,
      0,
      Math.PI * 2,
    )
    g.fill()
  }
  return canvas
}

const pngBytes = (canvas: HTMLCanvasElement): Uint8Array =>
  Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1] ?? ''), (ch) => ch.charCodeAt(0))

const urls = new Map<string, string>()
function imageUrl(
  d: Design,
  sh: Sheet,
  px: number,
  color: string,
  dpr: number,
  still: boolean,
): string {
  const key = `${d.id} ${d.loop} ${px} ${sh.fps} ${dpr} ${color} ${still}`
  let url = urls.get(key)
  if (!url) {
    url = still
      ? cellCanvas(sh, px, color, restingPicture(d), dpr).toDataURL('image/png')
      : URL.createObjectURL(
          new Blob(
            [
              assembleApng(
                sh.cells.map((dots) => pngBytes(cellCanvas(sh, px, color, dots, dpr))),
                sh,
              ) as BlobPart,
            ],
            {
              type: 'image/png',
            },
          ),
        )
    urls.set(key, url)
  }
  return url
}

// ---------- the shared canvas (WebKit) ----------

interface SharedCanvas {
  g: CanvasRenderingContext2D
  w: number
  h: number
  sh: Sheet
  cells: HTMLCanvasElement[]
  rest: HTMLCanvasElement
  seen: Set<Element>
  timer: ReturnType<typeof setTimeout> | undefined
  cell: number
}
const canvases = new Map<string, SharedCanvas>()
let canvasViews: IntersectionObserver | undefined
const canvasOf = new WeakMap<Element, SharedCanvas>()

function drawCell(c: SharedCanvas, cell: HTMLCanvasElement, index: number): void {
  if (c.cell === index) return
  c.g.clearRect(0, 0, c.w, c.h)
  c.g.drawImage(cell, 0, 0)
  c.cell = index
}
function runCanvas(c: SharedCanvas): void {
  clearTimeout(c.timer)
  c.timer = undefined
  if (!c.seen.size || paused || reducedMotion()) {
    drawCell(c, c.rest, -1)
    return
  }
  const tick = (): void => {
    const u = (performance.now() % c.sh.P) / c.sh.P
    let i = c.sh.holds.findIndex((x) => u < x.to)
    if (i < 0) i = c.sh.holds.length - 1
    const hold = c.sh.holds[i]
    if (!hold) return
    const cell = c.cells[hold.cell]
    if (cell) drawCell(c, cell, hold.cell)
    c.timer = setTimeout(tick, Math.max(1, (hold.to - u) * c.sh.P + 1))
  }
  tick()
}
function sharedCanvas(d: Design, sh: Sheet, px: number, color: string, dpr: number): string {
  const name = `pod-mark-${d.id}-${d.loop}-${px}-${sh.fps}-${dpr}-${color.replace(/\W/g, '')}`
  if (!canvases.has(name)) {
    const w = Math.round(sh.cellW * dpr)
    const h = Math.round(sh.cellH * dpr)
    const g = (document as CssCanvasDocument).getCSSCanvasContext?.('2d', name, w, h)
    if (!g) return name
    canvases.set(name, {
      g,
      w,
      h,
      sh,
      cells: sh.cells.map((dots) => cellCanvas(sh, px, color, dots, dpr)),
      rest: cellCanvas(sh, px, color, restingPicture(d), dpr),
      seen: new Set(),
      timer: undefined,
      cell: -2,
    })
  }
  return name
}
const watchCanvases = (): IntersectionObserver => {
  canvasViews ??= new IntersectionObserver((entries) => {
    const touched = new Set<SharedCanvas>()
    for (const e of entries) {
      const c = canvasOf.get(e.target)
      if (!c) continue
      if (e.isIntersecting) c.seen.add(e.target)
      else c.seen.delete(e.target)
      touched.add(c)
    }
    for (const c of touched) if (!c.seen.size || c.timer === undefined) runCanvas(c)
  })
  return canvasViews
}

// ---------- live marks ----------

interface Live {
  host: HTMLElement
  design: Design
  options: WorkingMarkOptions
  color: string
  dpr: number
  inner: HTMLElement | null
  still: boolean
}
const live = new Set<Live>()
let paused = false
let motionQuery: MediaQueryList | undefined
const reducedMotion = (): boolean => {
  motionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)')
  return motionQuery.matches
}

function render(m: Live): void {
  const { design: d, options: o, host } = m
  const px = o.size ?? 12
  const method = resolveMethod(o.method)
  const fps = o.fps === 'smooth' ? smoothFps(d) : (o.fps ?? DEFAULT_FPS)
  const sh = sheetOf(d, px, fps, m.dpr)
  m.still = method === 'still' || paused || reducedMotion()
  if (m.inner) {
    const c = canvasOf.get(m.inner)
    if (c) {
      c.seen.delete(m.inner)
      canvasViews?.unobserve(m.inner)
      runCanvas(c)
    }
    m.inner.remove()
  }
  const place = (el: HTMLElement): void => {
    el.style.cssText = `position:absolute;left:calc(50% + ${sh.left}px);top:calc(50% + ${sh.top}px);width:${sh.cellW}px;height:${sh.cellH}px;pointer-events:none`
  }
  if (method === 'canvas' && !m.still) {
    const name = sharedCanvas(d, sh, px, m.color, m.dpr)
    const i = document.createElement('i')
    place(i)
    i.style.background = `-webkit-canvas(${name}) 0 0 / 100% 100% no-repeat`
    const c = canvases.get(name)
    if (c) {
      canvasOf.set(i, c)
      watchCanvases().observe(i)
    }
    m.inner = i
  } else {
    const img = document.createElement('img')
    img.alt = ''
    img.draggable = false
    img.decoding = 'async'
    place(img)
    img.src = imageUrl(d, sh, px, m.color, m.dpr, m.still)
    m.inner = img
  }
  host.append(m.inner)
}

const colorOf = (m: Pick<Live, 'host' | 'options'>): string =>
  m.options.color ?? getComputedStyle(m.host).color

// The colour is baked into the image, so a theme change (a class or attribute on <html>, or the system scheme) and a
// change of reduced motion redraw the marks whose picture changed. One observer for all marks, while any exist.
let themeWatch: MutationObserver | undefined
let schemeQuery: MediaQueryList | undefined
let refreshQueued = false
const queueRefresh = (): void => {
  if (refreshQueued) return
  refreshQueued = true
  requestAnimationFrame(() => {
    refreshQueued = false
    refreshWorkingMarks()
  })
}
function startWatching(): void {
  themeWatch = new MutationObserver(queueRefresh)
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style'],
  })
  schemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
  schemeQuery.addEventListener('change', queueRefresh)
  reducedMotion()
  motionQuery?.addEventListener('change', queueRefresh)
}
function stopWatching(): void {
  themeWatch?.disconnect()
  themeWatch = undefined
  schemeQuery?.removeEventListener('change', queueRefresh)
  motionQuery?.removeEventListener('change', queueRefresh)
}

/** Re-reads every mark's colour, pixel density and motion setting and redraws the ones that changed. Theme switches
 *  through <html>'s class, `data-theme` or `style` and the system's colour scheme are caught on their own. */
export function refreshWorkingMarks(): void {
  redraw(true)
}
/** Redraws the marks whose picture changed; reading colours costs a style lookup per mark, so pausing skips it. */
function redraw(readColors: boolean): void {
  const dpr = dprNow()
  const stillNow = (m: Live): boolean =>
    resolveMethod(m.options.method) === 'still' || paused || reducedMotion()
  for (const m of live) {
    const color = readColors ? colorOf(m) : m.color
    if (color === m.color && dpr === m.dpr && stillNow(m) === m.still) continue
    m.color = color
    m.dpr = dpr
    render(m)
  }
}

export interface WorkingMarkHandle {
  update(options: WorkingMarkOptions): void
  destroy(): void
}

/**
 * Draws `design` inside `host` (which should be positioned and sized: see `workingMarkBox`, or use
 * `createWorkingMark`). Returns a handle to change the options or remove the mark.
 */
export function mountWorkingMark(
  host: HTMLElement,
  design: Design,
  options: WorkingMarkOptions = {},
): WorkingMarkHandle {
  if (!hasDom()) return { update() {}, destroy() {} }
  if (!live.size) startWatching()
  const m: Live = { host, design, options, color: '', dpr: dprNow(), inner: null, still: false }
  m.color = colorOf(m)
  live.add(m)
  render(m)
  return {
    update(next) {
      m.options = next
      m.color = colorOf(m)
      render(m)
    },
    destroy() {
      if (!live.delete(m)) return
      if (m.inner) {
        const c = canvasOf.get(m.inner)
        if (c) {
          c.seen.delete(m.inner)
          canvasViews?.unobserve(m.inner)
          runCanvas(c)
        }
        m.inner.remove()
      }
      if (!live.size) stopWatching()
    },
  }
}

/** A ready host element: an inline box of the mark's size, hidden from assistive tech (the label beside it carries
 *  the state), with the mark drawn inside. */
export function createWorkingMark(
  design: Design,
  options: WorkingMarkOptions = {},
): { element: HTMLSpanElement } & WorkingMarkHandle {
  const element = document.createElement('span')
  const box = workingMarkBox(design, options.size)
  element.setAttribute('aria-hidden', 'true')
  element.style.cssText = `position:relative;display:inline-block;flex:none;vertical-align:middle;width:${box.width}px;height:${box.height}px`
  const handle = mountWorkingMark(element, design, options)
  return { element, ...handle }
}

// ---------- pausing ----------

/** Shows every mark's resting picture while paused; they go on, in step, when unpaused. */
export function setWorkingMarksPaused(on: boolean): void {
  if (paused === on) return
  paused = on
  redraw(false)
  for (const c of canvases.values()) runCanvas(c)
}

/**
 * Pauses the marks after `idleMs` without a key, click, pointer move or wheel, and while the window is unfocused or
 * hidden; the next input, focus or showing starts them again. Measured in both engines: paused marks cost what
 * static marks cost, and the restart is not noticeable. Returns a function that stops it (and unpauses).
 */
export function pauseWorkingMarksWhenIdle({ idleMs = 5000 }: { idleMs?: number } = {}): () => void {
  if (!hasDom()) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => setWorkingMarksPaused(true), idleMs)
  }
  const wake = (): void => {
    if (document.visibilityState === 'hidden' || !document.hasFocus()) return
    setWorkingMarksPaused(false)
    arm()
  }
  const sleep = (): void => {
    clearTimeout(timer)
    setWorkingMarksPaused(true)
  }
  const onVisibility = (): void => (document.visibilityState === 'hidden' ? sleep() : wake())
  const inputs = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const
  for (const type of inputs) window.addEventListener(type, wake, { passive: true, capture: true })
  window.addEventListener('focus', wake)
  window.addEventListener('blur', sleep)
  document.addEventListener('visibilitychange', onVisibility)
  if (document.visibilityState === 'hidden' || !document.hasFocus()) sleep()
  else wake()
  return () => {
    clearTimeout(timer)
    for (const type of inputs) window.removeEventListener(type, wake, { capture: true })
    window.removeEventListener('focus', wake)
    window.removeEventListener('blur', sleep)
    document.removeEventListener('visibilitychange', onVisibility)
    setWorkingMarksPaused(false)
  }
}

import type { SpecialKey } from '@podium/terminal-client'
import type { CSSProperties, JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// ---------------------------------------------------------------------------
// Combined four-arrow swipe key — gesture engine, overlay, and styles in one file.
// Spec: local joystick with precision near origin, adaptive acceleration, and
// edge-hold fast repeat for constrained directions (especially Right).
// ---------------------------------------------------------------------------

export type ArrowDirection = 'left' | 'right' | 'up' | 'down'

export const DIR_TO_KEY: Record<ArrowDirection, SpecialKey> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}

type GeometryKind = 'neutral' | 'diagonalNeutral' | 'directionActive' | 'edgeHold'

export interface GeometryResult {
  kind: GeometryKind
  direction: ArrowDirection | null
  axisDistance: number
}

export interface UsableMaxes {
  left: number
  right: number
  up: number
  down: number
}

export interface VisualState {
  overlayVisible: boolean
  activeDirection: ArrowDirection | null
  speedP: number
  edgeHold: boolean
  pulseToken: number
  overlayX: number
  keyTop: number
  keyWidth: number
}

const CFG = {
  activationDeadzone: 9,
  directionAcquireRatio: 1.55,
  directionAcquireBias: 2,
  directionKeepRatio: 1.15,
  directionSwitchRatio: 1.8,
  directionSwitchDelayMs: 50,
  precisionEnd: 31,
  intendedMaxLeft: 76,
  intendedMaxRight: 76,
  intendedMaxUp: 60,
  intendedMaxDown: 52,
  edgeGuard: 10,
  edgeZone: 8,
  constrainedThreshold: 60,
  constrainedAccelRoom: 29,
  firstRepeatDelayNearMs: 380,
  firstRepeatDelayFarMs: 200,
  horizontalMinCps: 2.5,
  horizontalMaxCps: 13,
  verticalMinCps: 2.5,
  verticalMaxCps: 8,
  constrainedDistanceMaxCps: 8,
  edgeHoldDelayMs: 300,
  edgeRampDurationMs: 700,
  edgeHoldNormalCps: 8,
  edgeHoldFastCps: 15,
  speedUpSmoothingMs: 50,
  slowDownSmoothingMs: 10,
} as const

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

export function computeUsableMaxes(
  originX: number,
  originY: number,
  viewportW: number,
  viewportH: number,
): UsableMaxes {
  const guard = CFG.edgeGuard
  return {
    left: Math.min(CFG.intendedMaxLeft, Math.max(0, originX - guard)),
    right: Math.min(CFG.intendedMaxRight, Math.max(0, viewportW - originX - guard)),
    up: CFG.intendedMaxUp,
    down: Math.min(CFG.intendedMaxDown, Math.max(0, viewportH - originY - guard)),
  }
}

export function usableMaxForDirection(maxes: UsableMaxes, dir: ArrowDirection): number {
  switch (dir) {
    case 'left':
      return maxes.left
    case 'right':
      return maxes.right
    case 'up':
      return maxes.up
    case 'down':
      return maxes.down
  }
}

export function isConstrainedDirection(usableMax: number): boolean {
  return (
    usableMax < CFG.constrainedThreshold || usableMax - CFG.precisionEnd < CFG.constrainedAccelRoom
  )
}

export function evaluateGeometry(
  dx: number,
  dy: number,
  activeDirection: ArrowDirection | null,
): GeometryResult {
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  const main = Math.max(absX, absY)
  const cross = Math.min(absX, absY)

  const deadzone = activeDirection ? CFG.activationDeadzone * 0.75 : CFG.activationDeadzone
  if (main < deadzone) {
    return { kind: 'neutral', direction: null, axisDistance: 0 }
  }

  const requiredRatio = activeDirection ? CFG.directionKeepRatio : CFG.directionAcquireRatio
  if (main < requiredRatio * cross + CFG.directionAcquireBias) {
    return { kind: 'diagonalNeutral', direction: null, axisDistance: main }
  }

  const horizontal = absX > absY
  const direction: ArrowDirection = horizontal
    ? dx > 0
      ? 'right'
      : 'left'
    : dy > 0
      ? 'up'
      : 'down'
  const axisDistance = horizontal ? absX : absY

  return { kind: 'directionActive', direction, axisDistance }
}

export function candidatePassesSwitchGate(dx: number, dy: number): boolean {
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  const main = Math.max(absX, absY)
  const cross = Math.min(absX, absY)
  return main >= CFG.directionSwitchRatio * cross
}

export function distanceSpeedP(axisDistance: number, usableMax: number): number {
  if (axisDistance <= CFG.precisionEnd) return 0
  const denom = Math.max(1, usableMax - CFG.precisionEnd)
  return smoothstep(clamp((axisDistance - CFG.precisionEnd) / denom, 0, 1))
}

export function edgeHoldProgress(edgeHoldMs: number): number {
  if (edgeHoldMs < CFG.edgeHoldDelayMs) return 0
  return smoothstep((edgeHoldMs - CFG.edgeHoldDelayMs) / CFG.edgeRampDurationMs)
}

export function repeatCps(
  direction: ArrowDirection,
  axisDistance: number,
  usableMax: number,
  constrained: boolean,
  edgeHold: boolean,
  edgeHoldMs: number,
): number {
  const horizontal = direction === 'left' || direction === 'right'
  const minCps = horizontal ? CFG.horizontalMinCps : CFG.verticalMinCps
  const maxCps = horizontal ? CFG.horizontalMaxCps : CFG.verticalMaxCps
  const speedP = distanceSpeedP(axisDistance, usableMax)

  if (constrained) {
    const distanceCps = lerp(minCps, CFG.constrainedDistanceMaxCps, speedP)
    if (edgeHold) {
      const edgeP = edgeHoldProgress(edgeHoldMs)
      return lerp(CFG.edgeHoldNormalCps, CFG.edgeHoldFastCps, edgeP)
    }
    return distanceCps
  }

  const distanceCps = lerp(minCps, maxCps, speedP)
  if (edgeHold) {
    const edgeP = edgeHoldProgress(edgeHoldMs)
    return lerp(distanceCps, CFG.edgeHoldFastCps, edgeP)
  }
  return distanceCps
}

export function firstRepeatDelayMs(speedP: number): number {
  return Math.round(lerp(CFG.firstRepeatDelayNearMs, CFG.firstRepeatDelayFarMs, speedP))
}

function isNearEdge(axisDistance: number, usableMax: number): boolean {
  return axisDistance >= usableMax - CFG.edgeZone
}

function smoothCps(current: number, target: number, dtMs: number, slowing: boolean): number {
  const tau = slowing ? CFG.slowDownSmoothingMs : CFG.speedUpSmoothingMs
  if (tau <= 0 || dtMs <= 0) return target
  const alpha = 1 - Math.exp(-dtMs / tau)
  return current + (target - current) * alpha
}

function directionLockHaptic(): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(8)
}

export interface ArrowSwipeEngineCallbacks {
  onEmit: (direction: ArrowDirection) => void
  onVisualChange: (visual: VisualState) => void
}

/** DOM-free gesture engine — unit-testable and driven by pointer events in the UI. */
export class ArrowSwipeEngine {
  private fingerDown = false
  private originX = 0
  private originY = 0
  private dx = 0
  private dy = 0
  private activeDirection: ArrowDirection | null = null
  private pendingSwitch: ArrowDirection | null = null
  private pendingSwitchStart = 0
  private edgeHold = false
  private edgeHoldMs = 0
  private edgeHoldAnchor = 0
  private maxes: UsableMaxes = { left: 76, right: 76, up: 60, down: 52 }
  private nextRepeatAt = 0
  private lastTickAt = 0
  private smoothedCps: number = CFG.horizontalMinCps
  private repeatArmed = false
  private lastIntervalMs = 0
  private speedP: number = 0
  private pulseToken = 0
  private overlayX = 0
  private keyTop = 0
  private keyWidth = 40
  private rafId = 0
  private viewportW = 0
  private viewportH = 0

  constructor(private readonly cb: ArrowSwipeEngineCallbacks) {}

  getActiveDirection(): ArrowDirection | null {
    return this.activeDirection
  }

  touchDown(
    clientX: number,
    clientY: number,
    now: number,
    overlayAnchor: { x: number; top: number; width: number },
  ): void {
    this.fingerDown = true
    this.originX = clientX
    this.originY = clientY
    this.dx = 0
    this.dy = 0
    this.activeDirection = null
    this.pendingSwitch = null
    this.pendingSwitchStart = 0
    this.edgeHold = false
    this.edgeHoldMs = 0
    this.repeatArmed = false
    this.nextRepeatAt = 0
    this.lastTickAt = now
    this.smoothedCps = CFG.horizontalMinCps
    this.overlayX = overlayAnchor.x
    this.keyTop = overlayAnchor.top
    this.keyWidth = overlayAnchor.width
    this.viewportW = typeof window !== 'undefined' ? window.innerWidth : 400
    this.viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
    this.maxes = computeUsableMaxes(this.originX, this.originY, this.viewportW, this.viewportH)
    this.publishVisual(true)
    this.startScheduler()
  }

  touchMove(clientX: number, clientY: number, now: number): void {
    if (!this.fingerDown) return
    this.dx = clientX - this.originX
    this.dy = this.originY - clientY
    this.handleGeometry(now)
  }

  touchEnd(now: number): void {
    this.fingerDown = false
    this.activeDirection = null
    this.pendingSwitch = null
    this.edgeHold = false
    this.repeatArmed = false
    this.stopScheduler()
    this.publishVisual(false)
    this.lastTickAt = now
  }

  dispose(): void {
    this.stopScheduler()
  }

  /** Test hook — advances repeat scheduling without waiting for animation frames. */
  advanceTime(now: number): void {
    this.schedulerTick(now)
  }

  private fingerDelta(): { dx: number; dy: number } {
    return { dx: this.dx, dy: this.dy }
  }

  private classifyGeometry(): GeometryResult {
    const geo = evaluateGeometry(this.dx, this.dy, this.activeDirection)
    if (geo.kind !== 'directionActive' || !geo.direction) return geo

    const usable = usableMaxForDirection(this.maxes, geo.direction)
    const constrained = isConstrainedDirection(usable)
    if (constrained && isNearEdge(geo.axisDistance, usable)) {
      return { kind: 'edgeHold', direction: geo.direction, axisDistance: geo.axisDistance }
    }
    return geo
  }

  private handleGeometry(now: number): void {
    const geo = this.classifyGeometry()

    if (geo.kind === 'neutral') {
      this.clearActive()
      this.publishVisual(true)
      return
    }

    if (geo.kind === 'diagonalNeutral') {
      this.clearActive()
      this.publishVisual(true)
      return
    }

    const dir = geo.direction!
    const usable = usableMaxForDirection(this.maxes, dir)
    const constrained = isConstrainedDirection(usable)
    const inEdge = geo.kind === 'edgeHold'

    if (this.activeDirection === null) {
      this.enterDirection(dir, geo.axisDistance, usable, constrained, inEdge, now)
      return
    }

    if (dir === this.activeDirection) {
      this.pendingSwitch = null
      this.pendingSwitchStart = 0
      this.updateMotion(geo.axisDistance, usable, constrained, inEdge, now)
      this.publishVisual(true)
      return
    }

    const { dx, dy } = this.fingerDelta()
    if (!candidatePassesSwitchGate(dx, dy)) {
      this.updateMotion(
        this.axisDistanceFor(this.activeDirection),
        usableMaxForDirection(this.maxes, this.activeDirection),
        isConstrainedDirection(usableMaxForDirection(this.maxes, this.activeDirection)),
        this.edgeHold,
        now,
      )
      this.publishVisual(true)
      return
    }

    if (this.pendingSwitch !== dir) {
      this.pendingSwitch = dir
      this.pendingSwitchStart = now
    } else if (now - this.pendingSwitchStart >= CFG.directionSwitchDelayMs) {
      this.enterDirection(dir, geo.axisDistance, usable, constrained, inEdge, now)
    } else {
      this.updateMotion(
        this.axisDistanceFor(this.activeDirection),
        usableMaxForDirection(this.maxes, this.activeDirection),
        isConstrainedDirection(usableMaxForDirection(this.maxes, this.activeDirection)),
        this.edgeHold,
        now,
      )
    }
    this.publishVisual(true)
  }

  private axisDistanceFor(dir: ArrowDirection): number {
    return dir === 'left' || dir === 'right' ? Math.abs(this.dx) : Math.abs(this.dy)
  }

  private clearActive(): void {
    this.activeDirection = null
    this.pendingSwitch = null
    this.pendingSwitchStart = 0
    this.edgeHold = false
    this.edgeHoldMs = 0
    this.repeatArmed = false
    this.nextRepeatAt = 0
    this.lastIntervalMs = 0
    this.speedP = 0
  }

  private enterDirection(
    dir: ArrowDirection,
    axisDistance: number,
    usable: number,
    constrained: boolean,
    inEdge: boolean,
    now: number,
  ): void {
    const switching = this.activeDirection !== null && this.activeDirection !== dir
    this.activeDirection = dir
    this.pendingSwitch = null
    this.pendingSwitchStart = 0
    this.edgeHold = inEdge
    this.edgeHoldMs = 0
    this.edgeHoldAnchor = now
    this.speedP = distanceSpeedP(axisDistance, usable)
    this.smoothedCps = repeatCps(dir, axisDistance, usable, constrained, inEdge, 0)
    this.cb.onEmit(dir)
    if (!switching) directionLockHaptic()
    this.repeatArmed = true
    const delay = firstRepeatDelayMs(this.speedP)
    this.nextRepeatAt = now + delay
    this.lastIntervalMs = delay
    this.lastTickAt = now
    this.publishVisual(true)
  }

  private updateMotion(
    axisDistance: number,
    usable: number,
    constrained: boolean,
    inEdge: boolean,
    now: number,
  ): void {
    if (!this.activeDirection) return
    if (inEdge) {
      if (!this.edgeHold) {
        this.edgeHold = true
        this.edgeHoldAnchor = now
        this.edgeHoldMs = 0
      } else {
        this.edgeHoldMs = now - this.edgeHoldAnchor
      }
    } else {
      this.edgeHold = false
      this.edgeHoldMs = 0
    }
    this.speedP = distanceSpeedP(axisDistance, usable)
    const target = repeatCps(
      this.activeDirection,
      axisDistance,
      usable,
      constrained,
      this.edgeHold,
      this.edgeHoldMs,
    )
    const slowing = target < this.smoothedCps
    const dt = Math.max(0, now - this.lastTickAt)
    this.smoothedCps = smoothCps(this.smoothedCps, target, dt, slowing)
    this.lastTickAt = now
  }

  private schedulerTick = (now: number): void => {
    if (!this.fingerDown) return

    if (!this.activeDirection) {
      this.rafId = requestAnimationFrame(this.schedulerFrame)
      return
    }

    const geo = this.classifyGeometry()
    if (geo.kind === 'neutral' || geo.kind === 'diagonalNeutral') {
      this.clearActive()
      this.publishVisual(true)
      this.rafId = requestAnimationFrame(this.schedulerFrame)
      return
    }

    if (geo.direction !== this.activeDirection) {
      this.rafId = requestAnimationFrame(this.schedulerFrame)
      return
    }

    const usable = usableMaxForDirection(this.maxes, this.activeDirection)
    const constrained = isConstrainedDirection(usable)
    const inEdge = geo.kind === 'edgeHold'
    this.updateMotion(geo.axisDistance, usable, constrained, inEdge, now)

    if (!this.repeatArmed) {
      this.rafId = requestAnimationFrame(this.schedulerFrame)
      return
    }

    const interval = 1000 / Math.max(CFG.horizontalMinCps, this.smoothedCps)
    if (interval > this.lastIntervalMs) {
      this.nextRepeatAt = Math.max(this.nextRepeatAt, now + interval)
    } else if (interval < this.lastIntervalMs) {
      this.nextRepeatAt = Math.min(this.nextRepeatAt, now + interval)
    }
    this.lastIntervalMs = interval

    if (now >= this.nextRepeatAt) {
      this.cb.onEmit(this.activeDirection)
      this.pulseToken += 1
      this.nextRepeatAt = now + interval
      this.publishVisual(true)
    }

    this.rafId = requestAnimationFrame(this.schedulerFrame)
  }

  private schedulerFrame = (ts: number): void => {
    this.schedulerTick(ts)
  }

  private startScheduler(): void {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(this.schedulerFrame)
  }

  private stopScheduler(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  private publishVisual(overlayVisible: boolean): void {
    this.cb.onVisualChange({
      overlayVisible,
      activeDirection: this.activeDirection,
      speedP: this.speedP,
      edgeHold: this.edgeHold,
      pulseToken: this.pulseToken,
      overlayX: this.overlayX,
      keyTop: this.keyTop,
      keyWidth: this.keyWidth,
    })
  }
}

function glyphMotion(
  active: ArrowDirection | null,
  dir: ArrowDirection,
  speedP: number,
  edgeHold: boolean,
): CSSProperties | undefined {
  if (active !== dir) return undefined
  const stem = 3 + Math.round(speedP * 16)
  const edgeBoost = edgeHold && dir === 'right' ? 4 : 0
  const zoom = 1 + speedP * 0.22
  return {
    '--ask-stem': `${stem + edgeBoost}px`,
    '--ask-zoom': String(zoom),
  } as CSSProperties
}

function DpadGlyphs({
  active,
  speedP,
  edgeHold,
  pulseToken,
  variant = 'key',
}: {
  active: ArrowDirection | null
  speedP: number
  edgeHold: boolean
  pulseToken: number
  variant?: 'key' | 'float'
}): JSX.Element {
  const cls = (dir: ArrowDirection): string => {
    const on = active === dir
    const pulse = on && variant === 'float' ? ` ask-pulse-${pulseToken % 2}` : ''
    if (on) return `ask-g ${dir} on${pulse}`
    return active ? `ask-g ${dir} dim` : `ask-g ${dir}`
  }

  return (
    <>
      <span
        className={cls('up')}
        style={glyphMotion(active, 'up', speedP, edgeHold)}
        aria-hidden="true"
      >
        <i />
      </span>
      <span
        className={cls('right')}
        style={glyphMotion(active, 'right', speedP, edgeHold)}
        aria-hidden="true"
      >
        <i />
      </span>
      <span
        className={cls('down')}
        style={glyphMotion(active, 'down', speedP, edgeHold)}
        aria-hidden="true"
      >
        <i />
      </span>
      <span
        className={cls('left')}
        style={glyphMotion(active, 'left', speedP, edgeHold)}
        aria-hidden="true"
      >
        <i />
      </span>
      <span className="ask-center" aria-hidden="true" />
    </>
  )
}

const ARROW_SWIPE_STYLES = `
.ask-key {
  position: relative;
  isolation: isolate;
  flex: 0 0 auto;
  width: 40px;
  height: 30px;
  padding: 0;
  /* Bordered-key look shared with the key bar (mobile.md §2.3). */
  border: 1px solid var(--hairline-bar);
  border-radius: 6px;
  background: var(--card);
  cursor: pointer;
  font: inherit;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.ask-key::before {
  content: '';
  position: absolute;
  inset: -7px -2px;
}
.ask-key.holding {
  background: color-mix(in srgb, var(--secondary) 70%, var(--card));
  border-color: color-mix(in srgb, var(--hairline-bar) 65%, var(--primary));
}
.ask-key .ask-g {
  position: absolute;
  pointer-events: none;
  color: var(--muted-foreground);
  transition: color 0.06s ease, opacity 0.06s ease;
}
.ask-key .ask-g.dim { opacity: 0.28; }
.ask-key .ask-g.on { color: #fff; }
.ask-key .ask-g i {
  display: block;
  width: 0;
  height: 0;
}
.ask-key .ask-g.up { top: 5px; left: 50%; transform: translateX(-50%); }
.ask-key .ask-g.up i {
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-bottom: 5px solid currentColor;
}
.ask-key .ask-g.down { bottom: 5px; left: 50%; transform: translateX(-50%); }
.ask-key .ask-g.down i {
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
}
.ask-key .ask-g.left { left: 6px; top: 50%; transform: translateY(-50%); }
.ask-key .ask-g.left i {
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-right: 5px solid currentColor;
}
.ask-key .ask-g.right { right: 6px; top: 50%; transform: translateY(-50%); }
.ask-key .ask-g.right i {
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor;
}
.ask-key .ask-center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 3px;
  height: 3px;
  margin: -1.5px 0 0 -1.5px;
  border-radius: 50%;
  background: var(--muted-foreground);
  opacity: 0.55;
  pointer-events: none;
}
.ask-float {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  opacity: 0;
  transform: translateX(-50%) translateY(6px) scale(0.94);
  transition: opacity 0.1s ease, transform 0.12s ease;
}
.ask-float.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0) scale(1);
}
.ask-float-bubble {
  position: relative;
  width: 68px;
  height: 68px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--card) 92%, transparent);
  border: 1px solid var(--border);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.ask-float-neck {
  width: var(--ask-neck-w, 28px);
  height: 26px;
  margin-top: -1px;
  overflow: visible;
}
.ask-float-neck svg {
  display: block;
  width: 100%;
  height: 100%;
}
.ask-float-neck path {
  fill: color-mix(in srgb, var(--card) 92%, transparent);
  stroke: var(--border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.ask-float .ask-g {
  position: absolute;
  pointer-events: none;
  color: var(--muted-foreground);
  transition: color 0.05s ease, opacity 0.05s ease, transform 0.08s ease;
}
.ask-float .ask-g.dim { opacity: 0.22; }
.ask-float .ask-g.on { color: #fff; }
.ask-float .ask-g i {
  display: block;
  flex: 0 0 auto;
  width: 0;
  height: 0;
}
.ask-float .ask-g::after {
  content: '';
  display: block;
  flex: 0 0 auto;
  background: currentColor;
  opacity: 0.65;
  border-radius: 1px;
}
/* Head sits on the outer edge; stem grows inward toward center (same for all dirs). */
.ask-float .ask-g.up {
  top: 9px;
  left: 50%;
  transform: translateX(-50%) scale(var(--ask-zoom, 1));
  transform-origin: center top;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.ask-float .ask-g.up::after { width: 2px; height: var(--ask-stem, 0px); }
.ask-float .ask-g.up i {
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-bottom: 6px solid currentColor;
}
.ask-float .ask-g.down {
  bottom: 9px;
  left: 50%;
  transform: translateX(-50%) scale(var(--ask-zoom, 1));
  transform-origin: center bottom;
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
}
.ask-float .ask-g.down::after { width: 2px; height: var(--ask-stem, 0px); }
.ask-float .ask-g.down i {
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid currentColor;
}
.ask-float .ask-g.left {
  left: 9px;
  top: 50%;
  transform: translateY(-50%) scale(var(--ask-zoom, 1));
  transform-origin: left center;
  display: flex;
  flex-direction: row;
  align-items: center;
}
.ask-float .ask-g.left::after { height: 2px; width: var(--ask-stem, 0px); }
.ask-float .ask-g.left i {
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-right: 6px solid currentColor;
}
.ask-float .ask-g.right {
  right: 9px;
  top: 50%;
  transform: translateY(-50%) scale(var(--ask-zoom, 1));
  transform-origin: right center;
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
}
.ask-float .ask-g.right::after { height: 2px; width: var(--ask-stem, 0px); }
.ask-float .ask-g.right i {
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-left: 6px solid currentColor;
}
.ask-float .ask-center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  margin: -2px 0 0 -2px;
  border-radius: 50%;
  background: var(--muted-foreground);
  opacity: 0.5;
}
@keyframes ask-pulse-v {
  50% { filter: brightness(1.2); }
}
@keyframes ask-pulse-h {
  50% { filter: brightness(1.2); }
}
.ask-float .ask-g.up.on.ask-pulse-0,
.ask-float .ask-g.down.on.ask-pulse-0 { animation: ask-pulse-v 0.12s ease; }
.ask-float .ask-g.left.on.ask-pulse-1,
.ask-float .ask-g.right.on.ask-pulse-1 { animation: ask-pulse-h 0.12s ease; }
`

export interface ArrowSwipeKeyProps {
  onFire: (key: SpecialKey) => void
}

/** Four-direction swipe arrow key for the mobile soft-keyboard action row. */
export function ArrowSwipeKey({ onFire }: ArrowSwipeKeyProps): JSX.Element {
  const keyRef = useRef<HTMLButtonElement | null>(null)
  const onFireRef = useRef(onFire)
  onFireRef.current = onFire

  const [visual, setVisual] = useState<VisualState>({
    overlayVisible: false,
    activeDirection: null,
    speedP: 0,
    edgeHold: false,
    pulseToken: 0,
    overlayX: 0,
    keyTop: 0,
    keyWidth: 40,
  })

  const engineRef = useRef<ArrowSwipeEngine | null>(null)
  const pressedRef = useRef(false)

  useEffect(() => {
    const engine = new ArrowSwipeEngine({
      onEmit: (dir) => onFireRef.current(DIR_TO_KEY[dir]),
      onVisualChange: setVisual,
    })
    engineRef.current = engine
    return () => engine.dispose()
  }, [])

  const overlayAnchor = (): { x: number; top: number; width: number } => {
    const el = keyRef.current
    if (!el) return { x: 0, top: 0, width: 40 }
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, top: r.top, width: r.width }
  }

  const stop = (): void => {
    pressedRef.current = false
    engineRef.current?.touchEnd(performance.now())
  }

  return (
    <>
      <style>{ARROW_SWIPE_STYLES}</style>
      <button
        type="button"
        ref={keyRef}
        className={visual.overlayVisible ? 'ask-key holding' : 'ask-key'}
        aria-label="Arrow keys — touch and swipe toward a direction"
        onPointerDown={(e) => {
          e.preventDefault()
          pressedRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          engineRef.current?.touchDown(e.clientX, e.clientY, performance.now(), overlayAnchor())
        }}
        onPointerMove={(e) => {
          if (!pressedRef.current) return
          engineRef.current?.touchMove(e.clientX, e.clientY, performance.now())
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
      >
        {!visual.overlayVisible && (
          <DpadGlyphs active={null} speedP={0} edgeHold={false} pulseToken={0} variant="key" />
        )}
      </button>
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            className={visual.overlayVisible ? 'ask-float visible' : 'ask-float'}
            style={{
              left: visual.overlayX,
              bottom: `calc(100vh - ${visual.keyTop}px)`,
              ['--ask-neck-w' as string]: `${Math.max(22, Math.min(36, visual.keyWidth + 4))}px`,
            }}
            aria-hidden="true"
          >
            <div className="ask-float-bubble">
              <DpadGlyphs
                active={visual.activeDirection}
                speedP={visual.speedP}
                edgeHold={visual.edgeHold}
                pulseToken={visual.pulseToken}
                variant="float"
              />
            </div>
            <div className="ask-float-neck">
              <svg viewBox="0 0 40 26" preserveAspectRatio="none" aria-hidden="true">
                <path d="M3 0 H37 Q40 1 35 10 Q24 26 20 26 Q16 26 5 10 Q0 1 3 0 Z" />
              </svg>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/** @deprecated Use ArrowSwipeKey — kept as alias for any stale imports. */
export const ArrowPad = ArrowSwipeKey

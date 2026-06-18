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
  overlayY: number
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
  horizontalMaxCps: 11,
  verticalMinCps: 2.5,
  verticalMaxCps: 7,
  constrainedDistanceMaxCps: 8,
  edgeHoldDelayMs: 300,
  edgeRampDurationMs: 700,
  edgeHoldNormalCps: 8,
  edgeHoldFastCps: 14,
  speedUpSmoothingMs: 50,
  slowDownSmoothingMs: 10,
  minHitPx: 44,
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
    usableMax < CFG.constrainedThreshold ||
    usableMax - CFG.precisionEnd < CFG.constrainedAccelRoom
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
  private overlayY = 0
  private rafId = 0
  private viewportW = 0
  private viewportH = 0

  constructor(private readonly cb: ArrowSwipeEngineCallbacks) {}

  getActiveDirection(): ArrowDirection | null {
    return this.activeDirection
  }

  touchDown(clientX: number, clientY: number, now: number, overlayAnchor: { x: number; y: number }): void {
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
    this.overlayY = overlayAnchor.y
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
      overlayY: this.overlayY,
    })
  }
}

function DpadGlyphs({
  active,
  speedP,
  edgeHold,
  pulseToken,
  size = 'key',
}: {
  active: ArrowDirection | null
  speedP: number
  edgeHold: boolean
  pulseToken: number
  size?: 'key' | 'overlay'
}): JSX.Element {
  const stem = size === 'overlay' ? 4 + Math.round(speedP * 14) : 0
  const edgeBoost = edgeHold && active === 'right' ? 4 : 0
  const cls = (dir: ArrowDirection): string => {
    const on = active === dir
    const pulse = on ? ` ask-pulse-${pulseToken % 3}` : ''
    return on ? `ask-g ${dir} on${pulse}` : active ? `ask-g ${dir} dim` : `ask-g ${dir}`
  }
  const stemStyle = (dir: ArrowDirection): CSSProperties | undefined => {
    if (active !== dir || size === 'key') return undefined
    const len = stem + (dir === 'right' && edgeHold ? edgeBoost : 0)
    return { '--ask-stem': `${len}px` } as CSSProperties
  }

  return (
    <>
      <span className={cls('up')} style={stemStyle('up')} aria-hidden="true">
        <i />
      </span>
      <span className={cls('right')} style={stemStyle('right')} aria-hidden="true">
        <i />
      </span>
      <span className={cls('down')} style={stemStyle('down')} aria-hidden="true">
        <i />
      </span>
      <span className={cls('left')} style={stemStyle('left')} aria-hidden="true">
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
  overflow: visible;
  flex: 0 0 auto;
  width: 40px;
  height: 30px;
  min-width: ${CFG.minHitPx}px;
  min-height: ${CFG.minHitPx}px;
  padding: 0;
  margin: -7px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--secondary);
  cursor: pointer;
  font: inherit;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
.ask-overlay {
  position: fixed;
  z-index: 60;
  width: 60px;
  height: 60px;
  margin-left: -30px;
  margin-top: -68px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 88%, transparent);
  border: 1px solid var(--border);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  pointer-events: none;
  opacity: 0;
  transform: scale(0.92);
  transition: opacity 0.1s ease, transform 0.1s ease;
}
.ask-overlay.visible {
  opacity: 1;
  transform: scale(1);
}
.ask-overlay .ask-g {
  position: absolute;
  pointer-events: none;
  color: var(--muted-foreground);
  transition: color 0.05s ease, opacity 0.05s ease;
}
.ask-overlay .ask-g.dim { opacity: 0.22; }
.ask-overlay .ask-g.on { color: #fff; }
.ask-overlay .ask-g.up { top: 8px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; }
.ask-overlay .ask-g.down { bottom: 8px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column-reverse; align-items: center; }
.ask-overlay .ask-g.left { left: 8px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: row-reverse; align-items: center; }
.ask-overlay .ask-g.right { right: 8px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: row; align-items: center; }
.ask-overlay .ask-g i {
  display: block;
  flex: 0 0 auto;
  width: 0;
  height: 0;
}
.ask-overlay .ask-g.up i {
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-bottom: 6px solid currentColor;
}
.ask-overlay .ask-g.down i {
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid currentColor;
}
.ask-overlay .ask-g.left i {
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-right: 6px solid currentColor;
}
.ask-overlay .ask-g.right i {
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-left: 6px solid currentColor;
}
.ask-overlay .ask-g::after {
  content: '';
  display: block;
  background: currentColor;
  opacity: 0.65;
  border-radius: 1px;
}
.ask-overlay .ask-g.up::after,
.ask-overlay .ask-g.down::after { width: 2px; height: var(--ask-stem, 0px); }
.ask-overlay .ask-g.left::after,
.ask-overlay .ask-g.right::after { height: 2px; width: var(--ask-stem, 0px); }
.ask-overlay .ask-center {
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
@keyframes ask-pulse-a { 50% { transform: translateX(-50%) scale(1.08); } }
@keyframes ask-pulse-b { 50% { transform: translateY(-50%) scale(1.08); } }
.ask-overlay .ask-g.up.on.ask-pulse-0 { animation: ask-pulse-a 0.12s ease; }
.ask-overlay .ask-g.down.on.ask-pulse-0 { animation: ask-pulse-a 0.12s ease; }
.ask-overlay .ask-g.left.on.ask-pulse-1 { animation: ask-pulse-b 0.12s ease; }
.ask-overlay .ask-g.right.on.ask-pulse-1 { animation: ask-pulse-b 0.12s ease; }
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
    overlayY: 0,
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

  const overlayAnchor = (): { x: number; y: number } => {
    const el = keyRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
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
        className="ask-key"
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
        <DpadGlyphs
          active={visual.overlayVisible ? visual.activeDirection : null}
          speedP={visual.speedP}
          edgeHold={visual.edgeHold}
          pulseToken={visual.pulseToken}
          size="key"
        />
      </button>
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            className={visual.overlayVisible ? 'ask-overlay visible' : 'ask-overlay'}
            style={{ left: visual.overlayX, top: visual.overlayY }}
            aria-hidden="true"
          >
            <DpadGlyphs
              active={visual.activeDirection}
              speedP={visual.speedP}
              edgeHold={visual.edgeHold}
              pulseToken={visual.pulseToken}
              size="overlay"
            />
          </div>,
          document.body,
        )}
    </>
  )
}

/** @deprecated Use ArrowSwipeKey — kept as alias for any stale imports. */
export const ArrowPad = ArrowSwipeKey
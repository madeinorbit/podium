import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useState,
} from 'react'
import { Share2 } from 'lucide-react'

const GRAPH_HEIGHT = 12

export interface StatusMetricBucket {
  startMs: number
  value: number
}

interface StatusMetricProps {
  testId: string
  tone: 'agents' | 'burn' | 'ship'
  current: ReactNode
  buckets: StatusMetricBucket[]
  title: string
  summary: string
  aside: string
  reading: (value: number) => { value: string; label: string }
  foot: string
  shareText?: string
  /** Agent concurrency is an absolute pixel stack; rates scale to their peak. */
  scaleMax?: number
}

function timeLabel(bucket: StatusMetricBucket | undefined, index: number, count: number): string {
  if (index === count - 1 || !bucket || bucket.startMs <= 0) return 'now'
  return new Date(bucket.startMs + 60 * 60 * 1_000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function xIntent(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`
}

/**
 * One footer instrument: current reading, 12-hour trace, hover precision and a
 * share action. The three metrics deliberately share structure but not colour,
 * so the strip reads as one small dashboard instead of three unrelated widgets.
 */
export function StatusMetric({
  testId,
  tone,
  current,
  buckets,
  title,
  summary,
  aside,
  reading,
  foot,
  shareText,
  scaleMax,
}: StatusMetricProps): JSX.Element {
  const [activeIndex, setActiveIndex] = useState(Math.max(0, buckets.length - 1))
  const lastIndex = Math.max(0, buckets.length - 1)
  const safeIndex = Math.min(activeIndex, lastIndex)
  const active = buckets[safeIndex] ?? { startMs: 0, value: 0 }
  const activeReading = reading(active.value)
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.value))
  const chartMax = Math.max(scaleMax ?? peak, Number.EPSILON)
  const activeTime = timeLabel(active, safeIndex, buckets.length)

  const move = (event: MouseEvent<HTMLSpanElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 1
    setActiveIndex(Math.max(0, Math.min(lastIndex, Math.floor(ratio * buckets.length))))
  }
  const moveWithKeyboard = (event: KeyboardEvent<HTMLSpanElement>): void => {
    let next = safeIndex
    if (event.key === 'ArrowLeft') next -= 1
    else if (event.key === 'ArrowRight') next += 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = lastIndex
    else return
    event.preventDefault()
    setActiveIndex(Math.max(0, Math.min(lastIndex, next)))
  }

  return (
    <span className="status-strip-metric" data-tone={tone}>
      {current}
      {shareText && (
        <a
          className="status-strip-share"
          href={xIntent(shareText)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Share ${title.toLowerCase()} on X`}
          title={`Share ${title.toLowerCase()} on X`}
        >
          <Share2 size={9} strokeWidth={1.8} aria-hidden="true" />
        </a>
      )}
      <span className="status-strip-history">
        <span className="status-strip-history-label" aria-hidden="true">
          12h
        </span>
        <span
          className="status-strip-history-graph"
          data-testid={testId}
          role="slider"
          tabIndex={0}
          aria-label={summary}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={lastIndex}
          aria-valuenow={safeIndex}
          aria-valuetext={`${activeReading.value} ${activeReading.label} in the bucket ending ${activeTime}`}
          style={{ '--history-columns': buckets.length } as CSSProperties}
          onBlur={() => setActiveIndex(lastIndex)}
          onKeyDown={moveWithKeyboard}
          onMouseLeave={() => setActiveIndex(lastIndex)}
          onMouseMove={move}
        >
          {buckets.map((bucket, index) => {
            const height =
              bucket.value <= 0
                ? 0
                : Math.max(
                    1,
                    Math.round((Math.min(bucket.value, chartMax) / chartMax) * GRAPH_HEIGHT),
                  )
            const ageStrength = 0.36 + (index / Math.max(1, lastIndex)) * 0.34
            return (
              <span
                key={`${bucket.startMs}:${index}`}
                className="status-strip-history-stack"
                data-active={index === safeIndex ? 'true' : 'false'}
                data-current={index === lastIndex ? 'true' : 'false'}
                data-over-cap={bucket.value > chartMax ? 'true' : 'false'}
                style={
                  {
                    '--history-strength': ageStrength,
                    '--history-height': `${height}px`,
                  } as CSSProperties
                }
              >
                <i className="status-strip-history-pixel" />
              </span>
            )
          })}
        </span>
        <span className="status-strip-history-tooltip" aria-hidden="true">
          <span className="status-strip-history-tip-head">
            <b>{title}</b>
            <span>{aside}</span>
          </span>
          <span className="status-strip-history-reading">
            <b>{activeReading.value}</b>
            <span>{activeReading.label}</span>
            <time>{activeTime}</time>
          </span>
          <span className="status-strip-history-foot">{foot}</span>
        </span>
      </span>
    </span>
  )
}

import { useEffect } from 'react'
import { pauseWorkingMarksWhenIdle } from '@podium/working-mark'

export function useWorkingMarkMotion(): void {
  useEffect(() => pauseWorkingMarksWhenIdle(), [])
}

// The package listens to keyboard, pointer and wheel events at the window.
export function noteWorkingMarkInput(): void {}

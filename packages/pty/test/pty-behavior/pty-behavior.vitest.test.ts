import { describe, expect, it } from 'vitest'
import { nodePtyBackend } from '../../src/backends/index'
import { ptyBehaviorSpec } from './spec'

ptyBehaviorSpec({ describe, it, expect }, nodePtyBackend)

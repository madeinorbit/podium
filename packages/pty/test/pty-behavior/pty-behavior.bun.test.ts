// Run only under `bun test`; this is the production Bun.Terminal behavior matrix.
import { describe, expect, it } from 'bun:test'
import { bunTerminalBackend } from '../../src/backends/bun-terminal-backend'
import { ptyBehaviorSpec } from './spec'

ptyBehaviorSpec({ describe, it, expect }, bunTerminalBackend)

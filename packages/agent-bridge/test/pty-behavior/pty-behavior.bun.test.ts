// Run ONLY under `bun test`. Imports narrow paths so node:sqlite is never pulled in
// (it is not implemented in Bun), and so the node-pty native addon is never loaded.
import { describe, expect, it } from 'bun:test'
import { bunTerminalBackend } from '../../src/pty/bun-terminal-backend'
import { ptyBehaviorSpec } from './spec'

ptyBehaviorSpec({ describe, it, expect }, bunTerminalBackend)

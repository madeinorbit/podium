import { keyedComputed } from '@podium/mobx-helpers'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import { autorun, compareStructural } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createScanningHeaderSessions } from '../../../apps/web/harness/header-scan-control'


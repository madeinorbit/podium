import { describe, expect, it } from 'vitest'
import {
  applyAction,
  armedIfKilled,
  convergedObservation,
  desiredParentUnit,
  devLegacyDefinitions,
  leftoverParentUnit,
  legacyDevObservation,
  legacyUnitNames,
  legacyVpsObservation,
  type MigrationAction,
  parentChildrenForMode,
  planMigration,
  reboot,
  type TopologyObservation,
} from './topology-migration'

function walkUntil(
  start: TopologyObservation,
  stop: (obs: TopologyObservation, action: MigrationAction) => boolean,
  patch?: (obs: TopologyObservation, action: MigrationAction) => TopologyObservation,
): { obs: TopologyObservation; steps: MigrationAction[] } {
  const steps: MigrationAction[] = []
  let obs = start
  for (let i = 0; i < 20; i++) {
    const action = planMigration(obs)
    steps.push(action)
    if (stop(obs, action)) return { obs, steps }
    if (action.type === 'noop' || action.type === 'refuse-foreground') return { obs, steps }
    let next = applyAction(obs, action)
    if (patch) next = patch(next, action)
    obs = next
  }
  throw new Error(`did not stop after ${steps.map((s) => s.type).join(' → ')}`)
}

describe('desired parent unit name', () => {
  it('is podium.service, not podium-parent.service', () => {
    expect(desiredParentUnit('default')).toBe('podium.service')
    expect(desiredParentUnit('blue')).toBe('podium-blue.service')
    expect(leftoverParentUnit('default')).toBe('podium-parent.service')
    expect(leftoverParentUnit('blue')).toBe('podium-blue-parent.service')
  })
})

describe('parent children for mode', () => {
  it('daemon-only parent supervises only the daemon', () => {
    expect(parentChildrenForMode('daemon')).toEqual(['daemon'])
    expect(parentChildrenForMode('server')).toEqual(['server'])
    expect(parentChildrenForMode('all-in-one')).toEqual(['server', 'daemon'])
  })
})

describe('legacy unit sets', () => {
  it('a 3-unit VPS has server/janitor/daemon among the names it will shed', () => {
    expect(legacyUnitNames('default')).toEqual(
      expect.arrayContaining([
        'podium-parent.service',
        'podium-server.service',
        'podium-janitor.service',
        'podium-daemon.service',
      ]),
    )
  })

  it('a dev host sheds all 8 legacy definitions', () => {
    expect(devLegacyDefinitions('default')).toEqual([
      'podium-server.service',
      'podium-janitor.service',
      'podium-daemon.service',
      'podium-redeploy.service',
      'podium-health.service',
      'podium-health.timer',
      'podium-backend.service',
      'podium-daemon-system.service',
    ])
    expect(devLegacyDefinitions('default')).toHaveLength(8)
  })
})

describe('cannot-restart is the expected pre-migration state', () => {
  it('a 3-unit VPS honestly cannot restart, and that does not abort the plan', () => {
    const obs = legacyVpsObservation()
    expect(obs.cannotRestart).toBe(true)
    expect(planMigration(obs)).toEqual({ type: 'write-parent' })
    expect(armedIfKilled(obs)).toBe('legacy')
  })
})

describe('foreground keeps the cannot-restart refusal', () => {
  it('unmanaged persistence never writes units', () => {
    const obs: TopologyObservation = {
      ...legacyVpsObservation(),
      persistence: 'unmanaged',
      installedUnits: [],
      enabledUnits: [],
      activeUnits: [],
      liveRoles: ['all-in-one'],
    }
    expect(planMigration(obs)).toEqual({ type: 'refuse-foreground' })
    expect(applyAction(obs, { type: 'refuse-foreground' })).toEqual(obs)
  })
})

describe('converged install is a no-op', () => {
  it('re-running boot reconciliation on a one-unit host does nothing', () => {
    const obs = convergedObservation()
    expect(planMigration(obs)).toEqual({ type: 'noop' })
    expect(armedIfKilled(obs)).toBe('new')
  })
})

describe('3-unit VPS happy path', () => {
  it('ends with exactly podium.service armed and every legacy unit gone', () => {
    const { obs, steps } = walkUntil(
      legacyVpsObservation(),
      (_obs, action) => action.type === 'noop',
      (obs, action) => {
        if (action.type === 'await-healthy') return { ...obs, parentHealthy: true }
        return obs
      },
    )
    expect(steps.map((s) => s.type)).toEqual([
      'write-parent',
      'enable-parent',
      'mask-legacy',
      'start-parent',
      'await-healthy',
      'retire-legacy',
      'noop',
    ])
    expect(obs.installedUnits).toEqual(['podium.service'])
    expect(obs.enabledUnits).toEqual(['podium.service'])
    expect(obs.installedUnits).not.toEqual(
      expect.arrayContaining([
        'podium-server.service',
        'podium-janitor.service',
        'podium-daemon.service',
      ]),
    )
    expect(armedIfKilled(obs)).toBe('new')
    expect(obs.cannotRestart).toBe(false)
  })
})

describe('the legacy janitor unit is retired, not inherited (PDM-27)', () => {
  // Nothing renders a janitor unit any more: every server hosts the janitor as
  // a worker thread. An install that already HAS one must still be walked off
  // it, and this is the assertion that the migration — the only code left that
  // knows the name — does that, on the default and on a named instance.
  for (const instanceId of ['default', 'blue']) {
    const unit =
      instanceId === 'default' ? 'podium-janitor.service' : `podium-${instanceId}-janitor.service`

    it(`masks then stops and disables ${unit} before the parent takes over`, () => {
      const masked = walkUntil(
        legacyVpsObservation(instanceId),
        (_obs, action) => action.type === 'start-parent',
      )
      // Mask first: `Restart=always` on the legacy units would otherwise fight
      // the new parent's takeover bind.
      expect(masked.obs.maskedUnits).toContain(unit)
      expect(masked.obs.installedUnits).toContain(unit)

      const { obs, steps } = walkUntil(
        legacyVpsObservation(instanceId),
        (_obs, action) => action.type === 'noop',
        (next, action) =>
          action.type === 'await-healthy' ? { ...next, parentHealthy: true } : next,
      )
      expect(steps.map((s) => s.type)).toContain('retire-legacy')
      expect(obs.installedUnits).not.toContain(unit)
      expect(obs.enabledUnits).not.toContain(unit)
      // …and a kill here reboots into the parent alone, never back into a
      // second janitor beside the server's own.
      expect(armedIfKilled(reboot(obs))).toBe('new')
      expect(reboot(obs).liveRoles).not.toContain('janitor')
    })
  }

  it('a detached install reclaims the leftover janitor PROCESS the same way', () => {
    const { obs, steps } = walkUntil(
      {
        ...legacyVpsObservation(),
        persistence: 'detached',
        installedUnits: [],
        enabledUnits: [],
        activeUnits: [],
      },
      (_obs, action) => action.type === 'noop',
    )
    expect(steps.map((s) => s.type)).toEqual(['spawn-detached-parent', 'noop'])
    expect(obs.liveRoles).not.toContain('janitor')
  })
})

describe('dev host sheds all 8 definitions', () => {
  it('retire-legacy removes every extra unit the renderer used to emit', () => {
    const { obs } = walkUntil(
      legacyDevObservation(),
      (_obs, action) => action.type === 'noop',
      (obs, action) => {
        if (action.type === 'await-healthy') return { ...obs, parentHealthy: true }
        return obs
      },
    )
    expect(obs.installedUnits).toEqual(['podium.service'])
    for (const name of devLegacyDefinitions()) {
      expect(obs.installedUnits).not.toContain(name)
      expect(obs.enabledUnits).not.toContain(name)
    }
  })
})

describe('kill at each transition state — never neither', () => {
  const phases: Array<{ after: MigrationAction['type']; healthy?: boolean; timeout?: boolean }> = [
    { after: 'write-parent' },
    { after: 'enable-parent' },
    { after: 'mask-legacy' },
    { after: 'start-parent' },
    { after: 'await-healthy' },
    { after: 'retire-legacy', healthy: true },
  ]

  it.each(phases)('killing after $after leaves an armed topology', ({ after, healthy }) => {
    const { obs } = walkUntil(
      legacyVpsObservation(),
      (_obs, action) => action.type === after,
      (next, action) => {
        if (healthy && action.type === 'await-healthy') return { ...next, parentHealthy: true }
        return next
      },
    )
    const applied = applyAction(obs, planMigration(obs))
    const armed = armedIfKilled(applied)
    expect(armed, `armed after ${after}`).not.toBe('neither')
    expect(['legacy', 'new', 'both']).toContain(armed)

    const afterReboot = reboot(applied)
    const rebootArmed = armedIfKilled(afterReboot)
    expect(rebootArmed, `reboot armed after ${after}`).not.toBe('neither')
    expect(['legacy', 'new', 'both']).toContain(rebootArmed)
  })

  it('killing after health timeout aborts onto fully-armed legacy, not neither', () => {
    const { obs } = walkUntil(
      legacyVpsObservation(),
      (_o, action) => action.type === 'await-healthy',
    )
    const timedOut: TopologyObservation = { ...obs, healthTimedOut: true, parentHealthy: false }
    expect(planMigration(timedOut).type).toBe('abort-keep-legacy')
    const aborted = applyAction(timedOut, planMigration(timedOut))
    expect(armedIfKilled(aborted)).toBe('legacy')
    expect(aborted.parentUnitEnabled).toBe(false)
    expect(aborted.enabledUnits).toEqual(
      expect.arrayContaining([
        'podium-server.service',
        'podium-janitor.service',
        'podium-daemon.service',
      ]),
    )
    expect(armedIfKilled(reboot(aborted))).toBe('legacy')
  })
})

describe('health gate does not depend on the old topology restarting', () => {
  it('retire-legacy is offered only once the NEW parent is healthy, even if cannotRestart was true at the start', () => {
    let obs = legacyVpsObservation()
    expect(obs.cannotRestart).toBe(true)
    const steps: string[] = []
    for (let i = 0; i < 10; i++) {
      const action = planMigration(obs)
      steps.push(action.type)
      if (action.type === 'await-healthy') {
        expect(obs.parentProcessLive).toBe(true)
        expect(obs.cannotRestart).toBe(false)
        obs = { ...obs, parentHealthy: true }
        continue
      }
      if (action.type === 'noop') break
      obs = applyAction(obs, action)
    }
    expect(steps).toContain('retire-legacy')
    expect(steps.indexOf('retire-legacy')).toBeGreaterThan(steps.indexOf('await-healthy'))
  })
})

describe('detached installs converge to the parent without units', () => {
  it('spawns the parent over the run-registry trio', () => {
    const obs: TopologyObservation = {
      persistence: 'detached',
      mode: 'all-in-one',
      instanceId: 'default',
      parentUnitPresent: false,
      parentUnitEnabled: false,
      parentUnitActive: false,
      parentProcessLive: false,
      parentHealthy: false,
      cannotRestart: true,
      installedUnits: [],
      enabledUnits: [],
      activeUnits: [],
      maskedUnits: [],
      liveRoles: ['server', 'janitor', 'daemon'],
    }
    expect(planMigration(obs)).toEqual({ type: 'spawn-detached-parent' })
    const next = applyAction(obs, { type: 'spawn-detached-parent' })
    expect(next.parentProcessLive).toBe(true)
    expect(next.liveRoles).toContain('parent')
    expect(next.liveRoles).not.toContain('janitor')
    expect(next.installedUnits).toEqual([])
    expect(armedIfKilled(next)).toBe('new')
    expect(planMigration(next)).toEqual({ type: 'noop' })
  })

  it('reclaims a leftover janitor once the parent is live', () => {
    const obs: TopologyObservation = {
      persistence: 'detached',
      mode: 'all-in-one',
      instanceId: 'default',
      parentUnitPresent: false,
      parentUnitEnabled: false,
      parentUnitActive: false,
      parentProcessLive: true,
      parentHealthy: true,
      cannotRestart: false,
      installedUnits: [],
      enabledUnits: [],
      activeUnits: [],
      maskedUnits: [],
      liveRoles: ['parent', 'server', 'janitor', 'daemon'],
    }
    expect(planMigration(obs)).toEqual({ type: 'reclaim-stale-roles' })
  })
})

describe('daemon-only join converges to the parent', () => {
  it('writes podium.service and retires the legacy daemon unit', () => {
    const start: TopologyObservation = {
      persistence: 'systemd',
      mode: 'daemon',
      instanceId: 'default',
      parentUnitPresent: false,
      parentUnitEnabled: false,
      parentUnitActive: false,
      parentProcessLive: false,
      parentHealthy: false,
      cannotRestart: true,
      installedUnits: ['podium-daemon.service'],
      enabledUnits: ['podium-daemon.service'],
      activeUnits: ['podium-daemon.service'],
      maskedUnits: [],
      liveRoles: ['daemon'],
    }
    const { obs } = walkUntil(
      start,
      (_o, action) => action.type === 'noop',
      (next, action) => {
        if (action.type === 'await-healthy') return { ...next, parentHealthy: true }
        return next
      },
    )
    expect(obs.installedUnits).toEqual(['podium.service'])
    expect(obs.enabledUnits).toEqual(['podium.service'])
    expect(obs.installedUnits).not.toContain('podium-daemon.service')
  })
})

describe('POD-2505 leftover parent unit is retired', () => {
  it('a host that wrote podium-parent.service still converges to podium.service', () => {
    const start: TopologyObservation = {
      ...legacyVpsObservation(),
      installedUnits: [
        'podium-parent.service',
        'podium-server.service',
        'podium-janitor.service',
        'podium-daemon.service',
      ],
      enabledUnits: [
        'podium-parent.service',
        'podium-server.service',
        'podium-janitor.service',
        'podium-daemon.service',
      ],
    }
    const { obs } = walkUntil(
      start,
      (_o, action) => action.type === 'noop',
      (next, action) => {
        if (action.type === 'await-healthy') return { ...next, parentHealthy: true }
        return next
      },
    )
    expect(obs.installedUnits).toEqual(['podium.service'])
    expect(obs.installedUnits).not.toContain('podium-parent.service')
  })
})

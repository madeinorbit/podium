export const MOBILE_HOME = '/work' as const

export const MOBILE_TABS = [
  { name: 'work', title: 'Work' },
  { name: 'issues', title: 'Tasks' },
  { name: 'superagent', title: 'Super' },
  // Pulse is LAST on purpose [POD-662]: it is the only tab you visit to decide
  // something rather than to do something, and the three that carry the work
  // keep the thumb-side positions.
  { name: 'pulse', title: 'Pulse' },
] as const

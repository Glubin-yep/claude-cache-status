import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'cache-status',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// Two hours before the 5-hour window resets.
const NOW = 1794402738000 - 2 * 60 * 60 * 1000

const LINE = JSON.stringify({
  timestamp: '2026-11-11T10:22:41.471Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 51.0, window_minutes: 300, resets_at: 1794402738 },
      secondary: { used_percent: 44.0, window_minutes: 10080, resets_at: 1794594812 },
      plan_type: 'plus',
    },
  },
})

const HOME = 'C:\\u\\.codex'
const S = `${HOME}\\sessions`
const NEWEST = 'rollout-2026-11-11T11-33-10-new.jsonl'
const file = (name: string, mtimeMs: number) => ({ name, kind: 'file', size: 1000, mtimeMs, isLink: false })
const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const TREE: Record<string, unknown[]> = {
  [S]: [dir('2026')],
  [`${S}\\2026`]: [dir('10'), dir('11')],
  [`${S}\\2026\\11`]: [dir('10'), dir('11')],
  [`${S}\\2026\\10`]: [dir('31')],
  [`${S}\\2026\\11\\11`]: [file('rollout-2026-11-11T09-00-00-old.jsonl', NOW - 9e6), file(NEWEST, NOW - 1000)],
  [`${S}\\2026\\11\\10`]: [file('rollout-2026-11-10T09-00-00-older.jsonl', NOW - 9e7)],
}

const CACHE = { hit: 95, read: 90000, written: 1000, at: NOW - 60000 }

function engine(on: any, reads: string[]) {
  on('command.register', () => ({ value: { command: 'cache' } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { context: {}, rateLimits: [], cost: null } }))
  on('clock.now', () => ({ value: NOW }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${HOME}\r\n`, stderr: '' } }))
  on('fs.list', (_: any, e: any) => ({ value: TREE[e.path] ?? [] }))
  on('fs.read', (_: any, e: any) => {
    reads.push(e.path)
    return { value: `{"type":"session_meta"}\n${LINE}\n{"type":"other"}\n` }
  })
  on('state.get', ($: any, e: any, next: any) => {
    if (e.key === 'info') return { value: { value: CACHE, version: 1 } }
    return next(e)
  })
}

test('Codex limits are read from the newest rollout and drawn', async ($, on) => {
  const reads: string[] = []
  engine(on, reads)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Let the reader started by session.start finish.
  await new Promise(r => setTimeout(r, 50))

  expect(reads).toEqual([`${S}\\2026\\11\\11\\${NEWEST}`])

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const alt = String((await desk.find({ type: 'Svg' }))?.props.alt)
  expect(alt).toContain('CODEX 5H 51%')
  expect(alt).toContain('CODEX WEEK 44%')
  await desk.unmount()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await term.press({ key: 'toggle' })
  expect((await term.find({ type: 'Text', text: /cx 5h/ }))?.text).toBe('cx 5h 51%')
  expect((await term.find({ type: 'Text', text: /cx week/ }))?.text).toBe('cx week 44%')
  await term.unmount()
})

test('a window past its reset shows 0%', async ($, on) => {
  const LATER = 1794402738000 + 60000
  on('state.get', ($, e, next) => {
    if (e.key === 'info') return { value: { value: { ...CACHE, at: LATER - 60000 }, version: 1 } }
    if (e.key === 'now') return { value: { value: LATER, version: 1 } }
    if (e.key === 'isCompact') return { value: { value: true, version: 1 } }
    if (e.key === 'codex') {
      return {
        value: {
          value: {
            primary: { percent: 51, windowMin: 300, resetsAt: 1794402738000 },
            secondary: { percent: 44, windowMin: 10080, resetsAt: 1794594812000 },
            plan: 'plus',
            at: 0,
          },
          version: 1,
        },
      }
    }
    return next(e)
  })

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /cx 5h/ }))?.text).toBe('cx 5h 0%')
  expect((await term.find({ type: 'Text', text: /cx week/ }))?.text).toBe('cx week 44%')
  await term.unmount()
})

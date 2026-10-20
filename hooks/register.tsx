import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CacheInfo, CtxInfo, LimitInfo, Totals } from '../types'

const TTL_MS = 60 * 60 * 1000
const HOT_MS = 10 * 60 * 1000
const COOLING_MS = 10 * 60 * 1000
const WARN_MS = 5 * 60 * 1000
const SPARK = '▁▂▃▄▅▆▇█'

// The SVG strip: one row of cells. It scales down to the band's width.
const STRIP_W = 760
const STRIP_H = 60

// SVG cannot read the theme; these are GitHub-dark tones (the user runs dark).
const HEX: Record<string, string> = {
  green: '#3fb950',
  yellow: '#d29922',
  red: '#f85149',
  cyan: '#39c5cf',
  magenta: '#db61a2',
  blue: '#58a6ff',
}
const INK = '#e6edf3'
const MUTED = '#8b949e'
const TRACK = 'rgba(139,148,158,0.22)'
const RULE = 'rgba(139,148,158,0.18)'
const FONT = "system-ui,-apple-system,'Segoe UI',sans-serif"

const info = atom({ plugin: 'cache-status', key: 'info' } as const, null)
const now = atom({ plugin: 'cache-status', key: 'now' } as const, 0)
const ctx = atom({ plugin: 'cache-status', key: 'ctx' } as const, null)
const hist = atom({ plugin: 'cache-status', key: 'hist' } as const, [])
const limits = atom({ plugin: 'cache-status', key: 'limits' } as const, [])
const totals = atom({ plugin: 'cache-status', key: 'totals' } as const, { read: 0, written: 0, cost: null })
const isCompact = atom({ plugin: 'cache-status', key: 'isCompact' } as const, false)
const isAlert = atom({ plugin: 'cache-status', key: 'isAlert' } as const, false)

// Module-local: reset on reload, which at worst repeats one toast.
let warnedFor = 0

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return `${n}`
}

function dur(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60000))
  if (m <= 60) return `${m}m`
  const hours = Math.floor(m / 60)
  if (hours < 24) return `${hours}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function clamp01(f: number) {
  return Math.max(0, Math.min(1, f))
}

function heat(pct: number) {
  return pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red'
}

function load(pct: number) {
  return pct < 50 ? 'green' : pct < 80 ? 'yellow' : 'red'
}

function limitShort(kind: string) {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  if (kind === 'spend_limit') return 'spend'
  return kind
}

function limitName(kind: string) {
  if (kind === 'five_hour') return '5-HOUR'
  if (kind === 'seven_day') return 'WEEKLY'
  if (kind === 'spend_limit') return 'SPEND'
  return kind.toUpperCase()
}

function cacheState(sinceMs: number) {
  const left = TTL_MS - sinceMs
  if (left <= 0) return { icon: '❄', label: 'cold', color: 'blue', left: 0 }
  if (sinceMs < HOT_MS) return { icon: '🔥', label: 'hot', color: 'magenta', left }
  if (left < COOLING_MS) return { icon: '⚠', label: 'cooling', color: 'yellow', left }
  return { icon: '●', label: 'warm', color: 'cyan', left }
}

type Meter = { kind: 'bar'; frac: number; color: string; marker: number | null } | { kind: 'spark'; values: number[] }

type Cell = { label: string; labelColor: string; value: string; valueColor: string; unit: string; meter: Meter }

function meterSvg(m: Meter, x: number, y: number, w: number) {
  if (m.kind === 'bar') {
    const fill = Math.round(clamp01(m.frac) * w)
    let s = `<rect x="${x}" y="${y}" width="${w}" height="4" rx="2" fill="${TRACK}"/>`
    if (fill > 0) s += `<rect x="${x}" y="${y}" width="${fill}" height="4" rx="2" fill="${HEX[m.color]}"/>`
    if (m.marker !== null) {
      const mx = x + Math.round(clamp01(m.marker) * w)
      s += `<rect x="${mx - 1}" y="${y - 3}" width="2" height="10" rx="1" fill="${MUTED}"/>`
    }
    return s
  }
  const n = 16
  const gap = 2
  const bw = (w - gap * (n - 1)) / n
  const h = 10
  const start = n - m.values.length
  let s = ''
  for (let i = 0; i < n; i++) {
    const v = i >= start ? m.values[i - start] : null
    const bh = v === null ? 2 : Math.max(2, Math.round((v / 100) * h))
    const fill = v === null ? TRACK : HEX[heat(v)]
    s += `<rect x="${(x + i * (bw + gap)).toFixed(1)}" y="${y + 4 - bh}" width="${bw.toFixed(1)}" height="${bh}" rx="1" fill="${fill}"/>`
  }
  return s
}

function stripSvg(cells: Cell[]) {
  const w = STRIP_W / cells.length
  const pad = 14
  let body = ''
  cells.forEach((c, i) => {
    const x = i * w
    if (i > 0) body += `<rect x="${x}" y="8" width="1" height="${STRIP_H - 16}" fill="${RULE}"/>`
    body +=
      `<text x="${x + pad}" y="17" font-size="10" font-weight="600" letter-spacing="0.8" fill="${c.labelColor}">${c.label}</text>` +
      `<text x="${x + pad}" y="40"><tspan font-size="20" font-weight="700" fill="${c.valueColor}">${c.value}</tspan>` +
      (c.unit === '' ? '' : `<tspan dx="6" font-size="11" fill="${MUTED}">${c.unit}</tspan>`) +
      `</text>` +
      meterSvg(c.meter, x + pad, 50, w - pad * 2)
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${STRIP_W}" height="${STRIP_H}" viewBox="0 0 ${STRIP_W} ${STRIP_H}" ` +
    `font-family="${FONT}">${body}</svg>`
  )
}

function buildCells(c: CacheInfo, t: number, alert: boolean, history: number[], x: CtxInfo | null, ls: LimitInfo[], tot: Totals) {
  const st = cacheState(Math.max(0, t - c.at))
  const cells: Cell[] = [
    {
      label: alert ? 'CACHE MISS' : 'CACHE HIT',
      labelColor: alert ? HEX.red : MUTED,
      value: `${c.hit}%`,
      valueColor: HEX[alert ? 'red' : heat(c.hit)],
      unit: `↓${fmt(c.read)} ↑${fmt(c.written)}`,
      meter: { kind: 'spark', values: history },
    },
    {
      label: 'CACHE TTL',
      labelColor: MUTED,
      value: st.left > 0 ? dur(st.left) : '0m',
      valueColor: HEX[st.color],
      unit: `${st.icon} ${st.label}`,
      meter: { kind: 'bar', frac: st.left / TTL_MS, color: st.color, marker: null },
    },
  ]
  if (x !== null) {
    cells.push({
      label: 'CONTEXT',
      labelColor: MUTED,
      value: `${x.percent}%`,
      valueColor: HEX[load(x.percent)],
      unit: x.compactAt === null ? `${fmt(x.tokens)}/${fmt(x.window)}` : `⇲ ${fmt(Math.max(0, x.compactAt - x.tokens))} left`,
      meter: { kind: 'bar', frac: x.percent / 100, color: load(x.percent), marker: x.compactAt === null ? null : x.compactAt / x.window },
    })
  }
  for (const l of ls) {
    cells.push({
      label: `${limitName(l.kind)} LIMIT`,
      labelColor: MUTED,
      value: `${Math.round(l.percent)}%`,
      valueColor: HEX[load(l.percent)],
      unit: l.resetsAt === null ? '' : `↻ ${dur(l.resetsAt - t)}`,
      meter: { kind: 'bar', frac: l.percent / 100, color: load(l.percent), marker: null },
    })
  }
  const cachedFrac = tot.read + tot.written > 0 ? tot.read / (tot.read + tot.written) : 0
  cells.push({
    label: 'SESSION',
    labelColor: MUTED,
    value: tot.cost === null ? '—' : `$${tot.cost.toFixed(2)}`,
    valueColor: INK,
    unit: `♻ ${fmt(tot.read)}`,
    meter: { kind: 'bar', frac: cachedFrac, color: 'green', marker: null },
  })
  return { cells, st }
}

async function refreshUsage($: any, withBreakdown: boolean) {
  const u = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined)
  const c = u.context
  if (c.tokens !== undefined) {
    const prev = await read($, ctx)
    let compactAt = prev ? prev.compactAt : null
    const b = c.breakdown
    if (b) {
      const buffer = b.categories
        .filter((k: any) => k.kind === 'buffer')
        .reduce((s: number, k: any) => s + k.tokens, 0)
      compactAt = buffer > 0 ? b.rawMaxTokens - buffer : null
    }
    const v: CtxInfo = { tokens: c.tokens, window: c.window, percent: c.percent ?? 0, compactAt }
    await update($, ctx, () => v)
  }
  const ls: LimitInfo[] = u.rateLimits.map((r: any) => ({
    kind: r.kind,
    percent: r.percentUsed,
    resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : null,
  }))
  await update($, limits, () => ls)
  const cost = u.cost ? u.cost.usd : null
  await update($, totals, t => ({ ...t, cost }))
}

async function tick($: any) {
  const t = await $.clock.now()
  await update($, now, () => t)
  await refreshUsage($, false)
  const c = await read($, info)
  if (c && warnedFor !== c.at) {
    const left = TTL_MS - (t - c.at)
    if (left > 0 && left < WARN_MS) {
      warnedFor = c.at
      $.ui.toast(`❄ Prompt cache cools in ${dur(left)}: the next request re-writes ~${fmt(c.read + c.written)} tokens`, {
        timeoutMs: 8000,
      })
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The first version wrote the status line; clear whatever it left there.
    $.ui.status(undefined)
    await $.command.register({ name: 'cache', description: 'Toggle the cache status band between full and compact' })
    $.clock.every(15000, () => tick($))
    return next(e)
  })

  on('command.run', { command: 'cache' }, async $ => {
    await update($, isCompact, v => !v)
    return { text: (await read($, isCompact)) ? 'Cache band: compact.' : 'Cache band: full.' }
  })

  // Per request on the main loop: a turn's summed usage re-counts the cached
  // prefix once per tool round-trip, and subagent turns would overwrite it.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = e.agentId === undefined ? r.usage : null
    if (u) {
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const hit = total > 0 ? Math.round((u.cache_read_input_tokens / total) * 100) : 0
      const prev = await read($, info)
      const t = await $.clock.now()
      const fresh: CacheInfo = { hit, read: u.cache_read_input_tokens, written: u.cache_creation_input_tokens, at: t }

      const isMiss = prev !== null && prev.hit >= 80 && hit < 50 && total > 10000
      if (isMiss) {
        $.ui.toast(`⚠ Prompt cache miss: ${hit}% hit, re-wrote ${fmt(u.cache_creation_input_tokens)} tokens`, {
          timeoutMs: 6000,
        })
      }
      await update($, isAlert, () => isMiss)
      await update($, info, () => fresh)
      await update($, hist, list => [...list, hit].slice(-16))
      await update($, totals, x => ({
        ...x,
        read: x.read + u.cache_read_input_tokens,
        written: x.written + u.cache_creation_input_tokens,
      }))
      await update($, now, () => t)
      await refreshUsage($, true)
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, info)
    if (e.props.hasSurvey || c === null) {
      return next(e)
    }
    const els: any = $.ui.resolve(e)
    const { Box, Text, Button, Svg } = els
    const t = await read($, now)
    const x = await read($, ctx)
    const history = await read($, hist)
    const ls = await read($, limits)
    const tot = await read($, totals)
    const compact = await read($, isCompact)
    const alert = await read($, isAlert)

    const { cells, st } = buildCells(c, t, alert, history, x, ls, tot)
    const toggle = <Button key="toggle" label={compact ? '▸' : '▾'} onPress={() => update($, isCompact, v => !v)} />

    if (Svg && !compact) {
      const alt = cells.map(k => `${k.label} ${k.value} ${k.unit}`).join(', ')
      return (
        <Box flexDirection="row" alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" flexGrow={1}>
            <Svg source={stripSvg(cells)} alt={alt} />
          </Box>
          {toggle}
        </Box>
      )
    }

    // One text line: compact mode, and the terminal (no Svg there).
    const hitColor = alert ? 'red' : heat(c.hit)
    const sep = (k: string) => (
      <Text key={k} dimColor>
        {'  ·  '}
      </Text>
    )
    return (
      <Box flexDirection="row" paddingX={1} justifyContent="space-between" alignItems="center">
        <Box flexDirection="row">
          <Text color={hitColor} bold>{`⚡ ${c.hit}%`}</Text>
          <Text> </Text>
          {history.map((v, i) => (
            <Text key={`s${i}`} color={heat(v)}>
              {SPARK[Math.min(SPARK.length - 1, Math.floor((v / 100) * SPARK.length))]}
            </Text>
          ))}
          {sep('a')}
          <Text color={st.color} bold>{`${st.icon} ${st.left > 0 ? dur(st.left) : 'cold'}`}</Text>
          {x !== null && sep('b')}
          {x !== null && <Text color={load(x.percent)} bold>{`ctx ${x.percent}%`}</Text>}
          {ls.map(l => (
            <Box key={l.kind} flexDirection="row">
              {sep(`l${l.kind}`)}
              <Text color={load(l.percent)} bold>{`${limitShort(l.kind)} ${Math.round(l.percent)}%`}</Text>
            </Box>
          ))}
          {tot.cost !== null && sep('c')}
          {tot.cost !== null && <Text color="green" bold>{`$${tot.cost.toFixed(2)}`}</Text>}
        </Box>
        {toggle}
      </Box>
    )
  })
}

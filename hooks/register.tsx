import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CacheInfo, CodexInfo, CodexWindow, CtxInfo, LimitInfo, Totals } from '../types'

const TTL_MS = 60 * 60 * 1000
const HOT_MS = 10 * 60 * 1000
const COOLING_MS = 10 * 60 * 1000
const WARN_MS = 5 * 60 * 1000
const SPARK = '▁▂▃▄▅▆▇█'

// The SVG strip: one row of cells. It scales down to the band's width.
const STRIP_MIN_W = 760
const CELL_W = 118
const STRIP_H = 60

// Codex writes a rate-limit snapshot into its session logs on every turn.
const CODEX_EVERY_MS = 60 * 1000
const CODEX_MARK = '"limit_id":"codex"'

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
const codex = atom({ plugin: 'cache-status', key: 'codex' } as const, null)

// Module-local: reset on reload, which at worst repeats one toast.
let warnedFor = 0
// Codex reader: its home (undefined until asked, null when there is none),
// the rollout last parsed, and when it last looked.
let codexHome: string | null | undefined
let codexSeen = ''
let codexCheckedAt = 0
let codexBusy = false

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

function windowName(min: number) {
  if (min === 300) return '5H'
  if (min === 10080) return 'WEEK'
  if (min > 0 && min % 1440 === 0) return `${min / 1440}D`
  if (min > 0 && min % 60 === 0) return `${min / 60}H`
  return `${min}M`
}

// A window whose reset time has passed is back at 0%, whatever the last
// snapshot said: Codex only writes a new one when it is used.
function codexWindow(w: CodexWindow, t: number) {
  const isReset = w.resetsAt !== null && w.resetsAt <= t
  return {
    name: windowName(w.windowMin),
    percent: isReset ? 0 : Math.round(w.percent),
    unit: isReset ? 'reset' : w.resetsAt === null ? '' : `↻ ${dur(w.resetsAt - t)}`,
  }
}

function codexWindows(cx: CodexInfo | null, t: number) {
  if (cx === null) return []
  return [cx.primary, cx.secondary].filter((w): w is CodexWindow => w !== null).map(w => codexWindow(w, t))
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
  const STRIP_W = Math.max(STRIP_MIN_W, cells.length * CELL_W)
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

function buildCells(
  c: CacheInfo,
  t: number,
  alert: boolean,
  history: number[],
  x: CtxInfo | null,
  ls: LimitInfo[],
  tot: Totals,
  cx: CodexInfo | null,
) {
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
  for (const w of codexWindows(cx, t)) {
    cells.push({
      label: `CODEX ${w.name}`,
      labelColor: MUTED,
      value: `${w.percent}%`,
      valueColor: HEX[load(w.percent)],
      unit: w.unit,
      meter: { kind: 'bar', frac: w.percent / 100, color: load(w.percent), marker: null },
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

// Runs the first command line that starts: pwsh, Windows PowerShell, then sh.
async function runFirst($: any, pwsh: string, posix: string[]): Promise<string | null> {
  const tries = [
    ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', pwsh],
    ['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', pwsh],
    posix,
  ]
  for (const argv of tries) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 20000 })
      return r.exitCode === 0 ? r.stdout : null
    } catch {
      // Not installed here: try the next one.
    }
  }
  return null
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

type Rollout = { path: string; mtimeMs: number; size: number }

// The newest rollout files under sessions/YYYY/MM/DD, newest first.
async function recentRollouts($: any, home: string): Promise<Rollout[]> {
  const sep = home.includes('\\') ? '\\' : '/'
  const join = (...parts: string[]) => parts.join(sep)
  const numbered = async (dir: string): Promise<string[]> => {
    const es: any[] = await $.fs.list(dir).catch(() => [])
    return es
      .filter(k => k.kind === 'dir' && /^\d+$/.test(k.name))
      .map(k => k.name)
      .sort()
      .reverse()
  }
  const root = join(home.replace(/[\\/]+$/, ''), 'sessions')
  const days: string[] = []
  for (const y of (await numbered(root)).slice(0, 2)) {
    for (const m of (await numbered(join(root, y))).slice(0, 2)) {
      for (const d of (await numbered(join(root, y, m))).slice(0, 2)) days.push(join(root, y, m, d))
    }
  }
  days.sort().reverse()
  const files: Rollout[] = []
  for (const dir of days.slice(0, 2)) {
    const es: any[] = await $.fs.list(dir).catch(() => [])
    for (const k of es) {
      if (k.kind === 'file' && k.name.startsWith('rollout-') && k.name.endsWith('.jsonl')) {
        files.push({ path: join(dir, k.name), mtimeMs: k.mtimeMs, size: k.size })
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 3)
}

// The last line of a rollout that carries a Codex rate-limit snapshot.
async function lastCodexLine($: any, f: Rollout): Promise<string | null> {
  if (f.size < 3.5 * 1024 * 1024) {
    const text: string = await $.fs.read(f.path).catch(() => '')
    const i = text.lastIndexOf(CODEX_MARK)
    if (i < 0) return null
    const start = text.lastIndexOf('\n', i) + 1
    const end = text.indexOf('\n', i)
    return text.slice(start, end < 0 ? text.length : end)
  }
  // Too big for one $.fs.read: read its last 4 MB (Get-Content -Tail crawls
  // on long lines), and scan the whole file only if that has no whole line.
  const p = psQuote(f.path)
  const m = psQuote(CODEX_MARK)
  const out = await runFirst(
    $,
    `$p = ${p}; $m = ${m}; $l = $null; ` +
      `$fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); ` +
      `try { $len = $fs.Length; $n = [int][Math]::Min($len, 4MB); [void]$fs.Seek(-$n, 'End'); ` +
      `$b = New-Object byte[] $n; $o = 0; while ($o -lt $n) { $r = $fs.Read($b, $o, $n - $o); if ($r -le 0) { break }; $o += $r }; ` +
      `$t = [Text.Encoding]::UTF8.GetString($b, 0, $o); $i = $t.LastIndexOf($m); ` +
      `if ($i -ge 0) { $s = $t.LastIndexOf([char]10, $i) + 1; $e = $t.IndexOf([char]10, $i); if ($e -lt 0) { $e = $t.Length }; ` +
      `if ($s -gt 0 -or $n -eq $len) { $l = $t.Substring($s, $e - $s) } } } finally { $fs.Close() }; ` +
      `if (-not $l) { foreach ($x in [IO.File]::ReadLines($p)) { if ($x.Contains($m)) { $l = $x } } }; $l`,
    ['sh', '-c', 'l=$(tail -n 400 "$1" | grep -F "$2" | tail -n 1); [ -n "$l" ] || l=$(grep -F "$2" "$1" | tail -n 1); printf %s "$l"', 'sh', f.path, CODEX_MARK],
  )
  const line = out?.trim() ?? ''
  return line === '' ? null : line
}

function parseCodex(line: string): CodexInfo | null {
  try {
    const ev = JSON.parse(line)
    const rl = ev?.payload?.rate_limits
    if (!rl) return null
    const at = Date.parse(ev.timestamp) || 0
    const win = (w: any): CodexWindow | null => {
      if (!w || typeof w.used_percent !== 'number') return null
      const resetsAt =
        typeof w.resets_at === 'number'
          ? w.resets_at * 1000
          : typeof w.resets_in_seconds === 'number' && at > 0
            ? at + w.resets_in_seconds * 1000
            : null
      return { percent: w.used_percent, windowMin: w.window_minutes ?? 0, resetsAt }
    }
    const v: CodexInfo = { primary: win(rl.primary), secondary: win(rl.secondary), plan: rl.plan_type ?? null, at }
    return v.primary === null && v.secondary === null ? null : v
  } catch {
    return null
  }
}

async function refreshCodex($: any, t: number) {
  if (codexBusy || t - codexCheckedAt < CODEX_EVERY_MS) return
  codexBusy = true
  codexCheckedAt = t
  try {
    if (codexHome === undefined) {
      const out = await runFirst(
        $,
        `if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }`,
        ['sh', '-c', 'printf %s "${CODEX_HOME:-$HOME/.codex}"'],
      )
      codexHome = out?.trim() || null
    }
    if (!codexHome) return
    const files = await recentRollouts($, codexHome)
    if (files.length === 0) return
    const seen = `${files[0].path}|${files[0].mtimeMs}`
    if (seen === codexSeen) return
    codexSeen = seen
    // A session that has not had a turn yet has no snapshot: fall back to the
    // next newest.
    for (const f of files) {
      const line = await lastCodexLine($, f)
      const v = line === null ? null : parseCodex(line)
      if (v !== null) {
        const prev = await read($, codex)
        if (prev === null || v.at >= prev.at) await update($, codex, () => v)
        return
      }
    }
  } catch {
    // Codex not installed or its logs unreadable: the band just leaves it out.
  } finally {
    codexBusy = false
  }
}

async function tick($: any) {
  const t = await $.clock.now()
  await update($, now, () => t)
  await refreshUsage($, false)
  await refreshCodex($, t)
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
    void $.clock.now().then((t: number) => refreshCodex($, t))
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
    const cx = await read($, codex)

    const { cells, st } = buildCells(c, t, alert, history, x, ls, tot, cx)
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
          {codexWindows(cx, t).map(w => (
            <Box key={`cx${w.name}`} flexDirection="row">
              {sep(`cx${w.name}`)}
              <Text color={load(w.percent)} bold>{`cx ${w.name.toLowerCase()} ${w.percent}%`}</Text>
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

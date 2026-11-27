// Reusable vector marks, Braun dual-needle DialGauge, and fail-closed CoverageDetails.

import { ADAPTERS, WALLET_ADAPTERS, BANK_ADAPTERS, DIAGNOSTIC_LABELS } from './constants.js'

export function FinTaxMark({ size = 16 }) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('rect', { x: 3.5, y: 4, width: 17, height: 16, rx: 2 }),
    h('path', { d: 'm6.8 14 3.7-3.5 3 2 4-5M7 17h10' }),
  )
}

export function Icon({ kind, size = 15 }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0 } }
  if (kind === 'book') return h('svg', p, h('path', { d: 'M3.5 4.5c3.4-1.1 6.1-.4 8.5 1.3 2.6-1.7 5-2.3 8.5-1.3v14c-2.9-.8-5.7-.5-8.5 1.4-2.8-1.9-5.6-2.2-8.5-1.4zM12 6v14' }))
  if (kind === 'upload') return h('svg', p, h('path', { d: 'M12 16V3m-4.5 4.5L12 3l4.5 4.5M4 14v6h16v-6' }))
  if (kind === 'download') return h('svg', p, h('path', { d: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4' }))
  if (kind === 'arrow') return h('svg', p, h('path', { d: 'M3 12h16m-6-6 6 6-6 6' }))
  if (kind === 'chip') return h('svg', p, h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }), h('rect', { x: 8, y: 8, width: 8, height: 8 }), h('path', { d: 'M8 2v2m8-2v2M8 20v2m8-2v2M2 8h2m-2 8h2m16-8h2m-2 8h2' }))
  if (kind === 'check') return h('svg', p, h('path', { d: 'm5 12 4 4L19 6' }))
  if (kind === 'search') return h('svg', p, h('circle', { cx: 11, cy: 11, r: 7 }), h('path', { d: 'm20 20-3.8-3.8' }))
  if (kind === 'calendar') return h('svg', p, h('rect', { x: 3.5, y: 5, width: 17, height: 15, rx: 2 }), h('path', { d: 'M8 3v4m8-4v4M3.5 10h17' }))
  if (kind === 'close') return h('svg', p, h('path', { d: 'M6 6l12 12M18 6 6 18' }))
  return h('svg', p, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 8v4l2.5 2' }))
}

/** Dieter Rams precision analog dial gauge (101 ticks, warning red arc, animated signal-orange needle). */
export function DialGauge({ code, title, pct, warnPct = 73.3, footNote, subNote }) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0))
  const cx = 119
  const cy = 102
  const rOuter = 82
  const startDeg = -109
  const sweepDeg = 218
  const toRad = (deg) => ((deg - 90) * Math.PI) / 180
  const pt = (deg, rad) => [cx + rad * Math.cos(toRad(deg)), cy + rad * Math.sin(toRad(deg))]

  const [sx, sy] = pt(startDeg, rOuter)
  const [ex, ey] = pt(startDeg + sweepDeg, rOuter)
  const warnDeg = startDeg + (warnPct / 100) * sweepDeg
  const [wx, wy] = pt(warnDeg, rOuter)
  const warnLargeArc = sweepDeg * (1 - warnPct / 100) > 180 ? 1 : 0

  const ticks = []
  for (let i = 0; i <= 100; i++) {
    const deg = startDeg + (i / 100) * sweepDeg
    const isMajor = i % 10 === 0
    const isMid = !isMajor && i % 5 === 0
    const r1 = rOuter - 4
    const r2 = r1 - (isMajor ? 11.5 : isMid ? 8.2 : 5.2)
    const [x1, y1] = pt(deg, r1)
    const [x2, y2] = pt(deg, r2)
    const inWarn = i >= warnPct
    ticks.push(
      h('line', {
        key: `t${i}`,
        x1: x1.toFixed(2),
        y1: y1.toFixed(2),
        x2: x2.toFixed(2),
        y2: y2.toFixed(2),
        className: inWarn ? 'ftx-tick-warn' : 'ftx-tick',
        strokeWidth: isMajor || isMid ? 1.3 : 0.8,
      }),
    )
  }

  const labels = [0, 20, 40, 60, 80, 100].map((v) => {
    const deg = startDeg + (v / 100) * sweepDeg
    const [lx, ly] = pt(deg, 57)
    return h('text', { key: `l${v}`, x: lx.toFixed(1), y: (ly + 3.2).toFixed(1), textAnchor: 'middle', fontSize: 9.2, className: 'ftx-dial-lbl' }, String(v))
  })

  const needleAngle = startDeg + (clamped / 100) * sweepDeg

  return h(
    'div',
    { className: 'ftx-gauge' },
    h('div', { className: 'ftx-ghead' }, h('span', null, code), title),
    h(
      'svg',
      { viewBox: '0 0 238 145', className: 'ftx-meter', role: 'img', 'aria-label': `${title} ${clamped.toFixed(2)}%` },
      h('path', { d: `M${sx.toFixed(2)} ${sy.toFixed(2)} A${rOuter} ${rOuter} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`, fill: 'none', className: 'ftx-arc-bg', strokeWidth: 1.1 }),
      h('path', { d: `M${wx.toFixed(2)} ${wy.toFixed(2)} A${rOuter} ${rOuter} 0 ${warnLargeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`, fill: 'none', className: 'ftx-arc-warn', strokeWidth: 2.4 }),
      ...ticks,
      ...labels,
      h(
        'g',
        { style: { transformOrigin: `${cx}px ${cy}px`, transform: `rotate(${needleAngle.toFixed(2)}deg)`, transition: 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)' } },
        h('path', { d: `M${cx - 1.5} ${cy + 10} L${cx - 1.8} ${cy - 2} L${cx} ${cy - 74} L${cx + 2.1} ${cy - 2} L${cx + 2} ${cy + 10} Z`, transform: 'translate(0.9 1.3)', fill: 'rgba(90,82,68,0.28)' }),
        h('path', { d: `M${cx - 2.3} ${cy + 12} L${cx - 1.7} ${cy - 2} L${cx} ${cy - 75} L${cx + 1.7} ${cy - 2} L${cx + 2.3} ${cy + 12} Z`, fill: 'var(--ftx-needle)' }),
      ),
      h('circle', { cx, cy, r: 7, fill: 'var(--ftx-cap-out)' }),
      h('circle', { cx, cy, r: 4, fill: 'var(--ftx-cap-in)' }),
      h('circle', { cx: cx - 1, cy: cy - 1, r: 1.2, fill: 'var(--ftx-cap-hi)' }),
    ),
    h('div', { className: 'ftx-gval', style: clamped >= warnPct ? { color: 'var(--ftx-orange)' } : undefined }, `${Number(pct || 0).toFixed(2)}%`),
    h('div', { className: 'ftx-gfoot' }, h('i', null, footNote), subNote ? ` · ${subNote}` : ''),
  )
}

export function CoverageDetails({ coverage }) {
  const index = (value) => Number.isSafeInteger(value) && value > 0
  const lines = []
  for (const file of coverage?.files || []) {
    if (file.status === 'parsed' || !index(file.fileIndex)) continue
    const diagnostics = file.diagnostics?.length ? file.diagnostics : [{ code: file.code }]
    for (const detail of diagnostics) {
      const location = [
        `第 ${file.fileIndex} 份账单`,
        index(detail.entryIndex) && `ZIP 条目 ${detail.entryIndex}`,
        index(detail.sheetIndex) && `工作表 ${detail.sheetIndex}`,
      ].filter(Boolean).join(' / ')
      const candidates = (detail.candidates || []).filter(
        (name) => ADAPTERS.includes(name) || WALLET_ADAPTERS.includes(name) || BANK_ADAPTERS.includes(name),
      )
      const rows = (detail.candidateRows || []).map((row) => (typeof row === 'number' ? row : row?.row)).filter(index)
      const label = DIAGNOSTIC_LABELS.get(detail.code) || '解析待核'
      lines.push(`${location} · ${label}${candidates.length ? `（${candidates.join('、')}）` : ''}${rows.length ? ` · 待核行 ${rows.join('、')}` : ''}`)
    }
  }
  if (!lines.length) return null
  return h(
    'details',
    { className: 'ftx-hist-text', style: { fontSize: 12, color: 'var(--ftx-gap-fg)' } },
    h('summary', { style: { cursor: 'pointer' } }, `查看 ${lines.length} 项解析待核位置`),
    h(
      'ul',
      { style: { margin: '5px 0', paddingInlineStart: 20, maxHeight: 160, overflowY: 'auto' } },
      ...lines.map((line, i) => h('li', { key: i }, line)),
    ),
  )
}

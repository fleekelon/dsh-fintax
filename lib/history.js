// dsh-fintax v0.7.0 本地脱敏体检快照归档与 12 个月滚动红线监控引擎。
// 隐私与护城河纪律：仅落盘脱敏后的月度汇总 KPI（销售额、费用、风险计数），
// 绝不保存任何原始订单明细、买家隐私或正式会计分录；权限 0o600，受 FINTAX_CONFIG_DIR 隔离。

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getImaConfigDir } from './ima.js'

const HISTORY_FILE = 'fintax_history.json'
const MAX_SNAPSHOTS = 120
const CLIFF_75M = 75_000_000
const CLIFF_75M_WARN = 55_000_000
const THRESHOLD_5M = 5_000_000
const THRESHOLD_5M_WARN = 4_000_000

const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100

export function getHistoryFilePath() {
  return join(getImaConfigDir(), HISTORY_FILE)
}

function normalizeMonth(raw) {
  const s = String(raw ?? '').trim()
  const m = s.match(/(\d{4})[-/.](\d{1,2})/)
  if (m) {
    const yr = Number(m[1])
    const mo = Number(m[2])
    if (yr >= 2015 && yr <= 2099 && mo >= 1 && mo <= 12) {
      return `${yr}-${String(mo).padStart(2, '0')}`
    }
  }
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function monthToOrdinal(ym) {
  const [y, m] = ym.split('-').map(Number)
  return y * 12 + (m - 1)
}

function ordinalToMonth(ord) {
  const y = Math.floor(ord / 12)
  const m = (ord % 12) + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

function safeNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? r2(n) : 0
}

function safeInt(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function sortHistory(list) {
  return [...list].sort((a, b) => {
    if (a.month !== b.month) return b.month.localeCompare(a.month)
    return String(b.savedAt || '').localeCompare(String(a.savedAt || ''))
  })
}

export function loadHistory() {
  const p = getHistoryFilePath()
  if (!existsSync(p)) return []
  try {
    const raw = readFileSync(p, 'utf8').trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : []
    return sortHistory(arr.filter((x) => x && typeof x === 'object' && x.id))
  } catch {
    return []
  }
}

function persistHistory(list) {
  const dir = getImaConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = getHistoryFilePath()
  const trimmed = sortHistory(list).slice(0, MAX_SNAPSHOTS)
  writeFileSync(p, JSON.stringify({ schema: 'dsh-fintax-history-v1', entries: trimmed }, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
  try { chmodSync(p, 0o600) } catch { /* Windows ACL 忽略 POSIX chmod 差异 */ }
  return trimmed
}

/**
 * 基于历史归档计算 12 个自然月的报送参考净额和金额指标，用于风险初筛。
 */
export function computeRolling12m(history = [], referenceMonth = '') {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      snapshotCount: 0,
      monthCount: 0,
      windowStart: '',
      windowEnd: '',
      totalGrossCny: 0,
      totalRefundCny: 0,
      totalNetSalesCny: 0,
      totalFeesCny: 0,
      totalPayoutCny: 0,
      totalP0: 0,
      totalP1: 0,
      cliff75mPct: 0,
      cliff75mRemainWan: 7500,
      cliff75mLevel: 'safe',
      cliff75mAlert: null,
      threshold5mPct: 0,
      threshold5mRemainWan: 500,
      threshold5mLevel: 'safe',
      monthlySeries: [],
    }
  }

  const endMonth = referenceMonth ? normalizeMonth(referenceMonth) : sortHistory(history)[0].month
  const endOrd = monthToOrdinal(endMonth)
  const startOrd = endOrd - 11
  const windowStart = ordinalToMonth(startOrd)
  const windowEnd = endMonth

  const byMonth = new Map()
  let snapshotCount = 0
  let totalGrossCny = 0
  let totalRefundCny = 0
  let totalNetSalesCny = 0
  let totalFeesCny = 0
  let totalPayoutCny = 0
  let totalP0 = 0
  let totalP1 = 0

  for (const item of history) {
    const mo = normalizeMonth(item.month)
    const ord = monthToOrdinal(mo)
    if (ord < startOrd || ord > endOrd) continue
    snapshotCount++
    const gross = safeNum(item.grossCny)
    const refund = safeNum(item.refundCny)
    const net = item.netSalesCny !== undefined ? safeNum(item.netSalesCny) : r2(gross - refund)
    const fees = safeNum(item.feesCny)
    const payout = safeNum(item.payoutCny)
    const p0 = safeInt(item.p0Count)
    const p1 = safeInt(item.p1Count)

    totalGrossCny += gross
    totalRefundCny += refund
    totalNetSalesCny += net
    totalFeesCny += fees
    totalPayoutCny += payout
    totalP0 += p0
    totalP1 += p1

    const cur = byMonth.get(mo) || { month: mo, grossCny: 0, netSalesCny: 0, feesCny: 0, payoutCny: 0, count: 0, p0Count: 0, p1Count: 0 }
    cur.grossCny = r2(cur.grossCny + gross)
    cur.netSalesCny = r2(cur.netSalesCny + net)
    cur.feesCny = r2(cur.feesCny + fees)
    cur.payoutCny = r2(cur.payoutCny + payout)
    cur.count++
    cur.p0Count += p0
    cur.p1Count += p1
    byMonth.set(mo, cur)
  }

  totalGrossCny = r2(totalGrossCny)
  totalRefundCny = r2(totalRefundCny)
  totalNetSalesCny = r2(totalNetSalesCny)
  totalFeesCny = r2(totalFeesCny)
  totalPayoutCny = r2(totalPayoutCny)

  const cliff75mPct = r2((totalNetSalesCny / CLIFF_75M) * 100)
  const cliff75mRemainWan = r2(Math.max(0, CLIFF_75M - totalNetSalesCny) / 10_000)
  const cliff75mLevel = totalNetSalesCny > CLIFF_75M ? 'danger' : totalNetSalesCny >= CLIFF_75M_WARN ? 'warn' : 'safe'
  const cliff75mAlert =
    cliff75mLevel === 'danger'
      ? `【滚动账单风险提示】${windowStart}~${windowEnd} 报送参考净额 ${totalNetSalesCny.toFixed(2)} 元超过 4% 假设下的 7,500 万元收入等值（${cliff75mPct}%）。请按主体和纳税年度核验应纳税所得额及小型微利条件。`
      : cliff75mLevel === 'warn'
        ? `【滚动账单风险提示】${windowStart}~${windowEnd} 报送参考净额为 4% 假设下 7,500 万元收入等值的 ${cliff75mPct}%。请按主体和纳税年度复核。`
        : null

  const threshold5mPct = r2((totalNetSalesCny / THRESHOLD_5M) * 100)
  const threshold5mRemainWan = r2(Math.max(0, THRESHOLD_5M - totalNetSalesCny) / 10_000)
  const threshold5mLevel = totalNetSalesCny > THRESHOLD_5M ? 'danger' : totalNetSalesCny >= THRESHOLD_5M_WARN ? 'warn' : 'safe'

  const monthlySeries = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))

  return {
    snapshotCount,
    monthCount: monthlySeries.length,
    windowStart,
    windowEnd,
    totalGrossCny,
    totalRefundCny,
    totalNetSalesCny,
    totalFeesCny,
    totalPayoutCny,
    totalP0,
    totalP1,
    cliff75mPct,
    cliff75mRemainWan,
    cliff75mLevel,
    cliff75mAlert,
    threshold5mPct,
    threshold5mRemainWan,
    threshold5mLevel,
    monthlySeries,
  }
}

export function saveSnapshot(input = {}) {
  const month = normalizeMonth(input.month || input.period)
  const grossCny = safeNum(input.grossCny)
  const refundCny = safeNum(input.refundCny)
  const netSalesCny = input.netSalesCny !== undefined ? safeNum(input.netSalesCny) : r2(grossCny - refundCny)
  // 拒绝零销售且无退款的空/纯结汇快照；允许存在有效销售或纯退款调整的月份入库
  if (grossCny <= 0 && refundCny <= 0 && netSalesCny <= 0) {
    throw new Error('保存快照失败：有效人民币销售额必须大于 0（请先完成人民币汇率折算）')
  }

  const label = String(input.label ?? '').trim().slice(0, 80) || `${month} 店铺账单体检`
  const platforms = Array.isArray(input.platforms)
    ? [...new Set(input.platforms.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 16)
    : []

  const dedupKey = `${month}|${label.toLowerCase()}|${[...platforms].sort().join(',')}`
  const existing = loadHistory()
  const dupIdx = existing.findIndex(
    (x) => `${x.month}|${String(x.label || '').trim().toLowerCase()}|${[...(x.platforms || [])].sort().join(',')}` === dedupKey,
  )

  const entry = {
    id: dupIdx >= 0 ? existing[dupIdx].id : `snap_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
    savedAt: new Date().toISOString(),
    month,
    label,
    platforms,
    sheetCount: safeInt(input.sheetCount || 1),
    rowCount: safeInt(input.rowCount),
    grossCny,
    refundCny,
    netSalesCny,
    feesCny: safeNum(input.feesCny),
    payoutCny: safeNum(input.payoutCny),
    declaredVatSalesCny: input.declaredVatSalesCny !== undefined && input.declaredVatSalesCny !== null && input.declaredVatSalesCny !== ''
      ? safeNum(input.declaredVatSalesCny)
      : null,
    p0Count: safeInt(input.p0Count),
    p1Count: safeInt(input.p1Count),
    p2Count: safeInt(input.p2Count),
  }

  const nextList = dupIdx >= 0 ? [entry, ...existing.filter((_, i) => i !== dupIdx)] : [entry, ...existing]
  const history = persistHistory(nextList)
  return { entry, deduplicated: dupIdx >= 0, history, rolling12m: computeRolling12m(history) }
}

export function deleteSnapshot(id) {
  const target = String(id ?? '').trim()
  if (!target) throw new Error('快照 id 不能为空')
  const cur = loadHistory()
  const next = cur.filter((x) => x.id !== target)
  const deleted = next.length !== cur.length
  const history = persistHistory(next)
  return { deleted, history, rolling12m: computeRolling12m(history) }
}

export function clearHistory() {
  const p = getHistoryFilePath()
  if (existsSync(p)) rmSync(p, { force: true })
  return { history: [], rolling12m: computeRolling12m([]) }
}

// dsh-fintax v0.7.0 本地脱敏体检快照归档与 12 个月滚动红线监控引擎。
// 隐私与护城河纪律：仅落盘脱敏后的月度汇总 KPI（销售额、费用、风险计数），
// 绝不保存任何原始订单明细、买家隐私或正式会计分录；权限 0o600，受 FINTAX_CONFIG_DIR 隔离。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

const UNCLAIMED_ENTITY = '待认领'
const VAT_TYPES = new Set(['small_scale', 'general', 'unknown'])
const CIT_MODES = new Set(['assessed_4pct', 'audit_actual', 'unknown'])

function normIdentityPart(v, fallback = '') {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ') || fallback
}

function buildSourceKey({ entityName, storeScope, month }) {
  return `${normIdentityPart(entityName, 'unclaimed')}|${normIdentityPart(storeScope, 'default')}|${normalizeMonth(month)}`
}

function hydrateEntry(raw) {
  const month = normalizeMonth(raw.month)
  const platforms = Array.isArray(raw.platforms)
    ? [...new Set(raw.platforms.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 16)
    : []
  const entityName = String(raw.entityName ?? '').trim().slice(0, 80) || UNCLAIMED_ENTITY
  const ownershipStatus = entityName === UNCLAIMED_ENTITY ? 'unclaimed' : 'claimed'
  const storeScope = String(raw.storeScope ?? '').trim().slice(0, 80) || (platforms.length ? [...platforms].sort().join('+') : '默认店铺')
  const vatTaxpayerType = VAT_TYPES.has(raw.vatTaxpayerType) ? raw.vatTaxpayerType : 'unknown'
  const citAssessedMode = CIT_MODES.has(raw.citAssessedMode) ? raw.citAssessedMode : 'unknown'
  const zeroSalesConfirmed = Boolean(raw.zeroSalesConfirmed)
  const sourceKey = String(raw.sourceKey || '').trim() || buildSourceKey({ entityName, storeScope, month })
  return {
    ...raw,
    month,
    platforms,
    entityName,
    ownershipStatus,
    storeScope,
    vatTaxpayerType,
    citAssessedMode,
    zeroSalesConfirmed,
    sourceKey,
  }
}

export function loadHistory() {
  const p = getHistoryFilePath()
  if (!existsSync(p)) return []
  try {
    const raw = readFileSync(p, 'utf8').trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : []
    return sortHistory(arr.filter((x) => x && typeof x === 'object' && x.id).map(hydrateEntry))
  } catch {
    return []
  }
}

function persistHistory(list) {
  const dir = getImaConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = getHistoryFilePath()
  const trimmed = sortHistory(list.map(hydrateEntry)).slice(0, MAX_SNAPSHOTS)
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify({ schema: 'dsh-fintax-history-v2', entries: trimmed }, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
  try { chmodSync(tmp, 0o600) } catch { /* Windows ACL 忽略 POSIX chmod 差异 */ }
  renameSync(tmp, p)
  try { chmodSync(p, 0o600) } catch { /* Windows ACL 忽略 POSIX chmod 差异 */ }
  return trimmed
}

/**
 * 基于历史归档计算 12 个自然月的报送参考净额与本纳税年度情景指标，支持按主体过滤隔离。
 */
export function computeRolling12m(history = [], refOrOpts = '') {
  const opts = typeof refOrOpts === 'string' ? { referenceMonth: refOrOpts } : (refOrOpts || {})
  const referenceMonth = String(opts.referenceMonth || '').trim()
  const filterEntity = String(opts.entityName || '').trim()

  const allEntries = Array.isArray(history) ? history.map(hydrateEntry) : []
  const entityCountMap = new Map()
  for (const item of allEntries) {
    entityCountMap.set(item.entityName, (entityCountMap.get(item.entityName) || 0) + 1)
  }
  const entities = [...entityCountMap.entries()].map(([name, count]) => ({
    name,
    count,
    unclaimed: name === UNCLAIMED_ENTITY,
  }))
  const scoped = filterEntity ? allEntries.filter((x) => x.entityName === filterEntity) : allEntries

  if (scoped.length === 0) {
    return {
      snapshotCount: 0,
      monthCount: 0,
      missingMonthsCount: 12,
      zeroSalesMonthsCount: 0,
      activeEntity: filterEntity || '',
      entities,
      windowStart: '',
      windowEnd: '',
      taxYear: '',
      taxYearMonthCount: 0,
      taxYearNetSalesCny: 0,
      taxYearCliff75mPct: 0,
      taxYearCliff75mRemainWan: 7500,
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

  const endMonth = referenceMonth ? normalizeMonth(referenceMonth) : sortHistory(scoped)[0].month
  const endOrd = monthToOrdinal(endMonth)
  const startOrd = endOrd - 11
  const windowStart = ordinalToMonth(startOrd)
  const windowEnd = endMonth
  const taxYear = endMonth.slice(0, 4)

  const byMonth = new Map()
  const taxYearMonths = new Set()
  let snapshotCount = 0
  let totalGrossCny = 0
  let totalRefundCny = 0
  let totalNetSalesCny = 0
  let totalFeesCny = 0
  let totalPayoutCny = 0
  let taxYearNetSalesCny = 0
  let totalP0 = 0
  let totalP1 = 0

  for (const item of scoped) {
    const mo = normalizeMonth(item.month)
    const ord = monthToOrdinal(mo)
    const gross = safeNum(item.grossCny)
    const refund = safeNum(item.refundCny)
    const net = item.netSalesCny !== undefined ? safeNum(item.netSalesCny) : r2(gross - refund)
    if (mo.startsWith(`${taxYear}-`) && ord <= endOrd) {
      taxYearNetSalesCny += net
      taxYearMonths.add(mo)
    }
    if (ord < startOrd || ord > endOrd) continue
    snapshotCount++
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

    const cur = byMonth.get(mo) || {
      month: mo, grossCny: 0, netSalesCny: 0, feesCny: 0, payoutCny: 0, count: 0, p0Count: 0, p1Count: 0, zeroSalesConfirmed: false,
    }
    cur.grossCny = r2(cur.grossCny + gross)
    cur.netSalesCny = r2(cur.netSalesCny + net)
    cur.feesCny = r2(cur.feesCny + fees)
    cur.payoutCny = r2(cur.payoutCny + payout)
    cur.count++
    cur.p0Count += p0
    cur.p1Count += p1
    if (item.zeroSalesConfirmed) cur.zeroSalesConfirmed = true
    byMonth.set(mo, cur)
  }

  totalGrossCny = r2(totalGrossCny)
  totalRefundCny = r2(totalRefundCny)
  totalNetSalesCny = r2(totalNetSalesCny)
  totalFeesCny = r2(totalFeesCny)
  totalPayoutCny = r2(totalPayoutCny)
  taxYearNetSalesCny = r2(taxYearNetSalesCny)

  const cliff75mPct = r2((totalNetSalesCny / CLIFF_75M) * 100)
  const cliff75mRemainWan = r2(Math.max(0, CLIFF_75M - totalNetSalesCny) / 10_000)
  const cliff75mLevel = totalNetSalesCny > CLIFF_75M ? 'danger' : totalNetSalesCny >= CLIFF_75M_WARN ? 'warn' : 'safe'
  const cliff75mAlert =
    cliff75mLevel === 'danger'
      ? `【滚动账单风险提示】${windowStart}~${windowEnd} 报送参考净额 ${totalNetSalesCny.toFixed(2)} 元超过 4% 假设下的 7,500 万元收入等值（${cliff75mPct}%）。请按主体和纳税年度核验应纳税所得额及小型微利条件。`
      : cliff75mLevel === 'warn'
        ? `【滚动账单风险提示】${windowStart}~${windowEnd} 报送参考净额为 4% 假设下 7,500 万元收入等值的 ${cliff75mPct}%。请按主体和纳税年度复核。`
        : null

  const taxYearCliff75mPct = r2((taxYearNetSalesCny / CLIFF_75M) * 100)
  const taxYearCliff75mRemainWan = r2(Math.max(0, CLIFF_75M - taxYearNetSalesCny) / 10_000)

  const threshold5mPct = r2((totalNetSalesCny / THRESHOLD_5M) * 100)
  const threshold5mRemainWan = r2(Math.max(0, THRESHOLD_5M - totalNetSalesCny) / 10_000)
  const threshold5mLevel = totalNetSalesCny > THRESHOLD_5M ? 'danger' : totalNetSalesCny >= THRESHOLD_5M_WARN ? 'warn' : 'safe'

  const monthlySeries = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
  const missingMonthsCount = Math.max(0, 12 - monthlySeries.length)
  const zeroSalesMonthsCount = monthlySeries.filter((m) => m.zeroSalesConfirmed && m.netSalesCny === 0).length

  return {
    snapshotCount,
    monthCount: monthlySeries.length,
    missingMonthsCount,
    zeroSalesMonthsCount,
    activeEntity: filterEntity || '',
    entities,
    windowStart,
    windowEnd,
    taxYear,
    taxYearMonthCount: taxYearMonths.size,
    taxYearNetSalesCny,
    taxYearCliff75mPct,
    taxYearCliff75mRemainWan,
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
  const zeroSalesConfirmed = Boolean(input.zeroSalesConfirmed)
  // 拒绝零销售且未勾选确认零收入的空/纯结汇快照；允许存在有效销售、纯退款调整或明确确认零收入月份入库
  if (!zeroSalesConfirmed && grossCny <= 0 && refundCny <= 0 && netSalesCny <= 0) {
    throw new Error('保存快照失败：有效人民币销售额必须大于 0（若本月确为零收入，请勾选“确认本月零收入”后再归档）')
  }

  const label = String(input.label ?? '').trim().slice(0, 80) || `${month} 店铺账单体检`
  const platforms = Array.isArray(input.platforms)
    ? [...new Set(input.platforms.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 16)
    : []
  const entityName = String(input.entityName ?? '').trim().slice(0, 80) || UNCLAIMED_ENTITY
  const storeScope = String(input.storeScope ?? '').trim().slice(0, 80) || (platforms.length ? [...platforms].sort().join('+') : '默认店铺')
  const vatTaxpayerType = VAT_TYPES.has(input.vatTaxpayerType) ? input.vatTaxpayerType : 'unknown'
  const citAssessedMode = CIT_MODES.has(input.citAssessedMode) ? input.citAssessedMode : 'unknown'
  const conflictMode = ['check', 'replace', 'append'].includes(input.conflictMode) ? input.conflictMode : 'replace'

  // 归档身份严格由【公司主体 + 店铺/范围 + 账期】决定，与可编辑显示备注 label 彻底解耦！
  const sourceKey = buildSourceKey({ entityName, storeScope, month })
  const existing = loadHistory()
  const dupIdx = existing.findIndex((x) => x.sourceKey === sourceKey)

  if (dupIdx >= 0 && conflictMode === 'check') {
    return {
      conflict: true,
      sourceKey,
      existing: existing[dupIdx],
      history: existing,
      rolling12m: computeRolling12m(existing, { entityName: entityName === UNCLAIMED_ENTITY ? '' : entityName }),
    }
  }

  const shouldReplace = dupIdx >= 0 && conflictMode === 'replace'
  const entry = hydrateEntry({
    id: shouldReplace ? existing[dupIdx].id : `snap_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
    savedAt: new Date().toISOString(),
    month,
    entityName,
    storeScope,
    vatTaxpayerType,
    citAssessedMode,
    zeroSalesConfirmed,
    sourceKey,
    importMode: conflictMode === 'append' ? 'append' : shouldReplace ? 'replace' : 'new',
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
  })

  const nextList = shouldReplace ? [entry, ...existing.filter((_, i) => i !== dupIdx)] : [entry, ...existing]
  const history = persistHistory(nextList)
  return {
    conflict: false,
    entry,
    deduplicated: shouldReplace,
    history,
    rolling12m: computeRolling12m(history),
  }
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

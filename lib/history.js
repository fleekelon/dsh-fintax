// dsh-fintax v0.7.0 本地脱敏体检快照归档与 12 个月滚动红线监控引擎。
// 隐私与护城河纪律：仅落盘脱敏后的月度汇总 KPI（销售额、费用、风险计数），
// 绝不保存任何原始订单明细、买家隐私或正式会计分录；权限 0o600，受 FINTAX_CONFIG_DIR 隔离。

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getImaConfigDir } from './ima.js'
import { LocalStoreError, readLocalJson, withLocalWriteLock, writeLocalJson } from './local_store.js'

const HISTORY_FILE = 'fintax_history.json'
const MAX_SNAPSHOTS = 10_000
const CLIFF_75M = 75_000_000
const CLIFF_75M_WARN = 55_000_000
const THRESHOLD_5M = 5_000_000
const THRESHOLD_5M_WARN = 4_000_000

const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100

export function getHistoryFilePath() {
  return join(getImaConfigDir(), HISTORY_FILE)
}

export class HistoryInputError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function normalizeMonth(value) {
  if (typeof value !== 'string' || !/^(?:201[5-9]|20[2-9][0-9])-(?:0[1-9]|1[0-2])$/.test(value)) {
    throw new HistoryInputError('INVALID_MONTH', '账期须为有效的 YYYY-MM。')
  }
  return value
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
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER / 100 ? r2(n) : 0
}

function safeInt(v) {
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
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
  return (typeof v === 'string' ? v.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') : '') || fallback
}

const PLATFORMS = ['Amazon', 'TikTok Shop', 'Temu', 'AliExpress', 'Shopee', 'Shopify', 'PayPal', 'Stripe', 'WorldFirst', 'Payoneer', 'Airwallex']
const PLATFORM_BY_KEY = new Map(PLATFORMS.map((platform) => [platform.toLowerCase(), platform]))
const CONFLICT_MODES = new Set(['check', 'replace', 'append'])
const IMPORT_MODES = new Set(['new', 'replace', 'append'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function buildSourceKey({ entityName, storeScope, month }) {
  return JSON.stringify([1, normIdentityPart(entityName), normIdentityPart(storeScope), month])
}

function textField(value) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 80) : ''
}

function migrateId(value) {
  if (typeof value !== 'string' || !value || value.length > 128) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  if (UUID.test(value)) return value.toLowerCase()
  const hash = createHash('sha256').update('dsh-fintax-history-id:' + value).digest('hex')
  return [hash.slice(0, 8), hash.slice(8, 12), '8' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-')
}

function hydrateEntry(raw) {
  const month = normalizeMonth(raw.month)
  const platforms = Array.isArray(raw.platforms)
    ? [...new Set(raw.platforms.map((value) => PLATFORM_BY_KEY.get(normIdentityPart(value))).filter(Boolean))]
    : []
  const entityName = textField(raw.entityName) || UNCLAIMED_ENTITY
  const storeScope = textField(raw.storeScope) || (platforms.length ? [...platforms].sort().join('+') : '默认店铺')
  const grossCny = safeNum(raw.grossCny)
  const refundCny = safeNum(raw.refundCny)
  const savedAtMs = typeof raw.savedAt === 'string' ? Date.parse(raw.savedAt) : NaN
  const savedAt = Number.isFinite(savedAtMs) ? new Date(savedAtMs).toISOString() : ''
  const id = raw.id === undefined ? undefined : migrateId(raw.id)
  const revision = typeof raw.revision === 'string' && UUID.test(raw.revision)
    ? raw.revision.toLowerCase()
    : id && migrateId('revision:' + id + savedAt)
  return {
    id,
    revision,
    month,
    savedAt,
    label: textField(raw.label) || `${month} 店铺账单体检`,
    platforms,
    entityName,
    ownershipStatus: entityName === UNCLAIMED_ENTITY ? 'unclaimed' : 'claimed',
    storeScope,
    vatTaxpayerType: VAT_TYPES.has(raw.vatTaxpayerType) ? raw.vatTaxpayerType : 'unknown',
    citAssessedMode: CIT_MODES.has(raw.citAssessedMode) ? raw.citAssessedMode : 'unknown',
    zeroSalesConfirmed: raw.zeroSalesConfirmed === true,
    sourceKey: buildSourceKey({ entityName, storeScope, month }),
    importMode: IMPORT_MODES.has(raw.importMode) ? raw.importMode : 'new',
    sheetCount: safeInt(raw.sheetCount ?? 1),
    rowCount: safeInt(raw.rowCount),
    grossCny,
    refundCny,
    netSalesCny: raw.netSalesCny === undefined ? r2(grossCny - refundCny) : safeNum(raw.netSalesCny),
    feesCny: safeNum(raw.feesCny),
    payoutCny: safeNum(raw.payoutCny),
    declaredVatSalesCny: raw.declaredVatSalesCny == null || raw.declaredVatSalesCny === '' ? null : safeNum(raw.declaredVatSalesCny),
    p0Count: safeInt(raw.p0Count),
    p1Count: safeInt(raw.p1Count),
    p2Count: safeInt(raw.p2Count),
  }
}

export function loadHistory() {
  const raw = readLocalJson(getHistoryFilePath())
  if (raw === undefined) return []
  const entries = Array.isArray(raw) ? raw : raw?.entries
  if (!Array.isArray(entries)) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  const ids = new Set()
  const history = entries.map((item) => {
    try {
      const entry = hydrateEntry(item)
      if (!entry.id || ids.has(entry.id)) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
      ids.add(entry.id)
      return entry
    } catch {
      throw new LocalStoreError('LOCAL_DATA_CORRUPT')
    }
  })
  return sortHistory(history)
}

function persistHistory(list) {
  const history = sortHistory(list)
  writeLocalJson(getHistoryFilePath(), { schema: 'dsh-fintax-history-v3', entries: history })
  return history
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
  const thresholdApplicable = Boolean(filterEntity && filterEntity !== UNCLAIMED_ENTITY && scoped.length)

  if (scoped.length === 0) {
    return {
      snapshotCount: 0,
      thresholdApplicable,
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
      taxYearCliff75mPct: null,
      taxYearCliff75mRemainWan: null,
      totalGrossCny: 0,
      totalRefundCny: 0,
      totalNetSalesCny: 0,
      totalFeesCny: 0,
      totalPayoutCny: 0,
      totalP0: 0,
      totalP1: 0,
      cliff75mPct: null,
      cliff75mRemainWan: null,
      cliff75mLevel: null,
      cliff75mAlert: null,
      threshold5mPct: null,
      threshold5mRemainWan: null,
      threshold5mLevel: null,
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
    thresholdApplicable,
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
    taxYearCliff75mPct: thresholdApplicable ? taxYearCliff75mPct : null,
    taxYearCliff75mRemainWan: thresholdApplicable ? taxYearCliff75mRemainWan : null,
    totalGrossCny,
    totalRefundCny,
    totalNetSalesCny,
    totalFeesCny,
    totalPayoutCny,
    totalP0,
    totalP1,
    cliff75mPct: thresholdApplicable ? cliff75mPct : null,
    cliff75mRemainWan: thresholdApplicable ? cliff75mRemainWan : null,
    cliff75mLevel: thresholdApplicable ? cliff75mLevel : null,
    cliff75mAlert: thresholdApplicable ? cliff75mAlert : null,
    threshold5mPct: thresholdApplicable ? threshold5mPct : null,
    threshold5mRemainWan: thresholdApplicable ? threshold5mRemainWan : null,
    threshold5mLevel: thresholdApplicable ? threshold5mLevel : null,
    monthlySeries,
  }
}

export function saveSnapshot(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HistoryInputError('INVALID_SNAPSHOT', '归档参数须为对象。')
  }
  const month = normalizeMonth(input.month ?? input.period)
  const conflictMode = input.conflictMode === undefined ? 'check' : input.conflictMode
  if (!CONFLICT_MODES.has(conflictMode)) throw new HistoryInputError('INVALID_CONFLICT_MODE', '归档冲突处理方式无效。')
  if (input.zeroSalesConfirmed !== undefined && typeof input.zeroSalesConfirmed !== 'boolean') {
    throw new HistoryInputError('INVALID_ZERO_CONFIRMATION', '零收入确认须为布尔值。')
  }
  if (conflictMode === 'replace' &&
      (typeof input.targetId !== 'string' || !UUID.test(input.targetId) ||
       typeof input.expectedRevision !== 'string' || !UUID.test(input.expectedRevision))) {
    throw new HistoryInputError('INVALID_REPLACE_TARGET', '替换归档需要指定原快照及其版本。')
  }
  const snapshot = hydrateEntry({
    month,
    grossCny: input.grossCny,
    refundCny: input.refundCny,
    netSalesCny: input.netSalesCny,
    zeroSalesConfirmed: input.zeroSalesConfirmed,
    label: input.label,
    platforms: input.platforms,
    entityName: input.entityName,
    storeScope: input.storeScope,
    vatTaxpayerType: input.vatTaxpayerType,
    citAssessedMode: input.citAssessedMode,
    sheetCount: input.sheetCount,
    rowCount: input.rowCount,
    feesCny: input.feesCny,
    payoutCny: input.payoutCny,
    declaredVatSalesCny: input.declaredVatSalesCny,
    p0Count: input.p0Count,
    p1Count: input.p1Count,
    p2Count: input.p2Count,
  })
  const zeroSales = snapshot.grossCny === 0 && snapshot.refundCny === 0 && snapshot.netSalesCny === 0
  if (zeroSales && !snapshot.zeroSalesConfirmed) {
    throw new HistoryInputError('SALES_EVIDENCE_REQUIRED', '归档需要有效销售或退款调整。若本月确为零收入，请先确认零收入。')
  }
  snapshot.zeroSalesConfirmed &&= zeroSales

  return withLocalWriteLock(getHistoryFilePath(), () => {
    const existing = loadHistory()
    const candidates = existing.filter((entry) => entry.sourceKey === snapshot.sourceKey)
    const toReplace = conflictMode === 'replace'
      ? candidates.find((entry) => entry.id === input.targetId.toLowerCase() && entry.revision === input.expectedRevision.toLowerCase())
      : undefined
    if ((conflictMode === 'check' && candidates.length) || (conflictMode === 'replace' && !toReplace)) {
      return { conflict: true, existing: candidates[0] ?? null, candidates }
    }
    if (!toReplace && existing.length >= MAX_SNAPSHOTS) {
      throw new HistoryInputError('HISTORY_CAPACITY', '归档已达容量上限，请先迁出或删除旧档。')
    }
    let id = toReplace?.id ?? randomUUID()
    while (!toReplace && existing.some((item) => item.id === id)) id = randomUUID()
    const entry = {
      ...snapshot,
      id,
      revision: randomUUID(),
      savedAt: new Date().toISOString(),
      importMode: conflictMode === 'append' ? 'append' : toReplace ? 'replace' : 'new',
    }
    const history = persistHistory([entry, ...existing.filter((item) => item.id !== entry.id)])
    return { conflict: false, entry, deduplicated: Boolean(toReplace), history, rolling12m: computeRolling12m(history) }
  })
}

export function deleteSnapshot(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new HistoryInputError('INVALID_SNAPSHOT_ID', '归档快照 ID 无效。')
  return withLocalWriteLock(getHistoryFilePath(), () => {
    const current = loadHistory()
    const next = current.filter((entry) => entry.id !== id.toLowerCase())
    const deleted = next.length !== current.length
    const history = deleted ? persistHistory(next) : current
    return { deleted, history, rolling12m: computeRolling12m(history) }
  })
}

export function clearHistory() {
  const path = getHistoryFilePath()
  return withLocalWriteLock(path, () => {
    loadHistory()
    rmSync(path, { force: true })
    return { history: [], rolling12m: computeRolling12m([]) }
  })
}

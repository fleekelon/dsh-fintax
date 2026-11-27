// dsh-fintax v0.9.0 本地脱敏体检快照归档、12 个月滚动红线与自然年 Q1–Q4 汇总引擎（schema v4，向后兼容 v1–v3）。
// 隐私与护城河纪律：仅落盘脱敏后的月度汇总 KPI（销售额、费用、资金阶段汇总、风险计数），
// 绝不保存任何原始订单明细、买家隐私、Excel 母表公式或正式会计分录；权限 0o600，受 FINTAX_CONFIG_DIR 隔离。

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { getImaConfigDir } from './ima.js'
import { LocalStoreError, readLocalJson, withLocalWriteLock, writeLocalJson } from './local_store.js'

export const HISTORY_SCHEMA = 'dsh-fintax-history-v4'
export const BACKUP_SCHEMA = 'dsh-fintax-backup-v1'

const HISTORY_FILE = 'fintax_history.json'
const MAX_SNAPSHOTS = 10_000
const CLIFF_75M = 75_000_000
const CLIFF_75M_WARN = 55_000_000
const THRESHOLD_5M = 5_000_000
const THRESHOLD_5M_WARN = 4_000_000
const DAC7_EUR_THRESHOLD = 2_000
const DAC7_TXN_THRESHOLD = 30
const IRS_1099K_USD_THRESHOLD = 20_000
const IRS_1099K_TXN_THRESHOLD = 200
const IRS_1099K_STATE_MIN_USD = 600
const DEFAULT_USD_TO_CNY = 7.2
const DEFAULT_EUR_TO_CNY = 7.8

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

export function createHistoryStore({ filePath, dir } = {}) {
  const resolvePath = () => filePath || (dir ? join(dir, HISTORY_FILE) : getHistoryFilePath())
  return {
    get filePath() { return resolvePath() },
    load: () => loadHistoryFromPath(resolvePath()),
    save: (entries) => withLocalWriteLock(resolvePath(), () => persistHistoryToPath(resolvePath(), entries)),
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

function safeNullableNum(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER / 100 ? r2(n) : null
}

function safeInt(v) {
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

function safeNullableInt(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

function sortHistory(list) {
  return [...list].sort((a, b) => {
    if (a.month !== b.month) return b.month.localeCompare(a.month)
    return String(b.savedAt || '').localeCompare(String(a.savedAt || ''))
  })
}

const UNCLAIMED_ENTITY = '待认领'
const UNCLAIMED_ENTITY_KEY = 'unclaimed'
const VAT_TYPES = new Set(['small_scale', 'general', 'unknown'])
const CIT_MODES = new Set(['assessed_4pct', 'audit_actual', 'unknown'])

function normIdentityPart(v, fallback = '') {
  return (typeof v === 'string' ? v.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') : '') || fallback
}

const PLATFORMS = [
  'Amazon', 'TikTok Shop', 'Temu', 'AliExpress', 'Shopee', 'Shopify', 'PayPal', 'Stripe',
  'WorldFirst', 'Payoneer', 'Airwallex',
  'SHEIN', 'Walmart', 'Lazada', 'LianLian', 'PingPong', 'Sunrate',
]
const PLATFORM_BY_KEY = new Map([
  ...PLATFORMS.map((platform) => [platform.toLowerCase(), platform]),
  ['tiktok', 'TikTok Shop'],
  ['速卖通', 'AliExpress'],
  ['万里汇', 'WorldFirst'],
  ['派安盈', 'Payoneer'],
  ['空中云汇', 'Airwallex'],
  ['lianlian global', 'LianLian'],
  ['连连国际', 'LianLian'],
  ['连连', 'LianLian'],
  ['寻汇', 'Sunrate'],
])

const EU_DAC7_SITES = new Set([
  'EU', 'EUROPE', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'IE', 'AT', 'PT',
  'FI', 'DK', 'CZ', 'RO', 'HU', 'GR', 'SK', 'BG', 'HR', 'LT', 'SI', 'LV', 'EE', 'CY', 'LU', 'MT',
])
const US_SITES = new Set(['US', 'USA', 'NA'])
const VALID_SITE_RE = /^(?:[A-Z]{2,3}|EUROPE|DTC|GLOBAL)$/
const VALID_CURRENCY_RE = /^[A-Z]{3}$/

const STAGE3_STATUSES = new Set(['matched', 'partial', 'candidate_only', 'pending_bank_receipt'])
const CURRENCY_SOURCES = new Set(['recorded_orig', 'mixed_estimated', 'estimated_from_cny'])
const WALLET_PLATFORMS = new Set(['WorldFirst', 'Payoneer', 'Airwallex', 'LianLian', 'PingPong', 'Sunrate'])
const CONFLICT_MODES = new Set(['check', 'replace', 'append'])
const IMPORT_MODES = new Set(['new', 'replace', 'append'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assertNoPrototypePollution(value, code = 'UNSAFE_OBJECT_KEYS', depth = 0) {
  if (depth > 16) throw new HistoryInputError(code, '输入对象嵌套层数超限，已拒绝处理。')
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrototypePollution(item, code, depth + 1)
    return
  }
  if (!isPlainObject(value)) {
    throw new HistoryInputError(code, '检测到非法对象原型，已拒绝处理。')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new HistoryInputError(code, '输入对象包含不被允许的 Symbol 键。')
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new HistoryInputError(code, `检测到被禁止的原型污染键（${key}），已拒绝处理。`)
    }
    assertNoPrototypePollution(value[key], code, depth + 1)
  }
}

function toWellFormedClean(input) {
  const s = String(input ?? '')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1]
        i++
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      out += s[i]
    }
  }
  return out
}

function sliceUtf16Safe(raw, maxLen) {
  const clean = toWellFormedClean(raw)
  if (maxLen <= 0) return ''
  if (clean.length <= maxLen) return clean
  let end = maxLen
  const lastCode = clean.charCodeAt(end - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end--
  return clean.slice(0, end)
}

function textField(value, maxLen = 80) {
  return typeof value === 'string' ? sliceUtf16Safe(value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim(), maxLen) : ''
}

function isUnclaimedMarker(value) {
  const n = normIdentityPart(textField(value))
  return !n || n === UNCLAIMED_ENTITY_KEY || n === normIdentityPart(UNCLAIMED_ENTITY)
}

function resolveEntityFields(raw = {}) {
  const explicitLabel = textField(raw.entityLabel ?? raw.entityName)
  const explicitKeyRaw = textField(raw.entityKey)
  if ((!explicitLabel || isUnclaimedMarker(explicitLabel)) && (!explicitKeyRaw || isUnclaimedMarker(explicitKeyRaw))) {
    return { entityKey: UNCLAIMED_ENTITY_KEY, entityLabel: UNCLAIMED_ENTITY, entityName: UNCLAIMED_ENTITY, ownershipStatus: 'unclaimed' }
  }
  const entityLabel = explicitLabel && !isUnclaimedMarker(explicitLabel) ? explicitLabel : explicitKeyRaw
  const entityKey = explicitKeyRaw && !isUnclaimedMarker(explicitKeyRaw)
    ? normIdentityPart(explicitKeyRaw)
    : normIdentityPart(entityLabel)
  return { entityKey, entityLabel, entityName: entityLabel, ownershipStatus: 'claimed' }
}

function resolveShopFields(raw = {}, platforms = []) {
  const explicitLabel = textField(raw.shopLabel ?? raw.storeScope)
  const explicitKeyRaw = textField(raw.shopKey)
  const fallbackLabel = platforms.length ? [...platforms].sort().join('+') : '默认店铺'
  const shopLabel = explicitLabel || explicitKeyRaw || fallbackLabel
  const shopKey = normIdentityPart(explicitKeyRaw || shopLabel, '默认店铺')
  return { shopKey, shopLabel, storeScope: shopLabel }
}

function buildSourceKey({ entityKey, entityName, shopKey, storeScope, month }) {
  const ek = entityKey
    ? (isUnclaimedMarker(entityKey) ? UNCLAIMED_ENTITY_KEY : normIdentityPart(entityKey))
    : (isUnclaimedMarker(entityName) ? UNCLAIMED_ENTITY_KEY : normIdentityPart(entityName))
  const sk = shopKey ? normIdentityPart(shopKey) : normIdentityPart(storeScope)
  return JSON.stringify([1, ek, sk, month])
}

function migrateId(value) {
  if (typeof value !== 'string') throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128 || /[\p{Cc}\p{Cf}]/u.test(trimmed)) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  if (UUID.test(trimmed)) return trimmed.toLowerCase()
  const hash = createHash('sha256').update('dsh-fintax-history-id:' + trimmed).digest('hex')
  return [hash.slice(0, 8), hash.slice(8, 12), '8' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-')
}

function sanitizeSites(rawSites, fallbackSite) {
  const input = Array.isArray(rawSites) ? rawSites : fallbackSite ? [fallbackSite] : []
  const out = new Set()
  for (const item of input) {
    if (typeof item !== 'string') continue
    const clean = item.trim().toUpperCase()
    if (VALID_SITE_RE.test(clean)) out.add(clean)
  }
  return [...out]
}

function sanitizeCurrencies(rawCurrencies, fallbackCurrency) {
  const input = Array.isArray(rawCurrencies) ? rawCurrencies : fallbackCurrency ? [fallbackCurrency] : []
  const out = new Set()
  for (const item of input) {
    if (typeof item !== 'string') continue
    const clean = item.trim().toUpperCase()
    if (VALID_CURRENCY_RE.test(clean)) out.add(clean)
  }
  return [...out]
}

function sanitizePlatformBreakdown(rawList) {
  if (!Array.isArray(rawList)) return []
  const out = []
  for (const item of rawList.slice(0, 64)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const platform = PLATFORM_BY_KEY.get(normIdentityPart(item.platform))
    if (!platform) continue
    const site = typeof item.site === 'string' && VALID_SITE_RE.test(item.site.trim().toUpperCase())
      ? item.site.trim().toUpperCase()
      : null
    const currency = typeof item.currency === 'string' && VALID_CURRENCY_RE.test(item.currency.trim().toUpperCase())
      ? item.currency.trim().toUpperCase()
      : null
    const grossCny = safeNum(item.grossCny)
    const refundCny = safeNum(item.refundCny)
    out.push({
      platform,
      site,
      currency,
      grossCny,
      refundCny,
      netSalesCny: item.netSalesCny === undefined ? r2(grossCny - refundCny) : safeNum(item.netSalesCny),
      feesCny: safeNum(item.feesCny),
      payoutCny: safeNum(item.payoutCny),
      grossOrig: safeNullableNum(item.grossOrig),
      transactionCount: safeNullableInt(item.transactionCount),
    })
  }
  return out
}

function sanitizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function sanitizeReassignedFrom(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const at = sanitizeIsoTimestamp(raw.at)
  if (!at) return null
  const overwrittenIds = Array.isArray(raw.overwrittenIds)
    ? raw.overwrittenIds.filter((id) => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase()).slice(0, 50)
    : []
  return {
    entityKey: normIdentityPart(textField(raw.entityKey), UNCLAIMED_ENTITY_KEY),
    entityLabel: textField(raw.entityLabel) || UNCLAIMED_ENTITY,
    shopKey: normIdentityPart(textField(raw.shopKey), '默认店铺'),
    shopLabel: textField(raw.shopLabel) || '默认店铺',
    at,
    ...(overwrittenIds.length ? { overwrittenIds } : {}),
  }
}

function hydrateEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  const month = normalizeMonth(raw.month ?? raw.period)
  const platforms = Array.isArray(raw.platforms)
    ? [...new Set(raw.platforms.map((value) => PLATFORM_BY_KEY.get(normIdentityPart(value))).filter(Boolean))]
    : []
  const entity = resolveEntityFields(raw)
  const shop = resolveShopFields(raw, platforms)
  const grossCny = safeNum(raw.grossCny)
  const refundCny = safeNum(raw.refundCny)
  const savedAt = sanitizeIsoTimestamp(raw.savedAt) || ''
  if (raw.id !== undefined && typeof raw.id !== 'string') throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  const rawIdTrimmed = typeof raw.id === 'string' ? raw.id.trim() : undefined
  const id = rawIdTrimmed === undefined ? undefined : migrateId(rawIdTrimmed)
  let explicitLegacyId
  if (raw.legacyId !== undefined && raw.legacyId !== null) {
    if (typeof raw.legacyId !== 'string') throw new LocalStoreError('LOCAL_DATA_CORRUPT')
    const trimmedLegacy = raw.legacyId.trim()
    if (trimmedLegacy) {
      if (trimmedLegacy.length > 128 || /[\p{Cc}\p{Cf}]/u.test(trimmedLegacy) || UUID.test(trimmedLegacy)) {
        throw new LocalStoreError('LOCAL_DATA_CORRUPT')
      }
      const cleanLegacy = toWellFormedClean(trimmedLegacy)
      if (!cleanLegacy || cleanLegacy !== trimmedLegacy) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
      if (rawIdTrimmed !== undefined && !UUID.test(rawIdTrimmed) && cleanLegacy !== rawIdTrimmed) {
        throw new LocalStoreError('LOCAL_DATA_CORRUPT')
      }
      explicitLegacyId = cleanLegacy
    }
  }
  const derivedLegacyId = rawIdTrimmed !== undefined && !UUID.test(rawIdTrimmed)
    ? sliceUtf16Safe(rawIdTrimmed, 128)
    : undefined
  const legacyId = explicitLegacyId || derivedLegacyId || undefined
  const rawRevTrimmed = typeof raw.revision === 'string' ? raw.revision.trim() : ''
  const revision = rawRevTrimmed && UUID.test(rawRevTrimmed)
    ? rawRevTrimmed.toLowerCase()
    : id && migrateId('revision:' + id + savedAt)
  const stage2WalletInboundCny = safeNullableNum(raw.stage2WalletInboundCny ?? raw.walletInboundCny)
  const stage3CorporateRepatriatedCny = safeNullableNum(raw.stage3CorporateRepatriatedCny)
  const stage3ExpectedCny = safeNullableNum(raw.stage3ExpectedCny)
  const stage3BankReceivedCny = safeNullableNum(raw.stage3BankReceivedCny ?? raw.bankReceivedCny)
  const stage3UnmatchedCny = safeNullableNum(raw.stage3UnmatchedCny)
  const stage3Status = typeof raw.stage3Status === 'string' && STAGE3_STATUSES.has(raw.stage3Status) ? raw.stage3Status : null
  const stage3CoverageComplete = raw.stage3CoverageComplete === undefined ? true : Boolean(raw.stage3CoverageComplete)
  const stage3Verified = stage3CoverageComplete === false
    ? false
    : stage3Status !== null
      ? (stage3Status === 'matched' && (stage3UnmatchedCny ?? 0) === 0)
      : (stage3UnmatchedCny ?? 0) > 0
        ? false
        : raw.stage3Verified !== undefined
          ? raw.stage3Verified === true
          : stage3BankReceivedCny !== null
  const currencySource = typeof raw.currencySource === 'string' && CURRENCY_SOURCES.has(raw.currencySource)
    ? raw.currencySource
    : null
  const reassignedAt = sanitizeIsoTimestamp(raw.reassignedAt)
  const updatedAt = sanitizeIsoTimestamp(raw.updatedAt) || reassignedAt || (savedAt || null)
  return {
    id,
    ...(legacyId ? { legacyId } : {}),
    revision,
    month,
    period: month,
    savedAt,
    updatedAt,
    label: textField(raw.label) || `${month} 店铺账单体检`,
    platforms,
    entityName: entity.entityName,
    entityKey: entity.entityKey,
    entityLabel: entity.entityLabel,
    ownershipStatus: entity.ownershipStatus,
    storeScope: shop.storeScope,
    shopKey: shop.shopKey,
    shopLabel: shop.shopLabel,
    vatTaxpayerType: VAT_TYPES.has(raw.vatTaxpayerType) ? raw.vatTaxpayerType : 'unknown',
    citAssessedMode: CIT_MODES.has(raw.citAssessedMode) ? raw.citAssessedMode : 'unknown',
    zeroSalesConfirmed: raw.zeroSalesConfirmed === true,
    sourceKey: buildSourceKey({ entityKey: entity.entityKey, shopKey: shop.shopKey, month }),
    importMode: IMPORT_MODES.has(raw.importMode) ? raw.importMode : 'new',
    sheetCount: safeInt(raw.sheetCount ?? 1),
    rowCount: safeInt(raw.rowCount),
    grossCny,
    refundCny,
    netSalesCny: raw.netSalesCny === undefined ? r2(grossCny - refundCny) : safeNum(raw.netSalesCny),
    feesCny: safeNum(raw.feesCny),
    payoutCny: safeNum(raw.payoutCny),
    declaredVatSalesCny: safeNullableNum(raw.declaredVatSalesCny),
    stage2WalletInboundCny,
    stage3CorporateRepatriatedCny,
    stage3ExpectedCny,
    stage3BankReceivedCny,
    stage3UnmatchedCny,
    stage3Status,
    stage3CoverageComplete,
    stage3Verified,
    currencySource,
    sites: sanitizeSites(raw.sites, raw.site),
    currencies: sanitizeCurrencies(raw.currencies, raw.currency),
    euSalesEur: safeNullableNum(raw.euSalesEur),
    euOrderCount: safeNullableInt(raw.euOrderCount),
    usSalesUsd: safeNullableNum(raw.usSalesUsd),
    usTransactionCount: safeNullableInt(raw.usTransactionCount),
    platformBreakdown: sanitizePlatformBreakdown(raw.platformBreakdown),
    p0Count: safeInt(raw.p0Count),
    p1Count: safeInt(raw.p1Count),
    p2Count: safeInt(raw.p2Count),
    reassignedAt,
    reassignedFrom: sanitizeReassignedFrom(raw.reassignedFrom),
  }
}

export function findSnapshotById(entries = [], rawId) {
  if (!Array.isArray(entries) || typeof rawId !== 'string') return null
  const trimmed = rawId.trim()
  if (!trimmed || trimmed.length > 128 || /[\p{Cc}\p{Cf}]/u.test(trimmed)) return null
  if (UUID.test(trimmed)) {
    const target = trimmed.toLowerCase()
    return entries.find((entry) => entry.id === target) || null
  }
  const migratedTarget = migrateId(trimmed)
  return entries.find((entry) => entry.id === migratedTarget) ||
    entries.find((entry) => entry.legacyId === trimmed) ||
    null
}

function hydrateListStrict(entries) {
  if (!Array.isArray(entries)) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  const ids = new Set()
  const legacyIds = new Set()
  const history = entries.map((item) => {
    try {
      const entry = hydrateEntry(item)
      if (!entry.id || ids.has(entry.id)) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
      ids.add(entry.id)
      if (entry.legacyId) {
        if (legacyIds.has(entry.legacyId)) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
        legacyIds.add(entry.legacyId)
      }
      return entry
    } catch {
      throw new LocalStoreError('LOCAL_DATA_CORRUPT')
    }
  })
  for (const entry of history) {
    if (entry.legacyId) {
      const migratedFromLegacy = migrateId(entry.legacyId)
      if (migratedFromLegacy !== entry.id && ids.has(migratedFromLegacy)) {
        throw new LocalStoreError('LOCAL_DATA_CORRUPT')
      }
    }
  }
  return sortHistory(history)
}

function loadHistoryFromPath(filePath) {
  const raw = readLocalJson(filePath)
  if (raw === undefined) return []
  const entries = Array.isArray(raw) ? raw : raw?.entries
  return hydrateListStrict(entries)
}

function persistHistoryToPath(filePath, list) {
  const history = sortHistory(list)
  writeLocalJson(filePath, { schema: HISTORY_SCHEMA, entries: history })
  return history
}

function resolveStore(store) {
  if (store === undefined || store === null) {
    const filePath = getHistoryFilePath()
    return {
      kind: 'file',
      filePath,
      load: () => loadHistoryFromPath(filePath),
      withLock: (fn) => withLocalWriteLock(filePath, () => fn(() => loadHistoryFromPath(filePath), (list) => persistHistoryToPath(filePath, list))),
    }
  }
  if (typeof store === 'string') {
    const filePath = store
    return {
      kind: 'file',
      filePath,
      load: () => loadHistoryFromPath(filePath),
      withLock: (fn) => withLocalWriteLock(filePath, () => fn(() => loadHistoryFromPath(filePath), (list) => persistHistoryToPath(filePath, list))),
    }
  }
  if (typeof store === 'object' && !Array.isArray(store)) {
    if (typeof store.filePath === 'string' || typeof store.path === 'string') {
      const filePath = store.filePath || store.path
      return {
        kind: 'file',
        filePath,
        load: () => loadHistoryFromPath(filePath),
        withLock: (fn) => withLocalWriteLock(filePath, () => fn(() => loadHistoryFromPath(filePath), (list) => persistHistoryToPath(filePath, list))),
      }
    }
    const loader = typeof store.load === 'function' ? () => store.load()
      : typeof store.read === 'function' ? () => store.read()
        : typeof store.getEntries === 'function' ? () => store.getEntries()
          : null
    const saver = typeof store.save === 'function' ? (list) => store.save(list)
      : typeof store.write === 'function' ? (list) => store.write(list)
        : typeof store.setEntries === 'function' ? (list) => store.setEntries(list)
          : null
    if (loader) {
      const loadHydrated = () => {
        const loaded = loader()
        const rawEntries = Array.isArray(loaded) ? loaded : loaded?.entries
        return rawEntries === undefined ? [] : hydrateListStrict(rawEntries)
      }
      return {
        kind: 'custom',
        load: loadHydrated,
        withLock: (fn) => fn(loadHydrated, (list) => {
          const sorted = sortHistory(list)
          if (saver) saver(sorted)
          return sorted
        }),
      }
    }
  }
  throw new HistoryInputError('INVALID_STORE', '归档存储对象无效。')
}

export function loadHistory() {
  return loadHistoryFromPath(getHistoryFilePath())
}

function persistHistory(list) {
  return persistHistoryToPath(getHistoryFilePath(), list)
}

/**
 * 基于历史归档计算 12 个自然月的报送参考净额与本纳税年度情景指标，支持按主体过滤隔离。
 */
export function computeRolling12m(history = [], refOrOpts = '') {
  const opts = typeof refOrOpts === 'string' ? { referenceMonth: refOrOpts } : (refOrOpts || {})
  const referenceMonth = String(opts.referenceMonth || '').trim()
  const explicitEntityKeyMode = opts.entityKey !== undefined && opts.entityKey !== null && String(opts.entityKey).trim() !== ''
  const filterEntityRaw = explicitEntityKeyMode
    ? String(opts.entityKey).trim()
    : String(opts.entityName ?? '').trim()
  const filterEntityNorm = isUnclaimedMarker(filterEntityRaw) ? UNCLAIMED_ENTITY_KEY : normIdentityPart(filterEntityRaw)

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
  const scoped = filterEntityRaw
    ? allEntries.filter((x) =>
        explicitEntityKeyMode
          ? (filterEntityNorm === UNCLAIMED_ENTITY_KEY ? x.ownershipStatus === 'unclaimed' : x.entityKey === filterEntityNorm)
          : (x.entityName === filterEntityRaw ||
              x.entityKey === filterEntityNorm ||
              (isUnclaimedMarker(filterEntityRaw) && x.ownershipStatus === 'unclaimed')),
      )
    : allEntries
  const uniqueScopedEntityKeys = new Set(scoped.map((x) => x.entityKey))
  const thresholdApplicable = Boolean(
    filterEntityRaw &&
    !isUnclaimedMarker(filterEntityRaw) &&
    scoped.length > 0 &&
    uniqueScopedEntityKeys.size === 1 &&
    scoped.every((x) => x.ownershipStatus !== 'unclaimed'),
  )

  if (scoped.length === 0) {
    return {
      snapshotCount: 0, thresholdApplicable, monthCount: 0, missingMonthsCount: 12, zeroSalesMonthsCount: 0,
      activeEntity: filterEntityRaw || '', entities, windowStart: '', windowEnd: '', taxYear: '',
      taxYearMonthCount: 0, taxYearNetSalesCny: 0, taxYearCliff75mPct: null, taxYearCliff75mRemainWan: null,
      totalGrossCny: 0, totalRefundCny: 0, totalNetSalesCny: 0, totalFeesCny: 0, totalPayoutCny: 0,
      totalP0: 0, totalP1: 0, cliff75mPct: null, cliff75mRemainWan: null, cliff75mLevel: null, cliff75mAlert: null,
      threshold5mPct: null, threshold5mRemainWan: null, threshold5mLevel: null, monthlySeries: [],
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
    snapshotCount, thresholdApplicable, monthCount: monthlySeries.length, missingMonthsCount, zeroSalesMonthsCount,
    activeEntity: filterEntityRaw || '', entities, windowStart, windowEnd, taxYear,
    taxYearMonthCount: taxYearMonths.size, taxYearNetSalesCny,
    taxYearCliff75mPct: thresholdApplicable ? taxYearCliff75mPct : null,
    taxYearCliff75mRemainWan: thresholdApplicable ? taxYearCliff75mRemainWan : null,
    totalGrossCny, totalRefundCny, totalNetSalesCny, totalFeesCny, totalPayoutCny, totalP0, totalP1,
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
  const targetIdTrimmed = typeof input.targetId === 'string' ? input.targetId.trim() : ''
  const expectedRevTrimmed = typeof input.expectedRevision === 'string' ? input.expectedRevision.trim() : ''
  if (conflictMode === 'replace' && (!UUID.test(targetIdTrimmed) || !UUID.test(expectedRevTrimmed))) {
    throw new HistoryInputError('INVALID_REPLACE_TARGET', '替换归档需要指定原快照及其版本。')
  }
  const explicitInputEntityKey = typeof input.entityKey === 'string' ? textField(input.entityKey) : ''
  if (input.distinctNewEntity === true && (!explicitInputEntityKey || isUnclaimedMarker(explicitInputEntityKey))) {
    throw new HistoryInputError('ENTITY_KEY_REQUIRED', '新建同名独立法人主体必须填写统一社会信用代码或唯一主体编码（entityKey），严禁静默合并。')
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
    entityKey: input.entityKey,
    entityLabel: input.entityLabel,
    storeScope: input.storeScope,
    shopKey: input.shopKey,
    shopLabel: input.shopLabel,
    vatTaxpayerType: input.vatTaxpayerType,
    citAssessedMode: input.citAssessedMode,
    sheetCount: input.sheetCount,
    rowCount: input.rowCount,
    feesCny: input.feesCny,
    payoutCny: input.payoutCny,
    declaredVatSalesCny: input.declaredVatSalesCny,
    stage2WalletInboundCny: input.stage2WalletInboundCny ?? input.walletInboundCny,
    stage3CorporateRepatriatedCny: input.stage3CorporateRepatriatedCny,
    stage3ExpectedCny: input.stage3ExpectedCny,
    stage3BankReceivedCny: input.stage3BankReceivedCny ?? input.bankReceivedCny,
    stage3UnmatchedCny: input.stage3UnmatchedCny,
    stage3Status: input.stage3Status,
    stage3CoverageComplete: input.stage3CoverageComplete,
    stage3Verified: input.stage3Verified,
    currencySource: input.currencySource,
    sites: input.sites,
    site: input.site,
    currencies: input.currencies,
    currency: input.currency,
    euSalesEur: input.euSalesEur,
    euOrderCount: input.euOrderCount,
    usSalesUsd: input.usSalesUsd,
    usTransactionCount: input.usTransactionCount,
    platformBreakdown: input.platformBreakdown,
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
    if (!explicitInputEntityKey && snapshot.ownershipStatus === 'claimed') {
      const desiredLabelNorm = normIdentityPart(snapshot.entityLabel)
      const sameNameClaimedKeys = new Set(
        existing
          .filter((e) => e.ownershipStatus === 'claimed' && normIdentityPart(e.entityLabel) === desiredLabelNorm)
          .map((e) => e.entityKey),
      )
      if (
        sameNameClaimedKeys.size > 1 ||
        (sameNameClaimedKeys.size === 1 && [...sameNameClaimedKeys][0] !== desiredLabelNorm)
      ) {
        throw new HistoryInputError(
          'AMBIGUOUS_ENTITY_KEY',
          '库内已存在同显示名但具备独立主体编码的法人主体，归档时请显式传入 entityKey（统一社会信用代码/主体唯一编码）或暂存为「待认领」，严禁静默合并或分裂。',
        )
      }
    }
    const candidates = existing.filter((entry) => entry.sourceKey === snapshot.sourceKey)
    const targetIdNorm = targetIdTrimmed.toLowerCase()
    const expectedRevNorm = expectedRevTrimmed.toLowerCase()
    const byTargetId = conflictMode === 'replace' ? existing.find((entry) => entry.id === targetIdNorm) : undefined
    const toReplace = conflictMode === 'replace'
      ? candidates.find((entry) => entry.id === targetIdNorm && entry.revision === expectedRevNorm)
      : undefined
    if (conflictMode === 'check' && candidates.length) {
      return {
        conflict: true,
        conflictType: 'source_key_collision',
        reason: 'source_key_collision',
        existing: candidates[0] ?? null,
        candidates,
      }
    }
    if (conflictMode === 'replace' && !toReplace) {
      return {
        conflict: true,
        conflictType: byTargetId ? 'revision_conflict' : 'target_not_found',
        reason: byTargetId ? 'revision_mismatch' : 'target_not_found',
        existing: byTargetId ?? candidates[0] ?? null,
        candidates: candidates.length ? candidates : (byTargetId ? [byTargetId] : []),
      }
    }
    if (!toReplace && existing.length >= MAX_SNAPSHOTS) {
      throw new HistoryInputError('HISTORY_CAPACITY', '归档已达容量上限，请先迁出或删除旧档。')
    }
    let id = toReplace?.id ?? randomUUID()
    while (!toReplace && existing.some((item) => item.id === id)) id = randomUUID()
    const nowIso = new Date().toISOString()
    const entry = {
      ...snapshot,
      id,
      revision: randomUUID(),
      savedAt: nowIso,
      updatedAt: nowIso,
      importMode: conflictMode === 'append' ? 'append' : toReplace ? 'replace' : 'new',
    }
    const history = persistHistory([entry, ...existing.filter((item) => item.id !== entry.id)])
    return { conflict: false, entry, deduplicated: Boolean(toReplace), history, rolling12m: computeRolling12m(history) }
  })
}

export function deleteSnapshot(rawId) {
  if (typeof rawId !== 'string') {
    throw new HistoryInputError('INVALID_SNAPSHOT_ID', '归档快照 ID 无效。')
  }
  const id = rawId.trim()
  if (!id || id.length > 128 || /[\p{Cc}\p{Cf}]/u.test(id)) {
    throw new HistoryInputError('INVALID_SNAPSHOT_ID', '归档快照 ID 无效。')
  }
  const isUuid = UUID.test(id)
  return withLocalWriteLock(getHistoryFilePath(), () => {
    const current = loadHistory()
    const target = findSnapshotById(current, id)
    if (!isUuid && !target) {
      throw new HistoryInputError('INVALID_SNAPSHOT_ID', '归档快照 ID 无效。')
    }
    const next = target ? current.filter((entry) => entry.id !== target.id) : current
    const deleted = next.length !== current.length
    const history = deleted ? persistHistory(next) : current
    return {
      deleted,
      ...(deleted && !isUuid && target ? { matchedBy: 'legacyId', deletedId: target.id, legacyId: target.legacyId ?? id } : {}),
      history,
      rolling12m: computeRolling12m(history),
    }
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

const QUARTERS = [
  { quarter: 'Q1', label: 'Q1 (01–03月)', months: ['01', '02', '03'] },
  { quarter: 'Q2', label: 'Q2 (04–06月)', months: ['04', '05', '06'] },
  { quarter: 'Q3', label: 'Q3 (07–09月)', months: ['07', '08', '09'] },
  { quarter: 'Q4', label: 'Q4 (10–12月)', months: ['10', '11', '12'] },
]
const EU_TEXT_RE = /\b(?:EU|EUR|EUROPE|DE|FR|IT|ES|NL|PL|SE|BE|IE)\b|欧洲|欧盟|德国|法国|意大利|西班牙/i
const US_TEXT_RE = /\b(?:US|USA|USD)\b|美国|美站|北美/i

function normalizeYear(value, fallbackList = []) {
  if (value !== undefined && value !== null && value !== '') {
    const str = String(value).trim()
    if (!/^(?:201[5-9]|20[2-9][0-9])$/.test(str)) {
      throw new HistoryInputError('INVALID_YEAR', '汇总年份须为有效的四位自然年（如 2026）。')
    }
    return Number(str)
  }
  const latest = sortHistory(fallbackList)[0]
  if (latest?.month) return Number(latest.month.slice(0, 4))
  return new Date().getUTCFullYear()
}

function aggregatePlatforms(entries, totalNetSalesCny = 0) {
  const map = new Map()
  const add = (key, vals, multiPlatform) => {
    const cur = map.get(key) || {
      platform: key, grossCny: 0, refundCny: 0, netSalesCny: 0, feesCny: 0, payoutCny: 0,
      multiPlatform: Boolean(multiPlatform), snapshotCount: 0,
    }
    cur.grossCny = r2(cur.grossCny + vals.grossCny)
    cur.refundCny = r2(cur.refundCny + vals.refundCny)
    cur.netSalesCny = r2(cur.netSalesCny + vals.netSalesCny)
    cur.feesCny = r2(cur.feesCny + vals.feesCny)
    cur.payoutCny = r2(cur.payoutCny + vals.payoutCny)
    cur.snapshotCount++
    map.set(key, cur)
  }
  for (const e of entries) {
    if (Array.isArray(e.platformBreakdown) && e.platformBreakdown.length > 0) {
      for (const p of e.platformBreakdown) add(p.platform, p, false)
    } else if (e.platforms.length === 1) {
      add(e.platforms[0], e, false)
    } else if (e.platforms.length > 1) {
      add([...e.platforms].sort().join(' + '), e, true)
    } else {
      add('未标明平台', e, false)
    }
  }
  const denom = Math.abs(totalNetSalesCny) > 0 ? totalNetSalesCny : 0
  return [...map.values()]
    .map((item) => ({
      ...item,
      shareOfNetPct: denom > 0 ? r2((item.netSalesCny / denom) * 100) : 0,
    }))
    .sort((a, b) => b.netSalesCny - a.netSalesCny || a.platform.localeCompare(b.platform))
}

const UK_TEXT_RE = /\b(?:UK|GB|GBP)\b|英国/i

function nextBusinessDayIsoUtc(year, month1Based, day) {
  const dt = new Date(Date.UTC(year, month1Based - 1, day))
  const dow = dt.getUTCDay()
  if (dow === 6) dt.setUTCDate(dt.getUTCDate() + 2)
  else if (dow === 0) dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}

function endOfFebruaryIsoUtc(year) {
  return new Date(Date.UTC(year, 2, 0)).toISOString().slice(0, 10)
}

function summarizeBucket(entries) {
  let grossCny = 0
  let refundCny = 0
  let netSalesCny = 0
  let feesCny = 0
  let payoutCny = 0
  let declaredVatSum = 0
  let declaredVatCoverageCount = 0
  let stage2Sum = 0
  let stage2RecordedCount = 0
  let stage3CorpSum = 0
  let stage3CorpCount = 0
  let stage3BankSum = 0
  let stage3RecordedCount = 0
  let stage3VerifiedCount = 0
  let stage3UnmatchedSum = 0
  let stage3HasUnmatched = false
  let p0Count = 0
  let p1Count = 0
  let p2Count = 0

  const byMonth = new Map()
  for (const e of entries) {
    grossCny += e.grossCny
    refundCny += e.refundCny
    netSalesCny += e.netSalesCny
    feesCny += e.feesCny
    payoutCny += e.payoutCny
    if (e.stage2WalletInboundCny !== null) {
      stage2Sum += e.stage2WalletInboundCny
      stage2RecordedCount++
    }
    if (e.stage3CorporateRepatriatedCny !== null) {
      stage3CorpSum += e.stage3CorporateRepatriatedCny
      stage3CorpCount++
    }
    if (e.stage3BankReceivedCny !== null) {
      stage3BankSum += e.stage3BankReceivedCny
      stage3RecordedCount++
    }
    if (e.stage3Verified === true && e.stage3BankReceivedCny !== null) {
      stage3VerifiedCount++
    }
    if (e.stage3UnmatchedCny !== null && e.stage3UnmatchedCny > 0) {
      stage3UnmatchedSum += e.stage3UnmatchedCny
      stage3HasUnmatched = true
    } else if (!e.stage3Verified && e.stage3ExpectedCny !== null && e.stage3BankReceivedCny !== null && e.stage3ExpectedCny > e.stage3BankReceivedCny) {
      stage3UnmatchedSum += e.stage3ExpectedCny - e.stage3BankReceivedCny
      stage3HasUnmatched = true
    }
    p0Count += e.p0Count
    p1Count += e.p1Count
    p2Count += e.p2Count
    if (!byMonth.has(e.month)) byMonth.set(e.month, [])
    byMonth.get(e.month).push(e)
  }

  // 双边同覆盖期差额计算：仅在双方均有完整数据的月份内计算差额，另列待补期数与待补金额
  const sortedMonths = [...byMonth.keys()].sort()
  const declaredMatchedMonths = []
  const declaredPendingMonths = []
  let declaredMatchedNetSalesCny = 0
  let declaredMatchedVatSalesCny = 0
  let declaredPendingNetSalesCny = 0

  const stage1to2MatchedMonths = []
  const stage1to2PendingMonths = []
  let s1to2MatchedPayoutCny = 0
  let s1to2MatchedStage2Cny = 0
  let stage1to2PendingPayoutCny = 0

  const stage2to3MatchedMonths = []
  const stage2to3PendingMonths = []
  let s2to3MatchedStage2Cny = 0
  let s2to3MatchedStage3Cny = 0
  let stage2to3PendingStage2Cny = 0

  const stage1to3MatchedMonths = []
  const stage1to3PendingMonths = []
  let s1to3MatchedPayoutCny = 0
  let s1to3MatchedStage3Cny = 0
  let stage1to3PendingPayoutCny = 0

  for (const ym of sortedMonths) {
    const list = byMonth.get(ym)
    const mNet = list.reduce((acc, x) => acc + x.netSalesCny, 0)
    const mPayout = list.reduce((acc, x) => acc + x.payoutCny, 0)
    const allZeroConfirmed = list.every((x) => x.zeroSalesConfirmed && x.grossCny === 0 && x.netSalesCny === 0 && x.payoutCny === 0)

    // 同月含 append 补单时按整月增值税申报口径归并：任一记录已录整月申报额即覆盖同组补单，并对同值去重防翻倍
    const bySource = new Map()
    for (const item of list) {
      if (!bySource.has(item.sourceKey)) bySource.set(item.sourceKey, [])
      bySource.get(item.sourceKey).push(item)
    }
    const anyDeclaredInMonth = list.some((x) => x.declaredVatSalesCny !== null)
    let monthDeclaredVal = 0
    let monthDeclaredCovered = anyDeclaredInMonth
    let monthUncoveredNet = 0
    for (const grp of bySource.values()) {
      const grpDeclared = grp.filter((x) => x.declaredVatSalesCny !== null)
      const grpHasAppend = grp.some((x) => x.importMode === 'append')
      if (grpDeclared.length > 0) {
        const vals = grpHasAppend
          ? [...new Set(grpDeclared.map((x) => x.declaredVatSalesCny))]
          : grpDeclared.map((x) => x.declaredVatSalesCny)
        const grpSum = vals.reduce((acc, v) => acc + v, 0)
        monthDeclaredVal += grpSum
        declaredVatSum += grpSum
        declaredVatCoverageCount += grpHasAppend ? 1 : grpDeclared.length
        if (!grpHasAppend && grpDeclared.length < grp.length) {
          monthDeclaredCovered = false
          monthUncoveredNet += grp.filter((x) => x.declaredVatSalesCny === null).reduce((acc, x) => acc + x.netSalesCny, 0)
        }
      } else if (!(grp.every((x) => x.importMode === 'append') && anyDeclaredInMonth)) {
        monthDeclaredCovered = false
        monthUncoveredNet += grp.reduce((acc, x) => acc + x.netSalesCny, 0)
      }
    }

    if (monthDeclaredCovered && anyDeclaredInMonth) {
      declaredMatchedMonths.push(ym)
      declaredMatchedNetSalesCny += mNet
      declaredMatchedVatSalesCny += monthDeclaredVal
    } else if (!allZeroConfirmed) {
      declaredPendingMonths.push(ym)
      declaredPendingNetSalesCny += monthUncoveredNet
    }

    const hasAllStage2 = list.every((x) => x.stage2WalletInboundCny !== null)
    const hasAllStage3 = list.every((x) => x.stage3Verified === true && x.stage3BankReceivedCny !== null)
    const mStage2 = hasAllStage2 ? list.reduce((acc, x) => acc + x.stage2WalletInboundCny, 0) : 0
    const mStage3 = hasAllStage3 ? list.reduce((acc, x) => acc + x.stage3BankReceivedCny, 0) : 0

    if (hasAllStage2) {
      stage1to2MatchedMonths.push(ym)
      s1to2MatchedPayoutCny += mPayout
      s1to2MatchedStage2Cny += mStage2
    } else if (!allZeroConfirmed) {
      stage1to2PendingMonths.push(ym)
      stage1to2PendingPayoutCny += list.filter((x) => x.stage2WalletInboundCny === null).reduce((acc, x) => acc + x.payoutCny, 0)
    }

    const entryPendingStage3Amount = (x, fallbackField) => {
      if (x.stage3Verified === true && x.stage3BankReceivedCny !== null) return 0
      if (x.stage3UnmatchedCny !== null) return x.stage3UnmatchedCny
      if (x.stage3BankReceivedCny !== null) {
        const exp = x.stage3ExpectedCny ?? x.stage3CorporateRepatriatedCny ?? (x[fallbackField] ?? 0)
        return Math.max(0, exp - x.stage3BankReceivedCny)
      }
      return x[fallbackField] ?? 0
    }

    if (hasAllStage2 && hasAllStage3) {
      stage2to3MatchedMonths.push(ym)
      s2to3MatchedStage2Cny += mStage2
      s2to3MatchedStage3Cny += mStage3
    } else if (hasAllStage2 && !hasAllStage3 && !allZeroConfirmed) {
      stage2to3PendingMonths.push(ym)
      stage2to3PendingStage2Cny += list.reduce((acc, x) => acc + entryPendingStage3Amount(x, 'stage2WalletInboundCny'), 0)
    }

    if (hasAllStage3) {
      stage1to3MatchedMonths.push(ym)
      s1to3MatchedPayoutCny += mPayout
      s1to3MatchedStage3Cny += mStage3
    } else if (!allZeroConfirmed) {
      stage1to3PendingMonths.push(ym)
      stage1to3PendingPayoutCny += list.reduce((acc, x) => acc + entryPendingStage3Amount(x, 'payoutCny'), 0)
    }
  }

  grossCny = r2(grossCny)
  refundCny = r2(refundCny)
  netSalesCny = r2(netSalesCny)
  feesCny = r2(feesCny)
  payoutCny = r2(payoutCny)
  const declaredVatSalesCny = declaredVatCoverageCount > 0 ? r2(declaredVatSum) : null
  const stage2WalletInboundCny = stage2RecordedCount > 0 ? r2(stage2Sum) : null
  const stage3CorporateRepatriatedCny = stage3CorpCount > 0 ? r2(stage3CorpSum) : null
  const stage3BankReceivedCny = stage3RecordedCount > 0 ? r2(stage3BankSum) : null
  const stage3UnmatchedCny = stage3HasUnmatched ? r2(stage3UnmatchedSum) : (stage3VerifiedCount > 0 ? 0 : null)
  const declaredGapCny = declaredMatchedMonths.length > 0
    ? r2(declaredMatchedNetSalesCny - declaredMatchedVatSalesCny)
    : null
  const stage1to2GapCny = stage1to2MatchedMonths.length > 0
    ? r2(s1to2MatchedStage2Cny - s1to2MatchedPayoutCny)
    : null
  const stage2to3GapCny = stage2to3MatchedMonths.length > 0
    ? r2(s2to3MatchedStage3Cny - s2to3MatchedStage2Cny)
    : null
  const stage1to3GapCny = stage1to3MatchedMonths.length > 0
    ? r2(s1to3MatchedStage3Cny - s1to3MatchedPayoutCny)
    : null

  return {
    snapshotCount: entries.length,
    grossCny,
    refundCny,
    netSalesCny,
    feesCny,
    payoutCny,
    declaredVatSalesCny,
    declaredVatCoverageCount,
    declaredGapCny,
    declaredMatchedMonths,
    declaredMatchedMonthCount: declaredMatchedMonths.length,
    declaredMatchedNetSalesCny: r2(declaredMatchedNetSalesCny),
    declaredMatchedVatSalesCny: r2(declaredMatchedVatSalesCny),
    declaredPendingMonths,
    declaredPendingMonthCount: declaredPendingMonths.length,
    declaredPendingNetSalesCny: r2(declaredPendingNetSalesCny),
    stage2WalletInboundCny,
    stage2RecordedCount,
    stage3CorporateRepatriatedCny,
    stage3BankReceivedCny,
    stage3RecordedCount,
    stage3VerifiedCount,
    stage3FullVerifiedMonthCount: stage1to3MatchedMonths.length,
    stage3UnmatchedCny,
    stage1to2GapCny,
    stage1to2MatchedMonthCount: stage1to2MatchedMonths.length,
    stage1to2PendingMonths,
    stage1to2PendingMonthCount: stage1to2PendingMonths.length,
    stage1to2PendingPayoutCny: r2(stage1to2PendingPayoutCny),
    stage2to3GapCny,
    stage2to3MatchedMonthCount: stage2to3MatchedMonths.length,
    stage2to3PendingMonths,
    stage2to3PendingMonthCount: stage2to3PendingMonths.length,
    stage2to3PendingStage2Cny: r2(stage2to3PendingStage2Cny),
    stage1to3GapCny,
    stage1to3MatchedMonthCount: stage1to3MatchedMonths.length,
    stage1to3PendingMonths,
    stage1to3PendingMonthCount: stage1to3PendingMonths.length,
    stage1to3PendingPayoutCny: r2(stage1to3PendingPayoutCny),
    p0Count,
    p1Count,
    p2Count,
    totalAnomalies: p0Count + p1Count + p2Count,
  }
}

function detectJurisdictionSignals(entries, fxUsd, fxEur) {
  const euSites = new Set()
  const usSites = new Set()
  const nonEuSitesWithEur = new Set()
  const nonUsSitesWithUsd = new Set()
  let hasEurCurrency = false
  let hasUsdCurrency = false
  let euTextHit = false
  let usTextHit = false
  let eurOnNonEuSiteOnly = false
  let eurCurrencyWithoutSite = false
  let usdOnNonUsSiteOnly = false

  let euEntryCount = 0
  let euRecordedEur = 0
  let euRecordedEurCount = 0
  let euEstimatedEur = 0
  let euEstimatedEurCount = 0
  let euMissingAmountCount = 0
  let euOrderCount = 0
  let euOrderRecordedCount = 0
  let euMissingOrderCount = 0

  let usEntryCount = 0
  let usRecordedUsd = 0
  let usRecordedUsdCount = 0
  let usEstimatedUsd = 0
  let usEstimatedUsdCount = 0
  let usMissingAmountCount = 0
  let usTxnCount = 0
  let usTxnRecordedCount = 0
  let usMissingTxnCount = 0

  const euByPlatform = new Map()
  const usByPlatform = new Map()
  const ensurePlatBucket = (map, platform, unsplitMultiPlatform = false) => {
    if (!map.has(platform)) {
      map.set(platform, {
        platform,
        unsplitMultiPlatform,
        amount: 0,
        hasAmount: false,
        missingAmountCount: 0,
        count: 0,
        hasCount: false,
        missingCount: 0,
      })
    }
    return map.get(platform)
  }

  for (const e of entries) {
    const scopeText = `${e.storeScope || ''} ${e.label || ''}`
    const pbSites = (e.platformBreakdown || []).map((pb) => pb.site).filter(Boolean)
    const allSites = [...new Set([...(e.sites || []), ...pbSites])]
    const geoSites = allSites.filter((s) => s !== 'GLOBAL' && s !== 'DTC')
    const eEuSites = geoSites.filter((s) => EU_DAC7_SITES.has(s))
    const eUsSites = geoSites.filter((s) => US_SITES.has(s))
    for (const s of eEuSites) euSites.add(s)
    for (const s of eUsSites) usSites.add(s)

    const eHasExplicitSites = geoSites.length > 0
    const eExplicitNonEuOnly = eHasExplicitSites && eEuSites.length === 0
    const eExplicitNonUsOnly = eHasExplicitSites && eUsSites.length === 0 && !e.platforms.includes('Walmart')

    const eHasEur = e.currencies.includes('EUR') || (e.platformBreakdown || []).some((pb) => pb.currency === 'EUR')
    const eHasUsd = e.currencies.includes('USD') || (e.platformBreakdown || []).some((pb) => pb.currency === 'USD')
    if (eHasEur) hasEurCurrency = true
    if (eHasUsd) hasUsdCurrency = true

    const textUk = UK_TEXT_RE.test(scopeText)
    const textEu = !eExplicitNonEuOnly && EU_TEXT_RE.test(scopeText) && !(textUk && !/\b(?:EU|DE|FR|IT|ES|NL|PL|SE|BE|IE)\b|欧盟|德国|法国|意大利|西班牙/i.test(scopeText))
    const textUs = !eExplicitNonUsOnly && (US_TEXT_RE.test(scopeText) || e.platforms.includes('Walmart'))
    if (textEu) euTextHit = true
    if (textUs) usTextHit = true

    if (eExplicitNonEuOnly && (eHasEur || (e.euSalesEur ?? 0) > 0)) {
      eurOnNonEuSiteOnly = true
      for (const s of geoSites) nonEuSitesWithEur.add(s)
    } else if (!eHasExplicitSites && textUk && !textEu && (eHasEur || (e.euSalesEur ?? 0) > 0)) {
      eurOnNonEuSiteOnly = true
      nonEuSitesWithEur.add('UK')
    }
    if (eExplicitNonUsOnly && (eHasUsd || (e.usSalesUsd ?? 0) > 0)) {
      usdOnNonUsSiteOnly = true
      for (const s of geoSites) nonUsSitesWithUsd.add(s)
    }

    let breakdownEuOrig = 0
    let breakdownEuRecorded = false
    let breakdownEuEst = 0
    let breakdownEuEstimated = false
    let breakdownEuTxns = 0
    let breakdownEuTxnHit = false
    let breakdownEuTxnMissing = false
    const euPbRows = []

    let breakdownUsOrig = 0
    let breakdownUsRecorded = false
    let breakdownUsEst = 0
    let breakdownUsEstimated = false
    let breakdownUsTxns = 0
    let breakdownUsTxnHit = false
    let breakdownUsTxnMissing = false
    const usPbRows = []

    for (const pb of e.platformBreakdown || []) {
      const pbGeoSite = pb.site && pb.site !== 'GLOBAL' && pb.site !== 'DTC' ? pb.site : null
      const pbHasSite = Boolean(pbGeoSite)
      const pbIsEuSite = Boolean(pbGeoSite && EU_DAC7_SITES.has(pbGeoSite))
      const pbIsExplicitNonEu = pbHasSite && !pbIsEuSite
      const pbIsUsSite = Boolean((pbGeoSite && US_SITES.has(pbGeoSite)) || pb.platform === 'Walmart')
      const pbIsExplicitNonUs = pbHasSite && !pbIsUsSite
      const pbEu = pbIsEuSite || (!eExplicitNonEuOnly && !pbHasSite && pb.currency === 'EUR' && textEu)
      const pbUs = pbIsUsSite || (!eExplicitNonUsOnly && !pbHasSite && pb.currency === 'USD')
      if (pbIsExplicitNonEu && pb.currency === 'EUR') {
        eurOnNonEuSiteOnly = true
        nonEuSitesWithEur.add(pbGeoSite)
      }
      if (pbIsExplicitNonUs && pb.currency === 'USD') {
        usdOnNonUsSiteOnly = true
        nonUsSitesWithUsd.add(pbGeoSite)
      }
      if (pbEu) {
        let rowAmt = null
        if (pb.currency === 'EUR' && pb.grossOrig !== null) {
          rowAmt = pb.grossOrig
          breakdownEuOrig += pb.grossOrig
          breakdownEuRecorded = true
        } else if (pb.grossCny > 0) {
          rowAmt = pb.grossCny / fxEur
          breakdownEuEst += rowAmt
          breakdownEuEstimated = true
        } else if (pb.grossCny === 0 && e.zeroSalesConfirmed) {
          rowAmt = 0
          breakdownEuRecorded = true
        }
        if (pb.transactionCount !== null) {
          breakdownEuTxns += pb.transactionCount
          breakdownEuTxnHit = true
        } else {
          breakdownEuTxnMissing = true
        }
        euPbRows.push({ platform: pb.platform, amount: rowAmt, count: pb.transactionCount })
      }
      if (pbUs) {
        let rowAmt = null
        if (pb.currency === 'USD' && pb.grossOrig !== null) {
          rowAmt = pb.grossOrig
          breakdownUsOrig += pb.grossOrig
          breakdownUsRecorded = true
        } else if (pb.grossCny > 0) {
          rowAmt = pb.grossCny / fxUsd
          breakdownUsEst += rowAmt
          breakdownUsEstimated = true
        } else if (pb.grossCny === 0 && e.zeroSalesConfirmed) {
          rowAmt = 0
          breakdownUsRecorded = true
        }
        if (pb.transactionCount !== null) {
          breakdownUsTxns += pb.transactionCount
          breakdownUsTxnHit = true
        } else {
          breakdownUsTxnMissing = true
        }
        usPbRows.push({ platform: pb.platform, amount: rowAmt, count: pb.transactionCount })
      }
    }

    const euCurrencyOnlyNoSite = !eHasExplicitSites && !textEu && !textUk && eHasEur && !((e.euSalesEur ?? 0) > 0) && !((e.euOrderCount ?? 0) > 0)
    if (euCurrencyOnlyNoSite) eurCurrencyWithoutSite = true

    const entryEuFlag = !eExplicitNonEuOnly && (
      eEuSites.length > 0 ||
      textEu ||
      breakdownEuRecorded ||
      breakdownEuEstimated ||
      (!textUk && ((e.euSalesEur ?? 0) > 0 || (e.euOrderCount ?? 0) > 0))
    )
    const entryUsFlag = !eExplicitNonUsOnly && (
      eUsSites.length > 0 ||
      eHasUsd ||
      textUs ||
      breakdownUsRecorded ||
      breakdownUsEstimated ||
      (e.usSalesUsd ?? 0) > 0 ||
      (e.usTransactionCount ?? 0) > 0
    )

    const salesPlats = e.platforms.filter((p) => !WALLET_PLATFORMS.has(p))
    const resolveSingleOrCombinedPlat = (pbRows) => {
      const pbPlats = [...new Set(pbRows.map((r) => r.platform).filter(Boolean))]
      if (pbPlats.length === 1) return { platform: pbPlats[0], unsplit: false }
      if (salesPlats.length === 1) return { platform: salesPlats[0], unsplit: false }
      if (salesPlats.length > 1) return { platform: [...salesPlats].sort().join(' + '), unsplit: true }
      return { platform: '未标明平台', unsplit: false }
    }

    if (entryEuFlag) {
      euEntryCount++
      let entryEuAmt = null
      if (e.euSalesEur !== null) {
        if (e.currencySource === 'mixed_estimated' || (breakdownEuRecorded && breakdownEuEstimated)) {
          const mergedAmt = (breakdownEuEstimated && Math.abs(e.euSalesEur - r2(breakdownEuOrig)) < 0.02)
            ? e.euSalesEur + breakdownEuEst
            : e.euSalesEur
          const origPart = Math.min(mergedAmt, breakdownEuOrig)
          euRecordedEur += origPart
          euEstimatedEur += Math.max(0, mergedAmt - origPart)
          euRecordedEurCount++
          euEstimatedEurCount++
          entryEuAmt = mergedAmt
        } else if (e.currencySource === 'estimated_from_cny' || (!breakdownEuRecorded && breakdownEuEstimated)) {
          euEstimatedEur += e.euSalesEur
          euEstimatedEurCount++
          entryEuAmt = e.euSalesEur
        } else {
          euRecordedEur += e.euSalesEur
          euRecordedEurCount++
          entryEuAmt = e.euSalesEur
        }
      } else if (breakdownEuRecorded || breakdownEuEstimated) {
        entryEuAmt = breakdownEuOrig + breakdownEuEst
        if (breakdownEuRecorded) {
          euRecordedEur += breakdownEuOrig
          euRecordedEurCount++
        }
        if (breakdownEuEstimated) {
          euEstimatedEur += breakdownEuEst
          euEstimatedEurCount++
        }
      } else if (!entryUsFlag && e.grossCny > 0) {
        entryEuAmt = e.grossCny / fxEur
        euEstimatedEur += entryEuAmt
        euEstimatedEurCount++
      } else if (e.zeroSalesConfirmed && e.grossCny === 0) {
        entryEuAmt = 0
        euRecordedEurCount++
      } else {
        euMissingAmountCount++
      }

      let entryEuOrd = null
      if (e.euOrderCount !== null) {
        entryEuOrd = e.euOrderCount
        euOrderCount += e.euOrderCount
        euOrderRecordedCount++
      } else if (breakdownEuTxnHit && !breakdownEuTxnMissing) {
        entryEuOrd = breakdownEuTxns
        euOrderCount += breakdownEuTxns
        euOrderRecordedCount++
      } else if (breakdownEuTxnHit && breakdownEuTxnMissing) {
        entryEuOrd = breakdownEuTxns
        euOrderCount += breakdownEuTxns
        euOrderRecordedCount++
        euMissingOrderCount++
      } else if (e.zeroSalesConfirmed && e.grossCny === 0) {
        entryEuOrd = 0
        euOrderRecordedCount++
      } else {
        euMissingOrderCount++
      }

      const distinctEuPlats = new Set(euPbRows.map((r) => r.platform).filter(Boolean))
      if (euPbRows.length > 0 && distinctEuPlats.size > 1) {
        for (const r of euPbRows) {
          const b = ensurePlatBucket(euByPlatform, r.platform || '未标明平台', false)
          if (r.amount !== null) { b.amount += r.amount; b.hasAmount = true } else b.missingAmountCount++
          if (r.count !== null) { b.count += r.count; b.hasCount = true } else b.missingCount++
        }
      } else if (!(e.zeroSalesConfirmed && e.grossCny === 0 && (entryEuAmt ?? 0) === 0 && (entryEuOrd ?? 0) === 0)) {
        const { platform: pk, unsplit } = resolveSingleOrCombinedPlat(euPbRows)
        const b = ensurePlatBucket(euByPlatform, pk, unsplit)
        if (entryEuAmt !== null) { b.amount += entryEuAmt; b.hasAmount = true } else b.missingAmountCount++
        if (entryEuOrd !== null) { b.count += entryEuOrd; b.hasCount = true } else b.missingCount++
      }
    }

    if (entryUsFlag) {
      usEntryCount++
      let entryUsAmt = null
      if (e.usSalesUsd !== null) {
        if (e.currencySource === 'mixed_estimated' || (breakdownUsRecorded && breakdownUsEstimated)) {
          const mergedAmt = (breakdownUsEstimated && Math.abs(e.usSalesUsd - r2(breakdownUsOrig)) < 0.02)
            ? e.usSalesUsd + breakdownUsEst
            : e.usSalesUsd
          const origPart = Math.min(mergedAmt, breakdownUsOrig)
          usRecordedUsd += origPart
          usEstimatedUsd += Math.max(0, mergedAmt - origPart)
          usRecordedUsdCount++
          usEstimatedUsdCount++
          entryUsAmt = mergedAmt
        } else if (e.currencySource === 'estimated_from_cny' || (!breakdownUsRecorded && breakdownUsEstimated)) {
          usEstimatedUsd += e.usSalesUsd
          usEstimatedUsdCount++
          entryUsAmt = e.usSalesUsd
        } else {
          usRecordedUsd += e.usSalesUsd
          usRecordedUsdCount++
          entryUsAmt = e.usSalesUsd
        }
      } else if (breakdownUsRecorded || breakdownUsEstimated) {
        entryUsAmt = breakdownUsOrig + breakdownUsEst
        if (breakdownUsRecorded) {
          usRecordedUsd += breakdownUsOrig
          usRecordedUsdCount++
        }
        if (breakdownUsEstimated) {
          usEstimatedUsd += breakdownUsEst
          usEstimatedUsdCount++
        }
      } else if (!entryEuFlag && e.grossCny > 0) {
        entryUsAmt = e.grossCny / fxUsd
        usEstimatedUsd += entryUsAmt
        usEstimatedUsdCount++
      } else if (e.zeroSalesConfirmed && e.grossCny === 0) {
        entryUsAmt = 0
        usRecordedUsdCount++
      } else {
        usMissingAmountCount++
      }

      let entryUsOrd = null
      if (e.usTransactionCount !== null) {
        entryUsOrd = e.usTransactionCount
        usTxnCount += e.usTransactionCount
        usTxnRecordedCount++
      } else if (breakdownUsTxnHit && !breakdownUsTxnMissing) {
        entryUsOrd = breakdownUsTxns
        usTxnCount += breakdownUsTxns
        usTxnRecordedCount++
      } else if (breakdownUsTxnHit && breakdownUsTxnMissing) {
        entryUsOrd = breakdownUsTxns
        usTxnCount += breakdownUsTxns
        usTxnRecordedCount++
        usMissingTxnCount++
      } else if (e.zeroSalesConfirmed && e.grossCny === 0) {
        entryUsOrd = 0
        usTxnRecordedCount++
      } else {
        usMissingTxnCount++
      }

      const distinctUsPlats = new Set(usPbRows.map((r) => r.platform).filter(Boolean))
      if (usPbRows.length > 0 && distinctUsPlats.size > 1) {
        for (const r of usPbRows) {
          const b = ensurePlatBucket(usByPlatform, r.platform || '未标明平台', false)
          if (r.amount !== null) { b.amount += r.amount; b.hasAmount = true } else b.missingAmountCount++
          if (r.count !== null) { b.count += r.count; b.hasCount = true } else b.missingCount++
        }
      } else if (!(e.zeroSalesConfirmed && e.grossCny === 0 && (entryUsAmt ?? 0) === 0 && (entryUsOrd ?? 0) === 0)) {
        const { platform: pk, unsplit } = resolveSingleOrCombinedPlat(usPbRows)
        const b = ensurePlatBucket(usByPlatform, pk, unsplit)
        if (entryUsAmt !== null) { b.amount += entryUsAmt; b.hasAmount = true } else b.missingAmountCount++
        if (entryUsOrd !== null) { b.count += entryUsOrd; b.hasCount = true } else b.missingCount++
      }
    }
  }

  const euDetected = euEntryCount > 0 || euSites.size > 0 || euTextHit
  const eurCurrencyOnlyHint = !euDetected && (eurOnNonEuSiteOnly || eurCurrencyWithoutSite)
  const usDetected = usEntryCount > 0 || usSites.size > 0 || usTextHit
  const usdCurrencyOnlyHint = !usDetected && usdOnNonUsSiteOnly

  const euPlatformVerdicts = [...euByPlatform.values()].map((b) => {
    const amt = b.hasAmount ? r2(b.amount) : null
    const cnt = b.hasCount ? b.count : null
    const exEur = amt !== null && amt > DAC7_EUR_THRESHOLD
    const exOrd = cnt !== null && cnt >= DAC7_TXN_THRESHOLD
    return {
      platform: b.platform,
      unsplitMultiPlatform: b.unsplitMultiPlatform,
      euSalesEur: amt,
      euOrderCount: cnt,
      exceedsEurThreshold: exEur,
      exceedsOrderThreshold: exOrd,
      exceedsThreshold: !b.unsplitMultiPlatform && (exEur || exOrd),
      unsplitExceedsAggregate: b.unsplitMultiPlatform && (exEur || exOrd),
    }
  })

  const usPlatformVerdicts = [...usByPlatform.values()].map((b) => {
    const amt = b.hasAmount ? r2(b.amount) : null
    const cnt = b.hasCount ? b.count : null
    const mUsd = amt !== null && amt > IRS_1099K_USD_THRESHOLD
    const mTxn = cnt !== null && cnt > IRS_1099K_TXN_THRESHOLD
    return {
      platform: b.platform,
      unsplitMultiPlatform: b.unsplitMultiPlatform,
      usSalesUsd: amt,
      usTransactionCount: cnt,
      meetsUsdThreshold: mUsd,
      meetsTxnThreshold: mTxn,
      meetsFederalDualThreshold: !b.unsplitMultiPlatform && mUsd && mTxn,
      unsplitExceedsAggregate: b.unsplitMultiPlatform && mUsd && mTxn,
    }
  })

  const euSalesBasis = (euRecordedEurCount > 0 && euEstimatedEurCount > 0)
    ? 'mixed_estimated'
    : euRecordedEurCount > 0
      ? 'recorded_orig'
      : euEstimatedEurCount > 0
        ? 'estimated_from_cny'
        : 'none'
  const euSalesEur = (euRecordedEurCount > 0 || euEstimatedEurCount > 0)
    ? r2(euRecordedEur + euEstimatedEur)
    : null

  const usSalesBasis = (usRecordedUsdCount > 0 && usEstimatedUsdCount > 0)
    ? 'mixed_estimated'
    : usRecordedUsdCount > 0
      ? 'recorded_orig'
      : usEstimatedUsdCount > 0
        ? 'estimated_from_cny'
        : 'none'
  const usSalesUsd = (usRecordedUsdCount > 0 || usEstimatedUsdCount > 0)
    ? r2(usRecordedUsd + usEstimatedUsd)
    : null

  return {
    euDetected,
    eurCurrencyOnlyHint,
    nonEuSitesWithEur: [...nonEuSitesWithEur].sort(),
    euSites: [...euSites].sort(),
    hasEurCurrency,
    euEntryCount,
    euSalesEur,
    euSalesBasis,
    euRecordedEur: r2(euRecordedEur),
    euEstimatedEur: r2(euEstimatedEur),
    euMissingAmountCount,
    euOrderCount: euOrderRecordedCount > 0 ? euOrderCount : null,
    euMissingOrderCount,
    euPlatformVerdicts,
    usDetected,
    usdCurrencyOnlyHint,
    nonUsSitesWithUsd: [...nonUsSitesWithUsd].sort(),
    usSites: [...usSites].sort(),
    hasUsdCurrency,
    usEntryCount,
    usSalesUsd,
    usSalesBasis,
    usRecordedUsd: r2(usRecordedUsd),
    usEstimatedUsd: r2(usEstimatedUsd),
    usMissingAmountCount,
    usTransactionCount: usTxnRecordedCount > 0 ? usTxnCount : null,
    usMissingTxnCount,
    usPlatformVerdicts,
  }
}

function buildThreeJurisdictionCards({
  year, quarters, annual, missingMonths, entries, thresholdApplicable, crossEntityMixed, hasUnclaimed, fxUsd, fxEur, byEntitySummaries = [],
}) {
  const nextYear = year + 1
  const deadline = `${nextYear}-01-31`
  const euExchangeDeadline = endOfFebruaryIsoUtc(nextYear)
  const usRecipientDeadline = nextBusinessDayIsoUtc(nextYear, 1, 31)
  const usPaperDeadline = nextBusinessDayIsoUtc(nextYear, 2, 28)
  const usEfileDeadline = nextBusinessDayIsoUtc(nextYear, 3, 31)
  const q4 = quarters[3]
  const sig = detectJurisdictionSignals(entries, fxUsd, fxEur)

  // 1) 中国国务院第 810 号令（平台每季报送上季；卖家全年四层口径勾稽为内部事项）
  const cnAlerts = []
  const cnDataGaps = []
  const cnChecklist = [
    `核对互联网平台企业按季报送的 ${year} Q4（10–12 月）涉税收入总额（平台报送截止 ${deadline}），确保佣金与履约费未直接冲减报送收入总额。`,
    `卖家全年四层口径勾稽为企业内部合规事项（平台报送参考口径 ↔ 财务会计收入 ↔ 增值税申报口径 ↔ 企业所得税口径），严禁直接按银行回款净额申报收入。`,
    '核对 Stage 2 结汇通道入账与 Stage 3 国内银行对公入账回单，逐笔留存结汇水单与跨期在途说明。',
  ]
  const declaredGapCny = annual.declaredGapCny
  const hasMajorDeclaredGap = declaredGapCny !== null && (
    Math.abs(declaredGapCny) > 50_000 ||
    (annual.declaredMatchedNetSalesCny > 0 && Math.abs(declaredGapCny) / annual.declaredMatchedNetSalesCny > 0.05)
  )
  const hasMinorDeclaredGap = declaredGapCny !== null && Math.abs(declaredGapCny) > 1_000

  if (crossEntityMixed) cnAlerts.push('【跨主体混算阻断】当前含多个不同法人/个体户主体，810 号令报送比对、500 万与 7,500 万门槛须按单个主体分别核算，严禁合并判定或合并申报。')
  if (hasUnclaimed) {
    cnDataGaps.push('存在「待认领」历史归档，主体归属尚未确认')
    cnAlerts.push('存在「待认领」历史归档，请先完成主体归属认领再合拢全年四层口径。')
  }
  if (q4.missingMonths.length > 0) {
    cnDataGaps.push(`Q4 缺失账期：${q4.missingMonths.join('、')}`)
    cnAlerts.push(`${year} Q4 缺失账期：${q4.missingMonths.join('、')}，请于 ${deadline} 平台季度报送核对前补导。`)
  }
  if (missingMonths.length > q4.missingMonths.length) {
    cnDataGaps.push(`全年共缺档 ${missingMonths.length} 个月（${missingMonths.join('、')}）`)
    cnAlerts.push(`全年共缺档 ${missingMonths.length} 个月（${missingMonths.join('、')}），年度合计尚未完整闭环（以下仅为已归档月份已知下限）。`)
  }
  if (annual.p0Count > 0) cnAlerts.push(`全年存在 ${annual.p0Count} 项 P0 阻断级异常（含私户收款/全托管混表/守恒失衡等），申报前须先剥离整改。`)
  if (hasMajorDeclaredGap) {
    cnAlerts.push(`双边同覆盖期（${annual.declaredMatchedMonthCount} 期）报送参考净额（¥${annual.declaredMatchedNetSalesCny.toFixed(2)}）与已录增值税申报额（¥${annual.declaredMatchedVatSalesCny.toFixed(2)}）差额 ¥${declaredGapCny.toFixed(2)}，请立即核查四层口径差异与跨期结转。`)
  } else if (hasMinorDeclaredGap) {
    cnAlerts.push(`双边同覆盖期（${annual.declaredMatchedMonthCount} 期）报送参考净额与已录增值税申报额存在差额 ¥${declaredGapCny.toFixed(2)}，建议留存退换货与汇率差调整底稿。`)
  }
  if (annual.declaredPendingMonthCount > 0) {
    cnDataGaps.push(`待补整月增值税已申报额 ${annual.declaredPendingMonthCount} 期（${annual.declaredPendingMonths.join('、')}），待补对应净销售额 ¥${annual.declaredPendingNetSalesCny.toFixed(2)}`)
    cnAlerts.push(`尚有 ${annual.declaredPendingMonthCount} 期未录入整月增值税已申报销售额（对应净销 ¥${annual.declaredPendingNetSalesCny.toFixed(2)}），未计入双边申报差额，请补录后终核。`)
  }
  if (annual.snapshotCount > 0 && annual.stage1to2PendingMonthCount > 0) {
    cnDataGaps.push(`待补 Stage 2 结汇通道流水 ${annual.stage1to2PendingMonthCount} 期（${annual.stage1to2PendingMonths.join('、')}），待补平台放款 ¥${annual.stage1to2PendingPayoutCny.toFixed(2)}`)
    cnAlerts.push(`尚有 ${annual.stage1to2PendingMonthCount} 期未录入 Stage 2 第三方结汇通道流水（对应放款 ¥${annual.stage1to2PendingPayoutCny.toFixed(2)}），三段资金链尚未完整闭环。`)
  }
  if (annual.snapshotCount > 0 && annual.stage3VerifiedCount === 0) {
    if ((annual.stage3UnmatchedCny ?? 0) > 0) {
      cnDataGaps.push(`Stage 3 银行回单仅部分核销（已完整核销 0 期，待核未匹配差额 ¥${annual.stage3UnmatchedCny.toFixed(2)}）`)
      cnAlerts.push(`全年已完整核销 Stage 3 月份为 0 期，尚有未核销在途/待核差额 ¥${annual.stage3UnmatchedCny.toFixed(2)}，请补齐国内对公银行回单后再确认资金闭环。`)
    } else {
      cnDataGaps.push(`全年尚未录入 Stage 3 国内银行对公实收回单（待补 ${annual.stage1to3PendingMonthCount} 期 / 放款 ¥${annual.stage1to3PendingPayoutCny.toFixed(2)}）`)
      cnAlerts.push('全年尚未录入 Stage 3 国内银行对公实收回单，请核对银行入账回单后再确认资金闭环。')
    }
  } else if (annual.stage1to3PendingMonthCount > 0 || (annual.stage3UnmatchedCny ?? 0) > 0) {
    const unmTxt = (annual.stage3UnmatchedCny ?? 0) > 0 ? `，其中部分核销待核差额 ¥${annual.stage3UnmatchedCny.toFixed(2)}` : ''
    cnDataGaps.push(`待补或未完整核销 Stage 3 银行回单 ${annual.stage1to3PendingMonthCount} 期（${annual.stage1to3PendingMonths.join('、')}），待核金额 ¥${annual.stage1to3PendingPayoutCny.toFixed(2)}${unmTxt}`)
    cnAlerts.push(`尚有 ${annual.stage1to3PendingMonthCount} 期未完成 Stage 3 银行回单全额核销（待核 ¥${annual.stage1to3PendingPayoutCny.toFixed(2)}${unmTxt}），请补齐回单后终核。`)
  }
  if (annual.stage1to2GapCny !== null && Math.abs(annual.stage1to2GapCny) > 0.01) {
    cnDataGaps.push(`Stage 1 平台放款与 Stage 2 结汇入账存在未解释差额 ¥${annual.stage1to2GapCny.toFixed(2)}`)
    cnAlerts.push(`已覆盖月份内 Stage 1 放款与 Stage 2 结汇存在差额 ¥${annual.stage1to2GapCny.toFixed(2)}，请核对跨月在途款项。`)
  }
  if (annual.stage2to3GapCny !== null && Math.abs(annual.stage2to3GapCny) > 0.01) {
    cnDataGaps.push(`Stage 2 结汇与 Stage 3 银行实收存在差额 ¥${annual.stage2to3GapCny.toFixed(2)}`)
    cnAlerts.push(`已覆盖月份内 Stage 2 结汇与 Stage 3 银行实收存在差额 ¥${annual.stage2to3GapCny.toFixed(2)}，请留存银行手续费与汇兑损益底稿。`)
  }
  if (thresholdApplicable && annual.cliff75mLevel === 'danger') cnAlerts.push(`单主体全年净销售 ¥${annual.netSalesCny.toFixed(2)} 超出 4% 核定假设下 7,500 万（300 万应纳税所得额）临界值，请核验小微税率跳变风险。`)
  else if (thresholdApplicable && annual.cliff75mLevel === 'warn') cnAlerts.push(`单主体全年净销售已达 7,500 万情景参考值的 ${annual.cliff75mPct}%，请提前评估纳税年度汇算口径。`)
  if (thresholdApplicable && annual.threshold5mLevel === 'danger') cnAlerts.push('单主体累计销售额已超 500 万一般纳税人登记参考线，请核验一般纳税人登记时限与进项专票筹划。')

  const cnStatus = annual.snapshotCount === 0
    ? 'pending_data'
    : (crossEntityMixed || annual.p0Count > 0 || hasMajorDeclaredGap || (thresholdApplicable && (annual.cliff75mLevel === 'danger' || annual.threshold5mLevel === 'danger')))
      ? 'danger'
      : (missingMonths.length > 0 || hasUnclaimed)
        ? 'pending_data'
        : (cnAlerts.length > 0 || annual.p1Count > 0 || cnDataGaps.length > 0)
          ? 'warn'
          : 'ok'

  const china810 = {
    id: 'china_810',
    jurisdiction: 'CN',
    title: `中国 · 国务院 810 号令（平台按季报送与卖家全年内部勾稽）`,
    deadline,
    reporter: '互联网平台企业（每季终了次月内向税务机关报送上季涉税信息）；卖家全年四层口径勾稽为企业内部自查事项',
    scheduleNote: `平台每季报送上季（${year} Q4 报送截止 ${deadline}）；卖家全年四层口径勾稽为内部合规事项。`,
    policyRef: '国务院令第 810 号 / 国家税务总局公告 2025 年第 15 号',
    status: cnStatus,
    triggered: annual.snapshotCount > 0,
    dataComplete: cnDataGaps.length === 0 && annual.snapshotCount > 0,
    dataGaps: cnDataGaps,
    summary: annual.snapshotCount === 0
      ? `尚无 ${year} 年归档记录，请先导入月度账单。`
      : cnAlerts[0] || `${year} 全年 12 期齐备且未检出 P0 阻断项，请按四层口径完成内部年度勾稽。`,
    metrics: {
      q4NetSalesCny: q4.netSalesCny,
      q4GrossCny: q4.grossCny,
      q4MissingMonths: q4.missingMonths,
      annualGrossCny: annual.grossCny,
      annualNetSalesCny: annual.netSalesCny,
      annualPayoutCny: annual.payoutCny,
      annualDeclaredVatSalesCny: annual.declaredVatSalesCny,
      declaredGapCny,
      declaredMatchedMonthCount: annual.declaredMatchedMonthCount,
      declaredPendingMonthCount: annual.declaredPendingMonthCount,
      declaredPendingNetSalesCny: annual.declaredPendingNetSalesCny,
      stage1to2GapCny: annual.stage1to2GapCny,
      stage1to2PendingMonthCount: annual.stage1to2PendingMonthCount,
      stage1to2PendingPayoutCny: annual.stage1to2PendingPayoutCny,
      stage1to3GapCny: annual.stage1to3GapCny,
      stage1to3MatchedMonthCount: annual.stage1to3MatchedMonthCount,
      stage1to3PendingMonthCount: annual.stage1to3PendingMonthCount,
      stage1to3PendingPayoutCny: annual.stage1to3PendingPayoutCny,
      stage3VerifiedCount: annual.stage3VerifiedCount,
      stage3FullVerifiedMonthCount: annual.stage3FullVerifiedMonthCount,
      stage3UnmatchedCny: annual.stage3UnmatchedCny,
      p0Count: annual.p0Count,
      p1Count: annual.p1Count,
      thresholdApplicable,
      threshold5mPct: annual.threshold5mPct,
      cliff75mPct: annual.cliff75mPct,
    },
    alerts: cnAlerts,
    checklist: cnChecklist,
  }

  // 2) 欧盟 DAC7（平台报送 2027-01-31 vs 主管机关自动交换分期 2027-02-28；纯 UK+EUR 不误触；多主体不合并判门槛）
  const euAlerts = []
  const euDataGaps = []
  let euExceeds = false
  let euStatus = 'not_applicable'
  const euEntityVerdicts = crossEntityMixed
    ? byEntitySummaries
        .filter((be) => be.threeJurisdictions?.euDac7?.triggered)
        .map((be) => ({
          entityKey: be.entityKey,
          entityLabel: be.entityLabel,
          status: be.threeJurisdictions.euDac7.status,
          exceedsThreshold: be.threeJurisdictions.euDac7.metrics.exceedsThreshold,
          euSalesEur: be.threeJurisdictions.euDac7.metrics.euSalesEur,
          euOrderCount: be.threeJurisdictions.euDac7.metrics.euOrderCount,
        }))
    : []

  if (!sig.euDetected) {
    euExceeds = false
    euStatus = 'not_applicable'
    if (sig.eurCurrencyOnlyHint) {
      const siteHint = sig.nonEuSitesWithEur.length ? `非欧盟站点（${sig.nonEuSitesWithEur.join('/')}）` : '站点未标明的归档'
      euAlerts.push(`仅作人工核查提示：检出 ${siteHint} 使用 EUR 结算，因未检出欧盟 27 国站点，不自动触发欧盟 DAC7 红线；请另行核实卖家税务居民地、平台报告义务归属及英国 UK/OECD DPI 报送规则。`)
    }
  } else if (crossEntityMixed) {
    euExceeds = null
    euStatus = 'warn'
    const dangerEnts = euEntityVerdicts.filter((v) => v.status === 'danger')
    euAlerts.push(
      `【跨主体混算保护】当前包含多个独立法人主体，严禁合并不同主体的 EUR 金额或订单笔数判定欧盟 DAC7 门槛（> €${DAC7_EUR_THRESHOLD} 或 ≥ ${DAC7_TXN_THRESHOLD} 笔）；请按分主体拆表（byEntity）逐一核对。` +
      (dangerEnts.length ? `（其中单独触发的主体：${dangerEnts.map((x) => x.entityLabel).join('、')}）` : '（当前各独立主体均未单独触发 DAC7 高危门槛）'),
    )
  } else {
    if (hasUnclaimed) euDataGaps.push('存在「待认领」归档，主体归属未确认')
    if (missingMonths.length > 0) euDataGaps.push(`全年缺档 ${missingMonths.length} 个月（${missingMonths.join('、')}）`)
    if (sig.euMissingAmountCount > 0 || sig.euSalesEur === null) euDataGaps.push(`${sig.euMissingAmountCount || 1} 份欧盟快照缺少原币 EUR 金额`)
    if (sig.euMissingOrderCount > 0 || sig.euOrderCount === null) euDataGaps.push(`${sig.euMissingOrderCount || 1} 份欧盟快照缺少订单笔数`)

    const euDataComplete = euDataGaps.length === 0
    const euSingleDangerPlats = sig.euPlatformVerdicts.filter((v) => v.exceedsThreshold === true)
    const euAnySingleExceeds = euSingleDangerPlats.length > 0
    const euAggregateExceeds = (sig.euSalesEur !== null && sig.euSalesEur > DAC7_EUR_THRESHOLD) ||
      (sig.euOrderCount !== null && sig.euOrderCount >= DAC7_TXN_THRESHOLD)

    if (!hasUnclaimed && euAnySingleExceeds) {
      euExceeds = true
      euStatus = 'danger'
      const platListTxt = euSingleDangerPlats.map((v) => v.platform).join('、')
      euAlerts.push(`已检出欧盟站点业务${sig.euSites.length ? `（${sig.euSites.join('/')}）` : ''}，且单一报告平台（${platListTxt}）已知累计触发 DAC7 年度核对门槛（> €${DAC7_EUR_THRESHOLD} 或 ≥ ${DAC7_TXN_THRESHOLD} 笔）；报告平台运营方须于 ${deadline} 前向欧盟成员国主管机关报送，各主管机关自动交换分期截止 ${euExchangeDeadline}。`)
      if (!euDataComplete) {
        euAlerts.push(`资料尚有缺口（${euDataGaps.join('；')}），当前数值为已知下限，完整年度金额/笔数可能更高。`)
      }
    } else if (!hasUnclaimed && euAggregateExceeds && !euAnySingleExceeds) {
      euExceeds = euDataComplete ? false : null
      euStatus = euDataComplete ? 'warn' : 'pending_data'
      const perPlatTxt = sig.euPlatformVerdicts
        .map((v) => `${v.platform}: €${(v.euSalesEur ?? 0).toFixed(2)}/${v.euOrderCount ?? 0}笔`)
        .join('、')
      euAlerts.push(
        `【跨平台汇总预警 · 按单平台分别判定】全主体跨平台欧盟汇总 €${(sig.euSalesEur ?? 0).toFixed(2)} / ${sig.euOrderCount ?? 0} 笔已超参考线，但欧盟 DAC7 排除卖家门槛（> €${DAC7_EUR_THRESHOLD} 或 ≥ ${DAC7_TXN_THRESHOLD} 笔）按单一报告平台运营方分别判定，当前尚无单一独立平台超线（${perPlatTxt}）；请核实各平台集团内多站点是否合并报送并留存回执。`,
      )
      if (!euDataComplete) {
        euAlerts.push(`资料尚有缺口（${euDataGaps.join('；')}），补齐全部月份与笔数后请复核各平台门槛。`)
      }
    } else if (!euDataComplete) {
      euExceeds = null
      euStatus = 'pending_data'
      const lbEur = sig.euSalesEur !== null ? `已知下限 €${sig.euSalesEur.toFixed(2)}` : '金额待补'
      const lbOrd = sig.euOrderCount !== null ? `已知下限 ${sig.euOrderCount} 笔` : '笔数待补'
      euAlerts.push(`已检出欧盟站点业务${sig.euSites.length ? `（${sig.euSites.join('/')}）` : ''}（${lbEur} / ${lbOrd}），但覆盖不全（${euDataGaps.join('；')}），严禁判定“未触发”，须补齐全部月份与原币/笔数后复核 €${DAC7_EUR_THRESHOLD} 或 ${DAC7_TXN_THRESHOLD} 笔门槛。`)
    } else {
      euExceeds = false
      euStatus = 'ok'
    }

    if (sig.euSalesBasis === 'mixed_estimated') {
      euAlerts.push(`当前 EUR 金额合并了原币记录（€${sig.euRecordedEur.toFixed(2)}）与按参考汇率折算估算月份（€${sig.euEstimatedEur.toFixed(2)}，口径 mixed_estimated），请以平台后台原币 EUR 结算报表为准。`)
    } else if (sig.euSalesBasis === 'estimated_from_cny') {
      euAlerts.push('当前 EUR 金额系按参考汇率折算估算，请以平台后台原币 EUR 结算报表为准。')
    }
  }

  const euDac7 = {
    id: 'eu_dac7',
    jurisdiction: 'EU',
    title: `欧盟 · DAC7 平台年度涉税数据报送自检（平台报送 ${deadline} / 主管机关交换 ${euExchangeDeadline}）`,
    deadline,
    platformReportDeadline: deadline,
    authorityExchangeDeadline: euExchangeDeadline,
    reporter: '报告平台运营方（Reporting Platform Operator）',
    scheduleNote: `平台向成员国主管税务机关报送截止 ${deadline}；成员国主管机关自动交换分期截止 ${euExchangeDeadline}。`,
    policyRef: 'EU Council Directive (EU) 2021/514 (DAC7)',
    status: euStatus,
    triggered: sig.euDetected,
    dataComplete: sig.euDetected ? (!crossEntityMixed && euDataGaps.length === 0) : missingMonths.length === 0,
    dataGaps: euDataGaps,
    summary: !sig.euDetected
      ? (sig.eurCurrencyOnlyHint
        ? euAlerts[0]
        : `本年度已归档记录未检出欧盟 27 国站点信号${missingMonths.length > 0 ? `（尚缺 ${missingMonths.length} 个月账单，补齐后请复核）` : ''}。`)
      : euAlerts[0] || `已检出欧盟 27 国业务且全年 12 期原币与笔数齐备，低于 €${DAC7_EUR_THRESHOLD} 且不足 ${DAC7_TXN_THRESHOLD} 笔，请留存平台回执复核。`,
    metrics: {
      euDetected: sig.euDetected,
      eurCurrencyOnlyHint: sig.eurCurrencyOnlyHint,
      nonEuSitesWithEur: sig.nonEuSitesWithEur,
      euSites: sig.euSites,
      hasEurCurrency: sig.hasEurCurrency,
      euSalesEur: sig.euSalesEur,
      euSalesBasis: sig.euSalesBasis,
      euRecordedEur: sig.euRecordedEur,
      euEstimatedEur: sig.euEstimatedEur,
      euOrderCount: sig.euOrderCount,
      euMissingAmountCount: sig.euMissingAmountCount,
      euMissingOrderCount: sig.euMissingOrderCount,
      knownLowerBound: sig.euDetected && euDataGaps.length > 0,
      thresholdApplicable: !crossEntityMixed && !hasUnclaimed,
      crossEntityMixed,
      thresholdEur: DAC7_EUR_THRESHOLD,
      thresholdOrders: DAC7_TXN_THRESHOLD,
      exceedsThreshold: euExceeds,
      platformVerdicts: sig.euPlatformVerdicts,
      ...(crossEntityMixed ? { entityVerdicts: euEntityVerdicts } : {}),
    },
    alerts: euAlerts,
    checklist: [
      `平台报送截止 ${deadline}，成员国主管机关自动信息交换分期截止 ${euExchangeDeadline}；请向各欧盟平台下载 DAC7 年度卖家信息副本（含每季度对价 Consideration、扣除佣金及代扣 VAT）。`,
      '核对欧盟公司主体、VAT 税号/OSS/IOSS 申报表与平台 DAC7 报送金额，避免因平台代扣税/退款时间差引发税务问询。',
      '注意：英国脱欧后适用 UK/OECD DPI 规则（非欧盟 DAC7）；仅 UK 站点使用 EUR 结算时不按欧盟站点自动触发，但须另核卖家税务居民地与平台报告义务归属。',
    ],
  }

  // 3) 美国 IRS Form 1099-K（TPSO 联邦双门槛 >$20,000 且 >200 笔，支付卡收单另行处理；2027-01-31 周日收款人联顺延 2027-02-01、电子报送 IRS 2027-03-31）
  const usAlerts = []
  const usDataGaps = []
  let meetsUsd = null
  let meetsTxn = null
  let meetsFederalDual = false
  let stateThresholdWarning = false
  let usStatus = 'not_applicable'
  const usEntityVerdicts = crossEntityMixed
    ? byEntitySummaries
        .filter((be) => be.threeJurisdictions?.us1099k?.triggered)
        .map((be) => ({
          entityKey: be.entityKey,
          entityLabel: be.entityLabel,
          status: be.threeJurisdictions.us1099k.status,
          meetsFederalDualThreshold: be.threeJurisdictions.us1099k.metrics.meetsFederalDualThreshold,
          usSalesUsd: be.threeJurisdictions.us1099k.metrics.usSalesUsd,
          usTransactionCount: be.threeJurisdictions.us1099k.metrics.usTransactionCount,
        }))
    : []

  if (!sig.usDetected) {
    usStatus = 'not_applicable'
    if (sig.usdCurrencyOnlyHint) {
      const siteHint = sig.nonUsSitesWithUsd.length ? `非美国站点（${sig.nonUsSitesWithUsd.join('/')}）` : '非美站点'
      usAlerts.push(`仅作人工核查提示：检出 ${siteHint} 使用 USD 结算，因未检出美国站点，不自动计入美国 IRS Form 1099-K 门槛；若涉及美国境内 TPSO/PSE 收单请另核 W-8BEN-E 有效性。`)
    }
  } else if (crossEntityMixed) {
    meetsUsd = null
    meetsTxn = null
    meetsFederalDual = false
    stateThresholdWarning = false
    usStatus = 'warn'
    const dangerEnts = usEntityVerdicts.filter((v) => v.status === 'danger')
    usAlerts.push(
      `【跨主体混算保护】当前包含多个独立法人主体，严禁合并多主体 USD 金额或笔数判定 IRS 1099-K 联邦 TPSO 双门槛（>$20,000 且 >200 笔）或州级门槛；以下总额仅作多主体参考汇总，请按分主体拆表（byEntity）独立核对！` +
      (dangerEnts.length ? `（单独触发联邦双门槛的主体：${dangerEnts.map((x) => x.entityLabel).join('、')}）` : '（当前各独立主体均未单独触发联邦双门槛）'),
    )
  } else {
    if (hasUnclaimed) usDataGaps.push('存在「待认领」归档，主体归属未确认')
    if (missingMonths.length > 0) usDataGaps.push(`全年缺档 ${missingMonths.length} 个月（${missingMonths.join('、')}）`)
    if (sig.usMissingAmountCount > 0 || sig.usSalesUsd === null) usDataGaps.push(`${sig.usMissingAmountCount || 1} 份美国快照缺少原币 USD 金额`)
    if (sig.usMissingTxnCount > 0 || sig.usTransactionCount === null) usDataGaps.push(`${sig.usMissingTxnCount || 1} 份美国快照缺少交易笔数`)

    const usDataComplete = usDataGaps.length === 0
    const usSingleDualPlats = sig.usPlatformVerdicts.filter((v) => v.meetsFederalDualThreshold === true)
    const usAnySingleUsd = sig.usPlatformVerdicts.some((v) => !v.unsplitMultiPlatform && v.meetsUsdThreshold === true)
    const usAnySingleTxn = sig.usPlatformVerdicts.some((v) => !v.unsplitMultiPlatform && v.meetsTxnThreshold === true)
    const usAggregateDual = (sig.usSalesUsd !== null && sig.usSalesUsd > IRS_1099K_USD_THRESHOLD) &&
      (sig.usTransactionCount !== null && sig.usTransactionCount > IRS_1099K_TXN_THRESHOLD)

    meetsUsd = usAnySingleUsd ? true : usDataComplete ? false : null
    meetsTxn = usAnySingleTxn ? true : usDataComplete ? false : null
    meetsFederalDual = !hasUnclaimed && usSingleDualPlats.length > 0
    stateThresholdWarning = sig.usSalesUsd === null || sig.usSalesUsd >= IRS_1099K_STATE_MIN_USD

    if (meetsFederalDual) {
      usStatus = 'danger'
      const tpsoNames = usSingleDualPlats.map((v) => v.platform).join('、')
      usAlerts.push(`单一结算机构（${tpsoNames}）已同时超过 OBBBA 恢复后的 IRS 1099-K 联邦 TPSO 双门槛（>$20,000 且 >200 笔，全主体汇总 $${sig.usSalesUsd.toFixed(2)} / ${sig.usTransactionCount} 笔）；TPSO 收款人联截止 ${usRecipientDeadline}（${deadline} 逢周末顺延），电子报送 IRS 通常截止 ${usEfileDeadline}（支付卡收单另行按实报送）。`)
      if (!usDataComplete) {
        usAlerts.push(`资料尚有缺口（${usDataGaps.join('；')}），当前金额与笔数为已知下限，全年实际值可能更高。`)
      }
    } else if (!hasUnclaimed && usAggregateDual && usSingleDualPlats.length === 0) {
      usStatus = usDataComplete ? 'warn' : 'pending_data'
      const perTpsoTxt = sig.usPlatformVerdicts
        .map((v) => `${v.platform}: $${(v.usSalesUsd ?? 0).toFixed(2)}/${v.usTransactionCount ?? 0}笔`)
        .join('、')
      usAlerts.push(
        `【跨 TPSO 汇总参考 · 按单机构分别判定】全主体跨机构汇总 $${sig.usSalesUsd.toFixed(2)} / ${sig.usTransactionCount} 笔虽超参考线，但 IRS Form 1099-K 联邦双门槛（>$20,000 且 >200 笔）按单一 TPSO 结算机构分别判定，当前无单一机构同时达标（${perTpsoTxt}）；仍须核对低门槛州（$600/$1,000）及支付卡收单（PSE）报送。`,
      )
      if (!usDataComplete) {
        usAlerts.push(`资料尚有缺口（${usDataGaps.join('；')}），补齐全部月份与笔数后请逐机构复核。`)
      }
    } else if (!usDataComplete) {
      usStatus = 'pending_data'
      const lbUsd = sig.usSalesUsd !== null ? `已知下限 $${sig.usSalesUsd.toFixed(2)}` : '金额待补'
      const lbTxn = sig.usTransactionCount !== null ? `已知下限 ${sig.usTransactionCount} 笔` : '笔数待补'
      usAlerts.push(`已检出美国/USD 收款（${lbUsd} / ${lbTxn}），但覆盖不全（${usDataGaps.join('；')}），严禁判定“未触发”，须补齐全部月份、原币金额与交易笔数后复核联邦 TPSO 双门槛（>$20,000 且 >200 笔）。`)
      if (stateThresholdWarning) {
        usAlerts.push('州级提醒：部分美国州（如 MD/MA/VT/VA $600、IL/NJ $1,000）门槛显著低于联邦双门槛，仍可能收到平台/支付机构出具的 1099-K，请逐州核对。')
      }
    } else if (meetsUsd === true && meetsTxn === false) {
      usStatus = 'warn'
      usAlerts.push(`美国/USD 收款 $${sig.usSalesUsd.toFixed(2)} 超过 $20,000，但交易笔数（${sig.usTransactionCount} 笔）未超 200 笔，未同时满足 OBBBA 联邦 TPSO 双门槛；但部分美国州门槛更低（低至 $600），且支付卡收单无最低门槛，仍须核对州级与支付卡 1099-K！`)
    } else if (meetsUsd === false && meetsTxn === true) {
      usStatus = 'warn'
      usAlerts.push(`美国交易笔数（${sig.usTransactionCount} 笔）超 200 笔，但金额 $${sig.usSalesUsd.toFixed(2)} 未超 $20,000，未满足联邦 TPSO 双门槛；须重点核对部分美国州更低门槛（如 $600 / $1,000）及支付卡收单报送。`)
    } else if (stateThresholdWarning) {
      usStatus = 'warn'
      usAlerts.push(`未触发 OBBBA 联邦 TPSO $20,000 且 >200 笔双门槛，但部分美国州（如 MD/MA/VT/VA $600、IL/NJ $1,000）门槛显著更低，且支付卡收单另行处理，仍可能收到平台 1099-K，请逐州核对。`)
    } else {
      usStatus = 'ok'
    }

    if (sig.usSalesBasis === 'mixed_estimated') {
      usAlerts.push(`当前 USD 金额合并了原币记录（$${sig.usRecordedUsd.toFixed(2)}）与按参考汇率折算估算月份（$${sig.usEstimatedUsd.toFixed(2)}，口径 mixed_estimated），请以美国平台/支付网关原币 USD 总收款（Unadjusted Gross）为准。`)
    } else if (sig.usSalesBasis === 'estimated_from_cny') {
      usAlerts.push('当前 USD 金额系按参考汇率估算，请以美国平台/支付网关原币 USD 总收款（Unadjusted Gross）为准。')
    }
  }

  const usScheduleNote = usRecipientDeadline !== deadline
    ? `收款人联因 ${deadline} 逢周末顺延至 ${usRecipientDeadline}；电子报送 IRS 通常截止 ${usEfileDeadline}（纸质 ${usPaperDeadline}）。`
    : `收款人联截止 ${usRecipientDeadline}；电子报送 IRS 通常截止 ${usEfileDeadline}（纸质 ${usPaperDeadline}）。`

  const us1099k = {
    id: 'us_1099k',
    jurisdiction: 'US',
    title: `美国 · IRS Form 1099-K（收款人联 ${usRecipientDeadline} / IRS 电子报送 ${usEfileDeadline}）`,
    deadline: usRecipientDeadline,
    recipientDeadline: usRecipientDeadline,
    irsPaperDeadline: usPaperDeadline,
    irsEfileDeadline: usEfileDeadline,
    reporter: '第三方结算机构（TPSO，如电商平台/PayPal）或支付卡收单机构（PSE）',
    paymentScopeNote: '联邦双门槛（>$20,000 且 >200 笔）仅适用 TPSO 第三方结算网络交易；支付卡收单（Payment Card / PSE）无联邦最低金额或笔数门槛，另行处理。',
    scheduleNote: usScheduleNote,
    policyRef: 'IRC §6050W（OBBBA 恢复 TPSO 联邦 >$20,000 且 >200 笔双门槛；支付卡收单另行处理；部分州门槛低至 $600）',
    status: usStatus,
    triggered: sig.usDetected,
    dataComplete: sig.usDetected ? (!crossEntityMixed && usDataGaps.length === 0) : missingMonths.length === 0,
    dataGaps: usDataGaps,
    summary: !sig.usDetected
      ? (sig.usdCurrencyOnlyHint
        ? usAlerts[0]
        : `本年度已归档记录未检出美国站点或 USD 交易信号${missingMonths.length > 0 ? `（尚缺 ${missingMonths.length} 个月账单，补齐后请复核）` : ''}。`)
      : usAlerts[0] || `美国/USD 全年 12 期原币与笔数齐备，低于 TPSO 联邦 $20,000/200 笔双门槛及常见州级 $600 起点（支付卡收单另核），请核实 W-8BEN-E 有效性。`,
    metrics: {
      usDetected: sig.usDetected,
      usdCurrencyOnlyHint: sig.usdCurrencyOnlyHint,
      nonUsSitesWithUsd: sig.nonUsSitesWithUsd,
      usSites: sig.usSites,
      hasUsdCurrency: sig.hasUsdCurrency,
      usSalesUsd: sig.usSalesUsd,
      usSalesBasis: sig.usSalesBasis,
      usRecordedUsd: sig.usRecordedUsd,
      usEstimatedUsd: sig.usEstimatedUsd,
      usTransactionCount: sig.usTransactionCount,
      usMissingAmountCount: sig.usMissingAmountCount,
      usMissingTxnCount: sig.usMissingTxnCount,
      knownLowerBound: sig.usDetected && usDataGaps.length > 0,
      thresholdApplicable: !crossEntityMixed && !hasUnclaimed,
      crossEntityMixed,
      federalUsdThreshold: IRS_1099K_USD_THRESHOLD,
      federalTxnThreshold: IRS_1099K_TXN_THRESHOLD,
      stateMinUsdThreshold: IRS_1099K_STATE_MIN_USD,
      meetsUsdThreshold: meetsUsd,
      meetsTxnThreshold: meetsTxn,
      meetsFederalDualThreshold: meetsFederalDual,
      stateThresholdWarning,
      platformVerdicts: sig.usPlatformVerdicts,
      ...(crossEntityMixed ? { entityVerdicts: usEntityVerdicts } : {}),
    },
    alerts: usAlerts,
    checklist: [
      `区分交易类型与期限：TPSO 适用联邦 >$20,000 且 >200 笔双门槛，支付卡收单（PSE）另行无门槛报送；${usScheduleNote}`,
      `额外排查美国州级更低门槛（如 MD/MA/VT/VA $600、IL/NJ $1,000），非美实体务必确认 Amazon / PayPal / Stripe / Walmart 后台 Form W-8BEN-E 在有效期内。`,
      `若收到 ${year} 年度 Form 1099-K（Box 1a 未调整毛收款含运费、税费及退款前总额），务必与月度账单毛额和退款/费用桥接勾稽。`,
    ],
  }

  return { deadline, china810, euDac7, us1099k, cards: [china810, euDac7, us1099k] }
}

function aggregateYearScope({ year, entries, thresholdApplicable, crossEntityMixed, hasUnclaimed, fxUsd, fxEur, byEntitySummaries = [] }) {
  const byMonthMap = new Map()
  for (const e of entries) {
    if (!byMonthMap.has(e.month)) byMonthMap.set(e.month, [])
    byMonthMap.get(e.month).push(e)
  }

  const coveredMonths = []
  const missingMonths = []
  const zeroSalesMonths = []
  const monthlySeries = []

  const quarters = QUARTERS.map((qDef) => {
    const qMonthIds = qDef.months.map((mm) => `${year}-${mm}`)
    const qEntries = []
    const qCovered = []
    const qMissing = []
    const qZero = []
    for (const ym of qMonthIds) {
      const list = byMonthMap.get(ym) || []
      if (list.length === 0) {
        qMissing.push(ym)
        missingMonths.push(ym)
        monthlySeries.push({
          month: ym, quarter: qDef.quarter, status: 'missing', snapshotCount: 0,
          grossCny: 0, refundCny: 0, netSalesCny: 0, feesCny: 0, payoutCny: 0,
          stage2WalletInboundCny: null, stage3BankReceivedCny: null, p0Count: 0, p1Count: 0, p2Count: 0,
        })
      } else {
        qEntries.push(...list)
        qCovered.push(ym)
        coveredMonths.push(ym)
        const mSum = summarizeBucket(list)
        const isZero = mSum.netSalesCny === 0 && list.some((x) => x.zeroSalesConfirmed)
        if (isZero) {
          qZero.push(ym)
          zeroSalesMonths.push(ym)
        }
        monthlySeries.push({
          month: ym, quarter: qDef.quarter, status: isZero ? 'zero_confirmed' : 'recorded',
          snapshotCount: mSum.snapshotCount, grossCny: mSum.grossCny, refundCny: mSum.refundCny,
          netSalesCny: mSum.netSalesCny, feesCny: mSum.feesCny, payoutCny: mSum.payoutCny,
          stage2WalletInboundCny: mSum.stage2WalletInboundCny, stage3BankReceivedCny: mSum.stage3BankReceivedCny,
          p0Count: mSum.p0Count, p1Count: mSum.p1Count, p2Count: mSum.p2Count,
        })
      }
    }
    const qSum = summarizeBucket(qEntries)
    return {
      quarter: qDef.quarter,
      label: qDef.label,
      months: qMonthIds,
      coveredMonths: qCovered,
      missingMonths: qMissing,
      zeroSalesMonths: qZero,
      ...qSum,
      byPlatform: aggregatePlatforms(qEntries, qSum.netSalesCny),
    }
  })

  const annualSum = summarizeBucket(entries)
  const threshold5mPct = thresholdApplicable ? r2((annualSum.netSalesCny / THRESHOLD_5M) * 100) : null
  const threshold5mLevel = !thresholdApplicable ? null
    : annualSum.netSalesCny > THRESHOLD_5M ? 'danger'
      : annualSum.netSalesCny >= THRESHOLD_5M_WARN ? 'warn' : 'safe'
  const cliff75mPct = thresholdApplicable ? r2((annualSum.netSalesCny / CLIFF_75M) * 100) : null
  const cliff75mLevel = !thresholdApplicable ? null
    : annualSum.netSalesCny > CLIFF_75M ? 'danger'
      : annualSum.netSalesCny >= CLIFF_75M_WARN ? 'warn' : 'safe'

  const annual = {
    referenceOnly: crossEntityMixed,
    ...annualSum,
    coveredMonthCount: coveredMonths.length,
    missingMonthCount: missingMonths.length,
    zeroSalesMonthCount: zeroSalesMonths.length,
    threshold5mPct,
    threshold5mLevel,
    cliff75mPct,
    cliff75mLevel,
  }
  const byPlatform = aggregatePlatforms(entries, annual.netSalesCny)
  const threeJurisdictions = buildThreeJurisdictionCards({
    year, quarters, annual, missingMonths, entries, thresholdApplicable, crossEntityMixed, hasUnclaimed, fxUsd, fxEur, byEntitySummaries,
  })
  const missingMonthsNote = missingMonths.length === 0
    ? `${year} 年 12 个自然月账单已全部覆盖（含确认零收入 ${zeroSalesMonths.length} 月）。`
    : `${year} 年已覆盖 ${coveredMonths.length}/12 个月，缺失 ${missingMonths.length} 个月账单：${missingMonths.join('、')}（缺档月份未计入年度合计，请补导后复核年度红线）。`

  return { coveredMonths, missingMonths, zeroSalesMonths, missingMonthsNote, monthlySeries, quarters, annual, byPlatform, threeJurisdictions }
}

/**
 * 自然年 Q1–Q4 全年汇总（含缺失月份提示、三段实收缺口、跨主体混算保护与 2027-01-31 三地报送自检）。
 */
export function buildAnnualSummary(storeOrList, options = {}) {
  let rawEntries
  let opts = options || {}
  if (Array.isArray(storeOrList)) {
    rawEntries = storeOrList.map(hydrateEntry)
  } else if (storeOrList && typeof storeOrList === 'object' && Array.isArray(storeOrList.entries)) {
    rawEntries = hydrateListStrict(storeOrList.entries)
  } else if (
    storeOrList && typeof storeOrList === 'object' &&
    !('filePath' in storeOrList) && !('path' in storeOrList) &&
    typeof storeOrList.load !== 'function' && typeof storeOrList.read !== 'function' &&
    typeof storeOrList.getEntries !== 'function' &&
    ('year' in storeOrList || 'entityKey' in storeOrList || 'entityName' in storeOrList || 'shopKey' in storeOrList)
  ) {
    opts = storeOrList
    rawEntries = resolveStore(null).load()
  } else {
    rawEntries = resolveStore(storeOrList).load()
  }

  const year = normalizeYear(opts.year, rawEntries)
  const fxUsd = Number.isFinite(Number(opts.fxRateUsdToCny)) && Number(opts.fxRateUsdToCny) > 0 ? Number(opts.fxRateUsdToCny) : DEFAULT_USD_TO_CNY
  const fxEur = Number.isFinite(Number(opts.fxRateEurToCny)) && Number(opts.fxRateEurToCny) > 0 ? Number(opts.fxRateEurToCny) : DEFAULT_EUR_TO_CNY
  const asOfDate = typeof opts.asOfDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.asOfDate)
    ? opts.asOfDate
    : new Date().toISOString().slice(0, 10)

  const yearEntriesAll = rawEntries.filter((e) => e.month.startsWith(`${year}-`))
  const explicitEntityKeyFilter = opts.entityKey !== undefined && opts.entityKey !== null && String(opts.entityKey).trim() !== ''
  const entityFilterRaw = explicitEntityKeyFilter
    ? String(opts.entityKey).trim()
    : String(opts.entityName ?? opts.entity ?? '').trim()
  const shopFilterRaw = String(opts.shopKey ?? opts.storeScope ?? opts.shop ?? '').trim()
  const entityFilterNorm = entityFilterRaw ? (isUnclaimedMarker(entityFilterRaw) ? UNCLAIMED_ENTITY_KEY : normIdentityPart(entityFilterRaw)) : null
  const shopFilterNorm = shopFilterRaw ? normIdentityPart(shopFilterRaw) : null

  const summarizeEntities = (list) => {
    const m = new Map()
    for (const e of list) {
      const cur = m.get(e.entityKey) || { entityKey: e.entityKey, entityLabel: e.entityLabel, ownershipStatus: e.ownershipStatus, snapshotCount: 0 }
      cur.snapshotCount++
      m.set(e.entityKey, cur)
    }
    return [...m.values()].sort((a, b) => (a.ownershipStatus === 'unclaimed' ? 1 : b.ownershipStatus === 'unclaimed' ? -1 : a.entityLabel.localeCompare(b.entityLabel)))
  }

  const availableEntities = summarizeEntities(yearEntriesAll)
  const scoped = yearEntriesAll.filter((e) => {
    if (entityFilterNorm) {
      const matchEntity = explicitEntityKeyFilter
        ? (entityFilterNorm === UNCLAIMED_ENTITY_KEY ? e.ownershipStatus === 'unclaimed' : e.entityKey === entityFilterNorm)
        : (e.entityKey === entityFilterNorm ||
            normIdentityPart(e.entityLabel) === entityFilterNorm ||
            normIdentityPart(e.entityName) === entityFilterNorm ||
            (entityFilterNorm === UNCLAIMED_ENTITY_KEY && e.ownershipStatus === 'unclaimed'))
      if (!matchEntity) return false
    }
    if (shopFilterNorm) {
      const matchShop = e.shopKey === shopFilterNorm || normIdentityPart(e.storeScope) === shopFilterNorm
      if (!matchShop) return false
    }
    return true
  })

  const scopedEntities = summarizeEntities(scoped)
  // 严格按实际去重后的唯一 entityKey 数量判混算（即使传入显示名称筛选，两个不同 entityKey 共用同名时仍须判混算！）
  const crossEntityMixed = scopedEntities.length > 1
  const unclaimedCount = scoped.filter((e) => e.ownershipStatus === 'unclaimed').length
  const hasUnclaimed = unclaimedCount > 0
  const declarable = scoped.length > 0 && !crossEntityMixed && !hasUnclaimed && scopedEntities.length === 1
  const thresholdApplicable = declarable

  const mixingProtectionWarning = crossEntityMixed
    ? `【跨主体混算保护 · 不可直接合并申报】${year} 年度当前范围包含 ${scopedEntities.length} 个不同法人/主体键（${scopedEntities.map((x) => `${x.entityLabel}[${x.entityKey}]`).join('、')}）。不同法人/个体户的销售额、810 号令、500 万/7,500 万、EU DAC7 与 US IRS 1099-K 门槛绝对不可合并判定或合并申报，已按主体独立拆表，请按稳定 entityKey 切换至单一主体核算！`
    : null
  const unclaimedWarning = hasUnclaimed
    ? `【存在待认领归档】当前范围含 ${unclaimedCount} 份「待认领」历史快照，请使用一键主体重分配功能将其归入对应法人主体，避免漏算或错算。`
    : null

  const byEntity = scopedEntities.map((ent) => {
    const entEntries = scoped.filter((e) => e.entityKey === ent.entityKey)
    const entClaimed = ent.ownershipStatus === 'claimed'
    const agg = aggregateYearScope({
      year, entries: entEntries, thresholdApplicable: entClaimed && entEntries.length > 0,
      crossEntityMixed: false, hasUnclaimed: !entClaimed, fxUsd, fxEur,
    })
    return {
      entityKey: ent.entityKey,
      entityLabel: ent.entityLabel,
      ownershipStatus: ent.ownershipStatus,
      declarable: entClaimed && entEntries.length > 0,
      snapshotCount: entEntries.length,
      ...agg,
    }
  })

  const topAgg = aggregateYearScope({
    year, entries: scoped, thresholdApplicable, crossEntityMixed, hasUnclaimed, fxUsd, fxEur, byEntitySummaries: byEntity,
  })

  const scopeLabel = crossEntityMixed
    ? `多主体拆表参考（共 ${scopedEntities.length} 个主体 · 不可直接合并申报）`
    : entityFilterRaw
      ? (scopedEntities[0]?.entityLabel || entityFilterRaw)
      : (scopedEntities[0]?.entityLabel || '暂无归档主体')

  const warnings = [
    ...(mixingProtectionWarning ? [mixingProtectionWarning] : []),
    ...(unclaimedWarning ? [unclaimedWarning] : []),
    ...(topAgg.missingMonths.length > 0 ? [topAgg.missingMonthsNote] : []),
  ]

  return {
    schema: HISTORY_SCHEMA,
    year,
    yearLabel: String(year),
    deadlineDate: `${year + 1}-01-31`,
    asOfDate,
    filters: { entityKey: entityFilterNorm, shopKey: shopFilterNorm },
    scopeLabel,
    availableEntities,
    scopedEntities,
    crossEntityMixed,
    cannotMergeForTaxFiling: crossEntityMixed,
    hasUnclaimed,
    unclaimedCount,
    declarable,
    thresholdApplicable,
    mixingProtectionWarning,
    unclaimedWarning,
    warnings,
    snapshotCount: scoped.length,
    ...topAgg,
    missingMonthsCount: topAgg.missingMonths.length,
    byEntity,
  }
}

/**
 * 一键认领/重分配归档主体与店铺（典型场景：将「待认领」历史快照归入正式主体）。
 * 若重分配后的 entityKey + shopKey + period 与其他归档碰撞且未传 force: true，返回 { conflict: true, statusCode: 409, ... }。
 */
export function reassignArchiveEntity(storeOrId, archiveIdOrPatch, maybePatch) {
  let store = storeOrId
  let archiveId = archiveIdOrPatch
  let patch = maybePatch
  if (typeof storeOrId === 'string' && isPlainObject(archiveIdOrPatch) && maybePatch === undefined) {
    store = null
    archiveId = storeOrId
    patch = archiveIdOrPatch
  }

  if (typeof archiveId !== 'string') {
    throw new HistoryInputError('INVALID_SNAPSHOT_ID', '归档快照 ID 无效。')
  }
  const trimmedArchiveId = archiveId.trim()
  if (!trimmedArchiveId || trimmedArchiveId.length > 128 || /[\p{Cc}\p{Cf}]/u.test(trimmedArchiveId)) {
    throw new HistoryInputError('INVALID_SNAPSHOT_ID', '归档快照 ID 无效。')
  }
  if (!isPlainObject(patch)) {
    throw new HistoryInputError('INVALID_REASSIGN_PATCH', '主体重分配参数须为对象。')
  }
  assertNoPrototypePollution(patch, 'INVALID_REASSIGN_PATCH')

  if (patch.force !== undefined && typeof patch.force !== 'boolean') {
    throw new HistoryInputError('INVALID_FORCE_FLAG', 'force 覆盖参数须为布尔值。')
  }
  const trimmedExpectedRev = typeof patch.expectedRevision === 'string' ? patch.expectedRevision.trim() : undefined
  if (patch.expectedRevision !== undefined && (!trimmedExpectedRev || !UUID.test(trimmedExpectedRev))) {
    throw new HistoryInputError('INVALID_EXPECTED_REVISION', 'expectedRevision 须为有效的 UUID。')
  }

  const parsePatchNullableInt = (rawVal, code, label) => {
    if (rawVal === null || rawVal === '') return null
    if (typeof rawVal === 'boolean' || typeof rawVal === 'object') throw new HistoryInputError(code, `${label}须为非负整数或 null。`)
    const n = Number(rawVal)
    if (!Number.isSafeInteger(n) || n < 0 || n > 100_000_000) throw new HistoryInputError(code, `${label}须为非负整数或 null。`)
    return n
  }
  const parsePatchNullableAmt = (rawVal, code, label) => {
    if (rawVal === null || rawVal === '') return null
    if (typeof rawVal === 'boolean' || typeof rawVal === 'object') throw new HistoryInputError(code, `${label}须为非负数字或 null。`)
    const n = Number(rawVal)
    if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER / 100) throw new HistoryInputError(code, `${label}须为非负数字或 null。`)
    return r2(n)
  }

  const hasEuOrdersPatch = 'euOrderCount' in patch && patch.euOrderCount !== undefined
  const hasUsTxnsPatch = 'usTransactionCount' in patch && patch.usTransactionCount !== undefined
  const hasEuAmtPatch = 'euSalesEur' in patch && patch.euSalesEur !== undefined
  const hasUsAmtPatch = 'usSalesUsd' in patch && patch.usSalesUsd !== undefined
  const hasDeclaredPatch = 'declaredVatSalesCny' in patch && patch.declaredVatSalesCny !== undefined
  const nextEuOrders = hasEuOrdersPatch ? parsePatchNullableInt(patch.euOrderCount, 'INVALID_ORDER_COUNT', '欧盟订单笔数') : undefined
  const nextUsTxns = hasUsTxnsPatch ? parsePatchNullableInt(patch.usTransactionCount, 'INVALID_TRANSACTION_COUNT', '美国交易笔数') : undefined
  const nextEuAmt = hasEuAmtPatch ? parsePatchNullableAmt(patch.euSalesEur, 'INVALID_SALES_AMOUNT', '欧盟原币销售额') : undefined
  const nextUsAmt = hasUsAmtPatch ? parsePatchNullableAmt(patch.usSalesUsd, 'INVALID_SALES_AMOUNT', '美国原币销售额') : undefined
  const nextDeclaredVat = hasDeclaredPatch ? parsePatchNullableAmt(patch.declaredVatSalesCny, 'INVALID_DECLARED_VAT', '增值税已申报额') : undefined
  const hasMetricsPatch = hasEuOrdersPatch || hasUsTxnsPatch || hasEuAmtPatch || hasUsAmtPatch || hasDeclaredPatch

  const hasEntityPatch = 'entityKey' in patch || 'entityLabel' in patch || 'entityName' in patch
  const hasShopPatch = 'shopKey' in patch || 'shopLabel' in patch || 'storeScope' in patch
  if (!hasEntityPatch && !hasShopPatch && !hasMetricsPatch) {
    throw new HistoryInputError('INVALID_REASSIGN_PATCH', '请至少指定目标主体（entityKey/entityLabel）、店铺（shopKey/shopLabel）或补录指标。')
  }
  if (hasEntityPatch) {
    const rawEnt = textField(patch.entityLabel ?? patch.entityName ?? patch.entityKey)
    if (!rawEnt) throw new HistoryInputError('INVALID_ENTITY', '目标主体名称或标识不能为空。')
  }
  if (hasShopPatch) {
    const rawShop = textField(patch.shopLabel ?? patch.storeScope ?? patch.shopKey)
    if (!rawShop) throw new HistoryInputError('INVALID_SHOP', '目标店铺名称或标识不能为空。')
  }

  const force = patch.force === true
  const isUuidId = UUID.test(trimmedArchiveId)
  const resolved = resolveStore(store)

  return resolved.withLock((loadFn, saveFn) => {
    const existing = loadFn()
    const target = findSnapshotById(existing, trimmedArchiveId)
    if (!target) {
      if (!isUuidId) throw new HistoryInputError('INVALID_SNAPSHOT_ID', '归档快照 ID 无效。')
      throw new HistoryInputError('SNAPSHOT_NOT_FOUND', '未找到指定的归档快照。')
    }
    if (trimmedExpectedRev && target.revision !== trimmedExpectedRev.toLowerCase()) {
      return {
        conflict: true,
        statusCode: 409,
        reason: 'revision_mismatch',
        conflictType: 'revision_conflict',
        target,
        existing: target,
        conflicts: [target],
      }
    }

    const explicitEntityKey = 'entityKey' in patch && patch.entityKey !== undefined && String(patch.entityKey).trim() !== ''
      ? patch.entityKey
      : undefined
    const explicitEntityLabel = 'entityLabel' in patch
      ? patch.entityLabel
      : ('entityName' in patch ? patch.entityName : undefined)
    const desiredLabelNorm = explicitEntityLabel !== undefined ? normIdentityPart(textField(explicitEntityLabel)) : ''
    const preserveExistingKey = !explicitEntityKey &&
      target.ownershipStatus === 'claimed' &&
      Boolean(desiredLabelNorm) &&
      desiredLabelNorm === normIdentityPart(target.entityLabel)

    let reusedClaimedEntityKey
    if (!explicitEntityKey && !preserveExistingKey && desiredLabelNorm && !isUnclaimedMarker(desiredLabelNorm)) {
      const matchedKeys = new Set(
        existing
          .filter((item) => item.ownershipStatus === 'claimed' && item.entityKey && item.entityKey !== UNCLAIMED_ENTITY_KEY &&
            (normIdentityPart(item.entityLabel) === desiredLabelNorm || normIdentityPart(item.entityName) === desiredLabelNorm))
          .map((item) => item.entityKey),
      )
      if (matchedKeys.size === 1) {
        reusedClaimedEntityKey = [...matchedKeys][0]
      } else if (matchedKeys.size > 1) {
        throw new HistoryInputError(
          'AMBIGUOUS_ENTITY_KEY',
          '库内已存在多个同名独立法人主体，认领或重分配时必须显式传入目标 entityKey（统一社会信用代码/主体唯一编码），严禁静默新建第三主体。',
        )
      }
    }

    const nextEntity = hasEntityPatch
      ? resolveEntityFields({
          entityKey: explicitEntityKey ?? (preserveExistingKey ? target.entityKey : reusedClaimedEntityKey),
          entityLabel: explicitEntityLabel,
        })
      : {
          entityKey: target.entityKey,
          entityLabel: target.entityLabel,
          entityName: target.entityName,
          ownershipStatus: target.ownershipStatus,
        }

    const nextShop = hasShopPatch
      ? resolveShopFields({
          shopKey: 'shopKey' in patch ? patch.shopKey : undefined,
          shopLabel: 'shopLabel' in patch ? patch.shopLabel : ('storeScope' in patch ? patch.storeScope : undefined),
        }, target.platforms)
      : {
          shopKey: target.shopKey,
          shopLabel: target.shopLabel,
          storeScope: target.storeScope,
        }

    const nextSourceKey = buildSourceKey({ entityKey: nextEntity.entityKey, shopKey: nextShop.shopKey, month: target.month })
    const collisions = nextSourceKey === target.sourceKey
      ? []
      : existing.filter((entry) => entry.id !== target.id && entry.sourceKey === nextSourceKey)

    if (collisions.length > 0 && !force) {
      return {
        conflict: true,
        statusCode: 409,
        reason: 'source_key_collision',
        conflictType: 'source_key_collision',
        target,
        proposed: {
          entityKey: nextEntity.entityKey,
          entityLabel: nextEntity.entityLabel,
          shopKey: nextShop.shopKey,
          shopLabel: nextShop.shopLabel,
          month: target.month,
          period: target.month,
          sourceKey: nextSourceKey,
        },
        existing: collisions[0],
        conflicts: collisions,
      }
    }

    const nowIso = new Date().toISOString()
    const overwrittenIds = collisions.map((c) => c.id)
    const collisionIdSet = new Set(overwrittenIds)
    const updated = hydrateEntry({
      ...target,
      ...(target.legacyId ? { legacyId: target.legacyId } : {}),
      entityKey: nextEntity.entityKey,
      entityLabel: nextEntity.entityLabel,
      entityName: nextEntity.entityName,
      shopKey: nextShop.shopKey,
      shopLabel: nextShop.shopLabel,
      storeScope: nextShop.storeScope,
      vatTaxpayerType: patch.vatTaxpayerType !== undefined && VAT_TYPES.has(patch.vatTaxpayerType) ? patch.vatTaxpayerType : target.vatTaxpayerType,
      citAssessedMode: patch.citAssessedMode !== undefined && CIT_MODES.has(patch.citAssessedMode) ? patch.citAssessedMode : target.citAssessedMode,
      ...(hasEuOrdersPatch ? { euOrderCount: nextEuOrders } : {}),
      ...(hasUsTxnsPatch ? { usTransactionCount: nextUsTxns } : {}),
      ...(hasEuAmtPatch ? { euSalesEur: nextEuAmt } : {}),
      ...(hasUsAmtPatch ? { usSalesUsd: nextUsAmt } : {}),
      ...(hasDeclaredPatch ? { declaredVatSalesCny: nextDeclaredVat } : {}),
      revision: randomUUID(),
      reassignedAt: nowIso,
      updatedAt: nowIso,
      reassignedFrom: {
        entityKey: target.entityKey,
        entityLabel: target.entityLabel,
        shopKey: target.shopKey,
        shopLabel: target.shopLabel,
        at: nowIso,
        ...(overwrittenIds.length ? { overwrittenIds } : {}),
      },
    })

    const nextList = [updated, ...existing.filter((item) => item.id !== target.id && !collisionIdSet.has(item.id))]
    const history = saveFn(nextList)
    return {
      conflict: false,
      overwritten: overwrittenIds.length > 0,
      overwrittenCount: overwrittenIds.length,
      overwrittenIds,
      entry: updated,
      history,
      rolling12m: computeRolling12m(history),
    }
  })
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

// SHA-256 完整性防损校验摘要（用于检测备份文件截断、传输损坏或意外篡改；并非密码学来源数字签名）
export function computeBackupChecksum(records) {
  return createHash('sha256').update(`${BACKUP_SCHEMA}:${canonicalJson(records)}`).digest('hex')
}

const ALLOWED_RECORD_KEYS = new Set([
  'id', 'legacyId', 'revision', 'month', 'period', 'savedAt', 'updatedAt', 'label', 'platforms',
  'entityName', 'entityKey', 'entityLabel', 'ownershipStatus',
  'storeScope', 'shopKey', 'shopLabel',
  'vatTaxpayerType', 'citAssessedMode', 'zeroSalesConfirmed', 'sourceKey', 'importMode',
  'sheetCount', 'rowCount', 'grossCny', 'refundCny', 'netSalesCny', 'feesCny', 'payoutCny',
  'declaredVatSalesCny', 'stage2WalletInboundCny', 'walletInboundCny',
  'stage3CorporateRepatriatedCny', 'stage3ExpectedCny', 'stage3BankReceivedCny', 'bankReceivedCny',
  'stage3UnmatchedCny', 'stage3Status', 'stage3CoverageComplete', 'stage3Verified',
  'currencySource', 'sites', 'site', 'currencies', 'currency',
  'euSalesEur', 'euOrderCount', 'usSalesUsd', 'usTransactionCount', 'platformBreakdown',
  'p0Count', 'p1Count', 'p2Count', 'reassignedAt', 'reassignedFrom',
])

const REQUIRED_NUMERIC_KEYS = ['grossCny', 'refundCny', 'netSalesCny', 'feesCny', 'payoutCny']
const NULLABLE_NUMERIC_KEYS = [
  'declaredVatSalesCny', 'stage2WalletInboundCny', 'walletInboundCny',
  'stage3CorporateRepatriatedCny', 'stage3ExpectedCny', 'stage3BankReceivedCny', 'bankReceivedCny',
  'stage3UnmatchedCny', 'euSalesEur', 'usSalesUsd',
]
const INT_KEYS = ['sheetCount', 'rowCount', 'p0Count', 'p1Count', 'p2Count']
const NULLABLE_INT_KEYS = ['euOrderCount', 'usTransactionCount']

function stripVolatileFieldsForCompare(entry) {
  const copy = {
    ...entry,
    savedAt: entry.savedAt || `${entry.month}-28T00:00:00.000Z`,
  }
  delete copy.revision
  delete copy.updatedAt
  return canonicalJson(copy)
}

function validateBackupRecord(raw, idx) {
  if (!isPlainObject(raw)) {
    throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录不是合法对象。`)
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_RECORD_KEYS.has(key)) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录包含不被允许的字段（${key}）。`)
    }
  }
  normalizeMonth(raw.month ?? raw.period)
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.trim().length > 128 || /[\p{Cc}\p{Cf}]/u.test(raw.id)) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录 id 无效。`)
    }
  }
  if (raw.legacyId !== undefined && raw.legacyId !== null) {
    if (typeof raw.legacyId !== 'string') {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录 legacyId 须为字符串。`)
    }
    const trimLeg = raw.legacyId.trim()
    if (!trimLeg || trimLeg.length > 128 || /[\p{Cc}\p{Cf}]/u.test(trimLeg) || UUID.test(trimLeg) || toWellFormedClean(trimLeg) !== trimLeg) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录 legacyId 格式无效。`)
    }
    if (raw.id !== undefined && !UUID.test(raw.id.trim()) && raw.id.trim() !== trimLeg) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录 id 与 legacyId 不一致。`)
    }
  }
  if (raw.platforms !== undefined && (!Array.isArray(raw.platforms) || raw.platforms.some((p) => typeof p !== 'string'))) {
    throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录 platforms 字段无效。`)
  }
  for (const k of REQUIRED_NUMERIC_KEYS) {
    if (raw[k] !== undefined && (typeof raw[k] !== 'number' || !Number.isFinite(raw[k]))) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录金额字段 ${k} 须为有限数字。`)
    }
  }
  for (const k of NULLABLE_NUMERIC_KEYS) {
    if (raw[k] !== undefined && raw[k] !== null && (typeof raw[k] !== 'number' || !Number.isFinite(raw[k]))) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录字段 ${k} 须为有限数字或 null。`)
    }
  }
  for (const k of INT_KEYS) {
    if (raw[k] !== undefined && (!Number.isSafeInteger(raw[k]) || raw[k] < 0)) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录计数字段 ${k} 须为非负整数。`)
    }
  }
  for (const k of NULLABLE_INT_KEYS) {
    if (raw[k] !== undefined && raw[k] !== null && (!Number.isSafeInteger(raw[k]) || raw[k] < 0)) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录字段 ${k} 须为非负整数或 null。`)
    }
  }
  if (raw.vatTaxpayerType !== undefined && !VAT_TYPES.has(raw.vatTaxpayerType)) {
    throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录 vatTaxpayerType 无效。`)
  }
  if (raw.citAssessedMode !== undefined && !CIT_MODES.has(raw.citAssessedMode)) {
    throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录 citAssessedMode 无效。`)
  }
  let hydrated
  try {
    hydrated = hydrateEntry(raw)
  } catch {
    throw new HistoryInputError('INVALID_BACKUP_RECORD', `第 ${idx + 1} 条备份记录校验失败。`)
  }
  const fpDigest = createHash('sha256').update(canonicalJson({
    sourceKey: hydrated.sourceKey,
    importMode: hydrated.importMode,
    savedAt: hydrated.savedAt,
    label: hydrated.label,
    platforms: hydrated.platforms,
    grossCny: hydrated.grossCny,
    refundCny: hydrated.refundCny,
    netSalesCny: hydrated.netSalesCny,
    feesCny: hydrated.feesCny,
    payoutCny: hydrated.payoutCny,
  }), 'utf8').digest('hex').slice(0, 48)
  const deterministicId = hydrated.id || migrateId('bfp:' + fpDigest)
  const revSeed = createHash('sha256').update(`${deterministicId}:${hydrated.savedAt || hydrated.month}`, 'utf8').digest('hex').slice(0, 48)
  const deterministicRev = hydrated.revision || migrateId('rev:' + revSeed)
  return {
    ...hydrated,
    id: deterministicId,
    revision: deterministicRev,
    savedAt: hydrated.savedAt || `${hydrated.month}-28T00:00:00.000Z`,
  }
}

/**
 * 导出归档 JSON 安全备份（含 schemaVersion / exportedAt / recordCount / records / SHA-256 checksum）。
 */
export function exportArchiveBackup(store) {
  let records
  if (Array.isArray(store)) {
    records = sortHistory(store.map(hydrateEntry))
  } else if (store && typeof store === 'object' && Array.isArray(store.entries)) {
    records = hydrateListStrict(store.entries)
  } else {
    records = resolveStore(store).load()
  }
  const exportedAt = new Date().toISOString()
  const checksum = computeBackupChecksum(records)
  return {
    schemaVersion: BACKUP_SCHEMA,
    exportedAt,
    recordCount: records.length,
    records,
    checksum,
  }
}

const BACKUP_IMPORT_MODES = new Set(['merge_skip', 'merge_overwrite'])

/**
 * 安全导入归档 JSON 备份：防原型污染、校验 schema/条数/非法字段/SHA-256 checksum，
 * 支持 mode: 'merge_skip'（默认）与 'merge_overwrite'，返回精确统计 { imported, skipped, overwritten, conflicts }。
 */
export function importArchiveBackup(store, payload, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const mode = opts.mode === undefined ? 'merge_skip' : opts.mode
  if (!BACKUP_IMPORT_MODES.has(mode)) {
    throw new HistoryInputError('INVALID_IMPORT_MODE', '导入模式须为 merge_skip 或 merge_overwrite。')
  }
  const verifyChecksum = opts.verifyChecksum !== undefined
    ? Boolean(opts.verifyChecksum)
    : (opts.strictChecksum !== undefined ? Boolean(opts.strictChecksum) : true)
  const maxRecords = Number.isSafeInteger(opts.maxRecords) && opts.maxRecords > 0
    ? Math.min(opts.maxRecords, MAX_SNAPSHOTS)
    : MAX_SNAPSHOTS

  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new HistoryInputError('INVALID_BACKUP_PAYLOAD', '备份 JSON 解析失败，请检查文件完整性。')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HistoryInputError('INVALID_BACKUP_PAYLOAD', '备份数据须为合法的 JSON 对象。')
  }
  assertNoPrototypePollution(parsed, 'BACKUP_UNSAFE_KEYS')

  if (parsed.schemaVersion !== BACKUP_SCHEMA) {
    throw new HistoryInputError('INVALID_BACKUP_SCHEMA', `不支持的备份格式版本（需要 ${BACKUP_SCHEMA}）。`)
  }
  if (!Array.isArray(parsed.records)) {
    throw new HistoryInputError('INVALID_BACKUP_RECORDS', '备份数据缺少有效的 records 数组。')
  }
  if (parsed.recordCount !== undefined && (!Number.isSafeInteger(parsed.recordCount) || parsed.recordCount !== parsed.records.length)) {
    throw new HistoryInputError('BACKUP_RECORD_COUNT_MISMATCH', '备份记录条数与 recordCount 不一致，文件可能已截断。')
  }
  if (parsed.records.length > maxRecords) {
    throw new HistoryInputError('BACKUP_TOO_MANY_RECORDS', `备份记录条数超出允许上限（最多 ${maxRecords} 条）。`)
  }

  if (verifyChecksum) {
    if (typeof parsed.checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.checksum)) {
      throw new HistoryInputError('BACKUP_CHECKSUM_MISMATCH', '备份缺少有效的 SHA-256 校验摘要。')
    }
    const expected = computeBackupChecksum(parsed.records)
    const actualBuf = Buffer.from(parsed.checksum.toLowerCase(), 'utf8')
    const expectedBuf = Buffer.from(expected, 'utf8')
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      throw new HistoryInputError('BACKUP_CHECKSUM_MISMATCH', '备份 SHA-256 校验失败，文件可能已被篡改或截断。')
    }
  }

  const validatedRecords = parsed.records.map((rec, idx) => validateBackupRecord(rec, idx))
  // 备份批次内强制校验 legacyId 全局唯一且不与任何其他记录的确定性主键碰撞
  const batchLegacyOwner = new Map()
  const batchIds = new Set(validatedRecords.map((r) => r.id))
  for (const rec of validatedRecords) {
    if (!rec.legacyId) continue
    const prevOwner = batchLegacyOwner.get(rec.legacyId)
    if (prevOwner && prevOwner !== rec.id) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `备份记录中存在重复冲突的 legacyId（${rec.legacyId}）。`)
    }
    const migratedLeg = migrateId(rec.legacyId)
    if (migratedLeg !== rec.id && batchIds.has(migratedLeg)) {
      throw new HistoryInputError('INVALID_BACKUP_RECORD', `备份记录的 legacyId（${rec.legacyId}）与其他记录主键冲突。`)
    }
    batchLegacyOwner.set(rec.legacyId, rec.id)
  }

  const resolved = resolveStore(store)

  return resolved.withLock((loadFn, saveFn) => {
    const working = [...loadFn()]
    let imported = 0
    let skipped = 0
    let overwritten = 0
    let mutated = false
    const conflicts = []
    const seenIncomingIds = new Set()
    const seenIncomingPrimarySourceKeys = new Set()

    const assertNoLegacyCollisionWithStore = (incoming, ignoreIdx = -1) => {
      const incomingMig = incoming.legacyId ? migrateId(incoming.legacyId) : null
      for (let i = 0; i < working.length; i++) {
        if (i === ignoreIdx) continue
        const other = working[i]
        if (incoming.legacyId && (other.legacyId === incoming.legacyId || other.id === incomingMig)) {
          throw new HistoryInputError('INVALID_BACKUP_RECORD', `备份记录的 legacyId（${incoming.legacyId}）与库内既有归档冲突。`)
        }
        if (other.legacyId && migrateId(other.legacyId) === incoming.id) {
          throw new HistoryInputError('INVALID_BACKUP_RECORD', `备份记录的主键与库内既有 legacyId（${other.legacyId}）冲突。`)
        }
      }
    }

    for (const incoming of validatedRecords) {
      const isPrimary = incoming.importMode !== 'append'
      const dupIdInBatch = seenIncomingIds.has(incoming.id)
      const dupPrimaryInBatch = !dupIdInBatch && isPrimary && seenIncomingPrimarySourceKeys.has(incoming.sourceKey)
      const dupInBatch = dupIdInBatch || dupPrimaryInBatch
      const byIdIdx = working.findIndex((item) => item.id === incoming.id)
      const byPrimarySourceIdx = byIdIdx < 0 && isPrimary
        ? working.findIndex((item) => item.sourceKey === incoming.sourceKey && item.importMode !== 'append')
        : -1
      const targetIdx = byIdIdx >= 0 ? byIdIdx : byPrimarySourceIdx
      const hasConflict = dupInBatch || targetIdx >= 0

      if (!hasConflict) {
        assertNoLegacyCollisionWithStore(incoming, -1)
        working.push(incoming)
        seenIncomingIds.add(incoming.id)
        if (isPrimary) seenIncomingPrimarySourceKeys.add(incoming.sourceKey)
        imported++
        mutated = true
        continue
      }

      const reason = dupIdInBatch
        ? 'duplicate_in_backup'
        : dupPrimaryInBatch
          ? 'duplicate_source_key_in_backup'
          : byIdIdx >= 0
            ? 'id_collision'
            : 'source_key_collision'
      const existingMatch = targetIdx >= 0 ? working[targetIdx] : null

      if (mode === 'merge_skip' || dupInBatch) {
        seenIncomingIds.add(incoming.id)
        if (isPrimary) seenIncomingPrimarySourceKeys.add(incoming.sourceKey)
        skipped++
        conflicts.push({
          incomingId: incoming.id,
          existingId: existingMatch?.id ?? null,
          month: incoming.month,
          entityKey: incoming.entityKey,
          entityLabel: incoming.entityLabel,
          shopKey: incoming.shopKey,
          shopLabel: incoming.shopLabel,
          sourceKey: incoming.sourceKey,
          reason,
          action: 'skipped',
        })
        continue
      }

      assertNoLegacyCollisionWithStore(incoming, targetIdx)
      const sameIdAndSameContent = byIdIdx >= 0 &&
        existingMatch &&
        stripVolatileFieldsForCompare(incoming) === stripVolatileFieldsForCompare(existingMatch)
      const nextEntry = sameIdAndSameContent
        ? existingMatch
        : { ...incoming, revision: randomUUID(), updatedAt: new Date().toISOString() }
      working.splice(targetIdx, 1, nextEntry)
      if (!sameIdAndSameContent) mutated = true
      seenIncomingIds.add(incoming.id)
      if (isPrimary) seenIncomingPrimarySourceKeys.add(incoming.sourceKey)
      overwritten++
      conflicts.push({
        incomingId: incoming.id,
        existingId: existingMatch?.id ?? null,
        month: incoming.month,
        entityKey: incoming.entityKey,
        entityLabel: incoming.entityLabel,
        shopKey: incoming.shopKey,
        shopLabel: incoming.shopLabel,
        sourceKey: incoming.sourceKey,
        reason,
        revisionChanged: !sameIdAndSameContent,
        action: 'overwritten',
      })
    }

    if (working.length > MAX_SNAPSHOTS) {
      throw new HistoryInputError('HISTORY_CAPACITY', '合并后归档总条数超出容量上限，请先清理旧档。')
    }
    const history = mutated ? saveFn(working) : sortHistory(working)
    return {
      schemaVersion: BACKUP_SCHEMA,
      mode,
      imported,
      skipped,
      overwritten,
      conflicts,
      totalProcessed: validatedRecords.length,
      totalInStore: history.length,
      history,
      rolling12m: computeRolling12m(history),
    }
  })
}

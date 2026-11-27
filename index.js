// dsh-fintax：财税工作台插件入口（Host 半身）。
// 纯 ESM、零运行时依赖：
//   1. 向 ctx.tools 注册 6 个工具（4 个 IMA 知识库只读工具 + 1 个 17 通道账单/结汇/银行回单离线初筛体检雷达 fintax_parse_statement + 1 个 14 场景确定性算税与对账引擎 fintax_calc）；
//   2. 向 ctx.skills 注册 4 个随包财税合规技能；
//   3. 当宿主挂载 webServer 时，提供经会话准入校验的 /api/fintax/* 全量工作台与设置接口（绝不回传密钥明文）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import {
  imaCall,
  ImaServiceError,
  readImaTextDownload,
  searchImaKnowledge,
  loadCredentials,
  loadFintaxSettings,
  saveCredentials,
  clearCredentials,
  saveFintaxSettings,
  getPublicStatus,
  CREDENTIALS_HELP,
} from './lib/ima.js'
import * as calcModule from './lib/calc.js'
import {
  CalcInputError,
  CROSSBORDER_CALC_SPECS,
  CROSSBORDER_SCENARIOS,
  calculate,
  platformTaxReconcile,
} from './lib/calc.js'
import { StatementInputError, fmtAmount, toNumber2 } from './lib/statement.js'
import {
  buildConsolidatedReconcile,
  exportDiagnosticReport,
  normalizeFxMap,
  renderAnomaliesCsv,
  renderDiagnosticReportHtml,
  renderDiagnosticReportMd,
  renderRollingTrendReportHtml,
  serializeSummary,
} from './lib/report.js'
import {
  buildAnnualSummary,
  computeRolling12m,
  deleteSnapshot,
  exportArchiveBackup,
  HistoryInputError,
  importArchiveBackup,
  loadHistory,
  reassignArchiveEntity,
  saveSnapshot,
} from './lib/history.js'
import { renderAnnualSummaryHtml, renderAnnualSummaryMarkdown } from './lib/annual_report.js'
import { createParseCache } from './lib/parse_cache.js'
import { LocalStoreError } from './lib/local_store.js'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version

export const name = 'fintax'
export const inject = ['tools', 'skills']

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** 工具执行兜底：把错误变成模型可读的可操作提示，而不是让调用崩掉。 */
async function guarded(fn) {
  try {
    return await fn()
  } catch (err) {
    const known = err instanceof StatementInputError || err instanceof ImaServiceError ||
      err instanceof LocalStoreError || err instanceof PublicRequestError || err instanceof CalcInputError
    if (err instanceof StatementInputError && err.diagnostics?.length) {
      return `[错误] ${err.code} ${err.message}\n${JSON.stringify(err.diagnostics)}`
    }
    if (['REPORT_ALREADY_EXISTS', 'REPORT_FORMAT_UNSUPPORTED', 'REPORT_WRITE_FAILED'].includes(err?.code)) {
      return `[错误] ${err.code} ${err.message}`
    }
    if (err?.code === 'INVALID_FX_MAP') return '[错误] INVALID_FX_MAP 汇率须为有效的币种映射对象。'
    return known ? `[错误] ${err.code} ${err.message}` : '[错误] 操作失败，请核对输入参数、文件格式和本机权限。'
  }
}

const isRejection = (value) => Number.isInteger(value) && value >= 400 && value <= 599

/**
 * 宿主连接准入校验（对齐 DSH connection 服务，防止未授权访问或跨站伪造）：
 * - 现代宿主提供 connection.admit(req) -> { peer } | { rejection }
 * - 旧版提供 connection.requestRejection(req) -> number | undefined
 * - 若 connection 服务缺失或异常，默认按 503 拒绝（fail-closed）。
 */
function evaluateAdmission(req, connection) {
  if (!connection) return { rejection: 503, peer: null }
  try {
    if (typeof connection.admit === 'function') {
      const res = connection.admit(req)
      if (!res || typeof res !== 'object' || Array.isArray(res)) return { rejection: 503, peer: null }
      if (Object.hasOwn(res, 'rejection')) {
        return { rejection: isRejection(res.rejection) ? res.rejection : 503, peer: null }
      }
      if (Object.hasOwn(res, 'peer') && res.peer !== null && typeof res.peer === 'object') {
        return { rejection: undefined, peer: res.peer }
      }
      return { rejection: 503, peer: null }
    }
    if (typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      return { rejection: rejection === undefined || isRejection(rejection) ? rejection : 503, peer: null }
    }
    return { rejection: 503, peer: null }
  } catch {
    return { rejection: 503, peer: null }
  }
}

export function admitRequest(req, connection) {
  return evaluateAdmission(req, connection).rejection
}

function pickNonEmptyString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : ''
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function safeScopeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

const TRANSIENT_OR_SHARED_PEER_KEYS = new Set([
  'connectionId', 'requestId', 'reqId', 'traceId', 'socketId', 'streamId',
  'remoteAddress', 'remotePort', 'localAddress', 'localPort', 'ip', 'port',
])
const AUTH_COOKIE_NAME_RE = /^(?:__Host-|__Secure-)?(?:dsh[_-]?(?:session|token|sid|auth)|session(?:[_-]?id|[_-]?token)?|sid|connect\.sid|auth[_-]?(?:token|session)|access[_-]?token|jwt)$/i
const CLIENT_SESSION_RE = /^[0-9a-f]{32,64}$/i
const ASSERTION_ID_RE = /^[0-9a-f]{32}$/i

function isHighEntropyClientSession(raw) {
  if (!CLIENT_SESSION_RE.test(raw)) return false
  return new Set(raw.toLowerCase()).size >= 4
}

function extractAuthCookieIdentity(rawCookie) {
  if (typeof rawCookie !== 'string' || !rawCookie.trim()) return ''
  const matched = []
  for (const part of rawCookie.split(';')) {
    const eqIdx = part.indexOf('=')
    if (eqIdx <= 0) continue
    const name = part.slice(0, eqIdx).trim()
    const val = part.slice(eqIdx + 1).trim()
    if (name && val && AUTH_COOKIE_NAME_RE.test(name)) {
      matched.push(`${name.toLowerCase()}=${val}`)
    }
  }
  return matched.sort().join(';')
}

function signSessionAssertion(secret, assertionId, clientSession = '') {
  const mac = createHmac('sha256', secret)
    .update(`fintax-sess-v1:${assertionId}:${clientSession || ''}`)
    .digest('hex')
    .slice(0, 32)
  return `${assertionId}.${mac}`
}

function verifySessionAssertion(secret, rawHeader, clientSession = '') {
  if (typeof rawHeader !== 'string' || !rawHeader.trim()) return null
  const parts = rawHeader.trim().split('.')
  if (parts.length !== 2) return null
  const [id, sig] = parts
  if (!ASSERTION_ID_RE.test(id) || !/^[0-9a-f]{32}$/i.test(sig)) return null
  const expected = signSessionAssertion(secret, id.toLowerCase(), clientSession)
  return safeScopeEqual(`${id.toLowerCase()}.${sig.toLowerCase()}`, expected) ? id.toLowerCase() : null
}

function mintSignedArchiveToken(secret, month) {
  const tokId = randomBytes(16).toString('hex')
  const tokSecret = randomBytes(16).toString('hex')
  const secretHash = createHash('sha256').update(tokSecret, 'utf8').digest('hex')
  const sig = createHmac('sha256', secret)
    .update(`fintax-arch-v1:${tokId}.${tokSecret}.${month}`)
    .digest('hex')
    .slice(0, 32)
  return { token: `${tokId}.${tokSecret}.${sig}`, tokId, secretHash, sig }
}

function parseAndVerifyArchiveToken(secret, rawToken, archiveTokens) {
  if (typeof rawToken !== 'string' || !rawToken.trim()) return null
  const parts = rawToken.trim().split('.')
  if (parts.length !== 3) return null
  const [tokId, tokSecret, tokSig] = parts
  if (!ASSERTION_ID_RE.test(tokId) || !ASSERTION_ID_RE.test(tokSecret) || !/^[0-9a-f]{32}$/i.test(tokSig)) {
    return null
  }
  const entry = archiveTokens.get(tokId.toLowerCase())
  if (!entry) return null
  const expectedSig = createHmac('sha256', secret)
    .update(`fintax-arch-v1:${tokId.toLowerCase()}.${tokSecret.toLowerCase()}.${entry.month}`)
    .digest('hex')
    .slice(0, 32)
  if (!safeScopeEqual(tokSig.toLowerCase(), expectedSig)) return null
  const actualHash = createHash('sha256').update(tokSecret.toLowerCase(), 'utf8').digest('hex')
  if (!safeScopeEqual(actualHash, entry.secretHash)) return null
  return { tokId: tokId.toLowerCase(), entry }
}

function deriveSessionContext(req, peer, peerWeakIds, handlerSecret) {
  const headers = req?.headers && typeof req.headers === 'object' ? req.headers : {}
  const auth = pickNonEmptyString(headers.authorization)
  const authCookie = extractAuthCookieIdentity(headers.cookie)

  const stablePeerParts = []
  let hasSharedNetOnly = false
  let hadExistingWeakId = false
  let peerWeakId = null

  if (peer && typeof peer === 'object') {
    const keys = Object.keys(peer).sort()
    for (const k of keys) {
      if (TRANSIENT_OR_SHARED_PEER_KEYS.has(k)) continue
      const v = peer[k]
      if (typeof v === 'boolean') {
        if (v === true) stablePeerParts.push(`${k}:true`)
      } else {
        const s = pickNonEmptyString(v)
        if (s) stablePeerParts.push(`${k}:${s}`)
      }
    }
    hasSharedNetOnly = stablePeerParts.length === 0 && keys.length > 0 && keys.every((k) => TRANSIENT_OR_SHARED_PEER_KEYS.has(k) && k !== 'connectionId')
    if (peerWeakIds && !hasSharedNetOnly) {
      hadExistingWeakId = peerWeakIds.has(peer)
      peerWeakId = peerWeakIds.get(peer) || null
      if (!peerWeakId) {
        peerWeakId = randomBytes(16).toString('hex')
        peerWeakIds.set(peer, peerWeakId)
      }
    }
  }

  const admittedLoopbackPeer = Boolean(peer && typeof peer === 'object' && !hasSharedNetOnly)
  const rawClientSess = pickNonEmptyString(headers['x-fintax-client-session'])
  const clientSession = admittedLoopbackPeer && isHighEntropyClientSession(rawClientSess)
    ? rawClientSess.toLowerCase()
    : null

  const rawAssertion = pickNonEmptyString(headers['x-fintax-session-assertion'])
  const hasRawAssertionHeader = Boolean(rawAssertion)
  const verifiedAssertionId = admittedLoopbackPeer && handlerSecret
    ? verifySessionAssertion(handlerSecret, rawAssertion, clientSession || '')
    : null
  const invalidAssertionPresented = admittedLoopbackPeer && hasRawAssertionHeader && !verifiedAssertionId

  let responseAssertion = null
  let mintedAssertionId = null
  if (admittedLoopbackPeer && handlerSecret && !verifiedAssertionId && !invalidAssertionPresented && clientSession) {
    mintedAssertionId = createHmac('sha256', handlerSecret).update(`aid-v1:${clientSession}`).digest('hex').slice(0, 32)
    responseAssertion = signSessionAssertion(handlerSecret, mintedAssertionId, clientSession)
  }

  const hostParts = [
    ...stablePeerParts,
    auth ? `auth:${auth}` : '',
    authCookie ? `cookie:${authCookie}` : '',
  ].filter(Boolean)

  const explicitHostScope = hostParts.length > 0
    ? createHash('sha256').update(`host-v2:${hostParts.join('|')}`).digest('hex').slice(0, 32)
    : null

  const effectiveAssertionId = verifiedAssertionId || mintedAssertionId
  let scopeKey = null
  if (invalidAssertionPresented) {
    scopeKey = null
  } else if (explicitHostScope) {
    scopeKey = clientSession
      ? createHash('sha256').update(`scoped:${explicitHostScope}|${clientSession}`).digest('hex').slice(0, 32)
      : explicitHostScope
  } else if (effectiveAssertionId) {
    scopeKey = createHmac('sha256', handlerSecret).update(`asserted:${effectiveAssertionId}|${clientSession || ''}`).digest('hex').slice(0, 32)
  } else if (hadExistingWeakId && peerWeakId) {
    scopeKey = createHash('sha256').update(`peer-wm:${peerWeakId}|${clientSession || ''}`).digest('hex').slice(0, 32)
  }

  return {
    scopeKey,
    explicitHostScope,
    clientSession,
    verifiedAssertionId,
    mintedAssertionId,
    invalidAssertionPresented,
    responseAssertion,
    peerWeakId,
    hadExistingWeakId,
  }
}

class PublicRequestError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function bodyTooLarge() {
  return new PublicRequestError(413, 'REQUEST_TOO_LARGE', '请求体过大，请减少文件数量或拆分上传。')
}

/** 超限后停止累积，先返回 413，再由 HTTP 响应关闭连接。 */
function readJsonBody(req, maxBytes = 32_768) {
  const length = req.headers?.['content-length']
  if (/^\d+$/.test(length ?? '') && Number(length) > maxBytes) {
    req.resume()
    return Promise.reject(bodyTooLarge())
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let completed = false
    const fail = (error) => {
      if (completed) return
      completed = true
      chunks.length = 0
      reject(error)
    }
    req.on('data', (chunk) => {
      if (completed) return
      total += Buffer.byteLength(chunk)
      if (total > maxBytes) {
        fail(bodyTooLarge())
        return
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.once('end', () => {
      if (completed) return
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        const body = raw ? JSON.parse(raw) : {}
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError()
        completed = true
        resolve(body)
      } catch {
        fail(new PublicRequestError(400, 'INVALID_JSON_BODY', '请求体须为合法的 JSON 对象。'))
      }
    })
    const interrupted = () => fail(new PublicRequestError(400, 'REQUEST_INTERRUPTED', '请求读取中断，请重试。'))
    req.once('aborted', interrupted)
    req.once('error', interrupted)
    req.once('close', interrupted)
  })
}

const UPLOAD_BYTES = 20 * 1024 * 1024
const BACKUP_IMPORT_BYTES = 8 * 1024 * 1024
const MAX_PARSE_WORKERS = 2
const MAX_ARCHIVE_TOKENS = 64
const ARCHIVE_TTL_MS = 30 * 60 * 1000
const FORMATS = new Set(['all', 'data', 'html', 'md', 'csv'])
const EXPORT_FORMATS = new Set(['html', 'md', 'csv'])
const DEMOS = new Set([
  'all', 'v7', 'v8', 'v9', 'full', 'wallets',
  'amazon', 'tiktok', 'temu', 'aliexpress', 'shopee', 'shopify', 'paypal', 'stripe',
  'worldfirst', 'payoneer', 'airwallex',
])
const PLATFORMS = new Set([
  'amazon', 'tiktok', 'temu', 'aliexpress', 'shopee', 'shopify', 'paypal', 'stripe',
  'shein', 'walmart', 'lazada',
  'worldfirst', 'payoneer', 'airwallex', 'lianlian', 'pingpong', 'sunrate',
  'bank_receipt', 'bank', 'cmb', 'boc', 'icbc', 'ccb', 'abc', 'bocom',
])
const EU_ARCHIVE_SITES = new Set([
  'EU', 'EUROPE', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'IE', 'AT', 'PT',
  'FI', 'DK', 'CZ', 'RO', 'HU', 'GR', 'SK', 'BG', 'HR', 'LT', 'SI', 'LV', 'EE', 'CY', 'LU', 'MT',
])
const US_ARCHIVE_SITES = new Set(['US', 'USA', 'NA'])
const IMA_QUICK_DISCLAIMER = '仅展示 IMA 知识库命中标题与 ≤160 字只读摘要片段（严禁透传原文或公式）；完整条款请在 DSH 对话中追问或在 IMA 客户端核对原文。'
let activeParses = 0

function toWellFormedUtf16(input) {
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

function sliceUtf16Safe(input, maxLen) {
  const clean = toWellFormedUtf16(input)
  if (maxLen <= 0) return ''
  if (clean.length <= maxLen) return clean
  let end = maxLen
  const lastCode = clean.charCodeAt(end - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end--
  return clean.slice(0, end)
}

function sanitizeImaPlainText(raw, maxLen = 160) {
  const clean = toWellFormedUtf16(raw)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9:-]*(?:(?:\s+[^<>]*?)?\/?|\/)>/gi, '')
    .replace(/(?:https?:\/\/|ftp:\/\/|mailto:|www\.)\S+/gi, '')
    .replace(/(?<!:)\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[/:?#][^\s"'<>)]*)?/gi, '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (clean.length <= maxLen) return clean
  return sliceUtf16Safe(clean, Math.max(0, maxLen - 1)) + '…'
}

// Track B 接入 lib/calc.js 导出 getAllCalcSpecs()/ALL_CALC_SPECS 前的 14 引擎完整安全回退注册表
const FALLBACK_BASE_CALC_SPECS = Object.freeze([
  { code: 'platform_tax_reconcile', group: 'audit', currency: 'CNY', zh: '平台报送四层口径桥接', en: '4-Layer Platform Tax Bridge', desc: '对照平台报送、财务会计、增值税与出口、企业所得税四层口径，并独立核对资金放款。', fields: ['reportedGrossRevenue', 'reportedGrossSource', 'refunds', 'accountingRevenue', 'declaredVatSales', 'citTaxableIncome', 'marketplaceWithheldTax', 'cutoffAndFxDiff', 'platformFees', 'actualPayout'], exampleParams: { reportedGrossRevenue: 6000000, refunds: 450000, declaredVatSales: 4200000, platformFees: 600000 }, imaKeywords: ['810号令', '四层口径', '平台报送'] },
  { code: 'vat_taxpayer_threshold', group: 'audit', currency: 'CNY', zh: '500 万一般纳税人临界拐点', en: '5M General Taxpayer Cliff', desc: '核对年应征增值税销售额（严格 >500 万）、一般纳税人登记与小规模月/季起征点，试算进项抵扣临界成本。', fields: ['rolling12mTaxableSales', 'projectedAnnualGrossSales', 'deductibleCostRatio', 'hasExportRebateDemand', 'taxPeriod', 'periodTaxableSales'], exampleParams: { rolling12mTaxableSales: 4400000, projectedAnnualGrossSales: 4800000, deductibleCostRatio: 0.7 }, imaKeywords: ['一般纳税人', '500万', '增值税法'] },
  { code: 'cbec_assessed_cit', group: 'audit', currency: 'CNY', zh: '综试区 4% 核定与小型微利', en: 'CBEC Assessed CIT & Small-Profit Relief', desc: '综试区零售出口 4% 核定应税所得率、小型微利条件及 300 万超崖跳变对照试算。', fields: ['revenue', 'assessedQualificationConfirmed', 'taxableIncomeRate', 'taxYear', 'annualTaxableIncome', 'annualAverageEmployees', 'annualAverageAssets', 'nonRestrictedIndustry'], exampleParams: { revenue: 10000000, taxableIncomeRate: 0.04, taxYear: 2026 }, imaKeywords: ['综试区', '4%核定', '小型微利', '300万'] },
  { code: 'export_invoice_breakeven', group: 'export', currency: 'CNY', zh: '供应商开票加点毛利临界', en: 'Invoice Markup Breakeven g*', desc: '对比加点拿专票走免退税 vs 综试区合规无票免税，测算盈亏临界点 g* 与税后净利。', fields: ['barePurchaseAmount', 'supplierMarkupRate', 'vatRate', 'rebateRate', 'exportRevenue'], exampleParams: { barePurchaseAmount: 1000000, supplierMarkupRate: 0.08, vatRate: 0.13, rebateRate: 0.13 }, imaKeywords: ['开票加点', '无票免税', '免退税'] },
  { code: 'cbec_return_duty_exempt', group: 'export', currency: 'CNY', zh: '2026 第16号退运免税测算', en: '2026 #16 Return Duty Exemption', desc: '核验 2026–2027 年申报跨境电商出口批次专项退运免税资格与条件。', fields: ['customsCode', 'exportValueCny', 'exportDate', 'returnDate', 'returnReason', 'inOriginalCondition', 'isFood', 'refundedExportTax', 'hasTaxCertificate'], exampleParams: { customsCode: '9610', exportValueCny: 300000, exportDate: '2026-06-01', returnDate: '2026-10-01', returnReason: 'unsold', inOriginalCondition: true, isFood: false, refundedExportTax: 0, hasTaxCertificate: true }, imaKeywords: ['退运免税', '2026年第16号', '9610', '9810'] },
  { code: 'export_rebate_manufacturer', group: 'export', currency: 'CNY', zh: '生产企业“免、抵、退”税', en: 'Manufacturer Exempt-Credit-Refund', desc: '生产企业出口自产货物五步法免抵退税及免抵附加税预警测算。', fields: ['exportFobCny', 'totalInputVat', 'vatRate', 'rebateRate', 'domesticOutputVat'], exampleParams: { exportFobCny: 2000000, totalInputVat: 220000, vatRate: 0.13, rebateRate: 0.13, domesticOutputVat: 40000 }, imaKeywords: ['免抵退', '生产企业出口退税'] },
  { code: 'export_rebate_cancel_impact', group: 'export', currency: 'CNY', zh: '退税取消与电池消费税双税冲击', en: 'Rebate Cancellation & Battery Excise Impact', desc: '测算 2026#2/#29 退税取消/下调与 2026#20 电池消费税（CMA 门禁/成品充电宝豁免）双税毛利冲击及保毛利涨价。', fields: ['purchaseGrossCny', 'exportFobCny', 'oldRebateRate', 'newRebateRate', 'isConsumptionTaxItem', 'isFinishedPowerBank'], exampleParams: { purchaseGrossCny: 113, exportFobCny: 135.6, oldRebateRate: 0.06, newRebateRate: 0 }, imaKeywords: ['退税取消', '电池消费税', '2026年第11号', 'CMA'] },
  { code: 'export_rebate', group: 'export', currency: 'CNY', zh: '外贸企业出口免退税', en: 'Trading Export VAT Rebate', desc: '按专票不含税额与征退税率孰低规则精算外贸企业应退税额及征退税率差转成本。', fields: ['purchaseAmount', 'vatRate', 'rebateRate'], exampleParams: { purchaseAmount: 500000, vatRate: 0.13, rebateRate: 0.09 }, imaKeywords: ['外贸企业出口退税', '免退税'] },
  { code: 'annual_bonus_iit', group: 'general', currency: 'CNY', zh: '年终奖双轨比选与 6 盲区', en: 'Annual Bonus Dual-Track IIT', desc: '全年一次性奖金单独计税 vs 并入综合所得双轨最优比选与 6 档临界陷阱检测。', fields: ['bonus', 'annualComprehensiveTaxableIncome', 'annualSalary'], exampleParams: { bonus: 36001 }, imaKeywords: ['年终奖', '单独计税', '个人所得税'] },
  { code: 'cross_border_import', group: 'general', currency: 'CNY', zh: '跨境零售进口综合税', en: 'Cross-Border Retail Import Tax', desc: '跨境电商零售进口限额内 70% 综合税与单次/年度限额超限预警。', fields: ['price', 'vatRate', 'consumptionTaxRate', 'annualUsed'], exampleParams: { price: 1200, vatRate: 0.13, consumptionTaxRate: 0.15, annualUsed: 0 }, imaKeywords: ['跨境零售进口', '综合税', '1210'] },
  { code: 'vat', group: 'general', currency: 'CNY', zh: '增值税价税分离', en: 'VAT Split', desc: '对齐 2026《增值税法》口径的含税/不含税双向精确换算。', fields: ['amount', 'rate', 'inclusive'], exampleParams: { amount: 1130000, rate: 0.13, inclusive: true }, imaKeywords: ['增值税法', '价税分离'] },
])

function resolveAllCalcSpecs() {
  if (typeof calcModule.getAllCalcSpecs === 'function') {
    const list = calcModule.getAllCalcSpecs()
    if (Array.isArray(list) && list.length >= 14) return list
  }
  if (Array.isArray(calcModule.ALL_CALC_SPECS) && calcModule.ALL_CALC_SPECS.length >= 14) {
    return calcModule.ALL_CALC_SPECS
  }
  const byCode = new Map()
  for (const spec of [...FALLBACK_BASE_CALC_SPECS, ...CROSSBORDER_CALC_SPECS]) {
    if (spec?.code) byCode.set(spec.code, spec)
  }
  return [...byCode.values()]
}

function prepareParseRequest(body) {
  const reportFormat = body.reportFormat === undefined
    ? (body.exportFormat === undefined ? 'all' : body.exportFormat)
    : body.reportFormat
  if (!FORMATS.has(reportFormat)) throw new PublicRequestError(400, 'INVALID_REPORT_FORMAT', '报告格式无效。')
  const platform = String(body.platform ?? 'auto').trim().toLowerCase() || 'auto'
  if (platform !== 'auto' && !PLATFORMS.has(platform)) {
    throw new PublicRequestError(400, 'INVALID_STATEMENT_PLATFORM', '账单通道无效。')
  }
  const demo = typeof body.demo === 'string' ? body.demo.trim().toLowerCase().replace(/^demo:/, '') : ''
  if (body.demo != null && (typeof body.demo !== 'string' || !DEMOS.has(demo) || body.files?.length)) {
    throw new PublicRequestError(400, 'INVALID_DEMO', '请选择有效的示例，或单独上传账单。')
  }
  let files = []
  if (!demo) {
    if (!Array.isArray(body.files) || !body.files.length) throw new PublicRequestError(400, 'FILES_REQUIRED', '请上传至少一份账单文件。')
    if (body.files.length > 24) throw new PublicRequestError(413, 'FILE_COUNT_LIMIT', '单次最多解析 24 份账单文件，请分批上传。')
    let decodedBytes = 0
    files = body.files.map((file) => {
      const name = typeof file?.name === 'string' ? file.name.trim() : ''
      const dataBase64 = file?.dataBase64
      if (name.length > 255 || !name || /[/\\:\p{Cc}\p{Cf}]/u.test(name) || !/\.(csv|tsv|txt|xlsx|xlsm|zip)$/i.test(name)) {
        throw new PublicRequestError(400, 'INVALID_FILE_NAME', '账单文件名或扩展名无效。')
      }
      if (typeof dataBase64 !== 'string' || !dataBase64.length || dataBase64.length % 4 !== 0 ||
          /[^A-Za-z0-9+/=]/.test(dataBase64) || !/^[^=]+={0,2}$/.test(dataBase64) ||
          (dataBase64.endsWith('==') && !/[AQgw]==$/.test(dataBase64)) ||
          (dataBase64.endsWith('=') && !dataBase64.endsWith('==') && !/[AEIMQUYcgkosw048]=$/.test(dataBase64))) {
        throw new PublicRequestError(400, 'INVALID_FILE_DATA', '账单文件内容编码无效。')
      }
      decodedBytes += dataBase64.length / 4 * 3 - (dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0)
      if (decodedBytes > UPLOAD_BYTES) throw new PublicRequestError(413, 'FILE_BYTES_LIMIT', '账单文件合计最多 20 MiB，请拆分上传。')
      return { name, dataBase64 }
    })
  }
  if (body.fxConfirmed !== undefined && typeof body.fxConfirmed !== 'boolean') {
    throw new PublicRequestError(400, 'INVALID_FX_CONFIRMATION', '汇率确认须为布尔值。')
  }
  return {
    demo, files, platform, reportFormat, includeResourceAppendix: body.includeResourceAppendix === true,
    options: { fxRateToCny: body.fxRateToCny, fxRates: normalizeFxMap(body.fxRates), declaredVatSalesCny: body.declaredVatSalesCny },
  }
}

function parseInWorker(input, res) {
  if (activeParses >= MAX_PARSE_WORKERS) {
    throw new PublicRequestError(503, 'PARSE_BUSY', '账单正在处理中，请稍后重试。')
  }
  const worker = new Worker(new URL('./lib/parse_worker.js', import.meta.url), {
    workerData: input,
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 384 },
  })
  activeParses++
  worker.once('exit', () => { activeParses-- })
  return new Promise((resolve, reject) => {
    const failed = () => reject(new PublicRequestError(503, 'PARSE_INTERRUPTED', '账单处理超时或中断，请拆分账单后重试。'))
    const cancel = () => {
      void worker.terminate()
      failed()
    }
    const timeout = setTimeout(cancel, 30_000)
    const finish = () => {
      clearTimeout(timeout)
      res?.removeListener?.('close', cancel)
    }
    res?.once?.('close', cancel)
    worker.once('message', (value) => { finish(); resolve(value) })
    worker.once('error', () => { finish(); failed() })
    worker.once('exit', () => { finish(); failed() })
  })
}

function buildArchiveKpis(rawSummaries, consolidated, parseOptions = {}) {
  const opts = parseOptions && typeof parseOptions === 'object' ? parseOptions : { declaredVatSalesCny: parseOptions }
  const declaredVatSalesCny = opts.declaredVatSalesCny
  const fxRates = opts.fxRates && typeof opts.fxRates === 'object' ? opts.fxRates : {}
  const c = consolidated
  const summaries = rawSummaries || []
  const counts = { P0: 0, P1: 0, P2: 0 }
  for (const summary of summaries) {
    for (const anomaly of summary.anomalies || []) {
      const severity = String(anomaly.severity || '').slice(0, 2)
      if (Object.hasOwn(counts, severity)) counts[severity]++
    }
  }
  const salesSummaries = summaries.filter((s) => s.role !== 'settlement_wallet' && s.role !== 'bank_receipt')
  const sites = [...new Set(salesSummaries.map((s) => s.site).filter((x) => typeof x === 'string' && /^(?:[A-Z]{2,3}|EUROPE|DTC|GLOBAL)$/.test(x)))]
  const currencies = [...new Set(salesSummaries.map((s) => s.currency).filter((x) => typeof x === 'string' && /^[A-Z]{3}$/.test(x)))]
  const foreignCurrencies = currencies.filter((ccy) => ccy !== 'CNY')
  const singleFx = Number.isFinite(Number(opts.fxRateToCny)) && Number(opts.fxRateToCny) > 0 && foreignCurrencies.length === 1
    ? Number(opts.fxRateToCny)
    : null
  const fxEur = Number(fxRates.EUR) > 0 ? Number(fxRates.EUR) : (foreignCurrencies[0] === 'EUR' && singleFx ? singleFx : 7.8)
  const fxUsd = Number(fxRates.USD) > 0 ? Number(fxRates.USD) : (foreignCurrencies[0] === 'USD' && singleFx ? singleFx : 7.2)

  // 将 rawSummaries 按顺序对齐到 consolidated.breakdown，获取不重叠销售表及订单笔数
  const rawByIdx = summaries
  const activeSalesRows = []
  ;(c.breakdown || []).forEach((b, idx) => {
    if (b.role !== 'sales_platform') return
    const rawS = rawByIdx[idx]
    const rawOrderCnt = rawS
      ? (rawS.orderCount ?? rawS.positiveOrderCount ?? rawS.transactionCount)
      : (b.orderCount ?? b.transactionCount)
    const orderCount = Number.isSafeInteger(rawOrderCnt) && rawOrderCnt >= 0
      ? rawOrderCnt
      : (Number.isSafeInteger(b.orderCount) && b.orderCount >= 0 ? b.orderCount : null)
    const grossOrigNum = Number.isFinite(Number(b.grossOrig))
      ? Number(b.grossOrig)
      : (rawS && typeof rawS.taxReportingGrossRef === 'bigint' ? toNumber2(rawS.taxReportingGrossRef) : null)
    activeSalesRows.push({
      platform: b.platform,
      site: b.site || rawS?.site || null,
      currency: b.currency || rawS?.currency || null,
      grossCny: b.grossCny ?? 0,
      refundCny: b.refundCny ?? 0,
      netSalesCny: b.netSalesCny ?? 0,
      feesCny: b.feesCny ?? 0,
      payoutCny: b.payoutCny ?? 0,
      grossOrig: grossOrigNum,
      transactionCount: orderCount,
    })
  })

  const euRows = activeSalesRows.filter((r) => r.site && EU_ARCHIVE_SITES.has(r.site))
  const usRows = activeSalesRows.filter((r) => (r.site && US_ARCHIVE_SITES.has(r.site)) || r.platform === 'Walmart')

  let euOrigSum = 0
  let euOrigCnt = 0
  let euEstSum = 0
  let euEstCnt = 0
  let euOrdSum = 0
  let euOrdKnown = 0
  let euOrdMissing = false
  for (const r of euRows) {
    if (r.currency === 'EUR' && r.grossOrig !== null) {
      euOrigSum += r.grossOrig
      euOrigCnt++
    } else if (r.grossCny > 0 && fxEur > 0) {
      euEstSum += r.grossCny / fxEur
      euEstCnt++
    }
    if (r.transactionCount !== null) {
      euOrdSum += r.transactionCount
      euOrdKnown++
    } else {
      euOrdMissing = true
    }
  }
  const euSalesEur = (euOrigCnt > 0 || euEstCnt > 0) ? Math.round((euOrigSum + euEstSum) * 100) / 100 : null
  const euOrderCount = euRows.length > 0 && euOrdKnown > 0 && !euOrdMissing ? euOrdSum : null

  let usOrigSum = 0
  let usOrigCnt = 0
  let usEstSum = 0
  let usEstCnt = 0
  let usOrdSum = 0
  let usOrdKnown = 0
  let usOrdMissing = false
  for (const r of usRows) {
    if (r.currency === 'USD' && r.grossOrig !== null) {
      usOrigSum += r.grossOrig
      usOrigCnt++
    } else if (r.grossCny > 0 && fxUsd > 0) {
      usEstSum += r.grossCny / fxUsd
      usEstCnt++
    }
    if (r.transactionCount !== null) {
      usOrdSum += r.transactionCount
      usOrdKnown++
    } else {
      usOrdMissing = true
    }
  }
  const usSalesUsd = (usOrigCnt > 0 || usEstCnt > 0) ? Math.round((usOrigSum + usEstSum) * 100) / 100 : null
  const usTransactionCount = usRows.length > 0 && usOrdKnown > 0 && !usOrdMissing ? usOrdSum : null

  const hasMixed = (euOrigCnt > 0 && euEstCnt > 0) || (usOrigCnt > 0 && usEstCnt > 0)
  const hasEstOnly = !hasMixed && ((euOrigCnt === 0 && euEstCnt > 0) || (usOrigCnt === 0 && usEstCnt > 0)) && euOrigCnt === 0 && usOrigCnt === 0
  const currencySource = hasMixed ? 'mixed_estimated' : hasEstOnly ? 'estimated_from_cny' : ((euOrigCnt > 0 || usOrigCnt > 0) ? 'recorded_orig' : null)

  const fc = c.fundChain
  const s3 = fc?.stage3 || null
  const rawS3Status = s3?.stage3Status ?? fc?.stage3VerificationStatus ?? null
  const stage3Status = ['matched', 'partial', 'candidate_only', 'pending_bank_receipt'].includes(rawS3Status)
    ? rawS3Status
    : (rawS3Status ? 'pending_bank_receipt' : null)
  const stage3CorporateRepatriatedCny = fc && fc.walletCount > 0 ? fc.stage3CorporateRepatriatedCny : null
  const stage3ExpectedCny = s3?.stage2CorporateExpectedCny ?? stage3CorporateRepatriatedCny
  const stage3BankReceivedCny = fc?.bankReceivedCny ?? (s3 && s3.stats?.matchedCount > 0 ? s3.stage3MatchedCny : null)
  const stage3UnmatchedCny = s3
    ? (s3.inTransitUnmatchedCny ?? s3.fxGapOrInTransitCny ?? Math.max(0, Math.round(((stage3ExpectedCny ?? 0) - (stage3BankReceivedCny ?? 0)) * 100) / 100))
    : null
  const stage3CoverageComplete = Boolean(c.coverageComplete !== false)
  const stage3Verified = Boolean(
    stage3CoverageComplete &&
    stage3Status === 'matched' &&
    stage3BankReceivedCny !== null &&
    (stage3UnmatchedCny ?? 0) === 0,
  )

  return {
    platforms: [...new Set(summaries.filter((item) => item.role !== 'bank_receipt').map((item) => item.platform))],
    sheetCount: summaries.length,
    rowCount: summaries.reduce((total, item) => total + (item.rawRowCount || 0), 0),
    grossCny: c.totals.grossCny,
    refundCny: c.totals.refundCny,
    netSalesCny: c.totals.netSalesCny,
    feesCny: c.totals.feesCny,
    payoutCny: c.totals.payoutCny,
    stage2WalletInboundCny: fc && fc.walletCount > 0 ? fc.stage2WalletInboundCny : null,
    stage3CorporateRepatriatedCny,
    stage3ExpectedCny,
    stage3BankReceivedCny,
    stage3UnmatchedCny,
    stage3Status,
    stage3CoverageComplete,
    stage3Verified,
    currencySource,
    sites,
    currencies,
    euSalesEur,
    euOrderCount,
    usSalesUsd,
    usTransactionCount,
    platformBreakdown: activeSalesRows,
    p0Count: counts.P0,
    p1Count: counts.P1,
    p2Count: counts.P2,
    declaredVatSalesCny,
  }
}

function getArchiveMonth(summaries = []) {
  const months = new Set(summaries.map((item) => item.period))
  const [month] = months
  return months.size === 1 && /^(?:201[5-9]|20[2-9][0-9])-(?:0[1-9]|1[0-2])$/.test(month) ? month : undefined
}

/** 创建设置页与工作台后端路由处理器（导出以便单元测试直接验证准入、缓存与脱敏逻辑）。 */
export function createFintaxApiHandler({ getConnection, parseCacheOptions } = {}) {
  const archiveTokens = new Map()
  const peerWeakIds = new WeakMap()
  const handlerSecret = randomBytes(32)
  const parseCache = createParseCache(parseCacheOptions)
  return async function handleFintaxApi(req, res) {
    let sessionCtx = null
    const send = (status, payload) => {
      if (res.destroyed || res.writableEnded) return
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(sessionCtx?.responseAssertion ? { 'x-fintax-session-assertion': sessionCtx.responseAssertion } : {}),
        ...(status === 413 ? { connection: 'close' } : {}),
      })
      res.end(body)
    }

    let admission = { rejection: 503, peer: null }
    try {
      admission = evaluateAdmission(req, typeof getConnection === 'function' ? getConnection() : undefined)
    } catch { /* Host services can be unavailable during initialization. */ }
    if (admission.rejection !== undefined) {
      return send(admission.rejection, {
        error: admission.rejection === 401 ? '未登录或会话无效' : admission.rejection === 503 ? '宿主连接准入服务未就绪' : '拒绝访问',
      })
    }
    sessionCtx = deriveSessionContext(req, admission.peer, peerWeakIds, handlerSecret)
    const { scopeKey } = sessionCtx

    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const marker = '/api/fintax'
      const idx = url.pathname.indexOf(marker)
      const subPath = (idx >= 0 ? url.pathname.slice(idx + marker.length) : url.pathname).replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      if (subPath === '/status' && method === 'GET') {
        return send(200, {
          ok: true,
          version: PKG_VERSION,
          supportedChannels: 17,
          calcEngineCount: 14,
          capabilities: {
            stage3BankReconcile: true,
            annualSummary: true,
            parseCache: true,
            imaQuickDrawer: true,
            archiveBackup: true,
            entityReassign: true,
            dshMarketUpdateV1: true,
          },
          ...getPublicStatus(),
        })
      }

      if (subPath === '/credentials' && method === 'POST') {
        const body = await readJsonBody(req)
        const cid = typeof body?.clientId === 'string' ? body.clientId.trim() : ''
        const key = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!cid && !key) {
          return send(400, { error: '请至少填写 Client ID 或 API Key 后再保存' })
        }
        saveCredentials({ clientId: cid, apiKey: key })
        return send(200, { ok: true, ...getPublicStatus() })
      }

      if (subPath === '/credentials' && method === 'DELETE') {
        clearCredentials()
        return send(200, { ok: true, ...getPublicStatus() })
      }

      if (subPath === '/settings' && method === 'POST') {
        const body = await readJsonBody(req)
        const patch = {}
        if (body && Object.prototype.hasOwnProperty.call(body, 'defaultKbId')) patch.defaultKbId = body.defaultKbId ?? ''
        if (body && Object.prototype.hasOwnProperty.call(body, 'defaultKbName')) patch.defaultKbName = body.defaultKbName ?? ''
        if (body && Object.prototype.hasOwnProperty.call(body, 'customFxRates')) patch.customFxRates = body.customFxRates
        saveFintaxSettings(patch)
        return send(200, { ok: true, ...getPublicStatus() })
      }

      if (subPath === '/kbs' && method === 'GET') {
        if (!loadCredentials()) {
          return send(400, { error: '尚未配置完整的 IMA Client ID 与 API Key，请先保存凭证' })
        }
        const data = await imaCall(
          'openapi/wiki/v1/search_knowledge_base',
          {
            query: url.searchParams.get('query') ?? '',
            cursor: '',
            limit: 50,
          },
          { noCache: url.searchParams.get('refresh') === '1' },
        )
        const list = data.info_list ?? data.knowledge_base_list ?? data.list ?? []
        const kbs = Array.isArray(list)
          ? list.map((kb) => ({
              id: String(kb.kb_id ?? kb.id ?? ''),
              name: String(kb.kb_name ?? kb.name ?? '未命名知识库'),
              count: kb.content_count != null ? String(kb.content_count) : '',
              description: String(kb.description ?? ''),
            }))
          : []
        return send(200, { ok: true, kbs })
      }

      if (subPath === '/calc/specs' && method === 'GET') {
        const specs = resolveAllCalcSpecs()
        return send(200, {
          ok: true,
          version: PKG_VERSION,
          calcEngineCount: specs.length,
          scenarios: specs.map((spec) => spec.code),
          specs,
        })
      }

      if (subPath === '/calc' && method === 'POST') {
        const body = await readJsonBody(req, 65_536)
        const scenario = String(body?.scenario ?? '').trim()
        if (!scenario) return send(400, { code: 'INVALID_CALC_INPUT', error: 'scenario（算税场景标识）不能为空' })
        try {
          const result = calculate(scenario, body?.params || {})
          return send(200, { ok: true, result })
        } catch (calcErr) {
          const safeMsg = calcErr instanceof CalcInputError && typeof calcErr.message === 'string' && calcErr.message.trim()
            ? sliceUtf16Safe(calcErr.message.replace(/[\r\n]+/g, ' ').trim(), 200)
            : '试算参数校验失败，请核对场景和各项输入。'
          return send(400, { code: 'INVALID_CALC_INPUT', error: safeMsg })
        }
      }

      if (subPath === '/parse/export' && method === 'POST') {
        const body = await readJsonBody(req, 32_768)
        const format = String(body?.format ?? '').trim().toLowerCase()
        if (!EXPORT_FORMATS.has(format)) {
          return send(400, { ok: false, code: 'INVALID_EXPORT_FORMAT', error: 'INVALID_EXPORT_FORMAT', message: '导出格式须为 html、md 或 csv。' })
        }
        const hit = scopeKey ? parseCache.get(body?.cacheToken, scopeKey) : null
        if (!hit) {
          return send(404, {
            ok: false,
            code: 'CACHE_EXPIRED',
            error: 'CACHE_EXPIRED',
            message: '解析缓存已过期或不存在，请重新解析账单后导出。',
          })
        }
        const { summaries, consolidated, coverage } = hit.result
        const includeResourceAppendix = body?.includeResourceAppendix === true
        const renderOptions = { summaries, consolidated, coverage, version: PKG_VERSION, includeResourceAppendix }
        const stamp = getArchiveMonth(summaries) || new Date().toISOString().slice(0, 10).replace(/-/g, '')
        if (format === 'html') {
          return send(200, {
            ok: true,
            format: 'html',
            filename: `dsh-fintax-audit-${stamp}.html`,
            content: renderDiagnosticReportHtml(renderOptions),
            mimeType: 'text/html; charset=utf-8',
            fromCache: true,
          })
        }
        if (format === 'md') {
          return send(200, {
            ok: true,
            format: 'md',
            filename: `dsh-fintax-audit-${stamp}.md`,
            content: renderDiagnosticReportMd(renderOptions),
            mimeType: 'text/markdown; charset=utf-8',
            fromCache: true,
          })
        }
        return send(200, {
          ok: true,
          format: 'csv',
          filename: `dsh-fintax-anomalies-${stamp}.csv`,
          content: renderAnomaliesCsv(renderOptions),
          mimeType: 'text/csv; charset=utf-8',
          fromCache: true,
        })
      }

      if (subPath === '/parse' && method === 'POST') {
        const body = await readJsonBody(req, 28 * 1024 * 1024)
        const input = prepareParseRequest(body)
        const payload = await parseInWorker(input, res)
        if (payload.error) return send(400, payload)
        const { _rawSummaries, ...publicPayload } = payload
        const rawSummaries = Array.isArray(_rawSummaries) ? _rawSummaries : []
        const cached = rawSummaries.length && scopeKey
          ? parseCache.put({ summaries: rawSummaries, consolidated: publicPayload.consolidated, coverage: publicPayload.coverage }, { scopeKey })
          : { cached: false, cacheToken: null }
        const cacheToken = cached.cached ? cached.cacheToken : null

        const fxConfirmationNeeded = Boolean(rawSummaries.some((summary) => summary.role !== 'bank_receipt' && summary.currency !== 'CNY') && !body.fxConfirmed)
        const archiveMonth = getArchiveMonth(rawSummaries)
        let archiveBlockReason
        let archiveToken
        if (input.demo) archiveBlockReason = '示例仅供预览。'
        else if (!publicPayload.coverage.complete) archiveBlockReason = '请核对未解析账单或工作表后重新导入。'
        else if (!publicPayload.consolidated.ready || fxConfirmationNeeded) archiveBlockReason = '请核对账单币种并确认所用汇率。'
        else if (rawSummaries.length && !archiveMonth) archiveBlockReason = '请按可识别的单一账期分别导入归档。'
        else if (rawSummaries.length) {
          const now = Date.now()
          for (const [tokKey, entry] of archiveTokens) {
            if (entry.expiresAt <= now) archiveTokens.delete(tokKey)
          }
          if (archiveTokens.size >= MAX_ARCHIVE_TOKENS) archiveTokens.delete(archiveTokens.keys().next().value)
          const minted = mintSignedArchiveToken(handlerSecret, archiveMonth)
          archiveToken = minted.token
          archiveTokens.set(minted.tokId, {
            expiresAt: now + ARCHIVE_TTL_MS,
            secretHash: minted.secretHash,
            sig: minted.sig,
            month: archiveMonth,
            boundHostScope: sessionCtx.explicitHostScope,
            boundVerifiedAssertionId: sessionCtx.verifiedAssertionId,
            mintedAssertionId: sessionCtx.mintedAssertionId,
            boundClientSession: sessionCtx.clientSession,
            boundPeerWeakId: sessionCtx.hadExistingWeakId ? sessionCtx.peerWeakId : null,
            kpis: buildArchiveKpis(rawSummaries, publicPayload.consolidated, input.options),
          })
        }
        return send(200, { ok: true, version: PKG_VERSION, ...publicPayload, cacheToken, fxConfirmationNeeded, archiveToken, archiveMonth, archiveBlockReason })
      }

      if (subPath === '/history/annual' && method === 'GET') {
        const yearRaw = (url.searchParams.get('year') ?? '').trim()
        const entityKeyParam = (url.searchParams.get('entityKey') ?? '').trim()
        const entityNameParam = (url.searchParams.get('entity') ?? url.searchParams.get('entityName') ?? '').trim()
        const shopKey = (url.searchParams.get('shopKey') ?? url.searchParams.get('shop') ?? url.searchParams.get('storeScope') ?? '').trim()
        const format = (url.searchParams.get('format') ?? 'json').trim().toLowerCase() || 'json'
        if (!['json', 'html', 'md'].includes(format)) {
          return send(400, { ok: false, code: 'INVALID_REPORT_FORMAT', error: '年度导出格式须为 json、html 或 md。' })
        }
        const includeResourceAppendix = ['1', 'true', 'yes'].includes((url.searchParams.get('includeResourceAppendix') ?? '').trim().toLowerCase())
        const summary = buildAnnualSummary(null, {
          ...(yearRaw ? { year: Number(yearRaw) } : {}),
          ...(entityKeyParam ? { entityKey: entityKeyParam } : {}),
          ...(!entityKeyParam && entityNameParam ? { entityName: entityNameParam } : {}),
          ...(shopKey ? { shopKey } : {}),
        })
        if (format === 'html') {
          return send(200, {
            ok: true,
            format: 'html',
            filename: `dsh-fintax-annual-${summary.year}.html`,
            content: renderAnnualSummaryHtml(summary, { version: PKG_VERSION, includeResourceAppendix }),
            mimeType: 'text/html; charset=utf-8',
            summary,
          })
        }
        if (format === 'md') {
          return send(200, {
            ok: true,
            format: 'md',
            filename: `dsh-fintax-annual-${summary.year}.md`,
            content: renderAnnualSummaryMarkdown(summary, { version: PKG_VERSION, includeResourceAppendix }),
            mimeType: 'text/markdown; charset=utf-8',
            summary,
          })
        }
        return send(200, { ok: true, summary })
      }

      if (subPath === '/history/reassign' && method === 'POST') {
        const body = await readJsonBody(req, 32_768)
        const patch = {}
        for (const key of [
          'entityKey', 'entityLabel', 'entityName', 'shopKey', 'shopLabel', 'storeScope',
          'vatTaxpayerType', 'citAssessedMode', 'euOrderCount', 'usTransactionCount',
          'euSalesEur', 'usSalesUsd', 'declaredVatSalesCny', 'force', 'expectedRevision',
        ]) {
          if (Object.hasOwn(body, key) && body[key] !== undefined) patch[key] = body[key]
        }
        const result = reassignArchiveEntity(null, body?.archiveId, patch)
        if (result.conflict) {
          const isRevisionConflict = result.reason === 'revision_mismatch' || result.conflictType === 'revision_conflict'
          return send(409, {
            ok: false,
            code: isRevisionConflict ? 'REVISION_CONFLICT' : 'ARCHIVE_CONFLICT',
            conflictType: isRevisionConflict ? 'revision_conflict' : 'source_key_collision',
            error: isRevisionConflict
              ? '该归档快照版本已过期（可能已在别处更新），请刷新最新数据后重试。'
              : '重分配后的主体/店铺/账期与已有归档冲突，请确认后显式传 force: true 覆盖。',
            ...result,
          })
        }
        return send(200, { ok: true, ...result })
      }

      if (subPath === '/history/backup' && method === 'GET') {
        const backup = exportArchiveBackup(null)
        const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        return send(200, {
          ok: true,
          filename: `dsh-fintax-history-backup-${ymd}.json`,
          backup,
        })
      }

      if (subPath === '/history/backup' && method === 'POST') {
        const body = await readJsonBody(req, BACKUP_IMPORT_BYTES)
        if (!Object.hasOwn(body, 'backup') || body.backup === undefined || body.backup === null) {
          return send(400, { ok: false, code: 'INVALID_BACKUP_PAYLOAD', error: '请提供有效的 backup 备份数据对象。' })
        }
        // HTTP 备份导入强制启用 SHA-256 完整性防损校验，严禁客户端传入 verifyChecksum: false 绕过
        const result = importArchiveBackup(null, body.backup, {
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          verifyChecksum: true,
        })
        return send(200, { ok: true, ...result })
      }

      if (subPath === '/ima-quick' && method === 'POST') {
        const body = await readJsonBody(req, 32_768)
        const query = typeof body?.query === 'string' ? sliceUtf16Safe(body.query.trim(), 200) : ''
        if (!query) {
          return send(400, { ok: false, code: 'IMA_QUERY_REQUIRED', error: '请填写检索关键词。' })
        }
        const rawLimit = body?.limit === undefined || body?.limit === null || body?.limit === '' ? 6 : Number(body.limit)
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(8, Math.trunc(rawLimit))) : 6
        if (!loadCredentials()) {
          return send(200, {
            ok: true,
            configured: false,
            hits: [],
            message: '请先在设置页配置 IMA Client ID 与 API Key',
          })
        }
        const kbId = String(body?.kbId ?? '').trim() || String(loadFintaxSettings().defaultKbId ?? '').trim()
        if (!kbId) {
          return send(200, {
            ok: true,
            configured: true,
            query,
            usedFallback: false,
            fallbackTerms: [],
            hits: [],
            message: '请先在设置页绑定默认财税知识库，或指定 kbId 后检索。',
            disclaimer: IMA_QUICK_DISCLAIMER,
          })
        }
        const data = await searchImaKnowledge({ query, knowledge_base_id: kbId, cursor: '' })
        const list = Array.isArray(data.info_list) ? data.info_list : []
        const hits = list.slice(0, limit).map((it) => ({
          title: sanitizeImaPlainText(it?.title ?? '', 120),
          folderPath: sanitizeImaPlainText(it?.folder_path ?? it?.parent_folder_name ?? '', 160),
          snippet: sanitizeImaPlainText(it?.highlight_content ?? it?.snippet ?? it?.summary ?? '', 160),
        }))
        const fallbackTerms = Array.isArray(data.fallback?.queries) ? data.fallback.queries : []
        return send(200, {
          ok: true,
          configured: true,
          query,
          usedFallback: fallbackTerms.length > 0,
          fallbackTerms,
          hits,
          disclaimer: IMA_QUICK_DISCLAIMER,
        })
      }

      if (subPath === '/history' && method === 'GET') {
        const entityKey = (url.searchParams.get('entityKey') ?? '').trim()
        const entityName = (url.searchParams.get('entity') ?? '').trim()
        const history = loadHistory()
        const r12Opts = entityKey ? { entityKey } : { entityName }
        return send(200, { ok: true, history, rolling12m: computeRolling12m(history, r12Opts) })
      }

      if (subPath === '/history/report' && method === 'GET') {
        const entityKey = (url.searchParams.get('entityKey') ?? '').trim()
        const entityName = (url.searchParams.get('entity') ?? '').trim()
        const history = loadHistory()
        const rolling12m = computeRolling12m(history, entityKey ? { entityKey } : { entityName })
        const reportHtml = renderRollingTrendReportHtml({ history, rolling12m, version: PKG_VERSION })
        return send(200, { ok: true, version: PKG_VERSION, reportHtml })
      }

      if (subPath === '/history' && method === 'POST') {
        const hasInlineFiles = Boolean(req.headers?.['content-length'] && Number(req.headers['content-length']) > 65_536)
        const body = await readJsonBody(req, hasInlineFiles ? 28 * 1024 * 1024 : 2 * 1024 * 1024)
        let verifiedMonth = null
        let verifiedKpis = null
        let consumedTokId = null

        if (body.archiveToken !== undefined && body.archiveToken !== null && body.archiveToken !== '') {
          const parsedTok = parseAndVerifyArchiveToken(handlerSecret, body.archiveToken, archiveTokens)
          const ev = parsedTok?.entry || null
          let sessionBoundOk = false
          if (ev && ev.expiresAt > Date.now() && !sessionCtx.invalidAssertionPresented) {
            const hostOk = ev.boundHostScope !== null
              ? (sessionCtx.explicitHostScope !== null && safeScopeEqual(ev.boundHostScope, sessionCtx.explicitHostScope))
              : sessionCtx.explicitHostScope === null
            const assertionOk = ev.boundVerifiedAssertionId !== null
              ? (sessionCtx.verifiedAssertionId !== null && safeScopeEqual(ev.boundVerifiedAssertionId, sessionCtx.verifiedAssertionId))
              : (sessionCtx.verifiedAssertionId === null || (ev.mintedAssertionId !== null && safeScopeEqual(ev.mintedAssertionId, sessionCtx.verifiedAssertionId)))
            const clientSessOk = ev.boundClientSession !== null
              ? (sessionCtx.clientSession !== null && safeScopeEqual(ev.boundClientSession, sessionCtx.clientSession))
              : sessionCtx.clientSession === null
            const weakPeerOk = ev.boundPeerWeakId !== null
              ? (sessionCtx.peerWeakId !== null && safeScopeEqual(ev.boundPeerWeakId, sessionCtx.peerWeakId))
              : true
            sessionBoundOk = hostOk && assertionOk && clientSessOk && weakPeerOk
          }
          if (!ev || !sessionBoundOk) {
            return send(400, { code: 'ARCHIVE_EVIDENCE_REQUIRED', error: '请重新核对完整账单并确认所用汇率，再提交归档。' })
          }
          verifiedMonth = ev.month
          verifiedKpis = ev.kpis
          consumedTokId = parsedTok.tokId
        } else if (Array.isArray(body.files) && body.files.length > 0) {
          const input = prepareParseRequest({ ...body, reportFormat: 'data' })
          const payload = await parseInWorker(input, res)
          if (payload.error) return send(400, payload)
          const rawSummaries = Array.isArray(payload._rawSummaries) ? payload._rawSummaries : []
          const needFx = Boolean(rawSummaries.some((s) => s.role !== 'bank_receipt' && s.currency !== 'CNY') && !body.fxConfirmed)
          const recomputedMonth = getArchiveMonth(rawSummaries)
          if (!rawSummaries.length || !payload.coverage?.complete || !payload.consolidated?.ready || needFx || !recomputedMonth) {
            return send(400, { code: 'ARCHIVE_EVIDENCE_REQUIRED', error: '请重新核对完整账单并确认所用汇率，再提交归档。' })
          }
          verifiedMonth = recomputedMonth
          verifiedKpis = buildArchiveKpis(rawSummaries, payload.consolidated, input.options)
        } else {
          return send(400, { code: 'ARCHIVE_EVIDENCE_REQUIRED', error: '请重新核对完整账单并确认所用汇率，再提交归档。' })
        }

        if (body.month !== verifiedMonth) {
          return send(400, { code: 'ARCHIVE_PERIOD_MISMATCH', error: '归档账期须与已核对账单账期一致。' })
        }
        const saved = saveSnapshot({ ...body, ...verifiedKpis })
        if (saved.conflict) {
          const isRevisionConflict = saved.conflictType === 'revision_conflict' || saved.reason === 'revision_mismatch'
          return send(409, {
            ok: false,
            code: isRevisionConflict ? 'REVISION_CONFLICT' : 'ARCHIVE_CONFLICT',
            conflictType: saved.conflictType || (isRevisionConflict ? 'revision_conflict' : 'source_key_collision'),
            error: isRevisionConflict
              ? '目标归档快照版本已过期（可能已在别处更新），请刷新最新归档版本后重试。'
              : '同主体同店铺同账期的归档已存在，请确认覆盖目标或作为补充另存。',
            ...saved,
          })
        }
        if (consumedTokId) archiveTokens.delete(consumedTokId)
        const filterEntityKey = typeof body.filterEntityKey === 'string' ? body.filterEntityKey.trim() : ''
        const filterEntity = typeof body.filterEntity === 'string' ? body.filterEntity.trim() : ''
        const rolling12m = filterEntityKey
          ? computeRolling12m(saved.history, { entityKey: filterEntityKey })
          : filterEntity
            ? computeRolling12m(saved.history, { entityName: filterEntity })
            : saved.rolling12m
        return send(200, { ok: true, ...saved, rolling12m })
      }

      if ((subPath === '/history' || subPath.startsWith('/history/')) && method === 'DELETE') {
        const rawId = subPath.startsWith('/history/')
          ? subPath.slice('/history/'.length)
          : (url.searchParams.get('id') ?? '')
        let id = rawId
        try { id = decodeURIComponent(rawId) } catch { /* keep rawId */ }
        const entityKey = (url.searchParams.get('entityKey') ?? '').trim()
        const entityName = (url.searchParams.get('entity') ?? '').trim()
        const resDel = deleteSnapshot(id)
        const rolling12m = entityKey
          ? computeRolling12m(resDel.history, { entityKey })
          : entityName
            ? computeRolling12m(resDel.history, { entityName })
            : resDel.rolling12m
        return send(200, { ok: true, ...resDel, rolling12m })
      }

      return send(404, { code: 'UNKNOWN_ROUTE', error: '接口不存在。' })
    } catch (err) {
      if (err instanceof PublicRequestError) return send(err.statusCode, { code: err.code, error: err.message })
      if (err instanceof HistoryInputError) return send(400, { code: err.code, error: err.message })
      if (err?.code === 'INVALID_FX_MAP') return send(400, { code: err.code, error: '汇率须为有效的币种映射对象。' })
      if (err instanceof LocalStoreError) return send(err.code === 'LOCAL_DATA_BUSY' ? 409 : 500, { code: err.code, error: err.message })
      if (err instanceof ImaServiceError) {
        return send(err.code === 'INVALID_SETTINGS' ? 400 : 502, { code: err.code, error: err.message })
      }
      return send(500, { code: 'INTERNAL_ERROR', error: '处理请求失败，请稍后重试。' })
    }
  }
}

export function apply(ctx) {
  console.log(`[fintax] 财税工作台 v${PKG_VERSION} 加载中…`)

  // ── 工具 1：列出我的 IMA 知识库 ─────────────────────────────
  ctx.tools.register({
    name: 'ima_list_kbs',
    description:
      '列出当前用户配置的 IMA 知识库（id、名称、条数、是否已设为默认优先库）。若用户已在「设置 → 财税工作台」绑定默认知识库，可直接调用 ima_search / ima_browse 而无需每次先调本工具。',
    parameters: {
      query: { type: 'string', description: '按名称过滤知识库；留空返回全部。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        if (!loadCredentials()) return CREDENTIALS_HELP
        const pref = loadFintaxSettings()
        const data = await imaCall('openapi/wiki/v1/search_knowledge_base', {
          query: args?.query ?? '',
          cursor: '',
          limit: 30,
        })
        const list = data.info_list ?? data.knowledge_base_list ?? data.list ?? []
        if (!Array.isArray(list) || list.length === 0) {
          return '未找到知识库。'
        }
        const lines = list.map((kb) => {
          const id = kb.kb_id ?? kb.id
          const kbName = kb.kb_name ?? kb.name
          const isDefault = pref.defaultKbId && id === pref.defaultKbId
          const extra = [kb.content_count ? `${kb.content_count} 条内容` : '', kb.base_type ?? ''].filter(Boolean).join('，')
          return `${isDefault ? '★ [默认优先库] ' : '- '}id: ${id} | 名称: ${kbName}${extra ? ` | ${extra}` : ''}${kb.description ? ` | 描述: ${kb.description}` : ''}`
        })
        const defaultBanner = pref.defaultKbId
          ? `当前已绑定默认优先财税知识库：${pref.defaultKbName || pref.defaultKbId} (${pref.defaultKbId})；后续调用 ima_search / ima_browse 可省略 knowledge_base_id。\n`
          : ''
        return `${defaultBanner}找到 ${list.length} 个知识库：\n${lines.join('\n')}${data.is_end === false ? `\n（还有更多，next_cursor: ${data.next_cursor}）` : ''}`
      })
    },
  })

  // ── 工具 2：在指定（或默认）知识库内搜索 ────────────────────
  ctx.tools.register({
    name: 'ima_search',
    description:
      '在 IMA 知识库内搜索政策原文与底稿条目，返回 media_id、标题和命中摘要。首屏长问题少于 2 条时自动尝试最多 3 组财税短词。绑定默认知识库后可省略 knowledge_base_id。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '可传用户原始问题，也可传明确的关键词，例如“退运”或“9810”。',
      },
      knowledge_base_id: {
        type: 'string',
        description: '知识库 ID；若已在「设置 → 财税工作台」绑定默认知识库可留空，否则先用 ima_list_kbs 获取。',
      },
      cursor: { type: 'string', description: '分页游标，首次留空。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const kbId = String(args?.knowledge_base_id ?? '').trim() || String(loadFintaxSettings().defaultKbId ?? '').trim()
        if (!kbId) {
          throw new PublicRequestError(400, 'IMA_KB_REQUIRED', '请指定知识库 ID，或在财税工作台绑定默认库。')
        }
        if (!args?.query || !String(args.query).trim()) {
          throw new PublicRequestError(400, 'IMA_QUERY_REQUIRED', '请填写搜索关键词，或用 ima_browse 浏览目录。')
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const data = await searchImaKnowledge({
          query: String(args.query).trim(),
          knowledge_base_id: kbId,
          cursor: args.cursor ?? '',
        })
        const list = data.info_list ?? []
        const fallback = data.fallback?.queries.length
          ? `短词补查：${data.fallback.queries.join('、')}${data.fallback.failed ? `（${data.fallback.failed} 组查询失败）` : ''}。`
          : ''
        if (!Array.isArray(list) || list.length === 0) {
          return [`知识库 ${kbId} 中未搜到「${args.query}」。`, fallback, '可换更短的同义词重试，或用 ima_browse 浏览目录。'].filter(Boolean).join('\n')
        }
        const items = list.map((it) => {
          const isFolder = it.media_type === 99 || String(it.media_id ?? '').startsWith('folder_')
          return {
            media_id: it.media_id,
            title: it.title,
            media_type: it.media_type,
            kind: isFolder ? 'folder（请将 media_id 作为 folder_id 传给 ima_browse 展开目录，勿调 ima_read）' : 'item（可用 ima_read 读取）',
            highlight: it.highlight_content ?? '',
          }
        })
        return [
          `[库 ${kbId}] 命中 ${items.length} 条（query: ${args.query}）：`,
          ...(fallback ? [fallback] : []),
          JSON.stringify(items, null, 2),
          data.is_end === false && data.next_cursor ? `原查询还有更多结果，next_cursor: ${data.next_cursor}` : '原查询已到末尾。',
          '若命中文件夹（kind 为 folder），请将 media_id 作为 folder_id 传给 ima_browse 展开；引用文档前请用 ima_read 读取原文并核对文号。',
        ].join('\n')
      })
    },
  })

  // ── 工具 3：浏览知识库内容目录 ─────────────────────────────
  ctx.tools.register({
    name: 'ima_browse',
    description:
      '浏览 IMA 知识库的内容目录（标题 + media_id，支持传入 folder_id 展开子文件夹）。若用户已绑定默认知识库，knowledge_base_id 可省略。',
    parameters: {
      knowledge_base_id: {
        type: 'string',
        description: '知识库 ID；若已在「设置 → 财税工作台」绑定默认知识库可留空，否则先用 ima_list_kbs 获取。',
      },
      cursor: { type: 'string', description: '分页游标，首次留空。' },
      folder_id: { type: 'string', description: '可选，浏览指定文件夹（传入 folder_ 开头的 media_id）；留空浏览根目录。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const kbId = String(args?.knowledge_base_id ?? '').trim() || String(loadFintaxSettings().defaultKbId ?? '').trim()
        if (!kbId) {
          throw new PublicRequestError(400, 'IMA_KB_REQUIRED', '请指定知识库 ID，或在财税工作台绑定默认库。')
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const body = { knowledge_base_id: kbId, cursor: args?.cursor ?? '', limit: 50 }
        if (args?.folder_id) body.folder_id = String(args.folder_id).trim()
        const data = await imaCall('openapi/wiki/v1/get_knowledge_list', body)
        const list = data.knowledge_list ?? data.info_list ?? []
        if (!Array.isArray(list) || list.length === 0) return `知识库 ${kbId} 该目录下暂无内容。`
        const lines = list.map((it) => {
          const isFolder = it.media_type === 99 || String(it.media_id ?? '').startsWith('folder_')
          const tag = isFolder
            ? '📁 文件夹（请将 media_id 作为 folder_id 传给 ima_browse 展开）'
            : `📄 文档${it.media_type != null ? ` (media_type=${it.media_type})` : ''}（传 media_id 给 ima_read 读取）`
          return `- ${it.title} | media_id: ${it.media_id} | ${tag}`
        })
        return [
          `[库 ${kbId}] 共列出 ${lines.length} 条：`,
          ...lines,
          data.is_end === false ? `（还有更多，next_cursor: ${data.next_cursor}）` : '（已到末尾）',
        ].join('\n')
      })
    },
  })

  // ── 工具 4：读取知识条目原文（支持 offset 分段续读） ─────────
  const IMA_READ_CHUNK_CHARS = 8000
  const formatImaReadChunk = (mediaId, kindLabel, text, offset) => {
    const total = text.length
    if (offset >= total && total > 0) {
      return [
        `media_id: ${mediaId}（${kindLabel}）：offset=${offset} 已超出原文长度（共 ${total} 字）。`,
        `分页状态：hasMore: false | nextOffset: null | totalChars: ${total}`,
      ].join('\n')
    }
    let endIdx = Math.min(total, offset + IMA_READ_CHUNK_CHARS)
    if (endIdx < total && endIdx > offset) {
      const lastCode = text.charCodeAt(endIdx - 1)
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) endIdx--
    }
    const slice = toWellFormedUtf16(text.slice(offset, endIdx))
    const nextOffset = endIdx
    const hasMore = nextOffset < total
    return [
      `media_id: ${mediaId}（${kindLabel}${offset > 0 ? `，自第 ${offset} 字续读` : ''}）：`,
      slice,
      hasMore
        ? `\n…（原文共 ${total} 字，已展示 ${offset}–${nextOffset} 字；hasMore: true, nextOffset: ${nextOffset}，传 offset=${nextOffset} 可继续分段读取）`
        : offset > 0
          ? `\n（已读至全文末尾，共 ${total} 字；hasMore: false, nextOffset: null）`
          : '',
      '引用时请注明资料标题与出处，只引用原文中真实出现的政策文号。',
    ].filter(Boolean).join('\n')
  }

  ctx.tools.register({
    name: 'ima_read',
    description:
      '按 media_id 读取 IMA 的 Markdown、纯文本或笔记；超 8000 字长文支持传 offset 分段续读（返回 hasMore / nextOffset）。folder_ 开头的文件夹请用 ima_browse 展开。',
    parameters: {
      media_id: { type: 'string', required: true, description: '知识条目 media_id（来自 ima_browse 或 ima_search 结果中的非文件夹条目）。' },
      offset: { type: 'number', description: '可选，分段续读起始字符偏移（默认 0，单次返回最多 8000 字；上一次返回 hasMore: true 时传入 nextOffset）。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const mediaId = String(args?.media_id ?? '').trim()
        if (!mediaId) {
          throw new PublicRequestError(400, 'IMA_MEDIA_REQUIRED', '请从 ima_browse 或 ima_search 结果中获取 media_id。')
        }
        let offset = 0
        if (args?.offset !== undefined && args?.offset !== null && args?.offset !== '') {
          const parsedOffset = Number(args.offset)
          if (!Number.isInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 2_000_000) {
            throw new PublicRequestError(400, 'IMA_OFFSET_INVALID', 'offset 必须为 0 至 2000000 的整数。')
          }
          offset = parsedOffset
        }
        if (mediaId.startsWith('folder_')) {
          return `media_id "${mediaId}" 是文件夹，不能用 ima_read 读取。请调用 ima_browse 并传入 folder_id="${mediaId}" 展开查看该文件夹内的文档。`
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const data = await imaCall('openapi/wiki/v1/get_media_info', { media_id: mediaId })
        if (data.media_type === 99) {
          return `media_id "${mediaId}" 是文件夹（media_type=99），请调用 ima_browse 并传入 folder_id="${mediaId}" 展开查看内部文档。`
        }

        if (data.media_type === 11 && data.notebook_ext_info?.notebook_id) {
          try {
            const noteData = await imaCall('openapi/note/v1/get_doc_content', {
              note_id: data.notebook_ext_info.notebook_id,
              target_content_format: 0,
            })
            if (noteData?.content) {
              return formatImaReadChunk(mediaId, 'IMA 笔记原文', String(noteData.content), offset)
            }
          } catch {
            // Preserve the limited metadata projection below when a note cannot be read.
          }
        }

        if ((data.media_type === 7 || data.media_type === 13) && data.url_info?.url) {
          try {
            const text = await readImaTextDownload(data.url_info.url)
            return formatImaReadChunk(mediaId, 'Markdown/文本原文', text, offset)
          } catch {
            // Download failures must never expose server-provided URLs or headers.
          }
        }

        const mediaInfo = {
          title: typeof data.title === 'string' ? sliceUtf16Safe(data.title, 250) : '',
          media_type: Number.isSafeInteger(data.media_type) ? data.media_type : null,
        }
        if ([1, 3, 4, 5].includes(data.media_type)) {
          return [
            `media_id: ${mediaId} 的文件信息（二进制文档）：`,
            JSON.stringify(mediaInfo, null, 2),
            '注意：该条目为 PDF/Word/PPT/Excel 二进制文件，请勿直接用网页抓取工具读取 URL（会产生二进制乱码撑爆上下文）；请优先读取同目录下的 Markdown (.md) 指南文档，或将该文件说明告知用户。',
          ].join('\n')
        }

        return [
          `media_id: ${mediaId} 的条目信息：`,
          JSON.stringify(mediaInfo, null, 2),
          '请在 IMA 内打开条目核对原文（图片/官方网页条目请直接在 IMA 客户端查阅原图或原文链接）。',
        ].join('\n')
      })
    },
  })

  // ── 工具 5：14 场景确定性税额与差额对账引擎 ──────────────────
  ctx.tools.register({
    name: 'fintax_calc',
    description:
      '确定性财税试算与对账引擎（免配 IMA 亦可离线运行，严禁 LLM 心算替代），支持 14 大场景：' +
      'platform_tax_reconcile 对照平台报送、财务会计、增值税与出口、企业所得税四个口径，并独立核对资金放款；' +
      'eu_low_value_parcel 欧盟 ≤€150 低值包裹 €3×HS项数临时关税 + €2×HS项数退货不退处理费（IOSS 不代收）、PID 含税抽佣反推最低含税售价及欧盟仓对比；' +
      'us_t86_vs_9810_ddp 美线 T86 暂停后 Type 11 直邮 vs 9810 海外仓 DDP 单件毛利（含 2027-01-15 FBA +$0.19 敏感度）、IEEPA/CAPE 退税 fail-closed 严检与 ACE ACH Hold 及 2027-01-05 FIOR+CTPAT-validated 红线；' +
      'fba_mixed_procurement_split FBA 有票专票+无票采购混合出货拆单三方案净收益对比与操作边界；' +
      'export_invoice_breakeven 供应商开票加点「拿专票退税 vs 合规无票免税」毛利临界点与所得税联动测算；' +
      'export_rebate 外贸企业出口免退税（孰低规则+征退税率差转成本）；' +
      'export_rebate_manufacturer 生产企业出口“免、抵、退”税五步法测算（含免抵税额计征附加税预警）；' +
      'export_rebate_cancel_impact 出口退税取消/下调（2026年第2号/第29号/第11号第七条视同内销征税）与电池消费税（2026年第20号 CMA 报告门禁/成品充电宝豁免）双税毛利冲击及保毛利涨价测算；' +
      'cbec_assessed_cit 综试区零售出口4%核定应税所得率、小型微利条件及300万超崖跳变对照试算；' +
      'cbec_return_duty_exempt 2026年第16号公告跨境电商出口退运专项资格与条件测算（2026–2027申报，1210按出区离境起算）；' +
      'vat_taxpayer_threshold 500万一般纳税人强制认定临界与进项专票抵扣拐点测算；' +
      'annual_bonus_iit 年终奖个税（单独计税 vs 并入综合所得双轨最优比选 + 6档多发一元临界陷阱检测）；' +
      'cross_border_import 跨境电商零售进口综合税（限额内70%口径+超限预警）；' +
      'vat 增值税价税分离。',
    parameters: {
      scenario: {
        type: 'string',
        required: true,
        description:
          'platform_tax_reconcile | eu_low_value_parcel | us_t86_vs_9810_ddp | fba_mixed_procurement_split | export_invoice_breakeven | export_rebate | export_rebate_manufacturer | export_rebate_cancel_impact | cbec_assessed_cit | cbec_return_duty_exempt | vat_taxpayer_threshold | annual_bonus_iit | cross_border_import | vat',
      },
      params: {
        type: 'object',
        required: true,
        description:
          'platform_tax_reconcile: {reportedGrossRevenue, reportedGrossSource="platform"|"statement_reference", refunds=0, accountingRevenue?, declaredVatSales?, citTaxableIncome?, marketplaceWithheldTax=0, withheldTaxIncludedInGross=true, cutoffAndFxDiff=0, platformFees=0, subsidies=0, subsidiesIncludedInGross=false, selfRemitTaxNet=0, reserveChange=0, actualPayout?, principalRole="principal"}；' +
          'eu_low_value_parcel: {sellingPriceEur, vatRate=0.19, hsLineCount=1, purchaseCostEur=0, directShippingEur=0, otherVariableCostEur=0, commissionRate=0.15, commissionOnVatInclusive=true, returnRate=0, returnGoodsRecoveryRate=0, targetMarginRate?, marginBasis="vat_inclusive"|"ex_vat", monthlyOrders?, euWarehouseFirstLegEur?, euWarehouseDutyRate=0.04, euWarehouseLocalDeliveryEur?, euWarehouseStorageEur=0}；' +
          'us_t86_vs_9810_ddp: {sellingPriceUsd, purchaseCostUsd, declaredValueUsd?, tariffRate=0.35, type11ShippingUsd=0, type11ClearanceFeeUsd=0, ddpFirstLegUsd=0, ddpClearanceAmortizedUsd=0, localDeliveryUsd=0, monthlyStorageUsd=0, apply2027FbaHike=false, commissionRate=0.15, otherVariableCostUsd=0, monthlyVolume=1000, ieepaPaidUsd?, entryPeriodStart?, entryPeriodEnd?, tariffProgram?="IEEPA"|"Section301"|"Section232"|"Section122", aceAchBound?}；' +
          'fba_mixed_procurement_split: {totalExportCny, invoicedPurchaseGrossCny, noInvoicePurchaseCny, invoicedPurchaseInclusive=true, invoicedVatRate=0.13, invoicedRebateRate=0.13, supplierInvoiceMarkupRate=0.08, mixedSingleDeclarationCostCny=1500, split0110CostCny=1500, splitNoInvoiceMode="9810"|"9610"|"1039"|"agent_export", splitNoInvoiceCostCny=2500, surtaxRate=0.12}；' +
          'export_invoice_breakeven: {barePurchaseAmount, supplierMarkupRate, vatRate=0.13, rebateRate=vatRate, exportRevenue?, otherDeductibleExpenses=0, invoicedCitRate=0.05, noInvoiceRevenueCitRate=0.002}；' +
          'export_rebate: {purchaseAmount, vatRate=0.13, rebateRate=vatRate}；' +
          'export_rebate_manufacturer: {exportFobCny, totalInputVat, vatRate=0.13, rebateRate=vatRate, dutyFreeMaterialsCny=0, domesticOutputVat=0, priorCreditCarryover=0}；' +
          'export_rebate_cancel_impact: {purchaseGrossCny, exportFobCny, vatRate=0.13, oldRebateRate=0.06, newRebateRate=0, cancelAppliesDeemedDomesticVat=true, isConsumptionTaxItem=false, isFinishedPowerBank=false, consumptionTaxRate=0.02, hasValidCmaReport?, exportConsumptionTaxExempt=true, otherCostsCny=0}；' +
          'cbec_assessed_cit: {revenue, assessedQualificationConfirmed?, taxableIncomeRate=0.04, citRate=0.25, taxYear?, annualTaxableIncome?, annualAverageEmployees?, annualAverageAssets?, nonRestrictedIndustry?, smallLowProfit?}；' +
          'cbec_return_duty_exempt: {customsCode, exportValueCny, exportDate, returnDate, departureDate?, zoneExitDate?, returnedOutsideZone?, returnReason="unsold"|"customer_return"|"other", tariffRate=0.10, importVatRate=0.13, consumptionTaxRate=0, inOriginalCondition, isFood, refundedExportTax, exportRefundRepaid?, hasTaxCertificate}；' +
          'vat_taxpayer_threshold: {rolling12mTaxableSales, projectedAnnualGrossSales?, deductibleCostRatio=0.65, inputVatRate=0.13, generalOutputRate=0.13, smallScaleRate=0.01, hasExportRebateDemand=true, taxPeriod?="month"|"quarter", periodTaxableSales?, periodWaivedSales=0}；' +
          'annual_bonus_iit: {bonus, annualComprehensiveTaxableIncome?, annualSalary?, basicDeduction=60000, socialInsurance=0, specialAdditionalDeduction=0, otherDeductions=0}；' +
          'cross_border_import: {price, vatRate=0.13, consumptionTaxRate=0, discount=0.7, singleLimit=5000, annualLimit=26000, annualUsed=0}；' +
          'vat: {amount, rate=0.13, inclusive=true}。比例/税率均传 0~1 小数。',
      },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const rawParams = args?.params && typeof args.params === 'object' ? args.params : (args ?? {})
        const r = calculate(args?.scenario, rawParams)
        const lines = [`【${r.scenario}】`, ...r.steps.map((s) => `· ${s}`)]

        if (r.summaryLine) {
          lines.push(`核心结论：${r.summaryLine}`)
        } else {
          const amount = r.taxPayable ?? r.taxAmount ?? r.taxRefund
          const effRate = r.effectiveRate ?? r.effectiveRateOnRevenue
          const overLimitNote = r.withinLimit === false ? '（注意：本单已超限，不适用限额内优惠口径，此数字仅作限额内算术对照）' : ''
          lines.push(
            `结果：${r.taxRefund != null ? '应退税额' : '应纳税额'} ${amount} 元${effRate ? `（实际税负率 ${effRate}）` : ''}${r.afterTax != null ? `，税后 ${r.afterTax} 元` : ''}${overLimitNote}`,
          )
        }

        if (r.withinLimit === false) lines.push('⚠ 超限：见下方警告。')
        if (r.warnings?.length) lines.push(...r.warnings.map((w) => `⚠ ${w}`))
        if (r.policyRefs?.length) {
          lines.push('政策依据（引用前请核对现行有效性）：')
          lines.push(...r.policyRefs.map((p) => `· ${p.ref}：${p.note}`))
        }
        lines.push('声明：本结果基于传入参数与默认政策口径的确定性算术试算，政策参数须经权威来源核对；正式申报以主管税务机关口径为准。')
        return lines.join('\n')
      })
    },
  })

  // ── 工具 6：跨境平台、结汇通道与国内对公银行回单本地初筛体检与三段资金链核销 (v0.9 升级 17 通道 + Stage 3) ──
  ctx.tools.register({
    name: 'fintax_parse_statement',
    description:
      '本地离线解析跨境电商 11 大销售平台（Amazon[含 FR/IT/ES 及 SE/PL/BE/TR/AE/SA/BR/IN/IE 站点与 2027 新费用]、TikTok Shop、Temu、速卖通 AliExpress、Shopee、Shopify、PayPal、Stripe、SHEIN、Walmart、Lazada）、6 大第三方结汇通道（万里汇 WorldFirst、派安盈 Payoneer、空中云汇 Airwallex、连连国际 LianLian、PingPong、寻汇 SUNRATE）及国内对公银行回单（招行/中行/工行/建行/农行/交行，支持 .csv/.tsv/.txt/.xlsx/.xlsm/.zip 及 UTF-16，也可试用 demo:v9 / demo:v8 / demo:all / demo:v7 / demo:wallets / demo:full）。自动执行「① 平台放款 → ② 结汇入账 → ③ 国内对公银行回单 5 键核销」三段资金交叉核对（绝不重复计税）、多币种初筛与 P0/P1/P2 异常雷达，支持导出 HTML/Markdown 诊断书或异常派活 CSV。',
    parameters: {
      file_path: {
        type: 'string',
        description: '本机账单文件路径（支持 .csv / .tsv / .txt / .xlsx / .xlsm / .zip，或传 demo:v9 / demo:v8 / demo:all / demo:v7 / demo:wallets / demo:full 免文件体验）。与 file_paths 二选一即可。',
      },
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：多份月度/多站点、第三方结汇流水及国内对公银行回单路径数组（同时传入销售账单、结汇流水与银行回单将自动激活完整三段资金链 5 键核销）。',
      },
      platform: {
        type: 'string',
        description: 'auto（默认自动识别表头）| amazon | tiktok | temu | aliexpress | shopee | shopify | paypal | stripe | shein | walmart | lazada | worldfirst | payoneer | airwallex | lianlian | pingpong | sunrate | bank_receipt',
      },
      fx_rate_to_cny: {
        type: 'number',
        description: '可选：单币种折合人民币汇率（如 USD 传 7.18）。多币种账单请改用 fx_rates。',
      },
      fx_rates: {
        type: 'object',
        description: '可选：多币种汇率映射（如 {"USD": 7.18, "EUR": 7.82, "MYR": 1.62, "SGD": 5.36}），用于多站点/多币种合并折算总对账。',
      },
      declared_vat_sales_cny: {
        type: 'number',
        description: '可选：企业当期或全年累计实际已申报增值税/出口销售额（人民币，元）；自动执行合并申报缺口与“回款净额报税”诊断。',
      },
      export_report_path: {
        type: 'string',
        description: '可选：导出本地报告路径（传 "auto" 自动生成可打印 .html 汇报单，"auto.md" 生成 Markdown，"auto.csv" 生成全量异常排雷 CSV，或指定具体路径）。',
      },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const inputPaths = []
        if (args?.file_path && String(args.file_path).trim()) inputPaths.push(String(args.file_path).trim())
        if (Array.isArray(args?.file_paths)) {
          for (const p of args.file_paths) {
            if (p && String(p).trim()) inputPaths.push(String(p).trim())
          }
        }
        if (!inputPaths.length) throw new PublicRequestError(400, 'FILES_REQUIRED', '请提供账单文件路径。')
        const parsed = await parseInWorker({ inputPaths, platform: args?.platform || 'auto' })
        if (parsed.error) {
          const detail = parsed.diagnostics?.length ? '\n' + JSON.stringify(parsed.diagnostics) : ''
          throw new PublicRequestError(400, parsed.code, parsed.error + detail)
        }
        const summaries = parsed.localSummaries
        const consolidated = buildConsolidatedReconcile(summaries, {
          fxRateToCny: args?.fx_rate_to_cny,
          fxRates: args?.fx_rates,
          declaredVatSalesCny: args?.declared_vat_sales_cny,
        })

        const blocks = []
        const yuan = (n) => n == null ? '待核' : `¥${n.toFixed(2)}`
        const amountOrPending = (n) => typeof n === 'bigint' ? fmtAmount(n) : '待核'
        for (const [index, s] of summaries.entries()) {
          const publicSummary = serializeSummary({ ...s, fileName: '' })
          const ccy = publicSummary.currency
          const p0 = publicSummary.anomalies.filter((a) => a.severity.startsWith('P0'))
          const p1 = publicSummary.anomalies.filter((a) => a.severity.startsWith('P1'))
          const p2 = publicSummary.anomalies.filter((a) => a.severity.startsWith('P2'))

          const lines = s.role === 'bank_receipt'
            ? [
                `【国内对公银行入账回单摘要｜${s.bankLabel || s.platform} · ${ccy}】`,
                `· 回单 ${index + 1} · ${publicSummary.formatLabel}`,
                `· 识别期间：${publicSummary.period} | 贷方入账 ${s.creditRowCount || 0} 笔 / 借方 ${s.debitRowCount || 0} 笔（口径声明：银行回单仅参与 Stage 3 实收核销，不重复计入销售收入）`,
                `· 贷方入账合计（CNY）：${fmtAmount(s.totalCreditCny || 0n)} ｜ 银行扣收手续费（CNY）：${fmtAmount(s.totalBankFeeCny || 0n)}`,
              ]
            : s.role === 'settlement_wallet' && s.walletMetrics
            ? [
                `【第三方结汇通道资金排雷报告｜${s.platform} · ${ccy}】`,
                `· 账单 ${index + 1} · ${publicSummary.formatLabel}`,
                `· 识别期间：${publicSummary.period} | 有效明细行数：${s.rawRowCount} 行（口径声明：结汇通道不重复计入销售报送总额）`,
                `── 一、结汇通道资金流向拆解（单位：${ccy}，精确到 0.01）──`,
                `· ① 电商平台/收单网关回款入账：${fmtAmount(s.walletMetrics.platformInbound)}`,
                `· ② 非标准平台/其他入账（请核实来源防漏报）：${fmtAmount(s.walletMetrics.otherInbound)}`,
                `· ③ 结汇提现至企业账户（待核银行回单）：${fmtAmount(s.walletMetrics.fxWithdrawToCorporate)}`,
                `· ④ 提现至个人私户/法人私卡（P0 优先核查）：${fmtAmount(s.walletMetrics.fxWithdrawToPersonal)}`,
                `· ⑤ 收款户性质待核提现（未计入企业户转出占比，P1）：${fmtAmount(s.walletMetrics.unverifiedWithdraw || 0n)}`,
                `· ⑥ 钱包余额境外坐支（供应商/物流/广告/卡消费，P1 高危）：${fmtAmount(s.walletMetrics.directSpend)}`,
                `· ⑦ 提现/汇兑/账户手续费：${fmtAmount(s.walletMetrics.walletFees)}`,
                `· ⑧ 已自动剥离同户换汇/多币种互转：${fmtAmount(s.walletMetrics.internalFxStripped)}（${s.walletMetrics.internalFxCount} 笔，本币净变动 ${fmtAmount(s.walletMetrics.internalFxNet || 0n)}）`,
                `· ⑨ 期间净流：${publicSummary.walletMetrics.signedNetFlow ?? '待核'} ｜ 期初余额：${amountOrPending(s.walletMetrics.openingBalance)} ｜ 期末余额：${amountOrPending(s.walletMetrics.closingBalance)} ｜ 银行实收：待补回单`,
              ]
            : [
                `【跨境原始账单初筛体检报告｜${s.platform} · ${ccy}】`,
                `· 账单 ${index + 1} · ${publicSummary.formatLabel}`,
                `· 识别期间：${publicSummary.period} | 有效明细行数：${s.rawRowCount} 行`,
                `── 一、原币报送参考与结算项目（单位：${ccy}，精确到 0.01）──`,
                `· ① 商品含运费原价总额：${fmtAmount(s.grossSales)}`,
                `· ② 减：商家承担促销折扣：${fmtAmount(s.sellerDiscount)}`,
                `· ★ 账单推算报送参考毛额（①−②）：${fmtAmount(s.taxReportingGrossRef)}；正式报送总额请核对实际报送单及补贴归属。`,
                `· ③ 加：平台出资补贴 / 库存赔付：${fmtAmount(s.platformSubsidy)}`,
                `· ④ 减：客户退款本金：${fmtAmount(s.customerRefund)}`,
                `· ⑤~⑨ 平台与履约费用合计（主要责任人须单独列支成本费用，严禁直接冲减收入）：${fmtAmount(s.totalFees)}`,
                `    ├─ 平台佣金及交易手续费：${fmtAmount(s.platformCommission)}`,
                `    ├─ 联盟达人佣金（Affiliate/TAP）：${fmtAmount(s.affiliateCommission)}`,
                `    ├─ FBA / 仓储及尾程物流费：${fmtAmount(s.logisticsWarehousing)}`,
                `    ├─ 站内广告 / 网关直付广告费：${fmtAmount(s.inPlatformAds)}`,
                `    └─ 支付网关 / 拒付争议及履约罚款：${fmtAmount(s.gatewayDisputeFee)}`,
                `· 已自动剥离（商城代扣代缴流转税，不计入收入）：${fmtAmount(s.facilitatorTaxStripped)}`,
                `· ⑩ 非代扣待卖家自申报流转税净流入（应计其他应付款，勿混入收入）：${fmtAmount(s.selfRemitTaxNet)}`,
                `· ⑪ 冻结准备金/保证金净变动（+新增冻结 / -释放前期）：${fmtAmount(s.reserveNetChange)}`,
                `── 二、资金桥接与账单内部勾稽 ──`,
                `· 行内水平守恒校验：差额 ${fmtAmount(s.horizontalDiffTotal)} ${ccy}（${s.horizontalDiffTotal === 0n ? '✔ 全部明细行水平守恒通过' : '❌ 存在行内不守恒阻断项，见下方异常雷达'}）`,
                publicSummary.payoutEvidenceCount > 0
                  ? `· 理论应放款净额：${fmtAmount(s.theoreticalPayout)} ${ccy} | 账单内提取实际打款（Payout）：${fmtAmount(s.actualPayout)} ${ccy} | 放款差额（实际 − 理论，正为多放、负为少放）：${fmtAmount(s.statementPayoutDiff)} ${ccy}`
                  : `· 理论应放款净额：${fmtAmount(s.theoreticalPayout)} ${ccy} ｜ 实际放款及差额待补凭证。`,
              ]

          if (publicSummary.payoutEvidenceCount > 0 && s.statementPayoutDiff !== 0n && s.horizontalDiffTotal === 0n) {
            lines.push(
              `  （注：行内水平守恒已通过；放款差额 ${fmtAmount(s.statementPayoutDiff)} ${ccy} 通常源于自然月截取导致的期初/期末待打款留存余额变动或独立结算周期跨月打款。）`,
            )
          }
          if (s.uncapturedVoidExcluded > 0n) {
            lines.push(`· 已自动过滤未捕获预授权/未结清废单金额：${fmtAmount(s.uncapturedVoidExcluded)} ${ccy}`)
          }

          if (summaries.length === 1 && consolidated?.ready) {
            const rec = consolidated.reconcile
            lines.push(`── 三、人民币折算与申报比对诊断（按汇率 ${consolidated.breakdown[0].fx} 试算）──`)
            lines.push(...rec.steps.map((st) => `· ${st}`))
            if (rec.warnings.length) lines.push(...rec.warnings.map((w) => `⚠ ${w}`))
            if (consolidated.cliffAlert) lines.push(consolidated.cliffAlert)
            if (p0.length > 0) {
              lines.push(
                '⚠ 阻断级混表提示：上述折算毛收入仍包含尚未剥离的 P0 级异常记录（如全托管供货结算单），在按自营零售申报前请先剔除对应结算额！',
              )
            }
          }

          lines.push(`── 异常交易雷达扫描结果（P0阻断 ${p0.length} 项 | P1高危 ${p1.length} 项 | P2关注 ${p2.length} 项）──`)
          if (s.anomalies.length === 0) {
            lines.push('✔ 未检出异常交易记录。')
          } else {
            const ordered = [...p0, ...p1, ...p2]
            for (const a of ordered.slice(0, 18)) {
              lines.push(`· [${a.severity}] ${a.category}（本地定位 ${a.refId}，金额 ${a.amount} ${ccy}）：${a.detail}`)
            }
            if (ordered.length > 18) {
              lines.push(`· …其余 ${ordered.length - 18} 条同类异常已折叠汇总。`)
            }
          }

          lines.push(
            '── 合规与关账边界说明 ──',
            '· 如检出 P0/P1 异常（如全托管混表、网关余额坐支海外广告、非代扣待申报流转税、回款净额漏报），若已配置 IMA 知识库可调用 ima_search 检索对应实操 SOP 与政策原文。',
            '· 本工具提供原始账单离线初筛体检与异常排雷；企业正式关账仍须结合多店铺主体映射、央行基准汇率、第三方收款机构期初期末资金池、海关报关离境跨期台账及标准借贷会计分录完成完整底稿复核。',
          )
          blocks.push(lines.join('\n'))
        }

        if (summaries.length > 1 && consolidated) {
          if (consolidated.ready) {
            const hasSales = summaries.some((s) => s.role !== 'settlement_wallet' && s.role !== 'bank_receipt')
            const cLines = [
              `【多表/多币种合并人民币总对账 & 年终红线核验（共合并 ${summaries.length} 张结算单）】`,
              ...consolidated.breakdown.map((b, index) =>
                b.role === 'bank_receipt'
                  ? `· 银行回单 [文件 ${index + 1}]：${b.platform} 贷方入账 ¥${(b.bankCreditCny || 0).toFixed(2)} ｜ 银行手续费 ¥${(b.bankFeeCny || 0).toFixed(2)}（参与 Stage 3 核销，不重复计入销售报送额）`
                  : b.role === 'settlement_wallet'
                    ? `· 结汇通道 [账单 ${index + 1}]：平台入账折合 ¥${(b.walletInboundCny || 0).toFixed(2)} ｜ 转出企业户(待核回单)折合 ¥${(b.corporateWithdrawCny || 0).toFixed(2)}（汇率 ${b.fx}，不重复计入销售报送额）`
                    : `· 分表折算 [账单 ${index + 1}]：原币报送毛额 ${b.grossOrig} ${b.currency} × 汇率 ${b.fx} = ${b.grossCny.toFixed(2)} 元`,
              ),
              ...consolidated.reconcile.steps.map((st) => `· ${st}`),
              ...consolidated.reconcile.warnings.map((w) => `⚠ ${w}`),
              ...(hasSales
                ? [`· 4% 核定收入等值初筛：当前合并报送参考净额为 7,500 万元等值的 ${consolidated.cliffRatioPct}%。年度应纳税所得额须按主体另行核定。`]
                : []),
            ]
            if (consolidated.fundChain) {
              const fc = consolidated.fundChain
              const s1Txt = yuan(fc.stage1PlatformPayoutCny)
              const gapTxt = yuan(fc.stage1to2GapCny)
              const rateTxt = fc.corporateRepatriationRatePct !== null ? `${fc.corporateRepatriationRatePct}%` : '待核'
              const s3 = fc.stage3
              const hasS3 = Boolean(s3 && (fc.bankReceiptCount > 0 || s3.stats?.matchedCount > 0 || s3.stats?.candidateCount > 0))
              cLines.push(
                `── 三段资金链路交叉核对（平台放款 → 结汇通道 → ${hasS3 ? '国内对公银行回单核销' : '钱包转出至企业户[待核银行回单]'}）──`,
                `· ① 销售平台实际放款：${s1Txt} ｜ ② 结汇通道平台入账：¥${fc.stage2WalletInboundCny.toFixed(2)}${fc.stage2OtherInboundCny > 0 ? `（+其他入账 ¥${fc.stage2OtherInboundCny.toFixed(2)}）` : ''} ｜ 一/二段差额：${gapTxt}`,
                `· ③ 钱包转出至企业户(待核银行回单)：¥${fc.stage3CorporateRepatriatedCny.toFixed(2)}（企业户转出占比 ${rateTxt}）｜ 私户提现(P0)：¥${fc.stage3PersonalWithdrawCny.toFixed(2)} ｜ 待核提现(P1)：¥${(fc.stage3UnverifiedWithdrawCny || 0).toFixed(2)} ｜ 境外坐支(P1)：¥${fc.directSpendCny.toFixed(2)} ｜ 期末余额：${yuan(fc.closingBalanceCny)} ｜ 银行实收：${yuan(fc.bankReceivedCny)}`,
                ...(hasS3
                  ? [
                      `· Stage 3 银行实收离线核销（${s3.stage3Status}）：5 键已核销实收 ¥${s3.stage3MatchedCny.toFixed(2)}（${s3.stats?.matchedCount || 0} 笔）｜ 银行手续费 ¥${s3.bankFeeCny.toFixed(2)} ｜ 汇损差额 ¥${s3.fxSpreadCny.toFixed(2)} ｜ 汇损/在途未核销 ¥${s3.fxGapOrInTransitCny.toFixed(2)}`,
                      ...(s3.stage3CandidateMatches?.length
                        ? [
                            `· Stage 3 参考级候选回单（不计入法定 5 键核销，共 ${s3.stage3CandidateMatches.length} 组）：${s3.stage3CandidateMatches.map((m) => `${m.walletPlatform}→${m.bankLabel}(${m.period}) 预期 ${m.expectedAmount.toFixed(2)} vs 实收 ${m.receivedAmount.toFixed(2)}`).join('；')}`,
                          ]
                        : []),
                    ]
                  : []),
                ...(fc.candidateMatches?.length
                  ? [
                      `· 参考级候选配对（待补主体/账号/回单确认，不替代法定核销，共 ${fc.candidateMatches.length} 组）：${fc.candidateMatches.map((m) => `${m.platform}(${m.period}) ${m.currency} ${m.payoutAmount.toFixed(2)}→${m.inboundAmount.toFixed(2)}[差 ${m.diffAmount.toFixed(2)}]`).join('；')}`,
                    ]
                  : []),
                ...(fc.stage3StatusNote ? [`· 口径提示：${fc.stage3StatusNote}`] : []),
                ...fc.alerts.map((a) => `· ${a}`),
              )
            }
            if (consolidated.cliffAlert) cLines.push(consolidated.cliffAlert)
            if (consolidated.p0Count > 0) {
              cLines.push(
                '⚠ 阻断级混表提示：合并毛收入中含 P0 级异常记录（如全托管供货结算），按境外自营零售申报前请先剥离对应供货额！',
              )
            }
            blocks.push(cLines.join('\n'))
          } else {
            blocks.push(
              `【多币种合并折算提示】检测到多币种账单，尚缺币种 [${consolidated.missingCurrencies.join(', ')}] 的人民币汇率；请传入 fx_rates（如 {"USD": 7.18, "EUR": 7.82}）即可一键完成合并人民币总对账。`,
            )
          }
        }

        if (consolidated.coverageComplete === false) {
          const diagnostics = summaries.flatMap((summary) => summary.parseDiagnostics ?? [])
          blocks.push(`【部分账单待核】${JSON.stringify(diagnostics)}`)
        }
        if (summaries.length === 1 && !consolidated.ready) {
          blocks.push('【人民币折算待核】请核对币种及对应汇率。')
        }

        if (args?.export_report_path) {
          const savedPath = exportDiagnosticReport({
            summaries,
            consolidated,
            exportPath: args.export_report_path,
            firstInputPath: inputPaths[0],
            version: PKG_VERSION,
          })
          if (savedPath) {
            blocks.push('已在本机生成核对报告。')
          }
        }

        return blocks.join('\n\n========================================\n\n')
      })
    },
  })

  // ── 随包技能注册 ─────────────────────────────────────────────
  const skillsDir = join(PKG_DIR, 'skills')
  let entries = []
  try {
    entries = readdirSync(skillsDir)
  } catch {
    ctx.logger?.warn?.('[fintax] skills 目录缺失，跳过技能注册')
  }
  for (const entry of entries) {
    const dir = join(skillsDir, entry)
    const file = join(dir, 'SKILL.md')
    try {
      if (!statSync(dir).isDirectory()) continue
      const raw = readFileSync(file, 'utf8')
      const parsed = parseSkillMd(raw)
      if (!parsed) {
        ctx.logger?.warn?.(`[fintax] 无法解析 ${file}，跳过`)
        continue
      }
      ctx.skills.register({
        name: parsed.name,
        description: parsed.description,
        content: parsed.body,
        path: file,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: dir },
      })
    } catch (err) {
      ctx.logger?.warn?.(`[fintax] 注册技能 ${entry} 失败：${err.message}`)
    }
  }

  // ── 桌面端图形化设置接口（仅当宿主存在 webServer 时挂载，CLI 模式自动优雅跳过） ──
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      const apiHandler = createFintaxApiHandler({
        getConnection: () => scoped.get?.('connection') ?? ctx.get?.('connection'),
      })
      scoped.effect(
        () => scoped.webServer.register({ kind: 'prefix', path: '/api/fintax', handler: apiHandler }),
        'fintax: settings api routes',
      )
      ctx.logger?.info?.('[fintax] 设置页接口已挂载于 /api/fintax')
    })
  }

  console.log(`[fintax] 财税工作台 v${PKG_VERSION} 已加载：6 个工具（17 通道账单、结汇与国内银行回单离线体检雷达 + 14 大确定性算税场景 + 自然年 Q1–Q4 与 12 个月滚年归档）+ 4 个技能`)
}

/** 极简 frontmatter 解析：只取 name / description（单行值），其余交给正文。 */
function parseSkillMd(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim()
  }
  if (!meta.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name)) return null
  return { name: meta.name, description: meta.description ?? '', body: m[2].trim() }
}

// 合并原币账单，独立核对销售报送、申报与钱包资金。
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { platformStatementTaxReconcile } from './calc.js'
import { reconcileStage3 } from './bank_receipt.js'
import { AMOUNT_SCALE, absBig, fmtAmount, normalizeCurrencyCode, parseAmountCell, toNumber2 } from './statement_shared.js'

const { version: VERSION } = createRequire(import.meta.url)('../package.json')
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const ABSENT = ['待确认期间', '跨期（待核）']
const isMonth = (v) => typeof v === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(v)
const roundBig = (n, divisor) => n < 0n ? -roundBig(-n, divisor) : (n + divisor / 2n) / divisor
const fmtBalance = (v) => typeof v === 'bigint' ? fmtAmount(v) : '待核'
const fmtYuan = (v) => v == null ? '待核' : `¥${v.toFixed(2)}`
const decimalRate = /^(?:\+?\d+(?:\.\d*)?|\+?\.\d+)(?:e[+-]?\d+)?$/i

function recognizedCurrency(raw) {
  const code = normalizeCurrencyCode(raw)
  return code === 'UNKNOWN' ? null : code
}

function invalidFxMap() {
  return Object.assign(new TypeError('汇率表须为币种到正数汇率的对象'), { code: 'INVALID_FX_MAP' })
}

/** 汇率对象或 JSON 对象，保留尚未填写的币种。 */
export function normalizeFxMap(fxRatesRaw) {
  if (fxRatesRaw === undefined || (typeof fxRatesRaw === 'string' && !fxRatesRaw.trim())) return {}
  let obj = fxRatesRaw
  if (typeof fxRatesRaw === 'string') {
    try {
      obj = JSON.parse(fxRatesRaw)
    } catch {
      throw invalidFxMap()
    }
  }
  if (!obj || Object.getPrototypeOf(obj) !== Object.prototype) throw invalidFxMap()
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    const currency = recognizedCurrency(key)
    if (!currency) throw invalidFxMap()
    if (value === null || (typeof value === 'string' && !value.trim())) continue
    if (typeof value !== 'number' && !(typeof value === 'string' && decimalRate.test(value.trim()))) throw invalidFxMap()
    const rate = Number(value)
    if (!Number.isFinite(rate) || rate <= 0 || (out[currency] && out[currency] !== rate)) throw invalidFxMap()
    out[currency] = rate
  }
  return out
}

export function resolveCurrencyFx(currency, singleFx, fxMap, uniqueForeignCount) {
  const ccy = recognizedCurrency(currency)
  if (!ccy) return null
  if (ccy === 'CNY') return 1
  if (Object.hasOwn(fxMap || {}, ccy)) return fxMap[ccy]
  if (typeof singleFx !== 'number' && !(typeof singleFx === 'string' && decimalRate.test(singleFx.trim()))) return null
  const n = Number(singleFx)
  return Number.isFinite(n) && n > 0 && uniqueForeignCount === 1 ? n : null
}

// 把所有折算项放在同一十进制定点尺度下累积，最后才量化到分。
function exactConversions(rates) {
  const parts = new Map()
  let precision = 0
  for (const [ccy, rate] of rates) {
    const [mantissa, rawExponent = '0'] = String(rate).split('e')
    const [whole, fraction = ''] = mantissa.split('.')
    const exponent = Number(rawExponent) - fraction.length
    precision = Math.max(precision, -exponent)
    parts.set(ccy, [BigInt(whole + fraction), exponent])
  }
  const weights = new Map([...parts].map(([ccy, [mantissa, exponent]]) => [ccy, mantissa * 10n ** BigInt(precision + exponent)]))
  const baseWeight = 10n ** BigInt(precision)
  const denominator = AMOUNT_SCALE / 100n * baseWeight
  const money = (weighted) => {
    const cents = roundBig(weighted, denominator)
    const value = Number(cents / 100n) + Number(cents % 100n) / 100
    if (!Number.isFinite(value)) throw Object.assign(new RangeError('账单折算金额超出范围'), { code: 'AMOUNT_RANGE' })
    return value
  }
  return {
    weight: (ccy, amount) => weights.get(ccy) * amount,
    baseAmount: (amount) => {
      const parsed = parseAmountCell(amount)
      if (parsed.state !== 'value') throw Object.assign(new RangeError('申报金额超出支持范围'), { code: 'AMOUNT_RANGE' })
      return parsed.value * baseWeight
    },
    money,
  }
}

const walletFields = {
  walletInbound: 'platformInbound',
  otherInbound: 'otherInbound',
  returnedInbound: 'returnedInbound',
  corporateWithdraw: 'fxWithdrawToCorporate',
  grossCorporateWithdraw: 'grossCorporateWithdraw',
  matchedCorporateReturn: 'matchedCorporateReturn',
  unmatchedReturnAmount: 'unmatchedReturnAmount',
  personalWithdraw: 'fxWithdrawToPersonal',
  unverifiedWithdraw: 'unverifiedWithdraw',
  directSpend: 'directSpend',
  walletFees: 'walletFees',
  frozenOutflow: 'frozenOutflow',
  internalFxNet: 'internalFxNet',
  internalFxStripped: 'internalFxStripped',
  signedNetFlow: 'signedNetFlow',
}
const salesFields = {
  gross: 'taxReportingGrossRef', refund: 'customerRefund', fees: 'totalFees',
  subsidy: 'platformSubsidy', tax: 'selfRemitTaxNet', reserve: 'reserveNetChange', payout: 'actualPayout',
}

function evidenceKey(ev, currency) {
  const { period, entityKey, accountKey, referenceKey, sourcePlatform, amount } = ev
  if (!isMonth(period) || !entityKey || !accountKey || !referenceKey || !sourcePlatform) return null
  return JSON.stringify([period, entityKey, accountKey, currency, sourcePlatform, referenceKey, amount < 0n])
}

/** 每个可配对凭证必须具有同一主体、账号、账期、平台、币种与引用；另独立计算「参考级候选配对」（不替代法定 5 键核销）。 */
function matchFunds(c, coverageComplete) {
  const payouts = c.payoutEvidenceCount
  const inbounds = c.inboundEvidence.length
  const evidence = new Map()
  for (const [kind, entries] of [['payout', c.payoutEvidence], ['inbound', c.inboundEvidence]]) {
    for (const [idx, ev] of entries.entries()) {
      const key = evidenceKey(ev, c.currency)
      if (!key) continue
      if (!evidence.has(key)) evidence.set(key, { payout: [], inbound: [] })
      evidence.get(key)[kind].push({ idx, amount: ev.amount })
    }
  }
  let matchedCount = 0
  let matchedPayout = 0n
  let matchedInbound = 0n
  let mismatches = 0
  let gapDirection = 0n
  let opposingGaps = false
  const strictPayoutUsed = new Set()
  const strictInboundUsed = new Set()
  for (const { payout, inbound } of evidence.values()) {
    if (payout.length !== 1 || inbound.length !== 1) continue
    strictPayoutUsed.add(payout[0].idx)
    strictInboundUsed.add(inbound[0].idx)
    matchedCount++
    matchedPayout += payout[0].amount
    matchedInbound += inbound[0].amount
    const delta = inbound[0].amount - payout[0].amount
    if (delta !== 0n) {
      mismatches++
      const sign = delta > 0n ? 1n : -1n
      if (gapDirection !== 0n && gapDirection !== sign) opposingGaps = true
      gapDirection = sign
    }
  }

  // 双轨第二轨：仅对未被法定 5 键匹配的剩余放款/入账做「参考级候选配对」（同币种+同账期+同来源平台），严禁替代法定 matched。
  // 严守红线：保留主体/账号/参考号键，双方存在明确凭证冲突或巨额金额差（> 10%）时直接排除出参考候选，绝不伪称「缺主体/账号资料」。
  const hasCredentialConflict = (p, inb) => (
    (p.entityKey && inb.entityKey && p.entityKey !== inb.entityKey) ||
    (p.accountKey && inb.accountKey && p.accountKey !== inb.accountKey) ||
    (p.referenceKey && inb.referenceKey && p.referenceKey !== inb.referenceKey)
  )
  const describeMissingCreds = (p, inb) => {
    const missing = []
    if (!p.entityKey || !inb.entityKey) missing.push('主体编号')
    if (!p.accountKey || !inb.accountKey) missing.push('资金账户编号')
    if (!p.referenceKey || !inb.referenceKey) missing.push('放款凭证编号')
    return missing.length ? `缺${missing.join('/')}` : '缺完整五键对齐凭证'
  }
  const remPayouts = c.payoutEvidence
    .map((ev, idx) => ({
      idx,
      period: ev.period,
      platform: ev.sourcePlatform || null,
      amount: ev.amount,
      entityKey: ev.entityKey || null,
      accountKey: ev.accountKey || null,
      referenceKey: ev.referenceKey || null,
    }))
    .filter((item) => !strictPayoutUsed.has(item.idx) && isMonth(item.period) && item.platform && item.amount !== 0n)
  const remInbounds = c.inboundEvidence
    .map((ev, idx) => ({
      idx,
      period: ev.period,
      platform: ev.sourcePlatform || ev.inferredPlatform || null,
      amount: ev.amount,
      entityKey: ev.entityKey || null,
      accountKey: ev.accountKey || null,
      referenceKey: ev.referenceKey || null,
    }))
    .filter((item) => !strictInboundUsed.has(item.idx) && isMonth(item.period) && item.platform && item.amount !== 0n)

  const usedCandP = new Set()
  const usedCandI = new Set()
  const candidateMatches = []
  // Pass 1: 同账期 + 同平台 + 金额完全一致 + 无任何明确凭证冲突
  for (const p of remPayouts) {
    const hit = remInbounds.find(
      (inb) => !usedCandI.has(inb.idx) && inb.period === p.period && inb.platform === p.platform &&
        inb.amount === p.amount && !hasCredentialConflict(p, inb),
    )
    if (!hit) continue
    usedCandP.add(p.idx)
    usedCandI.add(hit.idx)
    candidateMatches.push({
      currency: c.currency,
      period: p.period,
      platform: p.platform,
      payoutAmount: p.amount,
      inboundAmount: hit.amount,
      diffAmount: 0n,
      status: 'candidate_pending_confirm',
      matchBasis: `同币种+同账期+同平台+金额一致（${describeMissingCreds(p, hit)}）`,
    })
  }
  // Pass 2: 同账期 + 同平台 + 同方向 1 对 1 近似候选（排除明确凭证冲突及巨额差额 > 10%）
  const groupKey = (x) => `${x.period}|${x.platform}|${x.amount < 0n ? '-' : '+'}`
  const pGroups = new Map()
  const iGroups = new Map()
  for (const p of remPayouts) {
    if (usedCandP.has(p.idx)) continue
    const k = groupKey(p)
    if (!pGroups.has(k)) pGroups.set(k, [])
    pGroups.get(k).push(p)
  }
  for (const inb of remInbounds) {
    if (usedCandI.has(inb.idx)) continue
    const k = groupKey(inb)
    if (!iGroups.has(k)) iGroups.set(k, [])
    iGroups.get(k).push(inb)
  }
  for (const [k, pList] of pGroups.entries()) {
    const iList = iGroups.get(k)
    if (pList.length === 1 && iList?.length === 1) {
      const p = pList[0]
      const hit = iList[0]
      if (hasCredentialConflict(p, hit)) continue
      const diffAmt = hit.amount - p.amount
      const absDiff = absBig(diffAmt)
      const absP = absBig(p.amount)
      const absI = absBig(hit.amount)
      const maxAbs = absP >= absI ? absP : absI
      // 巨额金额差（> 10%，如 100 vs 1 USD 差 99%）直接排除，不误导为参考候选
      if (maxAbs === 0n || absDiff * 100n > maxAbs * 10n) continue
      usedCandP.add(p.idx)
      usedCandI.add(hit.idx)
      candidateMatches.push({
        currency: c.currency,
        period: p.period,
        platform: p.platform,
        payoutAmount: p.amount,
        inboundAmount: hit.amount,
        diffAmount: diffAmt,
        status: 'candidate_pending_confirm',
        matchBasis: `同币种+同账期+同平台 1 对 1 候选（金额存在差额，${describeMissingCreds(p, hit)}）`,
      })
    }
  }

  const unmatchedPayout = c.platformPayout - matchedPayout
  const unmatchedInbound = c.walletInbound - matchedInbound
  const complete = coverageComplete && matchedCount > 0 && payouts === matchedCount && inbounds === matchedCount &&
    unmatchedPayout === 0n && unmatchedInbound === 0n
  return {
    matchedCount, mismatches, matchedPayout, matchedInbound, unmatchedPayout, unmatchedInbound,
    unmatchedPayoutCount: Math.max(0, payouts - matchedCount),
    unmatchedInboundCount: Math.max(0, inbounds - matchedCount),
    status: !complete ? 'pending_evidence' : mismatches > 0 ? 'mismatch' : 'matched',
    gap: complete && !opposingGaps ? matchedInbound - matchedPayout : null,
    candidateMatches,
  }
}

function observedPosition(wallets, field) {
  if (wallets.length === 0 || !isMonth(wallets[0].period)) return null
  const identities = new Set()
  let sum = 0n
  for (const s of wallets) {
    const value = s.walletMetrics?.[field]
    if (typeof value !== 'bigint' || s.period !== wallets[0].period) return null
    if (wallets.length > 1) {
      if (!s.accountKey) return null
      const identity = JSON.stringify([s.platform, s.accountKey, s.currency])
      if (identities.has(identity)) return null
      identities.add(identity)
    }
    sum += value
  }
  return sum
}

const DTC_STOREFRONT_PLATFORMS = new Set(['Shopify'])
const PAYMENT_GATEWAY_PLATFORMS = new Set(['PayPal', 'Stripe'])

export function buildConsolidatedReconcile(summaries, { fxRateToCny, fxRates, declaredVatSalesCny, coverageComplete = true } = {}) {
  if (!Array.isArray(summaries) || summaries.length === 0) return null
  coverageComplete = coverageComplete && !summaries.some((s) => s.parseDiagnostics?.length)
  const fxMap = normalizeFxMap(fxRates)
  const currencies = new Set()
  for (const s of summaries) {
    if (s.role === 'bank_receipt') {
      const bankCcys = [...new Set([
        ...Object.keys(s.creditTotalsByCurrency || {}),
        ...Object.keys(s.feeTotalsByCurrency || {}),
      ])].map(recognizedCurrency).filter(Boolean)
      if (bankCcys.length) {
        for (const c of bankCcys) currencies.add(c)
      } else if (s.currency !== 'UNKNOWN') {
        const rc = recognizedCurrency(s.currency)
        if (rc) currencies.add(rc)
      }
      // 币种为 UNKNOWN（如无币种列）的 bank_receipt 不参与 missingCurrencies 与 ready 判定，由 Stage 3 blankCurrency 阻断核销并告警
    } else {
      currencies.add(recognizedCurrency(s.currency))
    }
  }
  const foreignCount = [...currencies].filter((c) => c && c !== 'CNY').length
  const rates = new Map([...currencies].map((c) => [c, resolveCurrencyFx(c, fxRateToCny, fxMap, foreignCount)]))
  const missingCurrencies = [...rates].filter(([, rate]) => rate === null).map(([ccy]) => ccy || '待确认币种')
  if (missingCurrencies.length) return { ready: false, missingCurrencies, coverageComplete }

  const { weight, money, baseAmount } = exactConversions(rates)
  const total = Object.fromEntries(Object.keys(salesFields).map((key) => [key, 0n]))
  const currencyTotals = new Map()
  const walletSummaries = []
  const bankReceiptSummaries = []
  const hasDtcStorefront = summaries.some((s) => s.role !== 'settlement_wallet' && s.role !== 'bank_receipt' && DTC_STOREFRONT_PLATFORMS.has(s.platform))
  const storefrontPlatforms = [...new Set(summaries.filter((s) => s.role !== 'settlement_wallet' && s.role !== 'bank_receipt' && DTC_STOREFRONT_PLATFORMS.has(s.platform)).map((s) => s.platform))]
  const gatewayOverlapItems = []
  let gatewayGrossWeight = 0n
  let gatewayNetWeight = 0n
  let gatewayPayoutWeight = 0n
  let p0Count = 0
  let salesSheetCount = 0
  let payoutEvidenceCount = 0

  const breakdown = summaries.map((s) => {
    p0Count += (s.anomalies || []).filter((a) => String(a.severity || '').startsWith('P0')).length
    if (s.role === 'bank_receipt') {
      bankReceiptSummaries.push(s)
      const creditEntries = Object.entries(s.creditTotalsByCurrency || {})
      const feeEntries = Object.entries(s.feeTotalsByCurrency || {})
      const isUnknownBankCcy = creditEntries.length === 0 && s.currency !== 'MULTI' && !recognizedCurrency(s.currency)
      if (isUnknownBankCcy) {
        return {
          label: `${s.bankLabel || s.platform}·回单(${periodLabel(s)})`,
          platform: s.bankLabel || s.platform,
          bank: s.bank || 'GENERIC_BANK',
          site: 'CN',
          currency: '币种待核',
          fx: null,
          role: 'bank_receipt',
          grossOrig: '0.00',
          grossCny: 0,
          netSalesCny: 0,
          bankCreditCny: null,
          bankFeeCny: null,
          creditRowCount: s.creditRowCount || 0,
        }
      }
      const bankCcy = s.currency === 'MULTI' ? 'MULTI' : (recognizedCurrency(s.currency) || 'CNY')
      let bankCreditCny = toNumber2(s.totalCreditCny ?? 0n)
      let bankFeeCny = toNumber2(s.totalBankFeeCny ?? 0n)
      if (creditEntries.length > 0) {
        let cw = 0n
        for (const [k, v] of creditEntries) {
          const rc = recognizedCurrency(k)
          if (rc) cw += weight(rc, typeof v === 'bigint' ? v : (parseAmountCell(v).value ?? 0n))
        }
        bankCreditCny = money(cw)
      }
      if (feeEntries.length > 0) {
        let fw = 0n
        for (const [k, v] of feeEntries) {
          const rc = recognizedCurrency(k)
          if (rc) fw += weight(rc, typeof v === 'bigint' ? v : (parseAmountCell(v).value ?? 0n))
        }
        bankFeeCny = money(fw)
      } else if (Array.isArray(s.receipts) && s.receipts.some((r) => r && r.isTerminal !== false && r.feeAmount)) {
        let fw = 0n
        for (const r of s.receipts) {
          if (!r || r.isTerminal === false || r.blankCurrency) continue
          const rc = recognizedCurrency(r.currency || 'CNY')
          if (rc) fw += weight(rc, typeof r.feeAmount === 'bigint' ? r.feeAmount : (parseAmountCell(r.feeAmount).value ?? 0n))
        }
        bankFeeCny = money(fw)
      }
      return {
        label: `${s.bankLabel || s.platform}·回单(${periodLabel(s)})`,
        platform: s.bankLabel || s.platform,
        bank: s.bank || 'GENERIC_BANK',
        site: 'CN',
        currency: bankCcy,
        fx: bankCcy === 'MULTI' ? null : (rates.get(bankCcy) ?? 1),
        role: 'bank_receipt',
        grossOrig: '0.00',
        grossCny: 0,
        netSalesCny: 0,
        bankCreditCny,
        bankFeeCny,
        creditRowCount: s.creditRowCount || 0,
      }
    }
    const currency = recognizedCurrency(s.currency)
    if (!currencyTotals.has(currency)) {
      currencyTotals.set(currency, {
        currency, fx: rates.get(currency), platformPayout: 0n, payoutEvidenceCount: 0,
        payoutEvidence: [], inboundEvidence: [], wallets: [],
        ...Object.fromEntries(Object.keys(walletFields).map((key) => [key, 0n])),
      })
    }
    const c = currencyTotals.get(currency)
    const info = { label: `${s.platform}·${siteLabel(s)}(${periodLabel(s)})`, platform: s.platform, site: siteLabel(s), currency, fx: c.fx }
    if (s.role === 'settlement_wallet') {
      walletSummaries.push(s)
      c.wallets.push(s)
      for (const [key, field] of Object.entries(walletFields)) c[key] += s.walletMetrics?.[field] ?? 0n
      for (const ev of s.inboundEvidence ?? []) c.inboundEvidence.push(ev)
      return {
        ...info, role: 'settlement_wallet', grossOrig: '0.00', grossCny: 0, netSalesCny: 0,
        walletInboundCny: money(weight(currency, s.walletMetrics?.platformInbound ?? 0n)),
        corporateWithdrawCny: money(weight(currency, s.walletMetrics?.fxWithdrawToCorporate ?? 0n)),
      }
    }

    const gross = s.taxReportingGrossRef ?? 0n
    const refund = s.customerRefund ?? 0n
    const payout = s.actualPayout ?? 0n
    if (hasDtcStorefront && PAYMENT_GATEWAY_PLATFORMS.has(s.platform)) {
      const gWeight = weight(currency, gross)
      const nWeight = weight(currency, gross - refund)
      const pWeight = weight(currency, payout)
      gatewayGrossWeight += gWeight
      gatewayNetWeight += nWeight
      gatewayPayoutWeight += pWeight
      const item = {
        ...info,
        platform: s.platform,
        role: 'payment_gateway_overlap',
        orderCount: 0,
        gatewayOrderCount: s.orderCount ?? 0,
        grossOrig: fmtAmount(gross),
        grossCny: 0,
        netSalesCny: 0,
        gatewayGrossCny: money(gWeight),
        gatewayNetCny: money(nWeight),
        gatewayPayoutCny: money(pWeight),
      }
      gatewayOverlapItems.push(item)
      return item
    }

    salesSheetCount++
    const count = s.payoutEvidenceCount ?? Number(payout !== 0n)
    payoutEvidenceCount += count
    c.payoutEvidenceCount += count
    c.platformPayout += payout
    for (const ev of s.payoutEvidence ?? []) c.payoutEvidence.push(ev)
    for (const [key, field] of Object.entries(salesFields)) total[key] += weight(currency, s[field] ?? 0n)
    return {
      ...info, role: 'sales_platform', grossOrig: fmtAmount(gross),
      orderCount: s.orderCount ?? 0,
      grossCny: money(weight(currency, gross)), refundCny: money(weight(currency, refund)),
      netSalesCny: money(weight(currency, gross - refund)), feesCny: money(weight(currency, s.totalFees ?? 0n)),
      payoutCny: money(weight(currency, payout)),
    }
  })

  const dtcGatewayOverlap = gatewayOverlapItems.length > 0
    ? (() => {
        const excludedGatewayGrossCny = money(gatewayGrossWeight)
        const excludedGatewayNetCny = money(gatewayNetWeight)
        const excludedGatewayPayoutCny = money(gatewayPayoutWeight)
        const gatewayPlatforms = [...new Set(gatewayOverlapItems.map((x) => x.platform))]
        return {
          status: 'pending_order_gateway_reconcile',
          storefrontPlatforms,
          gatewayPlatforms,
          excludedGatewayGrossCny,
          excludedGatewayNetCny,
          excludedGatewayPayoutCny,
          items: gatewayOverlapItems,
          warning: `【防重复计入 · 独立站订单与支付网关双导入】同批同时导入独立站订单（${storefrontPlatforms.join('/')}）与支付网关流水（${gatewayPlatforms.join('/')}），已将网关侧参考毛额 ¥${excludedGatewayGrossCny.toFixed(2)}（净额 ¥${excludedGatewayNetCny.toFixed(2)}）单列核对、未重复累加至销售合计；请按订单号/交易引用逐笔核对重合订单并确认唯一主销售来源，确认独立站外收款后再另行并入。`,
        }
      })()
    : null

  const stage3FxRates = Object.fromEntries([...rates.entries()].filter(([ccy, rate]) => ccy && rate > 0))
  const stage3 = (walletSummaries.length > 0 || bankReceiptSummaries.length > 0)
    ? reconcileStage3(walletSummaries, bankReceiptSummaries, { fxRates: stage3FxRates, coverageComplete })
    : null

  let fundChain = null
  if (walletSummaries.length > 0) {
    const currencies = [...currencyTotals.values()].map((c) => ({ ...c, match: matchFunds(c, coverageComplete) }))
    const summarize = (read) => money(currencies.reduce((n, c) => n + weight(c.currency, read(c)), 0n))
    const linked = currencies.filter((c) => c.payoutEvidenceCount > 0 || c.inboundEvidence.length > 0 || c.walletInbound !== 0n)
    const status = !linked.length || linked.some((c) => c.match.status === 'pending_evidence') ? 'pending_evidence'
      : linked.some((c) => c.match.status === 'mismatch') ? 'mismatch' : 'matched'
    const rawGaps = linked.map((c) => c.match.gap)
    const roundedGap = status === 'pending_evidence' || rawGaps.some((v) => v === null) ||
      (rawGaps.some((v) => v < 0n) && rawGaps.some((v) => v > 0n)) ? null : summarize((c) => c.match.gap ?? 0n)
    const byCurrency = currencies.map((c) => ({
      currency: c.currency, fx: c.fx, platformPayout: toNumber2(c.platformPayout), payoutEvidenceCount: c.payoutEvidenceCount,
      ...Object.fromEntries(Object.keys(walletFields).map((key) => [key, toNumber2(c[key])])),
      signedNetFlow: c.wallets.some((s) => s.walletMetrics?.netUnobservedCount) ? null : toNumber2(c.signedNetFlow),
      openingBalance: toNumber2OrNull(coverageComplete ? observedPosition(c.wallets, 'openingBalance') : null),
      closingBalance: toNumber2OrNull(coverageComplete ? observedPosition(c.wallets, 'closingBalance') : null),
      retainedOffshore: toNumber2OrNull(coverageComplete ? observedPosition(c.wallets, 'unrepatriatedNet') : null),
      stage1to2Status: c.match.status,
      stage1to2Gap: c.match.status === 'mismatch' && toNumber2OrNull(c.match.gap) === 0 ? null : toNumber2OrNull(c.match.gap),
      matchedPayout: toNumber2(c.match.matchedPayout), matchedInbound: toNumber2(c.match.matchedInbound),
      unmatchedPayout: toNumber2(c.match.unmatchedPayout), unmatchedInbound: toNumber2(c.match.unmatchedInbound),
      unmatchedPayoutCount: c.match.unmatchedPayoutCount, unmatchedInboundCount: c.match.unmatchedInboundCount,
    }))

    const positionCny = (field) => {
      if (!coverageComplete || walletSummaries.some((s) => s.period !== walletSummaries[0].period)) return null
      const positions = new Map(currencies.filter((c) => c.wallets.length > 0).map((c) => [c.currency, observedPosition(c.wallets, field)]))
      if ([...positions.values()].some((v) => v === null)) return null
      return summarize((c) => positions.get(c.currency) ?? 0n)
    }
    const unmatchedReturnCount = walletSummaries.reduce((n, s) => n + (s.walletMetrics?.unmatchedReturnCount || 0), 0)
    const pendingReturnCount = walletSummaries.reduce((n, s) => n + (s.walletMetrics?.pendingReturnCount || 0), 0)
    const netPendingCount = walletSummaries.reduce((n, s) => n + (s.walletMetrics?.netPendingCount || 0), 0)
    const totalInbound = currencies.reduce((n, c) => n + weight(c.currency, c.walletInbound + c.otherInbound), 0n)
    const totalCorporate = currencies.reduce((n, c) => n + weight(c.currency, c.corporateWithdraw), 0n)
    const knownWalletMonths = new Set(walletSummaries.map((s) => s.period).filter(isMonth))
    const ratio = coverageComplete && knownWalletMonths.size === 1 && walletSummaries.every((s) => isMonth(s.period)) &&
      unmatchedReturnCount === 0 && pendingReturnCount === 0 && netPendingCount === 0 &&
      totalInbound > 0n && totalCorporate > 0n && totalCorporate <= totalInbound
      ? Number(roundBig(totalCorporate * 10_000n, totalInbound)) / 100 : null
    const alerts = []
    const personal = summarize((c) => c.personalWithdraw)
    const unverified = summarize((c) => c.unverifiedWithdraw)
    const spend = summarize((c) => c.directSpend)
    if (personal > 0) alerts.push(`【P0 优先核查 · 个人私户】疑似个人账户提现折合 ${personal.toFixed(2)} 元，请核对收款户名和银行回单。`)
    if (unverified > 0) alerts.push(`【P1 待核凭证 · 收款户性质不明】折合 ${unverified.toFixed(2)} 元提现待核收款主体，已排除在企业户转出占比之外。`)
    if (status !== 'matched') {
      alerts.push(status === 'mismatch'
        ? '【一/二段差额待解释】已关联凭证的放款与入账金额不一致，请逐笔核对。'
        : '【一/二段待核】当前覆盖或主体、账号、账期与放款凭证不足，未匹配金额需分别核对。')
    }
    if (linked.filter((c) => c.match.status !== 'matched').length > 1) {
      alerts.push('【一/二段跨币种单边未匹配】请逐币种核对放款和钱包入账。')
    }
    if (pendingReturnCount || unmatchedReturnCount) alerts.push('【退汇待核】部分退汇尚未关联到原提现，转出占比暂停展示。')
    if (netPendingCount) alerts.push('【钱包净额待核】部分手续费拆分或净变动存在未解释差额，转出占比暂停展示。')
    if (spend > 0) alerts.push(`【P1 待补凭证 · 境外余额坐支】支付境外费用折合 ${spend.toFixed(2)} 元，请补齐合同、发票与支付凭证。`)
    if (!salesSheetCount) alerts.push('【独立体检模式】本次仅导入第三方结汇流水，第一段平台放款待导入。')
    const retainedOffshoreCny = positionCny('unrepatriatedNet')
    if (retainedOffshoreCny === null) alerts.push('【余额待核】需补同账期钱包余额凭据后才能确认滞留金额。')

    const hasBankReceipts = bankReceiptSummaries.length > 0
    if (hasBankReceipts && stage3?.alerts?.length) {
      for (const a of stage3.alerts) {
        if (personal > 0 && a.includes('个人私户')) continue
        alerts.push(a)
      }
    }
    const stage3VerificationStatus = hasBankReceipts ? stage3.stage3Status : 'pending_bank_receipt'
    const bankReceivedCny = hasBankReceipts && stage3.stats.matchedCount > 0 ? stage3.stage3MatchedCny : null
    const stage3StatusNote = !hasBankReceipts
      ? '钱包流水仅显示向疑似企业账户转出，实收金额和账户归属均待核。请核对国内银行收款回单（主体、日期、币种、实收金额）。'
      : stage3.stage3Status === 'matched'
        ? '已通过国内对公银行回单完成法定 5 键精确核销（主体+对公账号/尾号+账期+回单参考号+币种金额），银行手续费与汇损已单列。'
        : stage3.stage3Status === 'partial'
          ? '已通过国内对公银行回单核销部分款项，其余参考级候选与在途差额请对照银行电子回单逐笔补齐确认。'
          : stage3.stage3Status === 'candidate_only'
            ? '仅检出 Stage 3 参考级候选银行回单（缺精确参考号或对公账号一致凭证），不可替代法定 5 键核销，请人工对照电子回单确认。'
            : '已导入国内银行回单但尚未通过法定 5 键核销，请核对本方户名、对公账号尾号、账期、结汇参考号及金额。'

    const rawCandidateMatches = currencies.flatMap((c) => c.match.candidateMatches || [])
    const candidateMatches = rawCandidateMatches.map((m) => ({
      currency: m.currency,
      period: m.period,
      platform: m.platform,
      payoutAmount: toNumber2(m.payoutAmount),
      inboundAmount: toNumber2(m.inboundAmount),
      diffAmount: toNumber2(m.diffAmount),
      payoutCny: money(weight(m.currency, m.payoutAmount)),
      inboundCny: money(weight(m.currency, m.inboundAmount)),
      diffCny: money(weight(m.currency, m.diffAmount)),
      status: m.status,
      matchBasis: m.matchBasis,
    }))
    const candidateMatchSummary = candidateMatches.length
      ? {
          count: candidateMatches.length,
          exactAmountCount: rawCandidateMatches.filter((m) => m.diffAmount === 0n).length,
          matchedPayoutCny: money(rawCandidateMatches.reduce((n, m) => n + weight(m.currency, m.payoutAmount), 0n)),
          matchedInboundCny: money(rawCandidateMatches.reduce((n, m) => n + weight(m.currency, m.inboundAmount), 0n)),
          diffCny: money(rawCandidateMatches.reduce((n, m) => n + weight(m.currency, m.diffAmount), 0n)),
          status: 'reference_only_pending_confirm',
          note: '参考级候选配对仅按同币种+同账期+同来源平台归组，因缺少主体/账号/放款编号强凭证，不可替代法定 5 键核销，请人工核对银行/钱包回单后确认。',
        }
      : null

    fundChain = {
      mode: salesSheetCount > 0 ? 'three_stage_cross_check' : 'wallet_only',
      hasSalesEvidence: payoutEvidenceCount > 0,
      hasSalesStatements: salesSheetCount > 0,
      salesSheetCount, walletCount: walletSummaries.length, bankReceiptCount: bankReceiptSummaries.length,
      stage1PlatformPayoutCny: payoutEvidenceCount > 0 ? money(total.payout) : null,
      stage1PayoutEvidenceCount: payoutEvidenceCount,
      stage2WalletInboundCny: summarize((c) => c.walletInbound),
      stage2OtherInboundCny: summarize((c) => c.otherInbound),
      stage1to2GapCny: status === 'mismatch' && roundedGap === 0 ? null : roundedGap, stage1to2Status: status,
      stage1MatchedPayoutCny: summarize((c) => c.match.matchedPayout),
      stage2MatchedInboundCny: summarize((c) => c.match.matchedInbound),
      stage1UnmatchedPayoutCny: summarize((c) => c.match.unmatchedPayout),
      stage2UnmatchedInboundCny: summarize((c) => c.match.unmatchedInbound),
      stage1UnmatchedPayoutCount: currencies.reduce((n, c) => n + c.match.unmatchedPayoutCount, 0),
      stage2UnmatchedInboundCount: currencies.reduce((n, c) => n + c.match.unmatchedInboundCount, 0),
      candidateMatches,
      candidateMatchSummary,
      stage3VerificationStatus,
      stage3StatusNote,
      stage3CorporateRepatriatedCny: money(totalCorporate),
      grossCorporateWithdrawCny: summarize((c) => c.grossCorporateWithdraw),
      matchedCorporateReturnCny: summarize((c) => c.matchedCorporateReturn),
      unmatchedReturnCny: summarize((c) => c.unmatchedReturnAmount),
      returnedInboundCny: summarize((c) => c.returnedInbound),
      stage3PersonalWithdrawCny: personal, stage3UnverifiedWithdrawCny: unverified, directSpendCny: spend,
      walletFeesCny: summarize((c) => c.walletFees),
      frozenOutflowCny: summarize((c) => c.frozenOutflow),
      internalFxNetCny: summarize((c) => c.internalFxNet),
      internalFxStrippedCny: summarize((c) => c.internalFxStripped),
      signedNetFlowCny: coverageComplete && !walletSummaries.some((s) => s.walletMetrics?.netUnobservedCount)
        ? summarize((c) => c.signedNetFlow) : null,
      openingBalanceCny: positionCny('openingBalance'), closingBalanceCny: positionCny('closingBalance'),
      retainedOffshoreCny, bankReceivedCny, corporateRepatriationRatePct: ratio, byCurrency, alerts,
      stage3,
    }
  } else if (bankReceiptSummaries.length > 0) {
    fundChain = {
      mode: 'bank_receipt_only',
      hasSalesEvidence: payoutEvidenceCount > 0,
      hasSalesStatements: salesSheetCount > 0,
      salesSheetCount, walletCount: 0, bankReceiptCount: bankReceiptSummaries.length,
      stage1PlatformPayoutCny: payoutEvidenceCount > 0 ? money(total.payout) : null,
      stage1PayoutEvidenceCount: payoutEvidenceCount,
      stage2WalletInboundCny: 0, stage2OtherInboundCny: 0,
      stage1to2GapCny: null, stage1to2Status: 'pending_evidence',
      stage1MatchedPayoutCny: 0, stage2MatchedInboundCny: 0,
      stage1UnmatchedPayoutCny: payoutEvidenceCount > 0 ? money(total.payout) : 0,
      stage2UnmatchedInboundCny: 0, stage1UnmatchedPayoutCount: payoutEvidenceCount, stage2UnmatchedInboundCount: 0,
      candidateMatches: [], candidateMatchSummary: null,
      stage3VerificationStatus: stage3.stage3Status,
      stage3StatusNote: '已导入国内对公银行回单，尚缺 Stage 2 第三方结汇流水以执行法定 5 键交叉核销。',
      stage3CorporateRepatriatedCny: 0, grossCorporateWithdrawCny: 0, matchedCorporateReturnCny: 0,
      unmatchedReturnCny: 0, returnedInboundCny: 0, stage3PersonalWithdrawCny: 0,
      stage3UnverifiedWithdrawCny: 0, directSpendCny: 0, walletFeesCny: 0, frozenOutflowCny: 0,
      internalFxNetCny: 0, internalFxStrippedCny: 0, signedNetFlowCny: null,
      openingBalanceCny: null, closingBalanceCny: null, retainedOffshoreCny: null,
      bankReceivedCny: null, corporateRepatriationRatePct: null, byCurrency: [],
      alerts: [...stage3.alerts, '【独立银行回单模式】请同步导入连连/PingPong/寻汇/万里汇等结汇流水以完成 Stage 3 五键核销。'],
      stage3,
    }
  }

  const totals = {
    grossCny: money(total.gross), refundCny: money(total.refund), netSalesCny: money(total.gross - total.refund),
    feesCny: money(total.fees), subsidyCny: money(total.subsidy), selfRemitTaxCny: money(total.tax),
    reserveCny: money(total.reserve), payoutCny: money(total.payout), payoutEvidenceCount,
  }
  const reconcile = salesSheetCount > 0 ? platformStatementTaxReconcile({
    reportedGrossRevenue: total.gross,
    reportedGrossSource: 'statement_reference',
    refunds: total.refund,
    platformFees: total.fees,
    subsidies: total.subsidy,
    selfRemitTaxNet: total.tax,
    reserveChange: total.reserve,
    actualPayout: payoutEvidenceCount > 0 ? total.payout : undefined,
    declaredVatSales: declaredVatSalesCny,
  }, { money, baseAmount }) : {
    summary: '本次仅导入第三方结汇通道流水，核对结果见资金链路分析。',
    steps: [], warnings: [],
  }
  if (dtcGatewayOverlap) {
    reconcile.warnings = [dtcGatewayOverlap.warning, ...(reconcile.warnings || [])]
  }
  const cliffRatioPct = r2(totals.netSalesCny / 75_000_000 * 100)
  const cliffAlert = totals.netSalesCny >= 55_000_000
    ? `【4% 核定收入等值初筛】合并报送参考净额为 7,500 万元等值的 ${cliffRatioPct}%。请按主体和纳税年度复核。` : null
  return { ready: true, coverageComplete, breakdown, totals, reconcile, fundChain, dtcGatewayOverlap, p0Count, cliffRatioPct, cliffAlert }
}

const toNumber2OrNull = (v) => typeof v === 'bigint' ? toNumber2(v) : null
const siteLabel = (s) => /^(?:[A-Z]{2,3}|DTC|GLOBAL|EUROPE|北美|欧洲|全球)$/.test(s.site || '') ? s.site : '待核站点'
const periodLabel = (s) => isMonth(s.period) || ABSENT.includes(s.period) ? s.period : '待确认期间'

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const mdText = (s) => String(s ?? '')
  .replace(/[\r\n\u2028\u2029]+/g, ' ')
  .replace(/[&<>"'\\\x60*_\[\]()!|~#{}+\-]/g, (char) => `&#${char.charCodeAt(0)};`)

function fileLabel(s) {
  const name = String(s.fileName ?? '').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160)
  if (s.role === 'bank_receipt') {
    const suffix = extname(name).toLowerCase()
    return `${s.bankLabel || s.platform} 银行回单${['.csv', '.tsv', '.xlsx'].includes(suffix) ? suffix : ''}`
  }
  if (s.role !== 'settlement_wallet') return name || '账单'
  const suffix = extname(name).toLowerCase()
  return `${s.platform} 结汇账单${['.csv', '.tsv', '.xlsx'].includes(suffix) ? suffix : ''}`
}

function publicAnomalies(s) {
  return (s.anomalies || []).map((a, index) => {
    const severity = /^P0/.test(a.severity) ? 'P0-阻断' : /^P1/.test(a.severity) ? 'P1-高危' : 'P2-关注'
    const rowFromText = /^第 (\d{1,7}) 行/.exec(a.detail || '')
    const rowNumber = a.rowNumber ?? a.row ?? (rowFromText ? Number(rowFromText[1]) : null)
    const refId = Number.isSafeInteger(rowNumber) && rowNumber > 0 ? `第 ${rowNumber} 行` : `异常 ${index + 1}`
    const category = String(a.category ?? '交易待核').slice(0, 96)
    return {
      severity, category, refId,
      amount: /^[+-]?\d+(?:\.\d+)?$/.test(a.amount ?? '') ? String(a.amount) : '',
      detail: inferNextAction({ category }),
    }
  })
}

function resolveExportTarget(exportPath, firstInputPath) {
  const raw = String(exportPath ?? '').trim()
  if (!raw) return null
  const isDemo = !firstInputPath || /^demo(?::|$)/i.test(firstInputPath)
  const baseDir = isDemo ? tmpdir() : dirname(resolve(firstInputPath))
  const stem = isDemo ? 'dsh_fintax_demo' : basename(firstInputPath, extname(firstInputPath))

  if (['auto', 'auto.html', 'html'].includes(raw.toLowerCase())) {
    return join(baseDir, `${stem}_税务初筛体检单.html`)
  }
  if (['auto.md', 'md', 'markdown'].includes(raw.toLowerCase())) {
    return join(baseDir, `${stem}_税务初筛体检单.md`)
  }
  if (['auto.csv', 'csv'].includes(raw.toLowerCase())) {
    return join(baseDir, `${stem}_异常排雷清单.csv`)
  }
  return resolve(raw)
}

/** 将含 BigInt 金额的账单摘要安全序列化为前端工作台可读的精确 JSON 对象。 */
export function serializeSummary(s) {
  const base = {
    role: s.role || 'sales_platform',
    period: periodLabel(s),
    platform: s.role === 'bank_receipt' ? (s.bankLabel || s.platform) : s.platform,
    site: siteLabel(s),
    currency: s.role === 'bank_receipt' && s.currency === 'MULTI' ? 'MULTI' : (recognizedCurrency(s.currency) || '待确认币种'),
    formatLabel: s.role === 'bank_receipt'
      ? `${s.bankLabel || s.platform} 对公银行回单`
      : `${s.platform} ${s.role === 'settlement_wallet' ? '结汇流水' : '销售账单'}`,
    fileName: fileLabel(s),
    rawRowCount: s.rawRowCount,
    orderCount: s.role === 'settlement_wallet' || s.role === 'bank_receipt' ? 0 : (s.orderCount || 0),
    payoutEvidenceCount: s.payoutEvidenceCount ?? Number((s.actualPayout ?? 0n) !== 0n),
    grossSales: fmtAmount(s.grossSales ?? 0n),
    sellerDiscount: fmtAmount(s.sellerDiscount ?? 0n),
    taxReportingGrossRef: fmtAmount(s.taxReportingGrossRef ?? 0n),
    taxReportingGrossRefSource: s.taxReportingGrossRefSource,
    platformSubsidy: fmtAmount(s.platformSubsidy ?? 0n),
    customerRefund: fmtAmount(s.customerRefund ?? 0n),
    totalFees: fmtAmount(s.totalFees ?? 0n),
    platformCommission: fmtAmount(s.platformCommission ?? 0n),
    affiliateCommission: fmtAmount(s.affiliateCommission ?? 0n),
    logisticsWarehousing: fmtAmount(s.logisticsWarehousing ?? 0n),
    inPlatformAds: fmtAmount(s.inPlatformAds ?? 0n),
    gatewayDisputeFee: fmtAmount(s.gatewayDisputeFee ?? 0n),
    facilitatorTaxStripped: fmtAmount(s.facilitatorTaxStripped ?? 0n),
    selfRemitTaxNet: fmtAmount(s.selfRemitTaxNet ?? 0n),
    reserveNetChange: fmtAmount(s.reserveNetChange ?? 0n),
    theoreticalPayout: fmtAmount(s.theoreticalPayout ?? 0n),
    actualPayout: fmtAmount(s.actualPayout ?? 0n),
    statementPayoutDiff: fmtAmount(s.statementPayoutDiff ?? 0n),
    statementPayoutDiffFormula: s.statementPayoutDiffFormula,
    uncapturedVoidExcluded: fmtAmount(s.uncapturedVoidExcluded ?? 0n),
    freeSampleCount: s.freeSampleCount || 0,
    horizontalDiffTotal: fmtAmount(s.horizontalDiffTotal ?? 0n),
    horizontalBalanced: (s.horizontalDiffTotal ?? 0n) === 0n,
    anomalies: publicAnomalies(s),
  }
  if (Array.isArray(s.amazon2027Fees) && s.amazon2027Fees.length) {
    base.amazon2027Fees = s.amazon2027Fees
  }
  if (s.role === 'bank_receipt') {
    base.bank = s.bank || 'GENERIC_BANK'
    base.bankLabel = s.bankLabel || s.platform
    base.creditRowCount = s.creditRowCount || 0
    base.debitRowCount = s.debitRowCount || 0
    base.totalCreditCny = fmtAmount(s.totalCreditCny || 0n)
    base.totalBankFeeCny = fmtAmount(s.totalBankFeeCny || 0n)
    base.bankReceiptMetrics = {
      creditRowCount: s.creditRowCount || 0,
      debitRowCount: s.debitRowCount || 0,
      totalCreditCny: fmtAmount(s.totalCreditCny || 0n),
      totalBankFeeCny: fmtAmount(s.totalBankFeeCny || 0n),
      creditTotalsByCurrency: Object.fromEntries(
        Object.entries(s.creditTotalsByCurrency || {}).map(([k, v]) => [k, fmtAmount(v)]),
      ),
      feeTotalsByCurrency: Object.fromEntries(
        Object.entries(s.feeTotalsByCurrency || {}).map(([k, v]) => [k, fmtAmount(v)]),
      ),
    }
  }
  if (s.walletMetrics) {
    const wm = s.walletMetrics
    base.walletMetrics = {
      platformInbound: fmtAmount(wm.platformInbound || 0n),
      otherInbound: fmtAmount(wm.otherInbound || 0n),
      returnedInbound: fmtAmount(wm.returnedInbound || 0n),
      fxWithdrawToCorporate: fmtAmount(wm.fxWithdrawToCorporate || 0n),
      grossCorporateWithdraw: fmtAmount(wm.grossCorporateWithdraw || 0n),
      matchedCorporateReturn: fmtAmount(wm.matchedCorporateReturn || 0n),
      unmatchedReturnAmount: fmtAmount(wm.unmatchedReturnAmount || 0n),
      unmatchedReturnCount: wm.unmatchedReturnCount || 0,
      pendingReturnCount: wm.pendingReturnCount || 0,
      fxWithdrawToPersonal: fmtAmount(wm.fxWithdrawToPersonal || 0n),
      unverifiedWithdraw: fmtAmount(wm.unverifiedWithdraw || 0n),
      directSpend: fmtAmount(wm.directSpend || 0n),
      walletFees: fmtAmount(wm.walletFees || 0n),
      internalFxStripped: fmtAmount(wm.internalFxStripped || 0n),
      internalFxNet: fmtAmount(wm.internalFxNet || 0n),
      internalFxCount: wm.internalFxCount || 0,
      frozenOutflow: fmtAmount(wm.frozenOutflow || 0n),
      frozenOrReturned: fmtAmount(wm.frozenOrReturned || 0n),
      voidExcludedCount: wm.voidExcludedCount || 0,
      netVerifiedRows: wm.netVerifiedRows || 0,
      openingBalance: typeof wm.openingBalance === 'bigint' ? fmtAmount(wm.openingBalance) : null,
      closingBalance: typeof wm.closingBalance === 'bigint' ? fmtAmount(wm.closingBalance) : null,
      unrepatriatedNet: typeof wm.unrepatriatedNet === 'bigint' ? fmtAmount(wm.unrepatriatedNet) : null,
      signedNetFlow: wm.netUnobservedCount ? null : fmtAmount(wm.signedNetFlow || 0n),
      ...(typeof wm.cnySettledCorporate === 'bigint' ? {
        cnySettledCorporate: fmtAmount(wm.cnySettledCorporate),
        cnySettledPersonal: fmtAmount(wm.cnySettledPersonal || 0n),
        cnySettledUnverified: fmtAmount(wm.cnySettledUnverified || 0n),
        fxExpectedCny: fmtAmount(wm.fxExpectedCny || 0n),
        fxSettlementDiffCny: fmtAmount(wm.fxSettlementDiffCny || 0n),
        fxSettlementCount: wm.fxSettlementCount || 0,
      } : {}),
    }
  }
  return base
}

function buildReportContext(summaries, consolidated) {
  const allAnoms = summaries.flatMap((s) =>
    publicAnomalies(s).map((a) => ({ ...a, scope: `${s.platform}·${siteLabel(s)}(${recognizedCurrency(s.currency) || '币种待核'})` })),
  )
  const p0 = allAnoms.filter((a) => a.severity.startsWith('P0'))
  const p1 = allAnoms.filter((a) => a.severity.startsWith('P1'))
  const p2 = allAnoms.filter((a) => a.severity.startsWith('P2'))
  const totalRows = summaries.reduce((acc, s) => acc + s.rawRowCount, 0)
  const pending = consolidated?.ready === false || consolidated?.coverageComplete === false ||
    Boolean(consolidated?.dtcGatewayOverlap) ||
    summaries.some((s) => s.role === 'settlement_wallet' || s.parseDiagnostics?.length)
  const genTime = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const overallBadge =
    p0.length > 0
      ? { level: 'P0 阻断级风险（申报前须先剥离/修正）', color: '#DC2626', bg: '#FEF2F2' }
      : p1.length > 0 || pending
        ? { level: '待核资料与凭证', color: '#B45309', bg: '#FFFBEB' }
        : { level: '初筛勾稽平衡（未检出阻断与高危项）', color: '#15803D', bg: '#F0FDF4' }
  return { allAnoms, p0, p1, p2, totalRows, genTime, overallBadge }
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八']

export function inferNextAction(anom) {
  const txt = `${anom?.category || ''} ${anom?.detail || ''}`
  if (/个人私户|私卡|公私混收/.test(txt)) {
    return '补核个人卡收款流水及往来性质说明；按企业对公收汇规范整改，若属分红或借款请核实个税与协议'
  }
  if (/收款户性质待核|待核银行回单|主体待核/.test(txt)) {
    return '调取银行入账回单，核验户名是否属于本境内经营主体、入账日期、币种及实收金额'
  }
  if (/坐支|广告|供应商|物流/.test(txt)) {
    return '补齐境外费用发票、广告账单或采购合同及支付水单，单独列支成本费用，勿直接冲减收入'
  }
  if (/非标准|其他入账|漏导/.test(txt)) {
    return '核实付款方身份与资金来源，确认是否漏导销售平台账单、退税款或关联方往来'
  }
  if (/全托管|供货/.test(txt)) {
    return '将全托管供货结算单从自营零售清单剥离，按国内供货/一般贸易开票口径单独核算'
  }
  if (/自申报|流转税|VAT|Sales Tax/i.test(txt)) {
    return '核对境外税局申报表及缴款回单，代收待缴税款计入往来科目，勿混入主营业务收入'
  }
  if (/冻结|退回|准备金|Reserve/i.test(txt)) {
    return '留存平台/通道冻结或退汇通知，跨期跟踪后续解冻释放或重新打款记录'
  }
  if (/非对公|银行回单|参考级候选/.test(txt)) {
    return '核对国内银行电子回单本方企业户名、账号尾号、结汇参考号及实收金额，区分银行手续费与汇损后人工确认'
  }
  if (/库龄|AWD|Oversize|2027/i.test(txt)) {
    return '复核 2027 年 Amazon 新费用科目归类及包装尺寸/库龄结构，单列物流履约成本，严禁冲减销售收入'
  }
  if (/水平守恒|不平衡|差额/.test(txt)) {
    return '回到原表定位对应单号行，排查是否存在未映射新费用列、跨月在途放款或手续费差额'
  }
  return '回到原始账单核对对应单号明细，补齐业务佐证凭证后再标注已复核'
}

const STAGE3_STATUS_ZH = {
  matched: '已全部 5 键精确核销',
  partial: '部分核销（含在途/候选待核）',
  candidate_only: '仅参考级候选（未法定核销）',
  pending_bank_receipt: '待补银行回单',
}

export function renderDiagnosticReportMd({ summaries, consolidated, coverage, version = VERSION, includeResourceAppendix = false }) {
  const { allAnoms, p0, p1, p2, totalRows, genTime, overallBadge } = buildReportContext(summaries, consolidated)
  const salesSummaries = summaries.filter((s) => s.role !== 'settlement_wallet' && s.role !== 'bank_receipt')
  const walletSummaries = summaries.filter((s) => s.role === 'settlement_wallet')
  const bankSummaries = summaries.filter((s) => s.role === 'bank_receipt')
  const periods = [...new Set(summaries.map(periodLabel))].join(' / ') || '未识别'
  const sourceLabels = (items) => items.map((s) =>
    mdText(`${s.platform}·${siteLabel(s)}(${recognizedCurrency(s.currency) || '币种待核'}, ${fileLabel(s)})`),
  ).join('；')
  let sec = 0
  const nextSec = () => `${CN_NUM[sec++] || sec}、`

  const md = [
    `# 跨境月结核对单（原始账单离线初筛）`,
    ``,
    `> **核查结论**：**${overallBadge.level}**（P0 优先核查 ${p0.length} 项 · P1 待补凭证 ${p1.length} 项 · P2 关注 ${p2.length} 项；注：P0/P1 表示核查优先级）  `,
    `> **生成引擎**：dsh-fintax v${mdText(version)}（BigInt 本地离线初筛）｜**生成时间**：${genTime}｜**识别账期**：${mdText(periods)}｜**覆盖文件**：${summaries.length} 份（${totalRows} 行明细）`,
    ``,
    `## ${nextSec()}本期核对范围与老板一页结论`,
    `- **已核对销售账单（${salesSummaries.length} 份）**：${salesSummaries.length ? sourceLabels(salesSummaries) : '本次未导入销售平台账单'}`,
    `- **已核对结汇流水（${walletSummaries.length} 份）**：${walletSummaries.length ? sourceLabels(walletSummaries) : '本次未导入第三方结汇流水'}`,
    ...(bankSummaries.length ? [`- **已核对国内对公银行回单（${bankSummaries.length} 份）**：${sourceLabels(bankSummaries)}`] : []),
  ]
  if (coverage?.complete === false || consolidated?.coverageComplete === false || summaries.some((s) => s.parseDiagnostics?.length)) {
    md.push('- **覆盖待核**：有未解析账单或工作表，以下金额仅涵盖已解析部分。')
  }
  if (consolidated?.ready === false) {
    md.push(`- **人民币折算待核**：请确认币种或填写汇率（${mdText(consolidated.missingCurrencies.join('、'))}）。`)
  }
  if (consolidated?.ready) {
    const fc = consolidated.fundChain
    const salesLine = salesSummaries.length
      ? `报送参考净额 ${fmtYuan(consolidated.totals.netSalesCny)} ｜ 平台放款 ${consolidated.totals.payoutEvidenceCount > 0 ? fmtYuan(consolidated.totals.payoutCny) : '待补放款凭证'}`
      : '未导入销售账单'
    const walletLine = fc
      ? ` ｜ 钱包平台入账 \`¥${fc.stage2WalletInboundCny.toFixed(2)}\` ｜ 钱包转出至企业户（待核银行回单）\`¥${fc.stage3CorporateRepatriatedCny.toFixed(2)}\``
      : ''
    md.push(`- **本期已对齐参考额**：${salesLine}${walletLine}`)
    if (fc?.stage1to2GapCny != null && fc.stage1to2GapCny !== 0) {
      md.push(`- **待解释跨段差额**：一/二段差额（②钱包入账 − ①平台放款）\`¥${fc.stage1to2GapCny.toFixed(2)}\`，请优先排查跨月在途放款、提现手续费或漏导账户。`)
    }
    if (consolidated.dtcGatewayOverlap) {
      md.push(`- **独立站防重算隔离**：${mdText(consolidated.dtcGatewayOverlap.warning)}`)
    }
  }
  md.push(
    `- **下一步派活摘要**：${allAnoms.length ? `共检出 ${allAnoms.length} 项待核事项（P0 ${p0.length} / P1 ${p1.length} / P2 ${p2.length}），详见下方「财务待核派活清单」。` : '本次覆盖的账单明细未检出 P0/P1/P2 异常，仍请按银行入账回单复核对公实收。'}`,
    ``,
  )
  if (salesSummaries.length > 0) {
    md.push(
      `## ${nextSec()}各平台／站点原币报送参考与结算项目`,
      `| 平台·站点 | 期间 | 币种 | ①商品含运费原价 | ★报送参考毛收入(①-②) | ④客户退款 | ⑤~⑨佣金与履约费 | 待自申报境外税 | 实际打款 | 水平守恒 |`,
      `|---|---|---|---:|---:|---:|---:|---:|---:|---|`,
      ...salesSummaries.map(
        (s) =>
          `| ${mdText(s.platform)}·${mdText(siteLabel(s))} | ${mdText(periodLabel(s))} | ${mdText(recognizedCurrency(s.currency) || '币种待核')} | ${fmtAmount(s.grossSales)} | **${fmtAmount(s.taxReportingGrossRef)}** | ${fmtAmount(s.customerRefund)} | ${fmtAmount(s.totalFees)} | ${fmtAmount(s.selfRemitTaxNet)} | ${fmtAmount(s.actualPayout)} | ${s.horizontalDiffTotal === 0n ? '✔ 通过' : '❌ 失衡'} |`,
      ),
      ``,
    )
  }
  if (walletSummaries.length > 0) {
    md.push(
      `## ${nextSec()}结汇收款通道原币资金流水拆解（不重复计入销售报送额）`,
      `| 结汇通道 | 期间 | 币种 | 平台回款入账 | 转出企业户(待核回单) | 个人私户(P0) | 待核提现(P1) | 境外坐支(P1) | 手续费 | 期末余额 |`,
      `|---|---|---|---:|---:|---:|---:|---:|---:|---:|`,
      ...walletSummaries.map((s) => {
        const wm = s.walletMetrics || {}
        return `| ${mdText(s.platform)}·${mdText(siteLabel(s))} | ${mdText(periodLabel(s))} | ${mdText(recognizedCurrency(s.currency) || '币种待核')} | ${fmtAmount(wm.platformInbound || 0n)} | **${fmtAmount(wm.fxWithdrawToCorporate || 0n)}** | ${fmtAmount(wm.fxWithdrawToPersonal || 0n)} | ${fmtAmount(wm.unverifiedWithdraw || 0n)} | ${fmtAmount(wm.directSpend || 0n)} | ${fmtAmount(wm.walletFees || 0n)} | ${fmtBalance(wm.closingBalance)} |`
      }),
      ``,
    )
  }
  if (bankSummaries.length > 0) {
    const bankBreakdowns = consolidated?.ready
      ? (consolidated.breakdown || []).filter((b) => b.role === 'bank_receipt')
      : []
    md.push(
      `## ${nextSec()}国内对公银行入账回单汇总（不重复计入销售报送额）`,
      `| 开户行 | 期间 | 币种 | 贷方笔数 | 贷方入账合计(CNY) | 银行手续费(CNY) |`,
      `|---|---|---|---:|---:|---:|`,
      ...bankSummaries.map((s, idx) => {
        const bd = bankBreakdowns[idx]
        const isUnknownCcy = bd
          ? bd.currency === '币种待核' || bd.bankCreditCny === null
          : (s.currency === 'UNKNOWN' || (!recognizedCurrency(s.currency) && s.currency !== 'MULTI'))
        const ccyLabel = isUnknownCcy ? '币种待核' : (s.currency === 'MULTI' ? 'MULTI' : (recognizedCurrency(s.currency) || 'CNY'))
        const hasNonCny = Object.keys(s.creditTotalsByCurrency || {}).some((c) => c !== 'CNY')
        const creditStr = isUnknownCcy || (bd && bd.bankCreditCny === null)
          ? '待确认币种'
          : bd
            ? bd.bankCreditCny.toFixed(2)
            : (hasNonCny ? '待补汇率' : fmtAmount(s.totalCreditCny || 0n))
        const feeStr = isUnknownCcy || (bd && bd.bankFeeCny === null)
          ? '待确认币种'
          : bd
            ? bd.bankFeeCny.toFixed(2)
            : (hasNonCny ? '待补汇率' : fmtAmount(s.totalBankFeeCny || 0n))
        return `| ${mdText(s.bankLabel || s.platform)} | ${mdText(periodLabel(s))} | ${mdText(ccyLabel)} | ${Number(s.creditRowCount || 0)} | **${creditStr}** | ${feeStr} |`
      }),
      ``,
    )
  }
  if (consolidated?.fundChain) {
    const fc = consolidated.fundChain
    const s1Txt = fmtYuan(fc.stage1PlatformPayoutCny)
    const gapTxt = fmtYuan(fc.stage1to2GapCny)
    const rateTxt = fc.corporateRepatriationRatePct !== null ? `**${fc.corporateRepatriationRatePct}%**` : '待核'
    const s3 = fc.stage3
    const showStage3 = Boolean(s3 && (bankSummaries.length > 0 || s3.stats?.matchedCount > 0 || s3.stats?.candidateCount > 0))
    md.push(
      `## ${nextSec()}三段资金链路交叉核对（平台放款 → 结汇通道 → ${showStage3 ? '国内对公银行实收回单' : '钱包转出至企业户[待核银行回单]'}）`,
      `- ① 销售平台实际放款合计：${s1Txt} ｜ ② 结汇通道平台入账合计：\`¥${fc.stage2WalletInboundCny.toFixed(2)}\`${fc.stage2OtherInboundCny > 0 ? `（另含其他入账 \`¥${fc.stage2OtherInboundCny.toFixed(2)}\`）` : ''} ｜ 一/二段差额（②−①）：${gapTxt}`,
      `- 未匹配平台放款：${fmtYuan(fc.stage1UnmatchedPayoutCny)}（${fc.stage1UnmatchedPayoutCount} 笔）｜未匹配钱包入账：${fmtYuan(fc.stage2UnmatchedInboundCny)}（${fc.stage2UnmatchedInboundCount} 笔）`,
      ...(fc.candidateMatches?.length
        ? [
            `- **参考级候选配对（待补主体/账号/回单确认，不替代法定 5 键核销，共 ${fc.candidateMatches.length} 组）**：${fc.candidateMatches
              .map((m) => mdText(`${m.platform}(${m.period}) ${m.currency} 放款 ${m.payoutAmount.toFixed(2)} → 入账 ${m.inboundAmount.toFixed(2)}（差 ${m.diffAmount.toFixed(2)}）`))
              .join('；')}`,
          ]
        : []),
      `- ③ 钱包显示转出至企业户（待核银行回单）：${fmtYuan(fc.stage3CorporateRepatriatedCny)}（企业户转出占比 ${rateTxt}）｜银行实收：${fmtYuan(fc.bankReceivedCny)}｜私户提现(P0)：${fmtYuan(fc.stage3PersonalWithdrawCny)}｜待核提现(P1)：${fmtYuan(fc.stage3UnverifiedWithdrawCny)}｜境外坐支(P1)：${fmtYuan(fc.directSpendCny)}`,
      ...(showStage3
        ? [
            `- **Stage 3 银行实收离线核销（${mdText(STAGE3_STATUS_ZH[s3.stage3Status] || s3.stage3Status)}）**：法定 5 键银行实收 \`¥${s3.stage3MatchedCny.toFixed(2)}\`（${s3.stats?.matchedCount || 0} 笔）｜银行手续费 \`¥${s3.bankFeeCny.toFixed(2)}\`｜汇损差额 \`¥${s3.fxSpreadCny.toFixed(2)}\`｜汇损/在途未核销差额 \`¥${s3.fxGapOrInTransitCny.toFixed(2)}\`（在途 \`¥${s3.inTransitUnmatchedCny.toFixed(2)}\`）`,
            ...(s3.matchedMatches?.length
              ? [
                  `- **Stage 3 5 键已核销明细**：${s3.matchedMatches
                    .map((m) => mdText(`${m.walletPlatform}→${m.bankLabel}(尾号${m.accountSuffix || '待核'}, ${m.period}) 实收 ${m.currency} ${m.receivedAmount.toFixed(2)} [手续费 ${m.bankFee.toFixed(2)} / 汇差 ${m.fxDiff.toFixed(2)}]`))
                    .join('；')}`,
                ]
              : []),
            ...(s3.stage3CandidateMatches?.length
              ? [
                  `- **Stage 3 参考级候选匹配（待人工核对电子回单确认，不计入法定核销，共 ${s3.stage3CandidateMatches.length} 组）**：${s3.stage3CandidateMatches
                    .map((m) => mdText(`${m.walletPlatform}→${m.bankLabel}(${m.period}) 预期 ${m.expectedAmount.toFixed(2)} vs 实收 ${m.receivedAmount.toFixed(2)} [差 ${m.diffAmount.toFixed(2)}]`))
                    .join('；')}`,
                ]
              : []),
          ]
        : []),
      `- 钱包期间净流：${fmtYuan(fc.signedNetFlowCny)}｜期初余额：${fmtYuan(fc.openingBalanceCny)}｜期末余额：${fmtYuan(fc.closingBalanceCny)}｜手续费：${fmtYuan(fc.walletFeesCny)}`,
      ...(fc.stage3StatusNote ? [`- 口径提示：${mdText(fc.stage3StatusNote)}`] : []),
      ...fc.alerts.map((a) => `- ${mdText(a)}`),
      ``,
    )
  }
  if (consolidated?.ready && salesSummaries.length > 0) {
    md.push(`## ${nextSec()}多表合并人民币折算与申报比对诊断`)
    for (const st of consolidated.reconcile.steps) md.push(`- ${mdText(st)}`)
    for (const w of consolidated.reconcile.warnings) md.push(`- ⚠ **预警**：${mdText(w)}`)
    if (consolidated.cliffAlert) md.push(`- ${mdText(consolidated.cliffAlert)}`)
    md.push(``)
  }
  md.push(`## ${nextSec()}财务待核派活清单（P0 优先: ${p0.length}｜P1 待核: ${p1.length}｜P2 关注: ${p2.length}）`)
  if (!allAnoms.length) md.push(`- ✔ 本次覆盖账单未检出异常交易记录；仍请结合银行入账回单完成对公实收复核。`)
  for (const a of [...p0, ...p1, ...p2].slice(0, 30)) {
    md.push(`- **${mdText(`[${a.severity}] [${a.scope}] ${a.category}`)}**（${mdText(a.refId)}，金额 ${mdText(a.amount)}）`)
    md.push(`  - 下一步待补凭证：${mdText(inferNextAction(a))}`)
  }
  md.push(
    ``,
    `## ${nextSec()}口径边界与核验声明`,
    `1. **四套口径区分**：平台涉税信息报送（国家税务总局公告2025年第15号，由平台按季报送；佣金不直接从报送收入总额扣除）、财务会计收入、增值税申报与企业所得税口径须分别勾稽，切勿直接按银行回款净额申报收入。`,
    `2. **本机初筛边界**：本核对单由本机离线基于已导入账单生成，钱包侧「转出至企业户」仅据收款户名特征归类，须经财务核对银行入账回单（主体、日期、币种、实收金额）后方可确认为已复核。`,
  )
  if (includeResourceAppendix) {
    md.push(
      `3. **扩展参考附页（由导出者勾选附带）**：可在 DSH 侧边栏「财税工作台」按需绑定腾讯 IMA 实战知识库检索现行政策与差额复核 SOP，或结合《跨境电商月结四层口径一表通母表》持续跟进跨期差额与关账底稿。`,
    )
  }
  return md.join('\n')
}

export function renderDiagnosticReportHtml({ summaries, consolidated, coverage, version = VERSION, includeResourceAppendix = false }) {
  const { allAnoms, p0, p1, p2, totalRows, genTime, overallBadge } = buildReportContext(summaries, consolidated)
  const salesSummaries = summaries.filter((s) => s.role !== 'settlement_wallet' && s.role !== 'bank_receipt')
  const walletSummaries = summaries.filter((s) => s.role === 'settlement_wallet')
  const bankSummaries = summaries.filter((s) => s.role === 'bank_receipt')
  const periods = [...new Set(summaries.map(periodLabel))].join(' / ') || '未识别'
  const sourceLabels = (items) => esc(items.map((s) => `${s.platform}·${siteLabel(s)}(${recognizedCurrency(s.currency) || '币种待核'}) [${fileLabel(s)}]`).join('；'))
  let sec = 0
  const nextSec = () => `${CN_NUM[sec++] || sec}、`

  const fc = consolidated?.fundChain
  const fmtY = (n) => n == null ? '待核' : `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const partial = coverage?.complete === false || consolidated?.coverageComplete === false || summaries.some((s) => s.parseDiagnostics?.length)
  const bossSummaryHtml = `<div class="card" style="background:#FAF9F5;border-color:#94A3B8">
    <h2>${nextSec()}本期核对范围与老板一页结论</h2>
    ${partial ? '<p class="pending">覆盖待核：有未解析账单或工作表，以下金额仅涵盖已解析部分。</p>' : ''}
    ${consolidated?.ready === false ? `<p class="pending">人民币折算待核：请确认币种或填写汇率（${esc(consolidated.missingCurrencies.join('、'))}）。</p>` : ''}
    ${consolidated?.dtcGatewayOverlap ? `<p class="pending">${esc(consolidated.dtcGatewayOverlap.warning)}</p>` : ''}
    <div class="cards-grid cards-grid-three">
      <div style="border:1px solid #CBD5E1;padding:10px 12px;background:#FFF">
        <div style="font-size:12px;color:#475569">本期覆盖账期与文件</div>
        <div style="font-size:15px;font-weight:800;margin-top:4px">${esc(periods)}</div>
        <div style="font-size:12px;color:#64748B;margin-top:3px">销售表 ${salesSummaries.length} 份 · 结汇流水 ${walletSummaries.length} 份${bankSummaries.length ? ` · 银行回单 ${bankSummaries.length} 份` : ''} · 共 ${totalRows} 行</div>
      </div>
      <div style="border:1px solid #CBD5E1;padding:10px 12px;background:#FFF">
        <div style="font-size:12px;color:#475569">${consolidated?.ready && salesSummaries.length ? '报送参考净额 / 平台放款' : '钱包入账 / 转出企业户(待核回单)'}</div>
        <div class="num" style="font-size:15px;font-weight:800;text-align:left;margin-top:4px">${consolidated?.ready
          ? (salesSummaries.length
              ? `${fmtY(consolidated.totals.netSalesCny)} / ${consolidated.totals.payoutEvidenceCount > 0 ? fmtY(consolidated.totals.payoutCny) : '待补放款凭证'}`
              : fc ? `${fmtY(fc.stage2WalletInboundCny)} / ${fmtY(fc.stage3CorporateRepatriatedCny)}` : '待补汇率')
          : '待补汇率折算'}</div>
        <div style="font-size:12px;color:#64748B;margin-top:3px">${fc?.bankReceivedCny != null ? `Stage 3 银行实收：${fmtY(fc.bankReceivedCny)}（手续费 ${fmtY(fc.stage3?.bankFeeCny)}）` : fc ? `一/二段差额（②−①）：${fmtY(fc.stage1to2GapCny)}` : '对外交接前请核验对应银行入账回单'}</div>
      </div>
      <div style="border:1px solid ${overallBadge.color};padding:10px 12px;background:${overallBadge.bg}">
        <div style="font-size:12px;color:#475569">待补凭证与优先核查事项</div>
        <div style="font-size:15px;font-weight:800;color:${overallBadge.color};margin-top:4px">P0 ${p0.length} 项 · P1 ${p1.length} 项 · P2 ${p2.length} 项</div>
        <div style="font-size:12px;color:#475569;margin-top:3px">${allAnoms.length ? '注：P0/P1 表示核查优先级，详见下方派活清单' : '本次覆盖明细无异常，仍须核对银行回单实收'}</div>
      </div>
    </div>
    <div style="font-size:12.5px;color:#334155;line-height:1.65">
      <div><b>本次已核对销售账单：</b>${salesSummaries.length ? sourceLabels(salesSummaries) : '无（未导入销售平台账单）'}</div>
      <div><b>本次已核对结汇流水：</b>${walletSummaries.length ? sourceLabels(walletSummaries) : '无（未导入第三方结汇流水）'}</div>
      ${bankSummaries.length ? `<div><b>本次已核对银行回单：</b>${sourceLabels(bankSummaries)}</div>` : ''}
    </div>
  </div>`

  const rowsHtml = salesSummaries
    .map(
      (s) => `<tr>
      <td><b>${esc(s.platform)} · ${esc(siteLabel(s))}</b><br/><span style="color:#64748B;font-size:12px">${esc(fileLabel(s))}</span></td>
      <td>${esc(periodLabel(s))}</td><td><b>${esc(recognizedCurrency(s.currency) || '币种待核')}</b></td>
      <td class="num">${fmtAmount(s.grossSales)}</td>
      <td class="num hi">${fmtAmount(s.taxReportingGrossRef)}</td>
      <td class="num">${fmtAmount(s.customerRefund)}</td>
      <td class="num">${fmtAmount(s.totalFees)}</td>
      <td class="num">${fmtAmount(s.selfRemitTaxNet)}</td>
      <td class="num">${fmtAmount(s.actualPayout)}</td>
      <td>${s.horizontalDiffTotal === 0n ? '<span style="color:#15803D;font-weight:700">✔ 守恒</span>' : '<span style="color:#DC2626;font-weight:700">❌ 失衡</span>'}</td>
    </tr>`,
    )
    .join('')

  const salesCardHtml = salesSummaries.length
    ? `<div class="card"><h2>${nextSec()}各站点原币报送参考与结算项目（精确到 0.01）</h2>
        <div class="table-scroll" tabindex="0" aria-label="销售账单原币表"><table><thead><tr><th>平台·站点</th><th>期间</th><th>币种</th><th class="num">①商品含运费</th><th class="num">★报送参考毛额</th><th class="num">④客户退款</th><th class="num">⑤~⑨平台履约费</th><th class="num">⑩待自报税</th><th class="num">实际放款</th><th>守恒</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      </div>`
    : ''

  const walletTableHtml = walletSummaries.length
    ? `<div class="card"><h2>${nextSec()}结汇收款通道资金拆解（不重复计入销售报送额）</h2>
        <div class="table-scroll" tabindex="0" aria-label="结汇钱包原币表"><table><thead><tr><th>结汇通道</th><th>期间</th><th>币种</th><th class="num">平台入账</th><th class="num">转出企业户(待核回单)</th><th class="num">私户(P0)</th><th class="num">待核提现</th><th class="num">坐支(P1)</th><th class="num">手续费</th><th class="num">期末余额</th></tr></thead><tbody>${walletSummaries
          .map((s) => {
            const wm = s.walletMetrics || {}
            return `<tr>
              <td><b>${esc(s.platform)} · ${esc(siteLabel(s))}</b><br/><span style="color:#64748B;font-size:12px">${esc(fileLabel(s))}</span></td>
              <td>${esc(periodLabel(s))}</td><td><b>${esc(recognizedCurrency(s.currency) || '币种待核')}</b></td>
              <td class="num">${fmtAmount(wm.platformInbound || 0n)}</td>
              <td class="num pending">${fmtAmount(wm.fxWithdrawToCorporate || 0n)}</td>
              <td class="num" style="color:${(wm.fxWithdrawToPersonal || 0n) > 0n ? '#DC2626;font-weight:800' : '#475569'}">${fmtAmount(wm.fxWithdrawToPersonal || 0n)}</td>
              <td class="num" style="color:${(wm.unverifiedWithdraw || 0n) > 0n ? '#B45309;font-weight:700' : '#475569'}">${fmtAmount(wm.unverifiedWithdraw || 0n)}</td>
              <td class="num" style="color:${(wm.directSpend || 0n) > 0n ? '#B45309;font-weight:700' : '#475569'}">${fmtAmount(wm.directSpend || 0n)}</td>
              <td class="num">${fmtAmount(wm.walletFees || 0n)}</td>
              <td class="num">${fmtBalance(wm.closingBalance)}</td>
            </tr>`
          })
          .join('')}</tbody></table></div>
      </div>`
    : ''

  const bankBreakdownsHtml = consolidated?.ready
    ? (consolidated.breakdown || []).filter((b) => b.role === 'bank_receipt')
    : []
  const bankTableHtml = bankSummaries.length
    ? `<div class="card"><h2>${nextSec()}国内对公银行入账回单汇总（不重复计入销售报送额）</h2>
        <div class="table-scroll" tabindex="0" aria-label="银行回单汇总表"><table><thead><tr><th>开户行</th><th>期间</th><th>币种</th><th class="num">贷方入账笔数</th><th class="num">贷方入账合计(CNY)</th><th class="num">银行手续费(CNY)</th></tr></thead><tbody>${bankSummaries
          .map((s, idx) => {
            const bd = bankBreakdownsHtml[idx]
            const isUnknownCcy = bd
              ? bd.currency === '币种待核' || bd.bankCreditCny === null
              : (s.currency === 'UNKNOWN' || (!recognizedCurrency(s.currency) && s.currency !== 'MULTI'))
            const ccyLabel = isUnknownCcy ? '币种待核' : (s.currency === 'MULTI' ? 'MULTI' : (recognizedCurrency(s.currency) || 'CNY'))
            const hasNonCny = Object.keys(s.creditTotalsByCurrency || {}).some((c) => c !== 'CNY')
            const creditStr = isUnknownCcy || (bd && bd.bankCreditCny === null)
              ? '待确认币种'
              : bd
                ? bd.bankCreditCny.toFixed(2)
                : (hasNonCny ? '待补汇率' : fmtAmount(s.totalCreditCny || 0n))
            const feeStr = isUnknownCcy || (bd && bd.bankFeeCny === null)
              ? '待确认币种'
              : bd
                ? bd.bankFeeCny.toFixed(2)
                : (hasNonCny ? '待补汇率' : fmtAmount(s.totalBankFeeCny || 0n))
            return `<tr>
            <td><b>${esc(s.bankLabel || s.platform)}</b><br/><span style="color:#64748B;font-size:12px">${esc(fileLabel(s))}</span></td>
            <td>${esc(periodLabel(s))}</td><td><b>${esc(ccyLabel)}</b></td>
            <td class="num">${Number(s.creditRowCount || 0)}</td>
            <td class="num hi">${esc(creditStr)}</td>
            <td class="num">${esc(feeStr)}</td>
          </tr>`
          }).join('')}</tbody></table></div>
      </div>`
    : ''

  const s3 = fc?.stage3
  const showStage3Html = Boolean(s3 && (bankSummaries.length > 0 || s3.stats?.matchedCount > 0 || s3.stats?.candidateCount > 0))
  const stage3DetailHtml = showStage3Html
    ? `<div style="margin:10px 0 8px;padding:10px 12px;border:1px solid #94A3B8;background:#F8FAFC">
        <div style="font-size:13px;font-weight:800;margin-bottom:6px">Stage 3 国内对公银行回单离线核销（${esc(STAGE3_STATUS_ZH[s3.stage3Status] || s3.stage3Status)}）</div>
        <div class="cards-grid cards-grid-four" style="margin-bottom:8px">
          <div style="border:1px solid #A7BEA0;padding:8px 10px;background:#F0FDF4"><div style="font-size:11.5px;color:#166534">5 键法定银行实收（${Number(s3.stats?.matchedCount || 0)} 笔）</div><div class="num" style="font-size:15px;font-weight:800;color:#15803D;text-align:left;margin-top:3px">${fmtY(s3.stage3MatchedCny)}</div></div>
          <div style="border:1px solid #CBD5E1;padding:8px 10px;background:#FFF"><div style="font-size:11.5px;color:#475569">银行扣收手续费</div><div class="num" style="font-size:15px;font-weight:800;text-align:left;margin-top:3px">${fmtY(s3.bankFeeCny)}</div></div>
          <div style="border:1px solid #CBD5E1;padding:8px 10px;background:#FFF"><div style="font-size:11.5px;color:#475569">结汇汇损差额</div><div class="num" style="font-size:15px;font-weight:800;text-align:left;margin-top:3px">${fmtY(s3.fxSpreadCny)}</div></div>
          <div style="border:1px solid ${s3.fxGapOrInTransitCny > 0 ? '#FDE68A' : '#CBD5E1'};padding:8px 10px;background:${s3.fxGapOrInTransitCny > 0 ? '#FFFBEB' : '#FFF'}"><div style="font-size:11.5px;color:#92400E">汇损/在途未核销差额</div><div class="num" style="font-size:15px;font-weight:800;color:${s3.fxGapOrInTransitCny > 0 ? '#B45309' : '#0F172A'};text-align:left;margin-top:3px">${fmtY(s3.fxGapOrInTransitCny)}</div></div>
        </div>
        ${s3.matchedMatches?.length ? `<div style="font-size:12.5px;color:#166534;margin-bottom:5px"><b>5 键已核销明细：</b>${s3.matchedMatches.map((m) => esc(`${m.walletPlatform}→${m.bankLabel}(尾号${m.accountSuffix || '待核'}, ${m.period}) 实收 ${m.currency} ${m.receivedAmount.toFixed(2)} [手续费 ${m.bankFee.toFixed(2)} / 汇差 ${m.fxDiff.toFixed(2)}]`)).join('；')}</div>` : ''}
        ${s3.stage3CandidateMatches?.length ? `<div style="font-size:12.5px;color:#92400E;padding:7px 10px;background:#FFFBEB;border-left:3px solid #D97706"><b>Stage 3 参考级候选回单（待人工核对电子回单确认，不计入法定 5 键核销 · ${s3.stage3CandidateMatches.length} 组）：</b>${s3.stage3CandidateMatches.map((m) => esc(`${m.walletPlatform}→${m.bankLabel}(${m.period}) 预期 ${m.expectedAmount.toFixed(2)} vs 实收 ${m.receivedAmount.toFixed(2)} [差 ${m.diffAmount.toFixed(2)}]`)).join('；')}</div>` : ''}
      </div>`
    : ''

  const fundChainHtml = fc
    ? `<div class="card"><h2>${nextSec()}三段资金链路交叉核对（平台放款 → 结汇通道 → ${showStage3Html ? '国内对公银行实收回单' : '钱包转出至企业户[待核银行回单]'}）</h2>
        <div class="cards-grid cards-grid-four">
          <div style="border:1px solid #CBD5E1;padding:10px;background:#F8FAFC"><div style="font-size:12px;color:#475569">① 销售平台放款（${fc.stage1PayoutEvidenceCount} 笔凭证）</div><div class="num" style="font-size:16px;font-weight:800;text-align:left;margin-top:4px">${fmtY(fc.stage1PlatformPayoutCny)}</div></div>
          <div style="border:1px solid #CBD5E1;padding:10px;background:#F8FAFC"><div style="font-size:12px;color:#475569">② 结汇通道入账（差额 ${fmtY(fc.stage1to2GapCny)}）${fc.stage2OtherInboundCny > 0 ? ` +其他 ${fmtY(fc.stage2OtherInboundCny)}` : ''}</div><div class="num" style="font-size:16px;font-weight:800;text-align:left;margin-top:4px">${fmtY(fc.stage2WalletInboundCny)}</div></div>
          <div class="pending" style="border:1px solid #FDE68A;padding:10px;background:#FFFBEB"><div style="font-size:12px">③ 转出至企业户·${showStage3Html ? esc(STAGE3_STATUS_ZH[s3.stage3Status] || '银行核销') : '待核回单'}（${fc.corporateRepatriationRatePct !== null ? `${fc.corporateRepatriationRatePct}%` : '待核'}）</div><div class="num" style="font-size:16px;font-weight:800;text-align:left;margin-top:4px">${fmtY(fc.stage3CorporateRepatriatedCny)}</div><div style="font-size:12px">银行实收 ${fmtY(fc.bankReceivedCny)}</div></div>
          <div style="border:1px solid ${fc.stage3PersonalWithdrawCny > 0 ? '#FECACA' : '#CBD5E1'};padding:10px;background:${fc.stage3PersonalWithdrawCny > 0 ? '#FEF2F2' : '#F8FAFC'}"><div style="font-size:12px;color:${fc.stage3PersonalWithdrawCny > 0 ? '#B91C1C' : '#475569'}">私户 P0 / 待核 / 坐支 P1</div><div class="num" style="font-size:14px;font-weight:800;color:${fc.stage3PersonalWithdrawCny > 0 ? '#DC2626' : '#0F172A'};text-align:left;margin-top:4px">¥${fc.stage3PersonalWithdrawCny.toFixed(2)} / ¥${(fc.stage3UnverifiedWithdrawCny || 0).toFixed(2)} / ¥${fc.directSpendCny.toFixed(2)}</div></div>
        </div>
        ${stage3DetailHtml}
        <div style="font-size:13px;margin-bottom:6px">已关联放款 ${fmtY(fc.stage1MatchedPayoutCny)} / 钱包入账 ${fmtY(fc.stage2MatchedInboundCny)} ｜ 未匹配放款 ${fmtY(fc.stage1UnmatchedPayoutCny)}（${fc.stage1UnmatchedPayoutCount} 笔） / 钱包入账 ${fmtY(fc.stage2UnmatchedInboundCny)}（${fc.stage2UnmatchedInboundCount} 笔）</div>
        ${fc.candidateMatches?.length ? `<div style="font-size:12.5px;color:#334155;padding:7px 10px;background:#FFFBEB;border-left:3px solid #D97706;margin-bottom:6px"><b>参考级候选配对（待补主体/账号/回单确认，不替代法定核销 · ${fc.candidateMatches.length} 组）：</b>${fc.candidateMatches.map((m) => esc(`${m.platform}(${m.period}) ${m.currency} ${m.payoutAmount.toFixed(2)}→${m.inboundAmount.toFixed(2)} [差 ${m.diffAmount.toFixed(2)}]`)).join('；')}</div>` : ''}
        <div style="font-size:13px;margin-bottom:6px">期间净流 ${fmtY(fc.signedNetFlowCny)} ｜ 期初余额 ${fmtY(fc.openingBalanceCny)} ｜ 期末余额 ${fmtY(fc.closingBalanceCny)} ｜ 企业户毛转出 ${fmtY(fc.grossCorporateWithdrawCny)} ｜ 已匹配企业户退汇 ${fmtY(fc.matchedCorporateReturnCny)} ｜ 待核退汇 ${fmtY(fc.unmatchedReturnCny)}</div>
        ${fc.stage3StatusNote ? `<div style="font-size:12px;color:#475569;padding:6px 10px;background:#F8FAFC;border-left:3px solid #64748B;margin-bottom:6px">${esc(fc.stage3StatusNote)}</div>` : ''}
        ${fc.alerts.map((a) => `<div style="font-size:13px;margin-top:5px;color:${a.includes('P0') ? '#B91C1C;font-weight:700' : a.includes('P1') || a.includes('差额') || a.includes('未匹配') ? '#B45309;font-weight:700' : '#334155'}">${esc(a)}</div>`).join('')}
      </div>`
    : ''

  const consHtml = consolidated?.ready && salesSummaries.length > 0
    ? `<div class="card"><h2>${nextSec()}多表合并人民币初筛与申报比对</h2>
        <ul>${consolidated.reconcile.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ul>
        ${consolidated.reconcile.warnings.map((w) => `<div style="color:#B45309;font-weight:700;margin-top:6px">⚠ ${esc(w)}</div>`).join('')}
        ${consolidated.cliffAlert ? `<div style="color:#B91C1C;font-weight:800;margin-top:8px;padding:8px 12px;background:#FEF2F2;border-radius:6px">${esc(consolidated.cliffAlert)}</div>` : ''}
      </div>`
    : ''

  const anomHtml = allAnoms.length
    ? [...p0, ...p1, ...p2]
        .slice(0, 30)
        .map((a) => {
          const c = a.severity.startsWith('P0') ? '#DC2626' : a.severity.startsWith('P1') ? '#D97706' : '#2563EB'
          return `<div class="anom-row" style="border-left:4px solid ${c};background:#F8FAFC;padding:10px 14px;margin-bottom:8px;border-radius:6px">
            <div style="font-weight:700;color:${c}">[${esc(a.severity)}] [${esc(a.scope)}] ${esc(a.category)} <span style="color:#475569;font-family:monospace;font-size:12px">(${esc(a.refId)} | ${esc(a.amount)})</span></div>
            <div style="font-size:12.5px;color:#0F172A;margin-top:5px;padding-top:5px;border-top:1px dashed #CBD5E1"><b>下一步待补凭证：</b>${esc(inferNextAction(a))}</div>
          </div>`
        })
        .join('')
    : '<div style="color:#475569">已解析明细未检出异常交易。银行实收请核对对应回单。</div>'

  const anomSectionTitle = `${nextSec()}财务待核派活清单与待补凭证`
  const appendixHtml = includeResourceAppendix
    ? `<br/>3. <b>扩展参考附页（由导出者勾选附带）</b>：可在 DSH 侧边栏「财税工作台」按需绑定腾讯 IMA 实战知识库检索现行政策与差额复核 SOP，或结合《跨境电商月结四层口径一表通母表》持续跟进跨期差额。`
    : ''

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>跨境月结核对单 — dsh-fintax</title>
<style>
  body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:#F1F5F9;color:#0F172A;margin:0;padding:28px}
  .page{max-width:1080px;margin:0 auto;background:#FFF;border:2px solid #0F172A;padding:32px 36px}
  h1{font-size:24px;margin:0 0 8px;letter-spacing:-0.3px} h2{font-size:17px;margin:0 0 12px;border-left:4px solid #0F172A;padding-left:10px}
  .meta{font-size:13px;color:#475569;margin-bottom:18px}
  .banner{padding:14px 18px;background:${overallBadge.bg};color:${overallBadge.color};font-weight:800;font-size:16px;margin-bottom:20px;border:2px solid ${overallBadge.color}}
  .card{border:1.5px solid #CBD5E1;padding:18px 20px;margin-bottom:18px;overflow-wrap:anywhere;min-width:0}
  .cards-grid{display:grid;gap:10px;margin-bottom:12px}.cards-grid-three{grid-template-columns:repeat(3,minmax(0,1fr))}.cards-grid-four{grid-template-columns:repeat(4,minmax(0,1fr))}
  .table-scroll{overflow-x:auto}.table-scroll table{min-width:680px}.pending{color:#B45309;font-weight:700}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{border-bottom:1px solid #E2E8F0;padding:9px 8px;text-align:left}
  th{background:#F8FAFC;color:#0F172A;font-weight:700;border-bottom:2px solid #0F172A} .num{text-align:right;font-family:Consolas,monospace;font-variant-numeric:tabular-nums} .hi{color:#1D4ED8;font-weight:800}
  ul{margin:0;padding-left:18px;font-size:13.5px;line-height:1.65}
  .footer{background:#0F172A;color:#F8FAFC;padding:16px 20px;font-size:13px;line-height:1.65}
  @media(max-width:720px){body{padding:8px}.page{padding:12px}.card{padding:12px}.cards-grid{grid-template-columns:minmax(0,1fr)}}
  @media print{body{background:#FFF;padding:0}.page{border:none;padding:10px}thead{display:table-header-group}tr,.card,.anom-row,.footer{break-inside:avoid;page-break-inside:avoid}}
</style></head><body><div class="page">
  <h1>跨境月结核对单（原始账单本机初筛）</h1>
  <div class="meta">生成工具：DeepSeek Harness 财税工作台 (dsh-fintax v${esc(version)}) ｜ 生成时间：${genTime} ｜ 识别账期：${esc(periods)} ｜ 扫描范围：${summaries.length} 张账单 / 共 ${totalRows} 行明细（本地离线核算，原始账单未上传）</div>
  <div class="banner">核查结论：${esc(overallBadge.level)}（P0 优先核查 ${p0.length} 项 · P1 待补凭证 ${p1.length} 项 · P2 关注 ${p2.length} 项）</div>
  ${bossSummaryHtml}
  ${salesCardHtml}
  ${walletTableHtml}
  ${bankTableHtml}
  ${fundChainHtml}
  ${consHtml}
  <div class="card"><h2>${anomSectionTitle}</h2>${anomHtml}</div>
  <div class="footer">
    <b>口径边界与核验声明：</b><br/>
    1. <b>严禁混用四套口径</b>：平台涉税信息报送（国家税务总局公告2025年第15号，由平台按季报送，佣金不直接从报送收入总额扣除）、财务会计收入、增值税申报与企业所得税口径须分别勾稽，严禁直接按银行回款净额申报收入。<br/>
    2. <b>本机初筛与回单核验边界</b>：本核对单仅基于已导入账单本机离线生成，供内部月结核对与待补凭证跟进；钱包侧「转出至企业户」仅据收款户名特征归类，须财务核对银行入账回单（主体、日期、币种、实收金额）后方可确认为已复核。${appendixHtml}
  </div>
</div></body></html>`
}

export function exportDiagnosticReport({ summaries, consolidated, coverage, exportPath, firstInputPath, version = VERSION, includeResourceAppendix = false }) {
  const target = resolveExportTarget(exportPath, firstInputPath)
  if (!target) return null
  const suffix = extname(target).toLowerCase()
  if (!['.csv', '.md', '.html'].includes(suffix)) {
    throw Object.assign(new Error('仅支持导出 HTML、Markdown 或 CSV 报告'), { code: 'REPORT_FORMAT_UNSUPPORTED' })
  }
  const options = { summaries, consolidated, coverage, version, includeResourceAppendix }
  const content = suffix === '.csv' ? renderAnomaliesCsv(options)
    : suffix === '.md' ? renderDiagnosticReportMd(options) : renderDiagnosticReportHtml(options)
  try {
    writeFileSync(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (err) {
    if (err.code === 'EEXIST') throw Object.assign(new Error('导出目标已存在，请使用新文件名'), { code: 'REPORT_ALREADY_EXISTS' })
    throw Object.assign(new Error('无法写入报告，请检查目标文件夹和权限'), { code: 'REPORT_WRITE_FAILED' })
  }
  return target
}

function csvCell(v, numericColumn) {
  const s = String(v ?? '').replace(/\r\n|[\r\n\u2028\u2029]/g, ' ')
  const numeric = numericColumn && /^[+-]?\d+(?:\.\d+)?$/.test(s)
  const textBeginsLikeFormula = /^[\s\p{Cf}\x00-\x1f]*[=+\-@＝＋－＠]/u.test(s)
  const textBeginsLikeNumber = /^[\s\p{Cf}\x00-\x1f]*\d+$/u.test(s)
  const safe = !numeric && (textBeginsLikeFormula || textBeginsLikeNumber) ? `'${s}` : s
  return /[",]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * 导出全量异常排雷清单 CSV（UTF-8 BOM，Excel 双击不乱码）。
 * 严守商业护城河：仅含待核查异常项、排雷说明与待补凭证指引，绝不包含正式关账母表公式或会计借贷分录。
 */
export function renderAnomaliesCsv({ summaries, coverage, consolidated }) {
  const all = (summaries || []).flatMap((s) =>
    publicAnomalies(s).map((a) => ({
      severity: a.severity || '',
      platform: s.platform || '',
      site: siteLabel(s),
      currency: recognizedCurrency(s.currency) || '币种待核',
      fileName: fileLabel(s),
      category: a.category || '',
      refId: a.refId || '',
      amount: a.amount || '',
      detail: a.detail || '',
      nextAction: inferNextAction(a),
    })),
  )
  const rank = (sev) => (sev.startsWith('P0') ? 0 : sev.startsWith('P1') ? 1 : 2)
  all.sort((a, b) => rank(a.severity) - rank(b.severity))

  const rows = [
    ['核查优先级', '平台', '站点', '币种', '来源文件', '异常类别', '本地核查位置', '异常金额(原币)', '命中原因与说明', '下一步待补凭证'],
    ...all.map((a) => [a.severity, a.platform, a.site, a.currency, a.fileName, a.category, a.refId, a.amount, a.detail, a.nextAction]),
  ]
  const s3 = consolidated?.fundChain?.stage3
  if (s3 && (consolidated?.fundChain?.bankReceiptCount > 0 || s3.stage3CandidateMatches?.length > 0)) {
    for (const m of s3.stage3CandidateMatches || []) {
      rows.push([
        'P2-关注', `${m.walletPlatform}→${m.bankLabel}`, 'CN', m.currency || 'CNY', 'Stage 3 银行回单核销',
        'Stage 3 参考级候选回单（待人工确认）', `尾号 ${m.accountSuffix || '待核'}`, Number(m.diffAmount || 0).toFixed(2),
        m.matchBasis || '参考级候选匹配，不计入法定 5 键核销', '核对国内银行电子回单参考号、本方账号及实收金额后手工确认核销',
      ])
    }
    for (const u of (s3.unmatchedSettlements || []).filter((x) => !x.hasCandidateMatch)) {
      rows.push([
        'P1-高危', u.walletPlatform || '结汇通道', 'CN', 'CNY', 'Stage 3 银行回单核销',
        'Stage 3 结汇在途/未核销回单', `尾号 ${u.accountSuffix || '待核'}`, Number(u.expectedCny || 0).toFixed(2),
        `预期折合 CNY ${Number(u.expectedCny || 0).toFixed(2)} 尚未匹配到国内对公银行回单`, '核查跨月在途结汇或补导对应期间国内对公银行入账回单',
      ])
    }
    if (s3.stage3MatchedCny > 0 || s3.bankFeeCny > 0 || s3.fxSpreadCny !== 0) {
      rows.push([
        '记录', 'Stage 3 核销汇总', 'CN', 'CNY', 'Stage 3 银行回单核销',
        '银行实收/手续费/汇损汇总', `${Number(s3.stats?.matchedCount || 0)} 笔已核销`, Number(s3.stage3MatchedCny || 0).toFixed(2),
        `银行实收 CNY ${Number(s3.stage3MatchedCny || 0).toFixed(2)}｜银行手续费 CNY ${Number(s3.bankFeeCny || 0).toFixed(2)}｜汇损差额 CNY ${Number(s3.fxSpreadCny || 0).toFixed(2)}｜在途/差额 CNY ${Number(s3.fxGapOrInTransitCny || 0).toFixed(2)}`,
        '留存银行电子回单与结汇水单归档备查',
      ])
    }
  }
  if (all.length === 0 && !(s3 && consolidated?.fundChain?.bankReceiptCount > 0)) {
    rows.push(['记录', '', '', '', '', '已解析明细无异常项', '', '', '已解析明细未检出 P0/P1/P2 异常记录', '对照银行入账回单完成实收复核'])
  }
  if (coverage?.complete === false || consolidated?.coverageComplete === false || summaries?.some((s) => s.parseDiagnostics?.length)) {
    rows.push(['待核', '', '', '', '', '账单覆盖不全', '', '', '有未解析账单或工作表', '核对导入清单与文件格式'])
  }
  rows.push(['声明', '', '', '', '', '初筛边界说明', '', '', '本清单用于内部异常交易排雷与待补凭证跟进', ''])
  return '\uFEFF' + rows.map((row, index) => row.map((cell, column) => csvCell(cell, index > 0 && column === 7)).join(',')).join('\r\n') + '\r\n'
}


/**
 * 导出 12 个月滚动财税风控趋势月报（独立可打印 A4 HTML，Braun 工业仪器风排版）。
 * 仅使用 fintax_history.json 中的脱敏月度 KPI 汇总，绝不含原始订单明细、会计分录或私域母表公式。
 */
export function renderRollingTrendReportHtml({ history = [], rolling12m = null, version = VERSION } = {}) {
  const genTime = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const r = rolling12m || {
    snapshotCount: 0, monthCount: 0, missingMonthsCount: 12, zeroSalesMonthsCount: 0, activeEntity: '', entities: [],
    windowStart: '', windowEnd: '', taxYear: '', taxYearMonthCount: 0, taxYearNetSalesCny: 0,
    taxYearCliff75mPct: 0, taxYearCliff75mRemainWan: 7500,
    totalGrossCny: 0, totalRefundCny: 0, totalNetSalesCny: 0, totalFeesCny: 0, totalPayoutCny: 0,
    totalP0: 0, totalP1: 0, cliff75mPct: 0, cliff75mRemainWan: 7500, cliff75mLevel: 'safe',
    threshold5mPct: 0, threshold5mRemainWan: 500, threshold5mLevel: 'safe', monthlySeries: [],
  }
  const series = Array.isArray(r.monthlySeries) ? r.monthlySeries : []
  const maxVal = Math.max(1, ...series.map((m) => Math.max(Math.abs(Number(m.netSalesCny || 0)), Math.abs(Number(m.payoutCny || 0)))))
  const fmtCny = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtWan = (n) => `${(Number(n || 0) / 10000).toFixed(2)} 万`

  // 纯内联 SVG 12 个月净销售 vs 实际回款趋势柱状图（双序列联合量程、零值不画假柱、负净销标零轴下提醒）
  const svgW = 860
  const svgH = 228
  const padL = 62
  const padR = 20
  const padT = 22
  const padB = 38
  const plotW = svgW - padL - padR
  const plotH = svgH - padT - padB
  const barStep = series.length ? plotW / Math.max(series.length, 6) : plotW / 6
  const barsSvg = series.length
    ? series
        .map((m, i) => {
          const cx = padL + i * barStep + barStep * 0.14
          const bw = Math.max(12, Math.min(34, barStep * 0.34))
          const netVal = Number(m.netSalesCny || 0)
          const payVal = Number(m.payoutCny || 0)
          const netH = netVal > 0 ? Math.max(3, (netVal / maxVal) * plotH) : 0
          const payH = payVal > 0 ? Math.max(3, (payVal / maxVal) * plotH) : 0
          const yNet = padT + plotH - netH
          const yPay = padT + plotH - payH
          const lbl = esc(String(m.month || '').slice(2))
          const hasP0 = Number(m.p0Count || 0) > 0
          const negBar = netVal < 0 ? `<rect x="${cx.toFixed(1)}" y="${(padT + plotH + 1).toFixed(1)}" width="${bw.toFixed(1)}" height="8" fill="#DC2626" rx="1"/>` : ''
          return `<g>
            ${netH > 0 ? `<rect x="${cx.toFixed(1)}" y="${yNet.toFixed(1)}" width="${bw.toFixed(1)}" height="${netH.toFixed(1)}" fill="${hasP0 ? '#C54B1E' : '#3F5E39'}" rx="2"/>` : negBar}
            ${payH > 0 ? `<rect x="${(cx + bw + 3).toFixed(1)}" y="${yPay.toFixed(1)}" width="${bw.toFixed(1)}" height="${payH.toFixed(1)}" fill="#8A8E80" rx="2"/>` : ''}
            <text x="${(cx + bw + 1.5).toFixed(1)}" y="${(padT + plotH + 22).toFixed(1)}" text-anchor="middle" font-size="11" fill="#4E514A" font-family="Consolas,monospace">${lbl}</text>
            <text x="${(cx + bw / 2).toFixed(1)}" y="${(Math.min(yNet, padT + plotH) - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#1C1E1B" font-family="Consolas,monospace">${(netVal / 10000).toFixed(1)}w</text>
          </g>`
        })
        .join('')
    : `<text x="${svgW / 2}" y="${svgH / 2}" text-anchor="middle" font-size="13" fill="#6F716A">暂无归档快照，请在财税工作台 Tab 1 点击「归档至 12 个月滚年监控」后导出</text>`

  const clampPct = (p) => Math.max(0, Math.min(100, Number(p || 0)))
  const lvlColor = (lv) => (lv === 'danger' ? '#C54B1E' : lv === 'warn' ? '#B45309' : '#3F5E39')
  const allHist = Array.isArray(history) ? history : []
  const entityHist = r.activeEntity
    ? allHist.filter((h) => (h.entityName || '待认领') === r.activeEntity)
    : allHist
  const inWinHist = r.windowStart && r.windowEnd
    ? entityHist.filter((h) => h.month >= r.windowStart && h.month <= r.windowEnd)
    : entityHist
  const missingMonths = r.missingMonthsCount !== undefined ? Number(r.missingMonthsCount) : Math.max(0, 12 - Number(r.monthCount || 0))
  const zeroMonths = Number(r.zeroSalesMonthsCount || 0)
  const isUnclaimed = r.activeEntity === '待认领'
  const thresholdApplicable = !isUnclaimed && Boolean(r.activeEntity) && r.thresholdApplicable !== false
  const entityScopeText = isUnclaimed ? '归档状态：待认领' : r.activeEntity
    ? `核算主体：${r.activeEntity}`
    : `核算范围：全部主体汇总${r.entities?.length ? `（${r.entities.length} 组）` : ''}`
  const snapsScopeNote = `窗口内 ${inWinHist.length} 份 / 当前筛选共 ${entityHist.length} 份`

  const tyPct = r.taxYearCliff75mPct !== undefined ? Number(r.taxYearCliff75mPct) : Number(r.cliff75mPct || 0)
  const tyRemain = r.taxYearCliff75mRemainWan !== undefined ? Number(r.taxYearCliff75mRemainWan) : Number(r.cliff75mRemainWan || 7500)
  const tyNet = r.taxYearNetSalesCny !== undefined ? Number(r.taxYearNetSalesCny) : Number(r.totalNetSalesCny || 0)
  const tyLvl = tyNet > 75_000_000 ? 'danger' : tyNet >= 55_000_000 ? 'warn' : 'safe'

  const snapsRows = inWinHist
    .map(
      (h) => {
        const ent = h.entityName || '待认领'
        const isUnclaimed = ent === '待认领'
        return `<tr>
          <td class="mono"><b>${esc(h.month)}</b>${h.zeroSalesConfirmed ? '<br/><span style="font-size:11px;color:#4E514A">确认零收入</span>' : ''}</td>
          <td><span style="font-weight:700;color:${isUnclaimed ? '#B45309' : '#1C1E1B'}">${esc(ent)}</span><br/><span style="font-size:11.5px;color:#5A5D55">${esc(h.storeScope || '-')}</span></td>
          <td>${esc(h.label || '-')}</td>
          <td>${esc((h.platforms || []).join(' / ') || '-')}</td>
          <td class="num">${fmtCny(h.grossCny)}</td>
          <td class="num"><b>${fmtCny(h.netSalesCny)}</b></td>
          <td class="num">${fmtCny(h.feesCny)}</td>
          <td class="num">${fmtCny(h.payoutCny)}</td>
          <td class="num" style="color:${h.p0Count > 0 ? '#C54B1E;font-weight:800' : '#3F5E39'}">P0:${Number(h.p0Count || 0)} / P1:${Number(h.p1Count || 0)}</td>
        </tr>`
      },
    )
    .join('')

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>12 个月滚动财税风控趋势月报 — dsh-fintax</title>
<style>
  body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:#E9E9DF;color:#1C1E1B;margin:0;padding:24px}
  .page{max-width:1040px;margin:0 auto;background:#F4F3ED;border:1.5px solid #B8B7AC;padding:28px 34px;box-shadow:0 8px 24px rgba(0,0,0,0.08)}
  .top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1C1E1B;padding-bottom:12px;margin-bottom:18px}
  h1{font-size:22px;margin:0;letter-spacing:-0.2px} .sub{font-size:12.5px;color:#5A5D55;margin-top:4px}
  h2{font-size:15px;margin:0 0 10px;border-left:4px solid #C54B1E;padding-left:9px;text-transform:uppercase;letter-spacing:0.3px}
  .lcd{background:#D5DEC8;border:1.5px solid #9DA78F;padding:16px 20px;margin-bottom:18px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  .kpi-l{font-size:11.5px;color:#3F4A38} .kpi-v{font:700 20px Consolas,monospace;color:#1A2416;margin-top:4px;font-variant-numeric:tabular-nums}
  .card{background:#FAF9F5;border:1px solid #CECDC2;padding:16px 18px;margin-bottom:16px;overflow-wrap:anywhere;min-width:0}
  .top,.lcd{overflow-wrap:anywhere;min-width:0}.table-scroll{overflow-x:auto}.table-scroll table{min-width:650px}
  .gauges{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
  .bar-bg{height:12px;background:#E2E1D7;border-radius:2px;overflow:hidden;margin:8px 0 6px}
  .bar-fill{height:100%}
  table{width:100%;border-collapse:collapse;font-size:12.5px} th,td{border-bottom:1px solid #DFDED4;padding:8px 7px;text-align:left}
  th{background:#ECECE3;border-bottom:1.5px solid #1C1E1B;font-weight:700}
  .num{text-align:right;font-family:Consolas,monospace;font-variant-numeric:tabular-nums} .mono{font-family:Consolas,monospace}
  .footer{background:#1C1E1B;color:#E9E9DF;padding:14px 18px;font-size:12.5px;line-height:1.65}
  @media(max-width:720px){body{padding:8px}.page,.card{padding:12px}.top{display:block}.lcd,.gauges{grid-template-columns:minmax(0,1fr)}}
  @media print{body{background:#FFF;padding:0}.page{border:none;box-shadow:none;padding:10px}thead{display:table-header-group}tr,.card,.lcd,.gauges,.footer{break-inside:avoid;page-break-inside:avoid}}
</style></head><body><div class="page">
  <div class="top">
    <div>
      <h1>跨境财税 12 个月滚动风控趋势月报</h1>
      <div class="sub">${esc(entityScopeText)} ｜ 滚动窗口：${esc(r.windowStart || '—')} 至 ${esc(r.windowEnd || '—')}（已覆盖 ${Number(r.monthCount || 0)}/12 月 · 缺档 ${missingMonths} 月${zeroMonths > 0 ? ` · 确认零收入 ${zeroMonths} 月` : ''} / ${Number(r.snapshotCount || 0)} 份快照）</div>
    </div>
    <div class="mono" style="font-size:12px;color:#5A5D55;text-align:right">DSH / FINTAX v${esc(version)}<br/>${genTime}</div>
  </div>
  <div class="lcd">
    <div><div class="kpi-l">滚年报送参考净额（初筛）</div><div class="kpi-v">${fmtCny(r.totalNetSalesCny)}</div></div>
    <div><div class="kpi-l">滚年报送参考毛额</div><div class="kpi-v">${fmtCny(r.totalGrossCny)}</div></div>
    <div><div class="kpi-l">滚年实际平台放款</div><div class="kpi-v">${fmtCny(r.totalPayoutCny)}</div></div>
    <div><div class="kpi-l">累计待核异常（P0 / P1）</div><div class="kpi-v" style="color:${r.totalP0 > 0 ? '#C54B1E' : '#1A2416'}">${Number(r.totalP0 || 0)} / ${Number(r.totalP1 || 0)}</div></div>
  </div>
  ${thresholdApplicable ? `<div class="gauges">
    <div class="card" style="margin-bottom:0">
      <h2>本纳税年度情景估算（4% 核定假设 · ${esc(r.taxYear || '本年')}）</h2>
      <div class="mono" style="font-size:13px">年度累计：<b>${fmtCny(tyNet)}</b>（${Number(r.taxYearMonthCount || r.monthCount || 0)} 个月）｜占 7,500 万等值 <b>${tyPct.toFixed(2)}%</b>（余 <b>${tyRemain.toFixed(2)} 万</b>）</div>
      <div class="bar-bg"><div class="bar-fill" style="width:${clampPct(tyPct)}%;background:${lvlColor(tyLvl)}"></div></div>
      <div style="font-size:12px;color:#5A5D55">情景说明：7,500 万系按 4% 应税所得率倒推 300 万年度应纳税所得额的情景估算值，仅适用于具备综试区核定资格主体，且小型微利企业仍须满足人数、资产总额等法定条件。</div>
    </div>
    <div class="card" style="margin-bottom:0">
      <h2>滚动登记参考（连续 12 月 / 4 季 · 500 万）</h2>
      <div class="mono" style="font-size:13px">当前进度：<b>${Number(r.threshold5mPct || 0).toFixed(2)}%</b> ｜ 距 500 万参考值剩余 <b>${Number(r.threshold5mRemainWan || 0).toFixed(2)} 万</b></div>
      <div class="bar-bg"><div class="bar-fill" style="width:${clampPct(r.threshold5mPct)}%;background:${lvlColor(r.threshold5mLevel)}"></div></div>
      <div style="font-size:12px;color:#5A5D55">注：同一纳税人连续不超过 12 个月或四个季度累计应征增值税销售额超过 500 万元须按规定登记为一般纳税人；缺档月份未计入，与“确认零收入”已分开标示。</div>
    </div>
  </div>` : `<div class="card">${isUnclaimed ? '此范围的归档待分配核算主体。' : '选择已认领的单一主体后可查看登记参考和核定情景。'}</div>`}
  <div class="card">
    <h2>逐月净销售（深绿 / P0 预警橙）与实际放款（冷灰）趋势图（单位：万元 CNY）</h2>
    <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" style="display:block;max-height:245px">
      <line x1="${padL}" y1="${padT + plotH}" x2="${svgW - padR}" y2="${padT + plotH}" stroke="#9E9D92" stroke-width="1"/>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#9E9D92" stroke-width="1"/>
      <text x="${padL - 8}" y="${padT + 8}" text-anchor="end" font-size="10" fill="#6F716A" font-family="Consolas,monospace">${fmtWan(maxVal)}</text>
      <text x="${padL - 8}" y="${padT + plotH}" text-anchor="end" font-size="10" fill="#6F716A" font-family="Consolas,monospace">0</text>
      ${barsSvg}
    </svg>
  </div>
  <div class="card">
    <h2>滚动窗口内已归档月度脱敏快照台账（${esc(snapsScopeNote)} · 不含原始订单行）</h2>
    <div class="table-scroll" tabindex="0" aria-label="归档快照台账"><table><thead><tr><th>归档月份</th><th>主体 / 店铺</th><th>用户备注</th><th>覆盖通道</th><th class="num">参考毛额</th><th class="num">参考净额</th><th class="num">平台费用</th><th class="num">实际放款</th><th class="num">异常数</th></tr></thead>
    <tbody>${snapsRows || '<tr><td colspan="9" style="text-align:center;color:#6F716A;padding:18px">暂无月度归档记录</td></tr>'}</tbody></table></div>
  </div>
  <div class="footer">
    <b>隐私与初筛声明：</b>本趋势月报由本机月度汇总（<code>~/.config/ima/fintax_history.json</code>，<code>0600</code>）离线生成，绝不包含原始订单明细（注：「主体 / 店铺」与「用户备注」原样显示您自行填写的文本，对外分享前请注意复核）；本报告不构成正式月结关账底稿、税务申报依据或会计凭证。
  </div>
</div></body></html>`
}

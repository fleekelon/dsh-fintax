import {
  CENT_STEP, absBig, cell, evidenceColumns, evidenceKey, finalizeSummary,
  findHeaderRow, fmtAmount, makeEmptySummary, normalizeCurrencyCode,
  parseAmountCell, pickFundEvidence, transactionMonth,
} from './statement.js'

const EXTRAS = {
  account: ['settlement account id', 'wallet account id', 'wallet id', 'account id', '资金账户编号', '结汇账户编号'],
  original_reference: ['original transaction id', 'original payout id', 'related transaction id', '原流水号', '原交易编号', '关联流水号'],
  opening: ['opening balance', 'beginning balance', '期初余额', '期初可用余额'],
  closing: ['closing balance', 'ending balance', '期末余额', '期末可用余额'],
  credit: ['credit', 'credit amount', 'amount in', 'inflow', '入账金额', '收入金额', '贷方金额'],
  debit: ['debit', 'debit amount', 'amount out', 'outflow', '出账金额', '支出金额', '借方金额'],
}
const SITE = { USD: 'US', EUR: 'EU', GBP: 'UK', AUD: 'AU', CAD: 'CA', JPY: 'JP', SGD: 'SG', MYR: 'MY', HKD: 'HK', CNY: 'CN', MXN: 'MX' }
const VOID = /^(?:pending|cancelled|canceled|declined|failure|failed|rejected|voided|void|processing|待处理|失败|取消|撤销|处理中)$/
const RETURN_STATUS = /^(?:returned|reversed|bounced|退汇|已退回|已退汇)$/
const RETURN = /^(?:(?:returned?|reversed?|rejected?) (?:wire|payout|withdrawal|transfer|funds?)|(?:wire|payout|withdrawal|transfer) (?:return|returned|reversal|reversed)|bounce(?:d)?|退汇|退回钱包|提现退回|汇款退回)$/
const FROZEN = /^(?:freeze|frozen|unfreeze|unfrozen|funds? hold|balance hold|account hold|reserve hold|reserve release|冻结|解冻|扣留|风控冻结|账户冻结)$/
const WITHDRAW = /^(?:withdraw(?:al)?(?: to (?:bank|bank account|private account|personal bank account))?|payout|bank payout|bank transfer|bank withdrawal|settlement to bank|transfer to bank|repatriation|提现|结汇提现|结汇|转出至银行|汇款至国内)$/
const FEE_REFUND = /^(?:fee refund|refund fee|fee reversal|退手续费|手续费返还|手续费冲回)$/
const FEE = /^(?:fee|fees|service fee|annual (?:account )?fee|withdrawal fee|fx fee|wire fee|手续费|提现费|账户年费|电汇费)$/
const INTERNAL = /^(?:conversion|fx conversion|currency conversion|currency exchange|manage currencies|internal transfer|self transfer|wallet transfer|内部换汇|换汇|币种互转|账户互转|内部划转)$/
const SPEND = /^(?:card purchase|card payment|issuing|make a payment|pay a recipient|subscription|purchase|余额直付|刷卡|云汇卡|采购款|广告费|物流费|缴税|代付)$/
const DEPOSIT = /^(?:incoming|deposit|global account deposit|platform payout|platform settlement|payment received|平台回款|平台结算|收款|入账)$/
const PLATFORM_MENTION = /\b(?:amazon|amz|tiktok|bytedance|temu|whaleco|aliexpress|shopee|shopify|paypal|stripe|walmart|ebay|etsy|wayfair|shein|mercadolibre|ozon|rakuten)\b|速卖通|虾皮/i
const PLATFORM_INFER_RULES = [
  ['Amazon', /\b(?:amazon|amz)\b/i],
  ['TikTok Shop', /\b(?:tiktok|bytedance)\b/i],
  ['Temu', /\b(?:temu|whaleco)\b/i],
  ['AliExpress', /\baliexpress\b|速卖通/i],
  ['Shopee', /\bshopee\b|虾皮/i],
  ['Shopify', /\bshopify\b/i],
  ['PayPal', /\bpaypal\b/i],
  ['Stripe', /\bstripe\b/i],
]
const PLATFORM_REVERSAL = /^(?:platform (?:payout|settlement) reversal|平台回款冲回|平台结算冲回)$/
const PLATFORM_DEPOSIT = /^(?:global account deposit|platform payout|platform settlement|平台回款|平台结算)$/
const PERSONAL = /\bpersonal\b|private\s*(?:bank|account)|\bindividual\b|自然人|个人(?:账户|银行|储蓄|私户|卡)|法人(?:私户|个人|卡)|私户|私卡/i
const CORPORATE = /co\.?\s*,?\s*ltd|\blimited\b|\bltd\b|\binc\b|\bllc\b|\bcorp(?:oration)?\b|corporate|business\s*account|\bpte\.?\b|\bgmbh\b|\bs\.?a\.?r\.?l\.?\b|\bb\.?v\.?\b|\bplc\b|有限公司|有限责任公司|股份公司|合伙企业|个体工商户|商行|经营部|工作室|贸易行|实业|集团|对公|公户|公司基本户/i

function inferPlatformMention(dest) {
  for (const [label, re] of PLATFORM_INFER_RULES) {
    if (re.test(dest)) return label
  }
  return null
}
const COMMERCIAL_SPEND = /\bsupplier\b|\bvendor\b|\bfactory\b|物流|供应商|采购款|广告|缴税|card purchase|facebook|google ads|yunexpress|freight/i
const TOTAL = /^(?:total|subtotal|summary|grand\s*total|合计|总计|小计|汇总)$/i
const TRANSACTION_TYPES = [WITHDRAW, RETURN, FROZEN, FEE, FEE_REFUND, INTERNAL, SPEND, DEPOSIT, PLATFORM_REVERSAL]

export const normalizeWalletCurrency = normalizeCurrencyCode
const enumValue = (value) => value.toLowerCase().replace(/[\s_-]+/g, ' ').trim()

function note(summary, severity, reason, amount, detail) {
  summary.anomalies.push({ severity, category: summary.platform + ' ' + reason, amount: fmtAmount(amount), detail })
}

function makeBucket(platform, currency, period, fileName, formatInfo, accountKey, entityKey) {
  const summary = makeEmptySummary({
    platform, site: SITE[currency] || 'GLOBAL', currency, period: period || '待确认期间',
    formatLabel: platform + ' 结汇流水 (' + formatInfo + ')', fileName,
  })
  summary.role = 'settlement_wallet'
  summary.accountKey = accountKey
  summary.entityKey = entityKey
  summary.inboundEvidence = []
  summary.walletMetrics = {
    platformInbound: 0n, otherInbound: 0n, returnedInbound: 0n,
    grossCorporateWithdraw: 0n, fxWithdrawToCorporate: 0n, fxWithdrawToPersonal: 0n,
    unverifiedWithdraw: 0n, directSpend: 0n, walletFees: 0n, internalFxStripped: 0n,
    internalFxNet: 0n, internalFxCount: 0, frozenOutflow: 0n, frozenOrReturned: 0n,
    voidExcludedCount: 0, netVerifiedRows: 0, signedNetFlow: 0n, netPendingCount: 0, netUnobservedCount: 0,
    invalidAmountCount: 0, netIncludedFeeRows: 0,
    pendingReturnCount: 0, unmatchedReturnCount: 0, unmatchedReturnAmount: 0n,
    matchedCorporateReturn: 0n, openingBalance: null, closingBalance: null, unrepatriatedNet: null,
  }
  return { summary, withdrawals: new Map(), returns: [], opening: new Set(), closing: new Set() }
}

function netMovement(provider, bucket, { amount, fee, net, type }) {
  const { summary } = bucket
  const wm = summary.walletMetrics
  // Ordinary fees can be exported as a positive cost or a negative wallet debit.
  // Only an explicit fee-reversal type gives a fee credit.
  const feeCost = FEE_REFUND.test(type) ? -absBig(fee) : absBig(fee)
  if (amount === null) return { principal: net, feeCost, movement: net }
  const separate = amount - feeCost
  const included = provider.includedWithdrawalFee && amount < 0n && WITHDRAW.test(type) && amount + feeCost < 0n
  if (net === null) {
    if (included && feeCost !== 0n) {
      wm.netPendingCount++
      wm.netUnobservedCount++
      note(summary, 'P1-高危', '钱包提现缺少净额且手续费口径待核', absBig(amount), '请核对原金额是否已包含手续费。')
      return { principal: amount, feeCost, movement: 0n }
    }
    return { principal: amount, feeCost, movement: separate }
  }
  if (net === separate) {
    wm.netVerifiedRows++
    return { principal: amount, feeCost, movement: net }
  }
  if (included && net === amount) {
    wm.netVerifiedRows++
    wm.netIncludedFeeRows++
    return { principal: amount + feeCost, feeCost, movement: net }
  }

  let diff = absBig(net - separate)
  if (included && absBig(net - amount) < diff) diff = absBig(net - amount)
  wm.netPendingCount++
  if (diff >= CENT_STEP) {
    summary.horizontalDiffTotal += diff
    note(summary, 'P0-阻断', '流水水平守恒异常', diff, '金额、手续费和净变动不一致。请核对原始导出。')
  } else {
    note(summary, 'P1-高危', '钱包手续费口径待核', diff, '净变动与原金额的费用拆分存在未解释差额。')
  }
  return { principal: amount, feeCost, movement: net }
}

function applyRow(provider, bucket, tx) {
  const { summary } = bucket
  const wm = summary.walletMetrics
  const { amount, net, type, dest, status, txKey, originalKey, evidence } = tx
  const isReturn = RETURN.test(type)
  const returnedStatus = RETURN_STATUS.test(status)
  if (VOID.test(status) && !isReturn) {
    wm.voidExcludedCount++
    summary.uncapturedVoidExcluded += absBig(amount ?? net ?? 0n)
    return
  }

  const { principal, movement, feeCost } = netMovement(provider, bucket, tx)
  wm.signedNetFlow += movement
  wm.walletFees += feeCost
  summary.platformCommission += feeCost
  if (INTERNAL.test(type)) {
    wm.internalFxCount++
    wm.internalFxStripped += absBig(principal)
    wm.internalFxNet += movement
    return
  }
  if (FEE.test(type) || FEE_REFUND.test(type)) {
    wm.walletFees -= principal
    summary.platformCommission -= principal
    return
  }
  if (isReturn || (returnedStatus && principal >= 0n)) {
    wm.frozenOrReturned += absBig(principal)
    if (movement > 0n) {
      wm.returnedInbound += movement
      bucket.returns.push({ amount: movement, originalKey })
    } else {
      wm.frozenOutflow += absBig(movement)
      wm.pendingReturnCount++
      wm.unmatchedReturnAmount += absBig(movement)
    }
    note(summary, 'P1-高危', '退汇流水待核', absBig(movement), '请核对原提现及对应退汇回单。')
    return
  }
  if (FROZEN.test(type)) {
    wm.frozenOrReturned += absBig(movement)
    if (movement < 0n) wm.frozenOutflow -= movement
    else wm.otherInbound += movement
    summary.reserveNetChange -= movement
    note(summary, 'P1-高危', '风控冻结或解冻', absBig(movement), '请核对资金扣留或释放凭证。')
    return
  }

  if (principal < 0n && PLATFORM_REVERSAL.test(type)) {
    wm.platformInbound += principal
    summary.inboundEvidence.push({ ...evidence, amount: principal, inferredPlatform: evidence.sourcePlatform || inferPlatformMention(dest) })
    return
  }
  if (principal > 0n) {
    if (evidence.sourcePlatform || PLATFORM_DEPOSIT.test(type) || (DEPOSIT.test(type) && PLATFORM_MENTION.test(dest))) {
      wm.platformInbound += principal
      summary.inboundEvidence.push({ ...evidence, amount: principal, inferredPlatform: evidence.sourcePlatform || inferPlatformMention(dest) })
    } else {
      wm.otherInbound += principal
      note(summary, 'P2-关注', '非标准电商平台入账（来源待核）', principal, '请核对入账来源并确认是否为货款或往来款。')
    }
    return
  }
  if (principal === 0n) return

  const out = -principal
  if (!WITHDRAW.test(type) || COMMERCIAL_SPEND.test(dest)) {
    wm.directSpend += out
    note(summary, 'P1-高危', '结汇余额坐支或非提现出账', out, '请核对资金用途与相关费用凭证。')
    return
  }
  let field = 'unverifiedWithdraw'
  if (PERSONAL.test(dest)) {
    field = 'fxWithdrawToPersonal'
    note(summary, 'P0-阻断', '提现至个人私户（公私混收高危）', out, '提现流向具有私户特征。请核对开户主体和银行回单。')
  } else if (CORPORATE.test(dest)) {
    field = 'fxWithdrawToCorporate'
    wm.grossCorporateWithdraw += out
  } else {
    note(summary, 'P1-高危', '提现收款户性质待核', out, '请核对收款户名、主体和银行回单。')
  }
  wm[field] += out
  summary.actualPayout += out
  if (returnedStatus) {
    wm.pendingReturnCount++
    wm.unmatchedReturnAmount += out
    note(summary, 'P1-高危', '提现状态为已退回', out, '请核对是否有对应的钱包退汇入账。')
  }
  if (txKey) bucket.withdrawals.set(txKey, bucket.withdrawals.has(txKey) ? null : { field, remaining: out, returnedStatus })
}

function finalizeBucket(bucket) {
  const { summary } = bucket
  const wm = summary.walletMetrics
  for (const entry of bucket.returns) {
    const original = summary.period !== '待确认期间' && entry.originalKey && bucket.withdrawals.get(entry.originalKey)
    if (!original || entry.amount > original.remaining) {
      wm.unmatchedReturnCount++
      wm.unmatchedReturnAmount += entry.amount
      continue
    }
    original.remaining -= entry.amount
    wm[original.field] -= entry.amount
    summary.actualPayout -= entry.amount
    if (original.field === 'fxWithdrawToCorporate') wm.matchedCorporateReturn += entry.amount
    if (original.returnedStatus) {
      wm.unmatchedReturnAmount -= entry.amount
      if (original.remaining === 0n) wm.pendingReturnCount--
    }
  }
  if (wm.unmatchedReturnCount) {
    note(summary, 'P1-高危', '未关联原提现的退汇入账', wm.unmatchedReturnAmount, '现有凭证不足以确定退汇应冲减哪笔提现。')
  }
  if (bucket.opening.size === 1) wm.openingBalance = bucket.opening.values().next().value
  if (bucket.closing.size === 1) wm.closingBalance = bucket.closing.values().next().value
  if (wm.netUnobservedCount === 0 && wm.openingBalance !== null && wm.closingBalance !== null &&
      absBig(wm.openingBalance + wm.signedNetFlow - wm.closingBalance) >= CENT_STEP) {
    note(summary, 'P1-高危', '钱包期末余额勾稽待核', absBig(wm.openingBalance + wm.signedNetFlow - wm.closingBalance), '期初余额、期间净流与期末余额不一致。请核对账期覆盖。')
  } else if (wm.closingBalance !== null && wm.netPendingCount === 0) {
    wm.unrepatriatedNet = wm.closingBalance > 0n ? wm.closingBalance : 0n
  }
  if (summary.currency === 'UNKNOWN') {
    note(summary, 'P1-高危', '币种缺失或无法识别', 0n, '请核对结汇流水币种。此表金额暂不能折算。')
  }
  if (wm.internalFxCount) {
    note(summary, 'P2-关注', '同户换汇或内部互转已剥离', wm.internalFxStripped, '已保留本币净变动，不将同户互转计为平台入账或转出。')
  }
  return finalizeSummary(summary)
}

export const WORLDFIRST_ALIASES = {
  date: ['transaction date', 'date', 'value date', '交易时间', '交易日期', '记账日期', '入账时间'],
  tx_id: ['transaction id', 'reference id', 'order no', '交易流水号', '流水号', '交易单号', '业务单号'],
  tx_type: ['transaction type', 'type', 'business type', '交易类型', '业务类型'],
  counterparty: ['counterparty', 'beneficiary', 'payer/payee', 'sender/recipient', '对方户名', '交易对手', '收付款方', '收款账户'],
  desc: ['description', 'remark', 'reference', 'memo', '备注', '摘要', '附言'],
  currency: ['currency', 'ccy', '币种', '货币'],
  amount: ['amount', 'transaction amount', '交易金额', '发生额', '金额'],
  fee: ['fee', 'service fee', 'commission', '手续费', '费用'],
  net: ['net amount', 'net', '净额', '净变动'],
  status: ['status', 'transaction status', '状态', '交易状态'],
}

export const PAYONEER_ALIASES = {
  date: ['date', 'transaction date', 'payment date', '日期', '交易日期'],
  tx_id: ['transaction id', 'payment id', 'id', '交易编号', '交易流水号'],
  tx_type: ['type', 'transaction type', 'category', '类型', '交易类型'],
  desc: ['description', 'details', 'memo', '描述', '交易描述', '备注'],
  counterparty: ['counterparty', 'payer', 'recipient', 'payee', '付款方', '收款方', '对方账户'],
  currency: ['currency', 'ccy', '币种'],
  amount: ['amount', 'credit/debit', 'transaction amount', '金额', '交易金额'],
  fee: ['fee', 'fees', '手续费', '费用'],
  net: ['net amount', 'net', '净额'],
  status: ['status', '状态'],
}

export const AIRWALLEX_ALIASES = {
  date: ['transaction date', 'created at', 'date', 'posted at', '交易日期', '创建时间', '入账日期'],
  tx_id: ['transaction id', 'financial transaction id', 'id', '交易id', '交易编号', '流水号'],
  tx_type: ['financial transaction type', 'transaction type', 'type', '交易类型', '资金类型'],
  counterparty: ['beneficiary', 'counterparty', 'merchant', 'payer', '收款方', '交易对手', '商户名称'],
  desc: ['description', 'reference', 'reason', '备注', '描述', '附言'],
  currency: ['currency', 'wallet currency', '币种'],
  amount: ['amount', 'gross amount', 'transaction amount', '金额', '交易金额'],
  fee: ['fee', 'transaction fee', '手续费', '费用'],
  net: ['net amount', 'net', '净额'],
  status: ['status', '状态'],
}

const PROVIDERS = [
  { label: 'WorldFirst', aliases: WORLDFIRST_ALIASES, includedWithdrawalFee: true, reference: /^wf[-_]/i },
  { label: 'Payoneer', aliases: PAYONEER_ALIASES, includedWithdrawalFee: true, reference: /^(?:py|pyo)[-_]/i },
  { label: 'Airwallex', aliases: AIRWALLEX_ALIASES, includedWithdrawalFee: true, reference: /^awx[-_]/i },
]

function fingerprint(provider, rows, headerIndex, columns, manual) {
  const header = rows[headerIndex]
  const distinctSides = 'credit' in columns && 'debit' in columns && columns.credit !== columns.debit
  const amount = 'amount' in columns || 'net' in columns || distinctSides
  if (!('date' in columns && 'tx_type' in columns && 'currency' in columns && amount)) return 0

  const sample = rows.slice(headerIndex + 1, headerIndex + 26).filter((row) => {
    const type = enumValue(cell(row, columns.tx_type))
    return TRANSACTION_TYPES.some((pattern) => pattern.test(type))
  })
  if (!sample.length) return 0
  if (manual) return 3
  const hasType = (pattern) => sample.some((row) => pattern.test(enumValue(cell(row, columns.tx_type))))
  const providerRef = sample.some((row) => provider.reference.test(cell(row, columns.tx_id)))
  const airwallexColumns = enumValue(cell(header, columns.tx_type)) === 'financial transaction type' ||
    enumValue(cell(header, columns.currency)) === 'wallet currency'
  if (provider.label === 'Airwallex') {
    const officialEnum = sample.some((row) => /^(?:GLOBAL_ACCOUNT_DEPOSIT|RETURNED_PAYOUT)$/.test(cell(row, columns.tx_type)))
    return airwallexColumns ? 3 : providerRef || officialEnum ? 2 : 0
  }
  if (airwallexColumns) return 0
  if (provider.label === 'WorldFirst') return distinctSides ? 3 : providerRef ? 2 : 0
  if (distinctSides) return 0
  if (/^credit\s*\/\s*debit$/i.test(cell(header, columns.amount))) return 3
  if (providerRef) return 2
  return 'status' in columns && 'counterparty' in columns && 'desc' in columns &&
    hasType(/^(?:incoming|withdrawal|annual account fee|manage currencies)$/) ? 1 : 0
}

export function findWalletCandidates(rows, manualPlatform = null) {
  const candidates = []
  for (const provider of PROVIDERS) {
    if (manualPlatform && provider.label !== manualPlatform) continue
    const match = findHeaderRow(rows, { ...provider.aliases, ...EXTRAS }, 4, 45, true)
    if (!match) continue
    const [headerIndex, columns] = match
    const score = fingerprint(provider, rows, headerIndex, columns, Boolean(manualPlatform))
    if (score) candidates.push({ platform: provider.label, provider, headerIndex, columns, score })
  }
  return candidates
}

export function parseWalletSheet(fileName, rows, formatInfo, { provider, headerIndex, columns }) {
  const fundColumns = evidenceColumns(rows[headerIndex])
  const buckets = new Map()
  for (const row of rows.slice(headerIndex + 1)) {
    const date = cell(row, columns.date)
    const type = enumValue(cell(row, columns.tx_type))
    const dest = cell(row, columns.counterparty) + ' ' + cell(row, columns.desc)
    const transactionId = cell(row, columns.tx_id)
    if (!date && !type && !dest.trim()) continue
    if (TOTAL.test(date) || TOTAL.test(type) || TOTAL.test(transactionId)) continue

    const currency = normalizeCurrencyCode(cell(row, columns.currency))
    const accountKey = evidenceKey(cell(row, columns.account))
    const evidence = pickFundEvidence(row, fundColumns, null, date, 0n)
    const period = transactionMonth(date)
    const key = JSON.stringify([currency, period, accountKey, evidence.entityKey])
    if (!buckets.has(key)) buckets.set(key, makeBucket(provider.label, currency, period, fileName, formatInfo, accountKey, evidence.entityKey))
    const bucket = buckets.get(key)
    const { summary } = bucket
    const money = Object.fromEntries(['amount', 'fee', 'net', 'credit', 'debit', 'opening', 'closing'].map(
      (field) => [field, parseAmountCell(cell(row, columns[field]))],
    ))
    let amount = money.amount.value ?? null
    if (money.credit.state === 'value' || money.debit.state === 'value') {
      amount = (money.credit.value ?? 0n) - absBig(money.debit.value ?? 0n)
      if (money.credit.value && money.debit.value) {
        summary.walletMetrics.netPendingCount++
        note(summary, 'P1-高危', '借贷双列同时有金额', absBig(amount), '请核对交易方向与净额。')
      }
    }
    const net = money.net.value ?? null
    summary.rawRowCount++
    if (money.opening.state === 'value') bucket.opening.add(money.opening.value)
    if (money.closing.state === 'value') bucket.closing.add(money.closing.value)
    if (Object.values(money).some((value) => value.state === 'invalid') || (amount === null && net === null)) {
      summary.walletMetrics.invalidAmountCount++
      summary.walletMetrics.netPendingCount++
      summary.walletMetrics.netUnobservedCount++
      note(summary, 'P1-高危', '钱包金额缺失或格式无效', 0n, '请核对金额、费用及余额列。')
      continue
    }
    if (money.fee.value && amount === null) {
      summary.walletMetrics.netPendingCount++
      note(summary, 'P1-高危', '钱包仅提供净额，手续费口径待核', absBig(net), '已采用原表净变动。请核对提现本金与费用。')
    }
    applyRow(provider, bucket, {
      type, dest, status: enumValue(cell(row, columns.status)), amount, net, fee: money.fee.value ?? 0n, evidence,
      txKey: evidenceKey(transactionId), originalKey: evidenceKey(cell(row, columns.original_reference)),
    })
  }
  return [...buckets.values()].map(finalizeBucket)
}


function parseProviderSheets(provider, fileName, sheets, formatInfo, forceMatch) {
  const results = []
  for (const [, rows] of sheets) {
    const candidate = findWalletCandidates(rows, forceMatch ? provider : null).find((item) => item.platform === provider)
    if (candidate) results.push(...parseWalletSheet(fileName, rows, formatInfo, candidate))
  }
  return results.length ? results : null
}

export function parseWorldFirstSheets(fileName, sheets, formatInfo, forceMatch = false) {
  return parseProviderSheets('WorldFirst', fileName, sheets, formatInfo, forceMatch)
}

export function parsePayoneerSheets(fileName, sheets, formatInfo, forceMatch = false) {
  return parseProviderSheets('Payoneer', fileName, sheets, formatInfo, forceMatch)
}

export function parseAirwallexSheets(fileName, sheets, formatInfo, forceMatch = false) {
  return parseProviderSheets('Airwallex', fileName, sheets, formatInfo, forceMatch)
}

// ── v0.8 结汇收款沙盒样本（与 demo:all 平台放款形成完整三段资金链交叉核对） ──
export const V8_DEMO_SAMPLES = {
  worldfirst: [
    'Demo_WorldFirst_USD_202611.csv',
    [
      '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,净额,状态',
      '2026-11-19,WF-20261119-01,平台回款,Amazon.com Services LLC,Amazon US Settlement SET-901,USD,33450.00,0.00,0.00,33450.00,Completed',
      '2026-11-21,WF-20261121-02,结汇提现,深圳星海跨境科技有限公司(对公基本户),货款结汇回流对公户,USD,0.00,26000.00,78.00,-26078.00,Completed',
      '2026-11-22,WF-20261122-03,余额直付,YunExpress Logistics Ltd,头程物流费余额支付,USD,0.00,3200.00,0.00,-3200.00,Completed',
      '2026-11-23,WF-20261123-04,内部换汇,WorldFirst FX Conversion,USD to HKD internal conversion,USD,0.00,1000.00,0.00,-1000.00,Completed',
    ].join('\n'),
  ],
  payoneer: [
    'Demo_Payoneer_USD_202611.csv',
    [
      'Date,Transaction ID,Type,Description,Counterparty,Currency,Amount,Fee,Net,Status',
      '2026-11-20,PY-880101,Incoming,Payment from Temu US Whaleco Inc,Temu US,USD,30000.00,0.00,30000.00,Completed',
      '2026-11-22,PY-880102,Withdrawal,Withdraw to Bank Account,"Shenzhen Xinghai Trading Co., Ltd.",USD,-22000.00,220.00,-22220.00,Completed',
      '2026-11-23,PY-880103,Withdrawal,Withdraw to Personal Bank Account,Zhang San Personal Account,USD,-5000.00,50.00,-5050.00,Completed',
      '2026-11-24,PY-880104,Incoming,Payment from Temu US Pending,Temu US,USD,1200.00,0.00,1200.00,Pending',
    ].join('\n'),
  ],
  airwallex: [
    'Demo_Airwallex_EUR_202611.csv',
    [
      'Transaction Date,Transaction ID,Financial Transaction Type,Beneficiary,Description,Currency,Amount,Fee,Net,Status',
      '2026-11-16,AWX-9901,GLOBAL_ACCOUNT_DEPOSIT,Shopify Payments EU,Shopify Payout PO-EU-1,EUR,11640.00,0.00,11640.00,SETTLED',
      '2026-11-18,AWX-9902,PAYOUT,"Shenzhen Xinghai E-commerce Co., Ltd.",Corporate CNY repatriation,EUR,-7500.00,35.00,-7535.00,SETTLED',
      '2026-11-19,AWX-9903,CARD_PURCHASE,Meta Platforms Ireland,Airwallex Borderless Card Facebook Ads,EUR,-2400.00,0.00,-2400.00,SETTLED',
      '2026-11-20,AWX-9904,FX_CONVERSION,Airwallex Treasury,Internal FX EUR to USD,EUR,-800.00,0.00,-800.00,SETTLED',
    ].join('\n'),
  ],
}

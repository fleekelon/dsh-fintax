// dsh-fintax v0.9.0 Stage 3 国内对公银行回单/流水离线核销器与 demo:v9 全链路脱敏样例生成器。
// 严守 fail-closed 审计铁律：
//   - 法定 matched 必须 5 键精确证据齐全（主体 entityKey + 账号/尾号 + 账期 + 参考号 referenceKey + 币种/金额在银行手续费允许窗口内）且 1 对 1 唯一；
//   - 其余「同账期 + 金额/摘要关键词近似」仅放入独立字段 stage3CandidateMatches（参考级待确认），绝不污染法定 matched；
//   - 识别非对公收款/个人私户入账并触发 P0 阻断；
//   - 纯 Node.js ESM 零第三方依赖，共享 lib/statement.js 的 BigInt 1e-8 算术内核与 HMAC 哈希。

import {
  AMOUNT_SCALE,
  CENT_STEP,
  CORPORATE_ENTITY_RE,
  PERSONAL_ACCOUNT_RE,
  absBig,
  appendDateValidationAnomalies,
  cell,
  evidenceKey,
  extractAccountPrefix,
  extractAccountSuffix,
  extractFullBankAccountDigits,
  findHeaderRow,
  fmtAmount,
  inferPeriod,
  mulScaledBig,
  normalizeBankInstitutionCode,
  normalizeCurrencyCode,
  normalizeEntityName,
  normalizeReferenceToken,
  parseAmountCell,
  toNumber2,
  transactionMonth,
} from './statement_shared.js'

const IS_MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/
const TOTAL_ROW_RE = /^(?:total|subtotal|summary|grand\s*total|合计|总计|小计|汇总|本期合计|本期发生额合计|发生额合计)$/i
const VOID_BANK_STATUS_RE = /^(?:failed|failure|cancelled|canceled|reversed|void|voided|rejected|returned|bounced|declined|失败|交易失败|已撤销|撤销|已冲正|冲正|作废|已退回|已退汇|退汇|退票)$/i
const PENDING_BANK_STATUS_RE = /^(?:pending|processing|in progress|submitted|initiated|queued|unposted|unsettled|on hold|hold|frozen|待处理|处理中|待入账|未入账|待审核|在途|冻结)$/i
const TERMINAL_BANK_STATUS_RE = /^(?:completed|complete|settled|posted|booked|succeeded|success|paid|confirmed|done|finished|成功|已完成|已入账|已记账|已到账|已结清|正常)$/i
const TERMINAL_SETTLEMENT_STATUS_RE = /^(?:completed|complete|settled|paid|succeeded|success|posted|done|finished|closed|已完成|成功|已入账|已打款|已结汇|已到账|已成功)$/i
const VOID_OR_RETURNED_SETTLEMENT_RE = /^(?:returned|reversed|bounced|refunded|failed|failure|cancelled|canceled|rejected|declined|void|voided|已退回|已退汇|退汇|退票|失败|交易失败|取消|已取消|撤销|已撤销|作废)$/i
const DEBIT_REVERSAL_KEYWORD_RE = /冲正|退回|退汇|退票|抹账|撤销|红字|reversal|reversed|return|returned|chargeback|bounce/i

const normStatus = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ').trim()
const isTerminalBankStatus = (v) => {
  const s = normStatus(v)
  return !s || TERMINAL_BANK_STATUS_RE.test(s)
}
const isTerminalSettlementStatus = (v) => {
  const s = normStatus(v)
  return !s || TERMINAL_SETTLEMENT_STATUS_RE.test(s)
}

export const BANK_RECEIPT_ALIASES = {
  tx_date: ['交易日期', '交易时间', '交易日', '入账日期', 'transaction date', 'tx date', 'trans date', 'date'],
  value_date: ['记账日期', '起息日', '起息日期', '入账时间', 'value date', 'posting date', 'booking date', 'book date'],
  credit: ['贷方发生额', '收入金额', '贷方金额', '入账金额', '收款金额', '实收金额', '发生额 贷', '贷方', 'credit', 'credit amount', 'deposit', 'amount in', 'inflow'],
  debit: ['借方发生额', '支出金额', '借方金额', '出账金额', '付款金额', '发生额 借', '借方', 'debit', 'debit amount', 'withdrawal', 'amount out', 'outflow'],
  amount: ['发生额', '交易金额', '金额', 'amount', 'transaction amount'],
  direction: ['借贷标志', '收支方向', '交易方向', '借 贷', 'dr cr', 'direction', 'dc flag'],
  currency: ['币种', '货币', '结算币种', 'currency', 'ccy'],
  fee: ['手续费', '银行手续费', '扣费', '电汇费', '中转行费用', '费用', 'fee', 'bank fee', 'charges', 'commission'],
  counterparty: ['对方户名', '付款人户名', '付款方名称', '汇款人名称', '交易对手', '对方名称', '对方单位', 'counterparty', 'remitter', 'payer', 'sender', 'ordering customer'],
  counterparty_account: ['对方账号', '付款人账号', '汇款账号', 'counterparty account', 'payer account'],
  own_entity: ['本方户名', '账户名称', '收款人户名', '收款户名', '户名', '客户名称', '企业名称', 'own account name', 'account name', 'beneficiary name', 'company name', 'legal entity name'],
  own_account: ['本方账号', '本方银行账号', '账号尾号', '收款账号', '账号', '银行账号', 'own account', 'account number', 'account no', 'account suffix', 'beneficiary account'],
  bank_name: ['开户行', '银行名称', '所属银行', 'bank name', 'bank'],
  summary: ['摘要', '附言', '用途', '交易摘要', '业务摘要', '用途 附言', '备注', 'summary', 'remark', 'memo', 'narrative', 'remittance info', 'purpose'],
  receipt_no: ['银行回单号', '回单号', '电子回单号', '银行流水号', '流水号', '交易流水号', '凭证号', 'receipt no', 'receipt number', 'bank reference', 'transaction ref', 'voucher no'],
  reference: ['关联流水号', '业务参考号', '结汇单号', '提现单号', '平台放款编号', '客户参考号', 'reference no', 'settlement reference', 'payout reference', 'client reference', 'external reference'],
  entity: ['主体编号', '法人实体编号', 'legal entity id', 'entity id'],
  account_id: ['资金账户编号', '收款账户编号', '结汇账户编号', 'account id', 'settlement account id'],
  status: ['状态', '交易状态', '记账状态', 'status'],
}

const BANK_PROFILES = [
  { code: 'CMB', label: '招商银行', re: /招商银行|招行|\bcmb\b|china\s*merchants\s*bank/i },
  { code: 'BOC', label: '中国银行', re: /中国银行|中行|\bboc\b|bank\s*of\s*china/i },
  { code: 'ICBC', label: '中国工商银行', re: /工商银行|工行|\bicbc\b|industrial\s*and\s*commercial\s*bank/i },
  { code: 'CCB', label: '中国建设银行', re: /建设银行|建行|\bccb\b|china\s*construction\s*bank/i },
  { code: 'ABC', label: '中国农业银行', re: /农业银行|农行|\babc\b|agricultural\s*bank/i },
  { code: 'BOCOM', label: '交通银行', re: /交通银行|交行|\bbocom\b|bank\s*of\s*communications/i },
]

const WALLET_KEYWORD_RULES = [
  ['LianLian', /lianlian|连连/i],
  ['PingPong', /pingpong|乒乓/i],
  ['SUNRATE', /sunrate|寻汇/i],
  ['WorldFirst', /worldfirst|万里汇|ant\s*international/i],
  ['Payoneer', /payoneer|派安盈/i],
  ['Airwallex', /airwallex|空中云汇/i],
]

const BANK_STRONG_HEADERS = new Set([
  '贷方发生额', '借方发生额', '银行回单号', '电子回单号', '回单号',
  '本方户名', '本方账号', '本方银行账号', '账号尾号', '银行流水号',
  '记账日期', '涉外收入申报号', 'remittance info', 'ordering customer',
  'bank reference', 'receipt no', 'receipt number', 'own account', 'own account name',
])

const WALLET_EXCLUDE_HEADERS = new Set([
  'financial transaction type', 'wallet currency', '连连流水号', 'lianlian transaction id',
  'pingpong单号', 'pingpong流水号', 'pingpong手续费', 'pingpong id',
  '寻汇流水号', 'sunrate reference', 'sell currency', 'buy currency',
  '实收人民币', '结汇汇率', '提现汇率', '成交汇率', 'balance impact', 'total released amount',
])

const REF_TOKEN_RE = /\b(?:LL|LLG|PPG|PNG|PP|SR|SUN|WF|PY|PYO|AWX|WD|TX|SET|REF|PO)[-_][A-Z0-9][A-Z0-9_-]{2,48}\b/gi

function normHeaderText(v) {
  return String(v ?? '')
    .trim()
    .replace(/^\ufeff/, '')
    .toLowerCase()
    .replace(/[\s_\-/\\（）()[\]【】:：.]+/g, ' ')
    .trim()
}

function detectBankInstitution(text) {
  const s = String(text ?? '')
  for (const p of BANK_PROFILES) {
    if (p.re.test(s)) return { code: p.code, label: p.label }
  }
  return { code: 'GENERIC_BANK', label: '国内对公银行' }
}

function detectWalletKeyword(text) {
  const s = String(text ?? '')
  for (const [label, re] of WALLET_KEYWORD_RULES) {
    if (re.test(s)) return label
  }
  return null
}

function extractPreambleMeta(preambleRows) {
  const meta = { ownEntity: '', ownAccount: '', bankText: '', currency: '', entityId: '', accountId: '' }
  for (const row of preambleRows) {
    const joined = row.filter(Boolean).join(' ')
    if (!joined) continue
    meta.bankText += ' ' + joined
    const entMatch = joined.match(/(?:本方户名|账户名称|户名|客户名称|企业名称)\s*[:：]\s*([^,，;；\t]+)/)
    if (entMatch && !meta.ownEntity) meta.ownEntity = entMatch[1].trim()
    const acctMatch = joined.match(/(?:本方账号|银行账号|账号尾号|账号)\s*[:：]\s*([0-9*\-xX●•\s]{4,36})/)
    if (acctMatch && !meta.ownAccount) meta.ownAccount = acctMatch[1].trim()
    const ccyMatch = joined.match(/(?:币种|货币|currency)\s*[:：]\s*([A-Za-z\u4e00-\u9fa5]{1,12})/i)
    if (ccyMatch && !meta.currency) {
      const norm = normalizeCurrencyCode(ccyMatch[1])
      if (norm !== 'UNKNOWN') meta.currency = norm
    }
    const eidMatch = joined.match(/(?:主体编号|法人实体编号|entity\s*id)\s*[:：]\s*([A-Za-z0-9_-]{2,64})/i)
    if (eidMatch && !meta.entityId) meta.entityId = eidMatch[1].trim()
    const aidMatch = joined.match(/(?:资金账户编号|收款账户编号|account\s*id)\s*[:：]\s*([A-Za-z0-9_-]{2,64})/i)
    if (aidMatch && !meta.accountId) meta.accountId = aidMatch[1].trim()
  }
  return meta
}

export function detectBankReceipt(headers, filename = '', rows = null) {
  let table = null
  if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
    table = rows
  } else if (Array.isArray(headers) && headers.length > 0) {
    table = Array.isArray(headers[0]) ? headers : [headers]
  }
  if (!table || table.length === 0) return null

  const found = findHeaderRow(table, BANK_RECEIPT_ALIASES, 3, 45, true)
    || findHeaderRow(table, BANK_RECEIPT_ALIASES, 4, 45, false)
  if (!found) return null

  const [headerIndex, columns] = found
  const headerRow = table[headerIndex] || []
  const normCells = headerRow.map(normHeaderText)
  if (normCells.some((h) => WALLET_EXCLUDE_HEADERS.has(h))) return null

  const hasDate = 'tx_date' in columns || 'value_date' in columns
  const hasMoney = 'credit' in columns || 'amount' in columns
  if (!hasDate || !hasMoney) return null

  const strongHeaderHits = normCells.filter((h) => BANK_STRONG_HEADERS.has(h)).length
  const fnStr = String(filename ?? '')
  const preambleText = table.slice(0, headerIndex).map((r) => r.join(' ')).join(' ')
  const sampleText = table.slice(headerIndex + 1, headerIndex + 15).map((r) => r.join(' ')).join(' ')
  const bankFileHint = /银行回单|对公回单|银行流水|入账回单|涉外收入|bank[_\s-]?receipt|bank[_\s-]?statement|招商银行|招行|中国银行|中行|工商银行|工行|建设银行|建行|\b(?:cmb|boc|icbc|ccb)\b/i.test(fnStr + ' ' + preambleText)
  const hasCreditDebitPair = 'credit' in columns && 'debit' in columns
  const hasOwnAccountOrEntity = 'own_entity' in columns || 'own_account' in columns
  const hasReceiptOrSummary = 'receipt_no' in columns || 'summary' in columns

  let score = 0
  if (strongHeaderHits >= 2) score += 3
  else if (strongHeaderHits === 1) score += 2
  if (bankFileHint) score += 2
  if (hasCreditDebitPair && hasOwnAccountOrEntity) score += 2
  else if (hasOwnAccountOrEntity && hasReceiptOrSummary) score += 1
  if (score < 3) return null

  const bank = detectBankInstitution(`${fnStr} ${preambleText} ${sampleText}`)
  return {
    detected: true,
    role: 'bank_receipt',
    bank: bank.code,
    bankLabel: bank.label,
    headerIndex,
    columns,
    score,
    confidence: score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low',
  }
}

function extractReferenceKeys(explicitRef, receiptNo, summaryText) {
  const keys = new Set()
  const addToken = (raw) => {
    const norm = normalizeReferenceToken(raw)
    if (!norm) return null
    const k = evidenceKey(norm)
    if (k) keys.add(k)
    return k
  }
  const explicitKey = addToken(explicitRef)
  addToken(receiptNo)
  let summaryTokenCount = 0
  // 严守显式关联号优先铁律：仅当显式关联流水号为空时才允许从摘要提取参考号，杜绝摘要弱提及盖过显式关联号冲突！
  if (!explicitKey) {
    const summaryHits = new Set()
    for (const m of String(summaryText || '').matchAll(REF_TOKEN_RE)) {
      const norm = normalizeReferenceToken(m[0])
      if (norm) {
        summaryHits.add(norm)
        addToken(norm)
      }
    }
    summaryTokenCount = summaryHits.size
  }
  return { keys, explicitKey, ambiguousSummaryRefs: summaryTokenCount > 1 }
}

function bankNote(anomalies, severity, category, amount, detail) {
  anomalies.push({ severity, category, refId: `BANK-${anomalies.length + 1}`, amount: fmtAmount(amount), detail })
}

export function parseBankReceiptRows(rows, ctx = {}) {
  const fileName = String(ctx.fileName || 'bank_receipt.csv')
  const formatInfo = String(ctx.formatInfo || 'csv')
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      role: 'bank_receipt', bank: 'GENERIC_BANK', bankLabel: '国内对公银行', fileName,
      formatLabel: `国内对公银行 对公入账回单 (${formatInfo})`, period: '待确认期间', currency: 'CNY',
      rawRowCount: 0, creditRowCount: 0, debitRowCount: 0, totalCreditCny: 0n, totalBankFeeCny: 0n,
      creditTotalsByCurrency: {}, feeTotalsByCurrency: {}, receipts: [], debitReversals: [], anomalies: [],
    }
  }

  let headerIndex = ctx.headerIndex
  let columns = ctx.columns
  let bankCode = ctx.bank || null
  let bankLabel = ctx.bankLabel || null
  if (headerIndex == null || !columns) {
    const det = detectBankReceipt(null, fileName, rows)
    if (det) {
      headerIndex = det.headerIndex
      columns = det.columns
      bankCode = bankCode || det.bank
      bankLabel = bankLabel || det.bankLabel
    } else {
      const found = findHeaderRow(rows, BANK_RECEIPT_ALIASES, 3, 45, false)
      if (!found) {
        return {
          role: 'bank_receipt', bank: 'GENERIC_BANK', bankLabel: '国内对公银行', fileName,
          formatLabel: `国内对公银行 对公入账回单 (${formatInfo})`, period: '待确认期间', currency: 'CNY',
          rawRowCount: 0, creditRowCount: 0, debitRowCount: 0, totalCreditCny: 0n, totalBankFeeCny: 0n,
          creditTotalsByCurrency: {}, receipts: [], anomalies: [],
        }
      }
      ;[headerIndex, columns] = found
    }
  }

  const preambleRows = rows.slice(0, headerIndex)
  const preambleMeta = extractPreambleMeta(preambleRows)
  const dataRows = rows.slice(headerIndex + 1)
  const sampleText = dataRows.slice(0, 15).map((r) => r.join(' ')).join(' ')
  if (!bankCode || !bankLabel) {
    const inst = detectBankInstitution(`${fileName} ${preambleMeta.bankText} ${sampleText}`)
    bankCode = inst.code
    bankLabel = inst.label
  }

  const receipts = []
  const debitReversals = []
  const anomalies = []
  const dates = []
  const creditByCcy = new Map()
  const feeByCcy = new Map()
  const hasStatusCol = 'status' in columns
  const hasCurrencyCol = 'currency' in columns
  let rawRowCount = 0
  let creditRowCount = 0
  let debitRowCount = 0
  let totalCreditCny = 0n
  let totalBankFeeCny = 0n

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const txDate = cell(row, columns.tx_date)
    const valDate = cell(row, columns.value_date)
    const effectiveDate = valDate || txDate
    const summaryText = cell(row, columns.summary)
    const receiptNo = cell(row, columns.receipt_no)
    const explicitRef = cell(row, columns.reference)
    const counterparty = cell(row, columns.counterparty)
    const status = normStatus(cell(row, columns.status))

    if (!effectiveDate && !summaryText && !receiptNo && !counterparty) continue
    if (TOTAL_ROW_RE.test(txDate) || TOTAL_ROW_RE.test(valDate) || TOTAL_ROW_RE.test(summaryText) || TOTAL_ROW_RE.test(receiptNo)) continue

    const isBlankStatus = hasStatusCol && !status
    const isVoidStatus = Boolean(status) && VOID_BANK_STATUS_RE.test(status)
    const isPendingStatus = Boolean(status) && PENDING_BANK_STATUS_RE.test(status)
    const isTerminal = !isBlankStatus && isTerminalBankStatus(status)

    const creditParsed = parseAmountCell(cell(row, columns.credit))
    const debitParsed = parseAmountCell(cell(row, columns.debit))
    const amountParsed = parseAmountCell(cell(row, columns.amount))
    const feeParsed = parseAmountCell(cell(row, columns.fee))

    if ([creditParsed, debitParsed, amountParsed, feeParsed].some((p) => p.state === 'invalid')) {
      bankNote(anomalies, 'P1-高危', '银行回单金额格式无效', 0n, `第 ${headerIndex + 2 + i} 行金额或手续费格式异常，请核对银行原表。`)
      continue
    }

    let creditAmount = 0n
    let debitAmount = 0n
    if (creditParsed.state === 'value' || debitParsed.state === 'value') {
      creditAmount = creditParsed.value ?? 0n
      debitAmount = debitParsed.value ?? 0n
      if (creditAmount < 0n) { debitAmount += -creditAmount; creditAmount = 0n }
      if (debitAmount < 0n) debitAmount = -debitAmount
    } else if (amountParsed.state === 'value') {
      const dir = cell(row, columns.direction).toLowerCase()
      const isDebitFlag = /^(?:借|支出|出账|d|dr|debit|out)$/i.test(dir)
      const isCreditFlag = /^(?:贷|收入|入账|c|cr|credit|in)$/i.test(dir)
      if (isDebitFlag || (!isCreditFlag && amountParsed.value < 0n)) debitAmount = absBig(amountParsed.value)
      else creditAmount = absBig(amountParsed.value)
    } else {
      continue
    }

    if (creditAmount === 0n && debitAmount === 0n) continue
    rawRowCount++
    if (effectiveDate) dates.push(effectiveDate)

    const explicitCcyCell = hasCurrencyCol ? cell(row, columns.currency) : ''
    const blankCurrency = (hasCurrencyCol && !explicitCcyCell && !preambleMeta.currency) || (!explicitCcyCell && !preambleMeta.currency && !ctx.currency)
    const rawCcy = explicitCcyCell || preambleMeta.currency || ctx.currency || 'CNY'
    const currency = blankCurrency ? 'UNKNOWN' : normalizeCurrencyCode(rawCcy)

    const ownEntity = cell(row, columns.own_entity) || preambleMeta.ownEntity || ctx.ownEntity || ''
    const ownAccount = cell(row, columns.own_account) || preambleMeta.ownAccount || ctx.ownAccount || ''
    const explicitEntity = cell(row, columns.entity) || preambleMeta.entityId || ctx.entityId || ''
    const explicitAccountId = cell(row, columns.account_id) || preambleMeta.accountId || ctx.accountId || ''
    const normEnt = normalizeEntityName(ownEntity)
    const explicitEntityKey = evidenceKey(explicitEntity)
    const legalEntityKey = CORPORATE_ENTITY_RE.test(ownEntity) && !PERSONAL_ACCOUNT_RE.test(ownEntity) && normEnt ? evidenceKey(normEnt) : null
    const entityKey = explicitEntityKey || legalEntityKey
    const accountSuffix = extractAccountSuffix(ownAccount)
    const accountPrefix = extractAccountPrefix(ownAccount)
    const fullBankDigits = extractFullBankAccountDigits(ownAccount)
    const explicitAccountKey = evidenceKey(explicitAccountId)
    const fullBankAccountKey = fullBankDigits ? evidenceKey(fullBankDigits) : null
    const accountKey = explicitAccountKey || fullBankAccountKey || (accountSuffix ? evidenceKey('ACCT_SUFFIX:' + accountSuffix) : null)

    if (creditAmount === 0n) {
      debitRowCount++
      const debitRefs = new Set()
      const addDebitToken = (t) => {
        const norm = normalizeReferenceToken(t)
        if (!norm) return null
        const k = evidenceKey(norm)
        if (k) debitRefs.add(k)
        return k
      }
      const debExplicitKey = addDebitToken(explicitRef)
      const summaryTokenMatches = [...String(summaryText || '').matchAll(REF_TOKEN_RE)]
      for (const m of summaryTokenMatches) addDebitToken(m[0])
      const hasReversalKeyword = DEBIT_REVERSAL_KEYWORD_RE.test(`${summaryText} ${status}`)
      // 保留所有带关联参考号或冲正/退汇特征的借方流出记录，用于在 Stage 3 冻结/冲销对应贷记回单！
      if (debExplicitKey || summaryTokenMatches.length > 0 || hasReversalKeyword) {
        for (const tok of String(summaryText || '').split(/[\s,，;；:：()（）]+/)) {
          if (/^[A-Za-z]{2,6}[-_][A-Za-z0-9_-]{2,48}$/.test(tok)) addDebitToken(tok)
        }
        debitReversals.push({
          period: transactionMonth(effectiveDate),
          currency: normalizeCurrencyCode(explicitCcyCell || preambleMeta.currency || ctx.currency || 'CNY'),
          debitAmount,
          explicitReferenceKey: debExplicitKey,
          referenceKeys: [...debitRefs],
          hasReversalKeyword,
          entityKey,
          explicitEntityKey,
          legalEntityKey,
          accountKey,
          explicitAccountKey,
          fullBankAccountKey,
          accountPrefix,
          accountSuffix,
        })
        if (hasReversalKeyword || debExplicitKey || summaryTokenMatches.length > 0) {
          bankNote(anomalies, 'P1-高危', '银行借方冲正/退票或同号流出记录', debitAmount, `第 ${headerIndex + 2 + i} 行检出关联借方流出或冲正记录，将在 Stage 3 冻结对应贷方回单核销。`)
        }
      }
      continue
    }

    if (blankCurrency || currency === 'UNKNOWN') {
      bankNote(anomalies, 'P1-高危', blankCurrency ? '银行回单币种单元格空白' : '银行回单币种无法识别', creditAmount, '银行入账币种缺失或无法识别，已按 fail-closed 原则阻断自动核销。')
    }
    const feeAmount = feeParsed.state === 'value' ? absBig(feeParsed.value) : 0n

    if (isTerminal && !blankCurrency && currency !== 'UNKNOWN') {
      creditRowCount++
      creditByCcy.set(currency, (creditByCcy.get(currency) ?? 0n) + creditAmount)
      feeByCcy.set(currency, (feeByCcy.get(currency) ?? 0n) + feeAmount)
      if (currency === 'CNY') {
        totalCreditCny += creditAmount
        totalBankFeeCny += feeAmount
      }
    } else if (!isTerminal) {
      const statusReason = isVoidStatus
        ? '银行回单已冲正/撤销/失败（已阻断核销）'
        : isPendingStatus
          ? '银行回单尚未终态入账（Pending/Processing）'
          : isBlankStatus
            ? '银行回单状态单元格空白（待核）'
            : '银行回单状态非明确终态（待核）'
      bankNote(anomalies, 'P1-高危', statusReason, creditAmount, `第 ${headerIndex + 2 + i} 行状态非明确终态入账，未计入实收合计并已阻断 Stage 3 自动核销。`)
    }

    const rowBankName = cell(row, columns.bank_name)
    const rowBank = rowBankName ? detectBankInstitution(rowBankName) : { code: bankCode, label: bankLabel }
    const stdBankCode = normalizeBankInstitutionCode(rowBankName || rowBank.code)

    let accountOwnership = 'unverified'
    let isPersonalOrNonCorporate = false
    if (PERSONAL_ACCOUNT_RE.test(ownEntity) || PERSONAL_ACCOUNT_RE.test(summaryText)) {
      accountOwnership = 'personal'
      isPersonalOrNonCorporate = true
      bankNote(anomalies, 'P0-阻断', '对公回单异常：疑似个人私户或私户转账入账', creditAmount, '检测到本方户名或摘要含个人私户/储蓄卡/对私特征，已阻断对公回单核销。')
    } else if (ownEntity && CORPORATE_ENTITY_RE.test(ownEntity)) {
      accountOwnership = 'corporate'
    } else if (ownEntity) {
      accountOwnership = 'non_corporate'
      isPersonalOrNonCorporate = true
      bankNote(anomalies, 'P0-阻断', '银行回单收款户名非企业对公主体', creditAmount, '本方户名未命中对公企业主体特征（疑似个人名收款），已阻断自动核销。')
    } else {
      bankNote(anomalies, 'P1-高危', '银行回单缺失本方户名', creditAmount, '缺少本方企业户名，无法通过法定 5 键核销，请补齐完整对公电子回单。')
    }

    const refExtracted = extractReferenceKeys(explicitRef, receiptNo, summaryText)
    const explicitReferenceKey = refExtracted.explicitKey
    const primaryRefNorm = normalizeReferenceToken(explicitRef || receiptNo)
    const referenceKey = primaryRefNorm ? evidenceKey(primaryRefNorm) : null
    const receiptRefKey = receiptNo ? evidenceKey(normalizeReferenceToken(receiptNo)) : null
    const walletKeywordHint = detectWalletKeyword(`${counterparty} ${summaryText}`)
    const period = transactionMonth(effectiveDate)

    receipts.push({
      bank: rowBank.code,
      bankCode: stdBankCode,
      bankLabel: rowBank.label,
      period,
      txDate,
      valueDate: valDate || txDate,
      currency,
      blankCurrency,
      creditAmount,
      feeAmount,
      status: isBlankStatus ? 'blank_status_unconfirmed' : (status || 'completed'),
      isTerminal,
      accountOwnership,
      isPersonalOrNonCorporate,
      entityKey: explicitEntityKey || (accountOwnership === 'corporate' ? legalEntityKey : null),
      explicitEntityKey,
      legalEntityKey: accountOwnership === 'corporate' ? legalEntityKey : null,
      accountKey,
      explicitAccountKey,
      fullBankAccountKey,
      accountPrefix,
      accountSuffix,
      referenceKey,
      explicitReferenceKey,
      receiptRefKey,
      referenceKeys: [...refExtracted.keys],
      ambiguousSummaryRefs: refExtracted.ambiguousSummaryRefs,
      walletKeywordHint,
      hasWalletKeyword: Boolean(walletKeywordHint),
    })
  }

  appendDateValidationAnomalies({ anomalies }, dates, null, 'BANK')
  const ccyKeys = [...creditByCcy.keys()]
  const allCurrencyUnknown = ccyKeys.length === 0 && receipts.some((r) => r.blankCurrency || r.currency === 'UNKNOWN')
  const primaryCurrency = ccyKeys.length === 1 ? ccyKeys[0] : ccyKeys.length > 1 ? 'MULTI' : (allCurrencyUnknown ? 'UNKNOWN' : 'CNY')
  return {
    role: 'bank_receipt',
    bank: bankCode,
    bankLabel,
    fileName,
    formatLabel: `${bankLabel} 对公入账回单 (${formatInfo})`,
    period: inferPeriod(dates),
    currency: primaryCurrency,
    rawRowCount,
    creditRowCount,
    debitRowCount,
    totalCreditCny,
    totalBankFeeCny,
    creditTotalsByCurrency: Object.fromEntries(creditByCcy.entries()),
    feeTotalsByCurrency: Object.fromEntries(feeByCcy.entries()),
    receipts,
    debitReversals,
    anomalies,
  }
}

// ════════════════════════════════════════════════════════════════
// Stage 3 离线核销引擎（严守 fail-closed 5 键精确匹配 + 独立参考候选轨）
// ════════════════════════════════════════════════════════════════

function toScaledBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  const parsed = parseAmountCell(value)
  return parsed.state === 'value' ? parsed.value : fallback
}

function normalizeFxRateMap(fxRates) {
  const fxMap = new Map([['CNY', AMOUNT_SCALE]])
  const invalidFxCurrencies = new Set()
  let hasInvalidFxInput = false
  if (fxRates === undefined || fxRates === null) return { fxMap, invalidFxCurrencies, hasInvalidFxInput }
  if (typeof fxRates !== 'object' || Array.isArray(fxRates)) {
    return { fxMap, invalidFxCurrencies, hasInvalidFxInput: true }
  }
  for (const [k, v] of Object.entries(fxRates)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue
    const code = normalizeCurrencyCode(k)
    const label = code !== 'UNKNOWN' ? code : String(k).trim().toUpperCase() || 'UNKNOWN'
    if (typeof v === 'boolean' || typeof v === 'object' || (typeof v === 'number' && !Number.isFinite(v))) {
      invalidFxCurrencies.add(label)
      if (code !== 'UNKNOWN' && code !== 'CNY') fxMap.delete(code)
      continue
    }
    const rawStr = String(v).trim()
    if (/^(?:nan|inf|infinity|-inf|-infinity)$/i.test(rawStr)) {
      invalidFxCurrencies.add(label)
      if (code !== 'UNKNOWN' && code !== 'CNY') fxMap.delete(code)
      continue
    }
    const parsed = parseAmountCell(v)
    if (code === 'UNKNOWN' || parsed.state !== 'value' || parsed.value <= 0n || (code === 'CNY' && parsed.value !== AMOUNT_SCALE)) {
      invalidFxCurrencies.add(label)
      if (code !== 'UNKNOWN' && code !== 'CNY') fxMap.delete(code)
      continue
    }
    fxMap.set(code, parsed.value)
  }
  return { fxMap, invalidFxCurrencies, hasInvalidFxInput }
}

function extractStage2Input(input, fxMap) {
  const items = Array.isArray(input) ? input : (input ? [input] : [])
  const settlements = []
  const unbackedItems = []
  let hasEvidenceMismatch = false
  let hasMissingFx = false
  let hasDiagnostics = false
  const missingFxCurrencies = new Set()

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (Array.isArray(item.parseDiagnostics) && item.parseDiagnostics.length > 0) hasDiagnostics = true
    const isWalletSummary = item.role === 'settlement_wallet' || Boolean(item.walletMetrics) || Array.isArray(item.outboundEvidence)
    if (isWalletSummary) {
      let evCorpPrincipalSum = 0n
      if (Array.isArray(item.outboundEvidence)) {
        for (const ev of item.outboundEvidence) {
          if (!ev) continue
          const pAmt = toScaledBigInt(ev.principalAmount, 0n)
          const evStatusNorm = normStatus(ev.status)
          const isVoidOrRet = Boolean(ev.returned) || VOID_OR_RETURNED_SETTLEMENT_RE.test(evStatusNorm)
          if (ev.returned && pAmt === 0n) continue
          settlements.push(ev)
          if ((ev.destinationType || 'unverified') === 'corporate' && !isVoidOrRet) {
            evCorpPrincipalSum += pAmt
          }
        }
      }
      if (item.walletMetrics && item.walletMetrics.fxWithdrawToCorporate != null) {
        const netCorpOrig = toScaledBigInt(item.walletMetrics.fxWithdrawToCorporate, 0n)
        const diffOrig = netCorpOrig - evCorpPrincipalSum
        if (diffOrig > 0n) {
          const ccy = normalizeCurrencyCode(item.currency)
          const diffCny = toCnyBig(diffOrig, ccy, fxMap)
          if (diffCny === null) {
            hasMissingFx = true
            if (ccy && ccy !== 'UNKNOWN') missingFxCurrencies.add(ccy)
          }
          unbackedItems.push({
            walletPlatform: item.platform || 'UnknownWallet',
            period: item.period || '待确认期间',
            currency: ccy,
            principalAmount: diffOrig,
            expectedCnyBig: diffCny,
          })
        } else if (diffOrig < 0n) {
          hasEvidenceMismatch = true
        }
      }
    } else if ('principalAmount' in item || 'settledCnyAmount' in item || 'destinationType' in item) {
      const pAmt = toScaledBigInt(item.principalAmount, 0n)
      if (!(item.returned && pAmt === 0n)) settlements.push(item)
    }
  }
  return { settlements, unbackedItems, hasEvidenceMismatch, hasMissingFx, missingFxCurrencies, hasDiagnostics }
}

function extractBankReceiptList(input) {
  const items = Array.isArray(input) ? input : (input ? [input] : [])
  const out = []
  const debitReversals = []
  let hasDiagnostics = false
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (Array.isArray(item.parseDiagnostics) && item.parseDiagnostics.length > 0) hasDiagnostics = true
    if (Array.isArray(item.debitReversals)) {
      for (const dr of item.debitReversals) {
        if (dr) debitReversals.push(dr)
      }
    }
    if (Array.isArray(item.receipts)) {
      for (const r of item.receipts) {
        if (r) out.push(r)
      }
    } else if ('debitAmount' in item && !('creditAmount' in item && toScaledBigInt(item.creditAmount, 0n) > 0n)) {
      debitReversals.push(item)
    } else if ('creditAmount' in item) {
      out.push(item)
    }
  }
  return { receipts: out, debitReversals, hasDiagnostics }
}

function hasEntityConflict(s, r) {
  if (s.explicitEntityKey && r.explicitEntityKey && s.explicitEntityKey !== r.explicitEntityKey) return true
  if (s.legalEntityKey && r.legalEntityKey && s.legalEntityKey !== r.legalEntityKey) return true
  if (!s.explicitEntityKey && !s.legalEntityKey && !r.explicitEntityKey && !r.legalEntityKey) {
    if (s.entityKey && r.entityKey && s.entityKey !== r.entityKey) return true
  } else if (s.entityKey && r.entityKey) {
    if (!s.explicitEntityKey && !s.legalEntityKey) {
      if (s.entityKey !== r.explicitEntityKey && s.entityKey !== r.legalEntityKey && s.entityKey !== r.entityKey) return true
    } else if (!r.explicitEntityKey && !r.legalEntityKey) {
      if (r.entityKey !== s.explicitEntityKey && r.entityKey !== s.legalEntityKey && r.entityKey !== s.entityKey) return true
    }
  }
  return false
}

function entitiesStrictlyMatch(s, r) {
  // 冲突优先拒绝：主体编号或法定户名任一维度不同立即拒绝
  if (hasEntityConflict(s, r)) return false
  if (s.explicitEntityKey && r.explicitEntityKey && s.explicitEntityKey === r.explicitEntityKey) return true
  if (s.legalEntityKey && r.legalEntityKey && s.legalEntityKey === r.legalEntityKey) return true
  if (s.entityKey && r.entityKey && s.entityKey === r.entityKey) return true
  return false
}

function hasAccountConflict(s, r) {
  if (s.explicitAccountKey && r.explicitAccountKey && s.explicitAccountKey !== r.explicitAccountKey) return true
  if (s.fullBankAccountKey && r.fullBankAccountKey && s.fullBankAccountKey !== r.fullBankAccountKey) return true
  if (s.accountSuffix && r.accountSuffix && s.accountSuffix !== r.accountSuffix) return true
  const p1 = s.accountPrefix || extractAccountPrefix(s.bankAccount)
  const p2 = r.accountPrefix || extractAccountPrefix(r.ownAccount)
  if (p1 && p2 && !p1.startsWith(p2) && !p2.startsWith(p1)) return true
  const b1 = normalizeBankInstitutionCode(s.bankCode || s.bankHint || s.bank)
  const b2 = normalizeBankInstitutionCode(r.bankCode || r.bank || r.bankLabel)
  if (b1 && b2 && b1 !== b2) return true
  return false
}

function accountsStrictlyMatch(s, r) {
  // 冲突优先拒绝：完整账号、显式账户编号、掩码前缀、账号尾号、标准化开户银行任一共同维度不同立即拒绝
  if (hasAccountConflict(s, r)) return false
  if (s.fullBankAccountKey && r.fullBankAccountKey) return true
  if (s.explicitAccountKey && r.explicitAccountKey) return true
  if (s.accountSuffix && r.accountSuffix) return true
  if (s.accountKey && r.accountKey && s.accountKey === r.accountKey) return true
  return false
}

function expectedAmountForCurrency(s, targetCurrency, fxMap, { allowReportFxFallback = true } = {}) {
  const ccy = normalizeCurrencyCode(targetCurrency)
  if (ccy === 'UNKNOWN') return null
  const srcCcy = normalizeCurrencyCode(s.currency)
  // 目标币严格核对：结汇凭证已知目标币（如 CNY）时，严禁用其他币种（如 USD）回单冒充核销！
  const rawTarget = s.targetCurrency ? normalizeCurrencyCode(s.targetCurrency) : null
  const knownTargetCcy = rawTarget && rawTarget !== 'UNKNOWN'
    ? rawTarget
    : (s.settledCnyAmount != null ? 'CNY' : null)
  if (knownTargetCcy && knownTargetCcy !== ccy) return null

  if (ccy === 'CNY') {
    if (srcCcy === 'CNY') return toScaledBigInt(s.principalAmount, null)
    // 部分退汇跨币种法定匹配门禁：缺少目标结算币、原始结汇汇率或本币实结凭证时，严禁用外部报表估值汇率放行正式 matched！
    if (!allowReportFxFallback && (s.settledCnyAmount == null || !s.fxRate || knownTargetCcy !== 'CNY' || s.cnySettlementUnverified)) {
      return null
    }
    if (s.settledCnyAmount != null) return toScaledBigInt(s.settledCnyAmount, null)
    if (s.expectedCnyAmount != null) return toScaledBigInt(s.expectedCnyAmount, null)
    if (!allowReportFxFallback) return null
    const rate = fxMap.get(srcCcy)
    if (rate) return mulScaledBig(toScaledBigInt(s.principalAmount, 0n), rate)
    return null
  }
  if (srcCcy === ccy) {
    return toScaledBigInt(s.principalAmount, null)
  }
  return null
}

function toCnyBig(amountBig, currency, fxMap) {
  const ccy = normalizeCurrencyCode(currency)
  if (ccy === 'CNY') return amountBig
  const rate = fxMap.get(ccy)
  return rate ? mulScaledBig(amountBig, rate) : null
}

function settlementExpectedCny(s, fxMap) {
  if (s.settledCnyAmount != null) return toScaledBigInt(s.settledCnyAmount, 0n)
  if (s.expectedCnyAmount != null) return toScaledBigInt(s.expectedCnyAmount, 0n)
  const principal = toScaledBigInt(s.principalAmount, 0n)
  return toCnyBig(principal, s.currency, fxMap)
}

function buildReceiptRefSet(r) {
  const set = new Set()
  if (Array.isArray(r.referenceKeys)) {
    for (const k of r.referenceKeys) { if (k) set.add(k) }
  }
  if (r.referenceKey) set.add(r.referenceKey)
  if (r.explicitReferenceKey) set.add(r.explicitReferenceKey)
  return set
}

function formatOrigAmountMap(map) {
  return [...map.entries()]
    .map(([ccy, amt]) => `${ccy} ${toNumber2(amt).toFixed(2)}`)
    .join('、')
}

function addOrigAmount(map, rawCcy, amtBig) {
  const ccy = normalizeCurrencyCode(rawCcy)
  const key = ccy !== 'UNKNOWN' ? ccy : '外币'
  map.set(key, (map.get(key) ?? 0n) + absBig(amtBig))
}

export function reconcileStage3(stage2Settlements, bankReceipts, options = {}) {
  const { fxMap, invalidFxCurrencies, hasInvalidFxInput } = normalizeFxRateMap(options.fxRates)
  const maxBankFeeCnyBig = toScaledBigInt(options.maxBankFeeCny ?? 500, 500n * AMOUNT_SCALE)
  const roundingTolBig = toScaledBigInt(options.roundingToleranceCny ?? 0.05, 5n * CENT_STEP)
  const candTolPct = typeof options.candidateAmountTolerancePct === 'number' && options.candidateAmountTolerancePct >= 0
    ? options.candidateAmountTolerancePct : 0.03

  const extracted = extractStage2Input(stage2Settlements, fxMap)
  const rawSettlements = extracted.settlements
  const unbackedItems = extracted.unbackedItems
  const hasEvidenceMismatch = extracted.hasEvidenceMismatch
  let hasMissingFx = extracted.hasMissingFx || hasInvalidFxInput || invalidFxCurrencies.size > 0
  const missingFxCurrencies = new Set([...extracted.missingFxCurrencies, ...invalidFxCurrencies])
  const bankExtracted = extractBankReceiptList(bankReceipts)
  const rawReceipts = bankExtracted.receipts
  const debitReversals = bankExtracted.debitReversals
  const coverageIncomplete = options.coverageComplete === false || extracted.hasDiagnostics || bankExtracted.hasDiagnostics

  // ── 借方冲正/退票预扫描：同关联号或冲正匹配的贷方回单与结算单一律冻结阻断！ ──
  const reversedRefKeys = new Set()
  for (const dr of debitReversals) {
    if (dr.explicitReferenceKey) reversedRefKeys.add(dr.explicitReferenceKey)
    if (Array.isArray(dr.referenceKeys)) {
      for (const k of dr.referenceKeys) { if (k) reversedRefKeys.add(k) }
    } else if (dr.referenceKey) {
      reversedRefKeys.add(dr.referenceKey)
    }
  }

  const alerts = []
  const eligibleSettlements = []
  let personalWithdrawCount = 0
  let personalWithdrawCnyBig = 0n
  const personalMissingFxOrig = new Map()
  let unverifiedWithdrawCount = 0
  let unverifiedWithdrawCnyBig = 0n
  const unverifiedMissingFxOrig = new Map()
  let nonTerminalCorporateCount = 0
  let voidOrReturnedCorporateCount = 0
  let partialReturnFrozenCount = 0
  let debitReversedSettlementCount = 0

  for (const s of rawSettlements) {
    const destType = s.destinationType || 'unverified'
    const sCcy = normalizeCurrencyCode(s.currency)
    const pAmt = toScaledBigInt(s.principalAmount, 0n)
    const sStatusNorm = normStatus(s.status)
    const isVoidOrReturned = Boolean(s.returned) || VOID_OR_RETURNED_SETTLEMENT_RE.test(sStatusNorm)

    if (destType === 'personal') {
      if (isVoidOrReturned) continue
      personalWithdrawCount++
      const cnyVal = settlementExpectedCny(s, fxMap)
      if (cnyVal === null) {
        hasMissingFx = true
        if (sCcy && sCcy !== 'UNKNOWN') missingFxCurrencies.add(sCcy)
        addOrigAmount(personalMissingFxOrig, s.currency, pAmt)
      } else {
        personalWithdrawCnyBig += cnyVal
      }
      continue
    }
    if (destType !== 'corporate') {
      if (isVoidOrReturned) continue
      unverifiedWithdrawCount++
      const cnyVal = settlementExpectedCny(s, fxMap)
      if (cnyVal === null) {
        hasMissingFx = true
        if (sCcy && sCcy !== 'UNKNOWN') missingFxCurrencies.add(sCcy)
        addOrigAmount(unverifiedMissingFxOrig, s.currency, pAmt)
      } else {
        unverifiedWithdrawCnyBig += cnyVal
      }
      continue
    }
    // 已退回 / 失败 / 取消的对公提现：不计入 Stage 3 应核分母，亦禁止参与核销！
    if (isVoidOrReturned) {
      voidOrReturnedCorporateCount++
      continue
    }
    const isNonTerminal = !isTerminalSettlementStatus(s.status)
    const missingPartialFxProof =
      Boolean(s.partialReturn) && sCcy !== 'CNY' &&
      (s.settledCnyAmount == null || !s.fxRate || normalizeCurrencyCode(s.targetCurrency) !== 'CNY' || s.cnySettlementUnverified)
    const isPartialFrozen = Boolean(s.partialReturnFrozen || s.cnySettlementUnverified || s.hasUnconfirmedReturn || missingPartialFxProof)
    const isReversedByDebit = Boolean(s.referenceKey && reversedRefKeys.has(s.referenceKey))
    if (isNonTerminal) nonTerminalCorporateCount++
    if (isPartialFrozen) partialReturnFrozenCount++
    if (isReversedByDebit) debitReversedSettlementCount++

    const preExpCny = settlementExpectedCny(s, fxMap)
    if (preExpCny === null) {
      hasMissingFx = true
      if (sCcy && sCcy !== 'UNKNOWN') missingFxCurrencies.add(sCcy)
    }

    eligibleSettlements.push({
      ...s,
      _expectedCny: preExpCny,
      _nonTerminal: isNonTerminal,
      _partialReturnFrozen: isPartialFrozen,
      _reversedByBankDebit: isReversedByDebit,
    })
  }

  const eligibleReceipts = []
  const abnormalReceipts = []
  const allReceiptRefSets = []
  const allKnownTargetRefs = new Set()
  for (const s of rawSettlements) {
    if (s?.referenceKey) allKnownTargetRefs.add(s.referenceKey)
  }
  for (const cr of rawReceipts) {
    for (const k of buildReceiptRefSet(cr)) allKnownTargetRefs.add(k)
    if (cr?.receiptRefKey) allKnownTargetRefs.add(cr.receiptRefKey)
  }
  let nonTerminalReceiptCount = 0
  let nonCorporateReceiptCount = 0
  let debitReversedReceiptCount = 0
  let blankCurrencyReceiptCount = 0

  for (const r of rawReceipts) {
    const refSet = buildReceiptRefSet(r)
    const allRefsForReversal = new Set(refSet)
    if (r.receiptRefKey) allRefsForReversal.add(r.receiptRefKey)
    allReceiptRefSets.push(refSet)

    const creditBig = toScaledBigInt(r.creditAmount, 0n)
    const receiptCcy = normalizeCurrencyCode(r.currency || 'CNY')
    const hitByRefReversal = [...allRefsForReversal].some((k) => reversedRefKeys.has(k))
    const hitByKeywordReversal = !hitByRefReversal && debitReversals.some((dr) => {
      if (!dr.hasReversalKeyword) return false
      const debAmt = toScaledBigInt(dr.debitAmount, 0n)
      if (debAmt <= 0n || debAmt !== creditBig) return false
      if (dr.period && r.period && dr.period !== r.period) return false
      if (dr.currency && receiptCcy !== 'UNKNOWN' && dr.currency !== receiptCcy) return false
      if (hasEntityConflict(dr, r) || hasAccountConflict(dr, r)) return false
      // 参考号排他守卫：仅当借方冲正参考号命中「另一笔已知贷方回单或结汇单」（证明冲的是别人）时才豁免；
      // 若携带银行内部孤儿冲正流水号（如 RVS-778899，不匹配任何已知回单/结汇单），继续按同户同额同期保守冻结！
      const drRefs = [...buildReceiptRefSet(dr)]
      const reversesAnotherKnownTarget =
        drRefs.length > 0 &&
        !drRefs.some((k) => allRefsForReversal.has(k)) &&
        drRefs.some((k) => allKnownTargetRefs.has(k))
      if (reversesAnotherKnownTarget) return false
      return true
    })
    if (hitByRefReversal || hitByKeywordReversal) {
      debitReversedReceiptCount++
      if (r.referenceKey) reversedRefKeys.add(r.referenceKey)
      if (r.explicitReferenceKey) reversedRefKeys.add(r.explicitReferenceKey)
      for (const s of eligibleSettlements) {
        if (s.referenceKey && (allRefsForReversal.has(s.referenceKey) || reversedRefKeys.has(s.referenceKey))) {
          if (!s._reversedByBankDebit) {
            s._reversedByBankDebit = true
            debitReversedSettlementCount++
          }
        }
      }
      abnormalReceipts.push({
        bank: r.bank || 'GENERIC_BANK',
        bankLabel: r.bankLabel || '国内银行',
        period: r.period || '待确认期间',
        currency: receiptCcy,
        creditAmount: toNumber2(creditBig),
        accountOwnership: r.accountOwnership || 'corporate',
        accountSuffix: r.accountSuffix || null,
        status: 'debit_reversed',
        reason: '同关联号或同笔金额存在银行借方冲正/退票记录，已冻结该贷方回单并阻断核销',
      })
      continue
    }

    if (r.blankCurrency || receiptCcy === 'UNKNOWN') {
      blankCurrencyReceiptCount++
      abnormalReceipts.push({
        bank: r.bank || 'GENERIC_BANK',
        bankLabel: r.bankLabel || '国内银行',
        period: r.period || '待确认期间',
        currency: 'UNKNOWN',
        creditAmount: toNumber2(creditBig),
        accountOwnership: r.accountOwnership || 'unverified',
        accountSuffix: r.accountSuffix || null,
        status: 'blank_or_unknown_currency',
        reason: '银行回单币种缺失或无法识别，已按 fail-closed 原则阻断核销',
      })
      continue
    }

    if (r.isTerminal === false || !isTerminalBankStatus(r.status)) {
      nonTerminalReceiptCount++
      abnormalReceipts.push({
        bank: r.bank || 'GENERIC_BANK',
        bankLabel: r.bankLabel || '国内银行',
        period: r.period || '待确认期间',
        currency: receiptCcy,
        creditAmount: toNumber2(creditBig),
        accountOwnership: r.accountOwnership || 'unverified',
        accountSuffix: r.accountSuffix || null,
        status: r.status || 'non_terminal',
        reason: '银行回单状态非终态或状态空白（Pending/Processing/Reversed/空白），已按终态门禁阻断核销',
      })
      continue
    }
    if (r.isPersonalOrNonCorporate || r.accountOwnership === 'personal' || r.accountOwnership === 'non_corporate') {
      nonCorporateReceiptCount++
      abnormalReceipts.push({
        bank: r.bank || 'GENERIC_BANK',
        bankLabel: r.bankLabel || '国内银行',
        period: r.period || '待确认期间',
        currency: receiptCcy,
        creditAmount: toNumber2(creditBig),
        accountOwnership: r.accountOwnership || 'non_corporate',
        accountSuffix: r.accountSuffix || null,
        reason: '非对公企业户或疑似个人私户入账，已按 P0 红线阻断核销',
      })
      continue
    }
    if (receiptCcy !== 'CNY' && !fxMap.get(receiptCcy)) {
      hasMissingFx = true
      missingFxCurrencies.add(receiptCcy)
    }
    if (r.accountOwnership === 'corporate') {
      eligibleReceipts.push({ ...r, _refSet: refSet })
    } else {
      // 缺失本方户名的回单不可进入法定 5 键匹配，仅可保留为未匹配待核（或参考候选）
      eligibleReceipts.push({ ...r, _missingEntity: true, _refSet: refSet })
    }
  }

  if (hasInvalidFxInput || invalidFxCurrencies.size > 0) {
    const badList = [...invalidFxCurrencies].join('、') || 'fxRates'
    alerts.push(`【P0-阻断 · 外币汇率参数非法】传入的外币汇率（${badList}）存在 <=0、NaN 或格式无效，已按 fail-closed 原则阻断自动核销并暂停对应外币折算，请修正为有效正数汇率。`)
  }
  if (hasMissingFx || missingFxCurrencies.size > 0) {
    const missList = [...missingFxCurrencies].join('、') || '外币'
    alerts.push(`【P1-高危 · 缺失外币汇率】检出外币流水（${missList}）缺少有效人民币折算汇率，已暂停对应外币折算并阻断自动核销，请补充有效汇率后重算。`)
  }
  if (debitReversedReceiptCount > 0 || debitReversedSettlementCount > 0) {
    alerts.push(`【P0-阻断 · 银行借方冲正/退票拦截】检出银行借方冲正或同关联号借记流出记录（涉及 ${Math.max(debitReversedReceiptCount, debitReversedSettlementCount)} 笔），已冻结对应贷记回单并阻断 Stage 3 正式核销！`)
  }
  if (personalWithdrawCount > 0) {
    const personalAmtDesc = personalMissingFxOrig.size > 0
      ? (personalWithdrawCnyBig > 0n
          ? `已折算部分 ¥${toNumber2(personalWithdrawCnyBig).toFixed(2)}，另有原币 ${formatOrigAmountMap(personalMissingFxOrig)} 缺少有效汇率未折算待补汇率`
          : `原币 ${formatOrigAmountMap(personalMissingFxOrig)} 缺少有效汇率暂未折算人民币，待补汇率`)
      : `折合 ¥${toNumber2(personalWithdrawCnyBig).toFixed(2)}`
    alerts.push(`【P0-阻断 · 个人私户提现】Stage 2 存在 ${personalWithdrawCount} 笔提现至个人私户（${personalAmtDesc}），严禁计入对公回单核销，请优先核查公私混收风险。`)
  }
  if (nonCorporateReceiptCount > 0) {
    alerts.push(`【P0-阻断 · 非对公银行回单】检出 ${nonCorporateReceiptCount} 笔非对公/疑似个人私户银行入账回单，已阻断自动核销。`)
  }
  if (voidOrReturnedCorporateCount > 0) {
    alerts.push(`【P1-高危 · 已退回/失败/取消提现已剔除】检出 ${voidOrReturnedCorporateCount} 笔状态为 Returned/Failed/Cancelled 的提现，已从 Stage 3 应核分母剔除并禁止核销。`)
  }
  if (nonTerminalCorporateCount > 0) {
    alerts.push(`【P1-高危 · 非终态提现拦截】检出 ${nonTerminalCorporateCount} 笔非终态或状态空白提现（Pending/Processing/空白等），已按交易终态门禁阻断 Stage 3 正式核销。`)
  }
  if (nonTerminalReceiptCount > 0) {
    alerts.push(`【P1-高危 · 非终态银行回单拦截】检出 ${nonTerminalReceiptCount} 笔非终态或状态空白银行回单（Pending/Processing/Reversed/空白等），已按交易终态门禁阻断 Stage 3 正式核销。`)
  }
  if (blankCurrencyReceiptCount > 0) {
    alerts.push(`【P1-高危 · 银行回单币种缺失】检出 ${blankCurrencyReceiptCount} 笔币种空白或无法识别的银行回单，已阻断 Stage 3 自动核销。`)
  }
  if (partialReturnFrozenCount > 0) {
    alerts.push(`【P1-高危 · 部分退汇冻结核销】检出 ${partialReturnFrozenCount} 笔部分退汇（或关联未完成退汇/缺少实结汇率凭证）的对公提现，已冻结 Stage 3 正式自动核销，请人工核对银行回单与退汇水单。`)
  }
  if (unverifiedWithdrawCount > 0) {
    const unvAmtDesc = unverifiedMissingFxOrig.size > 0
      ? (unverifiedWithdrawCnyBig > 0n
          ? `已折算部分 ¥${toNumber2(unverifiedWithdrawCnyBig).toFixed(2)}，另有原币 ${formatOrigAmountMap(unverifiedMissingFxOrig)} 缺少有效汇率未折算待补汇率`
          : `原币 ${formatOrigAmountMap(unverifiedMissingFxOrig)} 缺少有效汇率暂未折算人民币，待补汇率`)
      : `折合 ¥${toNumber2(unverifiedWithdrawCnyBig).toFixed(2)}`
    alerts.push(`【P1-高危 · 收款户性质待核】Stage 2 存在 ${unverifiedWithdrawCount} 笔收款户性质不明提现（${unvAmtDesc}），未纳入对公自动核销。`)
  }
  if (hasEvidenceMismatch) {
    alerts.push('【P1-高危 · 提款明细与钱包净对公总额不平】逐笔对公提款明细合计与结汇通道净对公总额不一致，已禁止全局判定为全部核销，请逐笔复核退汇与流水完整性。')
  }
  if (coverageIncomplete) {
    alerts.push('【P1-高危 · 账单覆盖不完整】同批存在未解析文件、异常工作表或待核诊断项（coverageComplete=false），已禁止将全局 Stage 3 判定为全部核销（matched）。')
  }

  // ── 预检：参考号全局唯一性门禁（先查重复参考号，再做金额/手续费筛选！） ──
  const settlementRefCounts = new Map()
  for (const s of eligibleSettlements) {
    if (!s.referenceKey) continue
    settlementRefCounts.set(s.referenceKey, (settlementRefCounts.get(s.referenceKey) || 0) + 1)
  }
  const receiptRefCounts = new Map()
  for (const refSet of allReceiptRefSets) {
    for (const k of refSet) {
      receiptRefCounts.set(k, (receiptRefCounts.get(k) || 0) + 1)
    }
  }
  const dupRefSettlements = new Set()
  let hasDuplicateRefConflict = false
  for (let si = 0; si < eligibleSettlements.length; si++) {
    const refKey = eligibleSettlements[si].referenceKey
    if (!refKey) continue
    if ((settlementRefCounts.get(refKey) || 0) > 1 || (receiptRefCounts.get(refKey) || 0) > 1) {
      dupRefSettlements.add(si)
      hasDuplicateRefConflict = true
    }
  }

  // ── Track 1：法定 fail-closed 5 键精确匹配 ───────────────────
  const sCandidates = new Map()
  const rCandidates = new Map()
  let feeOverCapCount = 0
  let unverifiedShortfallCount = 0
  let unverifiedShortfallCnyBig = 0n
  const unverifiedBySi = new Map()
  const feeOverCapBySi = new Set()

  for (let si = 0; si < eligibleSettlements.length; si++) {
    const s = eligibleSettlements[si]
    if (s._nonTerminal || s._partialReturnFrozen || s._reversedByBankDebit || dupRefSettlements.has(si)) continue
    if (!(s.entityKey || s.explicitEntityKey || s.legalEntityKey) || !s.referenceKey || !IS_MONTH_RE.test(s.period || '')) continue
    for (let ri = 0; ri < eligibleReceipts.length; ri++) {
      const r = eligibleReceipts[ri]
      if (r._missingEntity || r.blankCurrency || r.ambiguousSummaryRefs || !(r.entityKey || r.explicitEntityKey || r.legalEntityKey) || !IS_MONTH_RE.test(r.period || '')) continue
      // Key 1: Entity（冲突优先拒绝）
      if (!entitiesStrictlyMatch(s, r)) continue
      // Key 2: Account / Prefix / Suffix / Bank Institution（冲突优先拒绝）
      if (!accountsStrictlyMatch(s, r)) continue
      // Key 3: Period
      if (s.period !== r.period) continue
      // Key 4: Reference（显式关联号存在且不一致时直接判冲突排除，绝不允许摘要弱提及绕过！）
      if (s.referenceKey && r.explicitReferenceKey && s.referenceKey !== r.explicitReferenceKey) continue
      if (!r._refSet.has(s.referenceKey)) continue
      // Key 5: Target Currency & Amount & Declared Bank Fee（严格按汇率折算人民币核验，部分退汇禁外部汇率兜底！）
      const receiptCcy = normalizeCurrencyCode(r.currency || 'CNY')
      const expectedAmt = expectedAmountForCurrency(s, receiptCcy, fxMap, { allowReportFxFallback: !s.partialReturn })
      if (expectedAmt === null || expectedAmt <= 0n) continue
      const creditAmt = toScaledBigInt(r.creditAmount, 0n)
      if (creditAmt <= 0n) continue
      const feeAmt = toScaledBigInt(r.feeAmount, 0n)
      const fxRate = receiptCcy === 'CNY' ? AMOUNT_SCALE : fxMap.get(receiptCcy)
      if (!fxRate || fxRate <= 0n) {
        hasMissingFx = true
        if (receiptCcy && receiptCcy !== 'UNKNOWN') missingFxCurrencies.add(receiptCcy)
        continue
      }

      const shortfall = expectedAmt - creditAmt
      const shortfallCnyExact = shortfall * fxRate
      const feeCnyExact = feeAmt * fxRate
      const tolCnyExact = roundingTolBig * AMOUNT_SCALE
      const maxFeeCnyExact = maxBankFeeCnyBig * AMOUNT_SCALE

      // 1) 申明银行手续费超 maxBankFeeCny 直接拒配！
      if (feeCnyExact > maxFeeCnyExact) {
        feeOverCapCount++
        feeOverCapBySi.add(si)
        continue
      }
      // 2) 实收溢收超过人民币舍入容差（精确按外币汇率折算）拒配！
      if (shortfallCnyExact < -tolCnyExact) continue
      // 3) 短收超过银行手续费上限或超过一半本金拒配
      if (shortfallCnyExact > maxFeeCnyExact || shortfall > expectedAmt / 2n) continue
      // 4) 核验未证实差额：短收超出「回单明列银行手续费 + 容差」时，严禁把未证实差额伪记为 bankFeeCny！
      const unverifiedExact = shortfallCnyExact - feeCnyExact
      if (unverifiedExact > tolCnyExact) {
        const unverifiedCny = (unverifiedExact + AMOUNT_SCALE / 2n) / AMOUNT_SCALE
        unverifiedShortfallCount++
        unverifiedShortfallCnyBig += unverifiedCny
        unverifiedBySi.set(si, { ri, unverifiedCny, shortfall, feeAmt })
        continue
      }
      // 5) 防止明列手续费与短收金额双向自相矛盾（如短收 > 容差但明列费用又远大于短收）
      if (shortfallCnyExact > tolCnyExact && feeCnyExact > shortfallCnyExact + tolCnyExact) continue

      if (!sCandidates.has(si)) sCandidates.set(si, [])
      if (!rCandidates.has(ri)) rCandidates.set(ri, [])
      sCandidates.get(si).push({ ri, expectedAmt, creditAmt, feeAmt, shortfall, receiptCcy })
      rCandidates.get(ri).push(si)
    }
  }

  const matchedS = new Set()
  const matchedR = new Set()
  const matchedMatches = []
  let hasCollision = hasDuplicateRefConflict
  let stage3MatchedCnyBig = 0n
  let bankFeeCnyBig = 0n
  let creditDeductedFeeCnyBig = 0n
  let fxSpreadCnyBig = 0n

  for (const [si, edges] of sCandidates.entries()) {
    if (edges.length !== 1) {
      hasCollision = true
      continue
    }
    const edge = edges[0]
    if ((rCandidates.get(edge.ri)?.length ?? 0) !== 1) {
      hasCollision = true
      continue
    }
    matchedS.add(si)
    matchedR.add(edge.ri)
    const s = eligibleSettlements[si]
    const r = eligibleReceipts[edge.ri]
    // 严格按回单明列银行手续费记账，严禁将未证实短收伪记为银行手续费
    const declaredFee = edge.feeAmt
    const creditDeductedFee = edge.shortfall > 0n
      ? (edge.shortfall < declaredFee ? edge.shortfall : declaredFee)
      : 0n
    const recvCny = toCnyBig(edge.creditAmt, edge.receiptCcy, fxMap) ?? 0n
    const feeCny = toCnyBig(declaredFee, edge.receiptCcy, fxMap) ?? 0n
    const deductedFeeCny = toCnyBig(creditDeductedFee, edge.receiptCcy, fxMap) ?? 0n
    const fxDiff = toScaledBigInt(s.fxDiffCny, 0n)
    stage3MatchedCnyBig += recvCny
    bankFeeCnyBig += feeCny
    creditDeductedFeeCnyBig += deductedFeeCny
    fxSpreadCnyBig += fxDiff

    matchedMatches.push({
      walletPlatform: s.walletPlatform || 'UnknownWallet',
      bank: r.bank || 'GENERIC_BANK',
      bankLabel: r.bankLabel || '国内对公银行',
      period: s.period,
      currency: edge.receiptCcy,
      accountSuffix: r.accountSuffix || s.accountSuffix || null,
      expectedAmount: toNumber2(edge.expectedAmt),
      receivedAmount: toNumber2(edge.creditAmt),
      bankFee: toNumber2(declaredFee),
      fxDiff: toNumber2(fxDiff),
      status: 'matched',
      matchBasis: '5键精确核销（主体+对公账号/尾号+账期+回单参考号+币种金额）',
    })
  }
  if (hasDuplicateRefConflict) {
    alerts.push('【P1-高危 · 重复参考号冲突 / 5 键凭证碰撞】检出多笔银行回单或结汇单共用同一参考号（即使其中部分金额超窗或状态异常），已按 fail-closed 原则阻断自动核销，请人工逐笔核对。')
  } else if (hasCollision) {
    alerts.push('【P1-高危 · 5 键凭证碰撞】检出多笔结汇单或银行回单命中同一 5 键组合，已按 fail-closed 原则阻断自动核销，请人工逐笔核对。')
  }
  if (feeOverCapCount > 0) {
    alerts.push(`【P1-高危 · 银行手续费超窗】检出 ${feeOverCapCount} 笔银行回单申明手续费超过允许上限（¥${toNumber2(maxBankFeeCnyBig).toFixed(2)}），已阻断自动核销，请复核扣费凭证。`)
  }
  if (unverifiedShortfallCount > 0) {
    alerts.push(`【P1-高危 · 银行实收存在未证实差额】检出 ${unverifiedShortfallCount} 笔银行回单实收金额低于预期且超出明列手续费（未证实差额折合 ¥${toNumber2(unverifiedShortfallCnyBig).toFixed(2)}），未伪记为银行手续费并已阻断正式核销，请人工核对差额原因。`)
  }
  if (hasMissingFx) {
    const ccyList = [...missingFxCurrencies].join('、') || '外币'
    alerts.push(`【P1-高危 · 缺失外币折算汇率】检出需折算人民币核验的 ${ccyList} 提现或回单但缺少有效汇率，已按 fail-closed 原则阻断自动核销。`)
  }

  // ── Track 2：参考级候选匹配（绝不污染法定 matched） ──────────
  const stage3CandidateMatches = []
  const candUsedS = new Set()
  const candUsedR = new Set()
  const candRatioScale = BigInt(Math.round(candTolPct * 10_000))

  for (let si = 0; si < eligibleSettlements.length; si++) {
    if (matchedS.has(si)) continue
    const s = eligibleSettlements[si]
    if (s._nonTerminal || s._reversedByBankDebit || dupRefSettlements.has(si)) continue
    if (!IS_MONTH_RE.test(s.period || '')) continue

    let bestHit = null
    for (let ri = 0; ri < eligibleReceipts.length; ri++) {
      if (matchedR.has(ri) || candUsedR.has(ri)) continue
      const r = eligibleReceipts[ri]
      if (r.blankCurrency || !IS_MONTH_RE.test(r.period || '') || r.period !== s.period) continue
      // 严守候选层零冲突铁律：双方存在主体冲突、账号/前缀/尾号/银行冲突或显式关联号冲突时，连参考候选也绝不配对！
      if (hasEntityConflict(s, r)) continue
      if (hasAccountConflict(s, r)) continue
      if (s.referenceKey && r.explicitReferenceKey && s.referenceKey !== r.explicitReferenceKey) continue

      const receiptCcy = normalizeCurrencyCode(r.currency || 'CNY')
      const expectedAmt = expectedAmountForCurrency(s, receiptCcy, fxMap)
      if (expectedAmt === null || expectedAmt <= 0n) continue
      const creditAmt = toScaledBigInt(r.creditAmount, 0n)
      if (creditAmt <= 0n) continue
      const fxRate = receiptCcy === 'CNY' ? AMOUNT_SCALE : fxMap.get(receiptCcy)
      if (!fxRate || fxRate <= 0n) continue

      const diff = creditAmt - expectedAmt
      const absDiff = absBig(diff)
      const absDiffCnyExact = absDiff * fxRate
      const maxCandDiff = (expectedAmt * candRatioScale) / 10_000n
      const keywordHit = Boolean(r.walletKeywordHint && s.walletPlatform && r.walletKeywordHint.toLowerCase() === s.walletPlatform.toLowerCase())
      const refHit = Boolean(s.referenceKey && r._refSet.has(s.referenceKey))
      const amountClose = absDiff <= maxCandDiff || absDiffCnyExact <= maxBankFeeCnyBig * AMOUNT_SCALE
      if (!amountClose) continue
      if (!keywordHit && !refHit && absDiffCnyExact > roundingTolBig * AMOUNT_SCALE) continue

      const score = (refHit ? 2 : 0) + (keywordHit ? 2 : 0) + (absDiffCnyExact <= roundingTolBig * AMOUNT_SCALE ? 2 : 1)
      if (!bestHit || score > bestHit.score || (score === bestHit.score && absDiff < bestHit.absDiff)) {
        bestHit = { ri, r, receiptCcy, expectedAmt, creditAmt, diff, absDiff, keywordHit, score }
      }
    }

    if (bestHit) {
      candUsedS.add(si)
      candUsedR.add(bestHit.ri)
      const missingReasons = []
      if (s._partialReturnFrozen) missingReasons.push('部分退汇后本币余额待核')
      if (feeOverCapBySi.has(si)) missingReasons.push('银行手续费超出允许上限')
      const unv = unverifiedBySi.get(si)
      if (unv && unv.ri === bestHit.ri) missingReasons.push(`存在未证实差额 ${fmtAmount(unv.unverifiedCny)} 元`)
      if (!s.referenceKey || !bestHit.r._refSet.has(s.referenceKey)) missingReasons.push('缺精确参考号')
      if (hasAccountConflict(s, bestHit.r)) missingReasons.push('对公账号/尾号不一致')
      else if (!accountsStrictlyMatch(s, bestHit.r)) missingReasons.push('缺对公账号/尾号一致凭证')
      if (!(s.entityKey || s.explicitEntityKey || s.legalEntityKey) || !(bestHit.r.entityKey || bestHit.r.explicitEntityKey || bestHit.r.legalEntityKey)) {
        missingReasons.push('缺主体编号/户名')
      }
      const declaredFeeAmt = toScaledBigInt(bestHit.r.feeAmount, 0n)
      const candShortfall = bestHit.expectedAmt - bestHit.creditAmt
      const candUnverified = candShortfall > declaredFeeAmt ? candShortfall - declaredFeeAmt : 0n
      stage3CandidateMatches.push({
        walletPlatform: s.walletPlatform || 'UnknownWallet',
        bank: bestHit.r.bank || 'GENERIC_BANK',
        bankLabel: bestHit.r.bankLabel || '国内对公银行',
        period: s.period,
        currency: bestHit.receiptCcy,
        accountSuffix: bestHit.r.accountSuffix || s.accountSuffix || null,
        expectedAmount: toNumber2(bestHit.expectedAmt),
        receivedAmount: toNumber2(bestHit.creditAmt),
        diffAmount: toNumber2(bestHit.diff),
        declaredBankFee: toNumber2(declaredFeeAmt),
        unverifiedShortfall: toNumber2(candUnverified),
        walletKeywordHit: bestHit.keywordHit,
        status: 'candidate_pending_confirm',
        matchBasis: `参考级待确认：同账期+${bestHit.keywordHit ? `${s.walletPlatform}摘要关键词+` : ''}金额近似（${missingReasons.join('、') || '超出手续费窗口'}，不计入法定核销）`,
      })
    }
  }

  let stage2CorporateExpectedCnyBig = 0n
  let inTransitUnmatchedCnyBig = 0n
  let unbackedCorporateCnyBig = 0n
  const inTransitMissingFxOrig = new Map()
  const unbackedMissingFxOrig = new Map()
  const unmatchedSettlements = []
  for (let si = 0; si < eligibleSettlements.length; si++) {
    const s = eligibleSettlements[si]
    const expCnyVal = s._expectedCny !== undefined ? s._expectedCny : settlementExpectedCny(s, fxMap)
    if (expCnyVal === null) hasMissingFx = true
    const expCny = expCnyVal ?? 0n
    const pAmt = toScaledBigInt(s.principalAmount, 0n)
    stage2CorporateExpectedCnyBig += expCny
    if (!matchedS.has(si)) {
      inTransitUnmatchedCnyBig += expCny
      if (expCnyVal === null && !candUsedS.has(si)) {
        addOrigAmount(inTransitMissingFxOrig, s.currency, pAmt)
      }
      unmatchedSettlements.push({
        walletPlatform: s.walletPlatform || 'UnknownWallet',
        period: s.period || '待确认期间',
        currency: normalizeCurrencyCode(s.currency),
        principalAmount: toNumber2(pAmt),
        expectedCny: expCnyVal === null ? null : toNumber2(expCny),
        fxMissing: expCnyVal === null,
        accountSuffix: s.accountSuffix || null,
        hasCandidateMatch: candUsedS.has(si),
        status: s._reversedByBankDebit
          ? 'debit_reversed_blocked'
          : s._nonTerminal
            ? 'non_terminal_blocked'
            : s._partialReturnFrozen
              ? 'partial_return_frozen'
              : candUsedS.has(si)
                ? 'candidate_only'
                : 'in_transit_or_pending_receipt',
      })
    }
  }
  for (const ub of unbackedItems) {
    const ubCny = ub.expectedCnyBig ?? 0n
    if (ub.expectedCnyBig === null) {
      addOrigAmount(unbackedMissingFxOrig, ub.currency, ub.principalAmount)
    }
    unbackedCorporateCnyBig += ubCny
    stage2CorporateExpectedCnyBig += ubCny
    inTransitUnmatchedCnyBig += ubCny
    if (ub.expectedCnyBig === null) {
      addOrigAmount(inTransitMissingFxOrig, ub.currency, ub.principalAmount)
    }
    unmatchedSettlements.push({
      walletPlatform: ub.walletPlatform,
      period: ub.period,
      currency: ub.currency,
      principalAmount: toNumber2(ub.principalAmount),
      expectedCny: ub.expectedCnyBig === null ? null : toNumber2(ubCny),
      fxMissing: ub.expectedCnyBig === null,
      accountSuffix: null,
      hasCandidateMatch: false,
      status: 'missing_itemized_evidence',
    })
  }
  if (unbackedItems.length > 0) {
    const ubDesc = unbackedMissingFxOrig.size > 0
      ? (unbackedCorporateCnyBig > 0n
          ? `已折算部分 ¥${toNumber2(unbackedCorporateCnyBig).toFixed(2)}，另有原币 ${formatOrigAmountMap(unbackedMissingFxOrig)} 缺少有效汇率未折算待补汇率`
          : `原币 ${formatOrigAmountMap(unbackedMissingFxOrig)} 缺少有效汇率暂未折算人民币，待补汇率`)
      : `折合 ¥${toNumber2(unbackedCorporateCnyBig).toFixed(2)}`
    alerts.push(`【P1-高危 · 缺逐笔提款明细凭证】结汇通道存在 ${unbackedItems.length} 项未附逐笔 outboundEvidence 的净对公提款（${ubDesc}），已计入应核总额与未核在途，禁止全局判定已核销。`)
  }

  const unmatchedReceipts = []
  for (let ri = 0; ri < eligibleReceipts.length; ri++) {
    if (matchedR.has(ri)) continue
    const r = eligibleReceipts[ri]
    unmatchedReceipts.push({
      bank: r.bank || 'GENERIC_BANK',
      bankLabel: r.bankLabel || '国内对公银行',
      period: r.period || '待确认期间',
      currency: normalizeCurrencyCode(r.currency || 'CNY'),
      creditAmount: toNumber2(toScaledBigInt(r.creditAmount, 0n)),
      feeAmount: toNumber2(toScaledBigInt(r.feeAmount, 0n)),
      accountSuffix: r.accountSuffix || null,
      walletKeywordHint: r.walletKeywordHint || null,
      hasCandidateMatch: candUsedR.has(ri),
    })
  }

  const fxGapOrInTransitCnyBig = stage2CorporateExpectedCnyBig - stage3MatchedCnyBig - creditDeductedFeeCnyBig
  const matchedCount = matchedMatches.length
  const unmatchedSettlementCount = unmatchedSettlements.length

  const allCorporateMatched =
    !coverageIncomplete &&
    eligibleSettlements.length > 0 &&
    matchedCount === eligibleSettlements.length &&
    unmatchedSettlementCount === 0 &&
    unbackedItems.length === 0 &&
    unbackedCorporateCnyBig === 0n &&
    !hasEvidenceMismatch &&
    !hasCollision &&
    !hasDuplicateRefConflict &&
    !hasMissingFx &&
    debitReversedReceiptCount === 0 &&
    debitReversedSettlementCount === 0 &&
    blankCurrencyReceiptCount === 0 &&
    unverifiedShortfallCnyBig === 0n &&
    nonTerminalCorporateCount === 0 &&
    partialReturnFrozenCount === 0 &&
    inTransitUnmatchedCnyBig === 0n &&
    absBig(fxGapOrInTransitCnyBig) <= roundingTolBig

  let stage3Status = 'pending_bank_receipt'
  if (allCorporateMatched) {
    stage3Status = 'matched'
  } else if (matchedCount > 0) {
    stage3Status = 'partial'
  } else if (stage3CandidateMatches.length > 0) {
    stage3Status = 'candidate_only'
  }

  if (stage3CandidateMatches.length > 0) {
    alerts.push(`【P2-关注 · 参考级候选匹配】检出 ${stage3CandidateMatches.length} 组 Stage 3 参考级候选回单（因缺少参考号或对公账号强凭证未计入法定核销），请财务对照电子回单人工确认。`)
  }
  const pureInTransit = unmatchedSettlements.filter((x) => !x.hasCandidateMatch)
  if (pureInTransit.length > 0) {
    const transitDesc = inTransitMissingFxOrig.size > 0
      ? (inTransitUnmatchedCnyBig > 0n
          ? `已折算部分 ¥${toNumber2(inTransitUnmatchedCnyBig).toFixed(2)}，另有原币 ${formatOrigAmountMap(inTransitMissingFxOrig)} 因缺少有效汇率未折算待补汇率`
          : `原币 ${formatOrigAmountMap(inTransitMissingFxOrig)} 因缺少有效汇率暂未折算人民币，待补有效汇率后重算`)
      : `在途/未核销折合 ¥${toNumber2(inTransitUnmatchedCnyBig).toFixed(2)}`
    alerts.push(`【P1-高危 · 结汇在途或待补回单】尚有 ${pureInTransit.length} 笔企业户结汇未找到对应国内银行入账回单（${transitDesc}），请排查跨月在途或补导银行回单。`)
  }

  return {
    stage3Status,
    stage2CorporateExpectedCny: toNumber2(stage2CorporateExpectedCnyBig),
    stage3MatchedCny: toNumber2(stage3MatchedCnyBig),
    bankFeeCny: toNumber2(bankFeeCnyBig),
    unverifiedShortfallCny: toNumber2(unverifiedShortfallCnyBig),
    unbackedCorporateCny: toNumber2(unbackedCorporateCnyBig),
    fxGapOrInTransitCny: toNumber2(fxGapOrInTransitCnyBig),
    inTransitUnmatchedCny: toNumber2(inTransitUnmatchedCnyBig),
    fxSpreadCny: toNumber2(fxSpreadCnyBig),
    personalWithdrawCny: toNumber2(personalWithdrawCnyBig),
    unverifiedWithdrawCny: toNumber2(unverifiedWithdrawCnyBig),
    missingFxCurrencies: [...missingFxCurrencies].sort(),
    invalidFxCurrencies: [...invalidFxCurrencies].sort(),
    matchedMatches,
    stage3CandidateMatches,
    unmatchedSettlements,
    unmatchedReceipts,
    abnormalReceipts,
    alerts,
    stats: {
      totalSettlements: rawSettlements.length,
      eligibleCorporateCount: eligibleSettlements.length,
      unbackedCorporateCount: unbackedItems.length,
      nonTerminalCorporateCount,
      partialReturnFrozenCount,
      personalWithdrawCount,
      unverifiedWithdrawCount,
      totalReceipts: rawReceipts.length,
      eligibleReceiptCount: eligibleReceipts.length,
      abnormalReceiptCount: abnormalReceipts.length,
      nonTerminalReceiptCount,
      matchedCount,
      candidateCount: stage3CandidateMatches.length,
      unmatchedSettlementCount,
      unmatchedReceiptCount: unmatchedReceipts.length,
    },
  }
}

// ════════════════════════════════════════════════════════════════
// 内置脱敏全链路样例生成器 buildV9DemoFiles()（demo:v9）
// 涵盖：Amazon / SHEIN 销售 + 连连 / PingPong / 万里汇结汇 + 招行 / 中行对公回单
// 同时演示：精确 Stage 3 5 键核销、汇损/银行手续费差额、参考级候选匹配、在途未到账与 1 条 P0 私户拦截
// ════════════════════════════════════════════════════════════════

export function buildV9DemoFiles() {
  const specs = [
    {
      name: 'Demo_V9_Amazon_US_202611.csv',
      role: 'sales_platform',
      platform: 'amazon',
      csv: [
        '"Includes Amazon Marketplace, Fulfillment by Amazon (FBA) transactions"',
        '"date/time","settlement id","type","order id","marketplace","product sales","product sales tax","shipping credits","promotional rebates","marketplace withheld tax","selling fees","fba fees","other","total"',
        '"2026-11-04","SET-V9-AMZ-01","Order","114-9001","amazon.com","40000.00","3200.00","1500.00","-1500.00","-3200.00","-6000.00","-4500.00","0.00","29500.00"',
        '"2026-11-11","SET-V9-AMZ-01","Refund","114-9002","amazon.com","-2000.00","-160.00","0.00","0.00","160.00","300.00","0.00","0.00","-1700.00"',
        '"2026-11-18","SET-V9-AMZ-01","Transfer","","amazon.com","0.00","0.00","0.00","0.00","0.00","0.00","0.00","-27800.00","-27800.00"',
      ].join('\n'),
    },
    {
      name: 'Demo_V9_SHEIN_US_202611.csv',
      role: 'sales_platform',
      platform: 'shein',
      csv: [
        '结算日期,结算单号,合作模式,账务类型,站点,币种,销售额,商家优惠,平台补贴,退款金额,平台佣金,履约运费,质检扣款,提现金额,净结款',
        '2026-11-06,SHN-202611-001,半托管,订单结算,US,USD,20000.00,-500.00,300.00,0.00,-2000.00,-1800.00,0.00,0.00,16000.00',
        '2026-11-10,SHN-202611-002,半托管,费用冲回,US,USD,0.00,0.00,0.00,0.00,200.00,0.00,0.00,0.00,200.00',
        '2026-11-19,SHN-WD-202611,半托管,提现打款,US,USD,0.00,0.00,0.00,0.00,0.00,0.00,0.00,16200.00,16200.00',
      ].join('\n'),
    },
    {
      name: 'Demo_V9_LianLian_USD_202611.csv',
      role: 'settlement_wallet',
      platform: 'lianlian',
      csv: [
        '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,收款银行,主体编号,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,备注,状态',
        '2026-11-19,LL-IN-20261119-01,平台回款,Amazon,Amazon.com Services LLC,,,ENT-XH-2026,USD,27800.00,0.00,0.00,27800.00,,,Amazon US SET-V9-AMZ-01,Completed',
        '2026-11-21,LL-WD-20261121-01,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,招商银行,ENT-XH-2026,USD,0.00,15000.00,45.00,-15045.00,7.2400,108600.00,对公基本户结汇回流,Completed',
        '2026-11-24,LL-WD-20261124-02,结汇提现,Amazon,深圳星海跨境科技有限公司,7497654321006612,中国银行,ENT-XH-2026,USD,0.00,10000.00,30.00,-10030.00,7.2350,72300.00,对公一般户结汇含汇差50,Completed',
        '2026-11-25,LL-WD-20261125-03,提现,Amazon,张三个人储蓄卡,622202****9901,工商银行,ENT-XH-2026,USD,0.00,2000.00,10.00,-2010.00,7.2300,14460.00,个人私户提现红线演示,Completed',
      ].join('\n'),
    },
    {
      name: 'Demo_V9_PingPong_USD_202611.csv',
      role: 'settlement_wallet',
      platform: 'pingpong',
      csv: [
        '交易时间,PingPong单号,交易类型,店铺名称,收款户名,收款账号,收款银行,主体编号,币种,入账金额,提现金额,PingPong手续费,净额,提现汇率,实收人民币,备注,状态',
        '2026-11-20,PPG-IN-20261120-01,平台回款,SHEIN,Roadget Business Pte. Ltd.,,,ENT-XH-2026,USD,16200.00,0.00,0.00,16200.00,,,SHEIN US Payout,Completed',
        '2026-11-23,PPG-WD-20261123-01,结汇提现,SHEIN,深圳星海跨境科技有限公司,7559012345108821,招商银行,ENT-XH-2026,USD,0.00,10000.00,100.00,-10100.00,7.2200,72200.00,对公结汇(回单缺参考号演示候选),Completed',
        '2026-11-29,PPG-WD-20261129-02,结汇提现,SHEIN,深圳星海跨境科技有限公司,7497654321006612,中国银行,ENT-XH-2026,USD,0.00,5000.00,50.00,-5050.00,7.2200,36100.00,月末在途未到账演示,Completed',
      ].join('\n'),
    },
    {
      name: 'Demo_V9_WorldFirst_USD_202611.csv',
      role: 'settlement_wallet',
      platform: 'worldfirst',
      csv: [
        '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,净额,状态',
        '2026-11-19,WF-20261119-V9,平台回款,Amazon.com Services LLC,Amazon US Backup Store,USD,8000.00,0.00,0.00,8000.00,Completed',
        '2026-11-22,WF-20261122-V9,结汇提现,深圳星海跨境科技有限公司(对公基本户),万里汇对公回流,USD,0.00,6000.00,18.00,-6018.00,Completed',
      ].join('\n'),
    },
    {
      name: 'Demo_V9_CMB_BankReceipt_202611.csv',
      role: 'bank_receipt',
      platform: 'cmb',
      csv: [
        '交易日期,记账日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
        '2026-11-21,2026-11-21,108600.00,0.00,CNY,0.00,连连银通电子支付有限公司,深圳星海跨境科技有限公司,7559012345108821,ENT-XH-2026,连连国际结汇入账 LL-WD-20261121-01,CMB-20261121-0001,LL-WD-20261121-01',
        '2026-11-23,2026-11-23,72150.00,0.00,CNY,0.00,PingPong结汇清算户,深圳星海跨境科技有限公司,7559012345108821,ENT-XH-2026,PingPong跨境货款结汇入账,CMB-20261123-0002,',
      ].join('\n'),
    },
    {
      name: 'Demo_V9_BOC_BankReceipt_202611.csv',
      role: 'bank_receipt',
      platform: 'boc',
      csv: [
        '交易日期,记账日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
        '2026-11-24,2026-11-24,72180.00,0.00,CNY,120.00,连连银通跨境结汇专户,深圳星海跨境科技有限公司,7497654321006612,ENT-XH-2026,连连国际涉外结汇 LL-WD-20261124-02 扣收银行手续费120,BOC-20261124-0001,LL-WD-20261124-02',
      ].join('\n'),
    },
  ]

  return specs.map((item) => ({
    ...item,
    buffer: Buffer.from(item.csv, 'utf8'),
  }))
}

export function getV9DemoBuffers() {
  return buildV9DemoFiles().map((item) => [item.name, item.buffer])
}

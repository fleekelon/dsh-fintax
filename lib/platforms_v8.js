// dsh-fintax v0.8.0 第三方跨境收款结汇通道解析器（万里汇 WorldFirst / 派安盈 Payoneer / 空中云汇 Airwallex）
// 纯 Node.js 零第三方依赖，共享 lib/statement.js 的 BigInt 定点算术内核。
// 口径边界：结汇通道为 role='settlement_wallet'，绝不将平台回款入账重复计入销售额，仅用于三段资金交叉核对与合规排雷。

import {
  CENT_STEP,
  absBig,
  cell,
  finalizeSummary,
  findHeaderRow,
  fmtAmount,
  inferPeriod,
  makeEmptySummary,
  parseAmount,
} from './statement.js'

const CCY_SITE_MAP = {
  USD: 'US', EUR: 'EU', GBP: 'UK', AUD: 'AU', CAD: 'CA', JPY: 'JP',
  SGD: 'SG', MYR: 'MY', HKD: 'HK', CNY: 'CN', RMB: 'CN', MXN: 'MX', UNKNOWN: 'UNKNOWN',
}

const VOID_STATUS_RE = /pending|cancel|declin|fail|reject|void|processing|待处理|失败|取消|撤销|处理中/i
const TOTAL_ROW_RE = /^(?:total|subtotal|summary|grand\s*total|合计|总计|小计|汇总)$/i
const SUMMARY_SHEET_RE = /summary|overview|readme|guide|汇总|总览|说明/i
const FX_INTERNAL_RE = /fx[\s_-]*conversion|currency[\s_-]*conversion|currency[\s_-]*exchange|manage[\s_-]*currencies|internal[\s_-]*transfer|same[\s_-]*entity|self[\s_-]*transfer|wallet[\s_-]*transfer|换汇|购汇内部|币种互转|账户互转|内部划转/i
const PLATFORM_SOURCE_RE = /amazon|amz|tiktok|bytedance|temu|whaleco|pdd|aliexpress|alipay|alibaba|shopee|shopify|paypal|stripe|walmart|ebay|etsy|wayfair|shein|mercadolibre|ozon|rakuten|global[\s_]*account[\s_]*deposit|platform[\s_]*payout|平台回款|平台结算|店铺入账/i
const PERSONAL_ACCOUNT_RE = /\bpersonal\b|private\s*(?:bank|account)|\bindividual\b|自然人|个人(?:账户|银行|储蓄|私户|卡)|法人(?:私户|个人|卡)|私户|私卡/i
const CORPORATE_ACCOUNT_RE = /co\.?\s*,?\s*ltd|\blimited\b|\bltd\b|\binc\b|\bllc\b|\bcorp(?:oration)?\b|trading|technology|electronics|industrial|e-?commerce|corporate|business\s*account|有限公司|有限责任公司|股份公司|对公|公户|公司基本户|贸易公司|科技公司/i
const DIRECT_SPEND_RE = /\bsupplier\b|\bvendor\b|\bfactory\b|\b1688\b|meta\s*(?:platforms?|ads?|ireland)|facebook|google\s*(?:ads?|ireland|llc)|tiktok\s*ads?|bing\s*ads?|logistics|freight|forwarder|\bups\b|\bdhl\b|\bfedex\b|yunexpress|4px|cainiao|yanwen|vat\s*(?:pay|tax|hmrc|bzst)|hmrc|tax\s*authority|card[\s_]*purchase|\bissuing\b|borderless[\s_]*card|commercial[\s_]*card|payoneer\s*card|make\s*a\s*payment|pay\s*a\s*recipient|供应商|(?:支付|付|采购)货款|采购款|物流|头程|广告|云汇卡|刷卡|缴税|代付|余额直付/i
const WITHDRAW_RE = /withdraw|payout|settlement\s*to\s*bank|bank\s*transfer|transfer\s*to\s*bank|repatriat|提现|结汇|转出至银行|汇款至国内/i
const FEE_TYPE_RE = /^(?:fee|fees|service\s*fee|annual\s*(?:account\s*)?fee|withdrawal\s*fee|fx\s*fee|wire\s*fee|手续费|提现费|账户年费|电汇费)$/i
// 严格词边界：绝不把正常公司名 "ABC Holdings Ltd" 误判为冻结！
const FROZEN_RETURN_RE = /return(?:ed)?[\s_-]*(?:wire|payout|transfer|funds?)|\bbounce(?:d)?\b|reject(?:ed)?[\s_-]*payout|\bfreez(?:e|ing)\b|\bfrozen\b|(?:account|fund|balance|payout|compliance|risk)[\s_-]*hold|\bheld\b|\breserve[\s_-]*(?:hold|withhold)\b|退汇|退回钱包|风控冻结|账户冻结|冻结|扣留/i

/** 规范化结汇流水币种（支持中文币种名；无法识别时返回 UNKNOWN 而非静默归为 USD）。 */
export function normalizeWalletCurrency(raw) {
  const txt = String(raw ?? '').trim()
  if (!txt) return 'UNKNOWN'
  if (/人民币|rmb|cny|¥|￥/i.test(txt)) return 'CNY'
  if (/美元|美金|us\$|\busd\b/i.test(txt)) return 'USD'
  if (/欧元|€|\beur\b/i.test(txt)) return 'EUR'
  if (/英镑|£|\bgbp\b/i.test(txt)) return 'GBP'
  if (/港币|港元|hk\$|\bhkd\b/i.test(txt)) return 'HKD'
  if (/日元|\bjpy\b/i.test(txt)) return 'JPY'
  if (/澳元|\baud\b/i.test(txt)) return 'AUD'
  if (/加元|\bcad\b/i.test(txt)) return 'CAD'
  if (/新加坡元|新币|\bsgd\b/i.test(txt)) return 'SGD'
  if (/林吉特|马币|\bmyr\b/i.test(txt)) return 'MYR'
  if (/泰铢|\bthb\b/i.test(txt)) return 'THB'
  if (/越南盾|\bvnd\b/i.test(txt)) return 'VND'
  if (/印尼盾|\bidr\b/i.test(txt)) return 'IDR'
  const iso = txt.toUpperCase().replace(/[^A-Z]/g, '')
  if (iso === 'RMB') return 'CNY'
  if (iso.length === 3) return iso
  return 'UNKNOWN'
}

function makeWalletSummary({ platform, currency, formatLabel, fileName }) {
  const s = makeEmptySummary({
    period: '待确认期间',
    platform,
    site: CCY_SITE_MAP[currency] || 'GLOBAL',
    currency,
    formatLabel,
    fileName,
  })
  s.role = 'settlement_wallet'
  s.walletMetrics = {
    platformInbound: 0n,
    otherInbound: 0n,
    returnedInbound: 0n,
    fxWithdrawToCorporate: 0n,
    fxWithdrawToPersonal: 0n,
    unverifiedWithdraw: 0n,
    directSpend: 0n,
    walletFees: 0n,
    internalFxStripped: 0n,
    internalFxNet: 0n,
    internalFxCount: 0,
    frozenOutflow: 0n,
    frozenOrReturned: 0n,
    voidExcludedCount: 0,
    netVerifiedRows: 0,
    unrepatriatedNet: 0n,
    signedNetFlow: 0n,
  }
  return s
}

function isTotalOrSummaryRow(...vals) {
  return vals.some((v) => TOTAL_ROW_RE.test(String(v ?? '').trim()))
}

function classifyAndApplyWalletRow(bucket, {
  txId,
  txType,
  counterparty,
  desc,
  status,
  signedAmt,
  feeAmt,
  expectedNet,
  netOnly = false,
}) {
  const s = bucket.summary
  const wm = s.walletMetrics
  const ref = txId || counterparty || txType || 'ROW'
  const combined = `${txType} ${counterparty} ${desc}`.trim()
  const combinedWithStatus = `${combined} ${status || ''}`.trim()

  if (status && VOID_STATUS_RE.test(status) && !FROZEN_RETURN_RE.test(status)) {
    wm.voidExcludedCount += 1
    s.uncapturedVoidExcluded += absBig(signedAmt)
    return
  }

  // 严格单向 Net 水平守恒校验（绝不同时放行互斥方向；精度门槛统一 >= CENT_STEP）
  if (expectedNet != null && !netOnly) {
    wm.netVerifiedRows += 1
    const absFee = absBig(feeAmt)
    let diff = 0n
    if (signedAmt > 0n) {
      // 入账：正常扣费 net = signedAmt - absFee（或退费 feeAmt < 0 时允许 signedAmt + absFee）
      const exp = feeAmt < 0n ? signedAmt + absFee : signedAmt - absFee
      diff = absBig(expectedNet - exp)
    } else if (signedAmt < 0n) {
      // 出账：允许外扣（signedAmt - absFee）或内含于出账额（signedAmt）；禁止把手续费反加给实付
      const diffExt = absBig(expectedNet - (signedAmt - absFee))
      const diffInc = absBig(expectedNet - signedAmt)
      diff = diffExt <= diffInc ? diffExt : diffInc
    } else {
      // Amount = 0 且 fee = 0 但 Net != 0：捕获篡改
      diff = absBig(expectedNet - (signedAmt - absFee))
    }
    if (diff >= CENT_STEP) {
      s.horizontalDiffTotal += diff
      s.anomalies.push({
        severity: 'P0-阻断',
        category: `${s.platform} 流水水平守恒异常（疑似篡改或截断）`,
        refId: ref,
        amount: fmtAmount(diff),
        detail: `金额(${fmtAmount(signedAmt)})、手续费(${fmtAmount(feeAmt)})与净变动(${fmtAmount(expectedNet)})核验相差 ${fmtAmount(diff)} ${s.currency}，请核验原始导出文件是否被人工改写。`,
      })
    }
  }

  // 手续费处理：若 netOnly=true（仅导 Net 列），净额本身已扣过费，fee 仅用于展示记录，不再从资金余额二次扣减
  const absFee = absBig(feeAmt)
  const recordFee = !netOnly && absFee > 0n
  if (recordFee) {
    if (feeAmt < 0n && signedAmt > 0n) {
      // 罕见退费冲回不重复加费
    } else {
      wm.walletFees += absFee
      s.platformCommission += absFee
    }
  }

  // 1. 同主体换汇 / 多币种内部划转：记录有符号净流 internalFxNet 保持账本闭合，但不计入销售或回流
  if (FX_INTERNAL_RE.test(combined) || /^conversion$/i.test(txType.trim())) {
    wm.internalFxCount += 1
    wm.internalFxStripped += absBig(signedAmt)
    wm.internalFxNet += signedAmt
    return
  }

  // 2. 独立手续费行（区分扣费 vs 正数退费冲回）
  if (FEE_TYPE_RE.test(txType.trim()) || (signedAmt < 0n && FEE_TYPE_RE.test(combined) && !WITHDRAW_RE.test(combined))) {
    if (signedAmt < 0n) {
      const extraFee = absBig(signedAmt)
      wm.walletFees += extraFee
      s.platformCommission += extraFee
    } else if (signedAmt > 0n) {
      if (wm.walletFees >= signedAmt) {
        wm.walletFees -= signedAmt
        s.platformCommission -= signedAmt
      } else {
        const excess = signedAmt - wm.walletFees
        s.platformCommission -= wm.walletFees
        wm.walletFees = 0n
        wm.otherInbound += excess
      }
    }
    return
  }

  // 3. 退汇 / 风控冻结异常（严格区分正向退回钱包入账 vs 负向冻结扣留）
  if (FROZEN_RETURN_RE.test(combinedWithStatus)) {
    const amt = absBig(signedAmt)
    wm.frozenOrReturned += amt
    if (signedAmt > 0n) {
      wm.returnedInbound += amt
      s.reserveNetChange -= amt
    } else if (signedAmt < 0n) {
      wm.frozenOutflow += amt
      s.reserveNetChange += amt
    }
    s.anomalies.push({
      severity: 'P1-高危',
      category: `${s.platform} ${signedAmt > 0n ? '退汇退回钱包或解冻入账' : '风控冻结或扣留'}`,
      refId: ref,
      amount: fmtAmount(amt),
      detail: `检测到${signedAmt > 0n ? '退汇/解冻入账' : '冻结/扣留'}记录「${combined.slice(0, 80)}」，金额 ${fmtAmount(amt)} ${s.currency}。请核对原提现回单冲回与出口收汇核销时限。`,
    })
    return
  }

  // 4. 资金入账（signedAmt > 0）：仅明确匹配电商平台/收单网关才计入 platformInbound，其余归 otherInbound
  if (signedAmt > 0n) {
    if (PLATFORM_SOURCE_RE.test(combined)) {
      wm.platformInbound += signedAmt
    } else {
      wm.otherInbound += signedAmt
      s.anomalies.push({
        severity: 'P2-关注',
        category: `${s.platform} 非标准电商平台入账（来源待核）`,
        refId: ref,
        amount: fmtAmount(signedAmt),
        detail: `入账对手方「${counterparty || desc || txType}」金额 ${fmtAmount(signedAmt)} ${s.currency} 未匹配常见电商平台关键词，已单独归入其他入账，请确认是否为独立站/B2B 货款或股东往来款。`,
      })
    }
    return
  }

  // 5. 资金出账（signedAmt < 0）：严格优先级（私户 P0 > 坐支 P1 > 明确对公回流 > 待核查提现 P1）
  if (signedAmt < 0n) {
    const outAmt = absBig(signedAmt)
    const isPersonal = PERSONAL_ACCOUNT_RE.test(combined)
    const isCorporate = CORPORATE_ACCOUNT_RE.test(combined)
    const isDirectSpend = DIRECT_SPEND_RE.test(combined)
    const isWithdraw = WITHDRAW_RE.test(combined)

    // 最高优先阻断：只要出现个人/私户/私卡标识即触发 P0，绝不允许被公司备注绕过！
    if (isPersonal) {
      wm.fxWithdrawToPersonal += outAmt
      s.actualPayout += outAmt
      s.anomalies.push({
        severity: 'P0-阻断',
        category: `${s.platform} 提现至个人私户（公私混收高危）`,
        refId: ref,
        amount: fmtAmount(outAmt),
        detail: `结汇/提现流向含个人私户特征「${counterparty || desc || txType}」(${fmtAmount(outAmt)} ${s.currency})。平台回款绕开对公户进入个人私卡极易触发公私混收、出口无法收汇核销及稽查风险，申报前务必整改。`,
      })
      return
    }

    // 第二优先：供应商/物流/广告/刷卡/缴税坐支（哪怕供应商是有限公司，也属于坐支而非合规对公结汇回流！）
    if (isDirectSpend) {
      wm.directSpend += outAmt
      s.anomalies.push({
        severity: 'P1-高危',
        category: `${s.platform} 结汇余额境外坐支（供应商/广告/卡消费）`,
        refId: ref,
        amount: fmtAmount(outAmt),
        detail: `直接从结汇账户余额支付「${counterparty || desc || txType}」(${fmtAmount(outAmt)} ${s.currency})。余额坐支会拉低境内收汇匹配率且易形成无票成本，须留存发票/合同并同步核对出口收汇差额。`,
      })
      return
    }

    // 第三优先：明确具有企业/对公标识的结汇提现 → 已核实境内对公回流
    if (isCorporate) {
      wm.fxWithdrawToCorporate += outAmt
      s.actualPayout += outAmt
      return
    }

    // 其余提现（如户名仅写自然人姓名“张三”或脱敏卡号，无对公证据）：严禁默认算进对公合规分子！
    if (isWithdraw) {
      wm.unverifiedWithdraw += outAmt
      s.actualPayout += outAmt
      s.anomalies.push({
        severity: 'P1-高危',
        category: `${s.platform} 提现收款户性质待核（未计入已确认对公回流）`,
        refId: ref,
        amount: fmtAmount(outAmt),
        detail: `提现记录「${counterparty || desc || txType}」(${fmtAmount(outAmt)} ${s.currency}) 缺少对公企业户名标识，已归入「待核提现」且未计入已确认对公回流率，请核验银行收款回单确认非个人私户。`,
      })
      return
    }

    // 无法归类的余额出金
    wm.directSpend += outAmt
    s.anomalies.push({
      severity: 'P2-关注',
      category: `${s.platform} 未归类余额出账`,
      refId: ref,
      amount: fmtAmount(outAmt),
      detail: `出账记录「${combined.slice(0, 80)}」(${fmtAmount(outAmt)} ${s.currency}) 无法自动判定为对公结汇或常规费用，请人工复核资金去向。`,
    })
  }
}

function finalizeWalletBuckets(byCcy) {
  const results = []
  for (const b of byCcy.values()) {
    const s = b.summary
    const wm = s.walletMetrics
    s.period = inferPeriod(b.dates)
    if (s.currency === 'UNKNOWN') {
      s.anomalies.push({
        severity: 'P1-高危',
        category: `${s.platform} 币种缺失或无法识别`,
        refId: `${s.platform}-CCY`,
        amount: '0.00',
        detail: `部分流水币种列缺失或格式非常规，暂标记为 UNKNOWN（严禁静默按 USD 折算），请检查原始账单币种列。`,
      })
    }
    if (wm.internalFxCount > 0) {
      s.anomalies.push({
        severity: 'P2-关注',
        category: `${s.platform} 同户换汇/内部互转已自动剥离`,
        refId: `FX-CONV×${wm.internalFxCount}`,
        amount: fmtAmount(wm.internalFxStripped),
        detail: `已剥离 ${wm.internalFxCount} 笔同主体换汇/多币种互转流水（交易额 ${fmtAmount(wm.internalFxStripped)} ${s.currency}，本币净变动 ${fmtAmount(wm.internalFxNet)}），防止重复计入入账或虚增回流额。`,
      })
    }
    const totalIn = wm.platformInbound + wm.otherInbound + wm.returnedInbound
    const totalOut = wm.fxWithdrawToCorporate + wm.fxWithdrawToPersonal + wm.unverifiedWithdraw + wm.directSpend + wm.walletFees + wm.frozenOutflow
    // 严格账本守恒：signedNetFlow 纳入同户换汇净变动 internalFxNet 与退汇/冻结有符号变动
    wm.signedNetFlow = totalIn + wm.internalFxNet - totalOut
    wm.unrepatriatedNet = wm.signedNetFlow > 0n ? wm.signedNetFlow : 0n
    // 滞留比例分母与合并层对齐：使用 totalIn = platformInbound + otherInbound（不再仅用 platformInbound 导致 >100% 畸形比）
    const inboundBase = wm.platformInbound + wm.otherInbound
    if (inboundBase > 0n && wm.unrepatriatedNet >= 5000n * 10000n) {
      const retainedPct = Number((wm.unrepatriatedNet * 10000n) / inboundBase) / 100
      if (retainedPct >= 35) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: `${s.platform} 境外收款账户大额资金滞留未结汇`,
          refId: `${s.platform}-${s.currency}`,
          amount: fmtAmount(wm.unrepatriatedNet),
          detail: `当期账户入账 ${fmtAmount(inboundBase)} ${s.currency}，净滞留约 ${fmtAmount(wm.unrepatriatedNet)} ${s.currency}（占入账 ${retainedPct.toFixed(1)}%）尚未结汇回流。若涉 0110/9710/9810 出口退税，请关注收汇核销期限。`,
        })
      }
    }
    results.push(finalizeSummary(s))
  }
  return results
}

// ── 9. 万里汇 WorldFirst 结汇流水解析器（CSV / XLSX 多工作表，中英文表头） ──
export const WORLDFIRST_ALIASES = {
  date: ['transaction date', 'date', 'value date', '交易时间', '交易日期', '记账日期', '入账时间'],
  tx_id: ['transaction id', 'reference id', 'order no', '交易流水号', '流水号', '交易单号', '业务单号'],
  tx_type: ['transaction type', 'type', 'business type', '交易类型', '业务类型'],
  counterparty: ['counterparty', 'beneficiary', 'payer/payee', 'sender/recipient', '对方户名', '交易对手', '收付款方', '收款账户'],
  desc: ['description', 'remark', 'reference', 'memo', '备注', '摘要', '附言'],
  currency: ['currency', 'ccy', '币种', '货币'],
  credit: ['credit', 'credit amount', 'amount in', 'inflow', '入账金额', '收入金额', '贷方金额'],
  debit: ['debit', 'debit amount', 'amount out', 'outflow', '出账金额', '支出金额', '借方金额'],
  amount: ['amount', 'transaction amount', '交易金额', '发生额', '金额'],
  fee: ['fee', 'service fee', 'commission', '手续费', '费用'],
  net: ['net amount', 'net', '净额', '净变动'],
  status: ['status', 'transaction status', '状态', '交易状态'],
  balance: ['balance', 'closing balance', 'running balance', '账户余额', '余额'],
}

export function isWorldFirstMatch(fileName, rows, hdrIdx, colMap) {
  const fn = fileName.toLowerCase()
  if (/payoneer|派安盈|airwallex|空中云汇/.test(fn)) return false
  const hdrLine = (rows[hdrIdx] || []).map((c) => String(c ?? '').toLowerCase()).join(' ')
  if (hdrLine.includes('financial transaction type') || hdrLine.includes('wallet currency')) return false
  if (/worldfirst|world_first|万里汇/.test(fn)) return true
  if (!('currency' in colMap && 'date' in colMap)) return false
  if (!('amount' in colMap || 'credit' in colMap || 'debit' in colMap)) return false
  // 强结构特征：同时含入账/出账双列（或中文字段“交易流水号”+“对方户名”）
  if ('credit' in colMap && 'debit' in colMap) return true
  // 检查表头之前元数据行与流水号前缀（不因对手方备注偶现 worldfirst 抢走他方账单）
  for (let i = Math.max(0, hdrIdx - 5); i < hdrIdx; i++) {
    const line = rows[i].map((c) => String(c ?? '').toLowerCase()).join(' ')
    if (/worldfirst|world first|万里汇|ant\s*international/i.test(line)) return true
  }
  for (let i = hdrIdx + 1; i < Math.min(rows.length, hdrIdx + 25); i++) {
    const tid = cell(rows[i], colMap.tx_id).toLowerCase()
    if (/^wf[-_](?:tx|\d)/.test(tid)) return true
  }
  return false
}

export function parseWorldFirstSheets(fileName, sheets, formatInfo, forceMatch = false) {
  const byCcy = new Map()
  let matchedAny = false
  const ensureBucket = (ccy) => {
    if (!byCcy.has(ccy)) {
      byCcy.set(ccy, {
        dates: [],
        summary: makeWalletSummary({
          platform: 'WorldFirst',
          currency: ccy,
          formatLabel: `万里汇 WorldFirst 结汇流水 (${formatInfo})`,
          fileName,
        }),
      })
    }
    return byCcy.get(ccy)
  }

  for (const [sName, rows] of sheets) {
    if (sheets.length > 1 && SUMMARY_SHEET_RE.test(sName) && !/detail|tx|明细|流水/i.test(sName)) continue
    const m = findHeaderRow(rows, WORLDFIRST_ALIASES, 4)
    if (!m) continue
    if (!forceMatch && !matchedAny && !isWorldFirstMatch(`${fileName} ${sName}`, rows, m[0], m[1])) continue
    const [hdrIdx, colMap] = m
    if (!('amount' in colMap || 'credit' in colMap || 'debit' in colMap)) continue
    matchedAny = true

    for (const r of rows.slice(hdrIdx + 1)) {
      const dateStr = cell(r, colMap.date)
      const txType = cell(r, colMap.tx_type)
      const counterparty = cell(r, colMap.counterparty)
      const desc = cell(r, colMap.desc)
      if (!dateStr && !txType && !counterparty && !desc) continue
      if (isTotalOrSummaryRow(dateStr, txType, counterparty, desc, cell(r, colMap.tx_id))) continue
      const ccy = normalizeWalletCurrency(cell(r, colMap.currency))
      let signedAmt = 0n
      if ('credit' in colMap && 'debit' in colMap) {
        const cr = absBig(parseAmount(cell(r, colMap.credit)))
        const db = absBig(parseAmount(cell(r, colMap.debit)))
        signedAmt = cr - db
      } else if ('amount' in colMap && cell(r, colMap.amount) !== '') {
        signedAmt = parseAmount(cell(r, colMap.amount))
      } else if ('credit' in colMap) {
        signedAmt = parseAmount(cell(r, colMap.credit))
      } else if ('debit' in colMap) {
        const rawDb = parseAmount(cell(r, colMap.debit))
        signedAmt = rawDb > 0n ? -rawDb : rawDb
      }
      const feeAmt = parseAmount(cell(r, colMap.fee))
      const expectedNet = 'net' in colMap && cell(r, colMap.net) !== '' ? parseAmount(cell(r, colMap.net)) : null
      if (signedAmt === 0n && feeAmt === 0n && (expectedNet === null || expectedNet === 0n)) continue

      const bucket = ensureBucket(ccy)
      bucket.summary.rawRowCount += 1
      if (dateStr) bucket.dates.push(dateStr)
      classifyAndApplyWalletRow(bucket, {
        txId: cell(r, colMap.tx_id),
        txType,
        counterparty,
        desc,
        status: cell(r, colMap.status),
        signedAmt,
        feeAmt,
        expectedNet,
      })
    }
  }
  return byCcy.size > 0 ? finalizeWalletBuckets(byCcy) : null
}

// ── 10. 派安盈 Payoneer 结汇流水解析器（Transaction Report CSV / XLSX 多工作表） ──
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
  balance: ['running balance', 'balance', '余额'],
}

export function isPayoneerMatch(fileName, rows, hdrIdx, colMap) {
  const fn = fileName.toLowerCase()
  if (/worldfirst|万里汇|airwallex|空中云汇/.test(fn)) return false
  const hdrLine = (rows[hdrIdx] || []).map((c) => String(c ?? '').toLowerCase()).join(' ')
  if (hdrLine.includes('financial transaction type') || hdrLine.includes('wallet currency')) return false
  if ((hdrLine.includes('credit') && hdrLine.includes('debit')) || (hdrLine.includes('入账金额') && hdrLine.includes('出账金额'))) {
    return false
  }
  if (/payoneer|派安盈|p卡/.test(fn)) return true
  if (!('date' in colMap && 'amount' in colMap && 'currency' in colMap)) return false
  if (!('desc' in colMap || 'tx_type' in colMap)) return false
  for (let i = Math.max(0, hdrIdx - 5); i < Math.min(rows.length, hdrIdx + 25); i++) {
    const line = rows[i].map((c) => String(c ?? '').toLowerCase()).join(' ')
    if (/payoneer|派安盈|withdraw to bank account|manage currencies|annual account fee/i.test(line)) {
      return true
    }
  }
  return false
}

export function parsePayoneerSheets(fileName, sheets, formatInfo, forceMatch = false) {
  const byCcy = new Map()
  let matchedAny = false
  const ensureBucket = (ccy) => {
    if (!byCcy.has(ccy)) {
      byCcy.set(ccy, {
        dates: [],
        summary: makeWalletSummary({
          platform: 'Payoneer',
          currency: ccy,
          formatLabel: `派安盈 Payoneer 结汇流水 (${formatInfo})`,
          fileName,
        }),
      })
    }
    return byCcy.get(ccy)
  }

  for (const [sName, rows] of sheets) {
    if (sheets.length > 1 && SUMMARY_SHEET_RE.test(sName) && !/detail|tx|明细|流水/i.test(sName)) continue
    const m = findHeaderRow(rows, PAYONEER_ALIASES, 4)
    if (!m) continue
    if (!forceMatch && !matchedAny && !isPayoneerMatch(`${fileName} ${sName}`, rows, m[0], m[1])) continue
    const [hdrIdx, colMap] = m
    if (!('amount' in colMap)) continue
    matchedAny = true

    for (const r of rows.slice(hdrIdx + 1)) {
      const dateStr = cell(r, colMap.date)
      const desc = cell(r, colMap.desc)
      const txType = cell(r, colMap.tx_type)
      const counterparty = cell(r, colMap.counterparty)
      if (!dateStr && !desc && !txType) continue
      if (isTotalOrSummaryRow(dateStr, txType, counterparty, desc, cell(r, colMap.tx_id))) continue
      const ccy = normalizeWalletCurrency(cell(r, colMap.currency))
      const signedAmt = parseAmount(cell(r, colMap.amount))
      const feeAmt = parseAmount(cell(r, colMap.fee))
      const expectedNet = 'net' in colMap && cell(r, colMap.net) !== '' ? parseAmount(cell(r, colMap.net)) : null
      if (signedAmt === 0n && feeAmt === 0n && (expectedNet === null || expectedNet === 0n)) continue

      const bucket = ensureBucket(ccy)
      bucket.summary.rawRowCount += 1
      if (dateStr) bucket.dates.push(dateStr)
      classifyAndApplyWalletRow(bucket, {
        txId: cell(r, colMap.tx_id),
        txType,
        counterparty,
        desc,
        status: cell(r, colMap.status),
        signedAmt,
        feeAmt,
        expectedNet,
      })
    }
  }
  return byCcy.size > 0 ? finalizeWalletBuckets(byCcy) : null
}

// ── 11. 空中云汇 Airwallex 结汇流水解析器（Balance Activity / Wallet CSV / XLSX 多工作表） ──
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
  balance: ['balance', 'closing balance', '账户余额', '余额'],
}

export function isAirwallexMatch(fileName, rows, hdrIdx, colMap) {
  const fn = fileName.toLowerCase()
  if (/worldfirst|万里汇|payoneer|派安盈/.test(fn)) return false
  if (/airwallex|空中云汇|云汇/.test(fn)) return true
  if (!('date' in colMap && 'currency' in colMap && ('amount' in colMap || 'net' in colMap))) return false
  const hdrLine = (rows[hdrIdx] || []).map((c) => String(c ?? '').toLowerCase()).join(' ')
  if (hdrLine.includes('financial transaction type') || hdrLine.includes('wallet currency')) return true
  for (let i = Math.max(0, hdrIdx - 5); i < Math.min(rows.length, hdrIdx + 25); i++) {
    const line = rows[i].map((c) => String(c ?? '').toLowerCase()).join(' ')
    if (/airwallex|空中云汇|global_account_deposit|borderless_card|card_purchase|\bawx[-_]/i.test(line)) return true
  }
  return false
}

export function parseAirwallexSheets(fileName, sheets, formatInfo, forceMatch = false) {
  const byCcy = new Map()
  let matchedAny = false
  const ensureBucket = (ccy) => {
    if (!byCcy.has(ccy)) {
      byCcy.set(ccy, {
        dates: [],
        summary: makeWalletSummary({
          platform: 'Airwallex',
          currency: ccy,
          formatLabel: `空中云汇 Airwallex 结汇流水 (${formatInfo})`,
          fileName,
        }),
      })
    }
    return byCcy.get(ccy)
  }

  for (const [sName, rows] of sheets) {
    if (sheets.length > 1 && SUMMARY_SHEET_RE.test(sName) && !/detail|tx|明细|流水/i.test(sName)) continue
    const m = findHeaderRow(rows, AIRWALLEX_ALIASES, 4)
    if (!m) continue
    if (!forceMatch && !matchedAny && !isAirwallexMatch(`${fileName} ${sName}`, rows, m[0], m[1])) continue
    const [hdrIdx, colMap] = m
    if (!('amount' in colMap || 'net' in colMap)) continue
    matchedAny = true

    for (const r of rows.slice(hdrIdx + 1)) {
      const dateStr = cell(r, colMap.date)
      const txType = cell(r, colMap.tx_type)
      const counterparty = cell(r, colMap.counterparty)
      const desc = cell(r, colMap.desc)
      if (!dateStr && !txType && !counterparty && !desc) continue
      if (isTotalOrSummaryRow(dateStr, txType, counterparty, desc, cell(r, colMap.tx_id))) continue
      const ccy = normalizeWalletCurrency(cell(r, colMap.currency))
      const hasAmtCell = 'amount' in colMap && cell(r, colMap.amount) !== ''
      const hasNetCell = 'net' in colMap && cell(r, colMap.net) !== ''
      const netOnly = !hasAmtCell && hasNetCell
      const rawAmt = hasAmtCell ? parseAmount(cell(r, colMap.amount)) : parseAmount(cell(r, colMap.net))
      const feeAmt = parseAmount(cell(r, colMap.fee))
      const expectedNet = hasAmtCell && hasNetCell ? parseAmount(cell(r, colMap.net)) : null
      if (rawAmt === 0n && feeAmt === 0n && (expectedNet === null || expectedNet === 0n)) continue

      const bucket = ensureBucket(ccy)
      bucket.summary.rawRowCount += 1
      if (dateStr) bucket.dates.push(dateStr)
      classifyAndApplyWalletRow(bucket, {
        txId: cell(r, colMap.tx_id),
        txType,
        counterparty,
        desc,
        status: cell(r, colMap.status),
        signedAmt: rawAmt,
        feeAmt,
        expectedNet,
        netOnly,
      })
    }
  }
  return byCcy.size > 0 ? finalizeWalletBuckets(byCcy) : null
}

// ── v0.8 结汇收款沙盒样本（与 demo:all 平台放款形成完整三段资金链交叉核对） ──
export const V8_DEMO_SAMPLES = {
  worldfirst: [
    'Demo_WorldFirst_USD_202611.csv',
    [
      '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,状态',
      '2026-11-19,WF-20261119-01,平台回款,Amazon.com Services LLC,Amazon US Settlement SET-901,USD,33450.00,0.00,0.00,Completed',
      '2026-11-21,WF-20261121-02,结汇提现,深圳星海跨境科技有限公司(对公基本户),货款结汇回流对公户,USD,0.00,26000.00,78.00,Completed',
      '2026-11-22,WF-20261122-03,余额直付,YunExpress Logistics Ltd,头程物流费余额支付,USD,0.00,3200.00,0.00,Completed',
      '2026-11-23,WF-20261123-04,内部换汇,WorldFirst FX Conversion,USD to HKD internal conversion,USD,0.00,1000.00,0.00,Completed',
    ].join('\n'),
  ],
  payoneer: [
    'Demo_Payoneer_USD_202611.csv',
    [
      'Date,Transaction ID,Type,Description,Counterparty,Currency,Amount,Fee,Status',
      '2026-11-20,PY-880101,Incoming,Payment from Temu US Whaleco Inc,Temu US,USD,30000.00,0.00,Completed',
      '2026-11-22,PY-880102,Withdrawal,Withdraw to Bank Account,"Shenzhen Xinghai Trading Co., Ltd.",USD,-22000.00,220.00,Completed',
      '2026-11-23,PY-880103,Withdrawal,Withdraw to Personal Bank Account,Zhang San Personal Account,USD,-5000.00,50.00,Completed',
      '2026-11-24,PY-880104,Incoming,Payment from Temu US Pending,Temu US,USD,1200.00,0.00,Pending',
    ].join('\n'),
  ],
  airwallex: [
    'Demo_Airwallex_EUR_202611.csv',
    [
      'Transaction Date,Transaction ID,Financial Transaction Type,Beneficiary,Description,Currency,Amount,Fee,Status',
      '2026-11-16,AWX-9901,GLOBAL_ACCOUNT_DEPOSIT,Shopify Payments EU,Shopify Payout PO-EU-1,EUR,11640.00,0.00,SETTLED',
      '2026-11-18,AWX-9902,PAYOUT,"Shenzhen Xinghai E-commerce Co., Ltd.",Corporate CNY repatriation,EUR,-7500.00,35.00,SETTLED',
      '2026-11-19,AWX-9903,CARD_PURCHASE,Meta Platforms Ireland,Airwallex Borderless Card Facebook Ads,EUR,-2400.00,0.00,SETTLED',
      '2026-11-20,AWX-9904,FX_CONVERSION,Airwallex Treasury,Internal FX EUR to USD,EUR,-800.00,0.00,SETTLED',
    ].join('\n'),
  ],
}

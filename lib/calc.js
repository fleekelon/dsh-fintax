// 确定性税额与对账试算引擎（7 大场景）。所有政策参数均可由调用方显式覆盖；
// 默认值按现行政策填写，但政策会变——工作流要求先经知识库/权威来源核对再出结论。
// 本模块只做算术与结构化勾稽，不构成纳税申报依据。

const round2 = (x) => Math.round(x * 100) / 100

/** 解析必填数字参数：拒绝 null / undefined / 空字符串 / 布尔值 / 对象 / NaN。 */
function reqNum(raw, errMsg, { allowZero = true } = {}) {
  if (
    raw === undefined ||
    raw === null ||
    typeof raw === 'boolean' ||
    typeof raw === 'object' ||
    (typeof raw === 'string' && raw.trim() === '')
  ) {
    throw new Error(errMsg)
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
    throw new Error(errMsg)
  }
  return n
}

/** 解析可选非负数字参数：undefined / null / 空字符串时回退到 fallback；其余非法值抛错。 */
function optNum(raw, fallback, name) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return fallback
  }
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw new Error(`${name} 必须是非负数字`)
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} 必须是非负数字`)
  }
  return n
}

/** 解析可选带符号数字参数（允许正负调节项，如跨期调增/调减、准备金释放）。 */
function optSignedNum(raw, fallback, name) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return fallback
  }
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw new Error(`${name} 必须是有效数字`)
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`${name} 必须是有效数字`)
  }
  return n
}

/**
 * 场景 1：跨境电商零售进口综合税（限额内优惠口径）。
 */
export function crossBorderImport(p = {}) {
  const price = reqNum(p?.price, 'price 必须是非负数字（完税价格，元）')
  const vatRate = optNum(p?.vatRate, 0.13, 'vatRate')
  const ctr = optNum(p?.consumptionTaxRate, 0, 'consumptionTaxRate')
  const discount = optNum(p?.discount, 0.7, 'discount')
  const singleLimit = optNum(p?.singleLimit, 5000, 'singleLimit')
  const annualLimit = optNum(p?.annualLimit, 26000, 'annualLimit')
  const annualUsed = optNum(p?.annualUsed, 0, 'annualUsed')
  if (vatRate > 1 || ctr > 1 || discount > 1) throw new Error('税率/征收比例应为 0~1 的小数（如 13% 传 0.13）')
  if (ctr >= 1) throw new Error('consumptionTaxRate（消费税税率）必须小于 1')

  const warnings = []
  const overSingle = price > singleLimit
  const overAnnual = annualUsed + price > annualLimit
  if (overSingle) warnings.push(`单次交易 ${price} 元超过限值 ${singleLimit} 元`)
  if (overAnnual) warnings.push(`年度累计 ${round2(annualUsed + price)} 元超过限值 ${annualLimit} 元`)
  if (overSingle || overAnnual) {
    warnings.push('超限交易按一般贸易进口管理（全额关税+增值税+消费税），不适用本试算的限额内优惠口径；需另行取得关税税率后核算。')
  }

  const steps = []
  let taxBase = price
  let consumptionTax = 0
  if (ctr > 0) {
    taxBase = price / (1 - ctr)
    steps.push(`组成计税价格 = 完税价格 ÷ (1 − 消费税税率) = ${price} ÷ (1 − ${ctr}) = ${round2(taxBase)} 元`)
    consumptionTax = taxBase * ctr
    steps.push(`消费税（法定）= 组成计税价格 × ${ctr} = ${round2(consumptionTax)} 元`)
  }
  const vatAmt = taxBase * vatRate
  steps.push(`增值税（法定）= ${ctr > 0 ? '组成计税价格' : '完税价格'} × ${vatRate} = ${round2(vatAmt)} 元`)
  const statutory = consumptionTax + vatAmt
  const payable = statutory * discount
  steps.push(`应纳税额 = (消费税 + 增值税) × ${discount * 100}% = ${round2(statutory)} × ${discount} = ${round2(payable)} 元`)
  if (ctr === 0) {
    steps.push(`简化口径：综合税率 = ${vatRate} × ${discount} = ${(vatRate * discount * 100).toFixed(2)}%`)
  }

  return {
    scenario: '跨境电商零售进口综合税（限额内优惠口径）',
    price: round2(price),
    taxBase: round2(taxBase),
    consumptionTaxStatutory: round2(consumptionTax),
    vatStatutory: round2(vatAmt),
    discount,
    taxPayable: round2(payable),
    effectiveRate: price > 0 ? `${((payable / price) * 100).toFixed(2)}%` : '—',
    withinLimit: !overSingle && !overAnnual,
    steps,
    warnings,
    policyRefs: [
      { ref: '财关税〔2016〕18号', note: '限额内关税税率暂设为0，进口环节增值税、消费税按法定应纳税额的70%征收' },
      { ref: '财关税〔2018〕49号', note: '单次交易限值提高至5000元、年度交易限值提高至26000元，2019-01-01起执行' },
    ],
  }
}

/**
 * 场景 2：增值税价税分离 / 税额试算（一般计税口径）。
 */
export function vat(p = {}) {
  const amount = reqNum(p?.amount, 'amount 必须是非负数字（元）')
  const rate = optNum(p?.rate, 0.13, 'rate')
  const inclusive = p?.inclusive !== false
  if (rate > 1) throw new Error('rate 必须是 0~1 的小数（如 13% 传 0.13）')

  const net = inclusive ? amount / (1 + rate) : amount
  const tax = net * rate
  const gross = net + tax
  return {
    scenario: inclusive ? '增值税价税分离（含税价拆分）' : '增值税税额计算（不含税价）',
    rate,
    netAmount: round2(net),
    taxAmount: round2(tax),
    grossAmount: round2(gross),
    steps: inclusive
      ? [`不含税价 = ${amount} ÷ (1 + ${rate}) = ${round2(net)} 元`, `税额 = ${round2(net)} × ${rate} = ${round2(tax)} 元`]
      : [`税额 = ${amount} × ${rate} = ${round2(tax)} 元`, `价税合计 = ${amount} + ${round2(tax)} = ${round2(gross)} 元`],
    warnings: ['税率与征收方式（一般计税/简易计税/免税）需按业务实质和现行政策确认，本试算不替代申报。'],
    policyRefs: [
      { ref: '《中华人民共和国增值税法》', note: '2026-01-01起施行；税率结构（13%/9%/6%等）按现行规定，具体适用以税法及衔接公告为准' },
    ],
  }
}

/** 统一入口：按 scenario 分发。 */
export function calculate(scenario, params) {
  switch (scenario) {
    case 'cross_border_import':
      return crossBorderImport(params)
    case 'vat':
      return vat(params)
    case 'annual_bonus_iit':
      return annualBonusIit(params)
    case 'export_rebate':
      return exportRebate(params)
    case 'cbec_assessed_cit':
      return cbecAssessedCit(params)
    case 'export_invoice_breakeven':
      return exportInvoiceBreakeven(params)
    case 'platform_tax_reconcile':
      return platformTaxReconcile(params)
    default:
      throw new Error(
        `未知 scenario：${scenario}。支持：cross_border_import（跨境进口综合税）、vat（增值税）、annual_bonus_iit（年终奖个税）、export_rebate（外贸出口免退税）、cbec_assessed_cit（综试区4%核定所得税）、export_invoice_breakeven（开票加点拿票退税vs无票免税临界测算）、platform_tax_reconcile（平台涉税报送四层口径差额桥接核对）。`,
      )
  }
}

// ── 场景 3：年终奖单独计税 ────────────────────────────────────
const BONUS_BRACKETS = [
  { monthlyUpTo: 3000, rate: 0.03, quick: 0 },
  { monthlyUpTo: 12000, rate: 0.10, quick: 210 },
  { monthlyUpTo: 25000, rate: 0.20, quick: 1410 },
  { monthlyUpTo: 35000, rate: 0.25, quick: 2660 },
  { monthlyUpTo: 55000, rate: 0.30, quick: 4410 },
  { monthlyUpTo: 80000, rate: 0.35, quick: 7160 },
  { monthlyUpTo: Infinity, rate: 0.45, quick: 15160 },
]

function bonusTax(bonus) {
  const monthly = bonus / 12
  const b = BONUS_BRACKETS.find((x) => monthly <= x.monthlyUpTo)
  return { rate: b.rate, quick: b.quick, tax: bonus * b.rate - b.quick }
}

export function annualBonusIit(p = {}) {
  const bonus = reqNum(p?.bonus, 'bonus 必须是正数（全年一次性奖金，元）', { allowZero: false })

  const { rate, quick, tax } = bonusTax(bonus)
  const net = bonus - tax
  const steps = [
    `找档：${bonus} ÷ 12 = ${round2(bonus / 12)} 元/月 → 适用税率 ${rate * 100}%，速算扣除数 ${quick}`,
    `应纳税额 = ${bonus} × ${rate} − ${quick} = ${round2(tax)} 元`,
    `税后奖金 = ${bonus} − ${round2(tax)} = ${round2(net)} 元`,
  ]
  const warnings = [
    '一个纳税年度内，每人只允许使用一次全年一次性奖金单独计税政策。',
    '也可选择并入当年综合所得计税；哪种更优需结合工资、扣除项整体比较，本工具只算单独计税口径。',
  ]

  const idx = BONUS_BRACKETS.findIndex((x) => bonus / 12 <= x.monthlyUpTo)
  let trap = null
  if (idx > 0) {
    const boundary = BONUS_BRACKETS[idx - 1].monthlyUpTo * 12
    if (bonus > boundary) {
      const netAtBoundary = boundary - bonusTax(boundary).tax
      const cur = BONUS_BRACKETS[idx]
      const breakEven = (netAtBoundary - cur.quick) / (1 - cur.rate)
      if (bonus < breakEven) {
        trap = { boundary, breakEven: round2(breakEven), gainAtBoundary: round2(netAtBoundary - net) }
        warnings.push(
          `⚠ 临界点陷阱：奖金 ${bonus} 元落在 (${boundary}, ${round2(breakEven)}) 陷阱区间——若降到 ${boundary} 元，税后收入反而多 ${round2(netAtBoundary - net)} 元。发放方案建议避开该区间。`,
        )
      }
    }
  }

  return {
    scenario: '全年一次性奖金单独计税（个人所得税）',
    bonus: round2(bonus),
    rate,
    quickDeduction: quick,
    taxPayable: round2(tax),
    afterTax: round2(net),
    effectiveRate: `${((tax / bonus) * 100).toFixed(2)}%`,
    trap,
    steps,
    warnings,
    policyRefs: [
      { ref: '财政部 税务总局公告2023年第30号', note: '全年一次性奖金单独计税政策延续实施至2027-12-31' },
      { ref: '国税发〔2005〕9号', note: '全年一次性奖金计税方法的基础规定（除以12找档）' },
      { ref: '财税〔2018〕164号', note: '按月换算后的综合所得税率表' },
    ],
  }
}

// ── 场景 4：外贸企业出口退税（免退税） ──────────────────────
export function exportRebate(p = {}) {
  const purchaseAmount = reqNum(p?.purchaseAmount, 'purchaseAmount 必须是正数（增值税专用发票注明的不含税金额，元）', { allowZero: false })
  const vatRate = optNum(p?.vatRate, 0.13, 'vatRate')
  const rebateRate = optNum(p?.rebateRate, vatRate, 'rebateRate')
  for (const [name, v] of Object.entries({ vatRate, rebateRate })) {
    if (v > 1) throw new Error(`${name} 必须是 0~1 的小数（如 13% 传 0.13）`)
  }

  const effectiveRate = Math.min(vatRate, rebateRate)
  const refund = purchaseAmount * effectiveRate
  const nonRefundable = purchaseAmount * (vatRate - effectiveRate)
  const steps = [
    `计税依据 = 专票不含税金额 = ${purchaseAmount} 元（不是价税合计，也不是出口售价）`,
    `实际退税率 = min(发票税率 ${vatRate}, 商品退税率 ${rebateRate}) = ${effectiveRate}${effectiveRate < rebateRate ? '（孰低规则：从小规模纳税人购进/简易征税货物等情形）' : ''}`,
    `应退增值税 = ${purchaseAmount} × ${effectiveRate} = ${round2(refund)} 元`,
  ]
  if (nonRefundable > 0) {
    steps.push(`征退税率差转成本 = ${purchaseAmount} × (${vatRate} − ${effectiveRate}) = ${round2(nonRefundable)} 元（进项税额转出，计入主营业务成本）`)
  }

  return {
    scenario: '外贸企业出口退税（免退税办法）',
    purchaseAmount: round2(purchaseAmount),
    vatRate,
    rebateRate,
    effectiveRebateRate: effectiveRate,
    taxRefund: round2(refund),
    nonRefundableToCost: round2(nonRefundable),
    steps,
    warnings: [
      '退税率必须按商品代码在出口退税率文库核对（部分商品退税率被调低或取消，如2026年第29号公告等调整）；本工具默认退税率=适用税率仅是缺省口径。',
      '生产企业出口自产货物适用免抵退税（按离岸价计算），本办法不支持，请勿混用。',
      '9810 出口海外仓货物可按"离境即退税、销售再核算"在报关离境后申请出口预退税（国家税务总局公告2025年第3号），后续按实际销售核算。',
      '申报期限与逾期分类处理（财政部 税务总局公告2026年第11号、国家税务总局公告2026年第5号）：须区分第六条适用增值税免税情形（如已申报退免税但未在规定期限内补齐有关凭证等，进项转成本，不得一刀切概括为征税）与第七条适用征税情形（取消退免税货物、虚假业务、伪造单证、特定逾期未核销等列明项），须对照公告原文逐项核实。',
    ],
    policyRefs: [
      { ref: '财政部 税务总局公告2026年第11号', note: '出口业务增值税和消费税政策，2026-01-01起施行；第五条免退税计算、第六条免税情形、第七条征税情形' },
      { ref: '国家税务总局公告2026年第5号', note: '《出口业务增值税和消费税退（免）税管理办法》' },
      { ref: '国家税务总局公告2025年第3号', note: '9810 出口海外仓"离境即退税、销售再核算"' },
    ],
  }
}

// ── 场景 5：综试区零售出口核定征收企业所得税 ────────────────
export function cbecAssessedCit(p = {}) {
  const revenue = reqNum(p?.revenue, 'revenue 必须是非负数字（收入总额，元）')
  const taxableIncomeRate = optNum(p?.taxableIncomeRate, 0.04, 'taxableIncomeRate')
  const citRate = optNum(p?.citRate, 0.25, 'citRate')
  const smallLowProfit = p?.smallLowProfit === true
  for (const [name, v] of Object.entries({ taxableIncomeRate, citRate })) {
    if (v > 1) throw new Error(`${name} 必须是 0~1 的小数`)
  }

  const taxableIncome = revenue * taxableIncomeRate
  let effectiveCitRate = citRate
  const steps = [`应纳税所得额 = 收入总额 ${revenue} × 应税所得率 ${taxableIncomeRate} = ${round2(taxableIncome)} 元`]
  const warnings = [
    '适用前提（须全部满足并经税务机关事前鉴定）：①综试区注册并在当地线上综合服务平台登记出口信息；②通过综试区海关办理电商出口申报；③出口货物未取得有效进货凭证、享受增值税/消费税免税（无票免税）。',
    '核定征收是需申请鉴定的事前安排，不是自动适用；收入总额必须准确核算。',
    '9810 海外仓模式在国家明文层面未纳入核定征收范围，2026 年执行口径趋严（海外仓卖家普遍转向查账征收）——务必先与主管税务机关确认。',
  ]
  if (smallLowProfit) {
    if (taxableIncome <= 3_000_000) {
      effectiveCitRate = 0.05
      steps.push(`小型微利优惠：应纳税所得额 ≤ 300万，减按25%计入、按20%税率 → 实际税负 5%`)
      warnings.push('小微条件须同时满足：从业人数≤300人、资产总额≤5000万、非限制禁止行业；本工具按用户已确认处理。')
    } else {
      warnings.push(`应纳税所得额 ${round2(taxableIncome)} 元超过300万（对应4%所得率下7500万营收红线），丧失小微优惠，全额按 ${citRate * 100}% 计算。`)
    }
  }
  const tax = taxableIncome * effectiveCitRate
  steps.push(`应纳企业所得税 = ${round2(taxableIncome)} × ${effectiveCitRate} = ${round2(tax)} 元`)

  return {
    scenario: '综试区零售出口企业核定征收企业所得税',
    revenue: round2(revenue),
    taxableIncomeRate,
    taxableIncome: round2(taxableIncome),
    citRateApplied: effectiveCitRate,
    taxPayable: round2(tax),
    effectiveRateOnRevenue: revenue > 0 ? `${((tax / revenue) * 100).toFixed(2)}%` : '—',
    steps,
    warnings,
    policyRefs: [
      { ref: '国家税务总局公告2019年第36号', note: '综试区零售出口企业所得税核定征收，应税所得率统一4%，2020-01-01起施行' },
      { ref: '财税〔2018〕103号', note: '综试区零售出口"无票免税"（增值税、消费税免税）前提政策' },
      { ref: '财政部 税务总局公告2023年第12号', note: '小型微利企业实际5%税负，执行至2027-12-31' },
    ],
  }
}

// ── 场景 6：供应商开票加点「拿专票退税 vs 合规无票免税」毛利临界测算 ──
/**
 * 外贸/跨境卖家采购比选：供应商不含税裸价基础上开专票加收 supplierMarkupRate 税点，
 * 测算加点拿专票走出口免退税 vs 合规无票免税（综试区103号文 / 1039市场采购）的净现金流成本与盈亏临界加点率 g*，
 * 可选传入出口销售收入 exportRevenue 进一步联动测算两边企业所得税后综合净利对比。
 *
 * @param {object} p
 * @param {number} p.barePurchaseAmount 不含税裸价采购总额 P0，元
 * @param {number} p.supplierMarkupRate 供应商开专票加点比例 g（0~1小数，如加8个点传 0.08）
 * @param {number} [p.vatRate=0.13] 增值税专票税率 t（0~1小数）
 * @param {number} [p.rebateRate=vatRate] 商品出口退税率 r（0~1小数，须按HS编码核对）
 * @param {number} [p.exportRevenue] 可选：对应出口销售收入（人民币，元），传入时联动对比企业所得税后综合净利
 * @param {number} [p.otherDeductibleExpenses=0] 可选：头程物流、平台佣金等有合规凭证可税前扣除的其他费用，元
 * @param {number} [p.invoicedCitRate=0.05] 可选：拿票查账征收适用企业所得税率（默认小微5%=0.05，非小微传0.25）
 * @param {number} [p.noInvoiceRevenueCitRate=0.002] 可选：合规无票路径按营业收入折算的所得税负率（默认综试区4%×小微5%=0.002；标准4%×25%传0.01）
 */
export function exportInvoiceBreakeven(p = {}) {
  const bare = reqNum(p?.barePurchaseAmount, 'barePurchaseAmount 必须是正数（不含税裸价采购金额，元）', { allowZero: false })
  const markup = reqNum(p?.supplierMarkupRate, 'supplierMarkupRate 必须是非负小数（供应商开票加点率，如加8%传 0.08）')
  const vatRate = optNum(p?.vatRate, 0.13, 'vatRate')
  const rebateRate = optNum(p?.rebateRate, vatRate, 'rebateRate')
  const otherExp = optNum(p?.otherDeductibleExpenses, 0, 'otherDeductibleExpenses')
  const invoicedCitRate = optNum(p?.invoicedCitRate, 0.05, 'invoicedCitRate')
  const noInvoiceRevCitRate = optNum(p?.noInvoiceRevenueCitRate, 0.002, 'noInvoiceRevenueCitRate')

  for (const [name, v] of Object.entries({ markup, vatRate, rebateRate, invoicedCitRate, noInvoiceRevCitRate })) {
    if (v > 1) throw new Error(`${name} 必须是 0~1 的小数（如 8% 传 0.08，13% 传 0.13）`)
  }

  const effRebate = Math.min(vatRate, rebateRate)
  // 增值税现金流盈亏临界加点率: 1 + g* = (1 + t) / (1 + t - r) => g* = r / (1 + t - r)
  const breakevenMarkup = effRebate / (1 + vatRate - effRebate)

  const grossPaid = bare * (1 + markup)
  const invoiceExclTax = grossPaid / (1 + vatRate)
  const invoiceVat = invoiceExclTax * vatRate
  const vatRefund = invoiceExclTax * effRebate
  const nonRefundableVat = invoiceExclTax * (vatRate - effRebate)
  const deductiblePurchaseCost = invoiceExclTax + nonRefundableVat
  const netCashCostInvoiced = grossPaid - vatRefund
  const netCashCostNoInvoice = bare
  const cashSavingWithInvoice = netCashCostNoInvoice - netCashCostInvoiced

  const steps = [
    `增值税现金流临界加点率 g* = 实际退税率 ${effRebate} ÷ (1 + 专票税率 ${vatRate} − 实际退税率 ${effRebate}) = ${(breakevenMarkup * 100).toFixed(2)}%`,
    `路径A（加点 ${(markup * 100).toFixed(2)}% 拿专票退税）：含税采购支出 = ${bare} × (1 + ${markup}) = ${round2(grossPaid)} 元`,
    `专票价税分离：不含税金额 = ${round2(grossPaid)} ÷ (1 + ${vatRate}) = ${round2(invoiceExclTax)} 元，进项税额 = ${round2(invoiceVat)} 元`,
    `应退增值税 = ${round2(invoiceExclTax)} × ${effRebate} = ${round2(vatRefund)} 元${nonRefundableVat > 0 ? `；征退税率差转成本 = ${round2(nonRefundableVat)} 元` : ''}`,
    `路径A 退税后净采购成本 = ${round2(grossPaid)} − ${round2(vatRefund)} = ${round2(netCashCostInvoiced)} 元（可税前扣除采购成本 = ${round2(deductiblePurchaseCost)} 元）`,
    `路径B（合规无票免税裸采）：净采购成本 = ${round2(netCashCostNoInvoice)} 元（增值税免征不退）`,
    cashSavingWithInvoice >= 0
      ? `采购端对比结论：开票加点 ${(markup * 100).toFixed(2)}% 低于临界点 ${(breakevenMarkup * 100).toFixed(2)}%，拿专票退税比无票裸采直接少花 ${round2(cashSavingWithInvoice)} 元！`
      : `采购端对比结论：开票加点 ${(markup * 100).toFixed(2)}% 高于增值税临界点 ${(breakevenMarkup * 100).toFixed(2)}%，仅看增值税退税比裸采多支出 ${round2(-cashSavingWithInvoice)} 元（需继续结合企业所得税扣除条件判断）。`,
  ]

  let citComparison = null
  const hasRev = p?.exportRevenue !== undefined && p?.exportRevenue !== null && String(p.exportRevenue).trim() !== ''
  if (hasRev) {
    const rev = reqNum(p.exportRevenue, 'exportRevenue 必须是正数（出口销售收入，元）', { allowZero: false })
    const bookProfitA = rev - deductiblePurchaseCost - otherExp
    const citA = Math.max(0, bookProfitA) * invoicedCitRate
    const netProfitA = rev - netCashCostInvoiced - otherExp - citA

    const citB = rev * noInvoiceRevCitRate
    const netProfitB = rev - netCashCostNoInvoice - otherExp - citB
    const netProfitDiff = netProfitA - netProfitB

    citComparison = {
      exportRevenue: round2(rev),
      invoicedCitPayable: round2(citA),
      invoicedAfterTaxProfit: round2(netProfitA),
      noInvoiceAssessedCitPayable: round2(citB),
      noInvoiceAfterTaxProfit: round2(netProfitB),
      afterTaxAdvantageOfInvoice: round2(netProfitDiff),
    }
    steps.push(
      `联动所得税对比（出口营收 ${round2(rev)} 元）：路径A查账所得税 ${round2(citA)} 元，税后净利 ${round2(netProfitA)} 元；路径B（假设合法适用核定税负 ${(noInvoiceRevCitRate * 100).toFixed(2)}%）所得税 ${round2(citB)} 元，税后净利 ${round2(netProfitB)} 元 → 拿票路径综合税后${netProfitDiff >= 0 ? `多赚 ${round2(netProfitDiff)}` : `少赚 ${round2(-netProfitDiff)}`} 元`,
    )
  }

  const warnings = [
    '路径B（合规无票免税）并非无门槛：须严格满足综试区零售出口无票免税（财税〔2018〕103号）或 1039 市场采购贸易试点集聚区真实采购条件；若不满足免税/核定条件而走查账征收，无票采购成本面临无法在企业所得税前扣除的重大风险！',
    '出口退税存在报关、收汇、单证备案及审核账期，实际决策时还应考虑退税周期的资金占用成本，并按 HS 编码逐品核对最新出口退税率。',
  ]

  return {
    scenario: '供应商开票加点「拿专票退税 vs 合规无票免税」毛利临界测算',
    barePurchaseAmount: round2(bare),
    supplierMarkupRate: markup,
    vatRate,
    effectiveRebateRate: effRebate,
    breakevenMarkupRate: `${(breakevenMarkup * 100).toFixed(2)}%`,
    invoicedGrossOutflow: round2(grossPaid),
    invoiceExclTaxAmount: round2(invoiceExclTax),
    taxRefund: round2(vatRefund),
    nonRefundableVatToCost: round2(nonRefundableVat),
    netCashCostInvoiced: round2(netCashCostInvoiced),
    netCashCostNoInvoice: round2(netCashCostNoInvoice),
    cashSavingWithInvoice: round2(cashSavingWithInvoice),
    citComparison,
    summaryLine:
      cashSavingWithInvoice >= 0
        ? `增值税临界加点率 ${(breakevenMarkup * 100).toFixed(2)}%，当前加点 ${(markup * 100).toFixed(2)}%：拿专票退税净采购成本 ${round2(netCashCostInvoiced)} 元，比无票裸采净省 ${round2(cashSavingWithInvoice)} 元（应退增值税 ${round2(vatRefund)} 元）`
        : `增值税临界加点率 ${(breakevenMarkup * 100).toFixed(2)}%，当前加点 ${(markup * 100).toFixed(2)}%：拿专票退税净采购成本 ${round2(netCashCostInvoiced)} 元，比无票裸采高 ${round2(-cashSavingWithInvoice)} 元（应退增值税 ${round2(vatRefund)} 元）`,
    steps,
    warnings,
    policyRefs: [
      { ref: '财政部 税务总局公告2026年第11号', note: '外贸企业出口免退税计税依据与征退税率差处理规则' },
      { ref: '财税〔2018〕103号 / 国家税务总局公告2019年第36号', note: '综试区零售出口无票免税与经事前鉴定的企业所得税4%应税所得率核定' },
    ],
  }
}

// ── 场景 7：平台涉税信息报送 vs 结算放款 vs 纳税申报 四层口径差额桥接核对 ──
/**
 * 针对互联网平台涉税信息常态化报送（国家税务总局公告2025年第15号），
 * 对「平台报送收入总额」「平台结算实际放款」「企业已申报销售额」进行结构化差额拆解与异常排雷。
 *
 * @param {object} p
 * @param {number} p.reportedGrossRevenue 平台涉税报送的收入总额，元
 * @param {number} [p.refunds=0] 当期买家退款/退货冲回金额，元
 * @param {number} [p.marketplaceWithheldTax=0] 平台代收代缴境外消费税/VAT流转税，元
 * @param {number} [p.cutoffAndFxDiff=0] 跨期发货/报关离境时点调减及汇率折算差额，元（调减传正数，调增传负数）
 * @param {number} [p.platformFees=0] 平台佣金、FBA仓储物流费、广告费、支付手续费合计，元
 * @param {number} [p.subsidies=0] 平台补贴/赔付金额，元
 * @param {number} [p.reserveChange=0] 店铺保证金/准备金净增加额，元（释放传负数）
 * @param {number} [p.actualPayout] 可选：平台/支付机构实际放款到账金额，元（传入则执行资金链轧平校验）
 * @param {number} [p.declaredVatSales] 可选：企业当期实际已申报增值税/出口销售额，元（传入则执行申报缺口与净额法误报诊断）
 * @param {string} [p.principalRole='principal'] 'principal'（主要责任人，总额法）| 'agent'（代理人，净额法）
 */
export function platformTaxReconcile(p = {}) {
  const gross = reqNum(p?.reportedGrossRevenue, 'reportedGrossRevenue 必须是非负数字（平台报送收入总额，元）')
  const refunds = optNum(p?.refunds, 0, 'refunds')
  const withheldTax = optNum(p?.marketplaceWithheldTax, 0, 'marketplaceWithheldTax')
  const cutoffFx = optSignedNum(p?.cutoffAndFxDiff, 0, 'cutoffAndFxDiff')
  const fees = optNum(p?.platformFees, 0, 'platformFees')
  const subsidies = optNum(p?.subsidies, 0, 'subsidies')
  const reserve = optSignedNum(p?.reserveChange, 0, 'reserveChange')
  const role = p?.principalRole === 'agent' ? 'agent' : 'principal'

  const reportedNet = gross - refunds
  const legitAdjustments = refunds + withheldTax + cutoffFx
  const referenceGrossSales = gross - legitAdjustments

  const steps = [
    `【第一层：平台报送口径】报送收入总额 = ${round2(gross)} 元，减当期退款 ${round2(refunds)} 元 → 报送口径收入净额 = ${round2(reportedNet)} 元（依税总2025年第15号公告，平台佣金与服务费不从报送收入中扣除）`,
    `【第二层：跨口径桥接调减】退款冲回 ${round2(refunds)} 元 + 平台代扣境外流转税 ${round2(withheldTax)} 元 + 跨期离境与汇率折算差 ${round2(cutoffFx)} 元 = 合法口径/时点调减合计 ${round2(legitAdjustments)} 元`,
  ]

  if (role === 'principal') {
    steps.push(
      `【总额法参考销售口径（主要责任人）】= 报送总额 ${round2(gross)} − 桥接调减 ${round2(legitAdjustments)} = ${round2(referenceGrossSales)} 元${subsidies > 0 ? `（另有平台补贴/赔付 ${round2(subsidies)} 元，须按补贴对象与经济实质单独判断计入收入或冲减费用）` : ''}；平台佣金及履约费 ${round2(fees)} 元应单独列支成本费用，严禁直接冲减销售收入！`,
    )
  } else {
    steps.push(
      `【净额法提示（代理人模式）】仅当合同与实际履约证明卖方转让前未控制商品、不承担存货与主要售后风险时，方可按净佣金确认会计收入，须留存《企业会计准则第14号》代理人判断备忘录。`,
    )
  }

  const warnings = []
  let payoutReconciliation = null
  let declarationDiagnosis = null

  const hasPayout = p?.actualPayout !== undefined && p?.actualPayout !== null && String(p.actualPayout).trim() !== ''
  if (hasPayout) {
    const actualPayout = reqNum(p.actualPayout, 'actualPayout 必须是非负数字（实际放款到账金额，元）')
    // 理论放款 = 报送总额 - 退款 - 代扣境外税 + 补贴赔付 - 平台费用 - 准备金净增加
    const theoreticalPayout = gross - refunds - withheldTax + subsidies - fees - reserve
    const cashGap = theoreticalPayout - actualPayout
    payoutReconciliation = {
      theoreticalPayout: round2(theoreticalPayout),
      actualPayout: round2(actualPayout),
      unexplainedCashGap: round2(cashGap),
    }
    steps.push(
      `【第三层：资金放款轧平】理论放款 = ${round2(gross)} − 退款 ${round2(refunds)} − 代扣税 ${round2(withheldTax)} + 补贴 ${round2(subsidies)} − 平台费用 ${round2(fees)} − 准备金变动 ${round2(reserve)} = ${round2(theoreticalPayout)} 元；对比实际放款 ${round2(actualPayout)} 元 → 放款差额 = ${round2(cashGap)} 元`,
    )
    if (Math.abs(cashGap) > 1) {
      warnings.push(
        `资金链尚有 ${round2(cashGap)} 元未轧平！请继续排查：期初/期末待结算余额变动、跨期在途提现、买家拒付扣款（Chargeback）、广告费信用卡扣款混记或原币折算汇率差。`,
      )
    }
  }

  const hasDeclared = p?.declaredVatSales !== undefined && p?.declaredVatSales !== null && String(p.declaredVatSales).trim() !== ''
  if (hasDeclared) {
    const declared = reqNum(p.declaredVatSales, 'declaredVatSales 必须是非负数字（当期已申报销售额，元）')
    const rawDiff = gross - declared
    const unexplainedSalesGap = referenceGrossSales - declared
    const matchesFeeNettingTrap =
      role === 'principal' && fees > 0 && unexplainedSalesGap > 0 && Math.abs(unexplainedSalesGap - fees) / fees <= 0.15

    declarationDiagnosis = {
      declaredVatSales: round2(declared),
      rawReportingDiff: round2(rawDiff),
      explainedByBridge: round2(legitAdjustments),
      unexplainedSalesGap: round2(unexplainedSalesGap),
      nettingTrapDetected: matchesFeeNettingTrap,
    }

    steps.push(
      `【第四层：增值税/出口申报比对】平台报送 ${round2(gross)} 元 vs 已申报 ${round2(declared)} 元 → 表面总差额 ${round2(rawDiff)} 元；剔除 ${round2(legitAdjustments)} 元口径/时点调减后，待核查申报差额 = ${round2(unexplainedSalesGap)} 元`,
    )

    if (matchesFeeNettingTrap) {
      warnings.push(
        `高危“回款净额报税”预警：待核查申报缺口（${round2(unexplainedSalesGap)} 元）与平台佣金及履约费用（${round2(fees)} 元）高度吻合！主要责任人严禁直接用扣费后的放款净额申报销售额，切勿用“平台扣了佣金和FBA费”向税务机关解释少报收入，请按各税种规定核实并评估更正申报。`,
      )
    } else if (Math.abs(unexplainedSalesGap) > 1) {
      warnings.push(
        `剔除常规口径差后，总额法参考口径与已申报金额仍相差 ${round2(unexplainedSalesGap)} 元，请按主体×监管方式（内销/出口退免税/免税）逐栏核对报关单、出口发票与历史跨期申报表。`,
      )
    }
  }

  warnings.push(
    '资金轧平不等于纳税申报无误：最终增值税（内销/出口退免税/免税）与企业所得税应申报金额，须结合合同履约、报关离境单证与合规扣税凭证分别桥接复核。',
  )

  const summaryParts = [`总额法参考销售口径 ${round2(referenceGrossSales)} 元（已剥离口径/时点调减 ${round2(legitAdjustments)} 元）`]
  if (payoutReconciliation) summaryParts.push(`放款未解释差额 ${payoutReconciliation.unexplainedCashGap} 元`)
  if (declarationDiagnosis) summaryParts.push(`待核查申报缺口 ${declarationDiagnosis.unexplainedSalesGap} 元`)

  return {
    scenario: '平台涉税信息报送 vs 结算放款 vs 纳税申报 四层口径差额桥接核对',
    reportedGrossRevenue: round2(gross),
    reportedNetRevenue: round2(reportedNet),
    legitimateBridgeAdjustments: round2(legitAdjustments),
    referenceGrossSales: round2(referenceGrossSales),
    platformFees: round2(fees),
    payoutReconciliation,
    declarationDiagnosis,
    summaryLine: summaryParts.join('；'),
    steps,
    warnings,
    policyRefs: [
      { ref: '国家税务总局公告2025年第15号', note: '互联网平台企业涉税信息报送规定：收入总额不扣平台佣金、服务费与实际补贴，退款另列' },
      { ref: '《企业会计准则第14号——收入》', note: '主要责任人按总额法确认收入，平台佣金及履约费单独列支成本费用，不得直接冲减收入' },
      { ref: '财政部 税务总局公告2026年第11号', note: '出口业务增值税退（免）税、免税与征税分组申报规则' },
    ],
  }
}

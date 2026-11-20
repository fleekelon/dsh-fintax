// 确定性税额与对账试算引擎（10 大场景）。所有政策参数均可由调用方显式覆盖；
// 默认值按现行政策填写，但政策会变——工作流要求先经知识库/权威来源核对再出结论。
// 本模块只做算术与结构化勾稽，不构成纳税申报依据。

import {
  cbecReturnDutyExempt,
  exportRebateManufacturer,
  vatTaxpayerThreshold,
} from './calc_extra.js'

export { cbecReturnDutyExempt, exportRebateManufacturer, vatTaxpayerThreshold }

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
    case 'cbec_return_duty_exempt':
      return cbecReturnDutyExempt(params)
    case 'export_rebate_manufacturer':
      return exportRebateManufacturer(params)
    case 'vat_taxpayer_threshold':
      return vatTaxpayerThreshold(params)
    default:
      throw new Error(
        `未知 scenario：${scenario}。支持：platform_tax_reconcile（平台涉税报送四层口径桥接）、export_invoice_breakeven（开票加点拿票退税vs无票免税临界测算）、export_rebate（外贸出口免退税）、export_rebate_manufacturer（生产企业免抵退税）、cbec_assessed_cit（综试区4%核定所得税）、cbec_return_duty_exempt（2026年第16号退运免税测算）、vat_taxpayer_threshold（500万一般纳税人临界与拐点测算）、annual_bonus_iit（年终奖个税）、cross_border_import（跨境进口综合税）、vat（增值税）。`,
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
      '9810 海外仓货物报关离境后，未售货物可用 HWC-YT 标识申报出口预退税，已售货物按规定申报出口退（免）税。预退税的核算期自税务机关办结次月1日起至次年4月30日，按销售情况办理核算。',
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
  const revenue = reqNum(p?.revenue, 'revenue 必须是非负数字（同一主体核定口径收入总额，元）')
  const taxableIncomeRate = optNum(p?.taxableIncomeRate, 0.04, 'taxableIncomeRate')
  const citRate = optNum(p?.citRate, 0.25, 'citRate')
  const taxYear = optNum(p?.taxYear, 2026, 'taxYear')
  const annualTaxableIncome = optSignedNum(p?.annualTaxableIncome, null, 'annualTaxableIncome')
  const annualAverageEmployees = optNum(p?.annualAverageEmployees, null, 'annualAverageEmployees')
  const annualAverageAssets = optNum(p?.annualAverageAssets, null, 'annualAverageAssets')
  const nonRestrictedIndustry = p?.nonRestrictedIndustry ?? null
  const assessedQualificationConfirmed = p?.assessedQualificationConfirmed === true
  for (const [name, v] of Object.entries({ taxableIncomeRate, citRate })) {
    if (v > 1) throw new Error(`${name} 必须是 0~1 的小数`)
  }
  if (!Number.isInteger(taxYear) || taxYear < 1) throw new Error('taxYear 必须是有效的纳税年度')
  if (nonRestrictedIndustry !== null && typeof nonRestrictedIndustry !== 'boolean') {
    throw new Error('nonRestrictedIndustry 必须是布尔值')
  }

  const taxableIncome = revenue * taxableIncomeRate
  const incomeForEligibility = annualTaxableIncome ?? taxableIncome
  const withinPolicyYears = taxYear >= 2023 && taxYear <= 2027
  const hasAllEligibilityInputs =
    annualTaxableIncome !== null && annualAverageEmployees !== null && annualAverageAssets !== null && nonRestrictedIndustry !== null
  // 兼容既有调用。true 表示调用方已按主体和纳税年度核验全部条件，明细输入优先参与判定。
  const eligibilityConfirmed = p?.smallLowProfit === true || hasAllEligibilityInputs
  const smallLowProfitApplied =
    p?.smallLowProfit !== false &&
    eligibilityConfirmed &&
    withinPolicyYears &&
    incomeForEligibility <= 3_000_000 &&
    (annualAverageEmployees === null || annualAverageEmployees <= 300) &&
    (annualAverageAssets === null || annualAverageAssets <= 50_000_000) &&
    nonRestrictedIndustry !== false
  const effectiveCitRate = smallLowProfitApplied ? 0.05 : citRate
  const steps = [`核定所得额试算 = 收入总额 ${revenue} × 应税所得率 ${taxableIncomeRate} = ${round2(taxableIncome)} 元`]
  const warnings = [
    '4% 是综试区零售出口核定应税所得率。须在综试区注册并在当地线上综合服务平台登记出口信息、经综试区所在地海关申报电商出口、未取得有效进货凭证且享受增值税和消费税免税，并经主管税务机关鉴定。',
    '9810 海外仓出口预退税按税总2025年第3号办理。企业所得税能否核定，须由主管税务机关按综试区零售出口条件及具体业务另行确认。',
    '小型微利企业的5%实际税负政策执行至2027-12-31。须从事国家非限制和禁止行业，并同时满足同一主体年度应纳税所得额≤300万元、从业人数≤300人、资产总额≤5000万元。其中人数（含劳务派遣用工）和资产按全年各季度平均值计算。',
    '平台报送收入、跨主体汇总和滚动账单只用于风险提示。请用同一主体同一纳税年度的完整数据核对年度应纳税所得额。',
  ]
  if (!assessedQualificationConfirmed) warnings.push('主管税务机关鉴定待确认，本结果按核定征收假设试算。')
  if (taxableIncomeRate === 0.04) {
    warnings.push('7,500万元是按4%应税所得率反推的收入等值，前提是该收入完整覆盖同一主体年度核定口径。')
  } else {
    warnings.push('本次采用自定义应税所得率试算，综试区零售出口核定政策规定的应税所得率为4%。')
  }
  if (annualTaxableIncome === null && p?.smallLowProfit === true) {
    warnings.push('已选择确认全部小型微利条件，本次以核定所得额作为同一主体的全年所得试算；如另有所得或年度调整，请填写年度应纳税所得额。')
  }
  if (incomeForEligibility > 3_000_000) {
    const basis = annualTaxableIncome === null ? '本次核定所得额试算' : '年度应纳税所得额'
    warnings.push(`${basis} ${round2(incomeForEligibility)} 元超过300万元，本次按基准税率试算。`)
  }
  if (!withinPolicyYears) {
    warnings.push(`${taxYear} 纳税年度须另行核对当年小型微利优惠，本次按基准税率试算。`)
  } else if (smallLowProfitApplied) {
    steps.push(`小型微利优惠（${taxYear} 年）：减按25%计入应纳税所得额 × 20%税率 → 实际税负 5%`)
  } else if (incomeForEligibility <= 3_000_000) {
    warnings.push('小型微利条件尚未全部满足或确认，本次按基准税率试算。')
  }
  const tax = taxableIncome * effectiveCitRate
  steps.push(`企业所得税试算 = ${round2(taxableIncome)} × ${effectiveCitRate} = ${round2(tax)} 元`)

  return {
    scenario: '综试区零售出口企业核定征收企业所得税',
    revenue: round2(revenue),
    taxableIncomeRate,
    taxableIncome: round2(taxableIncome),
    taxYear,
    annualTaxableIncome: annualTaxableIncome === null ? null : round2(annualTaxableIncome),
    assessedQualificationConfirmed,
    smallLowProfitApplied,
    citRateApplied: effectiveCitRate,
    taxPayable: round2(tax),
    effectiveRateOnRevenue: revenue > 0 ? `${((tax / revenue) * 100).toFixed(2)}%` : '—',
    summaryLine: `核定征收情景试算：${taxYear} 年企业所得税 ${round2(tax)} 元，采用 ${round2(effectiveCitRate * 100)}% 所得税率${assessedQualificationConfirmed ? '' : '，主管税务机关鉴定待确认'}`,
    steps,
    warnings,
    policyRefs: [
      { ref: '国家税务总局公告2019年第36号', note: '综试区零售出口企业所得税核定征收，应税所得率统一4%，2020-01-01起施行' },
      { ref: '财税〔2018〕103号', note: '综试区零售出口"无票免税"（增值税、消费税免税）前提政策' },
      { ref: '财政部 税务总局公告2023年第12号', note: '小型微利企业实际5%税负，执行至2027-12-31' },
      { ref: '国家税务总局公告2025年第3号', note: '9810 海外仓出口预退税及销售后的核算规则' },
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
  if (citComparison) {
    warnings.push('企业所得税按输入税率作情景比较。两条路径须分别核实同一主体的全年应纳税所得额、小型微利条件和适用年度；无票路径的核定征收资格另由主管税务机关鉴定。')
  }

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

// ── 场景 7：平台报送、财务会计、增值税与出口、企业所得税，另列资金桥接 ──
/**
 * 分列四套口径的源数据和复核状态，另行核对银行放款。
 *
 * @param {object} p
 * @param {number} p.reportedGrossRevenue 平台涉税报送总额，或结算账单参考总额，元
 * @param {'platform'|'statement_reference'} [p.reportedGrossSource='platform'] 收入总额来源
 * @param {number} [p.refunds=0] 当期买家退款/退货冲回金额，元
 * @param {number} [p.refundReversal=0] 当期买家退款的冲回额，元
 * @param {number} [p.marketplaceWithheldTax=0] 平台代收代缴境外消费税/VAT流转税，元
 * @param {boolean} [p.withheldTaxIncludedInGross] 输入总额是否已含填报的代扣境外税（平台原值默认含，账单参考默认已剥离）
 * @param {number} [p.cutoffAndFxDiff=0] 跨期发货/报关离境时点调减及汇率折算差额，元（调减传正数，调增传负数）
 * @param {number} [p.platformFees=0] 平台佣金、FBA仓储物流费、广告费、支付手续费合计，元
 * @param {number} [p.platformFeeRebate=0] 平台费用返还额，元
 * @param {number} [p.subsidies=0] 平台补贴/赔付金额，元
 * @param {number} [p.subsidyReversal=0] 平台补贴冲回额，元
 * @param {boolean} [p.subsidiesIncludedInGross=false] 输入总额是否已含填报的补贴/赔付（兼容旧接口默认另计）
 * @param {number} [p.selfRemitTaxNet=0] 尚未包含在输入总额、随结算入账且待自申报的境外流转税净额，元
 * @param {number} [p.reserveChange=0] 店铺保证金/准备金净增加额，元（释放传负数）
 * @param {number} [p.actualPayout] 可选：平台/支付机构实际放款到账净额，元（资金流出可为负）
 * @param {number} [p.accountingRevenue] 可选：按履约与总额/净额法确认的同主体会计收入，元
 * @param {number} [p.declaredVatSales] 可选：企业当期实际已申报增值税/出口销售额，元（传入则执行申报缺口与净额法误报诊断）
 * @param {number} [p.citTaxableIncome] 可选：独立核实的同主体、同纳税年度企业所得税应纳税所得额，元
 * @param {string} [p.principalRole='principal'] 'principal'（主要责任人，总额法）| 'agent'（代理人，净额法）
 */
export function platformTaxReconcile(p = {}) {
  return reconcilePlatformTax(p)
}

/** 账单净调整包含前期发生额的冲回，保留其符号。 */
export function platformStatementTaxReconcile(p, exactAmounts) {
  return reconcilePlatformTax(p, exactAmounts)
}

function reconcilePlatformTax(p, exactAmounts) {
  const fromStatement = Boolean(exactAmounts)
  const money = exactAmounts?.money ?? round2
  const zero = fromStatement ? 0n : 0
  const abs = (n) => n < zero ? -n : n
  const gross = fromStatement
    ? p.reportedGrossRevenue
    : reqNum(p?.reportedGrossRevenue, 'reportedGrossRevenue 必须是非负数字（报送总额或账单参考总额，元）')
  const grossSource = p?.reportedGrossSource ?? 'platform'
  if (grossSource !== 'platform' && grossSource !== 'statement_reference') {
    throw new Error('reportedGrossSource 必须为 platform 或 statement_reference')
  }
  const refunds = fromStatement ? p.refunds : optNum(p?.refunds, 0, 'refunds') - optNum(p?.refundReversal, 0, 'refundReversal')
  const withheldTax = fromStatement ? zero : optNum(p?.marketplaceWithheldTax, 0, 'marketplaceWithheldTax')
  const cutoffFx = fromStatement ? zero : optSignedNum(p?.cutoffAndFxDiff, 0, 'cutoffAndFxDiff')
  const fees = fromStatement ? p.platformFees : optNum(p?.platformFees, 0, 'platformFees') - optNum(p?.platformFeeRebate, 0, 'platformFeeRebate')
  const subsidies = fromStatement ? p.subsidies : optNum(p?.subsidies, 0, 'subsidies') - optNum(p?.subsidyReversal, 0, 'subsidyReversal')
  const withheldTaxIncludedInGross = p?.withheldTaxIncludedInGross ?? (grossSource === 'platform')
  const withheldTaxAdjustment = withheldTaxIncludedInGross === true ? withheldTax : zero
  const cashSubsidyAdjustment = p?.subsidiesIncludedInGross === true ? zero : subsidies
  const selfRemitTax = fromStatement ? p.selfRemitTaxNet : optSignedNum(p?.selfRemitTaxNet, 0, 'selfRemitTaxNet')
  const reserve = fromStatement ? p.reserveChange : optSignedNum(p?.reserveChange, 0, 'reserveChange')
  const accountingRevenue = fromStatement ? null : optSignedNum(p?.accountingRevenue, null, 'accountingRevenue')
  const citTaxableIncome = fromStatement ? null : optSignedNum(p?.citTaxableIncome, null, 'citTaxableIncome')
  const actualPayout = fromStatement ? (p.actualPayout ?? null) : optSignedNum(p?.actualPayout, null, 'actualPayout')
  const declaredInput = optNum(p?.declaredVatSales, null, 'declaredVatSales')
  const declared = fromStatement && declaredInput !== null ? exactAmounts.baseAmount(declaredInput) : declaredInput
  const role = p?.principalRole === 'agent' ? 'agent' : 'principal'

  const grossLabel = grossSource === 'platform' ? '平台报送总额' : '账单参考总额'
  const reportedNet = gross - refunds
  const legitAdjustments = refunds + withheldTaxAdjustment + cutoffFx
  const referenceGrossSales = gross - legitAdjustments
  const adjAbs = money(abs(legitAdjustments))
  const adjDir = legitAdjustments >= 0 ? '调减' : '调增'
  const cutoffTerm =
    cutoffFx >= 0
      ? `+ 跨期离境与汇率折算差 ${money(cutoffFx)} 元`
      : `− 跨期离境与汇率折算调增 ${money(abs(cutoffFx))} 元`
  const refFormulaOp = legitAdjustments >= 0 ? `− 桥接调减 ${adjAbs}` : `+ 桥接调增 ${adjAbs}`

  const accountingAmount = accountingRevenue === null ? '会计收入待核实' : `会计收入 ${money(accountingRevenue)} 元`
  const steps = [
    `【平台报送】${grossLabel} ${money(gross)} 元 − 当期退款 ${money(refunds)} 元 = ${grossSource === 'platform' ? '平台报送净额' : '账单参考净额'} ${money(reportedNet)} 元`,
    `【跨口径调整】退款 ${money(refunds)} 元 + 已包含在输入总额的境外代扣税 ${money(withheldTaxAdjustment)} 元 ${cutoffTerm} = 口径/时点${adjDir}合计 ${adjAbs} 元`,
  ]

  if (role === 'principal') {
    steps.push(
      `【财务会计】${accountingAmount}。主要责任人按已收或应收对价总额确认收入，平台佣金及履约费 ${money(fees)} 元单列成本费用。`,
    )
  } else {
    steps.push(
      `【财务会计】${accountingAmount}。代理人按有权取得的佣金或手续费确认收入，须结合合同和履约核实转让前的控制权。`,
    )
  }
  steps.push(
    `【增值税与出口】参考销售额 = ${grossLabel} ${money(gross)} ${refFormulaOp} = ${money(referenceGrossSales)} 元。按内销、出口退（免）税、免税等类别复核申报口径。`,
    `【企业所得税】${citTaxableIncome === null ? '应纳税所得额待同主体、同纳税年度资料核实' : `独立填报的应纳税所得额 ${money(citTaxableIncome)} 元`}。依据利润、纳税调整或适用核定征收口径单独复核。`,
  )

  const warnings = []
  if (grossSource === 'statement_reference') {
    warnings.push('账单参考总额据结算明细推算。核对季度实际报送表的总额、退款、补贴与价税覆盖范围后，再进行申报差额判断。')
  }
  if (subsidies > 0) {
    warnings.push(`平台补贴/赔付 ${money(subsidies)} 元应按实际取得、来源和交易实质核对各口径。本次资金桥接${cashSubsidyAdjustment > 0 ? '从输入总额外另加' : '沿用输入总额中已含的金额'}。`)
  }
  let payoutReconciliation = null
  let declarationDiagnosis = null

  if (actualPayout !== null) {
    const theoretical = gross - refunds - withheldTaxAdjustment + cashSubsidyAdjustment - fees + selfRemitTax - reserve
    const theoreticalPayout = money(theoretical)
    const cashGap = (fromStatement ? money(actualPayout - theoretical) : money(money(actualPayout) - theoreticalPayout)) || 0
    payoutReconciliation = {
      theoreticalPayout,
      actualPayout: money(actualPayout),
      unexplainedCashGap: cashGap,
      gapFormula: '实际放款 − 理论放款',
    }
    const selfRemitTerm =
      selfRemitTax !== zero
        ? ` ${selfRemitTax >= 0 ? '+' : '−'} 待自申报流转税 ${money(abs(selfRemitTax))}`
        : ''
    steps.push(
      `【资金桥接】理论放款 = ${money(gross)} − 退款 ${money(refunds)} − 总额内代扣税 ${money(withheldTaxAdjustment)} + 总额外补贴 ${money(cashSubsidyAdjustment)} − 平台费用 ${money(fees)}${selfRemitTerm} − 准备金变动 ${money(reserve)} = ${theoreticalPayout} 元。放款差额（实际放款 − 理论放款）= ${money(actualPayout)} − ${theoreticalPayout} = ${cashGap} 元。正数表示实际多收，负数表示实际少收。`,
    )
    if (Math.abs(cashGap) > 1) {
      warnings.push(
        `资金链尚有 ${cashGap} 元差额（实际放款 − 理论放款）。请排查期初期末待结算余额、跨期在途提现、拒付、信用卡广告扣款或汇率差。`,
      )
    }
  }

  if (declared !== null) {
    const rawDiff = (fromStatement ? money(gross - declared) : money(money(gross) - money(declared))) || 0
    const unexplainedSalesGap = (fromStatement ? money(referenceGrossSales - declared) : money(money(referenceGrossSales) - money(declared))) || 0
    const feeAmount = fromStatement ? money(fees) : fees
    const matchesFeeNettingTrap =
      role === 'principal' && feeAmount > 0 && unexplainedSalesGap > 0 && Math.abs(unexplainedSalesGap - feeAmount) / feeAmount <= 0.15

    declarationDiagnosis = {
      declaredVatSales: money(declared),
      rawReportingDiff: rawDiff,
      explainedByBridge: money(legitAdjustments),
      unexplainedSalesGap,
      nettingTrapDetected: matchesFeeNettingTrap,
      rawReportingDiffFormula: `${grossLabel} − 已申报销售额`,
      unexplainedSalesGapFormula: '参考销售额 − 已申报销售额',
    }

    steps.push(
      `【增值税与出口差额】初步差额（${grossLabel} − 已申报销售额）= ${money(gross)} − ${money(declared)} = ${rawDiff} 元。待核查差额（参考销售额 − 已申报销售额）= ${money(referenceGrossSales)} − ${money(declared)} = ${unexplainedSalesGap} 元。正数表示前者高于申报额，负数表示前者低于申报额。`,
    )

    if (matchesFeeNettingTrap) {
      warnings.push(
        `“回款净额报税”预警：待核查申报差额 ${unexplainedSalesGap} 元与平台佣金和履约费用 ${money(fees)} 元接近。请检查是否误用扣费后的放款净额，按业务与各税种规则核实申报基数。`,
      )
    } else if (Math.abs(unexplainedSalesGap) > 1) {
      warnings.push(
        `参考销售额 − 已申报销售额为 ${unexplainedSalesGap} 元。请按主体、内销及出口申报类别逐栏核对报关单、出口发票与跨期申报表。`,
      )
    }
  }

  warnings.push(
    '资金桥接仅供核对放款。会计、增值税与出口、企业所得税各口径分别结合合同履约、报关离境单证和税务资料复核。',
  )

  const summaryParts = [
    `参考销售额 ${money(referenceGrossSales)} 元（${legitAdjustments >= 0 ? '已剥离口径/时点调减' : '已叠加口径/时点调增'} ${adjAbs} 元）`,
  ]
  if (payoutReconciliation) summaryParts.push(`放款差额（实际放款 − 理论放款）${payoutReconciliation.unexplainedCashGap} 元`)
  if (declarationDiagnosis) summaryParts.push(`待核查申报差额（参考销售额 − 已申报销售额）${declarationDiagnosis.unexplainedSalesGap} 元`)

  return {
    scenario: '平台报送、财务会计、增值税与出口、企业所得税四层口径核对',
    reportedGrossRevenue: money(gross),
    reportedNetRevenue: money(reportedNet),
    legitimateBridgeAdjustments: money(legitAdjustments),
    referenceGrossSales: money(referenceGrossSales),
    platformFees: money(fees),
    layers: {
      platformReporting: { source: grossSource, grossRevenue: money(gross), refunds: money(refunds), netRevenue: money(reportedNet) },
      financialAccounting: { principalRole: role, accountingRevenue: accountingRevenue === null ? null : money(accountingRevenue) },
      vatAndExport: { declaredVatSales: declarationDiagnosis?.declaredVatSales ?? null, referenceSales: money(referenceGrossSales) },
      corporateIncomeTax: { taxableIncome: citTaxableIncome === null ? null : money(citTaxableIncome) },
    },
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

// 确定性税额试算。所有政策参数均可由调用方显式覆盖；
// 默认值按现行政策填写，但政策会变——工作流要求先经知识库/权威来源核对再出结论。
// 本模块只做算术，不构成申报依据。

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

/**
 * 跨境电商零售进口综合税（限额内优惠口径）。
 * 依据框架：跨境电商零售进口税收政策（财关税〔2018〕49号等沿革文件）：
 * 限额内关税税率暂设为 0，进口环节增值税、消费税按法定应纳税额的 70% 征收。
 * 单次交易限值默认 5000 元、年度交易限值默认 26000 元，均可覆盖。
 *
 * @param {object} p
 * @param {number} p.price 完税价格（实际交易价格，含货价+运费+保险费），元
 * @param {number} [p.vatRate=0.13] 增值税法定税率（13% 或 9% 等）
 * @param {number} [p.consumptionTaxRate=0] 消费税比例税率（如高档化妆品 15%），无则 0
 * @param {number} [p.discount=0.7] 限额内征收比例（默认 70%）
 * @param {number} [p.singleLimit=5000] 单次交易限值，元
 * @param {number} [p.annualLimit=26000] 年度交易限值，元
 * @param {number} [p.annualUsed=0] 本年度已使用额度，元
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
  const vat = taxBase * vatRate
  steps.push(`增值税（法定）= ${ctr > 0 ? '组成计税价格' : '完税价格'} × ${vatRate} = ${round2(vat)} 元`)
  const statutory = consumptionTax + vat
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
    vatStatutory: round2(vat),
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
 * 增值税价税分离 / 税额试算（一般计税口径）。
 * @param {object} p
 * @param {number} p.amount 金额，元
 * @param {number} [p.rate=0.13] 税率（13%/9%/6% 等，传小数）
 * @param {boolean} [p.inclusive=true] amount 是否为含税价
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
    default:
      throw new Error(`未知 scenario：${scenario}。支持：cross_border_import（跨境电商零售进口综合税）、vat（增值税）、annual_bonus_iit（年终奖单独计税个税）、export_rebate（外贸企业出口退税）、cbec_assessed_cit（综试区零售出口核定征收企业所得税）。`)
  }
}

// ── 年终奖单独计税 ──────────────────────────────────────────
// 按月换算后的综合所得税率表（财税〔2018〕164号附件，2023年第30号公告延续）。
// 档位按 bonus/12 的商确定；速算扣除数只用一次（不乘12）。
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

/**
 * 全年一次性奖金单独计税（居民个人，一年限用一次）。
 * 含"多发一元"临界点陷阱检测：奖金落在 (档位上限, 税后收入持平点) 区间时，
 * 提示降到档位上限反而税后更多。
 * @param {object} p
 * @param {number} p.bonus 全年一次性奖金，元
 */
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

  // 临界点陷阱检测：找到奖金所在档位的下界（上一档上限），计算税后持平点
  const idx = BONUS_BRACKETS.findIndex((x) => bonus / 12 <= x.monthlyUpTo)
  let trap = null
  if (idx > 0) {
    const boundary = BONUS_BRACKETS[idx - 1].monthlyUpTo * 12 // 36000/144000/...
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

// ── 外贸企业出口退税（免退税） ──────────────────────────────
/**
 * 外贸企业（不具有生产能力）出口货物免退税试算。
 * 应退税额 = 购进出口货物的增值税专用发票注明金额（不含税）× 出口退税率。
 * 退税率默认等于适用税率（2026年第11号公告第三条：除国务院明确的外，退税率=适用税率），
 * 商品代码退税率被调低/取消的必须显式覆盖。
 * 从小规模纳税人购进等情形按"发票税率与退税率孰低"确定实际退税率。
 * @param {object} p
 * @param {number} p.purchaseAmount 专票注明的不含税金额，元
 * @param {number} [p.vatRate=0.13] 进项发票上的税率
 * @param {number} [p.rebateRate] 商品代码对应的出口退税率；缺省=vatRate
 */
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
      '退税率必须按商品代码在出口退税率文库核对（部分商品退税率被调低或取消，2024年以来多次调整）；本工具默认退税率=适用税率仅是缺省口径。',
      '生产企业出口自产货物适用免抵退税（按离岸价计算），本办法不支持，请勿混用。',
      '9810 出口海外仓货物可按"离境即退税、销售再核算"在报关离境后申请出口预退税（国家税务总局公告2025年第3号），后续按实际销售核算。',
      '申报期限：报关出口次月起至次年4月30日前；最长可延至出口之日起36个月内补报，超期视同境内销售征税（增值税法及实施条例口径）。',
    ],
    policyRefs: [
      { ref: '财政部 税务总局公告2026年第11号', note: '出口业务增值税和消费税政策，2026-01-01起施行；第五条：免退税=计税依据×退税率；第三条：退税率默认=适用税率' },
      { ref: '国家税务总局公告2026年第5号', note: '《出口业务增值税和消费税退（免）税管理办法》' },
      { ref: '国家税务总局公告2025年第3号', note: '9810 出口海外仓"离境即退税、销售再核算"' },
    ],
  }
}

// ── 综试区零售出口核定征收企业所得税 ────────────────────────
/**
 * 跨境电商综试区零售出口企业核定征收企业所得税试算。
 * 应纳税所得额 = 收入总额 × 应税所得率（统一4%）；再乘适用税率。
 * 符合小型微利条件的可叠加小微优惠（≤300万部分实际5%，至2027-12-31）。
 * @param {object} p
 * @param {number} p.revenue 收入总额，元
 * @param {number} [p.taxableIncomeRate=0.04] 应税所得率
 * @param {number} [p.citRate=0.25] 企业所得税税率
 * @param {boolean} [p.smallLowProfit=false] 是否已确认符合小型微利企业条件
 */
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
    '适用前提（须全部满足并经税务机关鉴定）：①综试区注册并在当地线上综合服务平台登记出口信息；②通过综试区海关办理电商出口申报；③出口货物未取得有效进货凭证、享受增值税/消费税免税（无票免税）。',
    '核定征收是需申请鉴定的事前安排，不是自动适用；收入总额必须准确核算。',
    '9810 海外仓模式在国家明文层面未纳入核定征收范围，2026 年执行口径趋严（海外仓卖家普遍转向查账征收）——务必先与主管税务机关确认。',
  ]
  if (smallLowProfit) {
    if (taxableIncome <= 3_000_000) {
      effectiveCitRate = 0.05
      steps.push(`小型微利优惠：应纳税所得额 ≤ 300万，减按25%计入、按20%税率 → 实际税负 5%`)
      warnings.push('小微条件须同时满足：从业人数≤300人、资产总额≤5000万、非限制禁止行业；本工具按用户已确认处理。')
    } else {
      warnings.push(`应纳税所得额 ${round2(taxableIncome)} 元超过300万，不享受小微优惠，按 ${citRate * 100}% 计算。`)
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
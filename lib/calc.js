// 确定性税额与对账试算引擎（14 大场景）。所有政策参数均可由调用方显式覆盖；
// 默认值按现行政策填写，但政策会变——工作流要求先经知识库/权威来源核对再出结论。
// 本模块只做算术与结构化勾稽，不构成纳税申报依据。

import { CalcInputError, boolOrDefault, optBoolean, optNum, optSignedNum, reqNum, round2 } from './calc_shared.js'
import {
  cbecReturnDutyExempt,
  exportRebateCancelImpact,
  exportRebateManufacturer,
  vatTaxpayerThreshold,
} from './calc_extra.js'
import {
  CROSSBORDER_CALC_SPECS,
  CROSSBORDER_SCENARIOS,
  calculateCrossborder,
  euLowValueParcel,
  fbaMixedProcurementSplit,
  usT86Vs9810Ddp,
} from './calc_crossborder.js'

export {
  CalcInputError,
  CROSSBORDER_CALC_SPECS,
  CROSSBORDER_SCENARIOS,
  calculateCrossborder,
  cbecReturnDutyExempt,
  euLowValueParcel,
  exportRebateCancelImpact,
  exportRebateManufacturer,
  fbaMixedProcurementSplit,
  usT86Vs9810Ddp,
  vatTaxpayerThreshold,
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
  if (vatRate > 1 || ctr > 1 || discount > 1) throw new CalcInputError('税率/征收比例应为 0~1 的小数（如 13% 传 0.13）')
  if (ctr >= 1) throw new CalcInputError('consumptionTaxRate（消费税税率）必须小于 1')

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
  const inclusive = boolOrDefault(p?.inclusive, true, 'inclusive')
  if (rate > 1) throw new CalcInputError('rate 必须是 0~1 的小数（如 13% 传 0.13）')

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

/** 统一入口：按 scenario 分发（14 大确定性算税场景）。 */
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
    case 'export_rebate_cancel_impact':
      return exportRebateCancelImpact(params)
    case 'vat_taxpayer_threshold':
      return vatTaxpayerThreshold(params)
    case 'eu_low_value_parcel':
      return euLowValueParcel(params)
    case 'us_t86_vs_9810_ddp':
      return usT86Vs9810Ddp(params)
    case 'fba_mixed_procurement_split':
      return fbaMixedProcurementSplit(params)
    default:
      throw new CalcInputError(
        `未知 scenario：${scenario}。支持：platform_tax_reconcile（平台涉税报送四层口径桥接）、eu_low_value_parcel（欧盟低值包裹 €3+€2 与 PID 反推售价）、us_t86_vs_9810_ddp（美线 Type 11 vs 9810 DDP 与 IEEPA/FIOR）、fba_mixed_procurement_split（FBA 有票+无票混合采购拆单）、export_invoice_breakeven（开票加点拿票退税vs无票免税临界测算）、export_rebate（外贸出口免退税）、export_rebate_manufacturer（生产企业免抵退税）、export_rebate_cancel_impact（退税取消/下调与电池消费税双税冲击测算）、cbec_assessed_cit（综试区4%核定所得税）、cbec_return_duty_exempt（2026年第16号退运免税测算）、vat_taxpayer_threshold（500万一般纳税人临界与拐点测算）、annual_bonus_iit（年终奖个税双轨比选）、cross_border_import（跨境进口综合税）、vat（增值税）。`,
      )
  }
}

export const calculateTax = calculate

// ── 场景 3：年终奖个税（单独计税 vs 并入综合所得双轨比选） ──────
const BONUS_BRACKETS = [
  { monthlyUpTo: 3000, rate: 0.03, quick: 0 },
  { monthlyUpTo: 12000, rate: 0.10, quick: 210 },
  { monthlyUpTo: 25000, rate: 0.20, quick: 1410 },
  { monthlyUpTo: 35000, rate: 0.25, quick: 2660 },
  { monthlyUpTo: 55000, rate: 0.30, quick: 4410 },
  { monthlyUpTo: 80000, rate: 0.35, quick: 7160 },
  { monthlyUpTo: Infinity, rate: 0.45, quick: 15160 },
]

const ANNUAL_COMP_BRACKETS = [
  { annualUpTo: 36000, rate: 0.03, quick: 0 },
  { annualUpTo: 144000, rate: 0.10, quick: 2520 },
  { annualUpTo: 300000, rate: 0.20, quick: 16920 },
  { annualUpTo: 420000, rate: 0.25, quick: 31920 },
  { annualUpTo: 660000, rate: 0.30, quick: 52920 },
  { annualUpTo: 960000, rate: 0.35, quick: 85920 },
  { annualUpTo: Infinity, rate: 0.45, quick: 181920 },
]

function bonusTax(bonus) {
  const monthly = bonus / 12
  const b = BONUS_BRACKETS.find((x) => monthly <= x.monthlyUpTo)
  return { rate: b.rate, quick: b.quick, tax: bonus * b.rate - b.quick }
}

function comprehensiveAnnualTax(taxableIncome) {
  if (taxableIncome <= 0) return { rate: 0, quick: 0, tax: 0 }
  const b = ANNUAL_COMP_BRACKETS.find((x) => taxableIncome <= x.annualUpTo)
  return { rate: b.rate, quick: b.quick, tax: taxableIncome * b.rate - b.quick }
}

export function annualBonusIit(p = {}) {
  const rawBonus = reqNum(p?.bonus, 'bonus 必须是正数（全年一次性奖金，元）', { allowZero: false })
  const bonus = round2(rawBonus)
  if (bonus <= 0) {
    throw new CalcInputError('bonus 量化到分后必须大于 0（至少 0.01 元）')
  }
  const directCompTaxable = optSignedNum(p?.annualComprehensiveTaxableIncome, null, 'annualComprehensiveTaxableIncome')
  const annualSalary = optNum(p?.annualSalary, null, 'annualSalary')
  const basicDeduction = optNum(p?.basicDeduction, 60000, 'basicDeduction')
  const socialInsurance = optNum(p?.socialInsurance, 0, 'socialInsurance')
  const specialAdditionalDeduction = optNum(p?.specialAdditionalDeduction, 0, 'specialAdditionalDeduction')
  const otherDeductions = optNum(p?.otherDeductions, 0, 'otherDeductions')

  const { rate, quick, tax } = bonusTax(bonus)
  const net = bonus - tax
  const steps = [
    `【方案 A · 单独计税】找档：${bonus} ÷ 12 = ${round2(bonus / 12)} 元/月 → 适用税率 ${rate * 100}%，速算扣除数 ${quick}`,
    `单独计税应纳税额 = ${bonus} × ${rate} − ${quick} = ${round2(tax)} 元；税后奖金 = ${round2(net)} 元`,
  ]
  const warnings = [
    '【6 盲区提示】一个纳税年度内，每人仅允许使用一次全年一次性奖金单独计税；同年度分多次发放奖金的，其余批次须并入综合所得。',
    '【跨年归属】年终奖按实际发放月份归属对应纳税年度（如 2027 年 1 月发放计入 2027 年度）；单独计税优惠延续至 2027-12-31。',
  ]

  const idx = BONUS_BRACKETS.findIndex((x) => bonus / 12 <= x.monthlyUpTo)
  let trap = null
  if (idx > 0) {
    const boundary = BONUS_BRACKETS[idx - 1].monthlyUpTo * 12
    if (bonus > boundary) {
      const netAtBoundary = boundary - bonusTax(boundary).tax
      const cur = BONUS_BRACKETS[idx]
      const breakEven = (netAtBoundary - cur.quick) / (1 - cur.rate)
      const gainAtBoundary = round2(netAtBoundary - net)
      if (bonus < breakEven && gainAtBoundary >= 0.01) {
        trap = { boundary, breakEven: round2(breakEven), gainAtBoundary }
        warnings.push(
          `⚠ 临界点陷阱（6 档倒挂区间之一）：奖金 ${bonus} 元落在 (${boundary}, ${round2(breakEven)}) 陷阱区间——若降到 ${boundary} 元，税后收入反而多 ${gainAtBoundary} 元。发放方案建议避开该区间。`,
        )
      }
    }
  }

  let dualTrack = null
  let summaryLine = null
  const hasCompInput = directCompTaxable !== null || annualSalary !== null
  if (hasCompInput) {
    const compBaseRaw = directCompTaxable !== null
      ? directCompTaxable
      : annualSalary - basicDeduction - socialInsurance - specialAdditionalDeduction - otherDeductions
    const baseCompTax = comprehensiveAnnualTax(Math.max(0, compBaseRaw)).tax
    const totalTaxSeparate = baseCompTax + tax
    const combinedTaxable = Math.max(0, compBaseRaw + bonus)
    const combinedInfo = comprehensiveAnnualTax(combinedTaxable)
    const totalTaxCombined = combinedInfo.tax
    const bonusIncrementalCombinedTax = totalTaxCombined - baseCompTax
    const diff = round2(totalTaxCombined - totalTaxSeparate)
    const recommendedMethod = diff > 0.005 ? 'separate' : diff < -0.005 ? 'combined' : 'equal'
    const taxSaving = round2(Math.abs(diff))
    const bestBonusAfterTax = round2(bonus - (recommendedMethod === 'combined' ? bonusIncrementalCombinedTax : tax))

    if (directCompTaxable === null) {
      steps.push(
        `不含年终奖的年综合所得净应税基数 = 年薪 ${annualSalary} − 基本减除 ${basicDeduction} − 三险一金 ${socialInsurance} − 专项附加扣除 ${specialAdditionalDeduction}${otherDeductions > 0 ? ` − 其他扣除 ${otherDeductions}` : ''} = ${round2(compBaseRaw)} 元`,
      )
    } else {
      steps.push(`不含年终奖的年综合所得应纳税所得额（含负扣除结余）= ${round2(compBaseRaw)} 元`)
    }
    steps.push(
      `【方案 A 合计】综合所得个税 ${round2(baseCompTax)} 元 + 年终奖单独计税 ${round2(tax)} 元 = 全年合计个税 ${round2(totalTaxSeparate)} 元`,
      `【方案 B · 并入综合所得】合并应纳税所得额 = max(0, ${round2(compBaseRaw)} + ${bonus}) = ${round2(combinedTaxable)} 元 → 全年合计个税 ${round2(totalTaxCombined)} 元（奖金增量税负 ${round2(bonusIncrementalCombinedTax)} 元）`,
      recommendedMethod === 'separate'
        ? `双轨结论：选择【单独计税】更省税，全年少缴个税 ${taxSaving} 元（奖金对应税后 ${round2(net)} 元）。`
        : recommendedMethod === 'combined'
          ? `双轨结论：选择【并入综合所得】更省税，全年少缴个税 ${taxSaving} 元（奖金对应税后 ${bestBonusAfterTax} 元）。`
          : '双轨结论：单独计税与并入综合所得全年合计个税一致。',
    )
    if (compBaseRaw < 0) {
      warnings.push(
        `【负应纳税所得额提示】不含年终奖的综合所得扣除尚未用足（结余 ${round2(-compBaseRaw)} 元）；并入综合所得可先抵减未用扣除额，通常明显优于单独计税！`,
      )
    }
    warnings.push('【12 月专扣确认】次年汇算清缴前（含 12 月专项附加扣除确认）可在个税 App 自由切换计税方式，建议结合全年实际扣除额最终核定。')

    dualTrack = {
      comprehensiveBaseRaw: round2(compBaseRaw),
      baseComprehensiveTax: round2(baseCompTax),
      totalTaxSeparate: round2(totalTaxSeparate),
      combinedTaxableIncome: round2(combinedTaxable),
      totalTaxCombined: round2(totalTaxCombined),
      bonusTaxSeparate: round2(tax),
      bonusIncrementalCombinedTax: round2(bonusIncrementalCombinedTax),
      recommendedMethod,
      taxSaving,
    }
    summaryLine =
      recommendedMethod === 'separate'
        ? `推荐【单独计税】：全年个税 ${round2(totalTaxSeparate)} 元，比并入综合所得省税 ${taxSaving} 元（年终奖单税 ${round2(tax)} 元，税后 ${round2(net)} 元）`
        : recommendedMethod === 'combined'
          ? `推荐【并入综合所得】：全年个税 ${round2(totalTaxCombined)} 元，比单独计税省税 ${taxSaving} 元（奖金增量税 ${round2(bonusIncrementalCombinedTax)} 元，税后 ${bestBonusAfterTax} 元）`
          : `双轨税负持平：全年合计个税 ${round2(totalTaxSeparate)} 元（年终奖税 ${round2(tax)} 元，税后 ${round2(net)} 元）`
  } else {
    warnings.push('也可选择并入当年综合所得计税；传入年综合所得应纳税所得额（或年薪与扣除项）即可一键比选两种方式优劣。')
  }

  return {
    scenario: hasCompInput ? '全年一次性奖金个税（单独计税 vs 并入综合所得双轨比选）' : '全年一次性奖金单独计税（个人所得税）',
    bonus: round2(bonus),
    rate,
    quickDeduction: quick,
    taxPayable: round2(tax),
    afterTax: round2(net),
    effectiveRate: `${((tax / bonus) * 100).toFixed(2)}%`,
    trap,
    dualTrack,
    summaryLine,
    steps,
    warnings,
    policyRefs: [
      { ref: '财政部 税务总局公告2023年第30号', note: '全年一次性奖金单独计税政策延续实施至2027-12-31' },
      { ref: '国税发〔2005〕9号', note: '全年一次性奖金计税方法的基础规定（除以12找档）' },
      { ref: '财税〔2018〕164号', note: '按月换算后的综合所得税率表及单独/并入二选一规则' },
    ],
  }
}

// ── 场景 4：外贸企业出口退税（免退税） ──────────────────────
export function exportRebate(p = {}) {
  const purchaseAmount = reqNum(p?.purchaseAmount, 'purchaseAmount 必须是正数（增值税专用发票注明的不含税金额，元）', { allowZero: false })
  const vatRate = optNum(p?.vatRate, 0.13, 'vatRate')
  const rebateRate = optNum(p?.rebateRate, vatRate, 'rebateRate')
  for (const [name, v] of Object.entries({ vatRate, rebateRate })) {
    if (v > 1) throw new CalcInputError(`${name} 必须是 0~1 的小数（如 13% 传 0.13）`)
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
      '9810 海外仓货物报关离境后，未售货物可用 HWC-YT 标识申报出口预退税，已售货物按规定申报出口退（免）税。预退税核算期自税务机关办结次月1日起，原则上至次年4月实际增值税纳税申报期截止（法定上界为次年4月30日，获准外贸企业等特定情形须按主管税务机关规定核对例外）；到期仍未实现销售的须按规定全额冲减/缴回已预退税款，待实际销售后再重新申报出口退（免）税。',
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
  const marginalTaxableIncomeRate = optNum(
    p?.marginalTaxableIncomeRate ?? p?.incrementalTaxableIncomeRate,
    null,
    'marginalTaxableIncomeRate',
  )
  const annualAverageEmployees = optNum(p?.annualAverageEmployees, null, 'annualAverageEmployees')
  const annualAverageAssets = optNum(p?.annualAverageAssets, null, 'annualAverageAssets')
  const nonRestrictedIndustry = optBoolean(p?.nonRestrictedIndustry, 'nonRestrictedIndustry')
  const assessedQualificationConfirmed = boolOrDefault(p?.assessedQualificationConfirmed, false, 'assessedQualificationConfirmed')
  const smallLowProfitOpt = optBoolean(p?.smallLowProfit, 'smallLowProfit')
  const assumeMarginalSame = boolOrDefault(p?.assumeMarginalRateSameAsAssessed, true, 'assumeMarginalRateSameAsAssessed')
  for (const [name, v] of Object.entries({ taxableIncomeRate, citRate })) {
    if (v > 1) throw new CalcInputError(`${name} 必须是 0~1 的小数`)
  }
  if (marginalTaxableIncomeRate !== null && marginalTaxableIncomeRate > 1) {
    throw new CalcInputError('marginalTaxableIncomeRate 必须是 0~1 的小数')
  }
  if (!Number.isInteger(taxYear) || taxYear < 1) throw new CalcInputError('taxYear 必须是有效的纳税年度')

  const taxableIncome = revenue * taxableIncomeRate
  const incomeForEligibility = annualTaxableIncome ?? taxableIncome
  const withinPolicyYears = taxYear >= 2023 && taxYear <= 2027
  const hasAllEligibilityInputs =
    annualTaxableIncome !== null && annualAverageEmployees !== null && annualAverageAssets !== null && nonRestrictedIndustry !== null
  // 兼容既有调用。true 表示调用方已按主体和纳税年度核验全部条件，明细输入优先参与判定。
  const eligibilityConfirmed = smallLowProfitOpt === true || hasAllEligibilityInputs
  const smallLowProfitApplied =
    smallLowProfitOpt !== false &&
    eligibilityConfirmed &&
    withinPolicyYears &&
    incomeForEligibility <= 3_000_000 &&
    (annualAverageEmployees === null || annualAverageEmployees <= 300) &&
    (annualAverageAssets === null || annualAverageAssets <= 50_000_000) &&
    nonRestrictedIndustry !== false
  const smallLowProfitRate = Math.min(0.05, citRate)
  const effectiveCitRate = smallLowProfitApplied ? smallLowProfitRate : citRate
  const steps = [`核定所得额试算 = 收入总额 ${revenue} × 应税所得率 ${taxableIncomeRate} = ${round2(taxableIncome)} 元`]
  const warnings = [
    '4% 是综试区零售出口核定应税所得率。须在综试区注册并在当地线上综合服务平台登记出口信息、经综试区所在地海关申报电商出口、未取得有效进货凭证且享受增值税和消费税免税，并经主管税务机关鉴定。',
    '9810 海外仓出口预退税按税总2025年第3号办理。企业所得税能否核定，须由主管税务机关按综试区零售出口条件及具体业务另行确认。',
    '小型微利企业的5%实际税负政策执行至2027-12-31。须从事国家非限制和禁止行业，并同时满足同一主体年度应纳税所得额≤300万元、从业人数≤300人、资产总额≤5000万元。其中人数（含劳务派遣用工）和资产按全年各季度平均值计算。',
    '平台报送收入、跨主体汇总和滚动账单只用于风险提示。请用同一主体同一纳税年度的完整数据核对年度应纳税所得额。',
  ]
  if (!assessedQualificationConfirmed) warnings.push('主管税务机关鉴定待确认（须以核准回执或鉴定文书为准），本结果按核定征收假设情景试算。')
  if (taxableIncomeRate === 0.04) {
    warnings.push('7,500万元是按4%应税所得率反推的收入等值，前提是该收入完整覆盖同一主体年度核定口径。')
  } else {
    warnings.push('本次采用自定义应税所得率试算，综试区零售出口核定政策规定的应税所得率为4%。')
  }
  if (annualTaxableIncome === null && smallLowProfitOpt === true) {
    warnings.push('已选择确认全部小型微利条件，本次以核定所得额作为同一主体的全年所得试算；如另有所得或年度调整，请填写年度应纳税所得额。')
  }
  if (incomeForEligibility > 3_000_000) {
    const basis = annualTaxableIncome === null ? '本次核定所得额试算' : '年度应纳税所得额'
    warnings.push(`${basis} ${round2(incomeForEligibility)} 元超过300万元，本次按基准税率试算。`)
  }
  if (!withinPolicyYears) {
    warnings.push(`${taxYear} 纳税年度须另行核对当年小型微利优惠，本次按基准税率试算。`)
  } else if (smallLowProfitApplied) {
    steps.push(
      smallLowProfitRate < 0.05
        ? `优惠税率孰低保护（${taxYear} 年）：基准税率 ${round2(citRate * 100)}% 低于小型微利 5%，按孰低税率 ${round2(smallLowProfitRate * 100)}% 计税`
        : `小型微利优惠（${taxYear} 年）：减按25%计入应纳税所得额 × 20%税率 → 实际税负 5%`,
    )
  } else if (incomeForEligibility <= 3_000_000) {
    warnings.push('小型微利条件尚未全部满足或确认，本次按基准税率试算。')
  }
  const tax = taxableIncome * effectiveCitRate
  steps.push(`企业所得税试算 = ${round2(taxableIncome)} × ${effectiveCitRate} = ${round2(tax)} 元`)

  const floor2 = (x) => Math.floor((x + 1e-12) * 100) / 100
  const cliffIncome = 3_000_000
  const cliffTaxAt3m = round2(cliffIncome * smallLowProfitRate)
  const cliffTaxJustOver = round2((cliffIncome + 1) * citRate)
  const cliffJumpDelta = Math.max(0, round2(cliffTaxJustOver - cliffTaxAt3m))
  const cliffRevenueEquiv = taxableIncomeRate > 0 ? round2(cliffIncome / taxableIncomeRate) : null
  const overCliffExtraTax = incomeForEligibility > cliffIncome ? Math.max(0, round2(incomeForEligibility * citRate - cliffTaxAt3m)) : 0
  const remainingIncomeExact = Math.max(0, cliffIncome - incomeForEligibility)
  const remainingIncomeTo3m = round2(remainingIncomeExact)
  // 当存在自定义全年应税所得（或自定义边际所得率）时，以「剩余年度应税所得 ÷ 新增收入适用所得率」向下取分反推安全新增收入空间；
  // 缺少有效边际所得率假设（如所得率为 0 或显式声明不可沿用核定所得率）时返回 null，严禁高报。
  const effectiveMarginalRate =
    marginalTaxableIncomeRate !== null
      ? (marginalTaxableIncomeRate > 0 ? marginalTaxableIncomeRate : null)
      : !assumeMarginalSame
        ? null
        : (taxableIncomeRate > 0 ? taxableIncomeRate : null)
  const remainingRevenueToCliff =
    effectiveMarginalRate !== null ? Math.max(0, floor2(remainingIncomeExact / effectiveMarginalRate)) : null
  const cliffComparison = {
    cliffTaxableIncome: cliffIncome,
    cliffRevenueEquiv,
    taxAt3mSmallLowProfit: cliffTaxAt3m,
    taxJustOver3m: cliffTaxJustOver,
    cliffJumpAtPlusOneYuan: cliffJumpDelta,
    exceeded3m: incomeForEligibility > cliffIncome,
    overCliffExtraTaxVs3m: overCliffExtraTax,
    remainingIncomeTo3m,
    remainingRevenueToCliff,
    marginalTaxableIncomeRateUsed: effectiveMarginalRate,
  }
  if (withinPolicyYears) {
    if (incomeForEligibility > cliffIncome) {
      steps.push(
        `【300 万小微崖跳变对照】若年度应纳税所得额控制在 300 万元（${cliffRevenueEquiv ? `对应 ${round2(taxableIncomeRate * 100)}% 收入等值 ${(cliffRevenueEquiv / 10000).toFixed(0)} 万元` : '小微上限'}），小微税额 150,000 元；当前超崖全额按 ${round2(citRate * 100)}% 计税，相比 300 万临界点多缴税款 ${overCliffExtraTax} 元（超 1 元即跳增 ${cliffJumpDelta} 元）。`,
      )
    } else {
      const revenueRoomNote =
        remainingRevenueToCliff !== null
          ? `（按新增收入适用所得率 ${round2(effectiveMarginalRate * 100)}% 反推新增收入空间 ${remainingRevenueToCliff} 元${annualTaxableIncome !== null ? '；若新增业务非同一所得率请另行传 marginalTaxableIncomeRate 核定' : ''}）`
          : '（缺少有效新增收入边际所得率假设，新增收入空间返回 null 待按实际边际利润率核定）'
      steps.push(
        `【300 万小微崖安全缓冲】距 300 万应纳税所得额红线余 ${remainingIncomeTo3m} 元${revenueRoomNote}；一旦超过 300 万哪怕 1 元，全额改按 ${round2(citRate * 100)}% 计税，税额从 150,000 元跳增至 ${cliffTaxJustOver} 元（+${cliffJumpDelta} 元）。`,
      )
    }
  }
  warnings.push(
    '【9810 预退税次年 4 月核算期硬提醒】9810 海外仓预退税（HWC-YT）核算期至次年 4 月实际增值税纳税申报期截止（法定上界次年 4 月 30 日）；到期仍未实现销售的须按规定全额冲减/缴回已预退税款，待实际销售后再重新申报，切勿与所得税 4% 核定混同。',
  )

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
    cliffComparison,
    summaryLine: `核定征收情景试算：${taxYear} 年企业所得税 ${round2(tax)} 元，采用 ${round2(effectiveCitRate * 100)}% 所得税率${incomeForEligibility > cliffIncome ? `（已超 300 万小微崖，较 300 万线多缴 ${overCliffExtraTax} 元）` : ''}${assessedQualificationConfirmed ? '' : '，主管税务机关鉴定待确认'}`,
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
    if (v > 1) throw new CalcInputError(`${name} 必须是 0~1 的小数（如 8% 传 0.08，13% 传 0.13）`)
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
      { ref: '国家税务总局公告2018年第28号', note: '企业所得税税前扣除凭证管理办法（走查账征收时无票采购成本扣除边界）' },
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
  const rawGrossSource = p?.reportedGrossSource
  if (typeof rawGrossSource === 'boolean' || (rawGrossSource !== null && typeof rawGrossSource === 'object')) {
    throw new CalcInputError('reportedGrossSource 必须为 platform 或 statement_reference')
  }
  const grossSource = rawGrossSource ?? 'platform'
  if (grossSource !== 'platform' && grossSource !== 'statement_reference') {
    throw new CalcInputError('reportedGrossSource 必须为 platform 或 statement_reference')
  }
  const refunds = fromStatement ? p.refunds : optNum(p?.refunds, 0, 'refunds') - optNum(p?.refundReversal, 0, 'refundReversal')
  const withheldTax = fromStatement ? zero : optNum(p?.marketplaceWithheldTax, 0, 'marketplaceWithheldTax')
  const cutoffFx = fromStatement ? zero : optSignedNum(p?.cutoffAndFxDiff, 0, 'cutoffAndFxDiff')
  const fees = fromStatement ? p.platformFees : optNum(p?.platformFees, 0, 'platformFees') - optNum(p?.platformFeeRebate, 0, 'platformFeeRebate')
  const subsidies = fromStatement ? p.subsidies : optNum(p?.subsidies, 0, 'subsidies') - optNum(p?.subsidyReversal, 0, 'subsidyReversal')
  const withheldTaxIncludedInGross = boolOrDefault(p?.withheldTaxIncludedInGross, grossSource === 'platform', 'withheldTaxIncludedInGross')
  const withheldTaxAdjustment = withheldTaxIncludedInGross ? withheldTax : zero
  const subsidiesIncludedInGross = boolOrDefault(p?.subsidiesIncludedInGross, false, 'subsidiesIncludedInGross')
  const cashSubsidyAdjustment = subsidiesIncludedInGross ? zero : subsidies
  const selfRemitTax = fromStatement ? p.selfRemitTaxNet : optSignedNum(p?.selfRemitTaxNet, 0, 'selfRemitTaxNet')
  const reserve = fromStatement ? p.reserveChange : optSignedNum(p?.reserveChange, 0, 'reserveChange')
  const accountingRevenue = fromStatement ? null : optSignedNum(p?.accountingRevenue, null, 'accountingRevenue')
  const citTaxableIncome = fromStatement ? null : optSignedNum(p?.citTaxableIncome, null, 'citTaxableIncome')
  const actualPayout = fromStatement ? (p.actualPayout ?? null) : optSignedNum(p?.actualPayout, null, 'actualPayout')
  const declaredInput = optNum(p?.declaredVatSales, null, 'declaredVatSales')
  const declared = fromStatement && declaredInput !== null ? exactAmounts.baseAmount(declaredInput) : declaredInput
  const rawRole = p?.principalRole
  if (typeof rawRole === 'boolean' || (rawRole !== null && typeof rawRole === 'object')) {
    throw new CalcInputError('principalRole 必须为 principal 或 agent')
  }
  const role = rawRole === undefined || rawRole === null || rawRole === '' ? 'principal' : String(rawRole).trim()
  if (role !== 'principal' && role !== 'agent') {
    throw new CalcInputError('principalRole 必须为 principal 或 agent')
  }

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

// ── 完整 14 引擎规格注册表（供 /api/fintax/calc/specs 与客户端统一读取） ──
const BASE_CALC_SPECS = [
  {
    code: 'platform_tax_reconcile',
    group: 'audit',
    currency: 'CNY',
    zh: '平台报送四层口径桥接',
    en: '4-Layer Platform Tax Bridge',
    desc: '分列平台报送、财务会计、增值税与出口、企业所得税四层口径，并独立做实际放款 vs 理论放款资金桥接与回款净额漏报诊断。',
    enDesc: 'Reconciles platform reporting, financial accounting, VAT/export declarations, and CIT layers alongside an independent payout cash bridge.',
    fields: [
      { key: 'reportedGrossRevenue', label: '平台报送总额或账单参考毛额（元）', enLabel: 'Reported Gross / Reference Sales (CNY)', def: '6000000', required: true },
      { key: 'reportedGrossSource', label: '报送金额来源', enLabel: 'Gross Revenue Source', type: 'select', def: 'platform', options: [{ value: 'platform', label: '平台实际报送数据' }, { value: 'statement_reference', label: '根据账单推算的参考额' }] },
      { key: 'refunds', label: '当期客户退款（元）', enLabel: 'Customer Refunds (CNY)', def: '450000' },
      { key: 'accountingRevenue', label: '会计确认收入（元，可选）', enLabel: 'Accounting Revenue (CNY)', def: '' },
      { key: 'declaredVatSales', label: '增值税与出口已申报销售额（元，可选）', enLabel: 'Declared VAT / Export Sales (CNY)', def: '4200000' },
      { key: 'citTaxableIncome', label: '企业所得税应纳税所得额（元，可选）', enLabel: 'CIT Taxable Income (CNY)', def: '' },
      { key: 'marketplaceWithheldTax', label: '商城代扣境外流转税（元）', enLabel: 'Marketplace Withheld Tax (CNY)', def: '350000' },
      { key: 'cutoffAndFxDiff', label: '跨期与汇率折算差（正调减/负调增）', enLabel: 'Cutoff & FX Adjustment (CNY)', def: '400000' },
      { key: 'platformFees', label: '平台佣金与履约费（元）', enLabel: 'Platform Fees & Fulfillment (CNY)', def: '600000' },
      { key: 'actualPayout', label: '平台放款净额（元，可选）', enLabel: 'Actual Payout (CNY)', def: '' },
    ],
    advancedFields: [
      { key: 'subsidies', label: '平台出资补贴/赔付（元）', enLabel: 'Platform Subsidies (CNY)', def: '0' },
      { key: 'refundReversal', label: '客户退款冲回（元）', enLabel: 'Refund Reversal (CNY)', def: '0' },
      { key: 'platformFeeRebate', label: '平台手续费返还（元）', enLabel: 'Platform Fee Rebate (CNY)', def: '0' },
      { key: 'subsidyReversal', label: '平台补贴/赔付冲回（元）', enLabel: 'Subsidy Reversal (CNY)', def: '0' },
      { key: 'subsidiesIncludedInGross', label: '上述毛额已含本次填写的补贴', enLabel: 'Subsidies Included in Gross', type: 'bool', def: false },
      { key: 'withheldTaxIncludedInGross', label: '上述毛额已含本次填写的境外代扣税', enLabel: 'Withheld Tax Included in Gross', type: 'bool', def: true },
      { key: 'selfRemitTaxNet', label: '非代扣待自申报税净额（元）', enLabel: 'Self-Remit Tax Net (CNY)', def: '0' },
      { key: 'reserveChange', label: '准备金净变动（+冻结/-释放）', enLabel: 'Reserve Net Change (CNY)', def: '0' },
      { key: 'principalRole', label: '会计主体责任角色', enLabel: 'Principal / Agent Role', type: 'select', def: 'principal', options: [{ value: 'principal', label: '主要责任人（总额法）' }, { value: 'agent', label: '代理人（净额法）' }] },
    ],
    exampleParams: { reportedGrossRevenue: 6000000, refunds: 450000, marketplaceWithheldTax: 350000, cutoffAndFxDiff: 400000, platformFees: 600000, declaredVatSales: 4200000 },
    imaKeywords: ['810号令', '四层口径', '平台报送', '总额法'],
  },
  {
    code: 'vat_taxpayer_threshold',
    group: 'audit',
    currency: 'CNY',
    zh: '500 万一般纳税人临界拐点',
    en: '5M General Taxpayer Cliff',
    desc: '核对年应征增值税销售额（严格超过 500 万元触发强制登记）、一般纳税人登记与小规模月/季起征点，并试算进项抵扣临界占比。',
    enDesc: 'Tracks rolling 12-month taxable sales against the >5M CNY general taxpayer threshold, small-scale monthly/quarterly exemptions, and input-VAT breakeven ratio.',
    fields: [
      { key: 'rolling12mTaxableSales', label: '近12个月累计应税销售额（元）', enLabel: 'Rolling 12M Taxable Sales (CNY)', def: '4400000', required: true },
      { key: 'projectedAnnualGrossSales', label: '预计未来年含税营收（元）', enLabel: 'Projected Annual Gross Sales (CNY)', def: '4800000' },
      { key: 'deductibleCostRatio', label: '可获专票含税成本占比（如 0.70）', enLabel: 'Deductible Cost Ratio', def: '0.70' },
      { key: 'hasExportRebateDemand', label: '是否有专票出口退税需求', enLabel: 'Export VAT Rebate Demand', type: 'bool', def: true },
      { key: 'taxPeriod', label: '小规模纳税期限（可选）', enLabel: 'Small-Scale Tax Period', type: 'select', def: '', options: [{ value: '', label: '请选择计税期间' }, { value: 'month', label: '按月（起征点 10 万元）' }, { value: 'quarter', label: '按季（起征点 30 万元）' }] },
      { key: 'periodTaxableSales', label: '当月/当季不含税销售额（元）', enLabel: 'Period Ex-VAT Sales (CNY)', def: '' },
    ],
    advancedFields: [
      { key: 'inputVatRate', label: '取得进项专票税率（默认 0.13）', enLabel: 'Input VAT Rate', def: '0.13' },
      { key: 'generalOutputRate', label: '一般纳税人销项税率（默认 0.13）', enLabel: 'General Output VAT Rate', def: '0.13' },
      { key: 'smallScaleRate', label: '小规模征收率（默认 0.01）', enLabel: 'Small-Scale Levy Rate', def: '0.01' },
      { key: 'periodWaivedSales', label: '放弃起征点免税的不含税销售额（元）', enLabel: 'Waived Exempt Sales (CNY)', def: '0' },
    ],
    exampleParams: { rolling12mTaxableSales: 4400000, projectedAnnualGrossSales: 4800000, deductibleCostRatio: 0.70, smallScaleRate: 0.01 },
    imaKeywords: ['一般纳税人', '500万', '小规模起征点', '增值税法'],
  },
  {
    code: 'cbec_assessed_cit',
    group: 'audit',
    currency: 'CNY',
    zh: '综试区 4% 核定与小型微利',
    en: 'CBEC Assessed CIT & Small-Profit Relief',
    desc: '4% 核定适用于经主管税务机关鉴定的综试区零售出口。小型微利按同一主体年度应纳税所得额（≤300 万）、人数、资产和行业核验，精准反推 300 万临界新增收入空间。',
    enDesc: 'Models CBEC 4% assessed CIT, small low-profit 5% relief (through 2027-12-31), and exact marginal revenue headroom to the 3M CNY cliff.',
    fields: [
      { key: 'revenue', label: '该主体本纳税年度可准确核算的收入总额（元）', enLabel: 'Entity Annual Revenue (CNY)', def: '15000000', required: true },
      { key: 'assessedQualificationConfirmed', label: '主管税务机关已鉴定适用综试区零售出口核定', enLabel: 'Assessed Qualification Confirmed', type: 'confirmation', def: '' },
      { key: 'taxableIncomeRate', label: '核定应税所得率（默认 0.04）', enLabel: 'Assessed Taxable Income Rate', def: '0.04' },
      { key: 'taxYear', label: '纳税年度', enLabel: 'Tax Year', def: '2026' },
      { key: 'annualTaxableIncome', label: '主体年度应纳税所得额（元，≤300 万）', enLabel: 'Annual Taxable Income (CNY)', def: '' },
      { key: 'annualAverageEmployees', label: '全年季度平均从业人数（≤300）', enLabel: 'Annual Average Employees', def: '' },
      { key: 'annualAverageAssets', label: '全年季度平均资产总额（元，≤5,000 万）', enLabel: 'Annual Average Assets (CNY)', def: '' },
      { key: 'nonRestrictedIndustry', label: '从事国家非限制和禁止行业', enLabel: 'Non-Restricted Industry', type: 'confirmation', def: '' },
    ],
    advancedFields: [
      { key: 'citRate', label: '法定企业所得税率（默认 0.25）', enLabel: 'Statutory CIT Rate', def: '0.25' },
      { key: 'marginalTaxableIncomeRate', label: '新增收入适用边际所得率（可选，默认沿用核定所得率）', enLabel: 'Marginal Taxable Income Rate (optional)', def: '' },
    ],
    exampleParams: { revenue: 15000000, taxableIncomeRate: 0.04, taxYear: 2026, assessedQualificationConfirmed: true },
    imaKeywords: ['综试区', '4%核定', '小型微利', '300万'],
  },
  {
    code: 'export_invoice_breakeven',
    group: 'export',
    currency: 'CNY',
    zh: '供应商开票加点毛利临界',
    en: 'Invoice Markup Breakeven g*',
    desc: '对比加税点拿专票走免退税 vs 综试区合规无票免税，算出盈亏临界加点率 g* 与税后净利。',
    enDesc: 'Compares paying supplier invoice markup for VAT export rebate vs compliant no-invoice exemption, computing breakeven markup g* and after-tax CIT impact.',
    fields: [
      { key: 'barePurchaseAmount', label: '无票裸采成本（元）', enLabel: 'Bare Purchase Amount (CNY)', def: '1000000', required: true },
      { key: 'supplierMarkupRate', label: '供应商开票加点率（如 0.08）', enLabel: 'Supplier Markup Rate', def: '0.08', required: true },
      { key: 'vatRate', label: '专票增值税率（如 0.13）', enLabel: 'Invoice VAT Rate', def: '0.13' },
      { key: 'rebateRate', label: '出口退税率（如 0.13 或 0.09）', enLabel: 'Export Rebate Rate', def: '0.13' },
      { key: 'exportRevenue', label: '预计出口营收（元，可选）', enLabel: 'Export Revenue (CNY, optional)', def: '1500000' },
    ],
    advancedFields: [
      { key: 'otherDeductibleExpenses', label: '其他有票可扣成本费用（元）', enLabel: 'Other Deductible Expenses (CNY)', def: '0' },
      { key: 'invoicedCitRate', label: '查账征收所得税率（默认 0.05）', enLabel: 'Invoiced Path CIT Rate', def: '0.05' },
      { key: 'noInvoiceRevenueCitRate', label: '无票核定综合所得税率（默认 0.002）', enLabel: 'No-Invoice Assessed CIT Rate', def: '0.002' },
    ],
    exampleParams: { barePurchaseAmount: 1000000, supplierMarkupRate: 0.08, vatRate: 0.13, rebateRate: 0.13, exportRevenue: 1500000 },
    imaKeywords: ['开票加点', '无票免税', '免退税'],
  },
  {
    code: 'cbec_return_duty_exempt',
    group: 'export',
    currency: 'CNY',
    zh: '2026 第16号退运免税测算',
    en: '2026 #16 Return Duty Exemption',
    desc: '核验 2026–2027 年申报的跨境电商出口批次，按原状非食品、滞销或退货、六个月期限和出口退税证明判断专项资格。',
    enDesc: 'Checks 2026-2027 CBEC return duty-exemption eligibility (9610/9710/9810/1210, 6-month window, non-food, original condition, tax certificate).',
    fields: [
      { key: 'customsCode', label: '原出口海关监管代码', enLabel: 'Original Export Customs Code', type: 'select', def: '9810', options: [{ value: '9610', label: '9610（跨境直邮出口）' }, { value: '9710', label: '9710（跨境B2B直接出口）' }, { value: '9810', label: '9810（跨境出口海外仓）' }, { value: '1210', label: '1210（特殊监管区域出口）' }, { value: '0110', label: '0110（一般贸易）' }, { value: '1039', label: '1039（市场采购）' }] },
      { key: 'exportValueCny', label: '退运商品原出口货值（元）', enLabel: 'Original Export Value (CNY)', def: '300000', required: true },
      { key: 'exportDate', label: '原出口申报日期', enLabel: 'Export Declaration Date', type: 'date', def: '' },
      { key: 'returnDate', label: '退运进境日期', enLabel: 'Return Import Date', type: 'date', def: '' },
      { key: 'zoneExitDate', label: '1210 出区离境日期', enLabel: '1210 Zone Exit Date', type: 'date', def: '', customsCode: '1210' },
      { key: 'returnedOutsideZone', label: '1210 退回境内区外', enLabel: '1210 Returned Outside Zone', type: 'confirmation', def: '', customsCode: '1210' },
      { key: 'returnReason', label: '退运原因', enLabel: 'Return Reason', type: 'select', def: '', options: [{ value: '', label: '请选择退运原因' }, { value: 'unsold', label: '滞销' }, { value: 'customer_return', label: '退货' }, { value: 'other', label: '其他' }] },
      { key: 'inOriginalCondition', label: '是否原状退运进境', enLabel: 'In Original Condition', type: 'confirmation', def: '' },
      { key: 'isFood', label: '是否为食品类商品', enLabel: 'Is Food Item', type: 'confirmation', def: '' },
      { key: 'refundedExportTax', label: '原出口已退税额（元，未退填 0）', enLabel: 'Refunded Export Tax (CNY)', def: '' },
      { key: 'exportRefundRepaid', label: '已退出口税款已缴回', enLabel: 'Export Refund Repaid', type: 'confirmation', def: '' },
      { key: 'hasTaxCertificate', label: '已取得《出口货物已补税/未退税证明》', enLabel: 'Has Tax Certificate', type: 'confirmation', def: '' },
    ],
    advancedFields: [
      { key: 'departureDate', label: '实际出口离境日期（1210 除外）', enLabel: 'Departure Date (non-1210)', type: 'date', def: '', excludeCustomsCode: '1210' },
      { key: 'tariffRate', label: '测算用进口关税率（默认 0.10）', enLabel: 'Import Tariff Rate', def: '0.10' },
      { key: 'importVatRate', label: '测算用进口增值税率（默认 0.13）', enLabel: 'Import VAT Rate', def: '0.13' },
      { key: 'consumptionTaxRate', label: '进口消费税率（默认 0）', enLabel: 'Import Consumption Tax Rate', def: '0' },
    ],
    exampleParams: { customsCode: '9810', exportValueCny: 300000, exportDate: '2026-03-15', returnDate: '2026-07-15', returnReason: 'customer_return', inOriginalCondition: true, isFood: false, refundedExportTax: 0, hasTaxCertificate: true },
    imaKeywords: ['退运免税', '2026年第16号', '9610', '9810'],
  },
  {
    code: 'export_rebate_manufacturer',
    group: 'export',
    currency: 'CNY',
    zh: '生产企业“免、抵、退”税',
    en: 'Manufacturer Exempt-Credit-Refund',
    desc: '工贸一体/工厂卖家出口自产货物五步法精算：应退税额、免抵税额（含城建附加税预警）与留抵结转。',
    enDesc: '5-step Exempt-Credit-Refund calculation for manufacturing exporters including exempt-offset surtax alert and credit carryover.',
    fields: [
      { key: 'exportFobCny', label: '当期出口离岸价 FOB（元）', enLabel: 'Export FOB Value (CNY)', def: '2000000', required: true },
      { key: 'totalInputVat', label: '当期全部可抵扣进项税（元）', enLabel: 'Total Deductible Input VAT (CNY)', def: '220000', required: true },
      { key: 'vatRate', label: '出口适用征税率（如 0.13）', enLabel: 'VAT Rate', def: '0.13' },
      { key: 'rebateRate', label: '商品出口退税率（如 0.13）', enLabel: 'Export Rebate Rate', def: '0.13' },
      { key: 'domesticOutputVat', label: '当期内销销项税额（元）', enLabel: 'Domestic Output VAT (CNY)', def: '40000' },
    ],
    advancedFields: [
      { key: 'dutyFreeMaterialsCny', label: '海关核销免税购进料件价（元）', enLabel: 'Duty-Free Materials (CNY)', def: '0' },
      { key: 'priorCreditCarryover', label: '上期期末留抵税额（元）', enLabel: 'Prior Period Credit Carryover (CNY)', def: '0' },
    ],
    exampleParams: { exportFobCny: 2000000, totalInputVat: 220000, vatRate: 0.13, rebateRate: 0.13, domesticOutputVat: 40000 },
    imaKeywords: ['免抵退', '生产企业出口退税'],
  },
  {
    code: 'export_rebate_cancel_impact',
    group: 'export',
    currency: 'CNY',
    zh: '退税取消与电池消费税双税冲击',
    en: 'Rebate Cancellation & Battery Excise Impact',
    desc: '对比保留原退税 vs 取消退税适用 2026#11 第七条视同内销征税（分列国内生产消费税、购价已含消费税与出口退免额，含 2026#20 电池消费税 4% 无 CMA 主口径门禁与成品充电宝豁免）。',
    enDesc: 'Models VAT export rebate cancellation (deemed domestic VAT) plus 2026 #20 battery excise tax (4% statutory default without CMA, export-exemption switch, finished power-bank exemption).',
    fields: [
      { key: 'purchaseGrossCny', label: '含税采购金额（元，如 113）', enLabel: 'VAT-Inclusive Purchase (CNY)', def: '113', required: true },
      { key: 'exportFobCny', label: '出口离岸价 FOB（元，如 135.60）', enLabel: 'Export FOB Value (CNY)', def: '135.60', required: true },
      { key: 'oldRebateRate', label: '原出口退税率（如电池 0.06 / 光伏 0.13）', enLabel: 'Previous Rebate Rate', def: '0.06' },
      { key: 'newRebateRate', label: '调整后退税率（归零填 0 / 新能源车填 0.09）', enLabel: 'New Rebate Rate', def: '0' },
      { key: 'isConsumptionTaxItem', label: '属 2026#20 列明应税电池/光伏电池', enLabel: 'Subject to Battery Excise Tax', type: 'bool', def: false },
      { key: 'isFinishedPowerBank', label: '为成品充电宝（用电充电系统，不在电池消费税范围）', enLabel: 'Finished Power Bank (Exempt)', type: 'bool', def: false },
    ],
    advancedFields: [
      { key: 'vatRate', label: '增值税税率（默认 0.13）', enLabel: 'VAT Rate', def: '0.13' },
      { key: 'cancelAppliesDeemedDomesticVat', label: '退税归零按 2026#11 第七条视同内销征税', enLabel: 'Apply Deemed Domestic VAT on Cancellation', type: 'bool', def: true },
      { key: 'consumptionTaxRate', label: '消费税率（备齐国标+CMA过渡 0.02 / 法定 0.04）', enLabel: 'Consumption Tax Rate', def: '0.02' },
      { key: 'meetsNationalStandard', label: '符合国家标准（享受减免税前置门禁）', enLabel: 'Meets National Standard', type: 'confirmation', def: '' },
      { key: 'hasValidCmaReport', label: '首次申报减免前已备齐有效 CMA 检测报告', enLabel: 'Valid CMA Report Before Initial Filing', type: 'confirmation', def: '' },
      { key: 'cmaScopeCovered', label: 'CMA 机构资质认定附表覆盖对应检测项目', enLabel: 'CMA Scope Covers Test Items', type: 'confirmation', def: '' },
      { key: 'exportConsumptionTaxExempt', label: '出口消费税退（免）税照旧保留（2026#2/#29第三条）', enLabel: 'Export Consumption Tax Exempt/Refundable', type: 'bool', def: true },
      { key: 'oldConsumptionTaxExempt', label: '原基准期出口消费税退（免）或未开征', enLabel: 'Baseline Export Excise Exempt', type: 'bool', def: true },
      { key: 'purchasePriceIncludesConsumptionTax', label: '采购价已含生产环节消费税（外贸购进退消费税口径）', enLabel: 'Purchase Price Includes Excise Tax', type: 'bool', def: false },
      { key: 'otherCostsCny', label: '其他物流/报关/佣金成本（元）', enLabel: 'Other Costs (CNY)', def: '0' },
    ],
    exampleParams: { purchaseGrossCny: 113, exportFobCny: 135.6, vatRate: 0.13, oldRebateRate: 0.06, newRebateRate: 0 },
    imaKeywords: ['退税取消', '电池消费税', '2026年第11号', 'CMA'],
  },
  {
    code: 'export_rebate',
    group: 'export',
    currency: 'CNY',
    zh: '外贸企业出口免退税',
    en: 'Trading Export VAT Rebate',
    desc: '按专票不含税额与征退税率孰低规则精算应退税额及征退税率差转成本。',
    enDesc: 'Calculates trading-company export VAT refund using the lower of invoice VAT rate and export rebate rate, plus non-refundable cost transfer.',
    fields: [
      { key: 'purchaseAmount', label: '进项专票不含税金额（元）', enLabel: 'Ex-VAT Invoice Amount (CNY)', def: '500000', required: true },
      { key: 'vatRate', label: '专票适用征税率（如 0.13）', enLabel: 'Invoice VAT Rate', def: '0.13' },
      { key: 'rebateRate', label: '商品出口退税率（如 0.09）', enLabel: 'Export Rebate Rate', def: '0.09' },
    ],
    advancedFields: [],
    exampleParams: { purchaseAmount: 500000, vatRate: 0.13, rebateRate: 0.09 },
    imaKeywords: ['外贸企业出口退税', '免退税'],
  },
  {
    code: 'annual_bonus_iit',
    group: 'general',
    currency: 'CNY',
    zh: '年终奖双轨比选与 6 盲区',
    en: 'Annual Bonus Dual-Track IIT',
    desc: '支持「单独计税 vs 并入综合所得」双向最优比选（留空综合所得则仅算单独计税），同步检测 6 档多发 1 元倒挂陷阱。',
    enDesc: 'Compares separate vs combined annual bonus IIT calculation and detects all 6 inverted tax-cliff trap bands.',
    fields: [
      { key: 'bonus', label: '全年一次性奖金总额（元）', enLabel: 'Annual Bonus Amount (CNY)', def: '36001', required: true },
      { key: 'annualComprehensiveTaxableIncome', label: '不含奖金年综合所得应纳税所得额（元，可填负值/留空）', enLabel: 'Annual Comprehensive Taxable Income (CNY)', def: '' },
      { key: 'annualSalary', label: '或填年税前工资薪金（元，自动扣 6 万及下方项）', enLabel: 'Annual Gross Salary (CNY, optional)', def: '' },
    ],
    advancedFields: [
      { key: 'basicDeduction', label: '年度基本减除费用（默认 60000）', enLabel: 'Annual Basic Deduction (CNY)', def: '60000' },
      { key: 'socialInsurance', label: '全年三险一金个人缴纳（元）', enLabel: 'Social Insurance & Housing Fund (CNY)', def: '0' },
      { key: 'specialAdditionalDeduction', label: '全年专项附加扣除（元）', enLabel: 'Special Additional Deductions (CNY)', def: '0' },
      { key: 'otherDeductions', label: '其他依法扣除（元）', enLabel: 'Other Deductions (CNY)', def: '0' },
    ],
    exampleParams: { bonus: 36000, annualComprehensiveTaxableIncome: 120000 },
    imaKeywords: ['年终奖', '单独计税', '个人所得税'],
  },
  {
    code: 'cross_border_import',
    group: 'general',
    currency: 'CNY',
    zh: '跨境零售进口综合税',
    en: 'Cross-Border Retail Import Tax',
    desc: '限额内 0 关税 + 70% 折算与消费税组成计税价格反算，含单次 5000 / 年度 26000 预警。',
    enDesc: 'Calculates China CBEC retail import composite tax (0% duty, 70% VAT/excise within 5,000/26,000 CNY quota).',
    fields: [
      { key: 'price', label: '单笔完税价格（元）', enLabel: 'Dutiable Value (CNY)', def: '1200', required: true },
      { key: 'vatRate', label: '增值税率（默认 0.13）', enLabel: 'Import VAT Rate', def: '0.13' },
      { key: 'consumptionTaxRate', label: '消费税率（如高档护肤品 0.15）', enLabel: 'Consumption Tax Rate', def: '0.15' },
      { key: 'annualUsed', label: '本年已用个人额度（元）', enLabel: 'Annual Quota Used (CNY)', def: '0' },
    ],
    advancedFields: [
      { key: 'discount', label: '综合税折算比例（默认 0.70）', enLabel: 'Composite Tax Discount Factor', def: '0.7' },
      { key: 'singleLimit', label: '单次交易限值（默认 5000）', enLabel: 'Single Transaction Limit (CNY)', def: '5000' },
      { key: 'annualLimit', label: '年度个人限值（默认 26000）', enLabel: 'Annual Individual Limit (CNY)', def: '26000' },
    ],
    exampleParams: { price: 1200, vatRate: 0.13, consumptionTaxRate: 0.15, annualUsed: 0 },
    imaKeywords: ['跨境零售进口', '综合税', '1210'],
  },
  {
    code: 'vat',
    group: 'general',
    currency: 'CNY',
    zh: '增值税价税分离',
    en: 'VAT Split',
    desc: '对齐 2026《增值税法》口径的含税/不含税双向精确换算。',
    enDesc: 'Converts VAT-inclusive and VAT-exclusive amounts cleanly under China VAT Law (effective 2026-01-01).',
    fields: [
      { key: 'amount', label: '合同金额（元）', enLabel: 'Contract Amount (CNY)', def: '1130000', required: true },
      { key: 'rate', label: '适用税率（如 0.13 / 0.06 / 0.01）', enLabel: 'VAT Rate', def: '0.13' },
      { key: 'inclusive', label: '金额是否含税', enLabel: 'Amount Is VAT-Inclusive', type: 'bool', def: true },
    ],
    advancedFields: [],
    exampleParams: { amount: 1130000, rate: 0.13, inclusive: true },
    imaKeywords: ['增值税法', '价税分离'],
  },
]

export const ALL_CALC_SPECS = Object.freeze([
  ...BASE_CALC_SPECS.filter((s) => s.group === 'audit'),
  ...CROSSBORDER_CALC_SPECS.filter((s) => s.group === 'crossborder'),
  ...CROSSBORDER_CALC_SPECS.filter((s) => s.group === 'export'),
  ...BASE_CALC_SPECS.filter((s) => s.group === 'export'),
  ...BASE_CALC_SPECS.filter((s) => s.group === 'general'),
])

export const ALL_CALC_SCENARIOS = Object.freeze(ALL_CALC_SPECS.map((s) => s.code))

/** 返回全部 14 个确定性算税引擎的完整规格注册表副本（供 /api/fintax/calc/specs 使用）。 */
export function getAllCalcSpecs() {
  return ALL_CALC_SPECS.map((spec) => structuredClone(spec))
}


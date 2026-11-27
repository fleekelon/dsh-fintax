import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ALL_CALC_SCENARIOS,
  ALL_CALC_SPECS,
  CalcInputError,
  annualBonusIit,
  calculate,
  cbecAssessedCit,
  cbecReturnDutyExempt,
  euLowValueParcel,
  exportRebateCancelImpact,
  fbaMixedProcurementSplit,
  getAllCalcSpecs,
  usT86Vs9810Ddp,
  vat,
  vatTaxpayerThreshold,
} from '../lib/calc.js'
import { optIsoDate } from '../lib/calc_shared.js'

test('RT-B1 [P0-06 + R2 P1-3 + ChatGPT P0-9] export_rebate_cancel_impact：分离新旧消费税负担真实驱动 profitDelta/FOB、四象限非抵消与国标/CMA/附表硬门禁', () => {
  // 1) 无 CMA 报告 + consumptionTaxRate=0.02 + exportConsumptionTaxExempt=true：
  // 主口径按法定 4%（4 元），仅基准 2 元退免，无 CMA 风险差额 2 元真实计入新口径负担（profitDelta = -10.6，FOB = 147.58）
  const exemptTrueNoCma = exportRebateCancelImpact({
    purchaseGrossCny: 113,
    exportFobCny: 135.6,
    vatRate: 0.13,
    oldRebateRate: 0.06,
    newRebateRate: 0,
    isConsumptionTaxItem: true,
    isFinishedPowerBank: false,
    consumptionTaxRate: 0.02,
    hasValidCmaReport: false,
    exportConsumptionTaxExempt: true,
  })
  assert.equal(exemptTrueNoCma.cmaGateBlocked, true)
  assert.equal(exemptTrueNoCma.applicableConsumptionTaxRate, 0.04)
  assert.equal(exemptTrueNoCma.domesticProductionConsumptionTaxCny, 4)
  assert.equal(exemptTrueNoCma.domesticConsumptionTaxRef, 4)
  assert.equal(exemptTrueNoCma.conditionalCmaConsumptionTaxRef, 2)
  assert.equal(exemptTrueNoCma.cmaRiskExtraTax, 2)
  assert.equal(exemptTrueNoCma.exportConsumptionTaxRefundableCny, 2)
  assert.equal(exemptTrueNoCma.unrefundedConsumptionTaxCostCny, 2)
  assert.equal(exemptTrueNoCma.oldGrossProfit, 28.6)
  assert.equal(exemptTrueNoCma.newGrossProfit, 18)
  assert.equal(exemptTrueNoCma.profitDelta, -10.6)
  assert.equal(exemptTrueNoCma.requiredFobToKeepProfit, 147.58)
  assert.ok(exemptTrueNoCma.summaryLine.includes('4 元') && exemptTrueNoCma.summaryLine.includes('主口径按法定 4%'))

  // 2) exportConsumptionTaxExempt=false：新增未退免消费税 4 元真实扣减新口径毛利并抬升保毛利 FOB 至 149.84（绝不与旧毛利正负抵消！）
  const exemptFalseNoCma = exportRebateCancelImpact({
    purchaseGrossCny: 113,
    exportFobCny: 135.6,
    vatRate: 0.13,
    oldRebateRate: 0.06,
    newRebateRate: 0,
    isConsumptionTaxItem: true,
    isFinishedPowerBank: false,
    consumptionTaxRate: 0.02,
    hasValidCmaReport: false,
    exportConsumptionTaxExempt: false,
  })
  assert.equal(exemptFalseNoCma.unrefundedConsumptionTaxCostCny, 4)
  assert.equal(exemptFalseNoCma.exportConsumptionTaxRefundableCny, 0)
  assert.equal(exemptFalseNoCma.oldGrossProfit, 28.6)
  assert.equal(exemptFalseNoCma.newGrossProfit, 16) // 20 - 4
  assert.equal(exemptFalseNoCma.profitDelta, -12.6)
  assert.equal(exemptFalseNoCma.requiredFobToKeepProfit, 149.84)
  // 闭环回代 FOB 149.84：新毛利 >= 原毛利 28.60，零 -0.01 跌破
  const loopbackSame = exportRebateCancelImpact({
    purchaseGrossCny: 113,
    exportFobCny: exemptFalseNoCma.requiredFobToKeepProfit,
    vatRate: 0.13,
    oldRebateRate: 0.06,
    newRebateRate: 0,
    isConsumptionTaxItem: true,
    consumptionTaxRate: 0.02,
    hasValidCmaReport: false,
    exportConsumptionTaxExempt: false,
  })
  assert.ok(loopbackSame.newGrossProfit >= exemptFalseNoCma.oldGrossProfit)
  assert.equal(exemptFalseNoCma.requiredFobToKeepPreConsumptionTaxProfit, 149.84)
  assert.equal(exemptFalseNoCma.summaryLine.includes('出口退免照旧'), false)
  assert.equal(exemptFalseNoCma.warnings.some((w) => w.includes('消费税出口退免照旧')), false)
  assert.ok(exemptFalseNoCma.warnings.some((w) => w.includes('未适用出口消费税退（免）税')))

  // 3) 购价已含消费税（外贸购进退消费税口径）：开/关出口退免在新口径与 profitDelta 上真实相差 4 元
  const embeddedTrue = exportRebateCancelImpact({
    purchaseGrossCny: 113,
    exportFobCny: 135.6,
    isConsumptionTaxItem: true,
    consumptionTaxRate: 0.04,
    purchasePriceIncludesConsumptionTax: true,
    exportConsumptionTaxExempt: true,
  })
  const embeddedFalse = exportRebateCancelImpact({
    purchaseGrossCny: 113,
    exportFobCny: 135.6,
    isConsumptionTaxItem: true,
    consumptionTaxRate: 0.04,
    purchasePriceIncludesConsumptionTax: true,
    exportConsumptionTaxExempt: false,
  })
  assert.equal(embeddedTrue.purchaseEmbeddedConsumptionTaxCny, 4)
  assert.equal(embeddedTrue.exportConsumptionTaxRefundableCny, 4)
  assert.equal(embeddedTrue.oldGrossProfit, 32.6)
  assert.equal(embeddedTrue.newGrossProfit, 24)
  assert.equal(embeddedTrue.profitDelta, -8.6)
  assert.equal(embeddedFalse.oldGrossProfit, 32.6)
  assert.equal(embeddedFalse.newGrossProfit, 20)
  assert.equal(embeddedFalse.profitDelta, -12.6)

  // 4) 备齐国标 + 有效 CMA 报告时适用 2% 过渡税率
  const withCma = exportRebateCancelImpact({
    purchaseGrossCny: 113000,
    exportFobCny: 135600,
    isConsumptionTaxItem: true,
    consumptionTaxRate: 0.02,
    hasValidCmaReport: true,
    exportConsumptionTaxExempt: false,
  })
  assert.equal(withCma.cmaGateBlocked, false)
  assert.equal(withCma.applicableConsumptionTaxRate, 0.02)
  assert.equal(withCma.domesticProductionConsumptionTaxCny, 2000)
  assert.equal(withCma.unrefundedConsumptionTaxCostCny, 2000)
  assert.equal(withCma.cmaRiskExtraTax, 0)
  assert.equal(withCma.profitDelta, -10600)
})

test('RT-B2 [P0-07 + R2 P1-13 + R2 P2-06] eu_low_value_parcel：€2 按项计收(€1.67/€42.25)、海外仓盈亏线 €8、向上取分一致与反推跨 €150 阻断', () => {
  // 1) 原反例：售价 €35.70、退货率 8%、2 申报项 → €6 关税 + €4 处理费，直邮净利 €1.67，保毛利最低可执行价 €42.25
  const r = euLowValueParcel({
    sellingPriceEur: 35.7,
    vatRate: 0.19,
    hsLineCount: 2,
    purchaseCostEur: 7,
    directShippingEur: 4,
    commissionRate: 0.15,
    commissionOnVatInclusive: true,
    returnRate: 0.08,
    targetMarginRate: 0.15,
  })
  assert.equal(r.euTempDutyEur, 6)
  assert.equal(r.euHandlingFeeEur, 4)
  assert.equal(r.euCustomsLevyTotalEur, 10)
  assert.equal(r.returnSunkHandlingFeeEur, 0.32) // 4 * 0.08
  assert.equal(r.netProfitEur, 1.67)
  assert.equal(r.minSellingPriceEur, 42.25)
  assert.equal(r.minSellingPriceCeilEur, 42.25)
  assert.equal(r.breakdown.reversePricing.mixedDirect.minSellingPriceEur, 42.25)
  assert.equal(r.breakdown.reversePricing.mixedDirect.minSellingPriceCeilEur, 42.25)
  assert.equal(r.breakdown.reversePricing.mixedDirect.priceIncreaseNeededEur, 6.55) // 42.25 - 35.70
  assert.equal(r.breakdown.reversePricing.mixedDirect.exceeds150Threshold, false)
  assert.equal(r.breakdown.reversePricing.mixedDirect.feasibleUnderLowValueRegime, true)
  // 同购物篮物理拆包 vs 简化为单税则 SKU 组合明确区分
  assert.equal(r.breakdown.planComparison.splitParcelByHsDirect.mode, 'same_basket_physical_split')
  assert.equal(r.breakdown.planComparison.splitParcelByHsDirect.shippingEur, 8) // 4 * 2
  assert.equal(r.breakdown.planComparison.splitParcelByHsDirect.customsLevyEur, 10)
  assert.equal(r.breakdown.planComparison.splitParcelByHsDirect.netProfitEur, -2.33) // 1.67 - 4
  assert.equal(r.breakdown.planComparison.singleHsDirect.mode, 'simplified_single_hs_sku_bundle')
  assert.equal(r.breakdown.planComparison.singleHsDirect.sameBasketEquivalent, false)
  assert.equal(r.recommendedPlan, 'mixed_direct') // 不把换 SKU 的 singleHs 当作同购物篮方案推荐

  // 2) 海外仓盈亏平衡履约线补齐退货回收率差：€12 精确修正为 €8，且在 €8 处净利精确打平
  const whLine = euLowValueParcel({
    sellingPriceEur: 119,
    vatRate: 0.19,
    hsLineCount: 2,
    purchaseCostEur: 40,
    directShippingEur: 2, // 运费 2 + 税费 10 = 12；退货回收率差 40 * 0.2 * (0 - 0.5) = -4 → 盈亏线 = 8
    commissionRate: 0.15,
    returnRate: 0.2,
    returnGoodsRecoveryRate: 0.5,
    euWarehouseReturnRecoveryRate: 0,
    euWarehouseTotalLogisticsEur: 8,
  })
  assert.equal(whLine.breakdown.planComparison.euWarehouse.returnRecoveryAdjustmentEur, -4)
  assert.equal(whLine.breakdown.planComparison.euWarehouse.breakevenTotalLogisticsVsMixedEur, 8)
  assert.equal(whLine.breakdown.planComparison.euWarehouse.advantageVsMixedDirectEur, 0)

  // 3) 反推售价精确解 30.004 统一向上取分：主字段 = 30.01、调价 = 0.01，零矛盾
  // 构造 exactP = 30.004：vat=0, comm=0, returnRate=0, targetMargin=0 => exactP = fixedCost = 30.004
  const ceilCheck = euLowValueParcel({
    sellingPriceEur: 30,
    vatRate: 0,
    hsLineCount: 1,
    purchaseCostEur: 25.004, // + 3 duty + 2 handling = 30.004
    directShippingEur: 0,
    commissionRate: 0,
    returnRate: 0,
    targetMarginRate: 0,
  })
  const rpCeil = ceilCheck.breakdown.reversePricing.mixedDirect
  assert.equal(rpCeil.minSellingPriceExactEur, 30.004)
  assert.equal(rpCeil.minSellingPriceEur, 30.01)
  assert.equal(rpCeil.minSellingPriceCeilEur, 30.01)
  assert.equal(ceilCheck.minSellingPriceEur, 30.01)
  assert.equal(rpCeil.priceIncreaseNeededEur, 0.01)

  // 4) 反推售价跨 €150 内在价值门槛（如反推 €414.56）必须标 exceeds150Threshold=true & feasibleUnderLowValueRegime=false & feasible=false
  const over150Rev = euLowValueParcel({
    sellingPriceEur: 120,
    vatRate: 0.19,
    hsLineCount: 2,
    purchaseCostEur: 100,
    directShippingEur: 10,
    commissionRate: 0.15,
    commissionOnVatInclusive: true,
    returnRate: 0.1,
    targetMarginRate: 0.36, // contribRate = 1/1.19 - 0.15 - 0.36 = 0.330336 -> exactP ≈ 403.6 -> >150 ex-VAT
  })
  const rpOver = over150Rev.breakdown.reversePricing.mixedDirect
  assert.equal(rpOver.exceeds150Threshold, true)
  assert.equal(rpOver.feasibleUnderLowValueRegime, false)
  assert.equal(rpOver.feasible, false)
  assert.equal(rpOver.minSellingPriceEur, null)
  assert.ok(rpOver.unconstrainedMinSellingPriceEur > 300)
  assert.ok(rpOver.minNetPriceExclVatEur > 150)
  assert.ok(over150Rev.warnings.some((w) => w.includes('€150') && w.includes('阻断')))
})

test('RT-B3 [P0-08 + R2 P0-1 + P1-01 + P2-05] us_t86_vs_9810_ddp：禁止单端日期互填、2026-02-24 停收时点、Type 11 $2,500 拦截、自定义 FBA 涨价与 FIOR 法规精修', () => {
  const base = {
    sellingPriceUsd: 35,
    purchaseCostUsd: 8,
    declaredValueUsd: 9,
    tariffRate: 0.35,
    type11ShippingUsd: 8,
    type11ClearanceFeeUsd: 3,
    ddpFirstLegUsd: 2,
    localDeliveryUsd: 5,
  }

  // 1) 单端日期禁止互填：仅传 entryPeriodStart 或仅传 entryPeriodEnd → pending_period, eligible=false, 退税=0
  const onlyStart = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 15000,
    tariffProgram: 'IEEPA',
    entryPeriodStart: '2025-05-01',
    aceAchBound: true,
  })
  assert.equal(onlyStart.breakdown.ieepaRefund.status, 'pending_period')
  assert.equal(onlyStart.breakdown.ieepaRefund.eligible, false)
  assert.equal(onlyStart.ieepaEligibleRefundUsd, 0)
  assert.equal(onlyStart.breakdown.ieepaRefund.entryPeriodEnd, null)

  const onlyEnd = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 15000,
    tariffProgram: 'IEEPA',
    entryPeriodEnd: '2026-01-15',
    aceAchBound: true,
  })
  assert.equal(onlyEnd.breakdown.ieepaRefund.status, 'pending_period')
  assert.equal(onlyEnd.breakdown.ieepaRefund.eligible, false)
  assert.equal(onlyEnd.ieepaEligibleRefundUsd, 0)
  assert.equal(onlyEnd.breakdown.ieepaRefund.entryPeriodStart, null)

  // 2) 未显式指定 tariffProgram 严禁默认按 IEEPA 放行 → pending_verification, eligible=false, 退税=0
  const noProgram = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 15000,
    entryPeriodStart: '2025-05-01',
    entryPeriodEnd: '2026-01-15',
    aceAchBound: true,
  })
  assert.equal(noProgram.breakdown.ieepaRefund.status, 'pending_verification')
  assert.equal(noProgram.breakdown.ieepaRefund.eligible, false)
  assert.equal(noProgram.ieepaEligibleRefundUsd, 0)

  // 3) 显式单日字段 entryDate='2026-02-20'（CBP 美东 2026-02-24 00:00 停收前）不再被误杀归零
  const feb20 = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 8800,
    tariffProgram: 'IEEPA',
    entryDate: '2026-02-20',
    aceAchBound: true,
  })
  assert.equal(feb20.breakdown.ieepaRefund.status, 'eligible_reference')
  assert.equal(feb20.breakdown.ieepaRefund.eligible, true)
  assert.equal(feb20.ieepaEligibleRefundUsd, 8800)
  assert.equal(feb20.breakdown.ieepaRefund.eligibleWindow.cutoffTimestampEst, '2026-02-24T00:00:00-05:00')

  // 2026-02-24 当日（停收日起）被拦截归零
  const feb24 = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 8800,
    tariffProgram: 'IEEPA',
    entryDate: '2026-02-24',
    aceAchBound: true,
  })
  assert.equal(feb24.breakdown.ieepaRefund.status, 'out_of_window')
  assert.equal(feb24.ieepaEligibleRefundUsd, 0)

  // 4) Type 11 $2,500 商业货资格拦截：$5,000 商业货即使直邮运费更低也严禁推荐 Type 11！
  const highVal = usT86Vs9810Ddp({
    sellingPriceUsd: 8000,
    purchaseCostUsd: 5000,
    declaredValueUsd: 5000,
    tariffRate: 0.25,
    type11ShippingUsd: 100,
    type11ClearanceFeeUsd: 50,
    ddpFirstLegUsd: 300,
    localDeliveryUsd: 200,
    commissionRate: 0.1,
  })
  assert.equal(highVal.type11Eligible, false)
  assert.equal(highVal.breakdown.type11Direct.eligible, false)
  assert.equal(highVal.breakdown.type11Direct.fallbackEntryType, 'Type 01 (Formal Entry)')
  assert.notEqual(highVal.recommendedPath, 'type11_direct')
  assert.equal(highVal.recommendedPath, '9810_ddp')
  assert.ok(highVal.warnings.some((w) => w.includes('$2,500') && w.includes('Type 01')))
  assert.ok(highVal.summaryLine.includes('Type 11 不适用'))

  // 5) 自定义 fba2027DeltaUsd 覆盖全盘平均 $0.19 假设
  const customFba = usT86Vs9810Ddp({
    ...base,
    apply2027FbaHike: true,
    fba2027DeltaUsd: 0.45,
  })
  const defaultFba = usT86Vs9810Ddp({
    ...base,
    apply2027FbaHike: true,
  })
  assert.equal(customFba.fba2027DeltaUsd, 0.45)
  assert.equal(Math.round((defaultFba.ddpNetProfitUsd - customFba.ddpNetProfitUsd) * 100) / 100, 0.26) // 0.45 - 0.19

  // 6) 清理 L727 当期税栈不再含芬太尼/对等已停收 IEEPA 税 & FIOR 法规精准表述（无负担美国不动产 + §111.29 须申请获准）
  const policyText = JSON.stringify(feb20.policyRefs)
  assert.equal(policyText.includes('芬太尼/对等关税'), false)
  assert.ok(feb20.breakdown.fiorCtpatCompliance.notice.includes('无负担美国不动产'))
  assert.ok(feb20.breakdown.fiorCtpatCompliance.notice.includes('申请获准'))
  assert.equal(feb20.breakdown.fiorCtpatCompliance.rule11129RequiresApproval, true)
  assert.equal(feb20.breakdown.fiorCtpatCompliance.alternativeAssetScope, 'continuously_directly_owned_unencumbered_us_real_property')
  assert.ok(feb20.warnings.some((w) => w.includes('无负担美国不动产') && w.includes('申请获准') && w.includes('位于美国且依法在美设立')))
})

test('RT-B4 [P1-02] fba_mixed_procurement_split：进项留抵单列不误计亏损（FOB 100,000 / 有票 226,000 / 无票 10,000 / 报关 1,500 → 损益 -123,004.42 + 留抵 14,495.58）', () => {
  const r = fbaMixedProcurementSplit({
    totalExportCny: 100000,
    invoicedPurchaseGrossCny: 226000,
    noInvoicePurchaseCny: 10000,
    mixedSingleDeclarationCostCny: 1500,
    invoicedVatRate: 0.13,
    deemedDomesticVatRate: 0.13,
    surtaxRate: 0.12,
  })
  assert.equal(r.mixedDeemedVatPayableCny, 0)
  assert.equal(r.mixedDeemedEndingInputVatCreditCny, 14495.58)
  assert.equal(r.mixedDeemedNetProfitCny, -123004.42)
  assert.equal(r.mixedDeemedCashFlowCny, -137500)
  assert.equal(r.breakdown.planComparison.mixedRiskDeemedDomestic.endingInputVatCreditCny, 14495.58)
  assert.equal(r.breakdown.planComparison.mixedRiskDeemedDomestic.netProfitCny, -123004.42)
  assert.notEqual(r.mixedDeemedNetProfitCny, -137500)
  assert.ok(r.warnings.some((w) => w.includes('期末留抵进项税额') && w.includes('14495.58')))
})

test('RT-B5 [P1-03 + R2 P1-14] cbec_assessed_cit：300 万元临界自定义全年应税所得精准反推新增收入空间（2,990,000→250,000；2,999,999→25；无边际所得率→null）', () => {
  const r1 = cbecAssessedCit({
    revenue: 10_000_000,
    taxableIncomeRate: 0.04,
    annualTaxableIncome: 2_990_000,
  })
  assert.equal(r1.cliffComparison.remainingIncomeTo3m, 10000)
  assert.equal(r1.cliffComparison.remainingRevenueToCliff, 250000)

  const r2 = cbecAssessedCit({
    revenue: 10_000_000,
    taxableIncomeRate: 0.04,
    annualTaxableIncome: 2_999_999,
  })
  assert.equal(r2.cliffComparison.remainingIncomeTo3m, 1)
  assert.equal(r2.cliffComparison.remainingRevenueToCliff, 25)

  // 缺少有效边际所得率假设（taxableIncomeRate=0 或 marginalTaxableIncomeRate=0 或 assumeMarginalRateSameAsAssessed=false）返回 null
  const rNoRate1 = cbecAssessedCit({
    revenue: 10_000_000,
    taxableIncomeRate: 0,
    annualTaxableIncome: 2_990_000,
  })
  assert.equal(rNoRate1.cliffComparison.remainingRevenueToCliff, null)

  const rNoRate2 = cbecAssessedCit({
    revenue: 10_000_000,
    taxableIncomeRate: 0.04,
    annualTaxableIncome: 2_990_000,
    marginalTaxableIncomeRate: 0,
  })
  assert.equal(rNoRate2.cliffComparison.remainingRevenueToCliff, null)

  const rNoRate3 = cbecAssessedCit({
    revenue: 10_000_000,
    taxableIncomeRate: 0.04,
    annualTaxableIncome: 2_990_000,
    assumeMarginalRateSameAsAssessed: false,
  })
  assert.equal(rNoRate3.cliffComparison.remainingRevenueToCliff, null)

  // 自定义边际所得率 10%：10,000 / 0.10 = 100,000
  const rCustomMargin = cbecAssessedCit({
    revenue: 10_000_000,
    taxableIncomeRate: 0.04,
    annualTaxableIncome: 2_990_000,
    marginalTaxableIncomeRate: 0.1,
  })
  assert.equal(rCustomMargin.cliffComparison.remainingRevenueToCliff, 100000)
})

test('RT-B6 完整 14 引擎规格注册表 ALL_CALC_SPECS / getAllCalcSpecs() 与 SKILL.md 法规口径核验', () => {
  assert.equal(ALL_CALC_SPECS.length, 14)
  assert.equal(ALL_CALC_SCENARIOS.length, 14)
  assert.equal(new Set(ALL_CALC_SCENARIOS).size, 14)

  const specsCopy = getAllCalcSpecs()
  assert.equal(specsCopy.length, 14)
  // 修改副本不得污染导出常量
  specsCopy[0].zh = 'MUTATED'
  assert.notEqual(ALL_CALC_SPECS[0].zh, 'MUTATED')

  for (const spec of ALL_CALC_SPECS) {
    assert.ok(spec.code && spec.group && spec.currency && spec.zh && spec.en && spec.desc, `${spec.code} 缺必填元数据`)
    assert.ok(Array.isArray(spec.fields) && spec.fields.length >= 3, `${spec.code} fields 缺失`)
    assert.ok(spec.exampleParams && typeof spec.exampleParams === 'object', `${spec.code} exampleParams 缺失`)
    assert.ok(Array.isArray(spec.imaKeywords) && spec.imaKeywords.length >= 2, `${spec.code} imaKeywords 缺失`)
    const out = calculate(spec.code, spec.exampleParams)
    assert.ok(out && typeof out.scenario === 'string', `${spec.code} exampleParams 无法通过 calculate 执行`)
  }

  // SKILL.md 法规精修核验
  const crossborderMd = readFileSync(new URL('../skills/fintax-crossborder-check/SKILL.md', import.meta.url), 'utf8')
  const calcMd = readFileSync(new URL('../skills/fintax-calc/SKILL.md', import.meta.url), 'utf8')
  const policyMd = readFileSync(new URL('../skills/fintax-policy-qa/SKILL.md', import.meta.url), 'utf8')
  for (const [name, md] of [['fintax-crossborder-check', crossborderMd], ['fintax-calc', calcMd], ['fintax-policy-qa', policyMd]]) {
    assert.equal(md.includes('2026-02-19'), false, `${name} 不得再残留旧 2026-02-19 停收日`)
    assert.ok(md.includes('2026-02-24'), `${name} 应标明 CBP 美东 2026-02-24 停收时点`)
    assert.ok(md.includes('无负担美国不动产'), `${name} 应精准限定 FIOR 替代资产为无负担美国不动产`)
    assert.ok(md.includes('申请获准'), `${name} 应标明 §111.29 延期须申请获准`)
    assert.equal(md.includes('CTPAT-certified'), false, `${name} 不得含 CTPAT-certified`)
    assert.equal(md.includes('--profile default'), false, `${name} 不得含 --profile default`)
  }
})


test('RT-B7 [R2 #75 P1-2 & ChatGPT P1] eu_low_value_parcel：€150.00 浮点边界不刺穿、单列运费剥离、超 €150 停推低值直邮与无解原因透传', () => {
  // 1) 152.55 / 1.017 与 155.55 / 1.037 精确等于 €150.00，严禁被 IEEE-754 误判超 €150！
  for (const [price, vatRate] of [[152.55, 0.017], [155.55, 0.037], [180, 0.2]]) {
    const exact150 = euLowValueParcel({ sellingPriceEur: price, vatRate, hsLineCount: 1 })
    assert.equal(exact150.netPriceExclVatEur, 150)
    assert.equal(exact150.exceeds150Threshold, false, `price=${price}, vat=${vatRate} 不得误判超 €150`)
    assert.equal(exact150.warnings.some((w) => w.includes('已超过 €150')), false)
  }

  // 2) 含税总价 €190.40 中含发票单列运费 €11.90（VAT 19%）→ 不含税内在货值 = (190.40 - 11.90) / 1.19 = €150.00 ≤ €150
  const sepShip = euLowValueParcel({ sellingPriceEur: 190.4, separateShippingInPriceEur: 11.9, vatRate: 0.19 })
  assert.equal(sepShip.netPriceExclVatEur, 160)
  assert.equal(sepShip.intrinsicValueExclVatEur, 150)
  assert.equal(sepShip.exceeds150Threshold, false)

  // 3) 原包裹已超 €150 内在价值门槛时，停止推荐 mixed_direct / single_hs_direct
  const overNoWh = euLowValueParcel({ sellingPriceEur: 200, vatRate: 0.19, hsLineCount: 2 })
  assert.equal(overNoWh.exceeds150Threshold, true)
  assert.equal(overNoWh.recommendedPlan, 'general_trade_clearance')
  assert.equal(overNoWh.recommendedOption, 'general_trade_clearance')
  assert.equal(overNoWh.infeasibleReason, 'exceeds_150_low_value_threshold')

  const overWithWh = euLowValueParcel({
    sellingPriceEur: 200, vatRate: 0.19, hsLineCount: 2, euWarehouseTotalLogisticsEur: 6,
  })
  assert.equal(overWithWh.recommendedOption, 'eu_warehouse')

  // 4) 目标净利率数学无解时返回 null + infeasibleReason='exceeds_theoretical_margin_cap'，并暴露 singleHsConsolidationSavingEur
  const mathInfeasible = euLowValueParcel({
    sellingPriceEur: 35.7, vatRate: 0.19, hsLineCount: 3, commissionRate: 0.15, targetMarginRate: 0.9,
  })
  assert.equal(mathInfeasible.minSellingPriceEur, null)
  assert.equal(mathInfeasible.infeasibleReason, 'exceeds_theoretical_margin_cap')
  assert.equal(mathInfeasible.singleHsConsolidationSavingEur, 6)
  assert.equal(mathInfeasible.unpackDutySavingEur, 6)
  assert.ok(mathInfeasible.policyRefs[0].note.includes('2026-07-01') && mathInfeasible.policyRefs[0].note.includes('2026-11-01'))
})

test('RT-B8 [R2 #75 P1-3 & ChatGPT P0-9/P1] export_rebate_cancel_impact：4 象限非恒等、字符串"false"识别、国标/附表拦截、非标税率告警与 200 组 FOB 回代零跌破', () => {
  // 1) #75 [P1-3] 原反例四象限遍历：profitDelta 与 requiredFobToKeepProfit 随 CMA 与退免开关真实单调变化
  const runQ = (hasValidCmaReport, exportConsumptionTaxExempt) => exportRebateCancelImpact({
    purchaseGrossCny: 113, exportFobCny: 135.6, oldRebateRate: 0.06, newRebateRate: 0,
    isConsumptionTaxItem: true, consumptionTaxRate: 0.02, otherCostsCny: 5,
    hasValidCmaReport, exportConsumptionTaxExempt,
  })
  const qTT = runQ(true, true)
  const qFT = runQ(false, true)
  const qTF = runQ(true, false)
  const qFF = runQ(false, false)
  assert.deepEqual([qTT.profitDelta, qTT.requiredFobToKeepProfit], [-8.6, 145.32])
  assert.deepEqual([qFT.profitDelta, qFT.requiredFobToKeepProfit], [-10.6, 147.58])
  assert.deepEqual([qTF.profitDelta, qTF.requiredFobToKeepProfit], [-10.6, 147.58])
  assert.deepEqual([qFF.profitDelta, qFF.requiredFobToKeepProfit], [-12.6, 149.84])

  // 2) 字符串 "false" / "0" 必须被识别为 false；meetsNationalStandard="false" 或 cmaScopeCovered="false" 即使有 CMA 也强制 4%！
  const badStd = exportRebateCancelImpact({
    purchaseGrossCny: 113, exportFobCny: 135.6, isConsumptionTaxItem: 'true',
    consumptionTaxRate: 0.02, hasValidCmaReport: 'true', meetsNationalStandard: 'false',
    exportConsumptionTaxExempt: 'false',
  })
  assert.equal(badStd.cmaGateBlocked, true)
  assert.equal(badStd.applicableConsumptionTaxRate, 0.04)
  assert.equal(badStd.exportConsumptionTaxExempt, false)
  assert.equal(badStd.profitDelta, -12.6)

  const badScope = exportRebateCancelImpact({
    purchaseGrossCny: 113, exportFobCny: 135.6, isConsumptionTaxItem: true,
    consumptionTaxRate: 0.02, hasValidCmaReport: true, cmaScopeCovered: '0',
    exportConsumptionTaxExempt: false,
  })
  assert.equal(badScope.cmaGateBlocked, true)
  assert.equal(badScope.applicableConsumptionTaxRate, 0.04)

  // 3) 非法定电池消费税率（如 8% 无 CMA、1.3% 有 CMA）按法定 4% 兜底并单列 customConsumptionTaxAssumptionRefCny + 告警
  for (const [rate, cma, expectedCustom] of [[0.08, false, 8], [0.013, true, 1.3]]) {
    const nonStat = exportRebateCancelImpact({
      purchaseGrossCny: 113, exportFobCny: 135.6, isConsumptionTaxItem: true,
      consumptionTaxRate: rate, hasValidCmaReport: cma,
    })
    assert.equal(nonStat.nonStatutoryRateProvided, true)
    assert.equal(nonStat.applicableConsumptionTaxRate, 0.04)
    assert.equal(nonStat.customConsumptionTaxAssumptionRefCny, expectedCustom)
    assert.ok(nonStat.warnings.some((w) => w.includes('非法定消费税率')))
  }

  // 4) 扫描 200 组含 purchaseGrossCny=100 的分位边界，验证 requiredFobToKeepProfit 回代后 newGrossProfit 100% >= oldGrossProfit
  for (let i = 0; i < 200; i++) {
    const pg = 100 + i * 0.37
    const r = exportRebateCancelImpact({
      purchaseGrossCny: pg, exportFobCny: pg * 1.2, vatRate: 0.13, oldRebateRate: 0.06, newRebateRate: 0,
      isConsumptionTaxItem: i % 2 === 0, consumptionTaxRate: 0.02, hasValidCmaReport: false, exportConsumptionTaxExempt: false,
    })
    const back = exportRebateCancelImpact({
      purchaseGrossCny: pg, exportFobCny: r.requiredFobToKeepProfit, vatRate: 0.13, oldRebateRate: 0.06, newRebateRate: 0,
      isConsumptionTaxItem: i % 2 === 0, consumptionTaxRate: 0.02, hasValidCmaReport: false, exportConsumptionTaxExempt: false,
    })
    assert.ok(back.newGrossProfit >= r.oldGrossProfit, `pg=${pg} 回代 FOB=${r.requiredFobToKeepProfit} 后 ${back.newGrossProfit} < ${r.oldGrossProfit}`)
  }
})

test('RT-B9 [R2 #75 P1-5 & ChatGPT P1] 数组/对象绕过拦截、MAX_MONETARY=1e11、type11DeclaredValueUsd 诚实假设、移除当期 Section 122、小微 3% 防倒挂与向下取分及奖金量化', () => {
  // 1) 空数组 [] / 对象 {} / 布尔值禁止绕过日期与枚举校验
  assert.throws(() => optIsoDate([], 'entryDate'), CalcInputError)
  assert.throws(() => usT86Vs9810Ddp({ sellingPriceUsd: 50, purchaseCostUsd: 10, tariffProgram: [] }), CalcInputError)
  assert.throws(() => fbaMixedProcurementSplit({ totalExportCny: 1000, invoicedPurchaseGrossCny: 500, noInvoicePurchaseCny: 100, splitNoInvoiceMode: [] }), CalcInputError)
  assert.throws(() => cbecReturnDutyExempt({ exportValueCny: 1000, customsCode: [] }), CalcInputError)
  assert.throws(() => vatTaxpayerThreshold({ rolling12mTaxableSales: 1000, taxPeriod: [] }), CalcInputError)

  // 2) MAX_MONETARY = 1e11 统一拦截超安全整数金额
  assert.throws(() => vat({ amount: 1e16 + 1.13, rate: 0.13 }), CalcInputError)
  assert.throws(() => cbecAssessedCit({ revenue: 1e12 }), CalcInputError)

  // 3) 单传 type11DeclaredValueUsd 时 assumptions[0] 诚实反映传入值，且 policyRefs[0] 不把已到期 Section 122 列入当期有效税栈
  const us3000 = usT86Vs9810Ddp({ sellingPriceUsd: 3500, purchaseCostUsd: 800, type11DeclaredValueUsd: 3000 })
  assert.equal(us3000.type11Eligible, false)
  assert.ok(us3000.assumptions[0].includes('3000') && us3000.assumptions[0].includes('显式传入'))
  assert.equal(us3000.assumptions[0].includes('未单独传入'), false)
  assert.equal(us3000.policyRefs[0].note.includes('仍在生效的 Section 301 / Section 232 / Section 122'), false)
  assert.ok(us3000.policyRefs[0].note.includes('2026-07-24'))

  // 4) cbecAssessedCit: citRate=0.03 不倒挂升至 5%，且 300 万临界新增收入空间严格向下取分
  const cit3 = cbecAssessedCit({ revenue: 1_000_000, citRate: 0.03, smallLowProfit: true })
  assert.equal(cit3.citRateApplied, 0.03)
  assert.ok(cit3.cliffComparison.cliffJumpAtPlusOneYuan >= 0)
  const citFloor = cbecAssessedCit({ revenue: 10_000_000, annualTaxableIncome: 2_900_000, marginalTaxableIncomeRate: 0.07 })
  assert.equal(citFloor.cliffComparison.remainingRevenueToCliff, 1428571.42) // 100000 / 0.07 = 1428571.42857 -> floor 1428571.42

  // 5) annualBonusIit: 36000.001 量化至 36000 按 3% 计税，38566.665 不误报“多 0 元”盲区
  const b1 = annualBonusIit({ bonus: 36000.001 })
  assert.equal(b1.bonus, 36000)
  assert.equal(b1.taxPayable, 1080)
  assert.equal(b1.trap, null)
  const b2 = annualBonusIit({ bonus: 38566.665 })
  assert.equal(b2.trap, null)
})

test('RT-B10 [R2 #92 P1] 购价已含消费税 + 2% 报价：未过国标/CMA/附表门禁绝不倒挂多赚，四象限 22/20/20/18 与 FOB 145.32/147.58/147.58/149.84', () => {
  const base = {
    purchaseGrossCny: 113, exportFobCny: 135.6, oldRebateRate: 0.06, newRebateRate: 0,
    isConsumptionTaxItem: true, consumptionTaxRate: 0.02, purchasePriceIncludesConsumptionTax: true,
  }
  const compliant = { meetsNationalStandard: true, hasValidCmaReport: true, cmaScopeCovered: true }
  const quad = [
    [{ ...compliant, exportConsumptionTaxExempt: true }, 22, -8.6, 145.32],
    [{ hasValidCmaReport: false, exportConsumptionTaxExempt: true }, 20, -10.6, 147.58],
    [{ ...compliant, exportConsumptionTaxExempt: false }, 20, -10.6, 147.58],
    [{ hasValidCmaReport: false, exportConsumptionTaxExempt: false }, 18, -12.6, 149.84],
  ]
  for (const [extra, newGp, delta, fob] of quad) {
    const r = exportRebateCancelImpact({ ...base, ...extra })
    assert.equal(r.oldGrossProfit, 30.6, `old ${JSON.stringify(extra)}`)
    assert.equal(r.newGrossProfit, newGp, `new ${JSON.stringify(extra)}`)
    assert.equal(r.profitDelta, delta, `delta ${JSON.stringify(extra)}`)
    assert.equal(r.requiredFobToKeepProfit, fob, `fob ${JSON.stringify(extra)}`)
  }

  // 任一门禁（国标 / 附表覆盖）为 false 时同样不得高于合规组新毛利
  for (const gate of [{ meetsNationalStandard: false }, { cmaScopeCovered: false }]) {
    const blocked = exportRebateCancelImpact({ ...base, hasValidCmaReport: true, exportConsumptionTaxExempt: true, ...gate })
    assert.equal(blocked.cmaGateBlocked, true)
    assert.equal(blocked.purchaseEmbeddedConsumptionTaxCny, 2)
    assert.equal(blocked.exportConsumptionTaxRefundableCny, 2)
    assert.equal(blocked.newGrossProfit, 20)
    assert.ok(blocked.newGrossProfit <= 22)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CalcInputError } from '../lib/calc_shared.js'
import {
  CROSSBORDER_CALC_SPECS,
  CROSSBORDER_SCENARIOS,
  calculateCrossborder,
  euLowValueParcel,
  fbaMixedProcurementSplit,
  usT86Vs9810Ddp,
} from '../lib/calc_crossborder.js'

test('v0.9 引擎 12 eu_low_value_parcel：基础 €3+€2 税费、含税抽佣 PID 与单包 vs 混装翻倍', () => {
  const single = euLowValueParcel({
    sellingPriceEur: 35.7,
    vatRate: 0.19,
    hsLineCount: 1,
    purchaseCostEur: 7,
    directShippingEur: 4,
    commissionRate: 0.15,
    commissionOnVatInclusive: true,
    returnRate: 0,
  })
  assert.equal(single.scenarioCode, 'eu_low_value_parcel')
  assert.equal(single.currency, 'EUR')
  assert.equal(single.netPriceExclVatEur, 30)
  assert.equal(single.vatAmountEur, 5.7)
  assert.equal(single.euTempDutyEur, 3)
  assert.equal(single.euHandlingFeeEur, 2)
  assert.equal(single.euCustomsLevyTotalEur, 5)
  assert.equal(single.commissionEur, 5.36) // 35.7 * 0.15 = 5.355 -> 5.36
  assert.equal(single.vatInclusiveCommissionExtraEur, 0.86) // (35.7 - 30) * 0.15 = 0.855 -> 0.86
  assert.equal(single.netProfitEur, 8.65) // 30 - 7 - 4 - 5 - 5.355 = 8.645 -> 8.65
  assert.equal(single.unpackDutySavingEur, 0)
  assert.equal(single.exceeds150Threshold, false)
  assert.equal(single.breakdown.customsLevies.handlingFeeRefundableOnReturn, false)
  assert.equal(single.breakdown.customsLevies.iossCollectsDutyOrHandling, false)
  assert.ok(single.warnings.some((w) => w.includes('IOSS') && w.includes('€3') && w.includes('€2')))
  assert.ok(single.warnings.some((w) => w.includes('€2') && w.includes('退货')))
  assert.ok(single.imaKeywords.includes('欧盟2欧') && single.imaKeywords.includes('PID') && single.imaKeywords.includes('IOSS'))
  assert.ok(single.disclaimer.length > 20)

  // 混装 2 个不同 HS 6 位税则项：按欧委会 2026-10-05 指引第 3 节，€3 关税翻倍至 €6、€2 处理费亦按项翻倍至 €4（合计 €10）
  const mixed2 = euLowValueParcel({
    sellingPriceEur: 35.7,
    vatRate: 0.19,
    hsLineCount: 2,
    purchaseCostEur: 7,
    directShippingEur: 4,
    commissionRate: 0.15,
    commissionOnVatInclusive: true,
    returnRate: 0.1,
    euWarehouseFirstLegEur: 1.5,
    euWarehouseDutyRate: 0.04,
    euWarehouseLocalDeliveryEur: 3.8,
    euWarehouseStorageEur: 0.2,
    monthlyOrders: 1000,
  })
  assert.equal(mixed2.euTempDutyEur, 6)
  assert.equal(mixed2.euHandlingFeeEur, 4)
  assert.equal(mixed2.euCustomsLevyTotalEur, 10)
  assert.equal(mixed2.unpackDutySavingEur, 3)
  assert.equal(mixed2.singleHsHandlingSavingEur, 2)
  assert.equal(mixed2.singleHsTotalLevySavingEur, 5)
  assert.equal(mixed2.returnSunkHandlingFeeEur, 0.4) // 4 * 0.10 = 0.40 全部已付处理费退货不退沉没
  assert.equal(mixed2.breakdown.returnSunkCosts.returnSunkHandlingFeePerRetainedEur, 0.44) // 0.40 / 0.9 = 0.4444 -> 0.44
  assert.equal(mixed2.breakdown.planComparison.singleHsDirect.dutySavingVsMixedEur, 3)
  assert.equal(mixed2.breakdown.planComparison.singleHsDirect.totalLevySavingVsMixedEur, 5)
  assert.equal(mixed2.breakdown.planComparison.splitParcelByHsDirect.parcelCount, 2)
  assert.equal(mixed2.breakdown.planComparison.euWarehouse.configured, true)
  assert.equal(mixed2.breakdown.planComparison.euWarehouse.bulkCustomsDutyEur, 0.34) // (7+1.5)*0.04
  assert.equal(mixed2.breakdown.planComparison.euWarehouse.totalLogisticsEur, 5.84) // 1.5+0.34+3.8+0.2
  assert.ok(mixed2.breakdown.planComparison.euWarehouse.advantageVsMixedDirectEur > 8)
  assert.equal(mixed2.recommendedPlan, 'eu_warehouse')
  assert.ok(mixed2.warnings.some((w) => w.includes('翻倍') && w.includes('物理拆')))
})

test('v0.9 引擎 12 eu_low_value_parcel：含税抽佣反推保毛利售价数学闭环验算（误差 < 0.01%）+ 中文别名 + 超 €150 预警', () => {
  // 场景 A：vat_inclusive 口径 + 退货率 8% + 混装 3 项税则
  const baseParams = {
    售价: 30,
    vatRate: 0.21,
    hsLineCount: 3,
    purchaseCostEur: 6.5,
    directShippingEur: 4.5,
    commissionRate: 0.15,
    commissionOnVatInclusive: true,
    returnRate: 0.08,
    targetMarginRate: 0.18,
  }
  const res = euLowValueParcel(baseParams)
  const rp = res.breakdown.reversePricing.mixedDirect
  assert.equal(rp.feasible, true)
  assert.ok(rp.minSellingPriceExactEur > 30)
  assert.ok(rp.loopbackCheck.marginErrorPct < 0.01)

  // 将反推精确售价代回引擎正向重算，验证实际净利率与目标净利率误差 < 0.01%
  const loopback = euLowValueParcel({ ...baseParams, 售价: rp.minSellingPriceExactEur })
  const errPct = Math.abs(loopback.netMarginPct - baseParams.targetMarginRate * 100)
  assert.ok(errPct < 0.01, `闭环误差 ${errPct}% 应 < 0.01%`)

  // 场景 B：ex_vat 口径 + commissionOnVatInclusive=false 同样满足数学闭环
  const exVatParams = {
    sellingPriceEur: 40,
    vatRate: 0.2,
    hsLineCount: 1,
    purchaseCostEur: 8,
    directShippingEur: 3.5,
    commissionRate: 0.12,
    commissionOnVatInclusive: false,
    returnRate: 0.05,
    targetMarginRate: 0.22,
    marginBasis: 'ex_vat',
  }
  const exRes = euLowValueParcel(exVatParams)
  const exRp = exRes.breakdown.reversePricing.mixedDirect
  assert.equal(exRp.feasible, true)
  const exLoopback = euLowValueParcel({ ...exVatParams, sellingPriceEur: exRp.minSellingPriceExactEur })
  assert.ok(Math.abs(exLoopback.netMarginOnExVatPct - 22) < 0.01)

  // 不可行目标净利率（VAT 20% + 抽佣 15% + 目标净利率 75% > 100%）优雅降级不返回 Infinity/负数
  const impossible = euLowValueParcel({
    sellingPriceEur: 30,
    vatRate: 0.2,
    commissionRate: 0.15,
    targetMarginRate: 0.75,
  })
  assert.equal(impossible.breakdown.reversePricing.mixedDirect.feasible, false)
  assert.equal(impossible.minSellingPriceEur, null)
  assert.ok(impossible.warnings.some((w) => w.includes('理论上限')))

  // 不含税价超 €150 触发超阈值预警
  const over150 = euLowValueParcel({ sellingPriceEur: 200, vatRate: 0.19 })
  assert.equal(over150.exceeds150Threshold, true)
  assert.ok(over150.warnings.some((w) => w.includes('€150')))
})

test('v0.9 引擎 13 us_t86_vs_9810_ddp：Type 11 vs 9810 DDP 毛利对比、2027 FBA +$0.19 与 FIOR+CTPAT 红线', () => {
  const res = usT86Vs9810Ddp({
    sellingPriceUsd: 39.99,
    purchaseCostUsd: 8,
    declaredValueUsd: 10,
    tariffRate: 0.45,
    type11ShippingUsd: 9.5,
    type11ClearanceFeeUsd: 3.5,
    ddpFirstLegUsd: 2.2,
    ddpClearanceAmortizedUsd: 0.3,
    localDeliveryUsd: 5.4,
    monthlyStorageUsd: 0.35,
    commissionRate: 0.15,
    monthlyVolume: 2000,
  })
  assert.equal(res.scenarioCode, 'us_t86_vs_9810_ddp')
  assert.equal(res.currency, 'USD')
  assert.equal(res.type11NetProfitUsd, 8.49)
  assert.equal(res.ddpNetProfitUsd, 13.24)
  assert.equal(res.ddpProfitAfter2027FbaHikeUsd, 13.05) // 13.2415 - 0.19 = 13.0515
  assert.equal(res.unitProfitDiffUsd, 4.75)
  assert.equal(res.monthlyProfitDiffUsd, 9500)
  assert.equal(res.recommendedPath, '9810_ddp')

  // 所有美线结果必须携带 2027-01-05 FIOR+CTPAT-validated 红线 & 111.29 不延 FIOR & 2027-01-15 FBA $0.19 提示
  const fior = res.breakdown.fiorCtpatCompliance
  assert.equal(fior.effectiveDate, '2027-01-05')
  assert.equal(fior.rule11129ExtendedTo, '2027-05-06')
  assert.equal(fior.does11129DelayFior, false)
  assert.equal(fior.requiredBrokerStatus, 'CTPAT-validated')
  assert.ok(res.warnings.some((w) => w.includes('2027-01-05') && w.includes('FIOR') && w.includes('CTPAT-validated') && w.includes('2027-05-06')))
  assert.ok(res.warnings.some((w) => w.includes('2027-01-15') && w.includes('$0.19')))

  // 勾选 apply2027FbaHike 直接计入 $0.19
  const withHike = usT86Vs9810Ddp({
    sellingPriceUsd: 39.99,
    purchaseCostUsd: 8,
    declaredValueUsd: 10,
    tariffRate: 0.45,
    type11ShippingUsd: 9.5,
    type11ClearanceFeeUsd: 3.5,
    ddpFirstLegUsd: 2.2,
    ddpClearanceAmortizedUsd: 0.3,
    localDeliveryUsd: 5.4,
    monthlyStorageUsd: 0.35,
    commissionRate: 0.15,
    apply2027FbaHike: true,
  })
  assert.equal(withHike.ddpNetProfitUsd, 13.05)
})

test('v0.9 引擎 13 us_t86_vs_9810_ddp：IEEPA/CAPE 退税严格口径拦截（301/232/122/超期/跨期归零 + P0 ACH Hold）', () => {
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

  // 1. 合法 IEEPA 且精确落在 2025-02-01 至 2026-02-23（CBP 美东 2026-02-24 00:00 停收 CSMS #67834313）窗口内 + ACE ACH 已绑定
  const valid = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 18500.5,
    tariffProgram: 'IEEPA',
    entryPeriodStart: '2025-02-01',
    entryPeriodEnd: '2026-02-23',
    aceAchBound: true,
  })
  assert.equal(valid.breakdown.ieepaRefund.eligible, true)
  assert.equal(valid.breakdown.ieepaRefund.status, 'eligible_reference')
  assert.equal(valid.ieepaEligibleRefundUsd, 18500.5)
  assert.equal(valid.achHoldAlert, false)

  // 2. 合法 IEEPA 但 aceAchBound=false → 发出 P0 ACH Hold 警告
  const noAch = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 12000,
    tariffProgram: 'IEEPA',
    entryPeriodStart: '2025-06-01',
    entryPeriodEnd: '2025-12-31',
    aceAchBound: false,
  })
  assert.equal(noAch.ieepaEligibleRefundUsd, 12000)
  assert.equal(noAch.achHoldAlert, true)
  assert.ok(noAch.warnings.some((w) => w.includes('P0') && w.includes('ACH Hold')))

  // 3. Section301 / Section232 / Section122 明确归零拦截并提示不适用 CAPE 退税
  for (const prog of ['Section301', 'Section232', 'Section122']) {
    const blocked = usT86Vs9810Ddp({
      ...base,
      ieepaPaidUsd: 50000,
      tariffProgram: prog,
      entryPeriodStart: '2025-04-01',
      entryPeriodEnd: '2025-10-01',
      aceAchBound: true,
    })
    assert.equal(blocked.breakdown.ieepaRefund.eligible, false, `${prog} 必须拦截`)
    assert.equal(blocked.breakdown.ieepaRefund.status, 'ineligible_program')
    assert.equal(blocked.ieepaEligibleRefundUsd, 0)
    assert.ok(blocked.warnings.some((w) => w.includes(prog) && w.includes('不适用 CAPE 退税')))
  }

  // 4. 超期单据（早于 2025-02-01 或晚于/等于 2026-02-24 停收日）强制归零
  const tooEarly = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 9000,
    tariffProgram: 'IEEPA',
    entryPeriodStart: '2025-01-01',
    entryPeriodEnd: '2025-01-31',
  })
  assert.equal(tooEarly.ieepaEligibleRefundUsd, 0)
  assert.equal(tooEarly.breakdown.ieepaRefund.status, 'out_of_window')

  const tooLate = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 9000,
    tariffProgram: 'IEEPA',
    entryPeriodStart: '2026-02-24',
    entryPeriodEnd: '2026-04-01',
  })
  assert.equal(tooLate.ieepaEligibleRefundUsd, 0)
  assert.equal(tooLate.breakdown.ieepaRefund.status, 'out_of_window')

  // 5. 跨期单据（跨越窗口边界）fail-closed 归零并要求按报关单拆分
  const straddling = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 9000,
    tariffProgram: 'IEEPA',
    entryPeriodStart: '2025-01-15',
    entryPeriodEnd: '2025-03-15',
  })
  assert.equal(straddling.ieepaEligibleRefundUsd, 0)
  assert.equal(straddling.breakdown.ieepaRefund.status, 'partial_window_split_required')

  // 6. 缺缴税期 fail-closed 归零
  const missingDates = usT86Vs9810Ddp({
    ...base,
    ieepaPaidUsd: 9000,
    tariffProgram: 'IEEPA',
  })
  assert.equal(missingDates.ieepaEligibleRefundUsd, 0)
  assert.equal(missingDates.breakdown.ieepaRefund.status, 'pending_period')
})

test('v0.9 辅助引擎 fba_mixed_procurement_split：50 万 FBA 硬混视同内销 vs 合规拆单 vs 加点全 0110 对比', () => {
  // 场景 A：供应商加点 8% < 临界点 13%，全量补票走 0110 优于拆单，二者均远优于硬混一票
  const r1 = fbaMixedProcurementSplit({
    totalExportCny: 500000,
    invoicedPurchaseGrossCny: 339000,
    noInvoicePurchaseCny: 100000,
    invoicedVatRate: 0.13,
    invoicedRebateRate: 0.13,
    supplierInvoiceMarkupRate: 0.08,
    splitNoInvoiceMode: '9810',
    mixedSingleDeclarationCostCny: 1500,
    split0110CostCny: 1500,
    splitNoInvoiceCostCny: 2500,
  })
  assert.equal(r1.scenarioCode, 'fba_mixed_procurement_split')
  assert.equal(r1.currency, 'CNY')
  assert.equal(r1.invoicedPurchaseExclTaxCny, 300000)
  assert.equal(r1.invoicedInputVatCny, 39000)
  assert.equal(r1.invoicedVatRefundCny, 39000)
  assert.equal(r1.mixedDeemedVatPayableCny, 18522.12)
  assert.equal(r1.mixedSurtaxCny, 2222.65)
  assert.equal(r1.mixedDeemedNetProfitCny, 38755.22)
  assert.equal(r1.mixedNoRefundNetProfitCny, 59500)
  assert.equal(r1.splitNetProfitCny, 96000)
  assert.equal(r1.gainVsMixedDeemedVatCny, 57244.78)
  assert.equal(r1.gainVsMixedNoRefundCny, 36500)
  assert.equal(r1.noInvoiceBreakevenMarkupPct, 13)
  assert.equal(r1.allInvoiced0110NetProfitCny, 102924.78)
  assert.equal(r1.recommendedPlan, 'all_invoiced_0110')
  assert.ok(r1.warnings.some((w) => w.includes('分单') && w.includes('骗税')))
  assert.ok(r1.warnings.some((w) => w.includes('2025年第17号') && w.includes('买单出口')))

  // 场景 B：供应商加点过高（17%）时，合规拆单（0110 + 9610）胜出
  const r2 = fbaMixedProcurementSplit({
    totalExportCny: 500000,
    invoicedPurchaseGrossCny: 339000,
    noInvoicePurchaseCny: 100000,
    invoicedVatRate: 0.13,
    invoicedRebateRate: 0.13,
    supplierInvoiceMarkupRate: 0.17,
    splitNoInvoiceMode: '9610',
    mixedSingleDeclarationCostCny: 1500,
    split0110CostCny: 1500,
    splitNoInvoiceCostCny: 2000,
  })
  assert.equal(r2.recommendedPlan, 'split_0110_and_no_invoice')
  assert.ok(r2.splitNetProfitCny > r2.allInvoiced0110NetProfitCny)
  assert.ok(r2.gainVsMixedDeemedVatCny > 50000)

  // 场景 C：不含税采购额口径 + agent_export 模式
  const r3 = fbaMixedProcurementSplit({
    totalExportCny: 500000,
    invoicedPurchaseGrossCny: 300000,
    invoicedPurchaseInclusive: false,
    noInvoicePurchaseCny: 100000,
    splitNoInvoiceMode: 'agent_export',
  })
  assert.equal(r3.invoicedPurchaseGrossCny, 339000)
  assert.equal(r3.splitNoInvoiceMode, 'agent_export')
})

test('v0.9 CROSSBORDER_CALC_SPECS 元数据契约与统一分发 calculateCrossborder 全通过', () => {
  assert.deepEqual(CROSSBORDER_SCENARIOS, ['eu_low_value_parcel', 'us_t86_vs_9810_ddp', 'fba_mixed_procurement_split'])
  assert.equal(CROSSBORDER_CALC_SPECS.length, 3)

  for (const spec of CROSSBORDER_CALC_SPECS) {
    assert.ok(spec.code && spec.zh && spec.en && spec.desc && spec.enDesc)
    assert.ok(Array.isArray(spec.fields) && spec.fields.length >= 5)
    assert.ok(Array.isArray(spec.advancedFields) && spec.advancedFields.length >= 4)
    assert.ok(Array.isArray(spec.imaKeywords) && spec.imaKeywords.length >= 3)
    const out = calculateCrossborder(spec.code, spec.exampleParams)
    assert.equal(out.scenarioCode, spec.code)
    assert.equal(typeof out.summaryLine, 'string')
    assert.ok(out.summary && typeof out.summary.headline === 'string')
    assert.ok(out.breakdown && typeof out.breakdown === 'object')
    assert.ok(Array.isArray(out.steps) && out.steps.length >= 3)
    assert.ok(Array.isArray(out.warnings) && out.warnings.length >= 2)
    assert.ok(Array.isArray(out.assumptions) && out.assumptions.length >= 2)
    assert.ok(Array.isArray(out.imaKeywords) && out.imaKeywords.length >= 3)
    assert.ok(Array.isArray(out.policyRefs) && out.policyRefs.length >= 2)
    assert.equal(typeof out.disclaimer, 'string')
  }

  assert.throws(() => calculateCrossborder('unknown_crossborder_engine', {}), CalcInputError)
})

test('v0.9 严格参数校验：拒绝负数、超大数、NaN、Infinity、布尔/对象、非法日期与非法枚举', () => {
  // 非法参数容器
  assert.throws(() => euLowValueParcel(null), CalcInputError)
  assert.throws(() => usT86Vs9810Ddp([]), CalcInputError)
  assert.throws(() => fbaMixedProcurementSplit('bad'), CalcInputError)

  // Engine 12 非法值
  assert.throws(() => euLowValueParcel({ sellingPriceEur: -10 }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: 0 }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: Number.NaN }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: Number.POSITIVE_INFINITY }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: 1e15 }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: true }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: 30, hsLineCount: 0 }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: 30, hsLineCount: 21 }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: 30, hsLineCount: 1.5 }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: 30, returnRate: 1 }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: 30, vatRate: 19 }), CalcInputError)
  assert.throws(() => euLowValueParcel({ sellingPriceEur: 30, marginBasis: 'invalid' }), CalcInputError)

  // Engine 13 非法值
  assert.throws(() => usT86Vs9810Ddp({ sellingPriceUsd: 30, purchaseCostUsd: -1 }), CalcInputError)
  assert.throws(() => usT86Vs9810Ddp({ sellingPriceUsd: 1e12, purchaseCostUsd: 5 }), CalcInputError)
  assert.throws(() => usT86Vs9810Ddp({ sellingPriceUsd: 30, purchaseCostUsd: 5, tariffRate: 6 }), CalcInputError)
  assert.throws(() => usT86Vs9810Ddp({ sellingPriceUsd: 30, purchaseCostUsd: 5, tariffProgram: 'Section999' }), CalcInputError)
  assert.throws(() => usT86Vs9810Ddp({ sellingPriceUsd: 30, purchaseCostUsd: 5, entryPeriodStart: '2026-02-30' }), CalcInputError)
  assert.throws(
    () => usT86Vs9810Ddp({ sellingPriceUsd: 30, purchaseCostUsd: 5, entryPeriodStart: '2026-01-10', entryPeriodEnd: '2025-12-01' }),
    CalcInputError,
  )

  // Helper Engine 非法值
  assert.throws(() => fbaMixedProcurementSplit({ totalExportCny: 0, invoicedPurchaseGrossCny: 100, noInvoicePurchaseCny: 0 }), CalcInputError)
  assert.throws(() => fbaMixedProcurementSplit({ totalExportCny: 500000, invoicedPurchaseGrossCny: 0, noInvoicePurchaseCny: 0 }), CalcInputError)
  assert.throws(() => fbaMixedProcurementSplit({ totalExportCny: 500000, invoicedPurchaseGrossCny: -1, noInvoicePurchaseCny: 100 }), CalcInputError)
  assert.throws(() => fbaMixedProcurementSplit({ totalExportCny: Number.MAX_SAFE_INTEGER, invoicedPurchaseGrossCny: 100, noInvoicePurchaseCny: 0 }), CalcInputError)
  assert.throws(() => fbaMixedProcurementSplit({ totalExportCny: 500000, invoicedPurchaseGrossCny: 100, noInvoicePurchaseCny: 100, splitNoInvoiceMode: '0110' }), CalcInputError)
})

test('v0.9 护城河与零外部依赖门禁：lib/calc_crossborder.js 严守红线', () => {
  const src = readFileSync(new URL('../lib/calc_crossborder.js', import.meta.url), 'utf8')
  assert.equal(src.includes('--profile default'), false, '不得含 --profile default')
  assert.equal(src.includes('CTPAT-certified'), false, '必须使用 CTPAT-validated')
  assert.equal(/充电宝[^。\n]{0,12}恢复征收|对成品充电宝征收消费税/.test(src), false, '不得含错误充电宝口径')
  assert.equal(/借方科目|贷方科目|借：应收账款|VLOOKUP\(|SUMIFS\(|18A!/.test(src), false, '不得含私域护城河敏感内容')

  // 确认仅依赖 ./calc_shared.js，零外部 npm 包导入
  const imports = [...src.matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['./calc_shared.js'])
})

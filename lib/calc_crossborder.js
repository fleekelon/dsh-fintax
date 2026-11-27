// dsh-fintax 跨境关税与低值包裹确定性算税引擎（v0.9.0 新增，纯 ESM，零外部依赖）：
//  12. eu_low_value_parcel          — 欧盟低值包裹 €3 临时关税 + €2 处理费（退货不退）+ PID 含税抽佣反推售价
//  13. us_t86_vs_9810_ddp           — 美线 T86 暂停：Type 11 直邮 vs 9810 海外仓 DDP + IEEPA 退税校验 & FIOR/CTPAT 红线
//  辅助. fba_mixed_procurement_split — 50 万 FBA 有票+无票混合采购拆单三步法净收益对比测算
//
// 护城河底线：仅提供通用确定性算术与合规门禁模型，严禁硬编码 362 项全量税号字典、100 本 Excel 公式或会计分录模板。

import { CalcInputError, optBoolean, optIsoDate, optNum, optSignedNum, reqNum, round2 } from './calc_shared.js'

const MAX_MONETARY = 1e11 // 单项金额上限 1,000 亿，防超大数/溢出失真
const MAX_VOLUME = 1e8
const STANDARD_DISCLAIMER =
  '本结果基于传入参数与现行公开政策口径的确定性算术试算，仅供定价测算、方案比选与合规排雷参考，不构成正式海关申报或纳税申报依据；具体税率、商品归类及退税资格请结合主管税务/海关机构或 IMA 知识库核实。'

const round4 = (x) => Math.round((x + Number.EPSILON) * 10_000) / 10_000
const round6 = (x) => Math.round((x + Number.EPSILON) * 1_000_000) / 1_000_000
const ceil2 = (x) => Math.ceil((x - 1e-12) * 100) / 100

function ensureParamsObject(p) {
  if (p === undefined) return {}
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    throw new CalcInputError('params 必须是 JSON 对象')
  }
  return p
}

function pickParam(p, keys) {
  let fallbackVal
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(p, k)) continue
    const v = p[k]
    if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) return v
    if (fallbackVal === undefined) fallbackVal = v
  }
  return fallbackVal
}

function reqBoundedNum(raw, errMsg, { allowZero = true, max = MAX_MONETARY } = {}) {
  const n = reqNum(raw, errMsg, { allowZero })
  if (n > max) throw new CalcInputError(`${errMsg}（不得超过 ${max}）`)
  return n
}

function optBoundedNum(raw, fallback, name, { max = MAX_MONETARY } = {}) {
  const n = optNum(raw, fallback, name)
  if (n !== null && n > max) {
    throw new CalcInputError(`${name} 超出合理数值上限（不得超过 ${max}）`)
  }
  return n
}

function optIntRange(raw, fallback, name, { min = 0, max = MAX_VOLUME } = {}) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return fallback
  }
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw new CalcInputError(`${name} 必须是 ${min}~${max} 之间的整数`)
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CalcInputError(`${name} 必须是 ${min}~${max} 之间的整数`)
  }
  return n
}

function checkRate(val, name, { max = 1, inclusiveMax = true, hint = '0~1 之间的小数（如 19% 传 0.19）' } = {}) {
  if (val === null) return
  const over = inclusiveMax ? val > max : val >= max
  if (val < 0 || over) {
    throw new CalcInputError(`${name} 必须是${hint}`)
  }
}

function hasAnyKey(p, keys) {
  return keys.some((k) => Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined && p[k] !== null && p[k] !== '')
}

// ── 场景 12：欧盟低值包裹 €3 临时关税 + €2 处理费 + PID 含税抽佣反推售价 ────────
const EU_LOW_VALUE_THRESHOLD_EUR = 150
const EU_TEMP_DUTY_PER_HS_EUR = 3
const EU_HANDLING_FEE_PER_HS_EUR = 2

/**
 * 场景 12：欧盟 ≤€150 低值包裹 €3/项临时关税 + €2/项欧盟处理费（按欧委会 2026-10-05 指引第 3 节均按包裹内申报的不同商品项/税则项计收，且退货不退）
 * + PID/含税抽佣反推保毛利最低可执行售价（向上取分 + €150 复核阻断）
 * +「同箱混装直邮 vs 同购物篮按项拆包直邮 vs 简化单税则 SKU 组合 vs 欧盟海外仓」方案对比。
 */
export function euLowValueParcel(rawParams = {}) {
  const p = ensureParamsObject(rawParams)
  const sellingPriceEur = reqBoundedNum(
    pickParam(p, ['sellingPriceEur', 'priceEur', 'retailPriceEur', '售价', '商品售价']),
    'sellingPriceEur 必须是正数（商品含税零售价，EUR）',
    { allowZero: false },
  )
  const vatRate = optBoundedNum(pickParam(p, ['vatRate', 'euVatRate', 'vat税率', '税率']), 0.19, 'vatRate')
  const hsLineCount = optIntRange(pickParam(p, ['hsLineCount', 'hsCount', 'tariffItemCount', '税则项数']), 1, 'hsLineCount', { min: 1, max: 20 })
  const purchaseCostEur = optBoundedNum(pickParam(p, ['purchaseCostEur', 'cogsEur', 'productCostEur', '采购成本']), 0, 'purchaseCostEur')
  const directShippingEur = optBoundedNum(pickParam(p, ['directShippingEur', 'shippingEur', 'freightEur', '直邮运费']), 0, 'directShippingEur')
  const splitParcelShippingEur = optBoundedNum(
    pickParam(p, ['splitParcelShippingEur', '拆包单包运费']),
    directShippingEur,
    'splitParcelShippingEur',
  )
  const otherVariableCostEur = optBoundedNum(pickParam(p, ['otherVariableCostEur', 'otherCostEur', '其他变动成本']), 0, 'otherVariableCostEur')
  const commissionRate = optBoundedNum(pickParam(p, ['commissionRate', 'platformCommissionRate', '平台抽佣率']), 0.15, 'commissionRate')
  const commissionOnVatInclusiveRaw = optBoolean(pickParam(p, ['commissionOnVatInclusive', '含税抽佣']), 'commissionOnVatInclusive')
  const commissionOnVatInclusive = commissionOnVatInclusiveRaw === null ? true : commissionOnVatInclusiveRaw
  const returnRate = optBoundedNum(pickParam(p, ['returnRate', 'refundRate', '退货率']), 0, 'returnRate')
  const returnGoodsRecoveryRate = optBoundedNum(pickParam(p, ['returnGoodsRecoveryRate', '退货残值回收率']), 0, 'returnGoodsRecoveryRate')
  const separateShippingInPriceEur = optBoundedNum(
    pickParam(p, ['separateShippingInPriceEur', 'invoicedSeparateShippingEur', '单列运费']),
    0,
    'separateShippingInPriceEur',
  )
  const targetMarginRate = optBoundedNum(pickParam(p, ['targetMarginRate', '目标净利率']), null, 'targetMarginRate')
  const marginBasisRaw = pickParam(p, ['marginBasis', '净利率口径'])
  if (typeof marginBasisRaw === 'boolean' || (marginBasisRaw !== null && typeof marginBasisRaw === 'object')) {
    throw new CalcInputError('marginBasis 必须为 vat_inclusive（含税售价口径）或 ex_vat（不含税净营收口径）')
  }
  const marginBasis = String(marginBasisRaw ?? 'vat_inclusive').trim().toLowerCase()
  const monthlyOrders = optIntRange(pickParam(p, ['monthlyOrders', '月订单量']), null, 'monthlyOrders', { min: 0, max: MAX_VOLUME })

  const whTotalOverride = optBoundedNum(pickParam(p, ['euWarehouseTotalLogisticsEur', '海外仓单件履约成本']), null, 'euWarehouseTotalLogisticsEur')
  const whFirstLeg = optBoundedNum(pickParam(p, ['euWarehouseFirstLegEur', 'warehouseHeadhaulEur', '海外仓头程']), null, 'euWarehouseFirstLegEur')
  const whDutyRate = optBoundedNum(pickParam(p, ['euWarehouseDutyRate', 'warehouseTariffRate', '海外仓关税率']), 0.04, 'euWarehouseDutyRate')
  const whDutyOverride = optBoundedNum(pickParam(p, ['euWarehouseDutyEur', '海外仓关税额']), null, 'euWarehouseDutyEur')
  const whLocalDelivery = optBoundedNum(pickParam(p, ['euWarehouseLocalDeliveryEur', 'warehouseLastMileEur', '海外仓本地派送']), null, 'euWarehouseLocalDeliveryEur')
  const whStorage = optBoundedNum(pickParam(p, ['euWarehouseStorageEur', '海外仓仓储费']), 0, 'euWarehouseStorageEur')
  const whReturnRecovery = optBoundedNum(pickParam(p, ['euWarehouseReturnRecoveryRate', '海外仓退货回收率']), returnGoodsRecoveryRate, 'euWarehouseReturnRecoveryRate')

  checkRate(vatRate, 'vatRate', { max: 1, inclusiveMax: true })
  checkRate(commissionRate, 'commissionRate', { max: 1, inclusiveMax: false, hint: '0~1 之间的小数（须小于 1，如 15% 传 0.15）' })
  checkRate(returnRate, 'returnRate', { max: 1, inclusiveMax: false, hint: '0~1 之间的小数（须小于 1，如 8% 传 0.08）' })
  checkRate(returnGoodsRecoveryRate, 'returnGoodsRecoveryRate', { max: 1, inclusiveMax: true })
  checkRate(whDutyRate, 'euWarehouseDutyRate', { max: 1, inclusiveMax: true })
  checkRate(whReturnRecovery, 'euWarehouseReturnRecoveryRate', { max: 1, inclusiveMax: true })
  checkRate(targetMarginRate, 'targetMarginRate', { max: 1, inclusiveMax: false, hint: '0~1 之间的小数（须小于 1，如 15% 传 0.15）' })
  if (separateShippingInPriceEur >= sellingPriceEur) {
    throw new CalcInputError('separateShippingInPriceEur（含税总价中发票单列的运费）必须小于商品含税总价 sellingPriceEur')
  }
  if (marginBasis !== 'vat_inclusive' && marginBasis !== 'ex_vat') {
    throw new CalcInputError('marginBasis 必须为 vat_inclusive（含税售价口径）或 ex_vat（不含税净营收口径）')
  }

  const netPriceExclVat = sellingPriceEur / (1 + vatRate)
  const intrinsicValueExclVat = (sellingPriceEur - separateShippingInPriceEur) / (1 + vatRate)
  const vatPerDelivered = sellingPriceEur - netPriceExclVat
  const exceeds150Threshold = intrinsicValueExclVat > EU_LOW_VALUE_THRESHOLD_EUR + 1e-9
  const keptRatio = 1 - returnRate

  // 含税抽佣 vs 不含税抽佣（PID 影响）
  const commBaseDelivered = commissionOnVatInclusive ? sellingPriceEur : netPriceExclVat
  const commissionPerDelivered = commBaseDelivered * commissionRate
  const vatInclusiveCommExtraPerDelivered = commissionOnVatInclusive
    ? sellingPriceEur * commissionRate - netPriceExclVat * commissionRate
    : 0
  const effectiveNetRevenue = netPriceExclVat * keptRatio
  const effectiveGrossSales = sellingPriceEur * keptRatio
  const effectiveCommission = commissionPerDelivered * keptRatio

  // 欧盟低值包裹两项收费（按欧委会 2026-10-05 指引第 3 节：€3 临时关税与 €2 处理费均按申报的不同商品项/税则项 hsLineCount 计收）
  const euTempDutyEur = EU_TEMP_DUTY_PER_HS_EUR * hsLineCount
  const euHandlingFeeEur = EU_HANDLING_FEE_PER_HS_EUR * hsLineCount
  const euCustomsLevyTotalEur = euTempDutyEur + euHandlingFeeEur
  const singleHsDutyEur = EU_TEMP_DUTY_PER_HS_EUR
  const singleHsHandlingFeeEur = EU_HANDLING_FEE_PER_HS_EUR
  const singleHsLevyTotalEur = singleHsDutyEur + singleHsHandlingFeeEur
  const unpackDutySavingEur = euTempDutyEur - singleHsDutyEur // 简化为单税则 SKU 组合节省 €3×(N-1) 关税
  const singleHsHandlingSavingEur = euHandlingFeeEur - singleHsHandlingFeeEur // 简化为单税则 SKU 组合节省 €2×(N-1) 处理费
  const singleHsTotalLevySavingEur = euCustomsLevyTotalEur - singleHsLevyTotalEur // 合计节省 €5×(N-1)

  // 退货沉没损耗明细（基于全部已付处理费 €2 × hsLineCount，退货不退）
  const returnSunkHandlingFeeEur = euHandlingFeeEur * returnRate
  const returnSunkHandlingFeePerRetainedEur = (euHandlingFeeEur * returnRate) / keptRatio
  const returnSunkDutyEur = euTempDutyEur * returnRate
  const returnSunkShippingEur = directShippingEur * returnRate
  const returnSunkCogsEur = purchaseCostEur * (1 - returnGoodsRecoveryRate) * returnRate
  const totalReturnSunkCostEur =
    returnSunkHandlingFeeEur + returnSunkDutyEur + returnSunkShippingEur + returnSunkCogsEur + otherVariableCostEur * returnRate

  const effectiveCogsDirect = purchaseCostEur * (1 - returnRate * returnGoodsRecoveryRate)
  const fixedCostMixedDirect = effectiveCogsDirect + directShippingEur + otherVariableCostEur + euTempDutyEur + euHandlingFeeEur
  const totalCostMixedDirect = fixedCostMixedDirect + effectiveCommission
  const netProfitMixedDirect = effectiveNetRevenue - totalCostMixedDirect
  const marginDenominator = marginBasis === 'ex_vat' ? effectiveNetRevenue : effectiveGrossSales
  const netMarginOnGrossRate = effectiveGrossSales > 0 ? netProfitMixedDirect / effectiveGrossSales : 0
  const netMarginOnExVatRate = effectiveNetRevenue > 0 ? netProfitMixedDirect / effectiveNetRevenue : 0
  const activeNetMarginRate = marginDenominator > 0 ? netProfitMixedDirect / marginDenominator : 0

  // 方案 A2（同购物篮严格对照）：保持商品构成与总件数一致，按项物理拆成 hsLineCount 个小包直邮（每包均需运费，税费仍为 €3×N + €2×N）
  const splitByHsShippingEur = splitParcelShippingEur * hsLineCount
  const splitByHsExtraShippingEur = splitByHsShippingEur - directShippingEur
  const fixedCostSplitByHs = effectiveCogsDirect + splitByHsShippingEur + otherVariableCostEur + euTempDutyEur + euHandlingFeeEur
  const totalCostSplitByHs = fixedCostSplitByHs + effectiveCommission
  const netProfitSplitByHs = effectiveNetRevenue - totalCostSplitByHs
  const netMarginSplitByHsPct = marginDenominator > 0 ? round2((netProfitSplitByHs / marginDenominator) * 100) : 0

  // 方案 B（SKU 结构简化基准，非同一多税则购物篮拆包）：简化为单一税则 SKU 组合（hsLineCount = 1，€3 关税 + €2 处理费 = €5）
  const fixedCostSingleHs = effectiveCogsDirect + directShippingEur + otherVariableCostEur + singleHsDutyEur + singleHsHandlingFeeEur
  const netProfitSingleHs = effectiveNetRevenue - (fixedCostSingleHs + effectiveCommission)
  const netMarginSingleHsPct = marginDenominator > 0 ? round2((netProfitSingleHs / marginDenominator) * 100) : 0

  // 方案 C：欧盟海外仓对照（补齐退货回收率差 purchaseCostEur × returnRate × (whReturnRecovery - returnGoodsRecoveryRate)）
  const whConfigured = whTotalOverride !== null || whFirstLeg !== null || whLocalDelivery !== null || whDutyOverride !== null
  const whReturnRecoveryAdjustmentEur = purchaseCostEur * returnRate * (whReturnRecovery - returnGoodsRecoveryRate)
  const breakevenWarehouseLogisticsVsMixed = directShippingEur + euCustomsLevyTotalEur + whReturnRecoveryAdjustmentEur
  const breakevenWarehouseLogisticsVsSingleHs = directShippingEur + singleHsLevyTotalEur + whReturnRecoveryAdjustmentEur
  let euWarehousePlan = {
    configured: false,
    returnRecoveryAdjustmentEur: round2(whReturnRecoveryAdjustmentEur),
    breakevenTotalLogisticsVsMixedEur: round2(breakevenWarehouseLogisticsVsMixed),
    breakevenTotalLogisticsVsSingleHsEur: round2(breakevenWarehouseLogisticsVsSingleHs),
    note: '未传入欧盟海外仓头程/清关/本地派送成本；已给出计入退货回收率差后的海外仓盈亏平衡单件履约红线（低于该值则海外仓更优）。',
  }
  if (whConfigured) {
    const firstLeg = whFirstLeg ?? 0
    const localDeliv = whLocalDelivery ?? 0
    const bulkDuty = whDutyOverride !== null ? whDutyOverride : (purchaseCostEur + firstLeg) * whDutyRate
    const whLogisticsTotal = whTotalOverride !== null ? whTotalOverride : firstLeg + bulkDuty + localDeliv + whStorage
    const whEffectiveCogs = purchaseCostEur * (1 - returnRate * whReturnRecovery)
    const whTotalCost = whEffectiveCogs + whLogisticsTotal + otherVariableCostEur + effectiveCommission
    const whNetProfit = effectiveNetRevenue - whTotalCost
    const whNetMarginPct = marginDenominator > 0 ? round2((whNetProfit / marginDenominator) * 100) : 0
    const advVsMixed = whNetProfit - netProfitMixedDirect
    const advVsSingle = whNetProfit - netProfitSingleHs
    euWarehousePlan = {
      configured: true,
      firstLegEur: round2(firstLeg),
      bulkCustomsDutyEur: round2(bulkDuty),
      localDeliveryEur: round2(localDeliv),
      storageEur: round2(whStorage),
      totalLogisticsEur: round2(whLogisticsTotal),
      returnRecoveryAdjustmentEur: round2(whReturnRecoveryAdjustmentEur),
      totalCostEur: round2(whTotalCost),
      netProfitEur: round2(whNetProfit),
      netMarginPct: whNetMarginPct,
      advantageVsMixedDirectEur: round2(advVsMixed),
      advantageVsSingleHsDirectEur: round2(advVsSingle),
      monthlyAdvantageVsMixedEur: monthlyOrders !== null ? round2(advVsMixed * monthlyOrders) : null,
      breakevenTotalLogisticsVsMixedEur: round2(breakevenWarehouseLogisticsVsMixed),
      breakevenTotalLogisticsVsSingleHsEur: round2(breakevenWarehouseLogisticsVsSingleHs),
    }
  }

  // 同购物篮最优履约方案判定：若原包裹内在价值已超 €150 低值门槛，严禁再推荐低值直邮方案！
  const sameBasketScores = [
    { key: 'mixed_direct', profit: netProfitMixedDirect },
    ...(hsLineCount > 1 ? [{ key: 'split_parcel_by_hs', profit: netProfitSplitByHs }] : []),
    ...(euWarehousePlan.configured ? [{ key: 'eu_warehouse', profit: euWarehousePlan.netProfitEur }] : []),
  ]
  sameBasketScores.sort((a, b) => b.profit - a.profit)
  const recommendedPlan = exceeds150Threshold
    ? (euWarehousePlan.configured ? 'eu_warehouse' : 'general_trade_clearance')
    : sameBasketScores[0].key
  const recommendedOption = recommendedPlan

  // 反推保毛利最低可执行含税售价（统一向上取分 + 反推后强制复核 ≤€150 门槛）
  const solveMinPrice = (fixedCost) => {
    const revFactorOnP = 1 / (1 + vatRate)
    const commFactorOnP = commissionOnVatInclusive ? commissionRate : commissionRate / (1 + vatRate)
    const marginFactorOnP = marginBasis === 'ex_vat' ? targetMarginRate / (1 + vatRate) : targetMarginRate
    const maxTheoreticalMarginRate = marginBasis === 'ex_vat'
      ? 1 - (commissionOnVatInclusive ? commissionRate * (1 + vatRate) : commissionRate)
      : revFactorOnP - commFactorOnP
    const contribRateOnP = revFactorOnP - commFactorOnP - marginFactorOnP
    if (contribRateOnP <= 1e-12) {
      return {
        feasible: false,
        mathFeasible: false,
        feasibleUnderLowValueRegime: false,
        exceeds150Threshold: false,
        infeasibleReason: 'exceeds_theoretical_margin_cap',
        targetMarginRate,
        marginBasis,
        maxTheoreticalMarginRate: round4(Math.max(0, maxTheoreticalMarginRate)),
        minNetPriceExclVatEur: null,
        minSellingPriceEur: null,
        minSellingPriceCeilEur: null,
        minSellingPriceExactEur: null,
        unconstrainedMinSellingPriceEur: null,
        priceIncreaseNeededEur: null,
        priceIncreaseNeededPct: null,
        loopbackCheck: null,
      }
    }
    const exactP = fixedCost / (keptRatio * contribRateOnP)
    const minPriceCeil = ceil2(exactP)
    const minNetPriceExclVat = Math.max(0, minPriceCeil - separateShippingInPriceEur) / (1 + vatRate)
    const reverseExceeds150 = minNetPriceExclVat > EU_LOW_VALUE_THRESHOLD_EUR + 1e-9

    const exactNetRev = (exactP / (1 + vatRate)) * keptRatio
    const exactComm = (commissionOnVatInclusive ? exactP : exactP / (1 + vatRate)) * commissionRate * keptRatio
    const exactProfit = exactNetRev - exactComm - fixedCost
    const exactDenom = marginBasis === 'ex_vat' ? exactNetRev : exactP * keptRatio
    const achievedMarginExact = exactDenom > 0 ? exactProfit / exactDenom : 0

    const ceilNetRev = (minPriceCeil / (1 + vatRate)) * keptRatio
    const ceilComm = (commissionOnVatInclusive ? minPriceCeil : minPriceCeil / (1 + vatRate)) * commissionRate * keptRatio
    const ceilProfit = ceilNetRev - ceilComm - fixedCost
    const ceilDenom = marginBasis === 'ex_vat' ? ceilNetRev : minPriceCeil * keptRatio
    const achievedMarginAtCeil = ceilDenom > 0 ? ceilProfit / ceilDenom : 0

    const loopbackCheck = {
      achievedMarginRate: round6(achievedMarginExact),
      achievedMarginAtCeilRate: round6(achievedMarginAtCeil),
      marginErrorPct: round6(Math.abs(achievedMarginExact - targetMarginRate) * 100),
    }

    if (reverseExceeds150) {
      return {
        feasible: false,
        mathFeasible: true,
        feasibleUnderLowValueRegime: false,
        exceeds150Threshold: true,
        infeasibleReason: 'exceeds_150_low_value_threshold',
        targetMarginRate,
        marginBasis,
        maxTheoreticalMarginRate: round4(Math.max(0, maxTheoreticalMarginRate)),
        minNetPriceExclVatEur: round2(minNetPriceExclVat),
        minSellingPriceEur: null,
        minSellingPriceCeilEur: null,
        minSellingPriceExactEur: null,
        unconstrainedMinSellingPriceEur: minPriceCeil,
        unconstrainedMinSellingPriceExactEur: round6(exactP),
        priceIncreaseNeededEur: null,
        priceIncreaseNeededPct: null,
        loopbackCheck,
      }
    }

    const increaseEur = round2(Math.max(0, minPriceCeil - sellingPriceEur))
    const increasePct = sellingPriceEur > 0 ? round2((Math.max(0, minPriceCeil - sellingPriceEur) / sellingPriceEur) * 100) : 0
    return {
      feasible: true,
      mathFeasible: true,
      feasibleUnderLowValueRegime: true,
      exceeds150Threshold: false,
      infeasibleReason: null,
      targetMarginRate,
      marginBasis,
      maxTheoreticalMarginRate: round4(Math.max(0, maxTheoreticalMarginRate)),
      minNetPriceExclVatEur: round2(minNetPriceExclVat),
      minSellingPriceEur: minPriceCeil,
      minSellingPriceCeilEur: minPriceCeil,
      minSellingPriceExactEur: round6(exactP),
      unconstrainedMinSellingPriceEur: minPriceCeil,
      priceIncreaseNeededEur: increaseEur,
      priceIncreaseNeededPct: increasePct,
      loopbackCheck,
    }
  }

  const reversePricing = targetMarginRate !== null
    ? {
        mixedDirect: solveMinPrice(fixedCostMixedDirect),
        singleHsDirect: hsLineCount > 1 ? solveMinPrice(fixedCostSingleHs) : null,
      }
    : null

  const steps = [
    `价税分离（VAT ${(vatRate * 100).toFixed(1)}%）：含税售价 €${round2(sellingPriceEur)} → 不含税价 €${round2(netPriceExclVat)}，IOSS 进口 VAT €${round2(vatPerDelivered)}`,
    `欧盟低值包裹税费（欧委会 2026-10-05 指引第 3 节，按申报的不同商品项/税则项计收）：€3 临时关税 × ${hsLineCount} 项 = €${round2(euTempDutyEur)} + €2 海关处理费 × ${hsLineCount} 项（退货不退）= €${round2(euHandlingFeeEur)} → 合计 €${round2(euCustomsLevyTotalEur)}（IOSS 均不代收）`,
    `平台抽佣（${commissionOnVatInclusive ? 'PID 含税售价基数' : '不含税净营收基数'} ${(commissionRate * 100).toFixed(1)}%）：单单成交佣金 €${round2(commissionPerDelivered)}${vatInclusiveCommExtraPerDelivered > 0 ? `（含税抽佣较不含税基数多扣 €${round2(vatInclusiveCommExtraPerDelivered)}）` : ''}`,
    `当前同箱混装直邮期望利润（退货率 ${(returnRate * 100).toFixed(1)}%）：有效不含税营收 €${round2(effectiveNetRevenue)} − 成本与税费合计 €${round2(totalCostMixedDirect)} = 净利润 €${round2(netProfitMixedDirect)}（含税口径净利率 ${round2(netMarginOnGrossRate * 100)}% / 不含税口径 ${round2(netMarginOnExVatRate * 100)}%）`,
  ]
  if (returnRate > 0) {
    steps.push(
      `退货沉没损耗：全部已付处理费 €${round2(euHandlingFeeEur)}（€2 × ${hsLineCount} 项）退货不退沉没 €${round2(returnSunkHandlingFeeEur)}/发出单（折合每成交单额外背负 €${round2(returnSunkHandlingFeePerRetainedEur)}）；含关税/头程/货损累计退货沉没成本 €${round2(totalReturnSunkCostEur)}/单`,
    )
  }
  if (hsLineCount > 1) {
    steps.push(
      `【同购物篮对照 · 按项物理拆包】保持商品构成与总件数一致拆成 ${hsLineCount} 个包裹：关税仍 €${round2(euTempDutyEur)}、处理费仍 €${round2(euHandlingFeeEur)}，运费升至 €${round2(splitByHsShippingEur)}（多花 €${round2(splitByHsExtraShippingEur)}），单单净利降至 €${round2(netProfitSplitByHs)}（净利率 ${netMarginSplitByHsPct}%）`,
      `【SKU 结构优化参考 · 简化为单税则 SKU 组合】仅当改变订单/SKU 构成使整单仅含 1 个 HS 项时（hsLineCount=1，非同一购物篮物理拆包），税费降至 €3+€2=€5（省关税 €${round2(unpackDutySavingEur)} + 省处理费 €${round2(singleHsHandlingSavingEur)} = 共省 €${round2(singleHsTotalLevySavingEur)}），净利 €${round2(netProfitSingleHs)}（净利率 ${netMarginSingleHsPct}%）`,
    )
  }
  if (euWarehousePlan.configured) {
    steps.push(
      `【同购物篮对照 · 欧盟海外仓】单件履约（头程+关税+派送+仓储）€${euWarehousePlan.totalLogisticsEur}，退货回收率差调整 ${whReturnRecoveryAdjustmentEur >= 0 ? `+€${round2(whReturnRecoveryAdjustmentEur)}` : `-€${round2(-whReturnRecoveryAdjustmentEur)}`}，盈亏平衡履约红线 €${round2(breakevenWarehouseLogisticsVsMixed)}/单；免征 €3+€2 后净利 €${euWarehousePlan.netProfitEur}（较当前同箱直邮 ${euWarehousePlan.advantageVsMixedDirectEur >= 0 ? `多赚 €${euWarehousePlan.advantageVsMixedDirectEur}` : `少赚 €${round2(-euWarehousePlan.advantageVsMixedDirectEur)}`}/单）`,
    )
  } else {
    steps.push(
      `【欧盟海外仓盈亏平衡红线】直邮运费 €${round2(directShippingEur)} + 税费（€3×${hsLineCount} + €2×${hsLineCount}）€${round2(euCustomsLevyTotalEur)}${Math.abs(whReturnRecoveryAdjustmentEur) > 1e-9 ? ` ${whReturnRecoveryAdjustmentEur >= 0 ? '+' : '−'} 退货回收率差 €${round2(Math.abs(whReturnRecoveryAdjustmentEur))}` : ''} = 盈亏平衡履约线 €${round2(breakevenWarehouseLogisticsVsMixed)}/单；海外仓单件履约低于该红线即更省成本`,
    )
  }
  if (reversePricing) {
    const rp = reversePricing.mixedDirect
    if (rp.feasible) {
      steps.push(
        `【PID 反推保毛利最低可执行售价（目标净利率 ${(targetMarginRate * 100).toFixed(2)}%）】向上取分最低含税售价 €${rp.minSellingPriceEur}（对应不含税 €${rp.minNetPriceExclVatEur} ≤ €150，需调价 +€${rp.priceIncreaseNeededEur}；精确解 €${rp.minSellingPriceExactEur}，闭环验算误差 ${rp.loopbackCheck.marginErrorPct}%）`,
      )
    } else if (rp.exceeds150Threshold) {
      steps.push(
        `【反推售价跨 €150 门槛阻断】无约束反推含税价 €${rp.unconstrainedMinSellingPriceEur} 对应不含税内在价值 €${rp.minNetPriceExclVatEur} > €150，已跳出低值包裹 €3+€2 制度适用区间，低值直邮口径下不可行（feasibleUnderLowValueRegime=false）！`,
      )
    } else {
      steps.push(
        `【反推售价不可行】当前 VAT ${(vatRate * 100).toFixed(1)}% + 抽佣 ${(commissionRate * 100).toFixed(1)}% 下理论最大净利率仅 ${round2(rp.maxTheoreticalMarginRate * 100)}%，无法达到目标净利率 ${(targetMarginRate * 100).toFixed(2)}%`,
      )
    }
  }

  const warnings = [
    '【IOSS 边界红线】IOSS 仅覆盖 ≤€150 订单的进口 VAT 申报缴纳，不代收自 2026-07-01 起实施的 €3/项临时关税与自 2026-11-01 起实施的 €2/项欧盟处理费（按欧委会 2026-10-05 指引第 3 节均按不同申报项/税则项计收），须单独确认承运商/清关行 DDP 代缴链路，避免末端到付拒签。',
    '【€2/项处理费退货不退】买家退货或拒签时，全部已付处理费（€2 × 申报项数）均不可退回，属刚性沉没成本；高退货率类目（服装/鞋靴）须按有效成交单分摊损耗。',
  ]
  if (hsLineCount > 1) {
    warnings.push(
      `【混装翻倍与物理拆包误区预警】当前包裹含 ${hsLineCount} 个不同申报项/HS 税则项，€3 关税翻倍至 €${round2(euTempDutyEur)} 且 €2 处理费翻倍至 €${round2(euHandlingFeeEur)}（合计 €${round2(euCustomsLevyTotalEur)}）。注意：若保持相同购物篮仅物理拆成 ${hsLineCount} 个小包发货，关税与处理费仍为 €${round2(euCustomsLevyTotalEur)} 且运费增至 €${round2(splitByHsShippingEur)}（更亏 €${round2(splitByHsExtraShippingEur)}）；真正省税须在 SKU/订单结构上归并为单税则组合，或转走欧盟海外仓一般贸易清关！`,
    )
  }
  if (exceeds150Threshold) {
    warnings.push(
      `【超 €150 阈值预警】当前不含税内在货值 €${round2(intrinsicValueExclVat)} 已超过 €150 低值包裹与 IOSS 上限，不适用 IOSS 及低值包裹 €3+€2 口径，已停止推荐低值直邮方案，将转入常规一般贸易清关（按 HS 税率计征关税+进口 VAT）或欧盟海外仓备货。`,
    )
  }
  if (commissionOnVatInclusive && vatInclusiveCommExtraPerDelivered > 0) {
    warnings.push(
      `【PID 含税抽佣侵蚀提示】平台按含税售价 €${round2(sellingPriceEur)} 计提 ${(commissionRate * 100).toFixed(1)}% 佣金，较不含税基数每单多扣 €${round2(vatInclusiveCommExtraPerDelivered)}，定价反推时切勿用不含税价直接乘佣金率！`,
    )
  }
  if (reversePricing && reversePricing.mixedDirect.exceeds150Threshold) {
    const rp = reversePricing.mixedDirect
    warnings.push(
      `【反推售价跨 €150 门槛阻断】按目标净利率 ${(targetMarginRate * 100).toFixed(2)}% 反推的含税价 €${rp.unconstrainedMinSellingPriceEur} 对应不含税内在价值 €${rp.minNetPriceExclVatEur}，已超过 €150 低值包裹门槛，不再适用 €3+€2 临时方案（feasibleUnderLowValueRegime=false），须改按常规一般贸易清关重算或转欧盟海外仓！`,
    )
  } else if (reversePricing && !reversePricing.mixedDirect.feasible) {
    warnings.push(
      `【目标净利率超理论上限】给定 VAT 与抽佣率下，即使零采购零运费，净利率理论上限也仅为 ${round2(reversePricing.mixedDirect.maxTheoreticalMarginRate * 100)}%，请下调目标净利率或优化抽佣/税负结构。`,
    )
  }

  const assumptions = [
    `按欧委会 2026-10-05 指引第 3 节，欧盟低值包裹 €${EU_TEMP_DUTY_PER_HS_EUR} 临时关税与 €${EU_HANDLING_FEE_PER_HS_EUR} 海关处理费均按包裹内申报的不同商品项/税则项（hsLineCount=${hsLineCount}）计收，且处理费退货不退。`,
    `平台抽佣基数按 ${commissionOnVatInclusive ? '含 VAT 零售价（PID 常见口径）' : '不含 VAT 净营收'}，退货订单假设平台退回佣金与 IOSS VAT；直邮退货残值回收率 ${(returnGoodsRecoveryRate * 100).toFixed(1)}%、海外仓退货回收率 ${(whReturnRecovery * 100).toFixed(1)}%。`,
    `净利率与反推售价口径采用 ${marginBasis === 'ex_vat' ? '不含税有效净营收（ex_vat）' : '含税有效销售额（vat_inclusive）'}；保毛利最低可执行售价统一向上取分并强制复核不含税价值 ≤€150。`,
  ]
  const imaKeywords = ['欧盟2欧', '150欧元', 'IOSS', 'PID', 'VAT']
  const rpSummarySuffix = reversePricing?.mixedDirect.feasible
    ? `｜保毛利最低含税价 €${reversePricing.mixedDirect.minSellingPriceEur}`
    : reversePricing?.mixedDirect.exceeds150Threshold
      ? `｜反推价 €${reversePricing.mixedDirect.unconstrainedMinSellingPriceEur}（不含税 €${reversePricing.mixedDirect.minNetPriceExclVatEur}）超 €150 不可行`
      : ''
  const summaryLine = `单单 €3×${hsLineCount} 关税 €${round2(euTempDutyEur)} + €2×${hsLineCount} 处理费 €${round2(euHandlingFeeEur)}（均按项计收、退货不退）｜当前直邮净利 €${round2(netProfitMixedDirect)}（${round2(activeNetMarginRate * 100)}%）${hsLineCount > 1 ? `｜单税则SKU组合可省 €${round2(singleHsTotalLevySavingEur)}/单` : ''}${rpSummarySuffix}`

  const topInfeasibleReason = reversePricing?.mixedDirect.infeasibleReason ?? (exceeds150Threshold ? 'exceeds_150_low_value_threshold' : null)

  return {
    scenario: '欧盟低值包裹 €3 临时关税 + €2 处理费与 PID 含税抽佣反推售价',
    scenarioCode: 'eu_low_value_parcel',
    currency: 'EUR',
    sellingPriceEur: round2(sellingPriceEur),
    separateShippingInPriceEur: round2(separateShippingInPriceEur),
    netPriceExclVatEur: round2(netPriceExclVat),
    intrinsicValueExclVatEur: round2(intrinsicValueExclVat),
    vatAmountEur: round2(vatPerDelivered),
    hsLineCount,
    exceeds150Threshold,
    euTempDutyEur: round2(euTempDutyEur),
    euHandlingFeeEur: round2(euHandlingFeeEur),
    euCustomsLevyTotalEur: round2(euCustomsLevyTotalEur),
    commissionEur: round2(effectiveCommission),
    vatInclusiveCommissionExtraEur: round2(vatInclusiveCommExtraPerDelivered),
    returnSunkHandlingFeeEur: round2(returnSunkHandlingFeeEur),
    totalReturnSunkCostEur: round2(totalReturnSunkCostEur),
    netProfitEur: round2(netProfitMixedDirect),
    netMarginPct: round2(activeNetMarginRate * 100),
    netMarginOnGrossPct: round2(netMarginOnGrossRate * 100),
    netMarginOnExVatPct: round2(netMarginOnExVatRate * 100),
    singleHsConsolidationSavingEur: round2(unpackDutySavingEur),
    unpackDutySavingEur: round2(unpackDutySavingEur),
    singleHsHandlingSavingEur: round2(singleHsHandlingSavingEur),
    singleHsTotalLevySavingEur: round2(singleHsTotalLevySavingEur),
    minSellingPriceEur: reversePricing?.mixedDirect.minSellingPriceEur ?? null,
    minSellingPriceCeilEur: reversePricing?.mixedDirect.minSellingPriceCeilEur ?? null,
    minSellingPriceExactEur: reversePricing?.mixedDirect.minSellingPriceExactEur ?? null,
    infeasibleReason: topInfeasibleReason,
    reversePricingExceeds150Threshold: reversePricing?.mixedDirect.exceeds150Threshold ?? false,
    reversePricingFeasibleUnderLowValueRegime: reversePricing ? reversePricing.mixedDirect.feasibleUnderLowValueRegime : null,
    recommendedPlan,
    recommendedOption,
    summaryLine,
    summary: {
      headline: summaryLine,
      euTempDutyEur: round2(euTempDutyEur),
      euHandlingFeeEur: round2(euHandlingFeeEur),
      euCustomsLevyTotalEur: round2(euCustomsLevyTotalEur),
      netProfitEur: round2(netProfitMixedDirect),
      netMarginPct: round2(activeNetMarginRate * 100),
      singleHsConsolidationSavingEur: round2(unpackDutySavingEur),
      unpackDutySavingEur: round2(unpackDutySavingEur),
      singleHsTotalLevySavingEur: round2(singleHsTotalLevySavingEur),
      minSellingPriceEur: reversePricing?.mixedDirect.minSellingPriceEur ?? null,
      minSellingPriceCeilEur: reversePricing?.mixedDirect.minSellingPriceCeilEur ?? null,
      infeasibleReason: topInfeasibleReason,
      recommendedPlan,
      recommendedOption,
    },
    breakdown: {
      revenueAndTax: {
        sellingPriceEur: round2(sellingPriceEur),
        separateShippingInPriceEur: round2(separateShippingInPriceEur),
        vatRate,
        netPriceExclVatEur: round2(netPriceExclVat),
        intrinsicValueExclVatEur: round2(intrinsicValueExclVat),
        vatPerDeliveredEur: round2(vatPerDelivered),
        effectiveGrossSalesEur: round2(effectiveGrossSales),
        effectiveNetRevenueEur: round2(effectiveNetRevenue),
        exceeds150Threshold,
      },
      customsLevies: {
        hsLineCount,
        dutyPerHsLineEur: EU_TEMP_DUTY_PER_HS_EUR,
        handlingFeePerHsLineEur: EU_HANDLING_FEE_PER_HS_EUR,
        handlingFeeBillingUnit: 'per_declared_hs_item',
        euTempDutyEur: round2(euTempDutyEur),
        euHandlingFeeEur: round2(euHandlingFeeEur),
        handlingFeeRefundableOnReturn: false,
        iossCollectsDutyOrHandling: false,
        totalCustomsLevyEur: round2(euCustomsLevyTotalEur),
      },
      commissionAndPid: {
        commissionRate,
        commissionOnVatInclusive,
        commissionPerDeliveredEur: round2(commissionPerDelivered),
        effectiveCommissionEur: round2(effectiveCommission),
        vatInclusiveExtraCommissionEur: round2(vatInclusiveCommExtraPerDelivered),
      },
      returnSunkCosts: {
        returnRate,
        returnGoodsRecoveryRate,
        returnSunkHandlingFeeEur: round2(returnSunkHandlingFeeEur),
        returnSunkHandlingFeePerRetainedEur: round2(returnSunkHandlingFeePerRetainedEur),
        returnSunkDutyEur: round2(returnSunkDutyEur),
        returnSunkShippingEur: round2(returnSunkShippingEur),
        returnSunkCogsEur: round2(returnSunkCogsEur),
        totalReturnSunkCostEur: round2(totalReturnSunkCostEur),
      },
      planComparison: {
        mixedDirect: {
          mode: 'same_basket_single_parcel',
          hsLineCount,
          parcelCount: 1,
          shippingEur: round2(directShippingEur),
          customsLevyEur: round2(euCustomsLevyTotalEur),
          totalCostEur: round2(totalCostMixedDirect),
          netProfitEur: round2(netProfitMixedDirect),
          netMarginPct: round2(activeNetMarginRate * 100),
          monthlyNetProfitEur: monthlyOrders !== null ? round2(netProfitMixedDirect * monthlyOrders) : null,
        },
        splitParcelByHsDirect: {
          mode: 'same_basket_physical_split',
          hsLineCount,
          parcelCount: hsLineCount,
          shippingEur: round2(splitByHsShippingEur),
          extraShippingVsMixedEur: round2(splitByHsExtraShippingEur),
          customsLevyEur: round2(euCustomsLevyTotalEur),
          totalCostEur: round2(totalCostSplitByHs),
          netProfitEur: round2(netProfitSplitByHs),
          netMarginPct: netMarginSplitByHsPct,
          deltaVsMixedEur: round2(netProfitSplitByHs - netProfitMixedDirect),
          monthlyNetProfitEur: monthlyOrders !== null ? round2(netProfitSplitByHs * monthlyOrders) : null,
        },
        singleHsDirect: {
          mode: 'simplified_single_hs_sku_bundle',
          sameBasketEquivalent: hsLineCount === 1,
          hsLineCount: 1,
          parcelCount: 1,
          shippingEur: round2(directShippingEur),
          customsLevyEur: round2(singleHsLevyTotalEur),
          dutySavingVsMixedEur: round2(unpackDutySavingEur),
          handlingSavingVsMixedEur: round2(singleHsHandlingSavingEur),
          totalLevySavingVsMixedEur: round2(singleHsTotalLevySavingEur),
          totalCostEur: round2(fixedCostSingleHs + effectiveCommission),
          netProfitEur: round2(netProfitSingleHs),
          netMarginPct: netMarginSingleHsPct,
          monthlyDutySavingEur: monthlyOrders !== null ? round2(unpackDutySavingEur * monthlyOrders) : null,
          monthlyTotalLevySavingEur: monthlyOrders !== null ? round2(singleHsTotalLevySavingEur * monthlyOrders) : null,
        },
        euWarehouse: euWarehousePlan,
        recommendedPlan,
        recommendedOption,
      },
      reversePricing,
    },
    steps,
    warnings,
    assumptions,
    imaKeywords,
    policyRefs: [
      { ref: '欧盟低值包裹 €3 临时关税（2026-07-01 起）与 €2 处理费新规（2026-11-01 起，欧委会 2026-10-05 指引第 3 节）', note: '≤€150 低值包裹 €3 临时关税（自 2026-07-01）与 €2 处理费（自 2026-11-01）均按包裹内申报的不同商品项/税则项计收，处理费退货不退，IOSS 均不代收' },
      { ref: '欧盟电商 VAT 改革方案（IOSS ≤€150 口径）', note: 'IOSS 仅用于 ≤€150 不含税内在价值（扣除发票单列运费）订单的进口 VAT 简化申报；平台含税抽佣（PID 效应）须在反推售价中计入并复核 ≤€150 门槛' },
    ],
    disclaimer: STANDARD_DISCLAIMER,
  }
}

// ── 场景 13：美线 T86 暂停：Type 11 直邮 vs 9810 海外仓 DDP + IEEPA 退税 & FIOR/CTPAT 红线 ──
const IEEPA_WINDOW_START = '2025-02-01'
const IEEPA_WINDOW_END = '2026-02-23' // CBP CSMS #67834313: 停收美东时间 2026-02-24 00:00，停收前完整自然日截至 2026-02-23
const IEEPA_CUTOFF_EST = '2026-02-24T00:00:00-05:00'
const TYPE11_MAX_COMMERCIAL_VALUE_USD = 2500
const AMAZON_US_2027_FBA_HIKE_USD = 0.19

function normalizeUsTariffProgram(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw new CalcInputError('tariffProgram 仅支持 IEEPA、Section301、Section232 或 Section122')
  }
  if (String(raw).trim() === '') return null
  const key = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (key === 'ieepa') return 'IEEPA'
  if (key === 'section301' || key === '301') return 'Section301'
  if (key === 'section232' || key === '232') return 'Section232'
  if (key === 'section122' || key === '122') return 'Section122'
  throw new CalcInputError('tariffProgram 仅支持 IEEPA、Section301、Section232 或 Section122')
}

/**
 * 场景 13：美线 $800 T86 暂停后 Type 11 直邮（先判 $2,500 商业非正式进口资格）vs 9810 海外仓 DDP 单件毛利对比，
 * 含 2027-01-15 Amazon US FBA 全盘平均涨价 $0.19 敏感度（支持 fba2027DeltaUsd 覆盖）、
 * IEEPA/CAPE 退税严格口径拦截（禁止单端日期互填，CBP 美东 2026-02-24 00:00 停收 CSMS #67834313）及 2027-01-05 FIOR (91 FR 69977) + CTPAT-validated 红线。
 */
export function usT86Vs9810Ddp(rawParams = {}) {
  const p = ensureParamsObject(rawParams)
  const sellingPriceUsd = reqBoundedNum(
    pickParam(p, ['sellingPriceUsd', 'priceUsd', '售价', '商品售价']),
    'sellingPriceUsd 必须是正数（商品售价，USD）',
    { allowZero: false },
  )
  const purchaseCostUsd = reqBoundedNum(
    pickParam(p, ['purchaseCostUsd', 'cogsUsd', '采购成本']),
    'purchaseCostUsd 必须是非负数字（采购成本，USD）',
    { allowZero: true },
  )
  const isExplicitlyProvided = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')
  const declaredRaw = pickParam(p, ['declaredValueUsd', 'fobUsd', 'dutiableValueUsd', '申报完税价', '完税价'])
  const type11DeclaredRaw = pickParam(p, ['type11DeclaredValueUsd', '直邮申报价'])
  const ddpDeclaredRaw = pickParam(p, ['ddpDeclaredValueUsd', '海外仓申报价'])
  const declaredValueProvided = isExplicitlyProvided(declaredRaw)
  const type11DeclaredProvided = declaredValueProvided || isExplicitlyProvided(type11DeclaredRaw)
  const ddpDeclaredProvided = declaredValueProvided || isExplicitlyProvided(ddpDeclaredRaw)
  const anyDeclaredProvided = type11DeclaredProvided || ddpDeclaredProvided
  const declaredValueUsd = optBoundedNum(declaredRaw, purchaseCostUsd, 'declaredValueUsd')
  const type11DeclaredValueUsd = optBoundedNum(type11DeclaredRaw, declaredValueUsd, 'type11DeclaredValueUsd')
  const ddpDeclaredValueUsd = optBoundedNum(ddpDeclaredRaw, declaredValueUsd, 'ddpDeclaredValueUsd')

  const tariffRate = optBoundedNum(pickParam(p, ['tariffRate', 'totalTariffRate', '总关税率']), 0.35, 'tariffRate')
  const type11TariffRate = optBoundedNum(pickParam(p, ['type11TariffRate', '直邮关税率']), tariffRate, 'type11TariffRate')
  const ddpTariffRate = optBoundedNum(pickParam(p, ['ddpTariffRate', '海外仓关税率']), tariffRate, 'ddpTariffRate')
  const commissionRate = optBoundedNum(pickParam(p, ['commissionRate', 'platformCommissionRate', '平台佣金率']), 0.15, 'commissionRate')

  const type11ShippingUsd = optBoundedNum(pickParam(p, ['type11ShippingUsd', 'directShippingUsd', '直邮运费']), 0, 'type11ShippingUsd')
  const type11ClearanceFeeUsd = optBoundedNum(pickParam(p, ['type11ClearanceFeeUsd', 'mpfAndClearanceUsd', '清关杂费']), 0, 'type11ClearanceFeeUsd')
  const ddpFirstLegUsd = optBoundedNum(pickParam(p, ['ddpFirstLegUsd', 'oceanFreightUsd', '头程运费']), 0, 'ddpFirstLegUsd')
  const ddpClearanceAmortizedUsd = optBoundedNum(pickParam(p, ['ddpClearanceAmortizedUsd', 'ddpMpfUsd', '头程清关分摊']), 0, 'ddpClearanceAmortizedUsd')
  const localDeliveryUsd = optBoundedNum(pickParam(p, ['localDeliveryUsd', 'fbaFulfillmentUsd', 'lastMileUsd', '本土派送费']), 0, 'localDeliveryUsd')
  const monthlyStorageUsd = optBoundedNum(pickParam(p, ['monthlyStorageUsd', 'storageUsd', '月均仓储费']), 0, 'monthlyStorageUsd')
  const otherVariableCostUsd = optBoundedNum(pickParam(p, ['otherVariableCostUsd', '其他变动成本']), 0, 'otherVariableCostUsd')
  const apply2027FbaHikeRaw = optBoolean(pickParam(p, ['apply2027FbaHike', '计入2027FBA涨价']), 'apply2027FbaHike')
  const apply2027FbaHike = apply2027FbaHikeRaw === true
  const fbaDeltaRaw = pickParam(p, ['fba2027DeltaUsd', 'fba2027HikeUsd', '2027FBA涨价幅度'])
  const fbaDeltaCustom = fbaDeltaRaw !== undefined && fbaDeltaRaw !== null && !(typeof fbaDeltaRaw === 'string' && fbaDeltaRaw.trim() === '')
  const fba2027DeltaUsd = optSignedNum(fbaDeltaRaw, AMAZON_US_2027_FBA_HIKE_USD, 'fba2027DeltaUsd')
  if (Math.abs(fba2027DeltaUsd) > MAX_MONETARY) {
    throw new CalcInputError(`fba2027DeltaUsd 超出合理数值上限（绝对值不得超过 ${MAX_MONETARY}）`)
  }
  const monthlyVolume = optIntRange(pickParam(p, ['monthlyVolume', 'monthlyUnits', '月销量']), 1000, 'monthlyVolume', { min: 0, max: MAX_VOLUME })

  const ieepaPaidUsd = optBoundedNum(pickParam(p, ['ieepaPaidUsd', '已缴IEEPA关税']), null, 'ieepaPaidUsd')
  const entryDateObj = optIsoDate(pickParam(p, ['entryDate', '缴税日期', '入境日期']), 'entryDate')
  const entryPeriodStartDate = optIsoDate(pickParam(p, ['entryPeriodStart', '缴税开始日期']), 'entryPeriodStart')
  const entryPeriodEndDate = optIsoDate(pickParam(p, ['entryPeriodEnd', '缴税结束日期']), 'entryPeriodEnd')
  const tariffProgram = normalizeUsTariffProgram(pickParam(p, ['tariffProgram', '关税项目']))
  const aceAchBound = optBoolean(pickParam(p, ['aceAchBound', '是否绑定ACE_ACH']), 'aceAchBound')

  checkRate(tariffRate, 'tariffRate', { max: 5, inclusiveMax: true, hint: '0~5 之间的小数（如 35% 传 0.35，145% 传 1.45）' })
  checkRate(type11TariffRate, 'type11TariffRate', { max: 5, inclusiveMax: true, hint: '0~5 之间的小数' })
  checkRate(ddpTariffRate, 'ddpTariffRate', { max: 5, inclusiveMax: true, hint: '0~5 之间的小数' })
  checkRate(commissionRate, 'commissionRate', { max: 1, inclusiveMax: false, hint: '0~1 之间的小数（须小于 1，如 15% 传 0.15）' })
  if (entryPeriodStartDate && entryPeriodEndDate && entryPeriodEndDate < entryPeriodStartDate) {
    throw new CalcInputError('entryPeriodEnd 不得早于 entryPeriodStart')
  }
  if (entryDateObj && entryPeriodStartDate && entryDateObj < entryPeriodStartDate) {
    throw new CalcInputError('entryDate 不得早于 entryPeriodStart')
  }
  if (entryDateObj && entryPeriodEndDate && entryDateObj > entryPeriodEndDate) {
    throw new CalcInputError('entryDate 不得晚于 entryPeriodEnd')
  }

  const commissionUsd = sellingPriceUsd * commissionRate

  // 先判 Type 11 非正式进口资格（19 CFR §143.21：普通商业货完税价上限 $2,500）
  const type11Eligible = type11DeclaredValueUsd <= TYPE11_MAX_COMMERCIAL_VALUE_USD
  const type11IneligibleReason = type11Eligible
    ? null
    : `申报完税价 $${round2(type11DeclaredValueUsd)} 超过普通商业货 Type 11 非正式进口上限 $${TYPE11_MAX_COMMERCIAL_VALUE_USD}（19 CFR §143.21），不适用 Type 11，须改走 Type 01 正式报关（Formal Entry）或 9810 海外仓 DDP。`

  // 路径 A：Type 11 直邮清关（若超 $2,500 仅作成本对照，禁止推荐）
  const type11DutyUsd = type11DeclaredValueUsd * type11TariffRate
  const type11LogisticsTotalUsd = type11ShippingUsd + type11ClearanceFeeUsd
  const type11TotalCostUsd = purchaseCostUsd + type11DutyUsd + type11LogisticsTotalUsd + commissionUsd + otherVariableCostUsd
  const type11NetProfitUsd = sellingPriceUsd - type11TotalCostUsd
  const type11MarginPct = round2((type11NetProfitUsd / sellingPriceUsd) * 100)

  // 路径 B：9810 海外仓 DDP（头程 + 清关关税 + 本土派送 + 月均仓储）
  const ddpDutyUsd = ddpDeclaredValueUsd * ddpTariffRate
  const fbaHikeAppliedUsd = apply2027FbaHike ? fba2027DeltaUsd : 0
  const ddpLogisticsTotalUsd = ddpFirstLegUsd + ddpClearanceAmortizedUsd + localDeliveryUsd + monthlyStorageUsd + fbaHikeAppliedUsd
  const ddpTotalCostUsd = purchaseCostUsd + ddpDutyUsd + ddpLogisticsTotalUsd + commissionUsd + otherVariableCostUsd
  const ddpNetProfitUsd = sellingPriceUsd - ddpTotalCostUsd
  const ddpMarginPct = round2((ddpNetProfitUsd / sellingPriceUsd) * 100)
  const ddpProfitAfter2027FbaHikeUsd = apply2027FbaHike ? ddpNetProfitUsd : ddpNetProfitUsd - fba2027DeltaUsd

  // 单件利差与月销量放大收益（正数表示 9810 海外仓 DDP 更优；Type 11 不合资格时绝不推荐 Type 11）
  const unitProfitDiffUsd = ddpNetProfitUsd - type11NetProfitUsd
  const monthlyProfitDiffUsd = unitProfitDiffUsd * monthlyVolume
  const unitProfitDiffAfter2027HikeUsd = ddpProfitAfter2027FbaHikeUsd - type11NetProfitUsd
  const monthlyProfitDiffAfter2027HikeUsd = unitProfitDiffAfter2027HikeUsd * monthlyVolume
  const recommendedPath = !type11Eligible
    ? '9810_ddp'
    : unitProfitDiffUsd > 0.005
      ? '9810_ddp'
      : unitProfitDiffUsd < -0.005
        ? 'type11_direct'
        : 'equal'

  // IEEPA / CAPE 退税估算严格校验（禁止单端日期互填，禁止未传 tariffProgram 默认按 IEEPA 放行）
  const ieepaEvaluated =
    ieepaPaidUsd !== null ||
    entryDateObj !== null ||
    entryPeriodStartDate !== null ||
    entryPeriodEndDate !== null ||
    tariffProgram !== null ||
    aceAchBound !== null

  const startStr = entryPeriodStartDate?.toISOString().slice(0, 10) ?? null
  const endStr = entryPeriodEndDate?.toISOString().slice(0, 10) ?? null
  const entryDateStr = entryDateObj?.toISOString().slice(0, 10) ?? null
  const singleDateMode = entryDateStr !== null && startStr === null && endStr === null
  const effStart = singleDateMode ? entryDateStr : startStr
  const effEnd = singleDateMode ? entryDateStr : endStr
  const effectiveProgram = tariffProgram // 严禁在未显式传入 tariffProgram 时私自回退为 'IEEPA'

  let ieepaRefund = {
    evaluated: ieepaEvaluated,
    tariffProgram: effectiveProgram,
    ieepaPaidUsd: ieepaPaidUsd !== null ? round2(ieepaPaidUsd) : null,
    entryDate: entryDateStr,
    entryPeriodStart: effStart,
    entryPeriodEnd: effEnd,
    periodMode: singleDateMode ? 'single_entry_date' : (effStart && effEnd ? 'period_range' : 'incomplete'),
    eligibleWindow: {
      start: IEEPA_WINDOW_START,
      end: IEEPA_WINDOW_END,
      cutoffTimestampEst: IEEPA_CUTOFF_EST,
      csmsRef: 'CSMS #67834313',
    },
    eligible: false,
    status: 'not_provided',
    eligibleRefundUsd: 0,
    aceAchBound,
    achHoldAlert: aceAchBound === false,
    reason: null,
  }

  const warnings = []
  if (!type11Eligible) {
    warnings.push(
      `【P0 · Type 11 资格拦截（>$2,500）】当前直邮申报完税价 $${round2(type11DeclaredValueUsd)} 超过普通商业货 Type 11 非正式进口上限 $2,500（19 CFR §143.21），不适用 Type 11，须改走 Type 01 正式报关（Formal Entry，须配 Customs Bond 与正式 MPF）或 9810 海外仓 DDP；上述 Type 11 算术结果仅作对照，严禁直接按 Type 11 申报！`,
    )
  }

  if (ieepaEvaluated) {
    if (effectiveProgram !== null && effectiveProgram !== 'IEEPA') {
      ieepaRefund.status = 'ineligible_program'
      ieepaRefund.eligible = false
      ieepaRefund.eligibleRefundUsd = 0
      ieepaRefund.reason = `${effectiveProgram} 关税不适用 IEEPA / CAPE 退税通道，可申报参考额已强制归零。`
      warnings.push(
        `【IEEPA/CAPE 退税拦截】传入税种为 ${effectiveProgram}，不适用 CAPE 退税（CAPE 退税仅针对 IEEPA 项下且入境/出库日早于 CBP 美东 2026-02-24 00:00 停收时点［CSMS #67834313，完整自然日 ${IEEPA_WINDOW_START} 至 ${IEEPA_WINDOW_END}］的实缴税行；Section301/Section232/Section122 一律归零拦截）。`,
      )
    } else if (!effStart || !effEnd) {
      ieepaRefund.status = 'pending_period'
      ieepaRefund.eligible = false
      ieepaRefund.eligibleRefundUsd = 0
      ieepaRefund.reason = `缺少完整缴税/入境期间（禁止用单端日期互填）：须同时提供 entryPeriodStart 与 entryPeriodEnd，或显式传独立单日字段 entryDate${effectiveProgram === null ? '，并显式指定 tariffProgram' : ''}，逐申报行核实税种、入境/出库日、实缴与清算状态。`
      warnings.push(
        `【IEEPA 退税待核验·日期不全】仅提供单端日期或未提供期间（禁止 start/end 互填），须补齐完整起止期或独立单日 entryDate${effectiveProgram === null ? ' 并显式指定 tariffProgram' : ''}，核验早于美东 2026-02-24 00:00 停收时点（CSMS #67834313）后方可估算（当前保守归零）。`,
      )
    } else if (effectiveProgram === null) {
      ieepaRefund.status = 'pending_verification'
      ieepaRefund.eligible = false
      ieepaRefund.eligibleRefundUsd = 0
      ieepaRefund.reason = '未显式指定关税项目 tariffProgram，严禁默认按 IEEPA 计入退税；须逐申报行核实税种确属 IEEPA（排除 Section 301/232/122）、入境/出库日、实缴金额与清算状态。'
      warnings.push(
        '【IEEPA 退税待核验·未指定税种】未显式传入 tariffProgram，严禁自动假定为 IEEPA；请逐申报行核对税种（IEEPA vs Section301/232/122）、入境/出库日、实缴与清算状态（当前保守归零）。',
      )
    } else if (ieepaPaidUsd === null) {
      ieepaRefund.status = 'pending_verification'
      ieepaRefund.eligible = false
      ieepaRefund.eligibleRefundUsd = 0
      ieepaRefund.reason = '未提供实缴 IEEPA 税额（ieepaPaidUsd），请按报关申报行核实实缴与清算状态后填入。'
      warnings.push('【IEEPA 退税待核验·缺实缴税额】未传入实缴 IEEPA 税额 ieepaPaidUsd，当前参考额为 $0。')
    } else if (effEnd < IEEPA_WINDOW_START || effStart > IEEPA_WINDOW_END) {
      ieepaRefund.status = 'out_of_window'
      ieepaRefund.eligible = false
      ieepaRefund.eligibleRefundUsd = 0
      ieepaRefund.reason = `缴税/入境期 ${effStart} 至 ${effEnd} 超出 IEEPA 停收前窗口（${IEEPA_WINDOW_START} 至 ${IEEPA_WINDOW_END}，CBP 美东 2026-02-24 00:00 停收 CSMS #67834313），不计入 CAPE 可申报参考额。`
      warnings.push(`【IEEPA 退税拦截·超期单据】缴税/入境期 ${effStart} 至 ${effEnd} 超出适用窗口（${IEEPA_WINDOW_START} 至 ${IEEPA_WINDOW_END}，美东 2026-02-24 00:00 停收），可申报参考额强制归零。`)
    } else if (effStart < IEEPA_WINDOW_START || effEnd > IEEPA_WINDOW_END) {
      ieepaRefund.status = 'partial_window_split_required'
      ieepaRefund.eligible = false
      ieepaRefund.eligibleRefundUsd = 0
      ieepaRefund.reason = `缴税/入境期 ${effStart} 至 ${effEnd} 跨出 ${IEEPA_WINDOW_START} 至 ${IEEPA_WINDOW_END} 边界（美东 2026-02-24 00:00 停收），须逐申报行拆出窗口内实缴 IEEPA 税额并核对清算状态后再估算。`
      warnings.push(`【IEEPA 退税拦截·跨期须逐行拆分】缴税/入境期 ${effStart} 至 ${effEnd} 跨越 ${IEEPA_WINDOW_START} 至 ${IEEPA_WINDOW_END} 边界，严禁整段混报，请逐申报行核实税种、入境/出库日、实缴与清算状态后拆出窗口内税额（当前保守归零）。`)
    } else {
      ieepaRefund.status = 'eligible_reference'
      ieepaRefund.eligible = true
      ieepaRefund.eligibleRefundUsd = round2(ieepaPaidUsd)
      ieepaRefund.reason = `税种为 IEEPA 且${singleDateMode ? `入境/缴税日 ${entryDateStr}` : `期间 ${effStart} 至 ${effEnd}`} 落在 CBP 美东 2026-02-24 00:00 停收前窗口（${IEEPA_WINDOW_START} 至 ${IEEPA_WINDOW_END}，CSMS #67834313），可申报参考额 $${round2(ieepaPaidUsd)}；实际退税仍须逐申报行核实税种、入境/出库日、实缴凭证与 CBP 清算（liquidation）状态。`
    }
    if (aceAchBound === false) {
      warnings.push(
        '【P0 · ACE ACH Hold 警告】检测到 aceAchBound=false（未在 CBP ACE Portal 绑定有效 ACH 退税银行账户），CAPE 退税申请将触发 ACH Hold 挂起无法打款，请立即完成 ACE ACH 银行绑定并核验 IOR 抬头一致！',
      )
    } else if (aceAchBound === null && ieepaRefund.eligible) {
      warnings.push('【ACE ACH 绑定待确认】尚未确认 CBP ACE Portal 是否已完成 ACH 退税账户绑定，请核实后再提交 CAPE 退税，避免触发 ACH Hold。')
    }
  }

  // 所有美线结果强制附带：2027-01-05 FIOR (91 FR 69977) + CTPAT-validated 红线 & 2027-01-15 Amazon US FBA 涨价敏感度提示
  warnings.push(
    '【P0 · 2027-01-05 美国 CBP FIOR+CTPAT 强制清关红线（91 FR 69977）】自 2027-01-05 起，美国本土 IOR 须位于美国且依法在美设立并满足 ≥51% 美国公民/绿卡实益所有与控制条件，替代资产条件严格限于持续直接持有的无负担美国不动产（非泛称实体资产），金额取 $20M 与上年申报进口货值 100% 孰高；不符合者均界定为境外进口商（FIOR），须自身获 CTPAT-validated 资质或委托 CTPAT-validated 美国持牌报关行清关；19 CFR §111.29 报关行核验延期须申请获准（最晚至 2027-05-06），且不推迟 2027-01-05 FIOR 硬熔断！',
    `【2027-01-15 Amazon US FBA 涨价敏感度提示】Amazon US FBA 配送费自 2027-01-15 起按${fbaDeltaCustom ? `自定义假设 $${fba2027DeltaUsd.toFixed(2)}/件` : `全盘平均敏感度假设 $${AMAZON_US_2027_FBA_HIKE_USD.toFixed(2)}/件（各尺寸段/价位段差异可用 fba2027DeltaUsd 覆盖）`}测算（另须关注合并库龄仓储与 3.5% AWD 燃油附加费）；${apply2027FbaHike ? `本次 9810 DDP 试算已计入该 $${fba2027DeltaUsd.toFixed(2)} 增量` : `计入该 $${fba2027DeltaUsd.toFixed(2)} 后 9810 DDP 单件毛利将降至 $${round2(ddpProfitAfter2027FbaHikeUsd)}（月利差 $${round2(monthlyProfitDiffAfter2027HikeUsd)}）`}。`,
  )

  const steps = [
    `共同项：售价 $${round2(sellingPriceUsd)}，采购成本 $${round2(purchaseCostUsd)}，平台佣金（${(commissionRate * 100).toFixed(1)}%）$${round2(commissionUsd)}${otherVariableCostUsd > 0 ? `，其他变动成本 $${round2(otherVariableCostUsd)}` : ''}`,
    `【Type 11 资格预检（19 CFR §143.21）】直邮完税价 $${round2(type11DeclaredValueUsd)} ${type11Eligible ? `≤ $${TYPE11_MAX_COMMERCIAL_VALUE_USD}（普通商业货非正式进口门槛内，受限/反倾销/PGA品类仍须核验）` : `> $${TYPE11_MAX_COMMERCIAL_VALUE_USD} → 不适用 Type 11（type11Eligible=false），须改走 Type 01 正式报关或 9810 海外仓 DDP`}`,
    `【方案 A · Type 11 直邮${type11Eligible ? '' : '（超限不适用，仅成本对照）'}】完税价 $${round2(type11DeclaredValueUsd)} × 税率 ${(type11TariffRate * 100).toFixed(1)}% = 关税 $${round2(type11DutyUsd)} + 直邮运费 $${round2(type11ShippingUsd)} + 清关/MPF $${round2(type11ClearanceFeeUsd)} → 全链路成本 $${round2(type11TotalCostUsd)}，单件毛利 $${round2(type11NetProfitUsd)}（${type11MarginPct}%）`,
    `【方案 B · 9810 海外仓 DDP】完税价 $${round2(ddpDeclaredValueUsd)} × 税率 ${(ddpTariffRate * 100).toFixed(1)}% = 关税 $${round2(ddpDutyUsd)} + 头程 $${round2(ddpFirstLegUsd)} + 清关分摊 $${round2(ddpClearanceAmortizedUsd)} + 本土派送 $${round2(localDeliveryUsd)} + 月均仓储 $${round2(monthlyStorageUsd)}${apply2027FbaHike ? ` + 2027 FBA 敏感度假设 $${fba2027DeltaUsd.toFixed(2)}` : ''} → 全链路成本 $${round2(ddpTotalCostUsd)}，单件毛利 $${round2(ddpNetProfitUsd)}（${ddpMarginPct}%）`,
    type11Eligible
      ? `【双路径单件利差与月度放大】9810 DDP 较 Type 11 直邮单件 ${unitProfitDiffUsd >= 0 ? `多赚 $${round2(unitProfitDiffUsd)}` : `少赚 $${round2(-unitProfitDiffUsd)}`}；按月销 ${monthlyVolume} 件放大，月净利差 ${monthlyProfitDiffUsd >= 0 ? `+$${round2(monthlyProfitDiffUsd)}` : `-$${round2(-monthlyProfitDiffUsd)}`}`
      : `【路径推荐结论】因完税价 $${round2(type11DeclaredValueUsd)} > $${TYPE11_MAX_COMMERCIAL_VALUE_USD} 不适用 Type 11，直接排除 Type 11 推荐，建议走 9810 海外仓 DDP（单件毛利 $${round2(ddpNetProfitUsd)}）或另按 Type 01 正式报关重算。`,
  ]
  if (ieepaEvaluated) {
    steps.push(`【IEEPA / CAPE 退税核验】税种 ${effectiveProgram ?? '未显式指定'}，${singleDateMode ? `单日 ${entryDateStr}` : `期间 ${effStart ?? '未填'} 至 ${effEnd ?? '未填'}`} → 状态 ${ieepaRefund.status}，可申报参考额 $${ieepaRefund.eligibleRefundUsd}${aceAchBound === false ? '（⚠ P0 ACH Hold 阻塞）' : ''}`)
  }

  const assumptions = [
    anyDeclaredProvided
      ? `申报完税价按显式传入/回退基数计征关税（Type 11: $${round2(type11DeclaredValueUsd)}${type11DeclaredProvided ? '［显式传入］' : '［默认按采购成本］'}，9810 DDP: $${round2(ddpDeclaredValueUsd)}${ddpDeclaredProvided ? '［显式传入］' : '［默认按采购成本］'}）；普通商业货 Type 11 非正式进口上限为 $${TYPE11_MAX_COMMERCIAL_VALUE_USD}（特定受限/配额/AD-CVD/PGA 品类即使 ≤$${TYPE11_MAX_COMMERCIAL_VALUE_USD} 亦可能须走 Type 01）。`
      : `未单独传入 declaredValueUsd / type11DeclaredValueUsd / ddpDeclaredValueUsd，默认以采购成本 $${round2(purchaseCostUsd)} 作为完税价 FOB 基数；实际海关估价以交易发票与一卖原则核定为准。`,
    `2027-01-15 Amazon US FBA 涨价按${fbaDeltaCustom ? `自定义值 $${fba2027DeltaUsd.toFixed(2)}/件` : `全盘平均敏感度假设 $${AMAZON_US_2027_FBA_HIKE_USD.toFixed(2)}/件`}试算；月度放大收益按月销 ${monthlyVolume} 件线性测算，不含备货资金占用利息与滞销移除费。`,
    `IEEPA 退税估算严格按 CBP 美东 2026-02-24 00:00 停收时点（CSMS #67834313，完整自然日 ${IEEPA_WINDOW_START} 至 ${IEEPA_WINDOW_END}）与显式税种白名单执行 fail-closed 过滤，禁止单端日期互填，实际退税须逐申报行核对入境/出库日、实缴与清算状态。`,
  ]
  const imaKeywords = ['FIOR', 'CTPAT', 'IEEPA', '美国关税', '境外进口商', 'T86', '9810']
  const diffLabel = unitProfitDiffUsd >= 0 ? `9810 DDP 单件多赚 $${round2(unitProfitDiffUsd)}` : `Type 11 直邮单件多赚 $${round2(-unitProfitDiffUsd)}`
  const summaryLine = type11Eligible
    ? `Type 11 毛利 $${round2(type11NetProfitUsd)}（${type11MarginPct}%）vs 9810 DDP 毛利 $${round2(ddpNetProfitUsd)}（${ddpMarginPct}%）｜${diffLabel}（月销 ${monthlyVolume} 件差 $${round2(Math.abs(monthlyProfitDiffUsd))}）${ieepaEvaluated ? `｜CAPE 参考退税 $${ieepaRefund.eligibleRefundUsd}` : ''}`
    : `【Type 11 不适用：完税价 $${round2(type11DeclaredValueUsd)} > $${TYPE11_MAX_COMMERCIAL_VALUE_USD} 须走 Type 01 正式报关】9810 DDP 毛利 $${round2(ddpNetProfitUsd)}（${ddpMarginPct}%）${ieepaEvaluated ? `｜CAPE 参考退税 $${ieepaRefund.eligibleRefundUsd}` : ''}`

  return {
    scenario: '美线 T86 暂停：Type 11 直邮 vs 9810 海外仓 DDP 与 IEEPA/FIOR 测算',
    scenarioCode: 'us_t86_vs_9810_ddp',
    currency: 'USD',
    sellingPriceUsd: round2(sellingPriceUsd),
    type11Eligible,
    type11MaxDeclaredValueUsd: TYPE11_MAX_COMMERCIAL_VALUE_USD,
    type11IneligibleReason,
    type11NetProfitUsd: round2(type11NetProfitUsd),
    type11MarginPct,
    ddpNetProfitUsd: round2(ddpNetProfitUsd),
    ddpMarginPct,
    fba2027DeltaUsd: round2(fba2027DeltaUsd),
    ddpProfitAfter2027FbaHikeUsd: round2(ddpProfitAfter2027FbaHikeUsd),
    unitProfitDiffUsd: round2(unitProfitDiffUsd),
    monthlyVolume,
    monthlyProfitDiffUsd: round2(monthlyProfitDiffUsd),
    recommendedPath,
    ieepaEligibleRefundUsd: ieepaRefund.eligibleRefundUsd,
    achHoldAlert: ieepaRefund.achHoldAlert,
    summaryLine,
    summary: {
      headline: summaryLine,
      type11Eligible,
      type11NetProfitUsd: round2(type11NetProfitUsd),
      ddpNetProfitUsd: round2(ddpNetProfitUsd),
      unitProfitDiffUsd: round2(unitProfitDiffUsd),
      monthlyProfitDiffUsd: round2(monthlyProfitDiffUsd),
      recommendedPath,
      ieepaEligibleRefundUsd: ieepaRefund.eligibleRefundUsd,
      achHoldAlert: ieepaRefund.achHoldAlert,
    },
    breakdown: {
      common: {
        sellingPriceUsd: round2(sellingPriceUsd),
        purchaseCostUsd: round2(purchaseCostUsd),
        commissionRate,
        commissionUsd: round2(commissionUsd),
        otherVariableCostUsd: round2(otherVariableCostUsd),
        monthlyVolume,
      },
      type11Direct: {
        eligible: type11Eligible,
        maxInformalDeclaredValueUsd: TYPE11_MAX_COMMERCIAL_VALUE_USD,
        ineligibleReason: type11IneligibleReason,
        fallbackEntryType: type11Eligible ? null : 'Type 01 (Formal Entry)',
        declaredValueUsd: round2(type11DeclaredValueUsd),
        tariffRate: type11TariffRate,
        dutyUsd: round2(type11DutyUsd),
        shippingUsd: round2(type11ShippingUsd),
        clearanceAndMpfUsd: round2(type11ClearanceFeeUsd),
        totalCostUsd: round2(type11TotalCostUsd),
        netProfitUsd: round2(type11NetProfitUsd),
        marginPct: type11MarginPct,
      },
      warehouse9810Ddp: {
        declaredValueUsd: round2(ddpDeclaredValueUsd),
        tariffRate: ddpTariffRate,
        dutyUsd: round2(ddpDutyUsd),
        firstLegUsd: round2(ddpFirstLegUsd),
        clearanceAmortizedUsd: round2(ddpClearanceAmortizedUsd),
        localDeliveryUsd: round2(localDeliveryUsd),
        monthlyStorageUsd: round2(monthlyStorageUsd),
        fba2027DeltaUsd: round2(fba2027DeltaUsd),
        fba2027DeltaIsCustom: fbaDeltaCustom,
        fba2027HikeAppliedUsd: round2(fbaHikeAppliedUsd),
        totalCostUsd: round2(ddpTotalCostUsd),
        netProfitUsd: round2(ddpNetProfitUsd),
        marginPct: ddpMarginPct,
        profitAfter2027FbaHikeUsd: round2(ddpProfitAfter2027FbaHikeUsd),
      },
      comparison: {
        type11Eligible,
        unitProfitDiffUsd: round2(unitProfitDiffUsd),
        monthlyProfitDiffUsd: round2(monthlyProfitDiffUsd),
        unitProfitDiffAfter2027HikeUsd: round2(unitProfitDiffAfter2027HikeUsd),
        monthlyProfitDiffAfter2027HikeUsd: round2(monthlyProfitDiffAfter2027HikeUsd),
        recommendedPath,
      },
      ieepaRefund,
      fiorCtpatCompliance: {
        effectiveDate: '2027-01-05',
        rule11129ExtendedTo: '2027-05-06',
        rule11129RequiresApproval: true,
        does11129DelayFior: false,
        usFormationAndLocationRequired: true,
        usOwnershipThresholdPct: 51,
        alternativeAssetScope: 'continuously_directly_owned_unencumbered_us_real_property',
        usAssetThresholdUsd: 20_000_000,
        priorYearValueAssetPct: 100,
        requiredBrokerStatus: 'CTPAT-validated',
        notice: '本土 IOR 须位于美国且依法在美设立并满足 ≥51% 美籍/绿卡实益所有与控制；替代资产条件严格限于持续直接持有的无负担美国不动产（金额取 $20M 与上年申报进口货值 100% 孰高）；否则界定为 FIOR，须自身或委托 CTPAT-validated 美国持牌报关行清关；§111.29 延期须申请获准（最晚 2027-05-06），且不推迟 2027-01-05 FIOR 硬熔断。',
      },
    },
    steps,
    warnings,
    assumptions,
    imaKeywords,
    policyRefs: [
      { ref: '美国 CBP T86 暂停与 Type 11 / Type 01 清关规则（19 CFR §143.21）', note: '$800 免税通道暂停后，普通商业货完税价 ≤$2,500 且非受限品类可核验 Type 11 非正式报关，>$2,500 须走 Type 01 正式报关；当期税率须按 10 位 HTSUS 核实基础 MFN 税率及仍在生效的 Section 301 / Section 232 等现行关税及 MPF 费用（已于 2026-02-24 停收的 IEEPA 关税及 150 天法定上限于 2026-07-24 届满的 Section 122 临时附加税不再默认列入当期有效税栈）' },
      { ref: '美国 CBP FIOR + CTPAT 强制清关规则（91 FR 69977，2027-01-05 生效）', note: '本土 IOR 须位于美国且依法在美设立并满足 ≥51% 美籍/绿卡实益所有与控制，替代资产严格限于该进口商实体自身持续直接持有的无负担美国不动产（取 $20M 与上年申报进口货值 100% 孰高）；否则界定为 FIOR，须自身或委托 CTPAT-validated 持牌报关行清关；§111.29 报关行核验延期须申请获准（最晚 2027-05-06），不推迟 FIOR 熔断' },
      { ref: 'IEEPA / CAPE 退税适用窗口与 ACE ACH 要求（CSMS #67834313）', note: 'CBP 于美东时间 2026-02-24 00:00 停收 IEEPA 关税（完整自然日 2025-02-01 至 2026-02-23）；仅适用于 IEEPA 项下有效税行（Section301/232/122 不适用），须逐申报行核实税种、入境/出库日、实缴与清算状态，并完成 CBP ACE Portal ACH 账户绑定' },
      { ref: 'Amazon US 2027-01-15 FBA 费率调整提示', note: '2027-01-15 起 FBA 配送费默认按全盘平均敏感度假设 +$0.19/件测算，各尺寸段/价位段实际差异可通过 fba2027DeltaUsd 覆盖' },
    ],
    disclaimer: STANDARD_DISCLAIMER,
  }
}

// ── 辅助引擎：50 万 FBA 有票+无票混合采购拆单测算 ──────────────────────────
const SPLIT_MODE_LABELS = {
  '9810': '9810 跨境出口海外仓（综试区合规无票免税）',
  '9610': '9610 跨境零售直邮出口（综试区合规无票免税）',
  '1039': '1039 市场采购贸易试点集聚区无票免税',
  agent_export: '合规委托代理出口（严守 2025#17 实名穿透报送）',
}

function normalizeSplitMode(raw) {
  if (raw === undefined || raw === null) return '9810'
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw new CalcInputError('splitNoInvoiceMode 仅支持 9810、9610、1039 或 agent_export')
  }
  if (String(raw).trim() === '') return '9810'
  const key = String(raw).trim().toLowerCase()
  if (key === '9810' || key === '9610' || key === '1039') return key
  if (key === 'agent_export' || key === 'agent' || key === '代理出口') return 'agent_export'
  throw new CalcInputError('splitNoInvoiceMode 仅支持 9810、9610、1039 或 agent_export')
}

/**
 * 辅助引擎：50 万 FBA 有票专票 + 无票混合采购拆单三步法测算。
 * 对比「方案 A 硬混一票（退税被拒/全额视同内销征税）」vs「方案 B 有票 0110 退税 + 无票合规拆单」vs「方案 C 无票加点补票全走 0110」。
 */
export function fbaMixedProcurementSplit(rawParams = {}) {
  const p = ensureParamsObject(rawParams)
  const totalExportCny = reqBoundedNum(
    pickParam(p, ['totalExportCny', 'exportValueCny', 'totalShipmentCny', '总出货额']),
    'totalExportCny 必须是正数（总出货额/出口 FOB 金额，元）',
    { allowZero: false },
  )
  const invoicedPurchaseRaw = reqBoundedNum(
    pickParam(p, ['invoicedPurchaseGrossCny', 'invoicedPurchaseCny', '有票采购额']),
    'invoicedPurchaseGrossCny 必须是非负数字（有票专票采购批次金额，元）',
    { allowZero: true },
  )
  const noInvoicePurchaseCny = reqBoundedNum(
    pickParam(p, ['noInvoicePurchaseCny', 'barePurchaseCny', '无票采购额']),
    'noInvoicePurchaseCny 必须是非负数字（无票采购批次金额，元）',
    { allowZero: true },
  )
  if (invoicedPurchaseRaw + noInvoicePurchaseCny <= 0) {
    throw new CalcInputError('invoicedPurchaseGrossCny 与 noInvoicePurchaseCny 不能同时为 0')
  }

  const invoicedInclusiveRaw = optBoolean(pickParam(p, ['invoicedPurchaseInclusive', '有票采购含税']), 'invoicedPurchaseInclusive')
  const invoicedPurchaseInclusive = invoicedInclusiveRaw === null ? true : invoicedInclusiveRaw
  const invoicedVatRate = optBoundedNum(pickParam(p, ['invoicedVatRate', 'vatRate', '进项税率']), 0.13, 'invoicedVatRate')
  const invoicedRebateRate = optBoundedNum(pickParam(p, ['invoicedRebateRate', 'rebateRate', '退税率']), invoicedVatRate, 'invoicedRebateRate')
  const supplierInvoiceMarkupRate = optBoundedNum(pickParam(p, ['supplierInvoiceMarkupRate', 'supplierMarkupRate', '加点开票率']), 0.08, 'supplierInvoiceMarkupRate')
  const noInvoiceVatRate = optBoundedNum(pickParam(p, ['noInvoiceVatRate', '无票补票税率']), invoicedVatRate, 'noInvoiceVatRate')
  const noInvoiceRebateRate = optBoundedNum(pickParam(p, ['noInvoiceRebateRate', '无票补票退税率']), invoicedRebateRate, 'noInvoiceRebateRate')

  const mixedSingleDeclarationCostCny = optBoundedNum(pickParam(p, ['mixedSingleDeclarationCostCny', '混装报关成本']), 1500, 'mixedSingleDeclarationCostCny')
  const split0110CostCny = optBoundedNum(pickParam(p, ['split0110CostCny', 'generalTrade0110CostCny', '0110拆单成本']), 1500, 'split0110CostCny')
  const splitNoInvoiceMode = normalizeSplitMode(pickParam(p, ['splitNoInvoiceMode', 'noInvoiceMode', '无票拆单模式']))
  const splitNoInvoiceCostCny = optBoundedNum(pickParam(p, ['splitNoInvoiceCostCny', 'noInvoiceSplitCostCny', '无票拆单成本']), 2500, 'splitNoInvoiceCostCny')
  const deemedDomesticVatRate = optBoundedNum(pickParam(p, ['deemedDomesticVatRate', '视同内销税率']), invoicedVatRate, 'deemedDomesticVatRate')
  const surtaxRate = optBoundedNum(pickParam(p, ['surtaxRate', '附加税率']), 0.12, 'surtaxRate')
  const defaultCitRate = splitNoInvoiceMode === '9810' || splitNoInvoiceMode === '9610' ? 0.002 : 0
  const noInvoiceAssessedCitRate = optBoundedNum(pickParam(p, ['noInvoiceAssessedCitRate', '无票核定所得税率']), defaultCitRate, 'noInvoiceAssessedCitRate')

  for (const [name, v] of Object.entries({
    invoicedVatRate,
    invoicedRebateRate,
    supplierInvoiceMarkupRate,
    noInvoiceVatRate,
    noInvoiceRebateRate,
    deemedDomesticVatRate,
    noInvoiceAssessedCitRate,
  })) {
    checkRate(v, name, { max: 1, inclusiveMax: true })
  }
  checkRate(surtaxRate, 'surtaxRate', { max: 0.5, inclusiveMax: true, hint: '0~0.5 之间的小数（如 12% 传 0.12）' })

  // 有票专票批次拆分
  const invoicedExclTaxCny = invoicedPurchaseInclusive ? invoicedPurchaseRaw / (1 + invoicedVatRate) : invoicedPurchaseRaw
  const invoicedInputVatCny = invoicedExclTaxCny * invoicedVatRate
  const invoicedGrossCny = invoicedExclTaxCny + invoicedInputVatCny
  const effInvoicedRebate = Math.min(invoicedVatRate, invoicedRebateRate)
  const invoicedVatRefundCny = invoicedExclTaxCny * effInvoicedRebate
  const invoicedNonRefundableVatCny = invoicedExclTaxCny * (invoicedVatRate - effInvoicedRebate)
  const invoicedNetPurchaseCostCny = invoicedGrossCny - invoicedVatRefundCny

  // 方案 A：硬混一票出口（风险对照：A1 全额视同内销征税 / A2 退税被拒免税不退）
  // 严格分列「当期应交增值税」「期末留抵进项税额（资产/待抵扣税额，不直接计为经营亏损）」与「税前损益」
  const deemedExclSalesCny = totalExportCny / (1 + deemedDomesticVatRate)
  const deemedOutputVatCny = deemedExclSalesCny * deemedDomesticVatRate
  const deemedVatNetBalanceCny = deemedOutputVatCny - invoicedInputVatCny
  const mixedDeemedVatPayableCny = Math.max(0, deemedVatNetBalanceCny)
  const mixedDeemedEndingInputVatCreditCny = Math.max(0, -deemedVatNetBalanceCny)
  const mixedSurtaxCny = mixedDeemedVatPayableCny * surtaxRate
  // 税前损益 = 不含税视同内销收入 − 有票不含税采购成本 − 无票采购成本 − 报关费 − 城建及附加（期末留抵进项不误计亏损！）
  const mixedDeemedNetProfitCny =
    deemedExclSalesCny - invoicedExclTaxCny - noInvoicePurchaseCny - mixedSingleDeclarationCostCny - mixedSurtaxCny
  // 当期现金流净额对照（含期末留抵进项短期占用的现金流）
  const mixedDeemedCashFlowCny =
    totalExportCny - invoicedGrossCny - noInvoicePurchaseCny - mixedSingleDeclarationCostCny - mixedDeemedVatPayableCny - mixedSurtaxCny
  const mixedNoRefundNetProfitCny = totalExportCny - invoicedGrossCny - noInvoicePurchaseCny - mixedSingleDeclarationCostCny

  // 方案 B：合规拆单（有票走 0110 退税 + 无票独立走 9810/9610/1039/合规代理）
  const effSplit0110Cost = invoicedGrossCny > 0 ? split0110CostCny : 0
  const effSplitNoInvCost = noInvoicePurchaseCny > 0 ? splitNoInvoiceCostCny : 0
  const splitDeclarationTotalCostCny = effSplit0110Cost + effSplitNoInvCost
  const extraSplitCostCny = splitDeclarationTotalCostCny - mixedSingleDeclarationCostCny
  const noInvoiceProcurementShare = noInvoicePurchaseCny / (invoicedGrossCny + noInvoicePurchaseCny)
  const estimatedNoInvoiceExportCny = totalExportCny * noInvoiceProcurementShare
  const estimatedNoInvoiceCitRefCny = estimatedNoInvoiceExportCny * noInvoiceAssessedCitRate
  const splitNetProfitCny = totalExportCny - invoicedNetPurchaseCostCny - noInvoicePurchaseCny - splitDeclarationTotalCostCny

  // 方案 C：有票正常退税 + 无票批次让供应商加点开专票一并走 0110 退税
  const effNoInvRebate = Math.min(noInvoiceVatRate, noInvoiceRebateRate)
  const noInvoiceBreakevenMarkup = effNoInvRebate / (1 + noInvoiceVatRate - effNoInvRebate)
  const noInvInvoicedGrossCny = noInvoicePurchaseCny * (1 + supplierInvoiceMarkupRate)
  const noInvInvoicedExclTaxCny = noInvInvoicedGrossCny / (1 + noInvoiceVatRate)
  const noInvVatRefundCny = noInvInvoicedExclTaxCny * effNoInvRebate
  const noInvNetCashCostCny = noInvInvoicedGrossCny - noInvVatRefundCny
  const allInvoiced0110NetProfitCny = totalExportCny - invoicedNetPurchaseCostCny - noInvNetCashCostCny - split0110CostCny

  // 收益差额对比
  const gainVsMixedDeemedVatCny = splitNetProfitCny - mixedDeemedNetProfitCny
  const gainVsMixedNoRefundCny = splitNetProfitCny - mixedNoRefundNetProfitCny
  const deltaAllInvoicedVsSplitCny = allInvoiced0110NetProfitCny - splitNetProfitCny
  const recommendedPlan =
    noInvoicePurchaseCny > 0 && deltaAllInvoicedVsSplitCny > 0.01
      ? 'all_invoiced_0110'
      : 'split_0110_and_no_invoice'

  const steps = [
    `有票专票批次：含税采购 ${round2(invoicedGrossCny)} 元（不含税 ${round2(invoicedExclTaxCny)} 元 + 进项税 ${round2(invoicedInputVatCny)} 元），适用退税率 ${(effInvoicedRebate * 100).toFixed(2)}% → 应退增值税 ${round2(invoicedVatRefundCny)} 元${invoicedNonRefundableVatCny > 0 ? `，征退差转成本 ${round2(invoicedNonRefundableVatCny)} 元` : ''}`,
    `【反面 · 方案 A1 硬混一票被拒·全额视同内销】不含税视同内销收入 ${round2(deemedExclSalesCny)} 元，销项税 ${round2(deemedOutputVatCny)} − 已有进项 ${round2(invoicedInputVatCny)} → 当期应交增值税 ${round2(mixedDeemedVatPayableCny)} 元、期末留抵进项税额 ${round2(mixedDeemedEndingInputVatCreditCny)} 元（不直接计为经营亏损）、附加税 ${round2(mixedSurtaxCny)} 元 → 税前损益 ${round2(mixedDeemedNetProfitCny)} 元${mixedDeemedEndingInputVatCreditCny > 0 ? `（含留抵资金占用的当期现金流净额 ${round2(mixedDeemedCashFlowCny)} 元）` : ''}（若仅退税被拒免税不退，净收益 ${round2(mixedNoRefundNetProfitCny)} 元）`,
    `【推荐 · 方案 B 有票 0110 退税 + 无票合规拆单（${splitNoInvoiceMode}）】有票实退 ${round2(invoicedVatRefundCny)} 元，无票批次 ${round2(noInvoicePurchaseCny)} 元分单报关（拆单总费用 ${round2(splitDeclarationTotalCostCny)} 元）→ 税前净收益 ${round2(splitNetProfitCny)} 元（较硬混视同内销多保住 ${round2(gainVsMixedDeemedVatCny)} 元，较退税被拒多赚 ${round2(gainVsMixedNoRefundCny)} 元）`,
    `【进阶 · 方案 C 无票加点 ${(supplierInvoiceMarkupRate * 100).toFixed(2)}% 补票全走 0110】增值税临界加点率 g* = ${(noInvoiceBreakevenMarkup * 100).toFixed(2)}%；补票后无票批次净采购成本 ${round2(noInvNetCashCostCny)} 元（应退 ${round2(noInvVatRefundCny)} 元）且省去无票拆单费 ${round2(effSplitNoInvCost)} 元 → 全量 0110 净收益 ${round2(allInvoiced0110NetProfitCny)} 元（较方案 B ${deltaAllInvoicedVsSplitCny >= 0 ? `再多赚 ${round2(deltaAllInvoicedVsSplitCny)}` : `少赚 ${round2(-deltaAllInvoicedVsSplitCny)}`} 元）`,
  ]

  const warnings = [
    '【三步法核心操作边界·严禁混报配票】有票 0110 退税货物与无票 9810/9610/1039 货物必须严格分单、分箱/分柜（独立提单、独立报关单、独立收汇核销路径），绝不可混入同一张 0110 出口报关单，否则易触发单证不符退税被拒甚至涉嫌骗税风险！',
    `【无票拆单合规门槛】当前无票拆单模式为「${SPLIT_MODE_LABELS[splitNoInvoiceMode]}」。综试区无票免税须经当地线上综合服务平台登记并经综试区海关报关（财税〔2018〕103 号）；委托代理出口须严守《国家税务总局公告2025年第17号》实名穿透报送，严禁“买单出口”或套用他人抬头！`,
    '【9810 预退税核算期与查账所得税扣除边界】若 9810 适用 HWC-YT 预退税，须在次年 4 月实际增值税申报期（上界 4 月 30 日）前完成销售核算，逾期未售须全额冲减缴回；非核定查账征收主体须按 2018 年第 28 号公告核查无票采购成本的税前扣除凭证风险。',
  ]
  if (mixedDeemedEndingInputVatCreditCny > 0) {
    warnings.push(
      `【期末留抵进项税额单列提示】方案 A1 视同内销销项税 ${round2(deemedOutputVatCny)} 元小于已有进项税 ${round2(invoicedInputVatCny)} 元，形成期末留抵进项税额 ${round2(mixedDeemedEndingInputVatCreditCny)} 元（当期应交增值税 0 元）；该留抵税额属待抵扣资产，不直接计入经营亏损（税前损益 ${round2(mixedDeemedNetProfitCny)} 元），但短期仍占用等额现金流（当期现金流净额 ${round2(mixedDeemedCashFlowCny)} 元）。`,
    )
  }
  if (extraSplitCostCny > invoicedVatRefundCny) {
    warnings.push(`【拆单成本倒挂提示】当前拆单增量费用 ${round2(extraSplitCostCny)} 元高于有票批次可退增值税 ${round2(invoicedVatRefundCny)} 元，建议核对货量合并周期或评估全量加点开票方案。`)
  }

  const assumptions = [
    `有票采购额按 ${invoicedPurchaseInclusive ? '含税专票总额' : '专票不含税金额'} 口径价税分离，退税率按 min(进项税率, 退税率) 孰低执行。`,
    `方案 A1 假设硬混报关导致出口退（免）税资格被否并适用 2026 年第 11 号公告第七条全额视同内销征税（增值税率 ${(deemedDomesticVatRate * 100).toFixed(1)}% + 城建及附加 ${(surtaxRate * 100).toFixed(1)}%）；若销项小于进项，差额单列为期末留抵进项税额，不直接计为经营亏损。`,
    `上述净收益为企业所得税前损益口径；无票拆单批次按采购占比估算核定所得税参考额 ${round2(estimatedNoInvoiceCitRefCny)} 元（按 ${(noInvoiceAssessedCitRate * 100).toFixed(2)}% 试算，须以主管税务机关事前鉴定为准）。`,
  ]
  const imaKeywords = ['拆单', '无票免税', '出口退税', '9810', '0110', '代理出口']
  const bestLabel = recommendedPlan === 'all_invoiced_0110' ? '无票加点补票全走 0110' : `有票 0110 退税 + 无票走 ${splitNoInvoiceMode} 合规拆单`
  const summaryLine = `硬混视同内销税前损益 ${round2(mixedDeemedNetProfitCny)} 元${mixedDeemedEndingInputVatCreditCny > 0 ? `（另列期末留抵 ${round2(mixedDeemedEndingInputVatCreditCny)} 元）` : ''} vs 合规拆单 ${round2(splitNetProfitCny)} 元（多保住 ${round2(gainVsMixedDeemedVatCny)} 元）｜加点补票全 0110 为 ${round2(allInvoiced0110NetProfitCny)} 元｜推荐：${bestLabel}`

  return {
    scenario: '50 万 FBA 有票+无票混合采购拆单测算',
    scenarioCode: 'fba_mixed_procurement_split',
    currency: 'CNY',
    totalExportCny: round2(totalExportCny),
    invoicedPurchaseGrossCny: round2(invoicedGrossCny),
    invoicedPurchaseExclTaxCny: round2(invoicedExclTaxCny),
    invoicedInputVatCny: round2(invoicedInputVatCny),
    invoicedVatRefundCny: round2(invoicedVatRefundCny),
    noInvoicePurchaseCny: round2(noInvoicePurchaseCny),
    splitNoInvoiceMode,
    mixedDeemedVatPayableCny: round2(mixedDeemedVatPayableCny),
    mixedDeemedEndingInputVatCreditCny: round2(mixedDeemedEndingInputVatCreditCny),
    mixedSurtaxCny: round2(mixedSurtaxCny),
    mixedDeemedNetProfitCny: round2(mixedDeemedNetProfitCny),
    mixedDeemedCashFlowCny: round2(mixedDeemedCashFlowCny),
    mixedNoRefundNetProfitCny: round2(mixedNoRefundNetProfitCny),
    splitNetProfitCny: round2(splitNetProfitCny),
    allInvoiced0110NetProfitCny: round2(allInvoiced0110NetProfitCny),
    gainVsMixedDeemedVatCny: round2(gainVsMixedDeemedVatCny),
    gainVsMixedNoRefundCny: round2(gainVsMixedNoRefundCny),
    deltaAllInvoicedVsSplitCny: round2(deltaAllInvoicedVsSplitCny),
    noInvoiceBreakevenMarkupPct: round2(noInvoiceBreakevenMarkup * 100),
    recommendedPlan,
    summaryLine,
    summary: {
      headline: summaryLine,
      mixedDeemedVatPayableCny: round2(mixedDeemedVatPayableCny),
      mixedDeemedEndingInputVatCreditCny: round2(mixedDeemedEndingInputVatCreditCny),
      mixedDeemedNetProfitCny: round2(mixedDeemedNetProfitCny),
      mixedDeemedCashFlowCny: round2(mixedDeemedCashFlowCny),
      splitNetProfitCny: round2(splitNetProfitCny),
      allInvoiced0110NetProfitCny: round2(allInvoiced0110NetProfitCny),
      gainVsMixedDeemedVatCny: round2(gainVsMixedDeemedVatCny),
      gainVsMixedNoRefundCny: round2(gainVsMixedNoRefundCny),
      recommendedPlan,
    },
    breakdown: {
      invoicedBatch: {
        grossPurchaseCny: round2(invoicedGrossCny),
        exclTaxCny: round2(invoicedExclTaxCny),
        inputVatCny: round2(invoicedInputVatCny),
        vatRate: invoicedVatRate,
        effectiveRebateRate: effInvoicedRebate,
        vatRefundCny: round2(invoicedVatRefundCny),
        nonRefundableVatToCostCny: round2(invoicedNonRefundableVatCny),
        netPurchaseCostCny: round2(invoicedNetPurchaseCostCny),
      },
      noInvoiceBatch: {
        barePurchaseCny: round2(noInvoicePurchaseCny),
        splitMode: splitNoInvoiceMode,
        splitModeLabel: SPLIT_MODE_LABELS[splitNoInvoiceMode],
        supplierInvoiceMarkupRate,
        breakevenMarkupPct: round2(noInvoiceBreakevenMarkup * 100),
        ifInvoicedGrossCny: round2(noInvInvoicedGrossCny),
        ifInvoicedVatRefundCny: round2(noInvVatRefundCny),
        ifInvoicedNetCashCostCny: round2(noInvNetCashCostCny),
        estimatedExportShareCny: round2(estimatedNoInvoiceExportCny),
        estimatedAssessedCitRefCny: round2(estimatedNoInvoiceCitRefCny),
      },
      planComparison: {
        mixedRiskDeemedDomestic: {
          deemedExclSalesCny: round2(deemedExclSalesCny),
          deemedOutputVatCny: round2(deemedOutputVatCny),
          vatPayableCny: round2(mixedDeemedVatPayableCny),
          endingInputVatCreditCny: round2(mixedDeemedEndingInputVatCreditCny),
          surtaxCny: round2(mixedSurtaxCny),
          declarationCostCny: round2(mixedSingleDeclarationCostCny),
          netProfitCny: round2(mixedDeemedNetProfitCny),
          cashFlowCny: round2(mixedDeemedCashFlowCny),
        },
        mixedRiskNoRefundOnly: {
          vatRefundCny: 0,
          declarationCostCny: round2(mixedSingleDeclarationCostCny),
          netProfitCny: round2(mixedNoRefundNetProfitCny),
        },
        compliantSplit: {
          split0110CostCny: round2(effSplit0110Cost),
          splitNoInvoiceCostCny: round2(effSplitNoInvCost),
          extraSplitCostCny: round2(extraSplitCostCny),
          vatRefundCny: round2(invoicedVatRefundCny),
          netProfitCny: round2(splitNetProfitCny),
          gainVsMixedDeemedVatCny: round2(gainVsMixedDeemedVatCny),
          gainVsMixedNoRefundCny: round2(gainVsMixedNoRefundCny),
        },
        allInvoiced0110: {
          declarationCostCny: round2(split0110CostCny),
          totalVatRefundCny: round2(invoicedVatRefundCny + noInvVatRefundCny),
          netProfitCny: round2(allInvoiced0110NetProfitCny),
          deltaVsSplitCny: round2(deltaAllInvoicedVsSplitCny),
        },
        recommendedPlan,
      },
    },
    steps,
    warnings,
    assumptions,
    imaKeywords,
    policyRefs: [
      { ref: '财政部 税务总局公告2026年第11号', note: '出口业务免退税计算及第七条不合规出口适用视同内销征税规则' },
      { ref: '国家税务总局公告2026年第5号', note: '出口退（免）税单证备案、分单报关与收汇核销管理要求' },
      { ref: '财税〔2018〕103号 / 国家税务总局公告2019年第36号', note: '综试区零售出口无票免税及经事前鉴定的 4% 核定征收口径' },
      { ref: '国家税务总局公告2025年第17号', note: '代理出口企业所得税预缴与真实委托方信息实名穿透报送要求（严禁买单出口）' },
    ],
    disclaimer: STANDARD_DISCLAIMER,
  }
}

// ── 统一分发与元数据导出（供 Phase 2 lib/calc.js / index.js / client.js 零重复挂载）──
export const CROSSBORDER_SCENARIOS = Object.freeze([
  'eu_low_value_parcel',
  'us_t86_vs_9810_ddp',
  'fba_mixed_procurement_split',
])

export function calculateCrossborder(scenario, params) {
  switch (scenario) {
    case 'eu_low_value_parcel':
      return euLowValueParcel(params)
    case 'us_t86_vs_9810_ddp':
      return usT86Vs9810Ddp(params)
    case 'fba_mixed_procurement_split':
      return fbaMixedProcurementSplit(params)
    default:
      throw new CalcInputError(`未知跨境算税 scenario：${scenario}。支持：${CROSSBORDER_SCENARIOS.join(' | ')}`)
  }
}

export const CROSSBORDER_CALC_SPECS = Object.freeze([
  {
    code: 'eu_low_value_parcel',
    group: 'crossborder',
    isNew: true,
    currency: 'EUR',
    zh: '欧盟低值包裹 €3+€2 与 PID 反推售价',
    en: 'EU Low-Value Parcel (€3+€2 & PID Pricing)',
    desc: '按欧委会 2026-10-05 指引第 3 节测算欧盟 ≤€150 低值包裹 €3/项临时关税 + €2/项退货不退处理费（均按包裹内申报的不同商品项/税则项计收，IOSS 不代收），支持 PID 含税抽佣向上取分反推售价（含 €150 复核阻断）及同箱混装/按项拆包/单税则 SKU 组合/欧盟海外仓对比。',
    enDesc: 'Models EU <=EUR 150 parcel EUR 3 per-item temporary duty + EUR 2 per-item non-refundable handling fee (EC 2026-10-05 guidance s.3, excluded from IOSS), cent-ceiled PID reverse pricing with EUR 150 re-check, and EU warehouse breakeven with return recovery spread.',
    fields: [
      { key: 'sellingPriceEur', label: '商品含税零售价（EUR）', enLabel: 'VAT-Inclusive Selling Price (EUR)', def: '35.7', required: true },
      { key: 'vatRate', label: '目标国 VAT 税率（如德 0.19 / 法 0.20）', enLabel: 'EU VAT Rate (e.g. 0.19)', def: '0.19' },
      { key: 'hsLineCount', label: '包裹内不同申报项/税则项数（1~20）', enLabel: 'Distinct Declared / HS Items (1-20)', def: '2' },
      { key: 'purchaseCostEur', label: '采购成本（EUR）', enLabel: 'Purchase Cost (EUR)', def: '7' },
      { key: 'directShippingEur', label: '国际直邮运费（EUR）', enLabel: 'Direct Parcel Shipping (EUR)', def: '4' },
      { key: 'commissionRate', label: '平台抽佣率（如 0.15）', enLabel: 'Platform Commission Rate', def: '0.15' },
      { key: 'returnRate', label: '退货率（如 0.08，体现 €2×项数 退货不退）', enLabel: 'Return Rate (e.g. 0.08)', def: '0.08' },
      { key: 'targetMarginRate', label: '目标净利率（可选，用于反推最低含税售价）', enLabel: 'Target Net Margin Rate (optional)', def: '0.15' },
    ],
    advancedFields: [
      { key: 'commissionOnVatInclusive', label: '平台按含税零售价基数抽佣（PID）', enLabel: 'Commission on VAT-Inclusive Price', type: 'bool', def: true },
      { key: 'marginBasis', label: '净利率与反推售价口径', enLabel: 'Margin Basis', type: 'select', def: 'vat_inclusive', options: [{ value: 'vat_inclusive', label: '含税有效销售额口径' }, { value: 'ex_vat', label: '不含税有效净营收口径' }] },
      { key: 'otherVariableCostEur', label: '其他变动成本/包材广告（EUR）', enLabel: 'Other Variable Cost (EUR)', def: '0' },
      { key: 'separateShippingInPriceEur', label: '含税总价中发票单列的买家运费（EUR，剥离后核验 €150 内在价值）', enLabel: 'Separately Invoiced Shipping in Price (EUR)', def: '0' },
      { key: 'splitParcelShippingEur', label: '同购物篮按项拆包每小包直邮运费（EUR，默认同直邮运费）', enLabel: 'Split Parcel Shipping Per Parcel (EUR)', def: '' },
      { key: 'returnGoodsRecoveryRate', label: '直邮退货商品残值回收率（0~1）', enLabel: 'Direct Return Goods Recovery Rate', def: '0' },
      { key: 'euWarehouseReturnRecoveryRate', label: '欧盟海外仓退货商品回收率（0~1，默认同直邮）', enLabel: 'EU Warehouse Return Recovery Rate', def: '' },
      { key: 'euWarehouseFirstLegEur', label: '欧盟海外仓单件头程运费（EUR，可选）', enLabel: 'EU Warehouse First-Leg Freight (EUR)', def: '' },
      { key: 'euWarehouseDutyRate', label: '欧盟海外仓一般贸易关税率（默认 0.04）', enLabel: 'EU Warehouse MFN Duty Rate', def: '0.04' },
      { key: 'euWarehouseLocalDeliveryEur', label: '欧盟海外仓本地尾程派送费（EUR，可选）', enLabel: 'EU Warehouse Local Delivery (EUR)', def: '' },
      { key: 'euWarehouseStorageEur', label: '欧盟海外仓月均仓储费（EUR）', enLabel: 'EU Warehouse Monthly Storage (EUR)', def: '0' },
      { key: 'monthlyOrders', label: '月订单量（用于放大月度利差，可选）', enLabel: 'Monthly Orders (optional)', def: '1000' },
    ],
    exampleParams: {
      sellingPriceEur: 35.7,
      vatRate: 0.19,
      hsLineCount: 2,
      purchaseCostEur: 7,
      directShippingEur: 4,
      commissionRate: 0.15,
      commissionOnVatInclusive: true,
      returnRate: 0.08,
      targetMarginRate: 0.15,
      euWarehouseFirstLegEur: 1.5,
      euWarehouseDutyRate: 0.04,
      euWarehouseLocalDeliveryEur: 3.8,
      euWarehouseStorageEur: 0.2,
      monthlyOrders: 1000,
    },
    imaKeywords: ['欧盟2欧', '150欧元', 'IOSS', 'PID', 'VAT'],
  },
  {
    code: 'us_t86_vs_9810_ddp',
    group: 'crossborder',
    isNew: true,
    currency: 'USD',
    zh: '美线 Type 11 vs 9810 DDP 与 IEEPA/FIOR',
    en: 'US Type 11 vs 9810 DDP & IEEPA/FIOR',
    desc: '先判 Type 11 $2,500 商业非正式进口资格再对比 9810 海外仓 DDP 单件毛利（含 2027-01-15 Amazon US FBA 全盘平均涨价 $0.19 可覆盖假设），严格校验 IEEPA/CAPE 退税（美东 2026-02-24 00:00 停收 CSMS #67834313，禁止单端日期互填）与 ACE ACH Hold，并附 2027-01-05 FIOR (91 FR 69977)+CTPAT-validated 红线。',
    enDesc: 'Gates Type 11 commercial informal entry at $2,500 before comparing against 9810 DDP (customizable 2027-01-15 FBA delta, default $0.19 average assumption), enforces strict IEEPA/CAPE refund validation (cutoff 2026-02-24 00:00 EST CSMS #67834313, no single-end date fabrication), ACE ACH Hold alerts, and 2027-01-05 FIOR (91 FR 69977) + CTPAT-validated rules.',
    fields: [
      { key: 'sellingPriceUsd', label: '商品售价（USD）', enLabel: 'Selling Price (USD)', def: '39.99', required: true },
      { key: 'purchaseCostUsd', label: '采购成本（USD）', enLabel: 'Purchase Cost (USD)', def: '8', required: true },
      { key: 'declaredValueUsd', label: '申报完税价 / FOB 价（USD，Type 11 商业货上限 $2,500）', enLabel: 'Declared Customs / FOB Value (USD)', def: '10' },
      { key: 'tariffRate', label: '适用总关税率（如 0.45 = 45%）', enLabel: 'Total Tariff Rate (decimal)', def: '0.45' },
      { key: 'type11ShippingUsd', label: 'Type 11 直邮国际运费（USD）', enLabel: 'Type 11 Direct Shipping (USD)', def: '9.5' },
      { key: 'type11ClearanceFeeUsd', label: 'Type 11 单票清关/MPF 杂费（USD）', enLabel: 'Type 11 Clearance & MPF Fee (USD)', def: '3.5' },
      { key: 'ddpFirstLegUsd', label: '9810 头程海运分摊（USD）', enLabel: '9810 Ocean First-Leg (USD)', def: '2.2' },
      { key: 'localDeliveryUsd', label: '海外仓/FBA 本土派送费（USD）', enLabel: 'US Local / FBA Delivery (USD)', def: '5.4' },
      { key: 'monthlyStorageUsd', label: '海外仓/FBA 月均仓储费（USD）', enLabel: 'Monthly Storage Fee (USD)', def: '0.35' },
      { key: 'commissionRate', label: '平台佣金率（默认 0.15）', enLabel: 'Platform Commission Rate', def: '0.15' },
    ],
    advancedFields: [
      { key: 'monthlyVolume', label: '月销量（件，默认 1000）', enLabel: 'Monthly Volume (units)', def: '2000' },
      { key: 'ddpClearanceAmortizedUsd', label: '9810 清关/MPF/HMF 分摊（USD）', enLabel: '9810 Clearance Amortized (USD)', def: '0.3' },
      { key: 'apply2027FbaHike', label: '直接计入 2027-01-15 FBA 敏感度涨价', enLabel: 'Include 2027-01-15 FBA Delta', type: 'bool', def: false },
      { key: 'fba2027DeltaUsd', label: '2027 FBA 单件涨价幅度（默认 $0.19 全盘平均假设，可覆盖）', enLabel: '2027 FBA Unit Fee Delta (USD)', def: '0.19' },
      { key: 'ieepaPaidUsd', label: '已缴拟申报 CAPE 退税金额（USD，可选）', enLabel: 'Paid Tariff for CAPE Estimate (USD)', def: '' },
      { key: 'tariffProgram', label: '关税项目（须显式指定，仅 IEEPA 适用 CAPE）', enLabel: 'Tariff Program (explicit)', type: 'select', def: '', options: [{ value: '', label: '请选择实缴税种（未选不放行）' }, { value: 'IEEPA', label: 'IEEPA（适用窗口内 CAPE 退税）' }, { value: 'Section301', label: 'Section 301（不适用 CAPE）' }, { value: 'Section232', label: 'Section 232（不适用 CAPE）' }, { value: 'Section122', label: 'Section 122（不适用 CAPE）' }] },
      { key: 'entryDate', label: '单票独立入境/缴税日（YYYY-MM-DD，可选）', enLabel: 'Single Entry Date (optional)', type: 'date', def: '' },
      { key: 'entryPeriodStart', label: '缴税开始日期（YYYY-MM-DD，须与结束日配对）', enLabel: 'Entry Period Start', type: 'date', def: '' },
      { key: 'entryPeriodEnd', label: '缴税结束日期（YYYY-MM-DD，须与开始日配对）', enLabel: 'Entry Period End', type: 'date', def: '' },
      { key: 'aceAchBound', label: '已在 CBP ACE Portal 绑定 ACH 账户', enLabel: 'ACE ACH Account Bound', type: 'confirmation', def: '' },
    ],
    exampleParams: {
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
      ieepaPaidUsd: 18500,
      tariffProgram: 'IEEPA',
      entryPeriodStart: '2025-03-01',
      entryPeriodEnd: '2026-02-20',
      aceAchBound: true,
    },
    imaKeywords: ['FIOR', 'CTPAT', 'IEEPA', '美国关税', '境外进口商', 'T86', '9810'],
  },
  {
    code: 'fba_mixed_procurement_split',
    group: 'export',
    isNew: true,
    currency: 'CNY',
    zh: '50 万 FBA 有票+无票混合采购拆单',
    en: 'FBA Mixed Procurement Split (0110 + 9810/9610)',
    desc: '测算有票专票与无票采购混合发 FBA 时「硬混一票退税被拒/全额视同内销（分列当期应交增值税、期末留抵进项与税前损益）」vs「有票 0110 退税 + 无票合规拆单」vs「加点补票全走 0110」净收益对比与操作边界。',
    enDesc: 'Compares mixed single-entry deemed-domestic-VAT risk (separating VAT payable, ending input VAT credit, and pre-tax P&L) vs compliant split (0110 rebate + 9810/9610/1039/agency) vs supplier-markup full-invoiced 0110.',
    fields: [
      { key: 'totalExportCny', label: '总出货额 / 出口 FOB 金额（元）', enLabel: 'Total Export Value (CNY)', def: '500000', required: true },
      { key: 'invoicedPurchaseGrossCny', label: '有票专票采购批次含税金额（元）', enLabel: 'Invoiced Purchase Gross (CNY)', def: '339000', required: true },
      { key: 'noInvoicePurchaseCny', label: '无票采购批次裸采金额（元）', enLabel: 'Non-Invoiced Bare Purchase (CNY)', def: '100000', required: true },
      { key: 'invoicedVatRate', label: '有票进项专票税率（默认 0.13）', enLabel: 'Input VAT Rate', def: '0.13' },
      { key: 'invoicedRebateRate', label: '有票商品出口退税率（默认 0.13）', enLabel: 'Export Rebate Rate', def: '0.13' },
      { key: 'supplierInvoiceMarkupRate', label: '无票供应商加点开专票报价（如 0.08）', enLabel: 'Supplier Invoice Markup Rate', def: '0.08' },
      { key: 'splitNoInvoiceMode', label: '无票批次合规拆单模式', enLabel: 'Non-Invoiced Split Mode', type: 'select', def: '9810', options: [{ value: '9810', label: '9810 海外仓无票免税' }, { value: '9610', label: '9610 直邮无票免税' }, { value: '1039', label: '1039 市场采购无票免税' }, { value: 'agent_export', label: '合规委托代理出口' }] },
    ],
    advancedFields: [
      { key: 'invoicedPurchaseInclusive', label: '有票采购金额已含进项增值税', enLabel: 'Invoiced Purchase VAT-Inclusive', type: 'bool', def: true },
      { key: 'mixedSingleDeclarationCostCny', label: '硬混一票报关杂费（元）', enLabel: 'Mixed Single Declaration Cost (CNY)', def: '1500' },
      { key: 'split0110CostCny', label: '0110 一般贸易独立报关费（元）', enLabel: '0110 Declaration Cost (CNY)', def: '1500' },
      { key: 'splitNoInvoiceCostCny', label: '无票拆单/代理出口增量费用（元）', enLabel: 'Non-Invoiced Split Cost (CNY)', def: '2500' },
      { key: 'surtaxRate', label: '城建税及附加比例（默认 0.12）', enLabel: 'Surtax Rate on VAT', def: '0.12' },
    ],
    exampleParams: {
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
    },
    imaKeywords: ['拆单', '无票免税', '出口退税', '9810', '0110', '代理出口'],
  },
])

// dsh-fintax 扩展确定性算税引擎（纯 ESM，零外部依赖）：
//   8. cbec_return_duty_exempt    — 2026年第16号公告跨境电商出口退运免税资格与省税测算
//   9. export_rebate_manufacturer — 生产企业出口货物“免、抵、退”税五步法测算
//  10. vat_taxpayer_threshold     — 500万一般纳税人强制认定临界 & 进项抵扣盈亏平衡拐点测算
//  11. export_rebate_cancel_impact — 退税取消/下调（2026#2/#29/#11）与电池消费税（2026#20）双税冲击测算

import { CalcInputError, optBoolean, optIsoDate, optNum, reqNum, round2 } from './calc_shared.js'

const ELIGIBLE_RETURN_CODES = new Set(['9610', '9710', '9810', '1210'])
const RETURN_DECLARATION_START = '2026-01-01'
const RETURN_DECLARATION_END = '2027-12-31'

function addCalendarMonths(date, months) {
  const end = new Date(date)
  end.setUTCMonth(date.getUTCMonth() + months + 1, 0)
  end.setUTCDate(Math.min(date.getUTCDate(), end.getUTCDate()))
  return end
}

/** 场景 8：跨境电商出口退运免税资格核验与进口环节省税测算（2026年第16号公告）。 */
export function cbecReturnDutyExempt(p = {}) {
  const customsCode = String(p?.customsCode ?? '').trim()
  const exportValueCny = reqNum(p?.exportValueCny, 'exportValueCny 必须是正数（退运商品原出口货值，元）', { allowZero: false })
  const tariffRate = optNum(p?.tariffRate, 0.10, 'tariffRate')
  const importVatRate = optNum(p?.importVatRate, 0.13, 'importVatRate')
  const ctr = optNum(p?.consumptionTaxRate, 0, 'consumptionTaxRate')
  const refundedExportTax = optNum(p?.refundedExportTax, null, 'refundedExportTax')
  const inOriginalCondition = optBoolean(p?.inOriginalCondition, 'inOriginalCondition')
  const isFood = optBoolean(p?.isFood, 'isFood')
  const hasTaxCertificate = optBoolean(p?.hasTaxCertificate, 'hasTaxCertificate')
  const returnReason = String(p?.returnReason ?? '').trim().toLowerCase()
  const isZoneExport = customsCode === '1210'

  if (tariffRate > 2 || importVatRate > 1 || ctr >= 1) {
    throw new CalcInputError('税率参数应为小数（如关税 10% 传 0.10、增值税 13% 传 0.13、消费税率须小于 1）')
  }

  const reasons = []
  const pending = []
  if (!customsCode) pending.push('请确认出口海关监管代码。')
  else if (!ELIGIBLE_RETURN_CODES.has(customsCode)) reasons.push(`海关监管代码 ${customsCode} 不适用第 16 号公告，专项范围为 9610、9710、9810、1210。`)

  const exportDate = optIsoDate(p?.exportDate, 'exportDate')
  const returnDate = optIsoDate(p?.returnDate, 'returnDate')
  const exportDay = exportDate?.toISOString().slice(0, 10)
  if (!exportDay) pending.push('请提供原出口申报日期。')
  else if (exportDay < RETURN_DECLARATION_START || exportDay > RETURN_DECLARATION_END) {
    reasons.push(`出口申报日期 ${exportDay} 超出第 16 号公告适用期间（${RETURN_DECLARATION_START} 至 ${RETURN_DECLARATION_END}）。`)
  }
  if (!returnDate) pending.push('请提供商品退运进境日期。')

  const windowStart = isZoneExport
    ? optIsoDate(p?.zoneExitDate, 'zoneExitDate')
    : optIsoDate(p?.departureDate, 'departureDate') ?? exportDate
  if (isZoneExport) {
    if (!windowStart) pending.push('1210 须提供货物从海关特殊监管区域或保税物流中心（B 型）出区离境的日期。')
    const returnedOutsideZone = optBoolean(p?.returnedOutsideZone, 'returnedOutsideZone')
    if (returnedOutsideZone === null) pending.push('请确认 1210 货物是否退运至境内区外。')
    else if (!returnedOutsideZone) reasons.push('1210 专项要求货物退运至境内区外。')
  }
  if (returnDate && ((windowStart && returnDate < windowStart) || (exportDate && returnDate < exportDate))) {
    throw new CalcInputError('退运进境日期不得早于出口申报日期或适用的离境日期')
  }

  const deadline = windowStart && addCalendarMonths(windowStart, 6)
  const returnDeadline = deadline?.toISOString().slice(0, 10) ?? null
  const monthsSinceExport = windowStart && returnDate
    ? round2((returnDate - windowStart) / 86_400_000 / 30.4375)
    : optNum(p?.monthsSinceExport, null, 'monthsSinceExport')
  if (deadline && returnDate && returnDate > deadline) reasons.push(`退运进境超过 6 个月，测算截止日为 ${returnDeadline}。`)
  if (inOriginalCondition === null) pending.push('请确认商品是否符合原状退运条件。')
  else if (!inOriginalCondition) reasons.push('商品不符合原状退运条件。')
  if (isFood === null) pending.push('请确认商品是否为食品。')
  else if (isFood) reasons.push('第 16 号公告的退运免税范围不含食品。')
  if (!returnReason) pending.push('请确认退运原因为滞销或退货。')
  else if (!['unsold', 'customer_return', '滞销', '退货'].includes(returnReason)) reasons.push('第 16 号公告仅适用于因滞销或退货退运的商品。')

  if (refundedExportTax === null) pending.push('请确认原出口已退税金额，未退税填 0。')
  if (refundedExportTax > 0 && optBoolean(p?.exportRefundRepaid, 'exportRefundRepaid') !== true) {
    pending.push('已办理出口退税的，须先向主管税务机关补缴原退税款。')
  }
  if (hasTaxCertificate !== true) pending.push('请确认已取得主管税务机关出具的《出口货物已补税/未退税证明》。')

  const eligibilityStatus = reasons.length > 0 ? 'ineligible' : pending.length > 0 ? 'pending' : 'eligible'
  const eligible = eligibilityStatus === 'eligible'
  const importTariff = exportValueCny * tariffRate
  const dutiablePlusTariff = exportValueCny + importTariff
  const taxBase = ctr > 0 ? dutiablePlusTariff / (1 - ctr) : dutiablePlusTariff
  const importConsumptionTax = taxBase * ctr
  const importVat = taxBase * importVatRate
  const totalImportTax = importTariff + importConsumptionTax + importVat
  const netCashBenefit = eligible ? round2(totalImportTax - refundedExportTax) : null

  const steps = [
    `出口申报日期 ${exportDay ?? '待确认'}，退运进境日期 ${returnDate?.toISOString().slice(0, 10) ?? '待确认'}。六个月从${isZoneExport ? '出区离境日' : '出口日'} ${windowStart?.toISOString().slice(0, 10) ?? '待确认'} 起算，测算截止日 ${returnDeadline ?? '待确认'}。`,
    `按普通进口税率估算关税 = ${exportValueCny} × ${tariffRate} = ${round2(importTariff)} 元`,
  ]
  if (ctr > 0) {
    steps.push(`进口消费税组价 = (${exportValueCny} + ${round2(importTariff)}) ÷ (1 − ${ctr}) = ${round2(taxBase)} 元；进口消费税 = ${round2(importConsumptionTax)} 元`)
  }
  steps.push(
    `按普通进口税率估算进口增值税 = ${round2(taxBase)} × ${importVatRate} = ${round2(importVat)} 元`,
    `普通进口情形下的税费对照值为 ${round2(totalImportTax)} 元（占货值 ${((totalImportTax / exportValueCny) * 100).toFixed(2)}%）。`,
  )
  if (eligible && refundedExportTax > 0) {
    steps.push(`扣除退税补缴后的净现金流测算 = ${round2(totalImportTax)} − ${round2(refundedExportTax)} = ${netCashBenefit} 元`)
  }

  const warnings = reasons.map((reason) => `【专项不适用】${reason}`)
  warnings.push(...pending.map((reason) => `【待核验】${reason}`))
  if (eligible) {
    warnings.push('申办时提交《出口货物已补税/未退税证明》、出口申报清单或报关单，以及滞销声明或退货记录等材料，由海关核验。')
  } else if (eligibilityStatus === 'ineligible') {
    if (ELIGIBLE_RETURN_CODES.has(customsCode) && exportDay >= '2023-01-30' && exportDay <= '2025-12-31') {
      warnings.push('2023-01-30 至 2025-12-31 的出口申报批次，另核对三部门公告 2023 年第 4 号及第 34 号的历史专项条件。')
    }
    warnings.push('另按《关税法》第 39 条及进口环节税收规定判断普通复运进境待遇，如因品质、规格或不可抗力在一年内原状复运进境，可核对不征收进口关税的条件。')
  }

  let summaryLine = '第 16 号公告专项资格待核验，请补齐待核事项。'
  if (eligible) summaryLine = `按输入符合第 16 号公告专项条件，估算免征进口关税、进口环节增值税和消费税合计 ${round2(totalImportTax)} 元。`
  else if (eligibilityStatus === 'ineligible') summaryLine = '第 16 号公告专项不适用，实际税费须按适用的复运进境规定另行判断。'

  return {
    scenario: '跨境电商出口退运免税资格与省税测算（2026年第16号公告）',
    customsCode,
    exportValueCny: round2(exportValueCny),
    monthsSinceExport,
    returnDeadline,
    eligible,
    eligibilityStatus,
    disqualifyReasons: reasons,
    pendingReasons: pending,
    importTariff: round2(importTariff),
    importConsumptionTax: round2(importConsumptionTax),
    importVat: round2(importVat),
    totalImportTaxSaved: eligible ? round2(totalImportTax) : 0,
    generalTradeImportTax: round2(totalImportTax),
    refundedExportTax: refundedExportTax === null ? null : round2(refundedExportTax),
    netCashBenefit,
    taxPayable: eligible ? 0 : null,
    summaryLine,
    steps,
    warnings,
    policyRefs: [
      { ref: '财政部 海关总署 税务总局公告2026年第16号', note: '规定出口申报期间、六个月时限、商品条件、退运原因与退税补缴凭证，1210 从出区离境起算并退至境内区外' },
      { ref: '《中华人民共和国关税法》第39条', note: '普通出口货物原状复运进境不征收进口关税的原因与时限条件' },
    ],
  }
}

/** 场景 9：生产企业出口货物“免、抵、退”税五步法测算（工贸一体/工厂型跨境卖家）。 */
export function exportRebateManufacturer(p = {}) {
  const exportFobCny = reqNum(p?.exportFobCny, 'exportFobCny 必须是正数（当期出口离岸价 FOB 人民币，元）', { allowZero: false })
  const totalInputVat = reqNum(p?.totalInputVat, 'totalInputVat 必须是非负数字（当期全部可抵扣进项税额，元）')
  const vatRate = optNum(p?.vatRate, 0.13, 'vatRate')
  const rebateRate = optNum(p?.rebateRate, vatRate, 'rebateRate')
  const dutyFreeMaterialsCny = optNum(p?.dutyFreeMaterialsCny, 0, 'dutyFreeMaterialsCny')
  const domesticOutputVat = optNum(p?.domesticOutputVat, 0, 'domesticOutputVat')
  const priorCreditCarryover = optNum(p?.priorCreditCarryover, 0, 'priorCreditCarryover')

  if (vatRate > 1 || rebateRate > 1) throw new CalcInputError('vatRate 与 rebateRate 应为 0~1 小数（如 13% 传 0.13）')
  if (dutyFreeMaterialsCny > exportFobCny) throw new CalcInputError('dutyFreeMaterialsCny（免税购进原材料价格）不能大于当期出口离岸价 exportFobCny')

  const warnings = []
  const effRebateRate = Math.min(vatRate, rebateRate)
  if (rebateRate > vatRate) {
    warnings.push(`传入退税率 ${rebateRate} 高于征税率 ${vatRate}，已按孰低原则锁定有效退税率为 ${effRebateRate}。`)
  }

  const netFob = exportFobCny - dutyFreeMaterialsCny
  const nonDeductibleToCost = netFob * (vatRate - effRebateRate)
  const netInputAfterTransfer = totalInputVat - nonDeductibleToCost
  const currentTaxBalance = domesticOutputVat - netInputAfterTransfer - priorCreditCarryover

  const vatPayable = Math.max(0, currentTaxBalance)
  const endingCredit = Math.max(0, -currentTaxBalance)
  const maxRebateLimit = netFob * effRebateRate
  const taxRefund = Math.min(endingCredit, maxRebateLimit)
  const taxExemptOffset = maxRebateLimit - taxRefund
  const nextCarryover = endingCredit - taxRefund

  const steps = [
    `计税基础 = 出口离岸价 ${exportFobCny} − 免税购进料件 ${dutyFreeMaterialsCny} = ${round2(netFob)} 元`,
    `① 不得免征和抵扣税额（转成本）= ${round2(netFob)} × (${vatRate} − ${effRebateRate}) = ${round2(nonDeductibleToCost)} 元`,
    `② 当期应纳税额 = 内销销项 ${domesticOutputVat} − (全部进项 ${totalInputVat} − 转出 ${round2(nonDeductibleToCost)}) − 上期留抵 ${priorCreditCarryover} = ${round2(currentTaxBalance)} 元`,
    `③ 当期应缴增值税 ${round2(vatPayable)} 元，期末留抵税额 ${round2(endingCredit)} 元；当期免抵退税额上限 = ${round2(netFob)} × ${effRebateRate} = ${round2(maxRebateLimit)} 元`,
    `④ 当期应退税额 = min(${round2(endingCredit)}, ${round2(maxRebateLimit)}) = ${round2(taxRefund)} 元`,
    `⑤ 当期免抵税额 = ${round2(maxRebateLimit)} − ${round2(taxRefund)} = ${round2(taxExemptOffset)} 元｜结转下期留抵 = ${round2(nextCarryover)} 元`,
  ]

  if (taxExemptOffset > 0) {
    warnings.push(`【城建税及附加待核】试算免抵税额 ${round2(taxExemptOffset)} 元，请按税务机关正式审核批准的当期免抵税额核对城建税、教育费附加及地方教育附加的计征依据。`)
  }
  if (dutyFreeMaterialsCny > 0) {
    warnings.push('已按免税购进料件抵减免抵退计税基础；进料加工业务须按主管税务机关核定的实耗法/购进法办理年度核销。')
  }
  warnings.push('生产企业自产或视同自产货物适用免抵退税；外购非视同自产贸易货物需区分口径，切勿混报。')

  const summaryLine = `当期应缴增值税 ${round2(vatPayable)} 元｜应退增值税 ${round2(taxRefund)} 元｜免抵税额 ${round2(taxExemptOffset)} 元｜结转下期留抵 ${round2(nextCarryover)} 元`

  return {
    scenario: '生产企业出口“免、抵、退”税测算',
    exportFobCny: round2(exportFobCny),
    dutyFreeMaterialsCny: round2(dutyFreeMaterialsCny),
    nonDeductibleToCost: round2(nonDeductibleToCost),
    vatPayable: round2(vatPayable),
    endingCredit: round2(endingCredit),
    maxRebateLimit: round2(maxRebateLimit),
    taxRefund: round2(taxRefund),
    taxExemptOffset: round2(taxExemptOffset),
    nextCarryover: round2(nextCarryover),
    summaryLine,
    steps,
    warnings,
    policyRefs: [
      { ref: '财政部 税务总局公告2026年第11号', note: '出口业务增值税政策：生产企业出口自产货物适用免抵退税办法' },
      { ref: '国家税务总局公告2026年第5号', note: '《出口业务增值税和消费税退（免）税管理办法》免抵退五步计算与单证备案要求' },
      { ref: '财税〔2005〕25号', note: '生产企业经税务机关正式审核批准的当期免抵的增值税税额应纳入城市维护建设税和教育费附加的计征范围' },
    ],
  }
}

/** 场景 10：500 万一般纳税人强制认定临界 & 小规模 vs 一般纳税人进项抵扣拐点测算。 */
export function vatTaxpayerThreshold(p = {}) {
  const rolling12m = reqNum(p?.rolling12mTaxableSales, 'rolling12mTaxableSales 必须是非负数字（近连续12个月累计应税销售额，元）')
  const projectedGross = optNum(p?.projectedAnnualGrossSales, rolling12m > 0 ? rolling12m : 4_000_000, 'projectedAnnualGrossSales')
  const deductibleCostRatio = optNum(p?.deductibleCostRatio, 0.65, 'deductibleCostRatio')
  const inputVatRate = optNum(p?.inputVatRate, 0.13, 'inputVatRate')
  const generalOutputRate = optNum(p?.generalOutputRate, 0.13, 'generalOutputRate')
  const smallScaleRate = optNum(p?.smallScaleRate, 0.01, 'smallScaleRate')
  const hasExportRebateDemand = p?.hasExportRebateDemand !== false
  const taxPeriod = String(p?.taxPeriod ?? '').trim()
  const periodTaxableSales = optNum(p?.periodTaxableSales, null, 'periodTaxableSales')
  const periodWaivedSales = optNum(p?.periodWaivedSales, 0, 'periodWaivedSales')

  if (deductibleCostRatio > 1 || inputVatRate > 1 || generalOutputRate > 1 || smallScaleRate > 1) {
    throw new CalcInputError('占比与税率参数均须为 0~1 之间的小数（如 65% 传 0.65，1% 传 0.01）')
  }
  if (taxPeriod && taxPeriod !== 'month' && taxPeriod !== 'quarter') throw new CalcInputError('taxPeriod 须为 month（按月）或 quarter（按季）')
  if (Boolean(taxPeriod) !== (periodTaxableSales !== null)) throw new CalcInputError('请同时填写税期 taxPeriod 和当期不含税销售额 periodTaxableSales')
  if (periodWaivedSales > (periodTaxableSales ?? 0)) throw new CalcInputError('放弃起征点免税的销售额不得超过当期不含税销售额')

  let periodSmallScale = null
  if (taxPeriod) {
    const threshold = taxPeriod === 'month' ? 100_000 : 300_000
    const reachesThreshold = periodTaxableSales >= threshold
    const taxBase = reachesThreshold ? periodTaxableSales : periodWaivedSales
    periodSmallScale = {
      taxPeriod,
      threshold,
      periodTaxableSales,
      reachesThreshold,
      exemptSales: round2(periodTaxableSales - taxBase),
      taxBase,
      estimatedVat: round2(taxBase * smallScaleRate),
    }
  }

  const THRESHOLD = 5_000_000
  const remainingQuota = Math.max(0, THRESHOLD - rolling12m)
  const utilizationPct = round2((rolling12m / THRESHOLD) * 100)
  const exceeded = rolling12m > THRESHOLD

  const smallScaleTax = (projectedGross / (1 + smallScaleRate)) * smallScaleRate
  const generalOutputTax = (projectedGross / (1 + generalOutputRate)) * generalOutputRate
  const generalInputTax = ((projectedGross * deductibleCostRatio) / (1 + inputVatRate)) * inputVatRate
  const generalNetTax = Math.max(0, generalOutputTax - generalInputTax)

  const outFactor = generalOutputRate / (1 + generalOutputRate)
  const inFactor = inputVatRate / (1 + inputVatRate)
  const smallFactor = smallScaleRate / (1 + smallScaleRate)
  const breakevenInputRatio = inFactor > 0 ? Math.max(0, (outFactor - smallFactor) / inFactor) : 1
  const breakevenPct = round2(breakevenInputRatio * 100)

  const taxDiff = generalNetTax - smallScaleTax
  const steps = [
    `500 万登记标准监测：连续不超过 12 个月或 4 个季度的累计应征增值税销售额 ${round2(rolling12m)} 元，占比 ${utilizationPct}%，${exceeded ? `已超标 ${round2(rolling12m - THRESHOLD)} 元` : `剩余额度 ${round2(remainingQuota)} 元`}`,
    `按预计年含税营收 ${round2(projectedGross)} 元对比国内应税税负：`,
    `· 小规模路径（征收率 ${(smallScaleRate * 100).toFixed(1)}%）：应纳增值税 = ${round2(projectedGross)} ÷ (1 + ${smallScaleRate}) × ${smallScaleRate} = ${round2(smallScaleTax)} 元`,
    `· 一般纳税人路径（销项 ${(generalOutputRate * 100).toFixed(1)}% / 进项占比 ${(deductibleCostRatio * 100).toFixed(1)}%）：销项 ${round2(generalOutputTax)} − 进项 ${round2(generalInputTax)} = ${round2(generalNetTax)} 元`,
    `· 无差别税负临界拐点：可取得专票的含税成本占比达到 ${breakevenPct}% 时，两类主体内销增值税持平；高于 ${breakevenPct}% 则一般纳税人更省税`,
  ]
  if (periodSmallScale) {
    const { threshold, reachesThreshold, taxBase, estimatedVat } = periodSmallScale
    const comparison = reachesThreshold ? '达到起征点，全额纳入计税基数' : '低于起征点，仅对放弃免税的销售额计税'
    steps.push(`假设按小规模申报，${taxPeriod === 'month' ? '月' : '季'}不含税销售额 ${periodTaxableSales} 元，起征点 ${threshold} 元。${comparison}，按计税基数 ${taxBase} 元 × ${smallScaleRate} 估算增值税 ${estimatedVat} 元。`)
  }

  const warnings = []
  if (exceeded) {
    warnings.push('【强制转一般纳税人红灯】超过 500 万元的，应在超标次月的申报纳税期限内办理登记。因自行补充或更正、风控核查、稽查查补等调整导致超标的，从调整之日起 10 个工作日内办理。自然人及符合规定并选择按小规模纳税的非企业单位依公告处理。')
    warnings.push('一般纳税人通常从超标所属期首日生效，涉及 2025 年或更早所属期按公告第十一条执行。逾期未办理的，自规定期限结束后第 5 个工作日起按一般纳税人管理，生效日仍按公告确定，已按小规模申报的所属期须逐期更正并确认相关扣税凭证用途。')
  } else if (utilizationPct >= 80) {
    warnings.push(`⚠【500 万红线黄灯】累计应税销售额已达 500 万红线的 ${utilizationPct}%（仅余 ${round2(remainingQuota)} 元），请提前梳理进项专票供应链与主体规划，避免被动强制转档后因缺进项导致税负骤增。`)
  }
  if (periodSmallScale || projectedGross <= 1_200_000) {
    warnings.push('2026-01-01 至 2027-12-31 按实际税期判断。月不含税销售额低于 10 万元或季不含税销售额低于 30 万元时适用起征点免税，等于边界即达到起征点，按规定以全额计税。差额征收以扣除后的不含税余额判断。')
    warnings.push('未达起征点时可就部分或全部交易放弃免税并按规定开具专票。税额按所填征收率估算，另有税收优惠或税率不同的业务应分别核对。')
  }
  if (hasExportRebateDemand) {
    warnings.push('【跨境出口关键分水岭】小规模纳税人出口仅适用“免税不退税”（进项税无法退回）；若采购可取得 13% 专票，主动登记一般纳税人可办理出口免退税，往往大幅优于小规模，请联动「供应商开票加点毛利临界」测算！')
  }

  const domesticBetter = taxDiff > 0 ? `内销口径小规模少缴 ${round2(taxDiff)} 元` : `内销口径一般纳税人少缴 ${round2(Math.abs(taxDiff))} 元`
  const summaryLine = `${exceeded ? '已超 500 万登记标准，须核对适用情形' : `距 500 万红线剩余 ${round2(remainingQuota)} 元（${utilizationPct}%）`}｜进项专票占比拐点 ${breakevenPct}%｜${domesticBetter}`

  return {
    scenario: '500 万一般纳税人临界与税负拐点测算',
    rolling12mTaxableSales: round2(rolling12m),
    remainingQuota: round2(remainingQuota),
    utilizationPct,
    exceeded,
    smallScaleVat: round2(smallScaleTax),
    generalVat: round2(generalNetTax),
    periodSmallScale,
    breakevenInputRatio: round2(breakevenInputRatio),
    breakevenInputPct: breakevenPct,
    taxPayable: round2(exceeded ? generalNetTax : Math.min(smallScaleTax, generalNetTax)),
    summaryLine,
    steps,
    warnings,
    policyRefs: [
      { ref: '《中华人民共和国增值税法》第9条、第23条', note: '500 万元为小规模纳税人年度标准。达到起征点时以全额计算增值税。' },
      { ref: '国家税务总局公告2026年第2号', note: '一般纳税人登记标准、期限、例外与生效规则，以法定应征增值税销售额为准' },
      { ref: '财政部 税务总局公告2026年第10号', note: '2026–2027 年小规模纳税人的按月和按季起征点及减按 1% 征收政策' },
      { ref: '国家税务总局公告2026年第4号', note: '未达起征点时，可以对全部或部分交易放弃免税' },
    ],
  }
}

/**
 * 场景 11：出口退税取消/下调（2026年第2号/第29号/第11号）与电池消费税（2026年第20号）双税毛利冲击测算。
 * 严守护城河纪律：仅提供通用确定性算术模型，不内嵌 362 项税号全量字典；具体税号须核对官方附件或 IMA 知识库。
 */
export function exportRebateCancelImpact(p = {}) {
  const purchaseGrossCny = reqNum(p?.purchaseGrossCny, 'purchaseGrossCny 必须是正数（含税采购金额，元）', { allowZero: false })
  const exportFobCny = reqNum(p?.exportFobCny, 'exportFobCny 必须是正数（出口离岸价 FOB 人民币，元）', { allowZero: false })
  const vatRate = optNum(p?.vatRate, 0.13, 'vatRate')
  const oldRebateRate = optNum(p?.oldRebateRate, 0.06, 'oldRebateRate')
  const newRebateRate = optNum(p?.newRebateRate, 0, 'newRebateRate')
  const otherCostsCny = optNum(p?.otherCostsCny, 0, 'otherCostsCny')
  const cancelAppliesDeemedDomesticVat = p?.cancelAppliesDeemedDomesticVat !== false
  const isConsumptionTaxItem = p?.isConsumptionTaxItem === true
  const isFinishedPowerBank = p?.isFinishedPowerBank === true
  const consumptionTaxRate = optNum(p?.consumptionTaxRate, 0.02, 'consumptionTaxRate')
  const hasValidCmaReport = optBoolean(p?.hasValidCmaReport, 'hasValidCmaReport')
  const exportConsumptionTaxExempt = p?.exportConsumptionTaxExempt !== false

  for (const [name, v] of Object.entries({ vatRate, oldRebateRate, newRebateRate })) {
    if (v > 1) throw new CalcInputError(`${name} 必须是 0~1 的小数（如 13% 传 0.13，6% 传 0.06）`)
  }
  if (consumptionTaxRate >= 1) throw new CalcInputError('consumptionTaxRate（消费税率）必须小于 1（如 2% 传 0.02，4% 传 0.04）')

  const purchaseExclTax = purchaseGrossCny / (1 + vatRate)
  const inputVat = purchaseGrossCny - purchaseExclTax
  const effOldRate = Math.min(vatRate, oldRebateRate)
  const effNewRate = Math.min(vatRate, newRebateRate)

  // 旧口径（按一般纳税人外贸企业免退税测算）
  const oldVatRefund = purchaseExclTax * effOldRate
  const oldNonRefundableCost = purchaseExclTax * (vatRate - effOldRate)
  const oldNetPurchaseCost = purchaseGrossCny - oldVatRefund
  const oldGrossProfit = exportFobCny - oldNetPurchaseCost - otherCostsCny

  // 新口径：newRebateRate === 0 且适用第 11 号第七条 → 视同内销征税；否则按免税不退或下调后新退税率测算
  let newMode = 'reduced_rebate'
  let newVatRefund = 0
  let newVatPayable = 0
  let newNonRefundableCost = 0
  let newGrossProfit = 0
  let requiredFobToKeepProfit = exportFobCny

  if (effNewRate === 0 && cancelAppliesDeemedDomesticVat) {
    newMode = 'deemed_domestic_vat'
    const deemedExclSales = exportFobCny / (1 + vatRate)
    const deemedOutputVat = deemedExclSales * vatRate
    newVatPayable = Math.max(0, deemedOutputVat - inputVat)
    // 销项减进项如为负（倒挂），净现金流仍以不含税收入减不含税成本测算
    newGrossProfit = deemedExclSales - purchaseExclTax - otherCostsCny
    requiredFobToKeepProfit = (oldGrossProfit + purchaseExclTax + otherCostsCny) * (1 + vatRate)
  } else if (effNewRate === 0) {
    newMode = 'exempt_no_refund'
    newNonRefundableCost = inputVat
    newGrossProfit = exportFobCny - purchaseGrossCny - otherCostsCny
    requiredFobToKeepProfit = oldGrossProfit + purchaseGrossCny + otherCostsCny
  } else {
    newMode = 'reduced_rebate'
    newVatRefund = purchaseExclTax * effNewRate
    newNonRefundableCost = purchaseExclTax * (vatRate - effNewRate)
    newGrossProfit = exportFobCny - (purchaseGrossCny - newVatRefund) - otherCostsCny
    requiredFobToKeepProfit = oldGrossProfit + (purchaseGrossCny - newVatRefund) + otherCostsCny
  }

  const profitDelta = newGrossProfit - oldGrossProfit
  const fobRaiseNeeded = Math.max(0, requiredFobToKeepProfit - exportFobCny)
  const fobRaisePct = exportFobCny > 0 ? (fobRaiseNeeded / exportFobCny) * 100 : 0

  // 消费税侧分列测算（2026#20 与 2026#2/#29 第三条出口消费税退免照旧）
  const consumptionTaxApplies = isConsumptionTaxItem && !isFinishedPowerBank
  const effectiveDomesticCtr = consumptionTaxApplies ? consumptionTaxRate : 0
  const domesticConsumptionTaxRef = consumptionTaxApplies ? purchaseExclTax * effectiveDomesticCtr : 0
  const statutory4PctConsumptionTaxRef = consumptionTaxApplies ? purchaseExclTax * 0.04 : 0
  const cmaRiskExtraTax =
    consumptionTaxApplies && effectiveDomesticCtr < 0.04 && hasValidCmaReport !== true
      ? Math.max(0, statutory4PctConsumptionTaxRef - domesticConsumptionTaxRef)
      : 0

  const steps = [
    `采购价税分离：含税采购 ${round2(purchaseGrossCny)} 元 ÷ (1 + ${vatRate}) = 不含税采购 ${round2(purchaseExclTax)} 元，进项税额 ${round2(inputVat)} 元`,
    `【原退税口径（退税率 ${(effOldRate * 100).toFixed(2)}%）】应退增值税 ${round2(oldVatRefund)} 元，征退差转成本 ${round2(oldNonRefundableCost)} 元 → 毛利 = ${round2(exportFobCny)} − (${round2(purchaseGrossCny)} − ${round2(oldVatRefund)})${otherCostsCny > 0 ? ` − 其他成本 ${round2(otherCostsCny)}` : ''} = ${round2(oldGrossProfit)} 元`,
  ]

  if (newMode === 'deemed_domestic_vat') {
    const deemedExcl = exportFobCny / (1 + vatRate)
    const deemedOut = deemedExcl * vatRate
    steps.push(
      `【取消退税·视同内销征税（2026年第11号第七条）】不含税销售额 = ${round2(exportFobCny)} ÷ (1 + ${vatRate}) = ${round2(deemedExcl)} 元，销项税 ${round2(deemedOut)} 元 − 进项税 ${round2(inputVat)} 元 = 应纳增值税 ${round2(newVatPayable)} 元（不含城建及附加）`,
      `新口径毛利 = 不含税收入 ${round2(deemedExcl)} − 不含税采购 ${round2(purchaseExclTax)}${otherCostsCny > 0 ? ` − 其他成本 ${round2(otherCostsCny)}` : ''} = ${round2(newGrossProfit)} 元`,
    )
  } else if (newMode === 'exempt_no_refund') {
    steps.push(
      `【免税不退对照口径（仅进项全额转成本）】应退增值税 0 元，进项转出 ${round2(newNonRefundableCost)} 元 → 新口径毛利 = ${round2(newGrossProfit)} 元`,
    )
  } else {
    steps.push(
      `【退税率下调口径（新退税率 ${(effNewRate * 100).toFixed(2)}%）】新应退增值税 ${round2(newVatRefund)} 元，征退差转成本 ${round2(newNonRefundableCost)} 元 → 新口径毛利 = ${round2(newGrossProfit)} 元`,
    )
  }

  steps.push(
    `【同口径毛利变动】${round2(oldGrossProfit)} 元 → ${round2(newGrossProfit)} 元（差额 ${round2(profitDelta)} 元）；若要维持原毛利 ${round2(oldGrossProfit)} 元，FOB 报价须上调至 ${round2(requiredFobToKeepProfit)} 元（+${round2(fobRaiseNeeded)} 元 / +${round2(fobRaisePct)}%）`,
  )

  if (isFinishedPowerBank) {
    steps.push('【消费税豁免】已标注为成品充电宝：属用电充电系统，不在 2026 年第 20 号公告电池消费税征税范围内（消费税额 0 元）。')
  } else if (consumptionTaxApplies) {
    steps.push(
      `【消费税单列（2026年第20号）】按不含税价 ${round2(purchaseExclTax)} 元 × 税率 ${(effectiveDomesticCtr * 100).toFixed(2)}% 估算消费税 ${round2(domesticConsumptionTaxRef)} 元；${exportConsumptionTaxExempt ? '按 2026 年第 2 号与第 29 号公告第三条，符合条件的出口消费税退（免）税政策照旧保留，未直接扣除出口毛利。' : '未适用出口消费税退免时，该税额将直接侵蚀毛利。'}`,
    )
  }

  const warnings = [
    '【按完整税号与出口日期核对】2026 年第 2 号（249 项光伏等取消 + 22 项电池 2026-12-31 报关单出口日锁 6%、2027-01-01 归零）与第 29 号（67 项新能源车 13%→9% + 竹木及电子烟具 8543400010 自 2027-04-01 取消，而 8543400090 已取消）须按完整 8/10 位商品代码与官方附件逐码核验，切勿只看前 4 位。',
  ]
  if (newMode === 'deemed_domestic_vat' && newVatPayable > 0) {
    warnings.push(
      `【增值税与附加税提示】取消出口退税适用 2026 年第 11 号公告第七条征税时，除少退原退税额外还须按销项减进项计缴增值税 ${round2(newVatPayable)} 元，并据实计提城建税及教育费附加（约增税 ${round2(newVatPayable * 0.12)} 元，未计入上述毛利）。`,
    )
  }
  if (isFinishedPowerBank) {
    warnings.push('【成品充电宝/成套储能边界】按 2026 年第 20 号公告口径，成品充电宝与成套储能系统属用电充电/成套设备，不在电池消费税征税范围；但电芯、电池组、电池簇等列明电池品类属于应税范围。')
  } else if (consumptionTaxApplies) {
    if (effectiveDomesticCtr < 0.04 && hasValidCmaReport !== true) {
      warnings.push(
        `【CMA 检测报告硬门禁】生产或委托加工享受 2% 过渡期减征（锂电/镍氢/全钒等 2026-09-01 起、一般光伏电池 2027-04-01 起）或列明新技术免征，均须符合相应国家标准并在首次申报减免前取得有效 CMA 机构出具、资质附表覆盖对应项目的检测报告！未备齐时按法定 4% 补税差额约 ${round2(cmaRiskExtraTax)} 元。`,
      )
    }
    warnings.push('【消费税出口退免照旧】2026 年第 2 号与第 29 号公告第三条均保留出口消费税退（免）税政策，与增值税出口退税取消分轨核算；外贸企业须凭合规消费税专用缴款书/增值税专票及单证备案办理。')
  }

  return {
    scenario: '出口退税取消/下调与电池消费税双税毛利冲击测算',
    newMode,
    purchaseGrossCny: round2(purchaseGrossCny),
    purchaseExclTaxCny: round2(purchaseExclTax),
    inputVatCny: round2(inputVat),
    exportFobCny: round2(exportFobCny),
    oldRebateRate: effOldRate,
    newRebateRate: effNewRate,
    oldVatRefund: round2(oldVatRefund),
    oldGrossProfit: round2(oldGrossProfit),
    newVatRefund: round2(newVatRefund),
    newVatPayable: round2(newVatPayable),
    newGrossProfit: round2(newGrossProfit),
    profitDelta: round2(profitDelta),
    requiredFobToKeepProfit: round2(requiredFobToKeepProfit),
    fobRaiseNeeded: round2(fobRaiseNeeded),
    fobRaisePct: round2(fobRaisePct),
    consumptionTaxApplies,
    domesticConsumptionTaxRef: round2(domesticConsumptionTaxRef),
    cmaRiskExtraTax: round2(cmaRiskExtraTax),
    taxPayable: round2(newVatPayable),
    summaryLine: `毛利 ${round2(oldGrossProfit)} 元 → ${round2(newGrossProfit)} 元（变动 ${round2(profitDelta)} 元）；保原毛利须调价至 FOB ${round2(requiredFobToKeepProfit)} 元（+${round2(fobRaisePct)}%）${consumptionTaxApplies ? `；消费税单列参考 ${round2(domesticConsumptionTaxRef)} 元（出口退免照旧）` : isFinishedPowerBank ? '；成品充电宝不征电池消费税' : ''}`,
    steps,
    warnings,
    policyRefs: [
      { ref: '财政部 税务总局公告2026年第2号', note: '取消光伏等 249 项出口退税，22 项电池 2026-04-01 起降至 6%、2027-01-01 取消；第三条保留消费税出口退（免）税' },
      { ref: '财政部 税务总局公告2026年第29号', note: '2027-04-01 起 67 项新能源汽车退税率 13%→9%，竹木与电子烟具 8543400010 取消退税；第三条保留消费税退（免）税' },
      { ref: '财政部 税务总局公告2026年第11号', note: '第七条：取消出口退（免）税的货物除列明例外原则上适用增值税征税政策' },
      { ref: '财政部 税务总局公告2026年第20号', note: '应税电池消费税：无汞原电池、锂原电池、镍氢、锂离子蓄电池、全钒液流电池 2026-09-01 起过渡 2%、2027-09-01 起法定 4%；一般光伏电池 2027-04-01 起过渡 2%、2028-04-01 起法定 4%；减免均须国标+首次申报前有效 CMA 报告；成品充电宝及成套储能系统不在征税范围' },
    ],
  }
}

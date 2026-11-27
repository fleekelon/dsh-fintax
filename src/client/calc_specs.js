// v0.9.0 new cross-border tariff & mixed procurement split specs (3 engines -> 14 total).

import { BASE_CALC_SCENARIOS } from './calc_specs_base.js'

export const V9_CALC_SCENARIOS = [
  {
    code: 'eu_low_value_parcel',
    group: 'crossborder',
    isNew: true,
    currency: 'EUR',
    zh: '欧盟低值包裹 €3+€2 与 PID 反推售价',
    en: 'EU Low-Value Parcel (€3+€2 & PID Pricing)',
    desc: '按欧委会指引测算欧盟 ≤€150 低值包裹 €3/项临时关税（自 2026-07-01 适用）+ €2/项退货不退处理费（自 2026-11-01 适用，IOSS 均不代收），支持 PID 含税抽佣向上取分反推售价（含 €150 复核阻断）及「同篮混装直邮 vs 同篮按项拆包 vs 单税则 SKU 归并 vs 欧盟海外仓」对比。',
    enDesc: 'Models EU <=EUR 150 parcel EUR 3 per-item temporary duty (from 2026-07-01) + EUR 2 per-item non-refundable handling fee (from 2026-11-01, excluded from IOSS), cent-ceiled PID reverse pricing with EUR 150 re-check, and physical split vs single-HS bundle vs EU warehouse comparison.',
    fields: [
      { key: 'sellingPriceEur', label: '商品含税零售价（EUR）', enLabel: 'VAT-Inclusive Selling Price (EUR)', def: '35.7' },
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
      { key: 'separateShippingInPriceEur', label: '售价内单独列明且不计入内在价值的运费（EUR，可选）', enLabel: 'Separately Stated Shipping in Price (EUR)', def: '' },
      { key: 'otherVariableCostEur', label: '其他变动成本/包材广告（EUR）', enLabel: 'Other Variable Cost (EUR)', def: '0' },
      { key: 'splitParcelShippingEur', label: '同购物篮按项拆包每小包直邮运费（EUR，默认同直邮运费）', enLabel: 'Split Parcel Shipping Per Parcel (EUR)', def: '' },
      { key: 'returnGoodsRecoveryRate', label: '直邮退货商品残值回收率（0~1）', enLabel: 'Direct Return Goods Recovery Rate', def: '0' },
      { key: 'euWarehouseReturnRecoveryRate', label: '欧盟海外仓退货商品回收率（0~1，默认同直邮）', enLabel: 'EU Warehouse Return Recovery Rate', def: '' },
      { key: 'euWarehouseFirstLegEur', label: '欧盟海外仓单件头程运费（EUR，可选）', enLabel: 'EU Warehouse First-Leg Freight (EUR)', def: '' },
      { key: 'euWarehouseDutyRate', label: '欧盟海外仓一般贸易关税率（默认 0.04）', enLabel: 'EU Warehouse MFN Duty Rate', def: '0.04' },
      { key: 'euWarehouseLocalDeliveryEur', label: '欧盟海外仓本地尾程派送费（EUR，可选）', enLabel: 'EU Warehouse Local Delivery (EUR)', def: '' },
      { key: 'euWarehouseStorageEur', label: '欧盟海外仓月均仓储费（EUR）', enLabel: 'EU Warehouse Monthly Storage (EUR)', def: '0' },
      { key: 'monthlyOrders', label: '月订单量（用于放大月度利差，可选）', enLabel: 'Monthly Orders (optional)', def: '1000' },
    ],
    imaKeywords: ['欧盟2欧', '150欧元', 'IOSS', 'PID', 'VAT'],
  },
  {
    code: 'us_t86_vs_9810_ddp',
    group: 'crossborder',
    isNew: true,
    currency: 'USD',
    zh: '美线 Type 11 vs 9810 DDP 与 IEEPA/FIOR',
    en: 'US Type 11 vs 9810 DDP & IEEPA/FIOR',
    desc: '对比美线 T86 暂停后 Type 11 直邮 vs 9810 海外仓 DDP 单件毛利（含 2027-01-15 Amazon US FBA 涨价 $0.19 敏感度），严格校验 IEEPA/CAPE 退税窗口与 ACE ACH Hold，并附 2027-01-05 FIOR+CTPAT-validated 红线。',
    enDesc: 'Compares US Type 11 direct mail vs 9810 overseas warehouse DDP unit margins (with 2027-01-15 FBA +$0.19 hike sensitivity), strict IEEPA/CAPE refund gating, ACE ACH Hold alerts, and 2027-01-05 FIOR + CTPAT-validated compliance.',
    fields: [
      { key: 'sellingPriceUsd', label: '商品售价（USD）', enLabel: 'Selling Price (USD)', def: '39.99' },
      { key: 'purchaseCostUsd', label: '采购成本（USD）', enLabel: 'Purchase Cost (USD)', def: '8' },
      { key: 'declaredValueUsd', label: '申报完税价 / FOB 价（USD）', enLabel: 'Declared Customs / FOB Value (USD)', def: '10' },
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
      { key: 'tariffProgram', label: '关税项目（须显式选择，仅 IEEPA 适用 CAPE）', enLabel: 'Tariff Program (explicit)', type: 'select', def: '', options: [{ value: '', label: '请选择实缴税种（未选不放行）' }, { value: 'IEEPA', label: 'IEEPA（适用窗口内 CAPE 退税）' }, { value: 'Section301', label: 'Section 301（不适用 CAPE）' }, { value: 'Section232', label: 'Section 232（不适用 CAPE）' }, { value: 'Section122', label: 'Section 122（不适用 CAPE）' }] },
      { key: 'entryDate', label: '单票独立入境/缴税日（YYYY-MM-DD，可选）', enLabel: 'Single Entry Date (optional)', type: 'date', def: '' },
      { key: 'entryPeriodStart', label: '缴税开始日期（YYYY-MM-DD，须与结束日配对）', enLabel: 'Entry Period Start', type: 'date', def: '' },
      { key: 'entryPeriodEnd', label: '缴税结束日期（YYYY-MM-DD，须与开始日配对）', enLabel: 'Entry Period End', type: 'date', def: '' },
      { key: 'aceAchBound', label: '已在 CBP ACE Portal 绑定 ACH 账户', enLabel: 'ACE ACH Account Bound', type: 'confirmation', def: '' },
    ],
    imaKeywords: ['FIOR', 'CTPAT', 'IEEPA', '美国关税', '境外进口商', 'T86', '9810'],
  },
  {
    code: 'fba_mixed_procurement_split',
    group: 'export',
    isNew: true,
    currency: 'CNY',
    zh: '50 万 FBA 有票+无票混合采购拆单',
    en: 'FBA Mixed Procurement Split (0110 + 9810/9610)',
    desc: '测算有票专票与无票采购混合发 FBA 时「硬混一票退税被拒/全额视同内销」vs「有票 0110 退税 + 无票合规拆单」vs「加点补票全走 0110」净收益对比与操作边界。',
    enDesc: 'Compares mixed single-entry deemed-domestic-VAT risk vs compliant split (0110 rebate + 9810/9610/1039/agency) vs supplier-markup full-invoiced 0110.',
    fields: [
      { key: 'totalExportCny', label: '总出货额 / 出口 FOB 金额（元）', enLabel: 'Total Export Value (CNY)', def: '500000' },
      { key: 'invoicedPurchaseGrossCny', label: '有票专票采购批次含税金额（元）', enLabel: 'Invoiced Purchase Gross (CNY)', def: '339000' },
      { key: 'noInvoicePurchaseCny', label: '无票采购批次裸采金额（元）', enLabel: 'Non-Invoiced Bare Purchase (CNY)', def: '100000' },
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
    imaKeywords: ['拆单', '无票免税', '出口退税', '9810', '0110', '代理出口'],
  },
]

export const CALC_SCENARIOS = [
  ...BASE_CALC_SCENARIOS.filter((s) => s.group === 'audit'),
  ...V9_CALC_SCENARIOS.filter((s) => s.group === 'crossborder'),
  ...V9_CALC_SCENARIOS.filter((s) => s.group === 'export'),
  ...BASE_CALC_SCENARIOS.filter((s) => s.group === 'export'),
  ...BASE_CALC_SCENARIOS.filter((s) => s.group === 'general'),
]

export function buildInitialValues(sc) {
  const obj = {}
  for (const f of [...(sc.fields || []), ...(sc.advancedFields || [])]) obj[f.key] = f.def
  return obj
}

export function fieldApplies(field, values) {
  return (!field.customsCode || field.customsCode === values.customsCode) &&
    (!field.excludeCustomsCode || field.excludeCustomsCode !== values.customsCode)
}

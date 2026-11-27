import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtAmount,
  parseAmount,
  parseStatementBuffer,
  readTabularSheetsFromBuffer,
} from '../lib/statement.js'
import { buildConsolidatedReconcile, serializeSummary } from '../lib/report.js'
import {
  AMAZON_2027_FEE_PATTERNS,
  AMAZON_V9_HEADER_ALIASES,
  AMAZON_V9_ROW_TYPE_ALIASES,
  AMAZON_V9_SITE_MAP,
  AMAZON_V9_SITE_TO_CURRENCY,
  classifyAmazon2027Fee,
  detectV9Platform,
  mergeAmazonV9HeaderAliases,
  parseV9PlatformRows,
  resolveAmazonV9Site,
} from '../lib/platforms_v9.js'
import {
  buildV9DemoFiles,
  detectBankReceipt,
  getV9DemoBuffers,
  parseBankReceiptRows,
  reconcileStage3,
} from '../lib/bank_receipt.js'

function csvToRows(csvText, fileName = 'test.csv') {
  const loaded = readTabularSheetsFromBuffer(Buffer.from(csvText, 'utf8'), fileName)
  return loaded.sheets[0][1]
}

test('v0.9 结汇钱包 1 — 连连国际 (LianLian)：入账/对公结汇/汇差/私户 P0 红线/不计入销售收入', () => {
  const csv = [
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,收款银行,主体编号,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,备注,状态',
    '2026-11-18,LL-IN-01,平台回款,Amazon,Amazon.com Services LLC,,,ENT-01,USD,30000.00,0.00,0.00,30000.00,,,Amazon US Payout,Completed',
    '2026-11-20,LL-WD-01,结汇提现,Amazon,深圳星海跨境科技有限公司(对公基本户),7559012345108821,招商银行,ENT-01,USD,0.00,15000.00,45.00,-15045.00,7.2400,108600.00,对公回流,Completed',
    '2026-11-21,LL-WD-02,结汇提现,Amazon,义乌市星河百货商行(个体工商户),6212260000003344,工商银行,ENT-01,USD,0.00,5000.00,15.00,-5015.00,7.2400,36150.00,个体户对公汇差50,Completed',
    '2026-11-22,LL-WD-03,提现,Amazon,张三个人储蓄卡,622202****9901,建设银行,ENT-01,USD,0.00,2000.00,10.00,-2010.00,7.2400,14480.00,私户提现,Completed',
    '2026-11-23,LL-SP-04,余额直付,Amazon,YunExpress Logistics Ltd,,,ENT-01,USD,0.00,1800.00,0.00,-1800.00,,,头程物流费,Completed',
    '2026-11-24,LL-IN-05,平台回款,Amazon,Amazon.com,,,ENT-01,USD,4000.00,0.00,0.00,4000.00,,,Pending payout,Pending',
  ].join('\n')
  const rows = csvToRows(csv, 'LianLian_202611.csv')
  const det = detectV9Platform(rows[0], 'LianLian_202611.csv', rows)
  assert.equal(det.platform, 'lianlian')
  assert.equal(det.role, 'settlement_wallet')

  const [s] = parseV9PlatformRows('lianlian', rows, { fileName: 'LianLian_202611.csv' })
  assert.equal(s.platform, 'LianLian')
  assert.equal(s.role, 'settlement_wallet')
  assert.equal(fmtAmount(s.taxReportingGrossRef), '0.00')
  assert.equal(fmtAmount(s.walletMetrics.platformInbound), '30000.00')
  assert.equal(fmtAmount(s.walletMetrics.fxWithdrawToCorporate), '20000.00')
  assert.equal(fmtAmount(s.walletMetrics.fxWithdrawToPersonal), '2000.00')
  assert.equal(fmtAmount(s.walletMetrics.directSpend), '1800.00')
  assert.equal(fmtAmount(s.walletMetrics.walletFees), '70.00')
  assert.equal(fmtAmount(s.walletMetrics.cnySettledCorporate), '144750.00')
  assert.equal(fmtAmount(s.walletMetrics.fxSettlementDiffCny), '-50.00')
  assert.equal(s.walletMetrics.voidExcludedCount, 1)
  assert.equal(s.outboundEvidence.length, 3)
  assert.equal(s.outboundEvidence[0].accountSuffix, '8821')
  assert.ok(s.outboundEvidence[0].entityKey && s.outboundEvidence[0].referenceKey)
  assert.ok(s.anomalies.some((a) => a.severity === 'P0-阻断' && a.category.includes('个人私户')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('坐支')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P2-关注' && a.category.includes('汇兑差额')))

  // 与 report.js 无缝兼容，绝不计入销售毛额
  const cons = buildConsolidatedReconcile([s], { fxRates: { USD: 7.24 } })
  assert.equal(cons.ready, true)
  assert.equal(cons.totals.grossCny, 0)
  assert.equal(cons.fundChain.stage2WalletInboundCny, 217200)
  assert.equal(serializeSummary(s).role, 'settlement_wallet')
})

test('v0.9 结汇钱包 2 & 3 — PingPong 与 寻汇 (SUNRATE)：多币种拆表、海外公司后缀、退汇冲减与无 Net 列费用反推', () => {
  const ppCsv = [
    '交易时间,PingPong单号,交易类型,店铺名称,收款户名,收款账号,币种,入账金额,提现金额,PingPong手续费,提现汇率,实收人民币,备注,状态',
    '2026-11-05,PPG-001,平台回款,SHEIN US,Roadget Business Pte. Ltd.,,USD,12000.00,0.00,0.00,,,SHEIN结算,Completed',
    '2026-11-08,PPG-002,结汇提现,SHEIN US,星海电子商务工作室,6228480000005566,USD,0.00,10000.00,100.00,7.2200,71478.00,手续费内扣自动识别,Completed',
    '2026-11-10,PPG-003,平台回款,Amazon DE,Amazon EU Sarl,,EUR,8000.00,0.00,0.00,,,EU结算,Completed',
    '2026-11-12,PPG-004,提现,Amazon DE,Starlight Europe GmbH,DE89370400440532013000,EUR,0.00,5000.00,25.00,7.8500,39250.00,手续费外扣自动识别,Completed',
  ].join('\n')
  const ppRows = csvToRows(ppCsv, 'PingPong_MultiCcy_202611.csv')
  assert.equal(detectV9Platform(ppRows[0], 'PingPong_MultiCcy_202611.csv', ppRows).platform, 'pingpong')
  const ppSums = parseV9PlatformRows('pingpong', ppRows, { fileName: 'PingPong_MultiCcy_202611.csv' })
  assert.equal(ppSums.length, 2)
  const ppUsd = ppSums.find((x) => x.currency === 'USD')
  const ppEur = ppSums.find((x) => x.currency === 'EUR')
  // 内扣 100 手续费 -> 实际结汇本金 9900 × 7.22 = 71478.00
  assert.equal(fmtAmount(ppUsd.walletMetrics.fxWithdrawToCorporate), '9900.00')
  assert.equal(ppUsd.walletMetrics.netPendingCount, 0)
  // 外扣 25 手续费 -> 实际结汇本金 5000 × 7.85 = 39250.00
  assert.equal(fmtAmount(ppEur.walletMetrics.fxWithdrawToCorporate), '5000.00')
  assert.equal(ppEur.walletMetrics.netPendingCount, 0)

  // 寻汇 SUNRATE：含合伙企业/Pte 后缀 + 内部换汇剥离 + 退汇关联原提现冲减
  const srCsv = [
    '交易日期,寻汇流水号,原流水号,交易类型,来源平台,收款方名称,收款银行账号,原币种,入账金额,出金金额,手续费,净额,成交汇率,实收人民币,状态',
    '2026-11-02,SR-101,,全球收款入账,Walmart,Walmart Inc,,USD,25000.00,0.00,0.00,25000.00,,,Completed',
    '2026-11-05,SR-102,,结汇出金,Walmart,深圳前海星海有限合伙企业,7559012345107788,USD,0.00,15000.00,30.00,-15030.00,7.2300,108450.00,Completed',
    '2026-11-06,SR-103,,结汇出金,Walmart,Xinghai SG Pte. Ltd.,SG0011223344,USD,0.00,3000.00,10.00,-3010.00,7.2300,21690.00,Completed',
    '2026-11-07,SR-104,SR-103,出金退回,Walmart,Bank Return,,USD,3000.00,0.00,0.00,3000.00,,,Returned',
    '2026-11-08,SR-105,,外汇兑换,SUNRATE,SUNRATE Treasury,,USD,0.00,1000.00,0.00,-1000.00,,,Completed',
  ].join('\n')
  const srRows = csvToRows(srCsv, 'SUNRATE_202611.csv')
  assert.equal(detectV9Platform(srRows[0], 'SUNRATE_202611.csv', srRows).platform, 'sunrate')
  const [sr] = parseV9PlatformRows('sunrate', srRows, { fileName: 'SUNRATE_202611.csv' })
  assert.equal(sr.platform, 'SUNRATE')
  assert.equal(fmtAmount(sr.walletMetrics.platformInbound), '25000.00')
  // SR-103 (3000) 被 SR-104 退汇全额冲减，剩余对公提现 15000.00
  assert.equal(fmtAmount(sr.walletMetrics.fxWithdrawToCorporate), '15000.00')
  assert.equal(fmtAmount(sr.walletMetrics.matchedCorporateReturn), '3000.00')
  assert.equal(fmtAmount(sr.walletMetrics.internalFxStripped), '1000.00')
  assert.equal(sr.outboundEvidence.find((e) => e.accountSuffix === '3344').returned, true)
})

test('v0.9 销售平台 1 — SHEIN：全托管/半托管混表 P0 阻断与费用冲回负值严格保符号', () => {
  const csv = [
    '结算日期,结算单号,合作模式,账务类型,站点,币种,销售额,供货货款,商家优惠,平台补贴,退款金额,平台佣金,履约运费,质检扣款,提现金额,净结款',
    '2026-11-05,SHN-1001,半托管,订单结算,US,USD,10000.00,0.00,-400.00,200.00,0.00,-1000.00,-800.00,-100.00,0.00,7900.00',
    '2026-11-07,SHN-1002,半托管,佣金冲回,US,USD,0.00,0.00,0.00,0.00,0.00,150.00,50.00,0.00,0.00,200.00',
    '2026-11-09,SHN-1003,全托管,供货结算,US,USD,0.00,5000.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,5000.00',
    '2026-11-20,SHN-WD-01,半托管,提现打款,US,USD,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,13100.00,13100.00',
  ].join('\n')
  const rows = csvToRows(csv, 'SHEIN_Settlement_202611.csv')
  const det = detectV9Platform(rows[0], 'SHEIN_Settlement_202611.csv', rows)
  assert.equal(det.platform, 'shein')
  assert.equal(det.role, 'sales_platform')

  const [s] = parseV9PlatformRows('shein', rows, { fileName: 'SHEIN_Settlement_202611.csv' })
  assert.equal(s.platform, 'SHEIN')
  assert.equal(s.horizontalDiffTotal, 0n, '费用冲回必须严格保符号且水平守恒为 0')
  assert.equal(fmtAmount(s.grossSales), '15000.00')
  // 佣金 1000 - 冲回 150 = 850.00（绝不可盲目 absBig 变成 1150.00！）
  assert.equal(fmtAmount(s.platformCommission), '850.00')
  // 履约运费 800 - 冲回 50 = 750.00
  assert.equal(fmtAmount(s.logisticsWarehousing), '750.00')
  assert.equal(fmtAmount(s.gatewayDisputeFee), '100.00')
  assert.equal(fmtAmount(s.actualPayout), '13100.00')
  assert.ok(s.anomalies.some((a) => a.severity === 'P0-阻断' && a.category.includes('全托管')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('质检')))
})

test('v0.9 销售平台 2 — Walmart：兼容长表事件流 (Order # / Amount Type / WFS) 与宽表明细及佣金冲回', () => {
  // 1) 官方长表 Reconciliation Report
  const longCsv = [
    'Period Start Date,Period End Date,Total Payable,Currency,Transaction Key,Transaction Posted Timestamp,Transaction Type,Order #,Amount,Amount Type',
    '2026-11-01,2026-11-30,1410.00,USD,WM-SET-01,,,,,',
    '2026-11-01,2026-11-30,,USD,WM-TX-1,2026-11-05,SALE,1088001,2000.00,Product Price',
    '2026-11-01,2026-11-30,,USD,WM-TX-2,2026-11-05,SALE,1088001,160.00,Tax on Product',
    '2026-11-01,2026-11-30,,USD,WM-TX-3,2026-11-05,SALE,1088001,-160.00,Tax Withheld',
    '2026-11-01,2026-11-30,,USD,WM-TX-4,2026-11-05,SALE,1088001,-300.00,Commission on Product',
    '2026-11-01,2026-11-30,,USD,WM-TX-5,2026-11-05,SALE,1088001,-120.00,WFS Fulfillment Fee',
    '2026-11-01,2026-11-30,,USD,WM-TX-6,2026-11-09,REFUND,1088002,-200.00,Product Price',
    '2026-11-01,2026-11-30,,USD,WM-TX-7,2026-11-09,REFUND,1088002,30.00,Commission on Product',
    '2026-11-01,2026-11-30,,USD,WM-TX-8,2026-11-12,ADJUSTMENT,1088003,-50.00,Walmart Connect Advertising',
  ].join('\n')
  const longRows = csvToRows(longCsv, 'Walmart_Recon_202611.csv')
  assert.equal(detectV9Platform(longRows[0], 'Walmart_Recon_202611.csv', longRows).platform, 'walmart')
  const [wl] = parseV9PlatformRows('walmart', longRows, { fileName: 'Walmart_Recon_202611.csv' })
  assert.equal(wl.platform, 'Walmart')
  assert.equal(wl.period, '2026-11')
  assert.equal(fmtAmount(wl.grossSales), '2000.00')
  assert.equal(fmtAmount(wl.customerRefund), '200.00')
  // 佣金 300 - 退款返还佣金 30 = 270.00
  assert.equal(fmtAmount(wl.platformCommission), '270.00')
  assert.equal(fmtAmount(wl.logisticsWarehousing), '120.00')
  assert.equal(fmtAmount(wl.inPlatformAds), '50.00')
  assert.equal(fmtAmount(wl.facilitatorTaxStripped), '160.00')
  assert.equal(fmtAmount(wl.selfRemitTaxNet), '0.00')
  assert.equal(fmtAmount(wl.actualPayout), '1410.00')

  // 2) 宽表格式（含 WFS 费用冲回负值保符号）
  const wideCsv = [
    'Period Start Date,Period End Date,Order #,Transaction Type,Currency,Product Price,Commission,WFS,Refund,Amount',
    '2026-11-01,2026-11-30,WM-W1,SALE,USD,1000.00,-150.00,-80.00,0.00,770.00',
    '2026-11-01,2026-11-30,WM-W2,ADJUSTMENT,USD,0.00,0.00,20.00,0.00,20.00',
  ].join('\n')
  const wideRows = csvToRows(wideCsv, 'walmart_wide.csv')
  assert.equal(detectV9Platform(wideRows[0], 'walmart_wide.csv', wideRows).platform, 'walmart')
  const [ww] = parseV9PlatformRows('walmart', wideRows, { fileName: 'walmart_wide.csv' })
  assert.equal(ww.horizontalDiffTotal, 0n)
  assert.equal(fmtAmount(ww.logisticsWarehousing), '60.00')
})

test('v0.9 销售平台 3 — Lazada：Fee Name / VAT in Amount / Paid Status / WHT 与佣金返还符号守恒', () => {
  const csv = [
    'Transaction Date,Order No.,Fee Name,Amount,VAT in Amount,Paid Status,Statement,Currency',
    '2026-11-05,LZ-5001,Item Price Credit,5000.00,0.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-05,LZ-5001,Shipping Fee Paid by Buyer,150.00,0.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-05,LZ-5001,Commission,-300.00,-18.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-06,LZ-5001,Reversal Commission,50.00,3.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-06,LZ-5001,Shipping Fee (Charged by Lazada),-200.00,-12.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-08,LZ-5002,Sponsored Discovery,-120.00,-7.20,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-10,LZ-5003,Reversal Item Price,-400.00,0.00,Not Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-11,LZ-5004,Withholding Tax,-45.00,0.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-12,LZ-5005,Item Price Credit,999.00,0.00,Cancelled,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-28,LZ-PAY-01,Bank Transfer Payout,-4145.80,0.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
  ].join('\n')
  const rows = csvToRows(csv, 'Lazada_MY_202611.csv')
  const det = detectV9Platform(rows[0], 'Lazada_MY_202611.csv', rows)
  assert.equal(det.platform, 'lazada')
  assert.equal(det.role, 'sales_platform')

  const [lz] = parseV9PlatformRows('lazada', rows, { fileName: 'Lazada_MY_202611.csv' })
  assert.equal(lz.platform, 'Lazada')
  assert.equal(lz.site, 'MY')
  assert.equal(lz.period, '2026-11')
  assert.equal(fmtAmount(lz.grossSales), '5150.00')
  assert.equal(fmtAmount(lz.customerRefund), '400.00')
  // 佣金含税 318.00 - 冲回 53.00 = 265.00
  assert.equal(fmtAmount(lz.platformCommission), '265.00')
  assert.equal(fmtAmount(lz.logisticsWarehousing), '212.00')
  assert.equal(fmtAmount(lz.inPlatformAds), '127.20')
  assert.equal(fmtAmount(lz.gatewayDisputeFee), '45.00')
  assert.equal(fmtAmount(lz.uncapturedVoidExcluded), '999.00')
  assert.equal(fmtAmount(lz.actualPayout), '4145.80')
  assert.ok(lz.anomalies.some((a) => a.category.includes('预提所得税')))
  assert.ok(lz.anomalies.some((a) => a.category.includes('Not Paid')))
})

test('v0.9 Amazon 扩展映射：FR/IT/ES 本地化表头、9 大站点映射与 2027 新增三类费用识别', () => {
  // FR/IT/ES 表头别名完整覆盖核心列且合并函数不污染输入对象
  assert.ok(AMAZON_V9_HEADER_ALIASES.date_time.includes('date/heure'))
  assert.ok(AMAZON_V9_HEADER_ALIASES.date_time.includes('data/ora'))
  assert.ok(AMAZON_V9_HEADER_ALIASES.date_time.includes('fecha/hora'))
  assert.ok(AMAZON_V9_HEADER_ALIASES.product_sales.includes('ventes de produits'))
  assert.ok(AMAZON_V9_HEADER_ALIASES.product_sales.includes('vendite'))
  assert.ok(AMAZON_V9_HEADER_ALIASES.product_sales.includes('ventas de productos'))
  assert.ok(AMAZON_V9_HEADER_ALIASES.fba_fees.includes('frais expédié par amazon'))
  assert.ok(AMAZON_V9_HEADER_ALIASES.fba_fees.includes('costi del servizio logistica di amazon'))
  assert.ok(AMAZON_V9_HEADER_ALIASES.fba_fees.includes('tarifas de logística de amazon'))
  assert.ok(AMAZON_V9_ROW_TYPE_ALIASES.order.includes('commande') && AMAZON_V9_ROW_TYPE_ALIASES.refund.includes('rimborso'))

  const base = { product_sales: ['product sales'] }
  const merged = mergeAmazonV9HeaderAliases(base)
  assert.equal(base.product_sales.length, 1, '合并函数不得修改原基础别名对象')
  assert.ok(merged.product_sales.includes('product sales') && merged.product_sales.includes('ventas de productos'))

  // 9 大站点 SE/PL/BE/TR/AE/SA/BR/IN/IE 全覆盖
  const expectedSites = {
    SE: ['amazon.se', 'SEK'],
    PL: ['amazon.pl', 'PLN'],
    BE: ['amazon.com.be', 'EUR'],
    TR: ['amazon.com.tr', 'TRY'],
    AE: ['amazon.ae', 'AED'],
    SA: ['amazon.sa', 'SAR'],
    BR: ['amazon.com.br', 'BRL'],
    IN: ['amazon.in', 'INR'],
    IE: ['amazon.ie', 'EUR'],
  }
  for (const [site, [domain, ccy]] of Object.entries(expectedSites)) {
    assert.ok(AMAZON_V9_SITE_MAP[site])
    assert.equal(AMAZON_V9_SITE_TO_CURRENCY[site], ccy)
    const resolved = resolveAmazonV9Site(`https://www.${domain}/`)
    assert.equal(resolved.site, site)
    assert.equal(resolved.currency, ccy)
  }

  // 2027 三大新增费用科目
  assert.equal(AMAZON_2027_FEE_PATTERNS.length, 3)
  assert.equal(classifyAmazon2027Fee('FBA Inventory Fee', 'Consolidated Aged Inventory Monthly Storage Fee').id, 'aged_monthly_storage_2027')
  assert.equal(classifyAmazon2027Fee('Service Fee', 'AWD 3.5% Fuel and Inflation Surcharge').id, 'awd_mcd_fuel_surcharge_2027')
  assert.equal(classifyAmazon2027Fee('Service Fee', 'MCD Fuel Surcharge 3.5%').surchargeRate, 0.035)
  assert.equal(classifyAmazon2027Fee('Order', 'Extra-Large Oversize Tier 5 Fulfillment Fee').id, 'oversize_6tier_fulfillment_2027')
  assert.equal(classifyAmazon2027Fee('Order', 'Standard referral fee'), null)
})

test('v0.9 Stage 3 银行回单解析与 fail-closed 5 键核销：精确核销 / 候选隔离 / 跨主体拦截 / 私户 P0 / 碰撞阻断', () => {
  // 1) 四大行通用对公回单探测与前置抬头元数据提取（招行/中行/工行/建行）
  const icbcCsv = [
    '中国工商银行企业网银电子回单明细',
    '本方户名：深圳星海跨境科技有限公司,本方账号：4000023009200128821,币种：人民币',
    '交易日期,记账日期,贷方发生额,借方发生额,手续费,对方户名,摘要,银行回单号,关联流水号',
    '2026-11-21,2026-11-21,108600.00,0.00,0.00,连连银通支付,连连结汇 LL-WD-20261121-01,ICBC-01,LL-WD-20261121-01',
    '2026-11-22,2026-11-22,0.00,5000.00,0.00,物业公司,房租支出,ICBC-02,',
    '合计,,108600.00,5000.00,0.00,,,,',
  ].join('\n')
  const icbcRows = csvToRows(icbcCsv, 'ICBC_Corp_202611.csv')
  const bankDet = detectBankReceipt(null, 'ICBC_Corp_202611.csv', icbcRows)
  assert.equal(bankDet.detected, true)
  assert.equal(bankDet.bank, 'ICBC')

  const icbcParsed = parseBankReceiptRows(icbcRows, { fileName: 'ICBC_Corp_202611.csv' })
  assert.equal(icbcParsed.creditRowCount, 1)
  assert.equal(icbcParsed.debitRowCount, 1)
  assert.equal(fmtAmount(icbcParsed.totalCreditCny), '108600.00')
  assert.equal(icbcParsed.receipts[0].accountSuffix, '8821')
  assert.equal(icbcParsed.receipts[0].accountOwnership, 'corporate')

  // 2) 非对公 / 个人私户回单必须触发 P0 阻断且绝不进入 matched 或 candidate
  const personalBankCsv = [
    '交易日期,贷方发生额,币种,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,CNY,连连银通,张三,6222020000008821,私户转账 LL-WD-20261121-01,CCB-P0-1,LL-WD-20261121-01',
  ].join('\n')
  const pBankRows = csvToRows(personalBankCsv, 'CCB_Personal.csv')
  const pBankParsed = parseBankReceiptRows(pBankRows, { fileName: 'CCB_Personal.csv' })
  assert.equal(pBankParsed.receipts[0].isPersonalOrNonCorporate, true)
  assert.ok(pBankParsed.anomalies.some((a) => a.severity === 'P0-阻断'))

  // 3) 跨主体 fail-closed 隔离：相同金额/账期/账号尾号/参考号，但企业主体不同 → 既不得 matched 也不得 candidate！
  const llCsv = [
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-WD-CROSS-01,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,USD,10000.00,30.00,-10030.00,7.2000,72000.00,Completed',
  ].join('\n')
  const [llSum] = parseV9PlatformRows('lianlian', csvToRows(llCsv, 'll.csv'), { fileName: 'll.csv' })

  const otherEntityBankCsv = [
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72000.00,CNY,0.00,连连银通,广州蓝海贸易有限公司,7559012345108821,连连国际结汇 LL-WD-CROSS-01,CMB-OTHER-1,LL-WD-CROSS-01',
  ].join('\n')
  const otherBank = parseBankReceiptRows(csvToRows(otherEntityBankCsv, 'cmb_other.csv'), { fileName: 'cmb_other.csv' })
  const crossRes = reconcileStage3([llSum], [otherBank])
  assert.equal(crossRes.stage3Status, 'pending_bank_receipt')
  assert.equal(crossRes.stage3MatchedCny, 0)
  assert.equal(crossRes.stage3CandidateMatches.length, 0, '跨主体绝对不得产生任何法定或候选匹配')

  // 4) 已知账号尾号冲突（9999 !== 8821）→ 既不可法定 matched，也必须在候选层排除已知冲突！
  const wrongAcctBankCsv = [
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72000.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345109999,连连国际结汇 LL-WD-CROSS-01,CMB-ACCT-1,LL-WD-CROSS-01',
  ].join('\n')
  const wrongAcctBank = parseBankReceiptRows(csvToRows(wrongAcctBankCsv, 'cmb_acct.csv'), { fileName: 'cmb_acct.csv' })
  const wrongAcctRes = reconcileStage3([llSum], [wrongAcctBank])
  assert.equal(wrongAcctRes.stage3Status, 'pending_bank_receipt')
  assert.equal(wrongAcctRes.stage3MatchedCny, 0)
  assert.equal(wrongAcctRes.stage3CandidateMatches.length, 0)

  // 4b) 本方账号缺失（非已知账号冲突）→ 不可法定 matched，但允许进入待人工复核参考候选
  const missingAcctBankCsv = [
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72000.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,,连连国际结汇 LL-WD-CROSS-01,CMB-NOACCT-1,LL-WD-CROSS-01',
  ].join('\n')
  const missingAcctBank = parseBankReceiptRows(csvToRows(missingAcctBankCsv, 'cmb_noacct.csv'), { fileName: 'cmb_noacct.csv' })
  const missingAcctRes = reconcileStage3([llSum], [missingAcctBank])
  assert.equal(missingAcctRes.stage3Status, 'candidate_only')
  assert.equal(missingAcctRes.stage3MatchedCny, 0)
  assert.equal(missingAcctRes.stage3CandidateMatches.length, 1)

  // 5) 重复 5 键碰撞（两张同号回单）→ fail-closed 阻断自动核销
  const dupBankCsv = [
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72000.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,连连结汇 LL-WD-CROSS-01,CMB-DUP-1,LL-WD-CROSS-01',
    '2026-11-21,72000.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,连连结汇 LL-WD-CROSS-01,CMB-DUP-2,LL-WD-CROSS-01',
  ].join('\n')
  const dupBank = parseBankReceiptRows(csvToRows(dupBankCsv, 'cmb_dup.csv'), { fileName: 'cmb_dup.csv' })
  const dupRes = reconcileStage3([llSum], [dupBank])
  assert.equal(dupRes.stage3MatchedCny, 0)
  assert.ok(dupRes.alerts.some((a) => a.includes('5 键凭证碰撞')))

  // 6) 超出银行手续费窗口（差额 5000 > 默认 500）→ 拒绝法定 matched
  const shortBankCsv = [
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,67000.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,连连结汇 LL-WD-CROSS-01,CMB-SHORT-1,LL-WD-CROSS-01',
  ].join('\n')
  const shortBank = parseBankReceiptRows(csvToRows(shortBankCsv, 'cmb_short.csv'), { fileName: 'cmb_short.csv' })
  const shortRes = reconcileStage3([llSum], [shortBank])
  assert.equal(shortRes.stage3MatchedCny, 0)

  // 7) 完美 5 键精确核销（含 80 元银行手续费）→ stage3Status === 'matched'
  const exactBankCsv = [
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,71920.00,CNY,80.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,连连国际结汇 LL-WD-CROSS-01,CMB-OK-1,LL-WD-CROSS-01',
  ].join('\n')
  const exactBank = parseBankReceiptRows(csvToRows(exactBankCsv, 'cmb_ok.csv'), { fileName: 'cmb_ok.csv' })
  const exactRes = reconcileStage3([llSum], [exactBank])
  assert.equal(exactRes.stage3Status, 'matched')
  assert.equal(exactRes.stage3MatchedCny, 71920)
  assert.equal(exactRes.bankFeeCny, 80)
  assert.equal(exactRes.fxGapOrInTransitCny, 0)
  // 脱敏校验：核销公开输出不含 HMAC/原始私钥或完整账号
  const serialized = JSON.stringify(exactRes)
  assert.equal(/entityKey|accountKey|referenceKey|7559012345108821/.test(serialized), false)
})

test('v0.9 demo:v9 全链路脱敏样例闭环 + 空表/异常输入/护城河与防原型污染边界', () => {
  const demoFiles = buildV9DemoFiles()
  assert.equal(demoFiles.length, 7)
  assert.equal(getV9DemoBuffers().length, 7)

  const salesSummaries = []
  const walletSummaries = []
  const bankBundles = []

  for (const f of demoFiles) {
    const loaded = readTabularSheetsFromBuffer(f.buffer, f.name)
    const rows = loaded.sheets[0][1]
    if (f.role === 'bank_receipt') {
      const det = detectBankReceipt(rows[0], f.name, rows)
      assert.ok(det?.detected, `${f.name} 应命中银行回单探测`)
      bankBundles.push(parseBankReceiptRows(rows, { fileName: f.name }))
    } else if (f.platform === 'amazon' || f.platform === 'worldfirst') {
      const parsed = parseStatementBuffer(f.buffer, f.name)
      for (const s of parsed) {
        if (s.role === 'settlement_wallet') walletSummaries.push(s)
        else salesSummaries.push(s)
      }
    } else {
      const det = detectV9Platform(rows[0], f.name, rows)
      assert.equal(det.platform, f.platform)
      const parsed = parseV9PlatformRows(det.platform, rows, { fileName: f.name })
      for (const s of parsed) {
        if (s.role === 'settlement_wallet') walletSummaries.push(s)
        else salesSummaries.push(s)
      }
    }
  }

  assert.equal(salesSummaries.length, 2) // Amazon + SHEIN
  assert.equal(walletSummaries.length, 3) // LianLian + PingPong + WorldFirst
  assert.equal(bankBundles.length, 2) // CMB + BOC

  // 防重复计税：合并销售 + 结汇后，销售总额只来自 Amazon + SHEIN
  const consSalesOnly = buildConsolidatedReconcile(salesSummaries, { fxRates: { USD: 7.24 } })
  const consAll = buildConsolidatedReconcile([...salesSummaries, ...walletSummaries], { fxRates: { USD: 7.24 } })
  assert.equal(consAll.totals.grossCny, consSalesOnly.totals.grossCny)
  assert.equal(consAll.totals.netSalesCny, consSalesOnly.totals.netSalesCny)

  // Stage 3 离线核销同时覆盖：2 笔精确 5 键核销 + ¥120 银行手续费 + -¥50 汇损 + 1 笔参考候选 + 2 笔在途（含万里汇 USD 6,000 = ¥43,440） + 1 笔 P0 私户拦截
  const s3 = reconcileStage3(walletSummaries, bankBundles, { fxRates: { USD: 7.24 } })
  assert.equal(s3.stage3Status, 'partial')
  assert.equal(s3.stats.matchedCount, 2)
  assert.equal(s3.stats.candidateCount, 1)
  assert.equal(s3.stats.personalWithdrawCount, 1)
  assert.equal(s3.stage2CorporateExpectedCny, 332640) // 108600 + 72300 + 72200 + 36100 + 43440 (WorldFirst)
  assert.equal(s3.stage3MatchedCny, 180780) // 108600 + 72180
  assert.equal(s3.bankFeeCny, 120)
  assert.equal(s3.fxSpreadCny, -50)
  assert.equal(s3.fxGapOrInTransitCny, 151740) // 72200 (候选) + 36100 (PingPong在途) + 43440 (WorldFirst在途)
  assert.equal(s3.inTransitUnmatchedCny, 151740)
  assert.equal(s3.personalWithdrawCny, 14460)
  assert.ok(s3.alerts.some((a) => a.includes('P0-阻断') && a.includes('个人私户')))
  assert.ok(s3.alerts.some((a) => a.includes('参考级候选匹配')))
  assert.ok(s3.alerts.some((a) => a.includes('在途')))

  // 边界测试：空表、仅表头、未知格式、原型污染键均安全 fail-closed
  assert.equal(detectV9Platform([], 'empty.csv', []), null)
  assert.deepEqual(parseV9PlatformRows('shein', [], {}), [])
  assert.deepEqual(parseV9PlatformRows('__proto__', [['a', 'b']], {}), [])
  assert.equal(detectBankReceipt([], 'empty.csv', []), null)
  const emptyBank = parseBankReceiptRows([], {})
  assert.equal(emptyBank.creditRowCount, 0)
  const emptyS3 = reconcileStage3([], [], { fxRates: JSON.parse('{"__proto__":{"polluted":1},"USD":7.2}') })
  assert.equal(({}).polluted, undefined)
  assert.equal(emptyS3.stage3Status, 'pending_bank_receipt')
  // 纯表头探测（不传数据行）对带专属列名的钱包也能工作
  assert.equal(
    detectV9Platform(['交易时间', '连连流水号', '交易类型', '平台来源', '币种', '入账金额', '提现金额', '手续费', '结汇汇率', '实收人民币', '状态'], 'lianlian.csv').platform,
    'lianlian',
  )
})

test('v0.9 对抗边界回归：脱敏尾号 ****8821 核销、跨账期在途拒配、防抢占 v0.8 钱包及护城河零泄密', async () => {
  const { readFileSync } = await import('node:fs')

  // 1) 银行回单账号打码为 ****8821 时，仍可凭 4 位尾号 + 主体 + 账期 + 参考号 + 金额完成 5 键精确核销
  const llCsv = [
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-28,LL-MASK-01,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,USD,5000.00,15.00,-5015.00,7.2000,36000.00,Completed',
  ].join('\n')
  const [llSum] = parseV9PlatformRows('lianlian', csvToRows(llCsv, 'll_mask.csv'), { fileName: 'll_mask.csv' })

  const maskedBankCsv = [
    '交易日期,记账日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,账号尾号,摘要,银行回单号,关联流水号',
    '2026-11-28,2026-11-28,36000.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,****8821,连连结汇 LL-MASK-01,CMB-M1,LL-MASK-01',
  ].join('\n')
  const maskedBank = parseBankReceiptRows(csvToRows(maskedBankCsv, 'cmb_masked.csv'), { fileName: 'cmb_masked.csv' })
  const maskRes = reconcileStage3([llSum], [maskedBank])
  assert.equal(maskRes.stage3Status, 'matched')
  assert.equal(maskRes.stage3MatchedCny, 36000)

  // 2) 跨账期在途（11 月底提现，12 月初银行到账）严守 fail-closed，绝不自动计入 11 月法定 matched
  const nextMonthBankCsv = [
    '交易日期,记账日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,账号尾号,摘要,银行回单号,关联流水号',
    '2026-12-01,2026-12-01,36000.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,****8821,连连结汇 LL-MASK-01,CMB-DEC1,LL-MASK-01',
  ].join('\n')
  const nextMonthBank = parseBankReceiptRows(csvToRows(nextMonthBankCsv, 'cmb_dec.csv'), { fileName: 'cmb_dec.csv' })
  const crossPeriodRes = reconcileStage3([llSum], [nextMonthBank])
  assert.equal(crossPeriodRes.stage3Status, 'pending_bank_receipt')
  assert.equal(crossPeriodRes.stage3MatchedCny, 0)
  assert.equal(crossPeriodRes.fxGapOrInTransitCny, 36000)

  // 3) 防抢占 v0.8 万里汇/派安盈/空中云汇（WF-/PY-/AWX- 流水不被 detectV9Platform 误认）
  const wfRows = csvToRows([
    '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,净额,状态',
    '2026-11-19,WF-20261119-01,平台回款,Amazon.com Services LLC,Amazon US,USD,33450.00,0.00,0.00,33450.00,Completed',
  ].join('\n'), 'export.csv')
  assert.equal(detectV9Platform(wfRows[0], 'export.csv', wfRows), null)
  assert.equal(detectBankReceipt(wfRows[0], 'export.csv', wfRows), null)

  // 4) 商业护城河门禁：新增源码绝不含私域会计分录/母表公式禁用词
  for (const rel of ['../lib/platforms_v9.js', '../lib/bank_receipt.js']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.equal(/借方科目|贷方科目|借：应收账款|一表通母表公式|VLOOKUP\(|SUMIFS\(/.test(src), false, `${rel} 含护城河禁用词`)
  }
})

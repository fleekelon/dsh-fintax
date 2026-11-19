import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { deflateRawSync } from 'node:zlib'
import {
  calculate,
  cbecReturnDutyExempt,
  exportRebateManufacturer,
  vatTaxpayerThreshold,
} from '../lib/calc.js'
import { parsePlatformStatement, parseStatementBuffer, fmtAmount } from '../lib/statement.js'
import { buildConsolidatedReconcile, exportDiagnosticReport, renderAnomaliesCsv } from '../lib/report.js'
import { clearHistory, computeRolling12m, deleteSnapshot, loadHistory, saveSnapshot } from '../lib/history.js'
import { createFintaxApiHandler } from '../index.js'

function makeFakeXlsx(sheets) {
  // 极简合法 .xlsx（ZIP STORE 模式），零外部依赖构造多工作表测试文件
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
  ]
  const wbSheetsXml = []
  const wbRelsXml = []
  sheets.forEach(([name, rows], idx) => {
    const id = idx + 1
    wbSheetsXml.push(`<sheet name="${name}" sheetId="${id}" r:id="rId${id}"/>`)
    wbRelsXml.push(`<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${id}.xml"/>`)
    const rowXml = rows
      .map((r, ri) => {
        const cells = r
          .map((val, ci) => {
            const col = String.fromCharCode(65 + ci)
            const esc = String(val ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            return `<c r="${col}${ri + 1}" t="inlineStr"><is><t>${esc}</t></is></c>`
          })
          .join('')
        return `<row r="${ri + 1}">${cells}</row>`
      })
      .join('')
    files.push([`xl/worksheets/sheet${id}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`])
  })
  files.push(['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheetsXml.join('')}</sheets></workbook>`])
  files.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRelsXml.join('')}</Relationships>`])

  const localChunks = []
  const centralChunks = []
  let offset = 0
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const rawBuf = Buffer.from(content, 'utf8')
    const compBuf = deflateRawSync(rawBuf)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(compBuf.length, 18)
    lh.writeUInt32LE(rawBuf.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    localChunks.push(lh, nameBuf, compBuf)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(compBuf.length, 20)
    ch.writeUInt32LE(rawBuf.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    centralChunks.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + compBuf.length
  }
  const cdBuf = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localChunks, cdBuf, eocd])
}

// ── 一、三大新算税引擎测试（场景 8~10） ───────────────────────

const eligibleReturnBatch = {
  customsCode: '9610',
  exportValueCny: 100_000,
  exportDate: '2026-03-15',
  returnDate: '2026-07-15',
  returnReason: 'customer_return',
  inOriginalCondition: true,
  isFood: false,
  refundedExportTax: 0,
  hasTaxCertificate: true,
}

test('v0.7 退运免税：9610/9810 6个月内原状退运符合2026年第16号公告免税条件', () => {
  const r = cbecReturnDutyExempt({
    ...eligibleReturnBatch,
    customsCode: '9810',
    exportValueCny: 300_000,
    tariffRate: 0.10,
    importVatRate: 0.13,
  })
  assert.equal(r.eligible, true)
  assert.equal(r.importTariff, 30_000)
  assert.equal(r.importVat, 42_900)
  assert.equal(r.totalImportTaxSaved, 72_900)
  assert.equal(r.taxPayable, 0)
  assert.ok(r.policyRefs.some((p) => p.ref.includes('2026年第16号')))
})

test('v0.7 退运免税：0110一般贸易 / 超6个月 / 食品类均触发阻断判定', () => {
  const r0110 = cbecReturnDutyExempt({ customsCode: '0110', exportValueCny: 100_000, monthsSinceExport: 2 })
  assert.equal(r0110.eligible, false)
  assert.equal(r0110.totalImportTaxSaved, 0)
  assert.ok(r0110.disqualifyReasons.some((x) => x.includes('0110')))
  assert.equal(r0110.taxPayable, null)
  assert.equal(r0110.netCashBenefit, null)
  assert.ok(r0110.warnings.some((w) => w.includes('《关税法》第 39 条')))
  assert.ok(![r0110.summaryLine, ...r0110.warnings].some((line) => line.includes('全额征税')))

  const rLate = cbecReturnDutyExempt({ customsCode: '9610', exportValueCny: 100_000, exportDate: '2026-01-10', returnDate: '2026-07-11' })
  assert.equal(rLate.eligible, false)
  assert.ok(rLate.disqualifyReasons.some((x) => x.includes('6 个月')))

  const rFood = cbecReturnDutyExempt({ customsCode: '1210', exportValueCny: 100_000, monthsSinceExport: 3, isFood: true })
  assert.equal(rFood.eligible, false)
  assert.ok(rFood.disqualifyReasons.some((x) => x.includes('食品')))
})

test('v0.7 退运免税：已办出口退税须先补缴 + 消费税组价核算', () => {
  const r = cbecReturnDutyExempt({
    ...eligibleReturnBatch,
    customsCode: '9610',
    exportValueCny: 200_000,
    exportDate: '2026-03-01',
    returnDate: '2026-09-01',
    tariffRate: 0.10,
    importVatRate: 0.13,
    consumptionTaxRate: 0.15,
    refundedExportTax: 26_000,
    exportRefundRepaid: true,
  })
  assert.equal(r.eligible, true)
  assert.equal(r.importTariff, 20_000)
  assert.ok(r.importConsumptionTax > 38_800)
  assert.equal(r.netCashBenefit, Math.round((r.totalImportTaxSaved - 26_000) * 100) / 100)
  assert.ok(r.warnings.some((w) => w.includes('已补税')))
})

test('第 16 号退运专项只适用 2026–2027 年出口申报批次，退运可跨年', () => {
  const historical = cbecReturnDutyExempt({ ...eligibleReturnBatch, exportDate: '2024-03-15', returnDate: '2024-07-15' })
  assert.equal(historical.eligibilityStatus, 'ineligible')
  assert.equal(historical.taxPayable, null)
  assert.ok(historical.warnings.some((w) => w.includes('历史专项')))

  const firstDay = cbecReturnDutyExempt({ ...eligibleReturnBatch, exportDate: '2026-01-01', returnDate: '2026-07-01' })
  assert.equal(firstDay.eligible, true)
  const lastDay = cbecReturnDutyExempt({ ...eligibleReturnBatch, exportDate: '2027-12-31', returnDate: '2028-06-30' })
  assert.equal(lastDay.eligible, true)
  assert.equal(lastDay.returnDeadline, '2028-06-30')
  const nextDay = cbecReturnDutyExempt({ ...eligibleReturnBatch, exportDate: '2028-01-01', returnDate: '2028-03-01' })
  assert.equal(nextDay.eligibilityStatus, 'ineligible')
  assert.throws(() => cbecReturnDutyExempt({ ...eligibleReturnBatch, exportDate: '2026-02-30' }), /有效日期/)
})

test('1210 以出区离境日期起算六个月并含月末截止日，须退至境内区外', () => {
  const zoneExport = {
    ...eligibleReturnBatch,
    customsCode: '1210',
    exportDate: '2026-07-31',
    zoneExitDate: '2026-08-31',
    returnDate: '2027-02-28',
    returnedOutsideZone: true,
  }
  const onDeadline = cbecReturnDutyExempt(zoneExport)
  assert.equal(onDeadline.returnDeadline, '2027-02-28')
  assert.equal(onDeadline.eligible, true)
  assert.equal(cbecReturnDutyExempt({ ...zoneExport, returnDate: '2027-03-01' }).eligible, false)
  assert.equal(cbecReturnDutyExempt({ ...zoneExport, returnedOutsideZone: false }).eligibilityStatus, 'ineligible')
  assert.equal(cbecReturnDutyExempt({ ...zoneExport, zoneExitDate: undefined }).eligibilityStatus, 'pending')
  assert.equal(cbecReturnDutyExempt({ ...zoneExport, returnedOutsideZone: undefined }).eligibilityStatus, 'pending')
  assert.throws(() => cbecReturnDutyExempt({ ...zoneExport, returnDate: '2026-08-01' }), /不得早于/)

  const direct = cbecReturnDutyExempt({ ...eligibleReturnBatch, exportDate: '2026-07-31', departureDate: '2026-08-31', returnDate: '2027-02-28' })
  assert.equal(direct.eligible, true)
  assert.equal(direct.returnDeadline, '2027-02-28')
})

test('退运缺失必填事实待核验，原因、原状、退税缴回和证明分别校验', () => {
  const legacy = cbecReturnDutyExempt({ customsCode: '9610', exportValueCny: 100_000, monthsSinceExport: 3 })
  assert.equal(legacy.eligibilityStatus, 'pending')
  assert.equal(legacy.taxPayable, null)
  assert.equal(legacy.monthsSinceExport, 3)
  assert.equal(cbecReturnDutyExempt({ ...eligibleReturnBatch, returnReason: 'unsold' }).eligible, true)
  assert.equal(cbecReturnDutyExempt({ ...eligibleReturnBatch, returnReason: 'other' }).eligibilityStatus, 'ineligible')
  assert.equal(cbecReturnDutyExempt({ ...eligibleReturnBatch, inOriginalCondition: false }).eligibilityStatus, 'ineligible')
  assert.equal(cbecReturnDutyExempt({ ...eligibleReturnBatch, isFood: 'false', inOriginalCondition: 'true' }).eligible, true)

  const unpaid = cbecReturnDutyExempt({ ...eligibleReturnBatch, refundedExportTax: 100, exportRefundRepaid: false })
  assert.equal(unpaid.eligibilityStatus, 'pending')
  assert.equal(unpaid.totalImportTaxSaved, 0)
  assert.ok(unpaid.pendingReasons.some((r) => r.includes('补缴')))
  assert.equal(cbecReturnDutyExempt({ ...eligibleReturnBatch, refundedExportTax: undefined }).eligibilityStatus, 'pending')
  assert.equal(cbecReturnDutyExempt({ ...eligibleReturnBatch, hasTaxCertificate: false }).eligibilityStatus, 'pending')
})

test('v0.7 生产企业免抵退：含内销销项、免抵税额与城建附加税高发漏报预警', () => {
  const r = exportRebateManufacturer({
    exportFobCny: 2_000_000,
    totalInputVat: 220_000,
    vatRate: 0.13,
    rebateRate: 0.13,
    domesticOutputVat: 40_000,
  })
  // 应纳税额 = 40000 - 220000 = -180000 -> 期末留抵 180000; 免抵退限额 = 260000 -> 应退 180000, 免抵 80000
  assert.equal(r.nonDeductibleToCost, 0)
  assert.equal(r.endingCredit, 180_000)
  assert.equal(r.maxRebateLimit, 260_000)
  assert.equal(r.taxRefund, 180_000)
  assert.equal(r.taxExemptOffset, 80_000)
  assert.equal(r.nextCarryover, 0)
  assert.ok(r.warnings.some((w) => w.includes('城建税')))
})

test('v0.7 生产企业免抵退：征退差转成本 + 免税购进料件抵减 + 留抵结转下期', () => {
  const r = exportRebateManufacturer({
    exportFobCny: 1_000_000,
    dutyFreeMaterialsCny: 200_000,
    totalInputVat: 150_000,
    vatRate: 0.13,
    rebateRate: 0.09,
    domesticOutputVat: 0,
    priorCreditCarryover: 10_000,
  })
  // netFob=800000; 不得免征=800000*0.04=32000; 应纳税额=-(150000-32000)-10000=-128000; 限额=800000*0.09=72000
  assert.equal(r.nonDeductibleToCost, 32_000)
  assert.equal(r.taxRefund, 72_000)
  assert.equal(r.taxExemptOffset, 0)
  assert.equal(r.nextCarryover, 56_000)

  // 内销消化完进项：直接缴税无退税
  const rPay = exportRebateManufacturer({
    exportFobCny: 500_000,
    totalInputVat: 50_000,
    domesticOutputVat: 120_000,
  })
  assert.equal(rPay.vatPayable, 70_000)
  assert.equal(rPay.taxRefund, 0)

  // 防御校验：免税料件大于离岸价抛错
  assert.throws(() => exportRebateManufacturer({ exportFobCny: 100_000, dutyFreeMaterialsCny: 120_000, totalInputVat: 10_000 }))
})

test('v0.7 500万一般纳税人临界：440万黄灯预警、进项拐点公式与超500万红灯阻断', () => {
  const r1 = vatTaxpayerThreshold({
    rolling12mTaxableSales: 4_400_000,
    projectedAnnualGrossSales: 4_800_000,
    deductibleCostRatio: 0.70,
    smallScaleRate: 0.01,
  })
  assert.equal(r1.exceeded, false)
  assert.equal(r1.remainingQuota, 600_000)
  assert.equal(r1.utilizationPct, 88)
  // 13%/13%/1% 无差别进项占比拐点 = (0.13/1.13 - 0.01/1.01) / (0.13/1.13) = 12 / 13.13 = 91.39%
  assert.equal(r1.breakevenInputPct, 91.39)
  assert.ok(r1.warnings.some((w) => w.includes('黄灯')))
  assert.ok(r1.warnings.some((w) => w.includes('免税不退税')))

  const r3 = vatTaxpayerThreshold({ rolling12mTaxableSales: 5_200_000, smallScaleRate: 0.03 })
  assert.equal(r3.exceeded, true)
  assert.equal(r3.remainingQuota, 0)
  // 13%/13%/3% 拐点 ≈ 74.71%
  assert.ok(Math.abs(r3.breakevenInputPct - 74.71) <= 0.05, `got ${r3.breakevenInputPct}`)
  assert.ok(r3.warnings.some((w) => w.includes('强制转一般纳税人红灯')))
  const warning = r3.warnings.join(' ')
  assert.match(warning, /次月的申报纳税期限内/)
  assert.match(warning, /调整之日起 10 个工作日内/)
  assert.match(warning, /超标所属期首日/)
  assert.match(warning, /第 5 个工作日/)
  assert.match(warning, /自然人/)
  assert.doesNotMatch(warning, /15 日|不得抵扣/)
})

test('小规模增值税起征点：月 100,000 元或季 300,000 元等于边界时按全额计税', () => {
  for (const [taxPeriod, threshold] of [['month', 100_000], ['quarter', 300_000]]) {
    const at = (periodTaxableSales, periodWaivedSales) => vatTaxpayerThreshold({
      rolling12mTaxableSales: 1_200_000,
      taxPeriod,
      periodTaxableSales,
      periodWaivedSales,
    }).periodSmallScale
    const below = at(threshold - 0.01)
    assert.equal(below.threshold, threshold)
    assert.equal(below.reachesThreshold, false)
    assert.equal(below.exemptSales, threshold - 0.01)
    assert.equal(below.taxBase, 0)
    assert.equal(at(threshold - 0.01, 1_000).estimatedVat, 10)

    const equal = at(threshold)
    assert.equal(equal.reachesThreshold, true)
    assert.equal(equal.exemptSales, 0)
    assert.equal(equal.taxBase, threshold)
    assert.equal(equal.estimatedVat, threshold * 0.01)
    assert.equal(at(threshold + 0.01).taxBase, threshold + 0.01)
  }
  assert.equal(vatTaxpayerThreshold({ rolling12mTaxableSales: 300_000, periodWaivedSales: 0 }).periodSmallScale, null)
  assert.throws(() => vatTaxpayerThreshold({ rolling12mTaxableSales: 300_000, taxPeriod: 'month' }), /同时填写/)
  assert.throws(() => vatTaxpayerThreshold({ rolling12mTaxableSales: 300_000, taxPeriod: 'month', periodTaxableSales: 1, periodWaivedSales: 2 }), /不得超过/)
})

test('v0.7 calculate() 分发完整覆盖全部 10 大场景', () => {
  assert.equal(calculate('cbec_return_duty_exempt', eligibleReturnBatch).eligible, true)
  assert.equal(calculate('export_rebate_manufacturer', { exportFobCny: 1_000_000, totalInputVat: 130_000 }).taxRefund, 130_000)
  assert.equal(calculate('vat_taxpayer_threshold', { rolling12mTaxableSales: 2_000_000 }).remainingQuota, 3_000_000)
  assert.throws(() => calculate('nonexistent_v7', {}), /cbec_return_duty_exempt/)
})

// ── 二、三大新平台解析器（PayPal / 速卖通 / Shopee）与沙盒测试 ──

test('v0.7 PayPal 解析：水平守恒、换汇剥离、余额坐支Meta广告、拒付与自报税全命中', () => {
  const [s] = parsePlatformStatement('demo:paypal')
  assert.equal(s.platform, 'PayPal')
  assert.equal(s.currency, 'USD')
  assert.equal(fmtAmount(s.grossSales), '16800.00')
  assert.equal(fmtAmount(s.selfRemitTaxNet), '1200.00')
  assert.equal(fmtAmount(s.customerRefund), '850.00')
  assert.equal(fmtAmount(s.inPlatformAds), '2600.00')
  assert.equal(fmtAmount(s.platformCommission), '792.00')
  assert.equal(fmtAmount(s.gatewayDisputeFee), '20.00')
  assert.equal(fmtAmount(s.actualPayout), '13738.00')
  assert.equal(fmtAmount(s.statementPayoutDiff), '0.00')
  assert.equal(s.horizontalDiffTotal, 0n)
  assert.ok(s.anomalies.some((a) => a.severity === 'P2-关注' && a.category.includes('换汇')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('余额坐支')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('拒付')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('Sales Tax')))
})

test('v0.7 PayPal 边界：篡改 Net 触发 P0 阻断 + 冻结准备金 + Pending 过滤 + 退款退手续费守恒', () => {
  const csv = [
    'Date,Name,Type,Status,Currency,Gross,Fee,Net,Sales Tax,Transaction ID,Balance Impact',
    '2026-11-01,Buyer 1,Website Payment,Completed,USD,1000.00,-40.00,960.00,0.00,TX-1,Credit',
    '2026-11-02,Buyer 1,Payment Refund,Completed,USD,-200.00,8.00,-192.00,0.00,TX-2,Debit',
    '2026-11-03,PayPal Reserve,Account Hold for Open Authorization,Completed,USD,-150.00,0.00,-150.00,0.00,TX-3,Debit',
    '2026-11-04,Pending Buyer,Express Checkout Payment,Pending,USD,999.00,0.00,999.00,0.00,TX-4,Memo',
    '2026-11-05,Tampered Row,Website Payment,Completed,USD,500.00,-20.00,450.00,0.00,TX-5,Credit',
  ].join('\n')
  const [s] = parseStatementBuffer(Buffer.from(csv, 'utf8'), 'PayPal_Edge.csv')
  assert.equal(s.platform, 'PayPal')
  assert.equal(fmtAmount(s.platformCommission), '52.00') // 40 - 8 + 20 = 52
  assert.equal(fmtAmount(s.reserveNetChange), '150.00')
  assert.equal(fmtAmount(s.uncapturedVoidExcluded), '999.00')
  assert.ok(s.anomalies.some((a) => a.severity === 'P0-阻断' && a.refId === 'TX-5'))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('准备金')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P2-关注' && a.category.includes('作废')))
})

test('v0.7 速卖通 AliExpress 解析：Choice全托管与POP混表P0拦截、IOSS代扣剥离且不与Temu误撞', () => {
  const [s] = parsePlatformStatement('demo:aliexpress')
  assert.equal(s.platform, 'AliExpress')
  assert.equal(s.currency, 'EUR')
  assert.equal(fmtAmount(s.grossSales), '29600.00') // (22000+1200) + 6400
  assert.equal(fmtAmount(s.affiliateCommission), '440.00')
  assert.equal(fmtAmount(s.facilitatorTaxStripped), '4620.00')
  assert.equal(fmtAmount(s.actualPayout), '24350.00')
  assert.equal(fmtAmount(s.statementPayoutDiff), '0.00')
  assert.equal(s.horizontalDiffTotal, 0n)
  assert.ok(s.anomalies.some((a) => a.severity === 'P0-阻断' && a.category.includes('全托管')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('违约罚款')))

  // 通用无平台关键字文件名也应精准识别为 AliExpress 而非被 Temu 误吃
  const genericCsv = [
    '入账时间,订单号,业务模式,币种,商品金额,平台佣金,联盟佣金,平台代扣税费,待自申报税,放款净额',
    '2026-11-10,ORD-1,POP自运营,USD,1000.00,80.00,20.00,100.00,50.00,950.00',
  ].join('\n')
  const [s2] = parseStatementBuffer(Buffer.from(genericCsv, 'utf8'), '202611_settlement_export.csv')
  assert.equal(s2.platform, 'AliExpress')
  assert.equal(fmtAmount(s2.selfRemitTaxNet), '50.00')
  assert.ok(s2.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('自申报')))
})

test('v0.7 Shopee 解析：运费倒挂预警、预提税 WHT、多工作表 XLSX 跳过 Summary 汇总页', () => {
  const [s] = parsePlatformStatement('demo:shopee')
  assert.equal(s.platform, 'Shopee')
  assert.equal(s.currency, 'MYR')
  assert.equal(fmtAmount(s.actualPayout), '35800.00')
  assert.equal(fmtAmount(s.statementPayoutDiff), '0.00')
  assert.equal(s.horizontalDiffTotal, 0n)
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('运费倒挂') && a.amount === '1000.00'))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('WHT') && a.amount === '450.00'))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('罚款')))

  // 构造双工作表 XLSX（Summary 汇总页在前 + Income 明细页在后），验证优先命中明细页
  const xlsxBuf = makeFakeXlsx([
    ['Summary', [['Shopee Monthly Summary', 'Total'], ['Total Released', '880.00']]],
    [
      'Income',
      [
        ['Payout Completed Date', 'Order ID', 'Site', 'Currency', 'Original Price', 'Buyer Paid Shipping Fee', 'Commission Fee', 'Actual Shipping Fee', 'Total Released Amount'],
        ['2026-11-12', 'SG-1001', 'SG', 'SGD', '1000.00', '20.00', '80.00', '60.00', '880.00'],
      ],
    ],
  ])
  const [sx] = parseStatementBuffer(xlsxBuf, 'Shopee_SG_202611.xlsx')
  assert.equal(sx.platform, 'Shopee')
  assert.equal(sx.currency, 'SGD')
  assert.equal(fmtAmount(sx.grossSales), '1020.00')
  assert.equal(sx.horizontalDiffTotal, 0n)
  assert.ok(sx.anomalies.some((a) => a.category.includes('运费倒挂') && a.amount === '40.00'))
})

test('v0.7 沙盒扩展：demo:v7 与 demo:full 多币种合并人民币总对账全通', () => {
  const v7List = parsePlatformStatement('demo:v7')
  assert.equal(v7List.length, 3)
  assert.deepEqual(v7List.map((x) => x.platform).sort(), ['AliExpress', 'PayPal', 'Shopee'])

  const cons = buildConsolidatedReconcile(v7List, {
    fxRates: { USD: 7.18, EUR: 7.82, MYR: 1.62 },
    declaredVatSalesCny: 330_000,
  })
  assert.equal(cons.ready, true)
  assert.ok(cons.totals.grossCny > 400_000)

  const fullList = parsePlatformStatement('demo:full')
  assert.equal(fullList.length, 6)
})

// ── 三、全量异常排雷 CSV 导出与公式注入防御 ───────────────────

test('v0.7 异常排雷 CSV：UTF-8 BOM、P0→P1→P2 排序、全量无截断、防 Excel 公式注入与 auto.csv 落盘', () => {
  const fakeSummaries = [
    {
      platform: 'PayPal',
      site: 'US',
      currency: 'USD',
      fileName: 'test.csv',
      rawRowCount: 30,
      grossSales: 0n,
      sellerDiscount: 0n,
      taxReportingGrossRef: 0n,
      platformSubsidy: 0n,
      customerRefund: 0n,
      totalFees: 0n,
      selfRemitTaxNet: 0n,
      actualPayout: 0n,
      horizontalDiffTotal: 0n,
      anomalies: [
        { severity: 'P2-关注', category: '换汇剥离', refId: 'FX-1', amount: '100.00', detail: '说明' },
        { severity: 'P0-阻断', category: '=CMD|"/C calc"!A0', refId: '+INJ-1', amount: '-50.00', detail: '守恒失衡' },
        ...Array.from({ length: 24 }, (_, i) => ({
          severity: 'P1-高危',
          category: `异常-${i + 1}`,
          refId: `R-${i + 1}`,
          amount: '10.00',
          detail: '含逗号,与"引号"说明',
        })),
      ],
    },
  ]
  const csv = renderAnomaliesCsv({ summaries: fakeSummaries })
  assert.ok(csv.startsWith('\uFEFF'))
  const lines = csv.trim().split('\r\n')
  // 表头 1 + 26 条全量异常（不被截断为20） + 声明行 1 = 28 行
  assert.equal(lines.length, 28)
  assert.ok(lines[1].startsWith('P0-阻断'))
  assert.ok(lines[1].includes("'=CMD"))
  assert.ok(lines[1].includes("'+INJ-1"))
  assert.ok(!csv.includes('借方科目'))

  const dir = mkdtempSync(join(tmpdir(), 'fintax-csv-'))
  try {
    const outPath = exportDiagnosticReport({
      summaries: fakeSummaries,
      consolidated: null,
      exportPath: 'auto.csv',
      firstInputPath: join(dir, 'sample.csv'),
    })
    assert.ok(outPath.endsWith('_异常排雷清单.csv'))
    assert.ok(readFileSync(outPath, 'utf8').startsWith('\uFEFF'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 四、本地脱敏历史归档 + 12 个月滚年红线 + /api/fintax/history ──

test('v0.7 本地脱敏归档：仅存摘要、滚动排除老月份及 7500 万参考和 500 万初筛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-hist-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir
  try {
    clearHistory()
    // 写入 14 个月前的老记录（应在最新 12 个月窗口外被自动滑出）
    saveSnapshot({ month: '2025-09', label: '老月份', platforms: ['Amazon'], grossCny: 90_000_000, netSalesCny: 90_000_000 })
    saveSnapshot({ month: '2026-10', label: '10月多平台', platforms: ['Amazon', 'PayPal'], grossCny: 42_000_000, refundCny: 2_000_000, netSalesCny: 40_000_000, p0Count: 1 })
    const s3 = saveSnapshot({ month: '2026-11', label: '11月黑五', platforms: ['Shopee', 'AliExpress'], grossCny: 40_000_000, refundCny: 1_000_000, netSalesCny: 39_000_000, p1Count: 2 })

    assert.equal(s3.history.length, 3)
    // 滑动窗口 2025-12 ~ 2026-11 仅统计 2026-10(4000万) + 2026-11(3900万) = 7900万（老月份 2025-09 自动滑出！）
    assert.equal(s3.rolling12m.windowStart, '2025-12')
    assert.equal(s3.rolling12m.windowEnd, '2026-11')
    assert.equal(s3.rolling12m.snapshotCount, 2)
    assert.equal(s3.rolling12m.totalNetSalesCny, 79_000_000)
    assert.equal(s3.rolling12m.cliff75mLevel, 'danger')
    assert.equal(s3.rolling12m.threshold5mLevel, 'danger')
    assert.match(s3.rolling12m.cliff75mAlert, /4% 假设下的 7,500 万元收入等值.*按主体和纳税年度核验/)

    // 删除 11 月快照后应退回安全区（4000万 < 5500万）
    const afterDel = deleteSnapshot(s3.entry.id)
    assert.equal(afterDel.deleted, true)
    assert.equal(afterDel.rolling12m.totalNetSalesCny, 40_000_000)
    assert.equal(afterDel.rolling12m.cliff75mLevel, 'safe')
    assert.equal(loadHistory().length, 2)

    // 确认 5500 万黄灯阈值
    const warn = computeRolling12m([{ id: '1', month: '2026-11', netSalesCny: 60_000_000 }])
    assert.equal(warn.cliff75mLevel, 'warn')
    assert.match(warn.cliff75mAlert, /4% 假设下 7,500 万元收入等值.*按主体和纳税年度复核/)
  } finally {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.7 后端路由端到端：/api/fintax/history CRUD、401拦截、/parse 返回 anomaliesCsv 与 demo:v7', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-api-v7-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir

  const invoke = async (handler, method, path, bodyObj) => {
    const raw = bodyObj !== undefined ? JSON.stringify(bodyObj) : ''
    const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : [])
    req.method = method
    req.url = path
    let status = 0
    let text = ''
    const res = {
      writeHead(code) { status = code },
      end(chunk) { text = String(chunk ?? '') },
    }
    await handler(req, res)
    return { status, json: JSON.parse(text) }
  }

  try {
    const okHandler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({}) }) })
    const denyHandler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ rejection: 401 }) }) })

    // 未登录禁止访问 history
    const denied = await invoke(denyHandler, 'GET', '/api/fintax/history')
    assert.equal(denied.status, 401)

    // POST /parse demo:v7 返回 3 平台 + anomaliesCsv
    const pRes = await invoke(okHandler, 'POST', '/api/fintax/parse', {
      demo: 'v7',
      fxRates: { USD: 7.18, EUR: 7.82, MYR: 1.62 },
      declaredVatSalesCny: 330_000,
    })
    assert.equal(pRes.status, 200)
    assert.equal(pRes.json.summaries.length, 3)
    assert.ok(pRes.json.anomaliesCsv.startsWith('\uFEFF'))
    assert.ok(pRes.json.anomaliesCsv.includes('PayPal'))

    // POST /history -> GET /history -> DELETE /history/:id
    const saved = await invoke(okHandler, 'POST', '/api/fintax/history', {
      month: '2026-11',
      label: 'v0.7三平台测试归档',
      platforms: ['PayPal', 'AliExpress', 'Shopee'],
      grossCny: pRes.json.consolidated.totals.grossCny,
      netSalesCny: pRes.json.consolidated.totals.netSalesCny,
      p0Count: 1,
      p1Count: 6,
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.history.length, 1)

    const listed = await invoke(okHandler, 'GET', '/api/fintax/history')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.rolling12m.snapshotCount, 1)

    const removed = await invoke(okHandler, 'DELETE', `/api/fintax/history/${saved.json.entry.id}`)
    assert.equal(removed.status, 200)
    assert.equal(removed.json.deleted, true)
    assert.equal(removed.json.history.length, 0)

    // POST /calc 验证退运专项和小规模起征点结果通过 HTTP API 返回
    const cRes = await invoke(okHandler, 'POST', '/api/fintax/calc', {
      scenario: 'cbec_return_duty_exempt',
      params: eligibleReturnBatch,
    })
    assert.equal(cRes.status, 200)
    assert.equal(cRes.json.result.eligible, true)

    const pastReturn = await invoke(okHandler, 'POST', '/api/fintax/calc', {
      scenario: 'cbec_return_duty_exempt',
      params: { ...eligibleReturnBatch, exportDate: '2024-03-15', returnDate: '2024-07-15' },
    })
    assert.equal(pastReturn.status, 200)
    assert.equal(pastReturn.json.result.eligibilityStatus, 'ineligible')
    assert.equal(pastReturn.json.result.taxPayable, null)

    const vatAtThreshold = await invoke(okHandler, 'POST', '/api/fintax/calc', {
      scenario: 'vat_taxpayer_threshold',
      params: { rolling12mTaxableSales: 1_200_000, taxPeriod: 'quarter', periodTaxableSales: 300_000 },
    })
    assert.equal(vatAtThreshold.status, 200)
    assert.equal(vatAtThreshold.json.result.periodSmallScale.taxBase, 300_000)
  } finally {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 五、补充边界防御、中文表头与 Host 工具层全链路回归 ──────

test('v0.7 PayPal 中文导出表头 + 境外物流余额坐支分类验证', () => {
  const cnCsv = [
    '日期,名称,类型,状态,币种,总额,费用,净额,销售税,交易号,余额影响',
    '2026-11-01,境外买家,快速结账付款,已完成,USD,5000.00,-220.00,4780.00,0.00,CN-PP-1,贷记',
    '2026-11-05,DHL Express Logistics,预核准付款,已完成,USD,-600.00,0.00,-600.00,0.00,CN-PP-2,借记',
    '2026-11-10,货币兑换,常规货币兑换,已完成,USD,-1000.00,0.00,-1000.00,0.00,CN-PP-3,借记',
  ].join('\n')
  const [s] = parseStatementBuffer(Buffer.from(cnCsv, 'utf8'), 'PayPal_CN_202611.csv')
  assert.equal(s.platform, 'PayPal')
  assert.equal(fmtAmount(s.grossSales), '5000.00')
  assert.equal(fmtAmount(s.logisticsWarehousing), '600.00')
  assert.equal(s.horizontalDiffTotal, 0n)
  assert.ok(s.anomalies.some((a) => a.category.includes('余额坐支') && a.detail.includes('物流费')))
  assert.ok(s.anomalies.some((a) => a.category.includes('换汇')))
})

test('v0.7 AliExpress 篡改放款净额触发 P0 阻断 + 纯 POP 无混表不误报 P0', () => {
  const tampered = [
    '入账时间,订单号,业务模式,币种,商品金额,平台佣金,放款净额',
    '2026-11-08,AE-BAD-1,POP自运营,USD,2000.00,160.00,1500.00',
  ].join('\n')
  const [sBad] = parseStatementBuffer(Buffer.from(tampered, 'utf8'), 'AliExpress_Bad.csv')
  assert.ok(sBad.anomalies.some((a) => a.severity === 'P0-阻断' && a.refId === 'AE-BAD-1'))

  const clean = [
    '入账时间,订单号,业务模式,币种,商品金额,平台佣金,放款净额',
    '2026-11-08,AE-OK-1,POP自运营,USD,2000.00,160.00,1840.00',
  ].join('\n')
  const [sOk] = parseStatementBuffer(Buffer.from(clean, 'utf8'), 'AliExpress_Clean.csv')
  assert.equal(sOk.anomalies.length, 0)
  assert.equal(sOk.horizontalDiffTotal, 0n)
})

test('v0.7 Shopee 篡改拨款额触发 P0 阻断 + 无运费倒挂健康账单零异常', () => {
  const clean = [
    'Payout Completed Date,Order ID,Site,Currency,Original Price,Buyer Paid Shipping Fee,Commission Fee,Actual Shipping Fee,Total Released Amount',
    '2026-11-12,TH-1,TH,THB,10000.00,300.00,500.00,300.00,9500.00',
  ].join('\n')
  const [sOk] = parseStatementBuffer(Buffer.from(clean, 'utf8'), 'Shopee_TH_202611.csv')
  assert.equal(sOk.platform, 'Shopee')
  assert.equal(sOk.currency, 'THB')
  assert.equal(sOk.anomalies.length, 0)

  const bad = [
    'Payout Completed Date,Order ID,Site,Currency,Original Price,Commission Fee,Total Released Amount',
    '2026-11-12,TH-BAD,TH,THB,10000.00,500.00,9000.00',
  ].join('\n')
  const [sBad] = parseStatementBuffer(Buffer.from(bad, 'utf8'), 'Shopee_TH_Bad.csv')
  assert.ok(sBad.anomalies.some((a) => a.severity === 'P0-阻断' && a.refId === 'TH-BAD'))
})

test('v0.7 新算税引擎边界防御：非法日期/负值/非法税率均严格抛错', () => {
  assert.throws(() => cbecReturnDutyExempt({ exportValueCny: 0, monthsSinceExport: 2 }))
  assert.throws(() => cbecReturnDutyExempt({ exportValueCny: 1000, exportDate: '2026-08-01', returnDate: '2026-03-01' }))
  assert.throws(() => cbecReturnDutyExempt({ exportValueCny: 1000, monthsSinceExport: 2, consumptionTaxRate: 1 }))
  assert.throws(() => exportRebateManufacturer({ exportFobCny: -100, totalInputVat: 10 }))
  assert.throws(() => vatTaxpayerThreshold({ rolling12mTaxableSales: 1000, deductibleCostRatio: 1.5 }))
})

test('v0.7 Host 工具层端到端：fintax_calc 3大新场景 + fintax_parse_statement demo:v7 + auto.csv', async () => {
  const { apply } = await import('../index.js')
  const tools = new Map()
  const skills = []
  apply({
    tools: { register: (t) => tools.set(t.name, t) },
    skills: { register: (s) => skills.push(s) },
    logger: { info() {}, warn() {} },
  })
  assert.equal(tools.size, 6)
  assert.equal(skills.length, 4)

  const calcTool = tools.get('fintax_calc')
  const outRet = await calcTool.execute({ scenario: 'cbec_return_duty_exempt', params: { ...eligibleReturnBatch, customsCode: '9810' } })
  assert.ok(outRet.includes('2026年第16号') && outRet.includes('符合'))

  const outMfg = await calcTool.execute({ scenario: 'export_rebate_manufacturer', params: { exportFobCny: 1_000_000, totalInputVat: 110_000, domesticOutputVat: 20_000 } })
  assert.ok(outMfg.includes('免抵税额') && outMfg.includes('城建税'))

  const outThr = await calcTool.execute({ scenario: 'vat_taxpayer_threshold', params: { rolling12mTaxableSales: 4_500_000 } })
  assert.ok(outThr.includes('500 万') && outThr.includes('91.39%'))

  const parseTool = tools.get('fintax_parse_statement')
  const dir = mkdtempSync(join(tmpdir(), 'fintax-tool-v7-'))
  try {
    const csvPath = join(dir, 'v7_anoms.csv')
    const outParse = await parseTool.execute({
      file_path: 'demo:v7',
      fx_rates: { USD: 7.18, EUR: 7.82, MYR: 1.62 },
      declared_vat_sales_cny: 330_000,
      export_report_path: csvPath,
    })
    assert.ok(outParse.includes('PayPal') && outParse.includes('AliExpress') && outParse.includes('Shopee'))
    assert.ok(readFileSync(csvPath, 'utf8').startsWith('\uFEFF'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.7 归档边界校验：非正销售额拒存 + 不存在快照删除安全返回 false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-hist-edge-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir
  try {
    assert.throws(() => saveSnapshot({ month: '2026-11', grossCny: 0, netSalesCny: 0 }))
    assert.throws(() => deleteSnapshot(''))
    const d = deleteSnapshot('snap_not_exists')
    assert.equal(d.deleted, false)
    assert.equal(d.rolling12m.snapshotCount, 0)
  } finally {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.7 护城河回归：全量源码与 CSV 模板严禁泄露私域母表公式或凭证分录模板', () => {
  const csv = renderAnomaliesCsv({ summaries: parsePlatformStatement('demo:full') })
  for (const forbidden of ['借方科目', '贷方科目', '一表通母表公式', 'VLOOKUP(', 'SUMIFS(']) {
    assert.ok(!csv.includes(forbidden), `不应出现护城河敏感词: ${forbidden}`)
  }
})

test('v0.7 PayPal 多币种自动拆表（USD + EUR 同文件）', () => {
  const multiCcy = [
    'Date,Name,Type,Status,Currency,Gross,Fee,Net,Sales Tax,Transaction ID,Balance Impact',
    '2026-11-01,US Buyer,Express Checkout Payment,Completed,USD,1000.00,-44.00,956.00,0.00,MC-1,Credit',
    '2026-11-02,EU Buyer,Express Checkout Payment,Completed,EUR,2000.00,-80.00,1920.00,0.00,MC-2,Credit',
  ].join('\n')
  const list = parseStatementBuffer(Buffer.from(multiCcy, 'utf8'), 'PayPal_Multi.csv')
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((x) => x.currency).sort(), ['EUR', 'USD'])
  assert.equal(list.find((x) => x.currency === 'EUR').site, 'EU')
})

test('v0.7 Shopee 高面值东南亚币种（VND/IDR）BigInt 定点零精度丢失', () => {
  const vndCsv = [
    'Payout Completed Date,Order ID,Site,Currency,Original Price,Commission Fee,Total Released Amount',
    '2026-11-15,VN-9988,VN,VND,1250000000.00,62500000.00,1187500000.00',
  ].join('\n')
  const [s] = parseStatementBuffer(Buffer.from(vndCsv, 'utf8'), 'Shopee_VN_202611.csv')
  assert.equal(s.currency, 'VND')
  assert.equal(fmtAmount(s.grossSales), '1250000000.00')
  assert.equal(fmtAmount(s.theoreticalPayout), '1187500000.00')
  assert.equal(s.horizontalDiffTotal, 0n)
})

test('v0.7 ZIP 压缩包混合 PayPal + AliExpress + Shopee 免解压直拖全解析', () => {
  // 复用简单 ZIP 打包器将三个平台的 CSV 打包进一个 .zip
  const entries = [
    ['PayPal_202611.csv', 'Date,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID,Balance Impact\n2026-11-02,Buyer,Express Checkout Payment,Completed,USD,3000.00,-120.00,2880.00,Z-1,Credit'],
    ['AliExpress_202611.csv', '入账时间,订单号,业务模式,币种,商品金额,平台佣金,放款净额\n2026-11-03,Z-AE-1,POP自运营,EUR,4000.00,320.00,3680.00'],
    ['Shopee_SG_202611.csv', 'Payout Completed Date,Order ID,Site,Currency,Original Price,Commission Fee,Total Released Amount\n2026-11-04,Z-SP-1,SG,SGD,5000.00,350.00,4650.00'],
  ]
  const local = []
  const central = []
  let off = 0
  for (const [name, txt] of entries) {
    const nb = Buffer.from(name, 'utf8')
    const raw = Buffer.from(txt, 'utf8')
    const comp = deflateRawSync(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26)
    local.push(lh, nb, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42)
    central.push(ch, nb)
    off += lh.length + nb.length + comp.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16)
  const zipBuf = Buffer.concat([...local, cd, eocd])

  const parsed = parseStatementBuffer(zipBuf, '202611_all_channels.zip')
  assert.equal(parsed.length, 3)
  assert.deepEqual(parsed.map((x) => x.platform).sort(), ['AliExpress', 'PayPal', 'Shopee'])
})

test('v0.7.1 API /status 返回候选版本与 /history?id=xxx 查询参数删除兼容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-status-v7-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir
  const handler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({}) }) })
  const call = async (method, url, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body), 'utf8')] : [])
    req.method = method; req.url = url
    let status = 0; let out = ''
    await handler(req, { writeHead(c) { status = c }, end(s) { out = String(s ?? '') } })
    return { status, json: JSON.parse(out) }
  }
  try {
    const st = await call('GET', '/api/fintax/status')
    assert.equal(st.status, 200)
    assert.equal(st.json.version, '0.7.1')
    const saved = await call('POST', '/api/fintax/history', { month: '2026-11', grossCny: 500_000, netSalesCny: 480_000 })
    const del = await call('DELETE', `/api/fintax/history?id=${encodeURIComponent(saved.json.entry.id)}`)
    assert.equal(del.status, 200)
    assert.equal(del.json.deleted, true)
  } finally {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.7 算税高级口径参数：platform_tax_reconcile 代理人净额法与准备金/补贴联动', () => {
  const r = calculate('platform_tax_reconcile', {
    reportedGrossRevenue: 1_000_000,
    refunds: 50_000,
    platformFees: 120_000,
    subsidies: 20_000,
    selfRemitTaxNet: 30_000,
    reserveChange: 40_000,
    actualPayout: 840_000,
    principalRole: 'agent',
  })
  // 理论放款 = 100万 - 5万 + 2万 - 12万 + 3万 - 4万 = 84万 -> 精确轧平 0
  assert.equal(r.payoutReconciliation.unexplainedCashGap, 0)
  assert.ok(r.steps.some((s) => s.includes('代理人')))
})

test('v0.7 归档隐私守卫：传入原始明细字段会被过滤，绝不落盘到 fintax_history.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-priv-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir
  try {
    saveSnapshot({
      month: '2026-11',
      label: '隐私测试',
      grossCny: 100_000,
      netSalesCny: 95_000,
      rawOrders: [{ buyerName: 'SENSITIVE_BUYER_PII', cardLast4: '9999' }],
    })
    const diskText = readFileSync(join(dir, 'fintax_history.json'), 'utf8')
    assert.ok(!diskText.includes('SENSITIVE_BUYER_PII'))
    assert.ok(!diskText.includes('rawOrders'))
  } finally {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  }
})

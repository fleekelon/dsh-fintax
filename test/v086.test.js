import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { deflateRawSync } from 'node:zlib'
import { apply, createFintaxApiHandler } from '../index.js'
import { annualBonusIit, calculate, cbecAssessedCit, exportRebateCancelImpact, CalcInputError } from '../lib/calc.js'
import { excelSerialToIsoDate, fmtAmount, parsePlatformStatement, parseStatementBuffer } from '../lib/statement.js'
import { buildConsolidatedReconcile, renderDiagnosticReportHtml, renderDiagnosticReportMd } from '../lib/report.js'
import { clearImaCache, searchImaKnowledge } from '../lib/ima.js'
import { withLocalWriteLock, writeLocalJson } from '../lib/local_store.js'

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildMiniZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    const comp = deflateRawSync(raw)
    const crc = crc32(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    localParts.push(lh, nameBuf, comp)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    centralParts.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, cd, eocd])
}

function mockApiCall(handler, method, urlPath, bodyObj, admitted = true) {
  return new Promise((resolve, reject) => {
    const raw = bodyObj !== undefined ? JSON.stringify(bodyObj) : ''
    const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : [])
    req.method = method
    req.url = urlPath
    req.headers = { 'content-type': 'application/json' }
    let statusCode = 0
    const chunks = []
    const res = {
      writeHead(code) { statusCode = code },
      end(data) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'))
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* ignore */ }
        resolve({ statusCode, text, json })
      },
    }
    Promise.resolve(handler(req, res, { admitted })).catch(reject)
  })
}

test('v0.8.6 UI 回归：暗黑主题适配 data-ds-dark-theme、11 大算税表单与参考级候选配对展示', () => {
  const clientCode = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(clientCode.includes('body[data-ds-dark-theme] .ftx-root'))
  assert.ok(clientCode.includes('[data-ds-dark-theme] .ftx-root'))
  assert.ok(clientCode.includes('export_rebate_cancel_impact'))
  assert.ok(clientCode.includes('annualComprehensiveTaxableIncome'))
  assert.ok(clientCode.includes('candidateMatches'))
  assert.ok(clientCode.includes('参考级候选配对'))
  assert.ok(!clientCode.includes('10 大确定性'))
})

test('v0.8.6 XLSX Excel 序列号日期还原（styles.xml 内置/自定义日期格式 + 1900/1904 日期系统）', () => {
  assert.equal(excelSerialToIsoDate(46320, false), '2026-10-25')
  assert.equal(excelSerialToIsoDate(46345.5, false), '2026-11-19')
  assert.equal(excelSerialToIsoDate(44858, true), '2026-10-25')

  const xlsx = buildMiniZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Order details" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': `<styleSheet>
      <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
      <cellXfs count="3">
        <xf numFmtId="0"/>
        <xf numFmtId="14" applyNumberFormat="1"/>
        <xf numFmtId="164" applyNumberFormat="1"/>
      </cellXfs>
    </styleSheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
      <row r="1">
        <c r="A1" t="inlineStr"><is><t>Statement date</t></is></c>
        <c r="B1" t="inlineStr"><is><t>Type</t></is></c>
        <c r="C1" t="inlineStr"><is><t>Order/adjustment ID</t></is></c>
        <c r="D1" t="inlineStr"><is><t>Currency</t></is></c>
        <c r="E1" t="inlineStr"><is><t>Gross sales</t></is></c>
        <c r="F1" t="inlineStr"><is><t>TikTok Shop commission fee</t></is></c>
        <c r="G1" t="inlineStr"><is><t>Total settlement amount</t></is></c>
      </row>
      <row r="2">
        <c r="A2" s="1"><v>46331</v></c>
        <c r="B2" t="inlineStr"><is><t>Order</t></is></c>
        <c r="C2" t="inlineStr"><is><t>TT-9001</t></is></c>
        <c r="D2" t="inlineStr"><is><t>USD</t></is></c>
        <c r="E2"><v>100.00</v></c>
        <c r="F2"><v>-15.00</v></c>
        <c r="G2"><v>85.00</v></c>
      </row>
      <row r="3">
        <c r="A3" s="2"><v>46345</v></c>
        <c r="B3" t="inlineStr"><is><t>Order</t></is></c>
        <c r="C3" t="inlineStr"><is><t>TT-9002</t></is></c>
        <c r="D3" t="inlineStr"><is><t>USD</t></is></c>
        <c r="E3"><v>200.00</v></c>
        <c r="F3"><v>-30.00</v></c>
        <c r="G3"><v>170.00</v></c>
      </row>
    </sheetData></worksheet>`,
  })

  const sums = parseStatementBuffer(xlsx, 'tiktok_serial_dates.xlsx')
  assert.equal(sums.length, 1)
  assert.equal(sums[0].platform, 'TikTok Shop')
  assert.equal(sums[0].period, '2026-11')
  assert.equal(sums[0].horizontalDiffTotal, 0n)
})

test('v0.8.6 双轨一/二段候选配对：严格 5 键零回归、脱敏参考级候选配对并在 HTML/MD 展示', () => {
  const summaries = parsePlatformStatement('demo:v8')
  const consolidated = buildConsolidatedReconcile(summaries, { fxRates: { USD: 7.25, EUR: 7.85 } })
  const fc = consolidated.fundChain

  // 法定 5 键口径零回归
  assert.equal(fc.stage1to2Status, 'pending_evidence')
  assert.equal(fc.stage1to2GapCny, null)

  // 参考级候选配对生效且脱敏
  assert.ok(Array.isArray(fc.candidateMatches) && fc.candidateMatches.length >= 2)
  assert.ok(fc.candidateMatchSummary)
  assert.ok(fc.candidateMatchSummary.count >= 2)
  assert.ok(fc.candidateMatchSummary.note.includes('参考级候选配对'))
  const json = JSON.stringify(consolidated)
  assert.equal(/entityKey|accountKey|referenceKey|private-(?:entity|wallet|reference)/.test(json), false)

  const html = renderDiagnosticReportHtml({ summaries, consolidated, version: '0.8.6' })
  const md = renderDiagnosticReportMd({ summaries, consolidated, version: '0.8.6' })
  assert.ok(html.includes('参考级候选配对'))
  assert.ok(md.includes('参考级候选配对'))
})

test('v0.8.6 /api/fintax/calc 参数错误透传（HTTP 400 明确中文提示且无堆栈泄露）', async () => {
  const handler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: {} }) }) })
  const bad = await mockApiCall(handler, 'POST', '/api/fintax/calc', {
    scenario: 'export_rebate_cancel_impact',
    params: { purchaseGrossCny: 0, exportFobCny: 135.6 },
  })
  assert.equal(bad.statusCode, 400)
  assert.ok(bad.json.error.includes('purchaseGrossCny'))
  assert.equal(bad.json.error.includes('at '), false)

  const ok = await mockApiCall(handler, 'POST', '/api/fintax/calc', {
    scenario: 'export_rebate_cancel_impact',
    params: { purchaseGrossCny: 113, exportFobCny: 135.6, oldRebateRate: 0.06, newRebateRate: 0 },
  })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.result.oldGrossProfit, 28.6)
  assert.equal(ok.json.result.newGrossProfit, 20)
  assert.equal(ok.json.result.profitDelta, -8.6)
})

test('v0.8.6 第 11 大引擎 export_rebate_cancel_impact：2026#11 视同内销、成品充电宝豁免与 CMA 报告门禁', () => {
  const base = calculate('export_rebate_cancel_impact', {
    purchaseGrossCny: 113,
    exportFobCny: 135.6,
    vatRate: 0.13,
    oldRebateRate: 0.06,
    newRebateRate: 0,
  })
  assert.equal(base.newMode, 'deemed_domestic_vat')
  assert.equal(base.oldGrossProfit, 28.6)
  assert.equal(base.newGrossProfit, 20)
  assert.equal(base.profitDelta, -8.6)
  assert.equal(base.requiredFobToKeepProfit, 145.32)
  assert.equal(base.fobRaisePct, 7.17)

  const powerBank = exportRebateCancelImpact({
    purchaseGrossCny: 113,
    exportFobCny: 135.6,
    isConsumptionTaxItem: true,
    isFinishedPowerBank: true,
    consumptionTaxRate: 0.02,
  })
  assert.equal(powerBank.consumptionTaxApplies, false)
  assert.equal(powerBank.domesticConsumptionTaxRef, 0)
  assert.equal(powerBank.cmaRiskExtraTax, 0)
  assert.ok(powerBank.warnings.some((w) => w.includes('成品充电宝') && w.includes('不在电池消费税征税范围')))

  const batteryNoCma = exportRebateCancelImpact({
    purchaseGrossCny: 113000,
    exportFobCny: 135600,
    isConsumptionTaxItem: true,
    isFinishedPowerBank: false,
    consumptionTaxRate: 0.02,
    hasValidCmaReport: false,
  })
  assert.equal(batteryNoCma.consumptionTaxApplies, true)
  assert.equal(batteryNoCma.domesticConsumptionTaxRef, 2000)
  assert.equal(batteryNoCma.cmaRiskExtraTax, 2000)
  assert.ok(batteryNoCma.warnings.some((w) => w.includes('CMA') && w.includes('2027-04-01')))
  assert.ok(batteryNoCma.warnings.some((w) => w.includes('出口消费税退（免）税政策')))

  const nevReduced = exportRebateCancelImpact({
    purchaseGrossCny: 113000,
    exportFobCny: 140000,
    oldRebateRate: 0.13,
    newRebateRate: 0.09,
  })
  assert.equal(nevReduced.newMode, 'reduced_rebate')
  assert.equal(nevReduced.profitDelta, -4000)

  const exemptOnly = exportRebateCancelImpact({
    purchaseGrossCny: 113,
    exportFobCny: 135.6,
    oldRebateRate: 0.06,
    newRebateRate: 0,
    cancelAppliesDeemedDomesticVat: false,
  })
  assert.equal(exemptOnly.newMode, 'exempt_no_refund')
  assert.equal(exemptOnly.newGrossProfit, 22.6)
})

test('v0.8.6 年终奖双轨比选：兼容旧入参 + 负剩余扣除推荐并入 + 高薪推荐单独', () => {
  const legacy = annualBonusIit({ bonus: 36001 })
  assert.equal(legacy.dualTrack, null)
  assert.equal(legacy.trap.boundary, 36000)

  // 年薪不足基本扣除（综合所得应纳税所得额 -20,000）+ 奖金 36,000 → 并入综合所得仅缴 (16,000)*3% = 480，比单独 1080 省 600
  const lowIncome = annualBonusIit({ bonus: 36000, annualComprehensiveTaxableIncome: -20000 })
  assert.ok(lowIncome.dualTrack)
  assert.equal(lowIncome.dualTrack.recommendedMethod, 'combined')
  assert.equal(lowIncome.dualTrack.totalTaxSeparate, 1080)
  assert.equal(lowIncome.dualTrack.totalTaxCombined, 480)
  assert.equal(lowIncome.dualTrack.taxSaving, 600)

  // 高薪（年薪 360,000，基本扣除 60,000，社保 40,000，专项附加 24,000 → 综合应纳税所得额 236,000）+ 奖金 36,000 → 单独计税大幅更省
  const highIncome = annualBonusIit({
    bonus: 36000,
    annualSalary: 360000,
    basicDeduction: 60000,
    socialInsurance: 40000,
    specialAdditionalDeduction: 24000,
  })
  assert.ok(highIncome.dualTrack)
  assert.equal(highIncome.dualTrack.recommendedMethod, 'separate')
  assert.ok(highIncome.dualTrack.taxSaving > 5000)
})

test('v0.8.6 综试区 4% 核定：300 万小微超崖税负跳变对照与 9810 次年 4 月核算期提示', () => {
  const under = cbecAssessedCit({ revenue: 75_000_000, assessedQualificationConfirmed: true })
  assert.ok(under.cliffComparison)
  assert.equal(under.cliffComparison.taxAt3mSmallLowProfit, 150000)
  assert.equal(under.cliffComparison.taxJustOver3m, 750000.25)
  assert.equal(under.cliffComparison.cliffJumpAtPlusOneYuan, 600000.25)
  assert.equal(under.cliffComparison.exceeded3m, false)
  assert.ok(under.warnings.some((w) => w.includes('9810') && w.includes('次年 4 月')))

  const over = cbecAssessedCit({ revenue: 80_000_000, assessedQualificationConfirmed: true })
  assert.equal(over.cliffComparison.exceeded3m, true)
  assert.equal(over.cliffComparison.overCliffExtraTaxVs3m, 650000)
  assert.ok(over.summaryLine.includes('已超 300 万'))
})

test('v0.8.6 ima_read 分段续读 offset 参数（8000 字切片 + hasMore/nextOffset + 非法 offset 拦截）', async (t) => {
  const saved = [process.env.IMA_CLIENT_ID, process.env.IMA_API_KEY]
  process.env.IMA_CLIENT_ID = 'fake-client-v086'
  process.env.IMA_API_KEY = 'fake-key-v086'
  clearImaCache()
  t.after(() => {
    clearImaCache()
    for (const [idx, key] of ['IMA_CLIENT_ID', 'IMA_API_KEY'].entries()) {
      if (saved[idx] === undefined) delete process.env[key]
      else process.env[key] = saved[idx]
    }
  })

  const longDoc = `${'A'.repeat(8000)}${'B'.repeat(450)}`
  t.mock.method(globalThis, 'fetch', (url) => {
    const u = String(url)
    if (u.includes('get_media_info')) {
      return Promise.resolve(new Response(JSON.stringify({
        code: 0,
        data: { title: '长政策原文', media_type: 11, notebook_ext_info: { notebook_id: 'nb-long-1' } },
      })))
    }
    if (u.includes('get_doc_content')) {
      return Promise.resolve(new Response(JSON.stringify({ code: 0, data: { content: longDoc } })))
    }
    return Promise.resolve(new Response(JSON.stringify({ code: 0, data: {} })))
  })

  const tools = new Map()
  apply({
    tools: { register: (tool) => tools.set(tool.name, tool) },
    skills: { register: () => {} },
  })
  const imaRead = tools.get('ima_read')
  assert.ok(imaRead)

  const page1 = await imaRead.execute({ media_id: 'doc-long-1' })
  assert.match(page1, /hasMore: true, nextOffset: 8000/)
  assert.match(page1, /offset=8000/)
  assert.ok(page1.includes('A'.repeat(200)))

  const page2 = await imaRead.execute({ media_id: 'doc-long-1', offset: 8000 })
  assert.match(page2, /hasMore: false, nextOffset: null/)
  assert.ok(page2.includes('B'.repeat(200)))

  const badOffset = await imaRead.execute({ media_id: 'doc-long-1', offset: -10 })
  assert.match(badOffset, /offset 必须为 0 至 2000000 的整数/)
})

test('v0.8.6 IMA V2.4.2 新增热点短词回退与大小写去重（CMA/充电宝/年终奖/9610试点/FIOR/ViDA/2026#162）', async (t) => {
  const saved = [process.env.IMA_CLIENT_ID, process.env.IMA_API_KEY]
  process.env.IMA_CLIENT_ID = 'fake-client-v086-ima'
  process.env.IMA_API_KEY = 'fake-key-v086-ima'
  clearImaCache()
  t.after(() => {
    clearImaCache()
    for (const [idx, key] of ['IMA_CLIENT_ID', 'IMA_API_KEY'].entries()) {
      if (saved[idx] === undefined) delete process.env[key]
      else process.env[key] = saved[idx]
    }
  })

  const queries = []
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    const body = JSON.parse(init.body)
    queries.push(body.query)
    return Promise.resolve(new Response(JSON.stringify({ code: 0, data: { info_list: [] } })))
  })

  await searchImaKnowledge({ query: '欧盟ViDA与美线FIOR和CTPAT合规、9610试点1%预缴怎么看？', knowledge_base_id: 'kb1' }, { noCache: true, retries: 0 })
  const fb1 = queries.slice(1)
  assert.ok(fb1.length >= 2 && fb1.length <= 3)
  assert.equal(new Set(fb1.map((x) => x.toLowerCase())).size, fb1.length)

  queries.length = 0
  await searchImaKnowledge({ query: '成品充电宝是否交电池消费税？CMA报告要求是什么？', knowledge_base_id: 'kb1' }, { noCache: true, retries: 0 })
  const fb2 = queries.slice(1)
  assert.ok(fb2.includes('电池') || fb2.includes('消费税') || fb2.includes('CMA') || fb2.includes('充电宝'))
})

test('v0.8.6 健壮性：Temu/速卖通/Shopee 费用冲回保符号、结汇对公后缀扩展、过期 .lock 自愈', () => {
  // Temu 手续费冲回（正数费用返还 = 退回费用）水平守恒为 0
  const temuCsv = [
    'Settlement Date,Order ID,Fulfillment Mode,Transaction Type,Site,Currency,Product Retail Price,Refund Amount,Platform Service Fee,Fulfillment Fee,Net Settlement',
    '2026-11-05,TM-1,Semi Managed,Order,US,USD,100.00,0.00,-10.00,-5.00,85.00',
    '2026-11-06,TM-2,Semi Managed,Fee Rebate,US,USD,0.00,0.00,3.00,0.00,3.00',
  ].join('\n')
  const temu = parseStatementBuffer(Buffer.from(temuCsv, 'utf8'), 'temu_rebate.csv')[0]
  assert.equal(temu.platform, 'Temu')
  assert.equal(temu.horizontalDiffTotal, 0n)

  // AliExpress 费用返还保符号
  const aeCsv = [
    'Settlement Time,Order ID,Currency,Order Amount,Refund Amount,Platform Commission,Cainiao Shipping Fee,Affiliate Commission,IOSS VAT,Escrow Amount',
    '2026-11-05,AE-1,USD,200.00,0.00,-16.00,-4.00,-2.00,0.00,178.00',
    '2026-11-06,AE-2,USD,0.00,0.00,2.00,0.00,0.00,0.00,2.00',
  ].join('\n')
  const ae = parseStatementBuffer(Buffer.from(aeCsv, 'utf8'), 'aliexpress_rebate.csv')[0]
  assert.equal(ae.platform, 'AliExpress')
  assert.equal(ae.horizontalDiffTotal, 0n)

  // 结汇扩展对公后缀（个体工商户 / 商行 / GmbH / Pte）识别为对公，但私户与坐支（Supplier）仍优先拦截
  const wfCsv = [
    '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,净变动,状态',
    '2026-11-01,W1,平台回款,Amazon,US Payout,USD,10000.00,0.00,0.00,10000.00,Completed',
    '2026-11-02,W2,提现,义乌市星河百货商行(个体工商户),货款提现,USD,0.00,3000.00,0.00,-3000.00,Completed',
    '2026-11-03,W3,提现,Starlight Europe GmbH,Corporate settlement,USD,0.00,2000.00,0.00,-2000.00,Completed',
    '2026-11-04,W4,提现,王五个人账户(个体工商户),私户,USD,0.00,1000.00,0.00,-1000.00,Completed',
    '2026-11-05,W5,提现,Starlight Europe GmbH,Supplier payment,USD,0.00,500.00,0.00,-500.00,Completed',
  ].join('\n')
  const wf = parseStatementBuffer(Buffer.from(wfCsv, 'utf8'), 'wf_corp_suffix.csv')[0]
  assert.equal(fmtAmount(wf.walletMetrics.fxWithdrawToCorporate), '5000.00')
  assert.equal(fmtAmount(wf.walletMetrics.fxWithdrawToPersonal), '1000.00')
  assert.equal(fmtAmount(wf.walletMetrics.directSpend), '500.00')

  // 过期 .lock 自愈 vs 新鲜 .lock 阻断
  const dir = mkdtempSync(join(tmpdir(), 'fintax-lock-'))
  try {
    const dataFile = join(dir, 'state.json')
    const lockFile = `${dataFile}.lock`
    writeFileSync(lockFile, 'stale', 'utf8')
    const past = new Date(Date.now() - 120_000)
    utimesSync(lockFile, past, past)
    withLocalWriteLock(dataFile, () => writeLocalJson(dataFile, { ok: 1 }), { staleMs: 30_000, retries: 0 })
    assert.deepEqual(JSON.parse(readFileSync(dataFile, 'utf8')), { ok: 1 })

    writeFileSync(lockFile, 'fresh', 'utf8')
    assert.throws(() => withLocalWriteLock(dataFile, () => writeLocalJson(dataFile, { ok: 2 }), { staleMs: 30_000, retries: 0 }), { code: 'LOCAL_DATA_BUSY' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.8.6 口径与护城河门禁：零错误电池口径、零 --profile default、零私域字典/分录泄露', () => {
  const files = [
    '../lib/calc.js',
    '../lib/calc_extra.js',
    '../lib/calc_shared.js',
    '../lib/report.js',
    '../lib/statement.js',
    '../lib/ima.js',
    '../index.js',
    '../client.js',
    '../README.md',
    '../skills/fintax-calc/SKILL.md',
    '../skills/fintax-crossborder-check/SKILL.md',
    '../skills/fintax-mode-select/SKILL.md',
    '../skills/fintax-policy-qa/SKILL.md',
  ]
  for (const rel of files) {
    const content = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.equal(content.includes('--profile default'), false, `${rel} 不得含 --profile default`)
    assert.equal(content.includes('CTPAT-certified'), false, `${rel} 应使用 CTPAT-validated`)
    assert.equal(/充电宝[^。\n]{0,12}恢复征收|对成品充电宝征收消费税/.test(content), false, `${rel} 含错误充电宝消费税口径`)
    assert.equal(/借方科目|贷方科目|借：应收账款|VLOOKUP\(|SUMIFS\(/.test(content), false, `${rel} 含私域护城河敏感内容`)
  }
  assert.ok(new CalcInputError('test') instanceof Error)
})

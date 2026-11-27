import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, createFintaxApiHandler } from '../index.js'
import { calculate, calculateTax, CROSSBORDER_CALC_SPECS } from '../lib/calc.js'
import { fmtAmount, parsePlatformStatement, parseStatementBuffer } from '../lib/statement.js'
import {
  buildConsolidatedReconcile,
  renderAnomaliesCsv,
  renderDiagnosticReportHtml,
  renderDiagnosticReportMd,
  serializeSummary,
} from '../lib/report.js'
import { clearImaCache } from '../lib/ima.js'
import { loadHistory, saveSnapshot } from '../lib/history.js'

function mockApiCall(handler, method, urlPath, bodyObj, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = bodyObj !== undefined ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)) : ''
    const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : [])
    req.method = method
    req.url = urlPath
    req.headers = { 'content-type': 'application/json', ...headers }
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
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

function useIsolatedConfig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-v09-int-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir
  t.after(() => {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('v0.9 集成 1：demo:v9 全链路解析 → Stage 3 五键核销 → HTML/MD/CSV 报表与零敏感泄露', async () => {
  const summaries = parsePlatformStatement('demo:v9')
  assert.equal(summaries.length, 7)
  assert.equal(summaries.filter((s) => s.role === 'sales_platform').length, 2)
  assert.equal(summaries.filter((s) => s.role === 'settlement_wallet').length, 3)
  assert.equal(summaries.filter((s) => s.role === 'bank_receipt').length, 2)

  const consolidated = buildConsolidatedReconcile(summaries, { fxRates: { USD: 7.24 } })
  assert.equal(consolidated.ready, true)
  const salesOnly = buildConsolidatedReconcile(summaries.filter((s) => s.role === 'sales_platform'), { fxRates: { USD: 7.24 } })
  // 防重复计税：加入 3 钱包 + 2 银行回单后，销售报送总额分毫不差
  assert.equal(consolidated.totals.grossCny, salesOnly.totals.grossCny)
  assert.equal(consolidated.totals.netSalesCny, salesOnly.totals.netSalesCny)

  const fc = consolidated.fundChain
  assert.ok(fc && fc.stage3)
  assert.equal(fc.bankReceiptCount, 2)
  assert.equal(fc.bankReceivedCny, 180780)
  assert.equal(fc.stage3VerificationStatus, 'partial')
  assert.equal(fc.stage3.stage3Status, 'partial')
  assert.equal(fc.stage3.stage2CorporateExpectedCny, 332640)
  assert.equal(fc.stage3.stage3MatchedCny, 180780)
  assert.equal(fc.stage3.bankFeeCny, 120)
  assert.equal(fc.stage3.fxSpreadCny, -50)
  assert.equal(fc.stage3.fxGapOrInTransitCny, 151740)
  assert.equal(fc.stage3.inTransitUnmatchedCny, 151740)
  assert.equal(fc.stage3.personalWithdrawCny, 14460)
  assert.equal(fc.stage3.matchedMatches.length, 2)
  assert.equal(fc.stage3.stage3CandidateMatches.length, 1)

  const html = renderDiagnosticReportHtml({ summaries, consolidated })
  const md = renderDiagnosticReportMd({ summaries, consolidated })
  const csv = renderAnomaliesCsv({ summaries, consolidated })
  for (const doc of [html, md]) {
    assert.ok(doc.includes('国内对公银行入账回单汇总'))
    assert.ok(doc.includes('Stage 3'))
    assert.ok(doc.includes('180,780.00') || doc.includes('180780.00'))
    assert.ok(doc.includes('120.00'))
    assert.ok(doc.includes('参考级候选'))
    // 默认纯洁零推广
    assert.ok(!doc.includes('扩展参考附页'))
    assert.ok(!doc.includes('一表通母表'))
  }
  assert.ok(csv.includes('Stage 3 参考级候选回单'))
  assert.ok(csv.includes('Stage 3 结汇在途'))
  assert.ok(csv.includes('银行实收/手续费/汇损汇总'))

  const publicDump = JSON.stringify({ consolidated, summaries: summaries.map(serializeSummary) }) + html + md + csv
  assert.equal(/entityKey|accountKey|referenceKey|7559012345108821|7497654321006612/.test(publicDump), false)

  // 工具层 fintax_parse_statement 也完整支持 demo:v9
  const tools = new Map()
  apply({ tools: { register: (tool) => tools.set(tool.name, tool) }, skills: { register: () => {} } })
  const toolOut = await tools.get('fintax_parse_statement').execute({ file_path: 'demo:v9', fx_rates: { USD: 7.24 } })
  assert.ok(toolOut.includes('国内对公银行入账回单摘要'))
  assert.ok(toolOut.includes('Stage 3 银行实收离线核销'))
  assert.ok(toolOut.includes('180780.00'))
})

test('v0.9 集成 2：Amazon FR/IT/ES 表头、SE/PL/BE/TR/AE/SA/BR/IN/IE 站点与 2027 FBA 新费用端到端解析', () => {
  const frCsv = [
    '"Includes Amazon FR transactions"',
    '"date/heure","numéro de versement","type","numéro de la commande","description","marketplace","ventes de produits","frais de vente","frais expédié par amazon","autre","total"',
    '"2026-11-05","SET-FR-1","Commande","402-1001","Article A","amazon.se","1000.00","-150.00","-100.00","0.00","750.00"',
    '"2026-11-08","SET-FR-1","Frais de service","","AWD 3.5% Fuel and Inflation Surcharge","amazon.se","0.00","0.00","0.00","-35.00","-35.00"',
    '"2026-11-09","SET-FR-1","Frais de stock expédié par Amazon","","Consolidated Aged Inventory Monthly Storage Fee","amazon.se","0.00","0.00","0.00","-65.00","-65.00"',
    '"2026-11-10","SET-FR-1","Commande","402-1002","Extra-Large Oversize Tier 5 Fulfillment Fee","amazon.se","500.00","-75.00","-120.00","0.00","305.00"',
  ].join('\n')

  const [sum] = parseStatementBuffer(Buffer.from(frCsv, 'utf8'), 'Amazon_SE_FR_202611.csv')
  assert.equal(sum.platform, 'Amazon')
  assert.equal(sum.site, 'SE')
  assert.equal(sum.currency, 'SEK')
  assert.equal(sum.horizontalDiffTotal, 0n)
  assert.equal(fmtAmount(sum.grossSales), '1500.00')
  // AWD 3.5% (35) + Aged Storage (65) + FBA fees (100 + 120) = 320.00 全部归入物流仓储费
  assert.equal(fmtAmount(sum.logisticsWarehousing), '320.00')
  assert.equal(fmtAmount(sum.platformCommission), '225.00')
  assert.equal(sum.amazon2027Fees.length, 3)
  assert.ok(sum.anomalies.some((a) => a.category.includes('AWD/MCD 3.5%')))
  assert.ok(sum.anomalies.some((a) => a.category.includes('库龄月度仓储费')))
  assert.ok(sum.anomalies.some((a) => a.category.includes('6 级 Oversize')))
})

test('v0.9 集成 3：POST /parse (demo:v9) + cacheToken + POST /parse/export 缓存极速导出与 404 过期/跨会话隔离', async () => {
  let fakeNow = 1_700_000_000_000
  const handler = createFintaxApiHandler({
    getConnection: () => ({ admit: (req) => ({ peer: { sessionId: req.headers['x-session'] || 'sess-A' } }) }),
    parseCacheOptions: { ttlMs: 60_000, now: () => fakeNow },
  })

  // 1) POST /parse demo:v9 返回 cacheToken 与完整 fundChain.stage3
  const parsed = await mockApiCall(handler, 'POST', '/api/fintax/parse', {
    demo: 'demo:v9',
    reportFormat: 'data',
    fxRates: { USD: 7.24 },
  }, { 'x-session': 'sess-A' })
  assert.equal(parsed.statusCode, 200)
  assert.equal(parsed.json.ok, true)
  assert.match(parsed.json.cacheToken, /^[0-9a-f]{32}$/)
  assert.equal(parsed.json._rawSummaries, undefined, '严禁向客户端泄露内部 _rawSummaries')
  assert.equal(parsed.json.consolidated.fundChain.stage3.stage3MatchedCny, 180780)
  assert.equal(parsed.json.consolidated.fundChain.stage3.bankFeeCny, 120)
  assert.equal(parsed.json.consolidated.fundChain.stage3.stage3CandidateMatches.length, 1)
  const bankSummaries = parsed.json.summaries.filter((s) => s.role === 'bank_receipt')
  assert.ok(bankSummaries.length >= 2, 'demo:v9 应返回多份 bank_receipt 脱敏摘要')
  assert.ok(bankSummaries.every((s) => s.creditRowCount >= 1 && Number(s.totalCreditCny) > 0 && s.receipts === undefined), '严禁向前端透传原始银行回单明细')
  const totalBankFee = bankSummaries.reduce((acc, s) => acc + Number(s.totalBankFeeCny || 0), 0)
  assert.ok(totalBankFee >= 120, `银行回单手续费合计应 >= 120，实际 ${totalBankFee}`)

  // 2) POST /parse/export 命中缓存导出 HTML / MD / CSV（免重传 20 MiB Base64）
  for (const [fmt, expectedMime, marker] of [
    ['html', 'text/html; charset=utf-8', 'Stage 3 国内对公银行回单离线核销'],
    ['md', 'text/markdown; charset=utf-8', 'Stage 3 银行实收离线核销'],
    ['csv', 'text/csv; charset=utf-8', 'Stage 3 参考级候选回单'],
  ]) {
    const exp = await mockApiCall(handler, 'POST', '/api/fintax/parse/export', {
      cacheToken: parsed.json.cacheToken,
      format: fmt,
      includeResourceAppendix: false,
    }, { 'x-session': 'sess-A' })
    assert.equal(exp.statusCode, 200)
    assert.equal(exp.json.ok, true)
    assert.equal(exp.json.format, fmt)
    assert.equal(exp.json.mimeType, expectedMime)
    assert.equal(exp.json.fromCache, true)
    assert.ok(exp.json.filename.endsWith('.' + fmt))
    assert.ok(exp.json.content.includes(marker))
  }

  // 3) 跨会话 scopeKey 访问必须返回 404 CACHE_EXPIRED
  const crossSess = await mockApiCall(handler, 'POST', '/api/fintax/parse/export', {
    cacheToken: parsed.json.cacheToken,
    format: 'html',
  }, { 'x-session': 'sess-B' })
  assert.equal(crossSess.statusCode, 404)
  assert.equal(crossSess.json.ok, false)
  assert.equal(crossSess.json.error, 'CACHE_EXPIRED')

  // 4) TTL 过期后返回 404 CACHE_EXPIRED
  fakeNow += 61_000
  const expired = await mockApiCall(handler, 'POST', '/api/fintax/parse/export', {
    cacheToken: parsed.json.cacheToken,
    format: 'html',
  }, { 'x-session': 'sess-A' })
  assert.equal(expired.statusCode, 404)
  assert.equal(expired.json.error, 'CACHE_EXPIRED')

  // 5) 原 /parse 带 exportFormat 向后兼容
  const legacyExport = await mockApiCall(handler, 'POST', '/api/fintax/parse', {
    demo: 'v9',
    exportFormat: 'md',
    fxRates: { USD: 7.24 },
  }, { 'x-session': 'sess-A' })
  assert.equal(legacyExport.statusCode, 200)
  assert.ok(legacyExport.json.reportMd.includes('Stage 3'))
})

test('v0.9 集成 4：/status 能力宣告、/calc/specs 与 14 大算税引擎（HTTP + calculateTax + 工具层）', async () => {
  const handler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: {} }) }) })

  const st = await mockApiCall(handler, 'GET', '/api/fintax/status')
  assert.equal(st.statusCode, 200)
  assert.equal(st.json.version, '0.9.1')
  assert.equal(st.json.supportedChannels, 17)
  assert.equal(st.json.calcEngineCount, 14)
  assert.deepEqual(st.json.capabilities, {
    stage3BankReconcile: true,
    annualSummary: true,
    parseCache: true,
    imaQuickDrawer: true,
    archiveBackup: true,
    entityReassign: true,
    dshMarketUpdateV1: true,
  })

  const specs = await mockApiCall(handler, 'GET', '/api/fintax/calc/specs')
  assert.equal(specs.statusCode, 200)
  assert.equal(specs.json.calcEngineCount, 14)
  assert.equal(specs.json.specs.length, 14)
  assert.equal(specs.json.scenarios.length, 14)
  for (const cbCode of CROSSBORDER_CALC_SPECS.map((s) => s.code)) {
    assert.ok(specs.json.scenarios.includes(cbCode), `/calc/specs 必须包含 ${cbCode}`)
  }

  // 3 大新增跨境算税引擎 HTTP + calculateTax 全闭环
  const eu = await mockApiCall(handler, 'POST', '/api/fintax/calc', {
    scenario: 'eu_low_value_parcel',
    params: { sellingPriceEur: 35.7, vatRate: 0.19, hsLineCount: 2, purchaseCostEur: 7, directShippingEur: 4, returnRate: 0.08, targetMarginRate: 0.15 },
  })
  assert.equal(eu.statusCode, 200)
  assert.equal(eu.json.result.scenarioCode, 'eu_low_value_parcel')
  assert.equal(eu.json.result.currency, 'EUR')
  assert.ok(eu.json.result.minSellingPriceEur > 35.7)

  const us = await mockApiCall(handler, 'POST', '/api/fintax/calc', {
    scenario: 'us_t86_vs_9810_ddp',
    params: {
      sellingPriceUsd: 39.99, purchaseCostUsd: 8, declaredValueUsd: 10, tariffRate: 0.45,
      type11ShippingUsd: 9.5, type11ClearanceFeeUsd: 3.5, ddpFirstLegUsd: 2.2, localDeliveryUsd: 5.4,
      ieepaPaidUsd: 10000, tariffProgram: 'Section301', entryPeriodStart: '2025-03-01', entryPeriodEnd: '2026-01-31', aceAchBound: false,
    },
  })
  assert.equal(us.statusCode, 200)
  assert.equal(us.json.result.ieepaEligibleRefundUsd, 0)
  assert.ok(us.json.result.warnings.some((w) => w.includes('ACE ACH')))
  assert.ok(us.json.result.warnings.some((w) => w.includes('CTPAT-validated')))

  const fba = await mockApiCall(handler, 'POST', '/api/fintax/calc', {
    scenario: 'fba_mixed_procurement_split',
    params: { totalExportCny: 500000, invoicedPurchaseGrossCny: 339000, noInvoicePurchaseCny: 100000 },
  })
  assert.equal(fba.statusCode, 200)
  assert.equal(fba.json.result.scenarioCode, 'fba_mixed_procurement_split')
  assert.equal(calculateTax('fba_mixed_procurement_split', { totalExportCny: 500000, invoicedPurchaseGrossCny: 339000, noInvoicePurchaseCny: 100000 }).invoicedVatRefundCny, fba.json.result.invoicedVatRefundCny)

  // 字段级错因透传 HTTP 400
  const bad = await mockApiCall(handler, 'POST', '/api/fintax/calc', { scenario: 'eu_low_value_parcel', params: { sellingPriceEur: -1 } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json.code, 'INVALID_CALC_INPUT')
  assert.ok(bad.json.error.includes('sellingPriceEur'))

  // 工具层 fintax_calc 支持 14 引擎
  const tools = new Map()
  apply({ tools: { register: (tool) => tools.set(tool.name, tool) }, skills: { register: () => {} } })
  const calcOut = await tools.get('fintax_calc').execute({ scenario: 'eu_low_value_parcel', params: { sellingPriceEur: 35.7, hsLineCount: 2 } })
  assert.ok(calcOut.includes('欧盟'))
  assert.ok(calculate('vat', { amount: 113, rate: 0.13 }).taxAmount === 13)
})

test('v0.9 集成 5：v4 归档字段落盘 + /history/annual (JSON/HTML/MD) + /history/reassign (409 冲突/强制覆盖) + /history/backup (防篡改/防原型污染)', async (t) => {
  useIsolatedConfig(t)
  const handler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: {} }) }) })

  // 1) 通过 /parse 解析销售+连连+招行回单，提交 /history 验证 v4 新字段自动落盘
  const amzCsv = [
    '"date/time","settlement id","type","order id","marketplace","product sales","selling fees","fba fees","other","total"',
    '"2026-11-05","SET-1","Order","114-1","amazon.com","10000.00","-1500.00","-1000.00","0.00","7500.00"',
    '"2026-11-18","SET-1","Transfer","","amazon.com","0.00","0.00","0.00","-7500.00","-7500.00"',
  ].join('\n')
  const llCsv = [
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,主体编号,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-19,LL-IN-1,平台回款,Amazon,Amazon.com,,ENT-A,USD,7500.00,0.00,0.00,7500.00,,,Completed',
    '2026-11-21,LL-WD-1,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,ENT-A,USD,0.00,7000.00,20.00,-7020.00,7.2000,50400.00,Completed',
  ].join('\n')
  const bankCsv = [
    '交易日期,记账日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,2026-11-21,50350.00,0.00,CNY,50.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-A,连连结汇 LL-WD-1,CMB-1,LL-WD-1',
  ].join('\n')

  const parsed = await mockApiCall(handler, 'POST', '/api/fintax/parse', {
    reportFormat: 'data',
    fxRates: { USD: 7.2 },
    fxConfirmed: true,
    files: [
      { name: 'amz.csv', dataBase64: Buffer.from(amzCsv).toString('base64') },
      { name: 'LianLian_202611.csv', dataBase64: Buffer.from(llCsv).toString('base64') },
      { name: 'CMB_BankReceipt_202611.csv', dataBase64: Buffer.from(bankCsv).toString('base64') },
    ],
  })
  assert.equal(parsed.statusCode, 200)
  assert.ok(parsed.json.archiveToken)
  assert.equal(parsed.json.archiveMonth, '2026-11')

  const saved = await mockApiCall(handler, 'POST', '/api/fintax/history', {
    month: '2026-11',
    entityName: '深圳星海跨境科技有限公司',
    storeScope: 'Amazon-US主店',
    archiveToken: parsed.json.archiveToken,
    conflictMode: 'check',
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json.entry.stage2WalletInboundCny, 54000)
  assert.equal(saved.json.entry.stage3BankReceivedCny, 50350)
  assert.equal(saved.json.entry.stage3Verified, true)
  assert.deepEqual(saved.json.entry.sites, ['US'])
  assert.deepEqual(saved.json.entry.currencies, ['USD'])
  assert.equal(saved.json.entry.usSalesUsd, 10000)
  assert.equal(saved.json.entry.platformBreakdown.length, 1)

  // 写入 1 条待认领快照（同月同店用于测试 409 冲突，另一条 2026-10 用于成功认领）
  const unclaimedCollision = saveSnapshot({
    month: '2026-11', entityName: '待认领', storeScope: 'Amazon-US主店',
    platforms: ['Amazon'], grossCny: 60000, netSalesCny: 58000, payoutCny: 45000,
  }).entry
  const unclaimedClean = saveSnapshot({
    month: '2026-10', entityName: '待认领', storeScope: 'Amazon-EU副店',
    platforms: ['Amazon'], sites: ['DE'], currencies: ['EUR'], euSalesEur: 5000,
    grossCny: 39000, netSalesCny: 38000, payoutCny: 30000,
  }).entry

  // 2) GET /history/annual JSON / HTML / MD
  const annJson = await mockApiCall(handler, 'GET', '/api/fintax/history/annual?year=2026')
  assert.equal(annJson.statusCode, 200)
  assert.equal(annJson.json.summary.year, 2026)
  assert.equal(annJson.json.summary.hasUnclaimed, true)
  assert.equal(annJson.json.summary.quarters.length, 4)
  assert.equal(annJson.json.summary.threeJurisdictions.cards.length, 3)

  const annHtml = await mockApiCall(handler, 'GET', '/api/fintax/history/annual?year=2026&format=html&includeResourceAppendix=false')
  assert.equal(annHtml.statusCode, 200)
  assert.equal(annHtml.json.format, 'html')
  assert.equal(annHtml.json.mimeType, 'text/html; charset=utf-8')
  assert.ok(annHtml.json.content.includes('2027-01-31'))
  assert.ok(!annHtml.json.content.includes('扩展参考附页'))

  const annMd = await mockApiCall(handler, 'GET', '/api/fintax/history/annual?year=2026&format=md')
  assert.equal(annMd.statusCode, 200)
  assert.equal(annMd.json.format, 'md')
  assert.equal(annMd.json.mimeType, 'text/markdown; charset=utf-8')
  assert.ok(annMd.json.content.includes('Q4'))

  // 3) POST /history/reassign：无冲突成功认领 + 碰撞返回 409 + force: true 覆盖成功
  const okReassign = await mockApiCall(handler, 'POST', '/api/fintax/history/reassign', {
    archiveId: unclaimedClean.id,
    entityLabel: '深圳星海跨境科技有限公司',
    shopLabel: 'Amazon-EU副店',
  })
  assert.equal(okReassign.statusCode, 200)
  assert.equal(okReassign.json.ok, true)
  assert.equal(okReassign.json.entry.entityLabel, '深圳星海跨境科技有限公司')

  const conflictReassign = await mockApiCall(handler, 'POST', '/api/fintax/history/reassign', {
    archiveId: unclaimedCollision.id,
    entityLabel: '深圳星海跨境科技有限公司',
    shopLabel: 'Amazon-US主店',
  })
  assert.equal(conflictReassign.statusCode, 409)
  assert.equal(conflictReassign.json.conflict, true)

  const forceReassign = await mockApiCall(handler, 'POST', '/api/fintax/history/reassign', {
    archiveId: unclaimedCollision.id,
    entityLabel: '深圳星海跨境科技有限公司',
    shopLabel: 'Amazon-US主店',
    force: true,
  })
  assert.equal(forceReassign.statusCode, 200)
  assert.equal(forceReassign.json.overwritten, true)

  // 4) GET/POST /history/backup：导出 + merge_skip + 篡改 checksum 400 + 原型污染 400
  const exported = await mockApiCall(handler, 'GET', '/api/fintax/history/backup')
  assert.equal(exported.statusCode, 200)
  assert.match(exported.json.filename, /^dsh-fintax-history-backup-\d{8}\.json$/)
  assert.match(exported.json.backup.checksum, /^[0-9a-f]{64}$/)

  const skipImport = await mockApiCall(handler, 'POST', '/api/fintax/history/backup', {
    backup: exported.json.backup,
    mode: 'merge_skip',
    verifyChecksum: true,
  })
  assert.equal(skipImport.statusCode, 200)
  assert.equal(skipImport.json.skipped, exported.json.backup.recordCount)

  const tampered = structuredClone(exported.json.backup)
  tampered.records[0].grossCny += 999
  const tamperedRes = await mockApiCall(handler, 'POST', '/api/fintax/history/backup', { backup: tampered, verifyChecksum: true })
  assert.equal(tamperedRes.statusCode, 400)
  assert.equal(tamperedRes.json.code, 'BACKUP_CHECKSUM_MISMATCH')

  const protoPayload = '{"backup":{"schemaVersion":"dsh-fintax-backup-v1","records":[],"__proto__":{"polluted":true}}}'
  const protoRes = await mockApiCall(handler, 'POST', '/api/fintax/history/backup', protoPayload)
  assert.equal(protoRes.statusCode, 400)
  assert.equal(({}).polluted, undefined)
  assert.ok(loadHistory().length >= 2)
})

test('v0.9 集成 6：POST /ima-quick（未配置提示 + 160 字截断护城河 + limit 上限 8 + 未鉴权 401）', async (t) => {
  useIsolatedConfig(t)
  const savedEnv = [process.env.IMA_CLIENT_ID, process.env.IMA_API_KEY, process.env.IMA_DEFAULT_KB_ID]
  delete process.env.IMA_CLIENT_ID
  delete process.env.IMA_API_KEY
  delete process.env.IMA_DEFAULT_KB_ID
  clearImaCache()
  t.after(() => {
    clearImaCache()
    for (const [idx, key] of ['IMA_CLIENT_ID', 'IMA_API_KEY', 'IMA_DEFAULT_KB_ID'].entries()) {
      if (savedEnv[idx] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[idx]
    }
  })

  // 未鉴权拦截 401
  const unauth = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ rejection: 401 }) }) })
  for (const [m, p] of [
    ['GET', '/api/fintax/calc/specs'],
    ['POST', '/api/fintax/parse/export'],
    ['GET', '/api/fintax/history/annual'],
    ['POST', '/api/fintax/history/reassign'],
    ['GET', '/api/fintax/history/backup'],
    ['POST', '/api/fintax/ima-quick'],
  ]) {
    const r = await mockApiCall(unauth, m, p, m === 'POST' ? {} : undefined)
    assert.equal(r.statusCode, 401, `${m} ${p} 未鉴权必须返回 401`)
  }

  const handler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: {} }) }) })

  // 1) 未配置 IMA 凭证 → 200 { ok: true, configured: false, hits: [], message }
  const uncfg = await mockApiCall(handler, 'POST', '/api/fintax/ima-quick', { query: '欧盟2欧处理费' })
  assert.equal(uncfg.statusCode, 200)
  assert.equal(uncfg.json.ok, true)
  assert.equal(uncfg.json.configured, false)
  assert.deepEqual(uncfg.json.hits, [])
  assert.ok(uncfg.json.message.includes('IMA Client ID'))

  // 2) 已配置凭证 → 校验 limit 锁死 8 + 每条严格仅含 3 白名单纯文本字段 { title, folderPath, snippet } + snippet <= 160 字且三字段均剥离 URL/HTML/控制符
  process.env.IMA_CLIENT_ID = 'v09-ima-cid'
  process.env.IMA_API_KEY = 'v09-ima-key'
  process.env.IMA_DEFAULT_KB_ID = 'kb-v09-main'
  const longText = `<b>核心摘要</b> ${'欧盟低值包裹2欧元处理费退货不退且IOSS不代收。'.repeat(15)} https://secret.cos.myqcloud.com/full-formula.xlsx`
  const fakeItems = Array.from({ length: 12 }, (_, idx) => ({
    media_id: `doc-${idx + 1}`,
    title: `<b>政策条目 ${idx + 1}</b> https://evil.test/title\u0007`,
    kb_id: 'kb-v09-main',
    parent_folder_name: '<i>01-跨境政策/欧盟</i> https://evil.test/folder\u0000',
    highlight_content: longText,
    update_time: '2026-11-26',
    url_info: { url: 'https://ima.qq.com/secret/download' },
    content: 'FULL_SECRET_TEXT_SHOULD_NEVER_APPEAR',
  }))
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(JSON.stringify({ code: 0, data: { info_list: fakeItems } }))))

  const quick = await mockApiCall(handler, 'POST', '/api/fintax/ima-quick', { query: '欧盟2欧', limit: 99 })
  assert.equal(quick.statusCode, 200)
  assert.equal(quick.json.ok, true)
  assert.equal(quick.json.configured, true)
  assert.equal(quick.json.hits.length, 8, 'limit 上限必须锁死 8')
  assert.ok(quick.json.disclaimer)
  for (const hit of quick.json.hits) {
    assert.deepEqual(Object.keys(hit).sort(), ['folderPath', 'snippet', 'title'])
    assert.ok(hit.snippet.length <= 160, `snippet 必须 <= 160 字，实际 ${hit.snippet.length}`)
    for (const val of [hit.title, hit.folderPath, hit.snippet]) {
      assert.equal(/https?:\/\//i.test(val), false)
      assert.equal(/<[a-z][^>]*>/i.test(val), false)
      assert.equal(/[\p{Cc}\p{Cf}]/u.test(val), false)
    }
  }
  assert.equal(JSON.stringify(quick.json).includes('FULL_SECRET_TEXT'), false)
  assert.equal(JSON.stringify(quick.json).includes('secret/download'), false)
})

test('v0.9 集成 7：50,000 行 Amazon 性能不退化 + Track D 全量口径与护城河门禁', () => {
  const N = 50_000
  const lines = new Array(N + 1)
  lines[0] = 'date/time,settlement id,type,order id,sku,description,quantity,marketplace,fulfillment,product sales,shipping credits,promotional rebates,marketplace withheld tax,selling fees,fba fees,other transaction fees,other,total'
  for (let i = 1; i <= N; i++) {
    lines[i] = `2026-11-15 08:00:00 UTC,SET-V9-50K,Order,ORD-${i},SKU-${i % 100},Item,1,amazon.com,Amazon,100.00,0.00,0.00,0.00,-15.00,0.00,0.00,0.00,85.00`
  }
  const buf = Buffer.from(lines.join('\n'), 'utf8')
  const t0 = performance.now()
  const summaries = parseStatementBuffer(buf, 'Amazon_V9_50K_2026-11.csv')
  const consolidated = buildConsolidatedReconcile(summaries, { fxRates: { USD: 7.20 } })
  const elapsedMs = Math.round(performance.now() - t0)
  assert.equal(summaries[0].rawRowCount, N)
  assert.equal(summaries[0].horizontalDiffTotal, 0n)
  assert.equal(consolidated.totals.grossCny, 36_000_000)
  assert.ok(elapsedMs < 15_000, `50,000 行端到端耗时应 < 15s，实际 ${elapsedMs}ms`)
  console.log(`  [v0.9 benchmark] 50,000 行 Amazon 解析+对账总耗时：${elapsedMs} ms`)

  // 零依赖检查 + Track D 文件口径与护城河门禁
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '0.9.1')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.scripts['build:client'], 'node scripts/build-client.mjs')
  assert.equal(pkg.scripts['check:client'], 'node scripts/build-client.mjs --check')

  for (const rel of [
    '../index.js', '../lib/calc.js', '../lib/statement.js', '../lib/report.js',
    '../README.md', '../CHANGELOG.md', '../docs/plugin-index.json',
    '../skills/fintax-calc/SKILL.md', '../skills/fintax-crossborder-check/SKILL.md',
    '../skills/fintax-mode-select/SKILL.md', '../skills/fintax-policy-qa/SKILL.md',
  ]) {
    const content = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.equal(content.includes('--profile default'), false, `${rel} 不得含 --profile default`)
    assert.equal(content.includes('CTPAT-certified'), false, `${rel} 不得含 CTPAT-certified`)
    assert.equal(/(?:>=|≥)\s*500\s*万/.test(content), false, `${rel} 不得将一般纳税人门槛误写为 >=500 万`)
    assert.equal(/充电宝[^。\n]{0,12}恢复征收|对成品充电宝征收消费税/.test(content), false, `${rel} 不得含错误充电宝消费税口径`)
    assert.equal(/借方科目|贷方科目|借：应收账款|一表通母表公式|VLOOKUP\(|SUMIFS\(/.test(content), false, `${rel} 含护城河禁词`)
  }
})

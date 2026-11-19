import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parsePlatformStatement, parseStatementBuffer, fmtAmount } from '../lib/statement.js'
import {
  buildConsolidatedReconcile,
  renderAnomaliesCsv,
  renderDiagnosticReportHtml,
  renderDiagnosticReportMd,
  renderRollingTrendReportHtml,
  serializeSummary,
} from '../lib/report.js'
import { loadFintaxSettings, sanitizeCustomFxRates, saveFintaxSettings } from '../lib/ima.js'
import { computeRolling12m, saveSnapshot } from '../lib/history.js'
import { apply, createFintaxApiHandler } from '../index.js'

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

test('v0.8 万里汇 WorldFirst：多币种拆表、对公/私户/坐支分类、换汇剥离、大额滞留与篡改阻断', () => {
  const csv = [
    '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,净变动,状态',
    '2026-11-05,WF-01,平台回款,Amazon.com Services LLC,US Settlement,USD,50000.00,0.00,0.00,50000.00,Completed',
    '2026-11-08,WF-02,结汇提现,深圳星海跨境科技有限公司(对公基本户),货款结汇回流对公户,USD,0.00,20000.00,60.00,-20060.00,Completed',
    '2026-11-09,WF-03,提现,张三个人储蓄卡,个人私户提现,USD,0.00,3000.00,15.00,-3015.00,Completed',
    '2026-11-10,WF-04,余额直付,Meta Platforms Ireland,Facebook Ads,USD,0.00,2000.00,0.00,-2000.00,Completed',
    '2026-11-11,WF-05,内部换汇,WorldFirst FX Conversion,USD to EUR,USD,0.00,1500.00,0.00,-1500.00,Completed',
    '2026-11-12,WF-06,平台回款,Amazon EU Sarl,EU Settlement,EUR,10000.00,0.00,0.00,9000.00,Completed',
  ].join('\n')

  const sums = parseStatementBuffer(Buffer.from(csv, 'utf8'), 'WorldFirst_202611.csv')
  assert.equal(sums.length, 2)
  const usd = sums.find((s) => s.currency === 'USD')
  const eur = sums.find((s) => s.currency === 'EUR')
  assert.equal(usd.platform, 'WorldFirst')
  assert.equal(usd.role, 'settlement_wallet')
  // 绝不计入销售报送毛额
  assert.equal(fmtAmount(usd.taxReportingGrossRef), '0.00')
  assert.equal(fmtAmount(usd.walletMetrics.platformInbound), '50000.00')
  assert.equal(fmtAmount(usd.walletMetrics.fxWithdrawToCorporate), '20000.00')
  assert.equal(fmtAmount(usd.walletMetrics.fxWithdrawToPersonal), '3000.00')
  assert.equal(fmtAmount(usd.walletMetrics.directSpend), '2000.00')
  assert.equal(fmtAmount(usd.walletMetrics.walletFees), '75.00')
  assert.equal(fmtAmount(usd.walletMetrics.internalFxStripped), '1500.00')
  // 滞留未结汇 = 50000 - 20000 - 3000 - 2000 - 75 - 1500(内部换汇卖出) = 23425.00（占 46.85% >= 35% 触发滞留预警）
  assert.equal(fmtAmount(usd.walletMetrics.unrepatriatedNet), '23425.00')
  assert.ok(usd.anomalies.some((a) => a.severity === 'P0-阻断' && a.category.includes('个人私户')))
  assert.ok(usd.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('坐支')))
  assert.ok(usd.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('滞留未结汇')))
  assert.ok(usd.anomalies.some((a) => a.severity === 'P2-关注' && a.category.includes('换汇')))
  // EUR 行篡改净变动触发水平守恒 P0 阻断
  assert.ok(eur.horizontalDiffTotal > 0n)
  assert.ok(eur.anomalies.some((a) => a.severity === 'P0-阻断' && a.category.includes('水平守恒')))
})

test('v0.8 派安盈 Payoneer：平台入账、私户 P0、独立年费行与 Pending 过滤', () => {
  const csv = [
    'Date,Transaction ID,Type,Description,Counterparty,Currency,Amount,Fee,Status',
    '2026-11-02,PY-1,Incoming,Payment from Amazon US,Amazon.com,USD,18000.00,0.00,Completed',
    '2026-11-05,PY-2,Withdrawal,Withdraw to Bank Account,"Guangzhou Haoyun Trading Co., Ltd.",USD,-14000.00,140.00,Completed',
    '2026-11-06,PY-3,Withdrawal,Withdraw to Private Account,Li Si Personal Bank,USD,-2500.00,25.00,Completed',
    '2026-11-07,PY-4,Fee,Annual Account Fee,Payoneer,USD,-29.95,0.00,Completed',
    '2026-11-08,PY-5,Incoming,Payment from Walmart,Walmart,USD,4000.00,0.00,Pending',
  ].join('\n')

  const sums = parseStatementBuffer(Buffer.from(csv, 'utf8'), 'Payoneer_Statement_202611.csv')
  assert.equal(sums.length, 1)
  const s = sums[0]
  assert.equal(s.platform, 'Payoneer')
  assert.equal(s.role, 'settlement_wallet')
  assert.equal(fmtAmount(s.walletMetrics.platformInbound), '18000.00')
  assert.equal(fmtAmount(s.walletMetrics.fxWithdrawToCorporate), '14000.00')
  assert.equal(fmtAmount(s.walletMetrics.fxWithdrawToPersonal), '2500.00')
  assert.equal(fmtAmount(s.walletMetrics.walletFees), '194.95')
  assert.equal(s.walletMetrics.voidExcludedCount, 1)
  assert.ok(s.anomalies.some((a) => a.severity === 'P0-阻断' && a.category.includes('个人私户')))
})

test('v0.8 空中云汇 Airwallex：全球收款入账、云汇卡广告坐支、FX_CONVERSION 剥离与退汇冻结', () => {
  const csv = [
    'Transaction Date,Transaction ID,Financial Transaction Type,Beneficiary,Description,Currency,Amount,Fee,Status',
    '2026-11-03,AWX-1,GLOBAL_ACCOUNT_DEPOSIT,Shopify Payments,EU Payout,EUR,15000.00,0.00,SETTLED',
    '2026-11-06,AWX-2,PAYOUT,"Shenzhen Star Tech Co., Ltd.",Corporate settlement,EUR,-9000.00,40.00,SETTLED',
    '2026-11-08,AWX-3,CARD_PURCHASE,Google Ireland Ads,Airwallex Borderless Card,EUR,-1800.00,0.00,SETTLED',
    '2026-11-09,AWX-4,FX_CONVERSION,Airwallex,FX Conversion EUR to USD,EUR,-1200.00,0.00,SETTLED',
    '2026-11-10,AWX-5,RETURNED_PAYOUT,Bank Wire,Returned wire payout,EUR,-500.00,0.00,SETTLED',
  ].join('\n')

  const sums = parseStatementBuffer(Buffer.from(csv, 'utf8'), 'Airwallex_Balance_202611.csv')
  assert.equal(sums.length, 1)
  const s = sums[0]
  assert.equal(s.platform, 'Airwallex')
  assert.equal(s.role, 'settlement_wallet')
  assert.equal(fmtAmount(s.walletMetrics.platformInbound), '15000.00')
  assert.equal(fmtAmount(s.walletMetrics.fxWithdrawToCorporate), '9000.00')
  assert.equal(fmtAmount(s.walletMetrics.directSpend), '1800.00')
  assert.equal(fmtAmount(s.walletMetrics.internalFxStripped), '1200.00')
  assert.equal(fmtAmount(s.walletMetrics.frozenOrReturned), '500.00')
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && a.category.includes('坐支')))
  assert.ok(s.anomalies.some((a) => a.severity === 'P1-高危' && (a.category.includes('风控冻结') || a.category.includes('退汇'))))
})

test('v0.8 防重复计税铁律与三段资金交叉核对：demo:v8 销售总额与 demo:all 全等、Amazon 无失衡误报且账本闭合', () => {
  const fx = { USD: 7.25, EUR: 7.85 }
  const sAll = parsePlatformStatement('demo:all')
  const cAll = buildConsolidatedReconcile(sAll, { fxRates: fx, declaredVatSalesCny: 580000 })
  const sV8 = parsePlatformStatement('demo:v8')
  const cV8 = buildConsolidatedReconcile(sV8, { fxRates: fx, declaredVatSalesCny: 580000 })

  assert.equal(sV8.length, 6)
  // Amazon 沙盒补齐 other 列后零水平守恒误报
  const amz = sV8.find((x) => x.platform === 'Amazon')
  assert.equal(amz.horizontalDiffTotal, 0n)
  // 核心防重复计税铁律：引入 3 份结汇流水后，合并报送毛额、退款、净额、费用、放款必须与纯销售账单分毫不差
  assert.equal(cV8.totals.grossCny, cAll.totals.grossCny)
  assert.equal(cV8.totals.refundCny, cAll.totals.refundCny)
  assert.equal(cV8.totals.netSalesCny, cAll.totals.netSalesCny)
  assert.equal(cV8.totals.feesCny, cAll.totals.feesCny)
  assert.equal(cV8.totals.payoutCny, cAll.totals.payoutCny)

  const fc = cV8.fundChain
  assert.ok(fc)
  assert.equal(fc.mode, 'three_stage_cross_check')
  assert.equal(fc.hasSalesEvidence, true)
  assert.equal(fc.salesSheetCount, 3)
  assert.equal(fc.walletCount, 3)
  // USD 差 -2300 × 7.25 = -16675；EUR 差 0
  assert.equal(fc.stage1to2GapCny, -16675)
  assert.equal(fc.stage3CorporateRepatriatedCny, 406875)
  assert.equal(fc.stage3PersonalWithdrawCny, 36250)
  assert.equal(fc.directSpendCny, 42040)
  assert.equal(fc.walletFeesCny, 2797.75)
  // 滞留净额纳入内部换汇流出（-1000 USD × 7.25 + -800 EUR × 7.85 = -13530 CNY），账本完全闭合
  assert.equal(fc.internalFxNetCny, -13530)
  assert.equal(fc.retainedOffshoreCny, 49893.75)
  assert.equal(fc.corporateRepatriationRatePct, 73.79)
  // 资金账本闭合校验：对公 + 私户 + 待核 + 坐支 + 手续费 + 滞留 - 内部换汇净流 === 结汇通道入账总额
  const sumCheck = Math.round((fc.stage3CorporateRepatriatedCny + fc.stage3PersonalWithdrawCny + fc.stage3UnverifiedWithdrawCny + fc.directSpendCny + fc.walletFeesCny + fc.retainedOffshoreCny - fc.internalFxNetCny) * 100) / 100
  assert.equal(sumCheck, fc.stage2WalletInboundCny)
  assert.ok(fc.alerts.some((a) => a.includes('P0 公私混收')))
  assert.ok(fc.alerts.some((a) => a.includes('资金缺口')))

  // HTML / MD 报告均包含结汇通道与三段核对章节
  const html = renderDiagnosticReportHtml({ summaries: sV8, consolidated: cV8, version: '0.8.0' })
  const md = renderDiagnosticReportMd({ summaries: sV8, consolidated: cV8, version: '0.8.0' })
  assert.ok(html.includes('三段资金链路交叉核对'))
  assert.ok(html.includes('结汇收款通道资金拆解'))
  assert.ok(md.includes('三段资金链路交叉核对'))

  // serializeSummary 保留 role 与 walletMetrics
  const serializedWf = serializeSummary(sV8.find((x) => x.platform === 'WorldFirst'))
  assert.equal(serializedWf.role, 'settlement_wallet')
  assert.equal(serializedWf.walletMetrics.platformInbound, '33450.00')
})

test('v0.8 纯结汇通道独立体检模式（demo:wallets）：不报错且销售毛额严格为 0', () => {
  const sums = parsePlatformStatement('demo:wallets')
  assert.equal(sums.length, 3)
  const cons = buildConsolidatedReconcile(sums, { fxRates: { USD: 7.25, EUR: 7.85 } })
  assert.equal(cons.ready, true)
  assert.equal(cons.totals.grossCny, 0)
  assert.equal(cons.totals.netSalesCny, 0)
  assert.equal(cons.fundChain.mode, 'wallet_only')
  assert.ok(cons.fundChain.alerts.some((a) => a.includes('独立体检模式')))
})

test('v0.8 用户自定义汇率持久化：白名单清洗、不覆盖 defaultKbId、支持重置清空', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fintax-v08-fx-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  const prevEnvKb = process.env.IMA_DEFAULT_KB_ID
  process.env.FINTAX_CONFIG_DIR = tmpDir
  delete process.env.IMA_DEFAULT_KB_ID
  try {
    // 先绑定默认 KB
    saveFintaxSettings({ defaultKbId: 'ima_kb_test88', defaultKbName: '测试财税库' })
    // 单独保存汇率（含脏数据过滤）
    const cleaned = sanitizeCustomFxRates({ usd: 7.28, EUR: 7.91, CNY: 1, BAD_CODE: 5, GBP: -1, JPY: 'abc' })
    assert.deepEqual(cleaned, { USD: 7.28, EUR: 7.91 })

    const s1 = saveFintaxSettings({ customFxRates: { usd: 7.28, EUR: 7.91, CNY: 1, BAD: -3 } })
    assert.equal(s1.defaultKbId, 'ima_kb_test88')
    assert.deepEqual(s1.customFxRates, { USD: 7.28, EUR: 7.91 })

    // 再更新 KB 不得冲掉 customFxRates
    const s2 = saveFintaxSettings({ defaultKbId: 'ima_kb_test99', defaultKbName: '新库' })
    assert.deepEqual(s2.customFxRates, { USD: 7.28, EUR: 7.91 })

    // 传 null 重置清空
    const s3 = saveFintaxSettings({ customFxRates: null })
    assert.deepEqual(s3.customFxRates, {})
    assert.equal(loadFintaxSettings().defaultKbId, 'ima_kb_test99')
  } finally {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    if (prevEnvKb !== undefined) process.env.IMA_DEFAULT_KB_ID = prevEnvKb
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('v0.8 HTTP API 路由端到端：汇率保存/读取、/parse demo:v8、/history/report 与 401 鉴权守卫', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fintax-v08-api-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = tmpDir
  try {
    const handler = createFintaxApiHandler({
      getConnection: () => ({ admit: () => ({}) }),
    })

    // 未鉴权访问 /history/report 必须拦截
    const unauthHandler = createFintaxApiHandler({
      getConnection: () => ({ admit: () => ({ rejection: 401 }) }),
    })
    const unauth = await mockApiCall(unauthHandler, 'GET', '/api/fintax/history/report')
    assert.equal(unauth.statusCode, 401)

    // 保存自定义汇率并在 /status 中回显
    const setFx = await mockApiCall(handler, 'POST', '/api/fintax/settings', { customFxRates: { USD: 7.31, EUR: 7.95 } })
    assert.equal(setFx.statusCode, 200)
    assert.deepEqual(setFx.json.customFxRates, { USD: 7.31, EUR: 7.95 })

    const st = await mockApiCall(handler, 'GET', '/api/fintax/status')
    assert.equal(st.statusCode, 200)
    assert.deepEqual(st.json.customFxRates, { USD: 7.31, EUR: 7.95 })

    // POST /parse demo:v8 返回 fundChain
    const parsed = await mockApiCall(handler, 'POST', '/api/fintax/parse', {
      demo: 'v8',
      fxRates: { USD: 7.25, EUR: 7.85 },
      declaredVatSalesCny: 580000,
    })
    assert.equal(parsed.statusCode, 200)
    assert.equal(parsed.json.consolidated.fundChain.mode, 'three_stage_cross_check')
    assert.equal(parsed.json.consolidated.fundChain.stage3PersonalWithdrawCny, 36250)

    // 归档 2 期快照并拉取 12 个月滚年趋势月报 HTML
    saveSnapshot({ month: '2026-10', label: '10月<script>alert(1)</script>', platforms: ['Amazon', 'WorldFirst'], grossCny: 600000, netSalesCny: 580000, feesCny: 120000, payoutCny: 460000, p0Count: 1, p1Count: 2 })
    saveSnapshot({ month: '2026-11', label: '11月全链路', platforms: ['Amazon', 'Temu', 'Payoneer'], grossCny: 712875, netSalesCny: 691125, feesCny: 145000, payoutCny: 568061.5, p0Count: 2, p1Count: 3 })

    const rep = await mockApiCall(handler, 'GET', '/api/fintax/history/report')
    assert.equal(rep.statusCode, 200)
    assert.ok(rep.json.reportHtml.includes('跨境财税 12 个月滚动风控趋势月报'))
    assert.ok(rep.json.reportHtml.includes('<svg'))
    // 严格 XSS 转义防御
    assert.ok(!rep.json.reportHtml.includes('<script>alert(1)</script>'))
    assert.ok(rep.json.reportHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  } finally {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('v0.8 Host 工具层与商业护城河回归：fintax_parse_statement demo:v8 + 趋势月报零泄密', async () => {
  const registeredTools = new Map()
  apply({
    tools: { register: (t) => registeredTools.set(t.name, t) },
    skills: { register: () => {} },
    logger: { info: () => {}, warn: () => {} },
  })
  const parseTool = registeredTools.get('fintax_parse_statement')
  assert.ok(parseTool)

  const outDir = mkdtempSync(join(tmpdir(), 'fintax-v08-tool-'))
  try {
    const htmlOut = join(outDir, 'v08_report.html')
    const txt = await parseTool.execute({
      file_path: 'demo:v8',
      fx_rates: { USD: 7.25, EUR: 7.85 },
      declared_vat_sales_cny: 580000,
      export_report_path: htmlOut,
    })
    assert.ok(txt.includes('第三方结汇通道资金排雷报告'))
    assert.ok(txt.includes('三段资金链路交叉核对'))
    assert.ok(txt.includes('73.79%'))

    const html = readFileSync(htmlOut, 'utf8')
    const trendHtml = renderRollingTrendReportHtml({
      history: [{ id: '1', month: '2026-11', label: '测试', platforms: ['Amazon'], grossCny: 500000, netSalesCny: 480000, feesCny: 80000, payoutCny: 400000, p0Count: 0, p1Count: 1 }],
      rolling12m: computeRolling12m([{ id: '1', month: '2026-11', label: '测试', platforms: ['Amazon'], grossCny: 500000, netSalesCny: 480000, feesCny: 80000, payoutCny: 400000, p0Count: 0, p1Count: 1 }]),
      version: '0.8.0',
    })
    const csv = renderAnomaliesCsv({ summaries: parsePlatformStatement('demo:v8') })

    for (const content of [txt, html, trendHtml, csv]) {
      for (const forbidden of ['借方科目', '贷方科目', '一表通母表公式', 'VLOOKUP(', 'SUMIFS(', '借：应收账款']) {
        assert.ok(!content.includes(forbidden), `检测到护城河禁用词：${forbidden}`)
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('v0.8 对抗回归 1：匿名文件名防抢单、中文人民币规范化、Total 行跳过与严苛 Net 守恒', () => {
  // 1) Airwallex 改名 statement.csv 且备注含 Payment from Amazon，绝不被 Payoneer 抢单
  const awxAnon = [
    'Transaction Date,Transaction ID,Financial Transaction Type,Beneficiary,Description,Currency,Amount,Fee,Status',
    '2026-11-05,TX-1,GLOBAL_ACCOUNT_DEPOSIT,Amazon,Payment from Amazon US,USD,1000.00,0.00,SETTLED',
  ].join('\n')
  const awxRes = parseStatementBuffer(Buffer.from(awxAnon, 'utf8'), 'statement.csv')
  assert.equal(awxRes[0].platform, 'Airwallex')

  // 2) WorldFirst 双列 Credit/Debit 改名 export.csv 且含 #1081 与中文人民币，绝不被 Shopify 抢单且归 CNY
  const wfAnon = [
    '交易时间,Order No,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,净变动,状态',
    '2026-11-05,#1081,平台回款,Amazon CN,Settlement,人民币,100.00,0.00,5.00,105.00,Completed',
    '2026-11-06,#1082,结汇提现,ABC Holdings Ltd,Corporate payout,人民币,0.00,50.00,2.00,-50.00,Completed',
    '2026-11-07,Total,合计,Total,Total,人民币,100.00,50.00,0.00,50.00,Completed',
  ].join('\n')
  const wfRes = parseStatementBuffer(Buffer.from(wfAnon, 'utf8'), 'export.csv')
  assert.equal(wfRes[0].platform, 'WorldFirst')
  assert.equal(wfRes[0].currency, 'CNY')
  // Total 汇总行被跳过（仅 2 条有效流水）
  assert.equal(wfRes[0].rawRowCount, 2)
  // 第 1 行入账 +100, fee=5, Net=+105 必须触发 P0 水平守恒阻断（绝不放行反向加费篡改！）
  assert.ok(wfRes[0].anomalies.some((a) => a.severity === 'P0-阻断' && a.category.includes('水平守恒')))
  // 第 2 行 ABC Holdings Ltd 归对公结汇（绝不因 Holdings 误判冻结），且内含手续费 Net=-50 合法通过
  assert.equal(fmtAmount(wfRes[0].walletMetrics.fxWithdrawToCorporate), '50.00')
  assert.equal(fmtAmount(wfRes[0].walletMetrics.frozenOrReturned), '0.00')
})

test('v0.8 对抗回归 2：公私混收零绕过、供应商不入对公、未知户名归待核提现与退汇正向闭合', () => {
  const csv = [
    'Date,Transaction ID,Type,Description,Counterparty,Currency,Amount,Fee,Status',
    '2026-11-01,PY-1,Incoming,Payment from Amazon US,Amazon,USD,1000.00,0.00,Completed',
    '2026-11-02,PY-2,Withdrawal,Company reimbursement,Zhang San Personal Account,USD,-200.00,0.00,Completed',
    '2026-11-03,PY-3,Bank Transfer,Supplier invoice payment,"Acme Trading Co., Ltd.",USD,-300.00,0.00,Completed',
    '2026-11-04,PY-4,Withdrawal,Bank withdrawal,张三,USD,-150.00,0.00,Completed',
    '2026-11-05,PY-5,Returned Wire,Returned wire payout,Bank,USD,50.00,0.00,Completed',
    '2026-11-06,PY-6,Incoming,Shareholder loan,Boss Li,USD,400.00,0.00,Completed',
  ].join('\n')
  const [s] = parseStatementBuffer(Buffer.from(csv, 'utf8'), 'Payoneer_Audit_202611.csv')
  // Personal + Company 仍强制命中 P0 私户，绝不绕过
  assert.equal(fmtAmount(s.walletMetrics.fxWithdrawToPersonal), '200.00')
  // Supplier + Trading Co., Ltd. 归入坐支，绝不计入对公回流
  assert.equal(fmtAmount(s.walletMetrics.directSpend), '300.00')
  // 未知户名“张三”归入待核提现，已确认对公回流为 0.00
  assert.equal(fmtAmount(s.walletMetrics.unverifiedWithdraw), '150.00')
  assert.equal(fmtAmount(s.walletMetrics.fxWithdrawToCorporate), '0.00')
  // 退汇退回钱包 +50 计入 returnedInbound，非标准入账 400 计入 otherInbound
  assert.equal(fmtAmount(s.walletMetrics.returnedInbound), '50.00')
  assert.equal(fmtAmount(s.walletMetrics.otherInbound), '400.00')
  // 账本严格闭合：1000 + 400 + 50 - 200 - 300 - 150 = 800.00
  assert.equal(fmtAmount(s.walletMetrics.signedNetFlow), '800.00')
})

test('v0.8 对抗回归 3：跨文件同币种消假滞留、异币种单边未匹配告警与 wallet_only 章节连续无重复', () => {
  const wfIn = parseStatementBuffer(Buffer.from(
    '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,状态\n2026-11-01,WF-1,平台回款,Amazon,US,USD,100.00,0.00,0.00,Completed',
    'utf8',
  ), 'WorldFirst_In.csv')
  const wfOut = parseStatementBuffer(Buffer.from(
    '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,状态\n2026-11-02,WF-2,结汇提现,深圳星海有限公司,回流,USD,0.00,100.00,0.00,Completed',
    'utf8',
  ), 'WorldFirst_Out.csv')
  const merged = buildConsolidatedReconcile([...wfIn, ...wfOut], { fxRates: { USD: 7.25 } })
  assert.equal(merged.fundChain.retainedOffshoreCny, 0)
  assert.equal(merged.fundChain.stage1PlatformPayoutCny, null)
  // wallet_only 章节连续：从「一、」开始且不重复输出告警
  const md = renderDiagnosticReportMd({ summaries: [...wfIn, ...wfOut], consolidated: merged, version: '0.8.0' })
  assert.ok(md.includes('## 一、结汇收款通道'))
  assert.ok(md.includes('## 二、三段资金链路交叉核对'))
  assert.ok(md.includes('## 三、异常交易雷达'))
  assert.equal(md.split('独立体检模式').length - 1, 1)

  // 异币种折人民币恰好抵消（USD 放款 785×7.25=5691.25 vs EUR 钱包入账 725×7.85=5691.25），必须检出单边未匹配！
  const usdSales = {
    role: 'sales_platform', period: '2026-11', platform: 'Amazon', site: 'US', currency: 'USD',
    fileName: 'a.csv', rawRowCount: 1, grossSales: 1000n * 10000n, sellerDiscount: 0n,
    taxReportingGrossRef: 1000n * 10000n, customerRefund: 0n, totalFees: 215n * 10000n,
    platformSubsidy: 0n, selfRemitTaxNet: 0n, reserveNetChange: 0n,
    actualPayout: 785n * 10000n, horizontalDiffTotal: 0n, anomalies: [],
  }
  const eurWallet = parseStatementBuffer(Buffer.from(
    'Transaction Date,Transaction ID,Financial Transaction Type,Beneficiary,Description,Currency,Amount,Fee,Status\n2026-11-02,AWX-1,GLOBAL_ACCOUNT_DEPOSIT,Amazon EU,Payout,EUR,725.00,0.00,SETTLED',
    'utf8',
  ), 'Airwallex_EU.csv')
  const crossCcy = buildConsolidatedReconcile([usdSales, ...eurWallet], { fxRates: { USD: 7.25, EUR: 7.85 } })
  assert.equal(crossCcy.fundChain.stage1to2GapCny, 0)
  assert.ok(crossCcy.fundChain.alerts.some((a) => a.includes('跨币种单边未匹配')))
})

test('v0.8 对抗回归 4：env 覆盖下保存汇率不擦除磁盘 KB、严格汇率类型校验、月度放款柱高与幂等去重归档', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fintax-v08-adv-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  const prevEnvKb = process.env.IMA_DEFAULT_KB_ID
  process.env.FINTAX_CONFIG_DIR = tmpDir
  delete process.env.IMA_DEFAULT_KB_ID
  try {
    // 1) 先写入磁盘 KB，再开启环境变量覆盖，仅保存汇率，再撤掉环境变量 → 磁盘原 KB 必须完好保留！
    saveFintaxSettings({ defaultKbId: 'disk_kb_001', defaultKbName: '磁盘原库' })
    process.env.IMA_DEFAULT_KB_ID = 'env_kb_override'
    saveFintaxSettings({ customFxRates: { USD: 7.26 } })
    delete process.env.IMA_DEFAULT_KB_ID
    const afterEnv = loadFintaxSettings()
    assert.equal(afterEnv.defaultKbId, 'disk_kb_001')
    assert.equal(afterEnv.defaultKbName, '磁盘原库')
    assert.deepEqual(afterEnv.customFxRates, { USD: 7.26 })

    // 2) 严格类型校验：拒绝布尔/数组/下溢 0，strict 模式传数组抛错
    const c = sanitizeCustomFxRates({ USD: true, EUR: [7.8], JPY: 0.0000001, GBP: '9.15' })
    assert.deepEqual(c, { GBP: 9.15 })
    assert.throws(() => sanitizeCustomFxRates(['bad'], { strict: true }))

    // 3) HTTP /settings 未鉴权 401 与非法 JSON 400
    const unauth = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ rejection: 401 }) }) })
    const r401 = await mockApiCall(unauth, 'POST', '/api/fintax/settings', { customFxRates: { USD: 9.99 } })
    assert.equal(r401.statusCode, 401)
    assert.deepEqual(loadFintaxSettings().customFxRates, { USD: 7.26 })

    const auth = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({}) }) })
    const r400 = await mockApiCall(auth, 'POST', '/api/fintax/settings', { customFxRates: [1, 2] })
    assert.equal(r400.statusCode, 400)

    // 4) 重复归档同月同源快照自动幂等覆盖（绝不翻倍误触红线），且月度聚合保留 payoutCny 供 SVG 双柱渲染
    saveSnapshot({ month: '2026-11', label: '11月主店', platforms: ['Amazon'], grossCny: 3_000_000, netSalesCny: 3_000_000, payoutCny: 2_400_000 })
    const dup = saveSnapshot({ month: '2026-11', label: '11月主店', platforms: ['Amazon'], grossCny: 3_000_000, netSalesCny: 3_000_000, payoutCny: 2_400_000 })
    assert.equal(dup.deduplicated, true)
    assert.equal(dup.history.length, 1)
    assert.equal(dup.rolling12m.totalNetSalesCny, 3_000_000)
    assert.equal(dup.rolling12m.monthlySeries[0].payoutCny, 2_400_000)

    // 断言 SVG 灰色放款柱高度远大于 2px（真实按 240万 / 300万 比例绘制）
    const svgHtml = renderRollingTrendReportHtml({ history: dup.history, rolling12m: dup.rolling12m, version: '0.8.0' })
    const greyMatch = svgHtml.match(/height="([\d.]+)" fill="#8A8E80"/)
    assert.ok(greyMatch && Number(greyMatch[1]) > 100, `期望灰色放款柱真实比例高度 > 100px，实际：${greyMatch?.[1]}`)
  } finally {
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    if (prevEnvKb === undefined) delete process.env.IMA_DEFAULT_KB_ID
    else process.env.IMA_DEFAULT_KB_ID = prevEnvKb
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportRebateManufacturer, platformTaxReconcile } from '../lib/calc.js'
import { finalizeSummary, makeEmptySummary, parseAmount, parseStatementBuffer } from '../lib/statement.js'
import {
  buildConsolidatedReconcile, exportDiagnosticReport, normalizeFxMap,
  renderAnomaliesCsv, renderDiagnosticReportHtml, renderDiagnosticReportMd,
  renderRollingTrendReportHtml, serializeSummary,
} from '../lib/report.js'

const version = createRequire(import.meta.url)('../package.json').version

for (const expected of [
  { input: 70_000, payable: 10_000, credit: 0, refund: 0, offset: 180_000, next: 0 },
  { input: 100_000, payable: 0, credit: 20_000, refund: 20_000, offset: 160_000, next: 0 },
  { input: 260_000, payable: 0, credit: 180_000, refund: 180_000, offset: 0, next: 0 },
  { input: 300_000, payable: 0, credit: 220_000, refund: 180_000, offset: 0, next: 40_000 },
]) {
  test(`生产企业期末留抵 ${expected.credit} 元时保留免抵退上限及孰低计算`, () => {
    const calc = exportRebateManufacturer({ exportFobCny: 2_000_000, vatRate: 0.13, rebateRate: 0.09, totalInputVat: expected.input })
    assert.equal(calc.maxRebateLimit, 180_000)
    assert.equal(calc.vatPayable, expected.payable)
    assert.equal(calc.endingCredit, expected.credit)
    assert.equal(calc.taxRefund, expected.refund)
    assert.equal(calc.taxExemptOffset, expected.offset)
    assert.equal(calc.nextCarryover, expected.next)
    assert.equal(calc.warnings.some((line) => /审核批准.*城建税/.test(line)), expected.offset > 0)
  })
}

function statement({ role = 'sales_platform', currency = 'CNY', period = '2026-11', fileName = 'source.csv' } = {}) {
  const s = makeEmptySummary({ period, currency, platform: role === 'sales_platform' ? 'Stripe' : 'Payoneer', site: 'CN', fileName })
  s.role = role
  s.rawRowCount = 1
  if (role === 'settlement_wallet') {
    s.walletMetrics = {}
    s.inboundEvidence = []
  }
  return s
}

const wallet = (options) => statement({ role: 'settlement_wallet', ...options })
const evidence = (amount, overrides = {}) => ({
  amount: parseAmount(amount), period: '2026-11', sourcePlatform: 'Stripe',
  entityKey: 'known-entity', accountKey: 'known-account', referenceKey: 'same-reference',
  ...overrides,
})

test('只在主体、账号、账期、平台、币种和放款引用全部匹配时确认跨段零差', () => {
  const sale = statement({ currency: 'RMB' })
  const receiving = wallet()
  sale.actualPayout = parseAmount('100')
  sale.payoutEvidenceCount = 1
  sale.payoutEvidence = [evidence('100')]
  receiving.walletMetrics.platformInbound = parseAmount('100')
  receiving.inboundEvidence = [evidence('100')]
  const compare = (options) => buildConsolidatedReconcile([finalizeSummary(sale), finalizeSummary(receiving)], options).fundChain
  assert.equal(compare().stage1to2Status, 'matched')
  assert.equal(compare().stage1to2GapCny, 0)
  assert.equal(compare({ coverageComplete: false }).stage1to2GapCny, null)
  for (const mismatch of [
    { entityKey: 'other-entity' }, { accountKey: 'other-account' }, { period: '2026-10' },
    { sourcePlatform: 'Amazon' }, { referenceKey: null },
  ]) {
    receiving.inboundEvidence = [evidence('100', mismatch)]
    const { stage1to2GapCny, stage1UnmatchedPayoutCny, stage2UnmatchedInboundCny } = compare()
    assert.equal(stage1to2GapCny, null)
    assert.equal(stage1UnmatchedPayoutCny, 100)
    assert.equal(stage2UnmatchedInboundCny, 100)
  }
  receiving.inboundEvidence = [evidence('100'), evidence('100')]
  receiving.walletMetrics.platformInbound = parseAmount('200')
  assert.equal(compare().stage1to2GapCny, null)
})

test('已观察的负放款保留符号，空白放款证据与明确的零额分开', () => {
  const a = statement(), b = statement(), c = wallet()
  a.actualPayout = parseAmount('1000')
  b.actualPayout = parseAmount('-200')
  a.payoutEvidenceCount = b.payoutEvidenceCount = 1
  const funds = buildConsolidatedReconcile([a, b, c].map(finalizeSummary)).fundChain
  assert.equal(funds.stage1PlatformPayoutCny, 800)
  assert.equal(funds.stage1PayoutEvidenceCount, 2)
  const noEvidence = buildConsolidatedReconcile([statement(), c].map(finalizeSummary)).fundChain
  assert.equal(noEvidence.hasSalesEvidence, false)
  assert.equal(noEvidence.stage1PlatformPayoutCny, null)
  const zero = statement()
  zero.payoutEvidenceCount = 1
  assert.equal(buildConsolidatedReconcile([zero, c].map(finalizeSummary)).fundChain.stage1PlatformPayoutCny, 0)
})

test('真实导入路径可关联结构化放款与钱包入账，公共报告不输出配对凭证', () => {
  const stripe = parseStatementBuffer(Buffer.from([
    'Date,Transaction ID,Type,Description,Currency,Amount,Fee,Net,Legal Entity ID,Destination Account ID,Payout Reference',
    '2026-11-06,po_test,payout,,RMB,-100,0,-100,private-entity,private-wallet,private-reference',
  ].join('\n')), 'stripe.csv')
  const payoneer = parseStatementBuffer(Buffer.from([
    'Date,Transaction ID,Type,Description,Counterparty,Currency,Amount,Fee,Net,Status,Legal Entity ID,Settlement Account ID,Platform Payout ID,Source Platform',
    '2026-11-06,PY-01,Incoming,Platform settlement,Stripe,CNY,100,0,100,Completed,private-entity,private-wallet,private-reference,Stripe',
  ].join('\n')), 'wallet.csv')
  const summaries = [...stripe, ...payoneer]
  const consolidated = buildConsolidatedReconcile(summaries)
  assert.equal(consolidated.fundChain.stage1to2Status, 'matched')
  assert.equal(consolidated.fundChain.stage1to2GapCny, 0)
  for (const data of [consolidated, summaries.map(serializeSummary)]) {
    assert.doesNotMatch(JSON.stringify(data), /private-(?:entity|wallet|reference)|entityKey|accountKey|referenceKey/)
  }
})

test('期间净流、期初期末余额和银行实收分别以各自证据展示', () => {
  const row = wallet()
  row.walletMetrics.platformInbound = row.walletMetrics.signedNetFlow = parseAmount('100')
  const reconcile = () => buildConsolidatedReconcile([finalizeSummary(row)]).fundChain
  assert.equal(reconcile().signedNetFlowCny, 100)
  assert.equal(reconcile().retainedOffshoreCny, null)
  assert.equal(reconcile().bankReceivedCny, null)
  row.walletMetrics.openingBalance = parseAmount('80')
  row.walletMetrics.closingBalance = row.walletMetrics.unrepatriatedNet = parseAmount('180')
  assert.equal(reconcile().openingBalanceCny, 80)
  assert.equal(reconcile().closingBalanceCny, 180)
  assert.equal(reconcile().retainedOffshoreCny, 180)
  row.walletMetrics.pendingReturnCount = 1
  row.walletMetrics.fxWithdrawToCorporate = parseAmount('100')
  assert.equal(reconcile().corporateRepatriationRatePct, null)
  row.walletMetrics.pendingReturnCount = 0
  row.walletMetrics.fxWithdrawToCorporate = 0n
  assert.equal(reconcile().corporateRepatriationRatePct, null)
  assert.equal(reconcile().stage3VerificationStatus, 'pending_bank_receipt')
})

test('按币种精确折算并最后量化，币种未知与缺汇率均保持待核', () => {
  const unknown = wallet({ currency: '' })
  unknown.walletMetrics.platformInbound = parseAmount('100')
  assert.deepEqual(buildConsolidatedReconcile([finalizeSummary(unknown)], { fxRateToCny: 7 }).missingCurrencies, ['待确认币种'])
  const usd = wallet({ currency: 'USD' })
  usd.walletMetrics.platformInbound = parseAmount('0.004')
  const ready = finalizeSummary(usd)
  assert.equal(buildConsolidatedReconcile([ready]).ready, false)
  assert.equal(buildConsolidatedReconcile([ready], { fxRates: { USD: 7 } }).fundChain.stage2WalletInboundCny, 0.03)
  assert.equal(buildConsolidatedReconcile([ready, ready], { fxRates: { USD: 1 } }).fundChain.stage2WalletInboundCny, 0.01)
  assert.throws(() => normalizeFxMap('null'), { code: 'INVALID_FX_MAP' })
  assert.throws(() => normalizeFxMap({ notACurrency: 7 }), { code: 'INVALID_FX_MAP' })
  assert.deepEqual(normalizeFxMap({ RMB: 1, USD: null, NZD: '' }), { CNY: 1 })
})

test('派生退款冲回与手续费返还保留符号，且资金桥接在最终显示阶段量化', () => {
  const sale = statement()
  sale.grossSales = parseAmount('100.006')
  sale.customerRefund = parseAmount('-5.004')
  sale.platformCommission = parseAmount('-5.004')
  sale.actualPayout = parseAmount('110.006')
  sale.payoutEvidenceCount = 1
  const consolidated = buildConsolidatedReconcile([finalizeSummary(sale)])
  assert.equal(consolidated.totals.refundCny, -5)
  assert.equal(consolidated.totals.feesCny, -5)
  assert.equal(consolidated.reconcile.reportedNetRevenue, 105.01)
  assert.equal(consolidated.reconcile.payoutReconciliation.theoreticalPayout, 110.01)
  assert.equal(consolidated.reconcile.payoutReconciliation.unexplainedCashGap, -0.01)
  assert.throws(() => platformTaxReconcile({ reportedGrossRevenue: 100, refunds: -5 }), /非负/)
  const calc = platformTaxReconcile({ reportedGrossRevenue: 100, refundReversal: 5, platformFeeRebate: 5, actualPayout: 110 })
  assert.equal(calc.payoutReconciliation.theoreticalPayout, 110)
})

test('默认版本统一且脱敏导出转义文本，禁止覆盖已有报告', () => {
  const sale = statement({ fileName: 'Research & [Planning] | Ledger.csv' })
  const receiving = wallet({ fileName: 'LEDGER-PRIVATE-wallet.csv' })
  sale.anomalies = [{ severity: 'P0-阻断', category: '行内勾稽差异', amount: '-0.20', refId: 'LEDGER-PRIVATE', detail: 'BANK-PARTY-PRIVATE', rowNumber: 7 }]
  const summaries = [sale, receiving].map(finalizeSummary)
  const data = { summaries, consolidated: buildConsolidatedReconcile(summaries) }
  const md = renderDiagnosticReportMd(data)
  const html = renderDiagnosticReportHtml(data)
  const csv = renderAnomaliesCsv(data)
  const dto = serializeSummary(sale)
  assert.ok(html.includes(`v${version}`))
  assert.ok(md.includes(`v${version}`))
  assert.ok(html.includes('Research &amp; [Planning] | Ledger.csv'))
  assert.ok(md.includes('Research &#38; &#91;Planning&#93; &#124; Ledger.csv'))
  assert.ok(html.includes('class="pending"'))
  assert.ok(csv.includes(',-0.20,'))
  assert.equal(dto.anomalies[0].refId, '第 7 行')
  for (const out of [md, html, csv, JSON.stringify(dto)]) assert.doesNotMatch(out, /LEDGER-PRIVATE|BANK-PARTY-PRIVATE/)
  const dir = mkdtempSync(join(tmpdir(), 'fintax-report-'))
  try {
    const exportPath = join(dir, 'report.md')
    exportDiagnosticReport({ ...data, exportPath })
    const original = readFileSync(exportPath, 'utf8')
    assert.throws(() => exportDiagnosticReport({ ...data, exportPath }), { code: 'REPORT_ALREADY_EXISTS' })
    assert.equal(readFileSync(exportPath, 'utf8'), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('全主体及待认领趋势只展示汇总，选中已认领单主体才显示阈值', () => {
  const history = Array.from({ length: 132 }, (_, index) => ({
    entityName: index < 66 ? 'A' : 'B', month: '2026-11', netSalesCny: 30000,
    label: `归档记录 ${index + 1}`, platforms: ['Stripe'],
  }))
  const rolling12m = { windowStart: '2025-12', windowEnd: '2026-11', totalNetSalesCny: 3_960_000 }
  const all = renderRollingTrendReportHtml({ history, rolling12m })
  assert.ok(all.includes('归档记录 132'))
  assert.ok(all.includes(`v${version}`))
  for (const activeEntity of [undefined, '待认领']) {
    const html = renderRollingTrendReportHtml({ history, rolling12m: { ...rolling12m, activeEntity } })
    assert.doesNotMatch(html, /500 万|7,500 万/)
  }
  const single = renderRollingTrendReportHtml({ history, rolling12m: { ...rolling12m, activeEntity: 'A', thresholdApplicable: true } })
  assert.match(single, /滚动登记参考/)
  assert.doesNotMatch(single, /归档记录 132/)
})


test('独立站订单（Shopify）与支付网关（PayPal/Stripe）同批双导入时防重复计入销售额', () => {
  const mkSale = (platform, fileName) => {
    const s = makeEmptySummary({ period: '2026-11', currency: 'EUR', platform, site: 'EU', fileName })
    s.role = 'sales_platform'
    s.rawRowCount = 1
    s.grossSales = parseAmount('100.00')
    s.taxReportingGrossRef = parseAmount('100.00')
    s.actualPayout = parseAmount('100.00')
    s.payoutEvidenceCount = 1
    return finalizeSummary(s)
  }
  const shopify = mkSale('Shopify', 'shopify_1081.csv')
  const paypal = mkSale('PayPal', 'paypal_1081.csv')
  const stripe = mkSale('Stripe', 'stripe_1081.csv')

  // 1) 单传独立站或单传支付网关均正常按 750 元计算，不触发双导入隔离
  const onlyShopify = buildConsolidatedReconcile([shopify], { fxRates: { EUR: 7.5 } })
  assert.equal(onlyShopify.totals.grossCny, 750)
  assert.equal(onlyShopify.totals.netSalesCny, 750)
  assert.equal(onlyShopify.dtcGatewayOverlap, null)

  const onlyPaypal = buildConsolidatedReconcile([paypal], { fxRates: { EUR: 7.5 } })
  assert.equal(onlyPaypal.totals.grossCny, 750)
  assert.equal(onlyPaypal.totals.netSalesCny, 750)
  assert.equal(onlyPaypal.dtcGatewayOverlap, null)

  // 2) 同批双导入 Shopify + PayPal：绝不翻倍至 1500，网关侧单列核对并输出待核预警
  const both = buildConsolidatedReconcile([shopify, paypal], { fxRates: { EUR: 7.5 } })
  assert.equal(both.ready, true)
  assert.equal(both.totals.grossCny, 750)
  assert.equal(both.totals.netSalesCny, 750)
  assert.equal(both.totals.payoutCny, 750)
  assert.equal(both.dtcGatewayOverlap?.status, 'pending_order_gateway_reconcile')
  assert.equal(both.dtcGatewayOverlap?.excludedGatewayGrossCny, 750)
  assert.equal(both.breakdown.find((b) => b.platform === 'PayPal')?.role, 'payment_gateway_overlap')
  assert.ok(both.reconcile.warnings.some((w) => w.includes('防重复计入')))

  const md = renderDiagnosticReportMd({ summaries: [shopify, paypal], consolidated: both })
  const html = renderDiagnosticReportHtml({ summaries: [shopify, paypal], consolidated: both })
  assert.match(md, /待核资料与凭证/)
  assert.match(md, /独立站防重算隔离/)
  assert.match(html, /待核资料与凭证/)
  assert.match(html, /防重复计入/)

  // 3) 同批导入 Shopify + Stripe 同样拦截防重算
  const withStripe = buildConsolidatedReconcile([shopify, stripe], { fxRates: { EUR: 7.5 } })
  assert.equal(withStripe.totals.grossCny, 750)
  assert.equal(withStripe.dtcGatewayOverlap?.excludedGatewayGrossCny, 750)
})

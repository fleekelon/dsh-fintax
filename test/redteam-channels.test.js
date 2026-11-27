import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  AMOUNT_SCALE,
  excelSerialToIsoDate,
  extractAccountPrefix,
  finalizeSummary,
  fmtAmount,
  makeEmptySummary,
  normalizeBankInstitutionCode,
  parseAmount,
  parseAmountCell,
  parsePlatformStatement,
  parseStatementBuffer,
  readTabularSheetsFromBuffer,
  transactionMonth,
} from '../lib/statement.js'
import { detectV9Platform, extractFullBankAccountDigits, parseV9PlatformRows } from '../lib/platforms_v9.js'
import { parseBankReceiptRows, reconcileStage3 } from '../lib/bank_receipt.js'
import {
  buildConsolidatedReconcile,
  renderDiagnosticReportHtml,
  renderDiagnosticReportMd,
  serializeSummary,
} from '../lib/report.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function csvRows(lines, fileName = 'test.csv') {
  return readTabularSheetsFromBuffer(Buffer.from(lines.join('\n'), 'utf8'), fileName).sheets[0][1]
}

// ════════════════════════════════════════════════════════════════
// 1. [P0-01] 旧钱包（WorldFirst/Payoneer/Airwallex）提款必须计入 Stage 3 核销分母，严禁误判 matched
// ════════════════════════════════════════════════════════════════
test('[P0-01] 连连 USD 15,000 已核 + 无回单 WorldFirst 对公 USD 6,000 → 分母 152,040、未核 43,440、status=partial', () => {
  const llBuf = Buffer.from([
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,收款银行,主体编号,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,备注,状态',
    '2026-11-21,LL-WD-P001,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,招商银行,ENT-XH-01,USD,0.00,15000.00,45.00,-15045.00,7.2400,108600.00,对公回流,Completed',
  ].join('\n'), 'utf8')
  const wfBuf = Buffer.from([
    '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,净额,状态',
    '2026-11-22,WF-WD-P001,结汇提现,深圳星海跨境科技有限公司(对公基本户),万里汇对公回流,USD,0.00,6000.00,18.00,-6018.00,Completed',
  ].join('\n'), 'utf8')
  const bankBuf = Buffer.from([
    '交易日期,记账日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,2026-11-21,108600.00,0.00,CNY,0.00,连连银通支付,深圳星海跨境科技有限公司,7559012345108821,ENT-XH-01,连连结汇 LL-WD-P001,CMB-P001,LL-WD-P001',
  ].join('\n'), 'utf8')

  const ll = parseStatementBuffer(llBuf, 'LianLian_202611.csv')[0]
  const wf = parseStatementBuffer(wfBuf, 'WorldFirst_202611.csv')[0]
  const bank = parseStatementBuffer(bankBuf, 'CMB_BankReceipt_202611.csv')[0]

  // WorldFirst 必须产出结构对齐的 outboundEvidence
  assert.equal(wf.outboundEvidence.length, 1)
  assert.equal(wf.outboundEvidence[0].destinationType, 'corporate')
  assert.equal(fmtAmount(wf.outboundEvidence[0].principalAmount), '6000.00')

  // 直接调用 reconcileStage3 与通过 buildConsolidatedReconcile 均必须精确命中 152,040 / 43,440 / partial
  const s3Direct = reconcileStage3([ll, wf], [bank], { fxRates: { USD: 7.24 } })
  assert.equal(s3Direct.stage2CorporateExpectedCny, 152040)
  assert.equal(s3Direct.stage3MatchedCny, 108600)
  assert.equal(s3Direct.inTransitUnmatchedCny, 43440)
  assert.equal(s3Direct.fxGapOrInTransitCny, 43440)
  assert.equal(s3Direct.stage3Status, 'partial')

  const cons = buildConsolidatedReconcile([ll, wf, bank], { fxRates: { USD: 7.24 } })
  assert.equal(cons.fundChain.stage3VerificationStatus, 'partial')
  assert.equal(cons.fundChain.stage3.stage2CorporateExpectedCny, 152040)
  assert.equal(cons.fundChain.stage3.inTransitUnmatchedCny, 43440)
  assert.equal(cons.fundChain.stage3.stage3Status, 'partial')

  // 退化/旧适配器摘要无 outboundEvidence 但 walletMetrics.fxWithdrawToCorporate = 6000 USD 时，同样计入分母并禁止 matched
  const legacyWallet = makeEmptySummary({ period: '2026-11', platform: 'LegacyWallet', site: 'US', currency: 'USD', formatLabel: 'legacy', fileName: 'legacy.csv' })
  legacyWallet.role = 'settlement_wallet'
  legacyWallet.walletMetrics = { fxWithdrawToCorporate: 6000n * AMOUNT_SCALE }
  const s3Legacy = reconcileStage3([ll, finalizeSummary(legacyWallet)], [bank], { fxRates: { USD: 7.24 } })
  assert.equal(s3Legacy.stage2CorporateExpectedCny, 152040)
  assert.equal(s3Legacy.unbackedCorporateCny, 43440)
  assert.equal(s3Legacy.inTransitUnmatchedCny, 43440)
  assert.equal(s3Legacy.fxGapOrInTransitCny, 43440)
  assert.equal(s3Legacy.stage3Status, 'partial')
  assert.ok(s3Legacy.alerts.some((a) => a.includes('缺逐笔提款明细凭证')))
})

// ════════════════════════════════════════════════════════════════
// 2. [P0-02 + R2 P0-3] 冲突优先拒绝（完整账号/法定户名/显式ID）、目标币严格核对、交易终态门禁
// ════════════════════════════════════════════════════════════════
test('[P0-02 + R2 P0-3] Stage 3 完整账号冲突、法定户名冲突、目标币错配与非终态提款/回单全量拦截', () => {
  const llBase = [
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,资金账户编号,主体编号,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-WD-02,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,ACCT-SHARED,ENT-01,USD,15000.00,45.00,-15045.00,7.2400,108600.00,Completed',
  ]
  const [ll] = parseV9PlatformRows('lianlian', csvRows(llBase, 'll.csv'), { fileName: 'll.csv' })

  // 2a) 相同资金账户编号 + 相同尾号 8821，但完整银行账号不同（7559012345108821 vs 6212269999998821）→ 立即拒绝正式核销！
  const diffFullAcctBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,资金账户编号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,6212269999998821,ACCT-SHARED,ENT-01,连连结汇 LL-WD-02,CMB-ACCT-DIFF,LL-WD-02',
  ], 'cmb.csv'))
  const resFullAcct = reconcileStage3([ll], [diffFullAcctBank])
  assert.equal(resFullAcct.stage3MatchedCny, 0)
  assert.notEqual(resFullAcct.stage3Status, 'matched')

  // 2b) 相同主体编号 ENT-01，但法定户名不同（深圳星海 vs 广州蓝海）→ 正式核销与候选全部拒绝！
  const diffLegalEntBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,资金账户编号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,CNY,0.00,连连银通,广州蓝海贸易有限公司,7559012345108821,ACCT-SHARED,ENT-01,连连结汇 LL-WD-02,CMB-ENT-DIFF,LL-WD-02',
  ], 'cmb.csv'))
  const resLegalEnt = reconcileStage3([ll], [diffLegalEntBank])
  assert.equal(resLegalEnt.stage3MatchedCny, 0)
  assert.equal(resLegalEnt.stage3CandidateMatches.length, 0)
  assert.equal(resLegalEnt.stage3Status, 'pending_bank_receipt')

  // 2c) 结汇目标币为 CNY 108,600，用 USD 15,000 回单绝不可按 CNY 108,600 核销！
  const usdReceipt = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,资金账户编号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,15000.00,USD,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ACCT-SHARED,ENT-01,连连结汇 LL-WD-02,CMB-USD-1,LL-WD-02',
  ], 'cmb_usd.csv'))
  const resWrongCcy = reconcileStage3([ll], [usdReceipt], { fxRates: { USD: 7.24 } })
  assert.equal(resWrongCcy.stage3MatchedCny, 0)
  assert.equal(resWrongCcy.stage3CandidateMatches.length, 0)
  assert.equal(resWrongCcy.stage3Status, 'pending_bank_receipt')

  // 2d) 交易终态门禁：提款标 Returned / Failed / Cancelled / Pending 或回单标 Pending / Processing / Reversed 一律禁止正式核销
  const exactBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,资金账户编号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ACCT-SHARED,ENT-01,连连结汇 LL-WD-02,CMB-OK,LL-WD-02',
  ], 'cmb_ok.csv'))

  const [llReturned] = parseV9PlatformRows('lianlian', csvRows([
    llBase[0],
    '2026-11-21,LL-WD-02,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,ACCT-SHARED,ENT-01,USD,15000.00,45.00,-15045.00,7.2400,108600.00,Returned',
  ], 'll_ret.csv'), { fileName: 'll_ret.csv' })
  const resWdRet = reconcileStage3([llReturned], [exactBank])
  assert.equal(resWdRet.stage3MatchedCny, 0)
  assert.notEqual(resWdRet.stage3Status, 'matched')

  for (const badWdStatus of ['Returned', 'Failed', 'Cancelled', 'Pending']) {
    const fakeEv = { ...ll.outboundEvidence[0], status: badWdStatus }
    const r = reconcileStage3([fakeEv], [exactBank])
    assert.equal(r.stage3MatchedCny, 0, `提款状态 ${badWdStatus} 必须禁止正式核销`)
    assert.notEqual(r.stage3Status, 'matched')
  }

  for (const badBankStatus of ['Pending', 'Processing', 'Reversed']) {
    const bankBad = parseBankReceiptRows(csvRows([
      '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,资金账户编号,主体编号,摘要,银行回单号,关联流水号,状态',
      `2026-11-21,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ACCT-SHARED,ENT-01,连连结汇 LL-WD-02,CMB-BAD,LL-WD-02,${badBankStatus}`,
    ], 'cmb_bad.csv'))
    const r = reconcileStage3([ll], [bankBad])
    assert.equal(r.stage3MatchedCny, 0, `回单状态 ${badBankStatus} 必须禁止正式核销`)
    assert.notEqual(r.stage3Status, 'matched')
    assert.ok(r.abnormalReceipts.length >= 1)
  }
})

// ════════════════════════════════════════════════════════════════
// 3. [P0-03 + R2 P1-18] 手续费超窗、未证实差额、部分退汇、重复参考号 & 外币容差精确换算
// ════════════════════════════════════════════════════════════════
test('[P0-03 + R2 P1-18] 手续费超窗、未证实差额不伪记、部分退汇拒配、重复参考号先检与外币容差 fail-closed', () => {
  const [ll] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,主体编号,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-WD-03,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,ENT-01,USD,15000.00,45.00,-15045.00,7.2400,108600.00,Completed',
  ], 'll.csv'), { fileName: 'll.csv' })

  // 3a) 回单明列手续费 1,000 > maxBankFeeCny (500) 直接拒配（即使实收=预期或实收=预期-1000）
  for (const recv of ['108600.00', '107600.00']) {
    const feeOverBank = parseBankReceiptRows(csvRows([
      '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
      `2026-11-21,${recv},CNY,1000.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-01,连连结汇 LL-WD-03,CMB-FEE-OVER,LL-WD-03`,
    ], 'cmb_fee.csv'))
    const r = reconcileStage3([ll], [feeOverBank], { maxBankFeeCny: 500 })
    assert.equal(r.stage3MatchedCny, 0)
    assert.equal(r.bankFeeCny, 0)
    assert.notEqual(r.stage3Status, 'matched')
    assert.ok(r.alerts.some((a) => a.includes('手续费超窗')))
  }

  // 3b) 实收 108,200、明列费用 0 元 → 绝不能把 400 元差额伪记为 bankFeeCny=400！
  const unverifiedBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,108200.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-01,连连结汇 LL-WD-03,CMB-UNV,LL-WD-03',
  ], 'cmb_unv.csv'))
  const resUnv = reconcileStage3([ll], [unverifiedBank])
  assert.equal(resUnv.stage3MatchedCny, 0)
  assert.equal(resUnv.bankFeeCny, 0, '严禁将未证实差额伪记为银行手续费')
  assert.equal(resUnv.unverifiedShortfallCny, 400)
  assert.notEqual(resUnv.stage3Status, 'matched')
  assert.ok(resUnv.alerts.some((a) => a.includes('未证实差额')))

  // 3c) 部分退汇：USD 15,000 退回 USD 5,000 后本金降为 USD 10,000，绝不可用原 CNY 108,600 回单全额核销
  const [llPartialRet] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,原流水号,交易类型,平台来源,收款户名,收款银行账号,主体编号,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-WD-03,,结汇提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,ENT-01,USD,0.00,15000.00,45.00,-15045.00,7.2400,108600.00,Completed',
    '2026-11-23,LL-RET-03,LL-WD-03,提现退回,Amazon,Bank Return,,ENT-01,USD,5000.00,0.00,0.00,5000.00,,,Completed',
  ], 'll_part.csv'), { fileName: 'll_part.csv' })
  assert.equal(fmtAmount(llPartialRet.walletMetrics.fxWithdrawToCorporate), '10000.00')
  assert.equal(fmtAmount(llPartialRet.outboundEvidence[0].principalAmount), '10000.00')
  assert.equal(fmtAmount(llPartialRet.outboundEvidence[0].settledCnyAmount), '72400.00')
  assert.equal(llPartialRet.outboundEvidence[0].partialReturnFrozen, true)

  const origFullBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-01,连连结汇 LL-WD-03,CMB-FULL,LL-WD-03',
  ], 'cmb_full.csv'))
  const resPartFull = reconcileStage3([llPartialRet], [origFullBank])
  assert.equal(resPartFull.stage3MatchedCny, 0)
  assert.equal(resPartFull.stage3CandidateMatches.length, 0)
  assert.notEqual(resPartFull.stage3Status, 'matched')

  // 即使按比例推算 72,400 的回单，因无法确定退汇后准确本币余额，正式核销同样被冻结
  const proratedBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,72400.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-01,连连结汇 LL-WD-03,CMB-724,LL-WD-03',
  ], 'cmb_724.csv'))
  const resPart724 = reconcileStage3([llPartialRet], [proratedBank])
  assert.equal(resPart724.stage3MatchedCny, 0)
  assert.notEqual(resPart724.stage3Status, 'matched')
  assert.ok(resPart724.alerts.some((a) => a.includes('部分退汇冻结')))

  // 3d) 重复参考号全局唯一性先于金额筛选：两张回单共用 LL-WD-03，即使其中一张金额超窗（50,000），另一张 108,600 也禁止静默核销！
  const dupRefWithOutlierBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-01,连连结汇 LL-WD-03,CMB-D1,LL-WD-03',
    '2026-11-21,50000.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-01,连连结汇 LL-WD-03,CMB-D2,LL-WD-03',
  ], 'cmb_dup.csv'))
  const resDupRef = reconcileStage3([ll], [dupRefWithOutlierBank])
  assert.equal(resDupRef.stage3MatchedCny, 0)
  assert.equal(resDupRef.matchedMatches.length, 0)
  assert.notEqual(resDupRef.stage3Status, 'matched')
  assert.ok(resDupRef.alerts.some((a) => a.includes('重复参考号冲突')))

  // 3e) 外币容差精确换算：100 USD vs 100.04 USD（汇率 7.2、容差 0.05 CNY → 差 0.288 CNY > 0.05 CNY）必须拒配；缺汇率 fail-closed
  const [llUsdDirect] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,主体编号,币种,目标币种,提现金额,手续费,净额,状态',
    '2026-11-21,LL-USD-100,外币提现,Amazon,深圳星海跨境科技有限公司,7559012345108821,ENT-01,USD,USD,100.00,0.00,-100.00,Completed',
  ], 'll_usd.csv'), { fileName: 'll_usd.csv' })
  const usdOverTolBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,100.04,USD,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-01,连连外币汇款 LL-USD-100,CMB-USD-TOL,LL-USD-100',
  ], 'cmb_usd_tol.csv'))
  const resUsdTolReject = reconcileStage3([llUsdDirect], [usdOverTolBank], { fxRates: { USD: 7.2 }, roundingToleranceCny: 0.05 })
  assert.equal(resUsdTolReject.stage3MatchedCny, 0)
  assert.notEqual(resUsdTolReject.stage3Status, 'matched')

  // 缺汇率时 fail-closed（绝不再回退固定 100 外币单位）
  const usdExactBank = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-21,100.00,USD,0.00,连连银通,深圳星海跨境科技有限公司,7559012345108821,ENT-01,连连外币汇款 LL-USD-100,CMB-USD-OK,LL-USD-100',
  ], 'cmb_usd_ok.csv'))
  const resUsdNoFx = reconcileStage3([llUsdDirect], [usdExactBank], { fxRates: {} })
  assert.equal(resUsdNoFx.stage3MatchedCny, 0)
  assert.notEqual(resUsdNoFx.stage3Status, 'matched')
  assert.ok(resUsdNoFx.alerts.some((a) => a.includes('缺失外币折算汇率')))

  const resUsdWithFx = reconcileStage3([llUsdDirect], [usdExactBank], { fxRates: { USD: 7.2 }, roundingToleranceCny: 0.05 })
  assert.equal(resUsdWithFx.stage3Status, 'matched')
  assert.equal(resUsdWithFx.stage3MatchedCny, 720)
})

// ════════════════════════════════════════════════════════════════
// 4. [P1-04 + R2 P1-15] 法国账单错月/法式金额 + 匿名/v9 规则防抢占 v0.8 通道
// ════════════════════════════════════════════════════════════════
test('[P1-04 + R2 P1-15] Amazon FR DD/MM/YYYY 归 2026-11、法式窄/不换行空格金额与歧义日期拦截', () => {
  // 4a) 法式金额解析：窄不换行空格 \u202f 与不换行空格 \u00a0 + 逗号小数
  assert.equal(fmtAmount(parseAmount('1\u202f234,50')), '1234.50')
  assert.equal(fmtAmount(parseAmount('1\u00a0234,50')), '1234.50')
  assert.equal(fmtAmount(parseAmount('-1\u202f234,50 €')), '-1234.50')
  assert.equal(parseAmountCell('12 34').state, 'invalid')

  // 4b) Amazon FR 账单：05/11/2026 必须归 2026-11（而非 2026-05），且法式金额水平守恒为 0
  const frCsv = [
    '"Includes Amazon FR transactions"',
    '"date/heure","numéro de versement","type","numéro de la commande","description","marketplace","ventes de produits","frais de vente","frais expédié par amazon","autre","total"',
    `"05/11/2026","SET-FR-11","Commande","402-1101","Article A","amazon.fr","1\u202f234,50","-185,18","-100,00","0,00","949,32"`,
    `"06/11/2026","SET-FR-11","Commande","402-1102","Article B","amazon.fr","1\u00a0234,50","-185,18","-100,00","0,00","949,32"`,
    `"10/11/2026","SET-FR-11","Transfert","","","amazon.fr","0,00","0,00","0,00","-1\u202f898,64","-1\u202f898,64"`,
  ].join('\n')
  const [fr] = parseStatementBuffer(Buffer.from(frCsv, 'utf8'), 'Amazon_FR_202611.csv')
  assert.equal(fr.platform, 'Amazon')
  assert.equal(fr.period, '2026-11', '法国账单 05/11/2026 必须按 DD/MM/YYYY 归为 2026-11')
  assert.equal(fmtAmount(fr.grossSales), '2469.00')
  assert.equal(fmtAmount(fr.actualPayout), '1898.64')
  assert.equal(fr.payoutEvidence[0].period, '2026-11')
  assert.equal(fr.horizontalDiffTotal, 0n)

  // 4c) 无法确定站点且 a<=12 && b<=12 && a!==b 的歧义斜杠日期必须列入待核，严禁静默猜成 2026-05
  assert.equal(transactionMonth('05/11/2026', { strict: true }), null)
  assert.equal(transactionMonth('05/11/2026', { strict: true, dateOrder: 'DMY' }), '2026-11')
  const ambigCsv = [
    '"date/time","settlement id","type","order id","description","marketplace","product sales","selling fees","fba fees","other","total"',
    '"05/11/2026","SET-X","Order","111-1","Item","","100.00","-15.00","0.00","0.00","85.00"',
  ].join('\n')
  const [ambig] = parseStatementBuffer(Buffer.from(ambigCsv, 'utf8'), 'Amazon_UnknownSite.csv')
  assert.equal(ambig.period, '待确认期间')
  assert.ok(ambig.anomalies.some((a) => a.category.includes('日/月歧义')))
})

test('[P1-04 + R2 P1-15] 否定守卫与权重降级：WorldFirst/Payoneer/Airwallex 绝不被 SUNRATE 或匿名 LianLian 抢占', () => {
  // 4d) WorldFirst 含 Buy Currency / Sell Currency 列（无论具名还是匿名），绝不被 SUNRATE 抢占
  const wfFxLines = [
    'Date,Order No,Transaction Type,Counterparty,Description,Currency,Buy Currency,Sell Currency,Credit,Debit,Fee,Net,Status',
    '2026-11-19,1000881,Platform payout,Amazon.com Services LLC,Amazon US,USD,CNY,USD,10000.00,0.00,0.00,10000.00,Completed',
    '2026-11-21,1000882,Withdrawal,深圳星海跨境科技有限公司,Corporate FX,USD,CNY,USD,0.00,6000.00,18.00,-6018.00,Completed',
  ]
  const wfFxRows = csvRows(wfFxLines, 'WorldFirst_FX_202611.csv')
  assert.equal(detectV9Platform(wfFxRows[0], 'WorldFirst_FX_202611.csv', wfFxRows), null)
  assert.equal(detectV9Platform(wfFxRows[0], 'export.csv', wfFxRows), null)
  assert.equal(parseStatementBuffer(Buffer.from(wfFxLines.join('\n'), 'utf8'), 'WorldFirst_FX_202611.csv')[0].platform, 'WorldFirst')
  assert.equal(parseStatementBuffer(Buffer.from(wfFxLines.join('\n'), 'utf8'), 'export.csv')[0].platform, 'WorldFirst')

  // 4e) 具名 WorldFirst 单列 Amount + 汇率 + 实收人民币，绝不被匿名 LianLian 规则抢占
  const wfSingleLines = [
    'Transaction Date,Order No,Transaction Type,Counterparty,Source Platform,Currency,Amount,FX Rate,Received CNY,Status',
    '2026-11-21,900101,Withdrawal,深圳星海跨境科技有限公司,Amazon,USD,-5000.00,7.24,36200.00,Completed',
  ]
  const wfSingleRows = csvRows(wfSingleLines, 'WorldFirst_202611.csv')
  assert.equal(detectV9Platform(wfSingleRows[0], 'WorldFirst_202611.csv', wfSingleRows), null)
  assert.equal(parseStatementBuffer(Buffer.from(wfSingleLines.join('\n'), 'utf8'), 'WorldFirst_202611.csv')[0].platform, 'WorldFirst')

  // 4f) 明确通道特征冲突（WorldFirst 双列 Credit/Debit 同时携带寻汇专属列「寻汇流水号」）→ 显式回报 STATEMENT_CANDIDATE_CONFLICT
  const conflictCsv = [
    'Date,寻汇流水号,Transaction Type,Counterparty,Currency,Credit,Debit,Status',
    '2026-11-21,1001,Withdrawal,深圳星海跨境科技有限公司,USD,0.00,5000.00,Completed',
  ].join('\n')
  assert.throws(
    () => parseStatementBuffer(Buffer.from(conflictCsv, 'utf8'), 'WorldFirst_Conflict.csv'),
    (err) => err.code === 'STATEMENT_CANDIDATE_CONFLICT',
  )
})

// ════════════════════════════════════════════════════════════════
// 5. [P1-05 + R2 P1-16 + R2 P1-17] 费用冲回符号、Lazada Not Paid、Amazon AWD 净额与双计费用修复
// ════════════════════════════════════════════════════════════════
test('[P1-05 + R2 P1-16 + R2 P1-17] SHEIN/Walmart 仅冲回行守恒、Lazada Not Paid 不计放款、AWD 冲销净额为 0 与独立 FEE 行不双计', () => {
  // 5a) SHEIN 仅含冲回行时不再被全局 dedSign 翻正，净额严格守恒
  const sheinRevOnly = [
    '结算日期,结算单号,合作模式,账务类型,站点,币种,销售额,商家优惠,平台补贴,退款金额,平台佣金,履约运费,质检扣款,提现金额,净结款',
    '2026-11-10,SHN-REV-1,半托管,费用冲回,US,USD,0.00,0.00,0.00,0.00,200.00,50.00,0.00,0.00,250.00',
  ].join('\n')
  const [shn] = parseStatementBuffer(Buffer.from(sheinRevOnly, 'utf8'), 'SHEIN_ReversalOnly.csv')
  assert.equal(shn.platform, 'SHEIN')
  assert.equal(fmtAmount(shn.platformCommission), '-200.00')
  assert.equal(fmtAmount(shn.logisticsWarehousing), '-50.00')
  assert.equal(shn.horizontalDiffTotal, 0n)

  // 5b) Walmart 宽表仅含冲回行时同样保负费用符号且水平守恒
  const wmRevOnly = [
    'Period Start Date,Period End Date,Order #,Transaction Type,Currency,Product Price,Commission,WFS,Refund,Amount',
    '2026-11-01,2026-11-30,WM-REV-1,ADJUSTMENT,USD,0.00,30.00,20.00,0.00,50.00',
  ].join('\n')
  const [wm] = parseStatementBuffer(Buffer.from(wmRevOnly, 'utf8'), 'Walmart_WideRevOnly.csv')
  assert.equal(wm.platform, 'Walmart')
  assert.equal(fmtAmount(wm.platformCommission), '-30.00')
  assert.equal(fmtAmount(wm.logisticsWarehousing), '-20.00')
  assert.equal(wm.horizontalDiffTotal, 0n)

  // 5c) Lazada Not Paid / 未付款状态绝不计入已放款 actualPayout，且 Refund 下的佣金冲回归 platformCommission 而非 customerRefund
  const lazadaCsv = [
    'Transaction Date,Transaction Type,Order No.,Fee Name,Amount,VAT in Amount,Paid Status,Statement,Currency',
    '2026-11-05,Orders,LZ-1,Item Price Credit,1000.00,0.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-06,Refund,LZ-1,Reversal Commission,50.00,3.00,Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-28,Payout,LZ-PAY-UNPAID,Bank Transfer Payout,-1053.00,0.00,Not Paid,01 Nov 2026 - 30 Nov 2026,MYR',
    '2026-11-29,Payout,LZ-PAY-UNPAID-CN,提现打款,-200.00,0.00,未付款,01 Nov 2026 - 30 Nov 2026,MYR',
  ].join('\n')
  const [lz] = parseStatementBuffer(Buffer.from(lazadaCsv, 'utf8'), 'Lazada_MY_Unpaid.csv')
  assert.equal(lz.platform, 'Lazada')
  assert.equal(fmtAmount(lz.actualPayout), '0.00', 'Not Paid / 未付款状态绝不得计入已放款')
  assert.equal(lz.payoutEvidenceCount, 0)
  assert.equal(fmtAmount(lz.customerRefund), '0.00')
  assert.equal(fmtAmount(lz.platformCommission), '-53.00')
  assert.ok(lz.anomalies.some((a) => a.category.includes('Not Paid')))

  // 5d) Amazon AWD -35 / +35 冲销：净额必须为 0.00（活动发生额 70.00），绝不把标签净额误显示为 70.00
  const amzAwdCsv = [
    '"Includes Amazon US transactions"',
    '"date/time","settlement id","type","order id","description","marketplace","product sales","selling fees","fba fees","other","total"',
    '"2026-11-08","SET-AWD","Service Fee","","AWD 3.5% Fuel and Inflation Surcharge","amazon.com","0.00","0.00","0.00","-35.00","-35.00"',
    '"2026-11-09","SET-AWD","Service Fee","","AWD 3.5% Fuel and Inflation Surcharge","amazon.com","0.00","0.00","0.00","35.00","35.00"',
  ].join('\n')
  const [amz] = parseStatementBuffer(Buffer.from(amzAwdCsv, 'utf8'), 'Amazon_AWD_Offset.csv')
  assert.equal(fmtAmount(amz.logisticsWarehousing), '0.00')
  assert.equal(amz.amazon2027Fees.length, 1)
  assert.equal(amz.amazon2027Fees[0].amount, '0.00')
  assert.equal(amz.amazon2027Fees[0].netAmount, '0.00')
  assert.equal(amz.amazon2027Fees[0].activityAmount, '70.00')
  const awdAnom = amz.anomalies.find((a) => a.category.includes('AWD/MCD 3.5%'))
  assert.equal(awdAnom.amount, '0.00')

  // 5e) platforms_v9.js 独立 FEE / FEE_REFUND 行只确认一次费用：Fee=Net=10 为 -10.00（绝不再双计为 -20.00！）
  const llFeeRefundCsv = [
    '交易时间,连连流水号,交易类型,平台来源,收款户名,币种,交易金额,手续费,净额,状态',
    '2026-11-10,LL-FR-1,手续费返还,Amazon,LianLian,USD,,10.00,10.00,Completed',
  ].join('\n')
  const [llFr] = parseV9PlatformRows('lianlian', csvRows(llFeeRefundCsv.split('\n'), 'll_fr.csv'), { fileName: 'll_fr.csv' })
  assert.equal(fmtAmount(llFr.walletMetrics.walletFees), '-10.00', '独立 FEE_REFUND 行 Fee=Net=10 必须为 -10.00 而非 -20.00')
  assert.equal(llFr.walletMetrics.netPendingCount, 0)

  const llFeeOnlyCsv = [
    '交易时间,连连流水号,交易类型,平台来源,收款户名,币种,交易金额,手续费,净额,状态',
    '2026-11-10,LL-F-1,手续费,Amazon,LianLian,USD,,10.00,-10.00,Completed',
  ].join('\n')
  const [llFee] = parseV9PlatformRows('lianlian', csvRows(llFeeOnlyCsv.split('\n'), 'll_f.csv'), { fileName: 'll_f.csv' })
  assert.equal(fmtAmount(llFee.walletMetrics.walletFees), '10.00', '独立 FEE 行 Fee=10, Net=-10 必须为 10.00 而非 20.00')
  assert.equal(llFee.walletMetrics.netPendingCount, 0)
})

// ════════════════════════════════════════════════════════════════
// 6. [P1-06 + R2 P2-07] Stage 1–2 候选层排除明确凭证冲突与巨额差额（如 100 vs 1 USD）
// ════════════════════════════════════════════════════════════════
test('[P1-06 + R2 P2-07] Stage 1–2 候选层排除三键冲突与 100 vs 1 USD 巨额差额，绝不伪称缺资料', () => {
  const mkPair = (pOverride, iOverride) => {
    const sale = makeEmptySummary({ period: '2026-11', platform: 'Amazon', site: 'US', currency: 'USD', formatLabel: 'csv', fileName: 'amz.csv' })
    sale.rawRowCount = 1
    sale.actualPayout = parseAmount(pOverride.amount ?? '100')
    sale.payoutEvidenceCount = 1
    sale.payoutEvidence = [{
      period: '2026-11',
      sourcePlatform: 'Amazon',
      amount: sale.actualPayout,
      entityKey: pOverride.entityKey ?? null,
      accountKey: pOverride.accountKey ?? null,
      referenceKey: pOverride.referenceKey ?? null,
    }]
    const wallet = makeEmptySummary({ period: '2026-11', platform: 'LianLian', site: 'US', currency: 'USD', formatLabel: 'csv', fileName: 'll.csv' })
    wallet.role = 'settlement_wallet'
    wallet.rawRowCount = 1
    wallet.walletMetrics = { platformInbound: parseAmount(iOverride.amount ?? '100') }
    wallet.inboundEvidence = [{
      period: '2026-11',
      sourcePlatform: 'Amazon',
      amount: wallet.walletMetrics.platformInbound,
      entityKey: iOverride.entityKey ?? null,
      accountKey: iOverride.accountKey ?? null,
      referenceKey: iOverride.referenceKey ?? null,
    }]
    return buildConsolidatedReconcile([finalizeSummary(sale), finalizeSummary(wallet)], { fxRates: { USD: 7.2 } }).fundChain
  }

  // 6a) 三键全部冲突（主体、账号、参考号均明确存在且不相等），即使同账期同平台同金额 100 USD → 绝不入候选！
  const triConflict = mkPair(
    { amount: '100', entityKey: 'ENT-A', accountKey: 'ACC-A', referenceKey: 'REF-A' },
    { amount: '100', entityKey: 'ENT-B', accountKey: 'ACC-B', referenceKey: 'REF-B' },
  )
  assert.equal(triConflict.candidateMatches.length, 0)
  assert.equal(triConflict.stage1to2Status, 'pending_evidence')

  // 6b) 任意单键冲突（主体冲突 / 账号冲突 / 参考号冲突）→ 绝不入候选！
  assert.equal(mkPair({ entityKey: 'ENT-A' }, { entityKey: 'ENT-B' }).candidateMatches.length, 0)
  assert.equal(mkPair({ accountKey: 'ACC-A' }, { accountKey: 'ACC-B' }).candidateMatches.length, 0)
  assert.equal(mkPair({ referenceKey: 'REF-A' }, { referenceKey: 'REF-B' }).candidateMatches.length, 0)

  // 6c) 巨额金额差（100 USD vs 1 USD，差 99%）→ 绝不入候选！
  const hugeGap = mkPair({ amount: '100' }, { amount: '1' })
  assert.equal(hugeGap.candidateMatches.length, 0)
})

// ════════════════════════════════════════════════════════════════
// 7. [P2-02 + R2 P2-08 + R2 P2-09] Excel 历元上界 / 序号 60 拦截 & 独立 import 0 TDZ
// ════════════════════════════════════════════════════════════════
test('[P2-02 + R2 P2-08 + R2 P2-09] Excel 1900 序号 60 拦截、1904 上界 < 2957004 与全模块独立 import 零 TDZ', () => {
  // 7a) Excel 1900 / 1904 序列号边界校验
  assert.equal(excelSerialToIsoDate(59, false), '1900-02-28')
  assert.equal(excelSerialToIsoDate(60, false), null, '1900 制虚构 1900-02-29（序号 60）必须被拦截而非静默映为 1900-02-28')
  assert.equal(excelSerialToIsoDate(60.75, false), null)
  assert.equal(excelSerialToIsoDate(61, false), '1900-03-01')
  assert.equal(excelSerialToIsoDate(2_958_465, false), '9999-12-31')
  assert.equal(excelSerialToIsoDate(2_958_466, false), null)
  assert.equal(excelSerialToIsoDate(0, true), '1904-01-01')
  assert.equal(excelSerialToIsoDate(2_957_003, true), '9999-12-31')
  assert.equal(excelSerialToIsoDate(2_957_004, true), null, '1904 制上界必须严格 < 2957004')
  assert.equal(excelSerialToIsoDate('', true), null)

  // 7b) 独立 import 各核心模块必须 0 ReferenceError (TDZ)
  for (const mod of [
    './lib/statement_shared.js',
    './lib/statement.js',
    './lib/platforms_v8.js',
    './lib/platforms_v9.js',
    './lib/bank_receipt.js',
    './lib/report.js',
    './lib/platforms_extra.js',
    './lib/platforms_v7.js',
  ]) {
    const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(mod)}).then(() => console.log('IMPORT_OK'))`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    assert.match(out, /IMPORT_OK/, `独立 import(${mod}) 必须成功无 TDZ`)
  }
})


// ════════════════════════════════════════════════════════════════
// 8. [#75 P0-1 & #81 ChatGPT P1] 掩码前缀冲突、带备注完整卡号冲突、跨银行冲突与候选层同步拦截
// ════════════════════════════════════════════════════════════════
test('[R2 #75 P0-1 & ChatGPT P1] 掩码前缀 6222****8821 vs 7559、带(基本户)备注完整卡号冲突与跨银行冲突全部拒配且排除候选', () => {
  assert.equal(extractFullBankAccountDigits('7559-0123-8821(基本户)'), '755901238821')
  assert.equal(extractFullBankAccountDigits('9999 0123 8821（一般户）'), '999901238821')
  assert.equal(extractAccountPrefix('6222****8821'), '6222')
  assert.equal(extractAccountPrefix('7559****8821(基本户)'), '7559')
  assert.equal(normalizeBankInstitutionCode('中国工商银行深圳分行'), 'ICBC')
  assert.equal(normalizeBankInstitutionCode('招商银行'), 'CMB')

  // 8a) 掩码前缀 6222****8821 + 工商银行 vs 755901238821 + 招商银行
  const [llMask] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,收款户名,收款银行账号,收款银行,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-P01-A,结汇提现,深圳星海跨境科技有限公司,6222****8821,工商银行,USD,10000.00,0.00,-10000.00,7.2400,72400.00,Completed',
  ]), { fileName: 'll_mask.csv' })
  const bankCmb = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72400.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,连连结汇 LL-P01-A,CMB-P01-A,LL-P01-A',
  ]), { fileName: 'cmb_p01.csv', bank: 'CMB' })
  const resA = reconcileStage3([llMask], [bankCmb])
  assert.notEqual(resA.stage3Status, 'matched')
  assert.equal(resA.stage3MatchedCny, 0)
  assert.equal(resA.stage3CandidateMatches.length, 0)

  // 8b) 双掩码不同前缀 6222****8821 vs 7559****8821（同银行同尾号仍须冲突拒配）
  const bankMaskB = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72400.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,7559****8821,连连结汇 LL-P01-A,ICBC-P01-B,LL-P01-A',
  ]), { fileName: 'icbc_mask.csv', bank: 'ICBC' })
  const resB = reconcileStage3([llMask], [bankMaskB])
  assert.equal(resB.stage3MatchedCny, 0)
  assert.equal(resB.stage3CandidateMatches.length, 0)

  // 8c) 带账户性质备注的不同完整卡号 7559-0123-8821(基本户) vs 9999 0123 8821(一般户)
  const [llNote] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,收款户名,收款银行账号,收款银行,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-P01-C,结汇提现,深圳星海跨境科技有限公司,7559-0123-8821(基本户),招商银行,USD,10000.00,0.00,-10000.00,7.2400,72400.00,Completed',
  ]), { fileName: 'll_note.csv' })
  const bankNoteConflict = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72400.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,9999 0123 8821(一般户),连连结汇 LL-P01-C,CMB-P01-C,LL-P01-C',
  ]), { fileName: 'cmb_note_bad.csv', bank: 'CMB' })
  const resC = reconcileStage3([llNote], [bankNoteConflict])
  assert.equal(resC.stage3MatchedCny, 0)
  assert.equal(resC.stage3CandidateMatches.length, 0)

  // 8d) 同尾号无前缀（仅写 ****8821）但跨银行机构（工商银行 vs 招商银行）→ 拒配！
  const [llIcbcTail] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,收款户名,收款银行账号,收款银行,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-P01-D,结汇提现,深圳星海跨境科技有限公司,****8821,中国工商银行,USD,10000.00,0.00,-10000.00,7.2400,72400.00,Completed',
  ]), { fileName: 'll_tail.csv' })
  const bankCmbTail = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72400.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,****8821,连连结汇 LL-P01-D,CMB-P01-D,LL-P01-D',
  ]), { fileName: 'cmb_tail.csv', bank: 'CMB' })
  assert.equal(reconcileStage3([llIcbcTail], [bankCmbTail]).stage3MatchedCny, 0)

  // 8e) 正向对照：前缀兼容 + 同银行 + 带(基本户)备注 → 正常 matched
  const bankNoteOk = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,72400.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821（基本户）,连连结汇 LL-P01-C,CMB-P01-OK,LL-P01-C',
  ]), { fileName: 'cmb_note_ok.csv', bank: 'CMB' })
  assert.equal(reconcileStage3([llNote], [bankNoteOk]).stage3Status, 'matched')
})

// ════════════════════════════════════════════════════════════════
// 9. [#75 P0-2 & #81 ChatGPT P0-3 / P0-4] 伪造部分退汇本币冻结、多次退汇同步、未完成退汇不抹本金、禁外部汇率放行
// ════════════════════════════════════════════════════════════════
test('[R2 #75 P0-2 & ChatGPT P0-3/P0-4] 伪造退汇本币冻结、2次退汇同步与退满清零、Failed/空状态退汇不抹本金、禁外部汇率替代凭证', () => {
  // 9a) 提现 USD 15,000（108,600 CNY），退回 USD 100 却伪造实收人民币 108,500，配 CNY 100 回单严禁 matched！
  const [llForged] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,关联流水号,交易类型,收款户名,收款银行账号,收款银行,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-20,LL-P02-1,,结汇提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,0.00,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
    '2026-11-22,LL-RET-1,LL-P02-1,退汇入账,深圳星海跨境科技有限公司,755901238821,招商银行,USD,100.00,0.00,0.00,100.00,7.2400,108500.00,Completed',
  ]), { fileName: 'll_forged.csv' })
  assert.equal(llForged.outboundEvidence[0].partialReturnFrozen, true)
  const bank100 = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-23,100.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,连连结汇 LL-P02-1,CMB-100,LL-P02-1',
  ]), { fileName: 'cmb_100.csv', bank: 'CMB' })
  const resForged = reconcileStage3([llForged], [bank100])
  assert.notEqual(resForged.stage3Status, 'matched')
  assert.equal(resForged.stage3MatchedCny, 0)
  assert.equal(resForged.stage2CorporateExpectedCny, 107876) // 14,900 * 7.24

  // 9b) 2 次合规部分退汇同步更新 wm.fxSettlementDiffCny，第 3 次退满 newRem===0n 时重置 partialReturn* 标志
  const [llTwoRet] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,关联流水号,交易类型,收款户名,收款银行账号,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-18,LL-2R,,结汇提现,深圳星海跨境科技有限公司,755901238821,USD,0.00,15000.00,0.00,-15000.00,7.2400,108500.00,Completed',
    '2026-11-19,LL-2R-A,LL-2R,退汇入账,深圳星海跨境科技有限公司,755901238821,USD,5000.00,0.00,0.00,5000.00,7.2400,36166.67,Completed',
    '2026-11-20,LL-2R-B,LL-2R,退汇入账,深圳星海跨境科技有限公司,755901238821,USD,4000.00,0.00,0.00,4000.00,7.2400,28933.33,Completed',
  ]), { fileName: 'll_2r.csv' })
  assert.equal(llTwoRet.walletMetrics.fxSettlementDiffCny, llTwoRet.outboundEvidence[0].fxDiffCny)

  const [llFullRet] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,关联流水号,交易类型,收款户名,收款银行账号,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-18,LL-3R,,结汇提现,深圳星海跨境科技有限公司,755901238821,USD,0.00,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
    '2026-11-19,LL-3R-A,LL-3R,退汇入账,深圳星海跨境科技有限公司,755901238821,USD,5000.00,0.00,0.00,5000.00,7.2400,36200.00,Completed',
    '2026-11-20,LL-3R-B,LL-3R,退汇入账,深圳星海跨境科技有限公司,755901238821,USD,10000.00,0.00,0.00,10000.00,7.2400,72400.00,Completed',
  ]), { fileName: 'll_3r.csv' })
  assert.equal(llFullRet.outboundEvidence[0].principalAmount, 0n)
  assert.equal(llFullRet.outboundEvidence[0].partialReturn, false)
  assert.equal(llFullRet.outboundEvidence[0].partialReturnFrozen, false)
  assert.equal(llFullRet.outboundEvidence[0].cnySettlementUnverified, false)

  // 9c) [ChatGPT P0-3] 未完成退汇（Failed / Pending / 空状态）严禁冲减原提款本金或抹去分母（应核分母保持 217,200！）
  const [llFailedRet] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,关联流水号,交易类型,收款户名,收款银行账号,收款银行,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-20,LL-F1,,结汇提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,0.00,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
    '2026-11-21,LL-F2,,结汇提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,0.00,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
    '2026-11-22,LL-F2-RET,LL-F2,退汇入账,深圳星海跨境科技有限公司,755901238821,招商银行,USD,15000.00,0.00,0.00,15000.00,7.2400,108600.00,Failed',
  ]), { fileName: 'll_failed_ret.csv' })
  const bankF1 = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-20,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-F1,CMB-F1,LL-F1',
  ]), { fileName: 'cmb_f1.csv', bank: 'CMB' })
  const resFailedRet = reconcileStage3([llFailedRet], [bankF1])
  assert.equal(resFailedRet.stage2CorporateExpectedCny, 217200)
  assert.notEqual(resFailedRet.stage3Status, 'matched')

  // 9d) [ChatGPT P0-4] 缺实结凭证的跨币种部分退汇禁止借外部 fxRates 放行正式 matched
  const [llNoFxProof] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,关联流水号,交易类型,收款户名,收款银行账号,收款银行,币种,入账金额,提现金额,手续费,净额,状态',
    '2026-11-20,LL-NFX,,结汇提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,0.00,15000.00,0.00,-15000.00,Completed',
    '2026-11-21,LL-NFX-R,LL-NFX,退汇入账,深圳星海跨境科技有限公司,755901238821,招商银行,USD,5000.00,0.00,0.00,5000.00,Completed',
  ]), { fileName: 'll_nfx.csv' })
  const bank72400 = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-22,72400.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-NFX,CMB-NFX,LL-NFX',
  ]), { fileName: 'cmb_nfx.csv', bank: 'CMB' })
  const resNoFxProof = reconcileStage3([llNoFxProof], [bank72400], { fxRates: { USD: 7.24 } })
  assert.equal(resNoFxProof.stage3MatchedCny, 0)
  assert.notEqual(resNoFxProof.stage3Status, 'matched')
})

// ════════════════════════════════════════════════════════════════
// 10. [#81 ChatGPT P0-1, P0-2, P1 & #75 P0-3, P1-4] 借方冲正拦截、显式关联号冲突、缺汇率/非法汇率预检与外币回单报表折算
// ════════════════════════════════════════════════════════════════
test('[R2 ChatGPT P0-1/P0-2/P1 & #75 P0-3/P1-4] 银行借方冲正冻结、摘要不盖显式关联号冲突、空币种/空状态/覆盖率拦截、非法汇率告警与外币回单折算一致', () => {
  const [llOk] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,收款户名,收款银行账号,收款银行,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-WD-2411,结汇提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
  ]), { fileName: 'll_ok.csv' })

  // 10a) [ChatGPT P0-1] 同关联号先贷记 108,600 后以另一回单号借记冲正 108,600（同文件 & 跨文件）→ 严禁 matched！
  const bankSameFileRev = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-WD-2411,CMB-CR-1,LL-WD-2411',
    '2026-11-22,0.00,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,冲正退票 LL-WD-2411,CMB-DR-2,LL-WD-2411',
  ]), { fileName: 'cmb_rev.csv', bank: 'CMB' })
  assert.equal(reconcileStage3([llOk], [bankSameFileRev]).stage3MatchedCny, 0)

  const bankCrOnly = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-WD-2411,CMB-CR-X1,LL-WD-2411',
  ]), { fileName: 'cmb_cr_x1.csv', bank: 'CMB' })
  const bankDrOtherFile = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-23,0.00,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,跨日退票冲正,CMB-DR-X2,LL-WD-2411',
  ]), { fileName: 'cmb_dr_x2.csv', bank: 'CMB' })
  assert.equal(reconcileStage3([llOk], [bankCrOnly, bankDrOtherFile]).stage3MatchedCny, 0)

  // 10b) [ChatGPT P0-2] 银行显式关联号列为 LL-WD-9292，摘要提到 LL-WD-2411 → 显式关联号冲突直接排除（法定与候选均为 0）！
  const bankRefConflict = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇入账 LL-WD-2411,CMB-REF-BAD,LL-WD-9292',
  ]), { fileName: 'cmb_ref_bad.csv', bank: 'CMB' })
  const resRefConflict = reconcileStage3([llOk], [bankRefConflict])
  assert.equal(resRefConflict.stage3MatchedCny, 0)
  assert.equal(resRefConflict.stage3CandidateMatches.length, 0)

  // 10c) [ChatGPT P1] 银行币种格空白 / 存在状态列但单元格空白 / coverageComplete=false 均禁止正式 matched
  const bankBlankCcy = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,108600.00,,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇,CMB-BCCY,LL-WD-2411',
  ]), { fileName: 'cmb_bccy.csv', bank: 'CMB' })
  assert.equal(reconcileStage3([llOk], [bankBlankCcy]).stage3MatchedCny, 0)

  const bankBlankStatus = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号,交易状态',
    '2026-11-21,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇,CMB-BST,LL-WD-2411,',
  ]), { fileName: 'cmb_bst.csv', bank: 'CMB' })
  assert.equal(reconcileStage3([llOk], [bankBlankStatus]).stage3MatchedCny, 0)
  assert.notEqual(reconcileStage3([llOk], [bankCrOnly], { coverageComplete: false }).stage3Status, 'matched')

  // 10d) [#75 P0-3] 缺外币汇率或传入 0 / -7.2 / NaN：必须提前产出高优缺汇率告警，严禁静默展示“折合 ¥0.00”！
  const [wfEur] = parseStatementBuffer(Buffer.from([
    '交易时间,交易流水号,交易类型,对方户名,备注,币种,入账金额,出账金额,手续费,净变动,状态',
    '2026-11-10,WF-EUR-1,结汇提现,深圳星海跨境科技有限公司(对公基本户),对公回流,EUR,0.00,10000.00,0.00,-10000.00,Completed',
    '2026-11-11,WF-EUR-2,提现,张三个人储蓄卡,私户提现,EUR,0.00,2000.00,0.00,-2000.00,Completed',
  ].join('\n'), 'utf8'), 'WorldFirst_EUR.csv')
  const resBadFx = reconcileStage3([wfEur], [], { fxRates: { EUR: 0, USD: -7.2, HKD: NaN } })
  assert.ok(resBadFx.missingFxCurrencies.includes('EUR'))
  assert.ok(resBadFx.invalidFxCurrencies.includes('EUR') && resBadFx.invalidFxCurrencies.includes('USD') && resBadFx.invalidFxCurrencies.includes('HKD'))
  assert.ok(resBadFx.alerts.some((a) => a.includes('缺失外币汇率')))
  assert.ok(resBadFx.alerts.some((a) => a.includes('外币汇率参数非法')))
  assert.equal(resBadFx.alerts.some((a) => a.includes('折合 ¥0.00')), false)
  assert.ok(resBadFx.alerts.some((a) => a.includes('EUR 10000.00')))
  const resEmptyFx = reconcileStage3([wfEur], [], { fxRates: {} })
  assert.ok(resEmptyFx.missingFxCurrencies.includes('EUR'))
  assert.ok(resEmptyFx.alerts.some((a) => a.includes('缺失外币汇率')))
  assert.equal(resEmptyFx.alerts.some((a) => a.includes('折合 ¥0.00')), false)

  // 10e) [#75 P1-4] 原币美元提现（fxRate=1.0000 无实收人民币）+ 国内对公美元户回单（USD 14,980 + 手续费 USD 20）→ report.js 折算一致不报 0.00
  const [llUsdSame] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,收款户名,收款银行账号,收款银行,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-21,LL-USD-SAME,原币提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,15000.00,0.00,-15000.00,1.0000,,Completed',
  ]), { fileName: 'll_usd_same.csv' })
  assert.equal(llUsdSame.outboundEvidence[0].targetCurrency, 'USD')
  const [cmbUsd] = parseStatementBuffer(Buffer.from([
    '交易日期,贷方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-21,14980.00,USD,20.00,LianLian Pay,深圳星海跨境科技有限公司,755901238821,原币入账 LL-USD-SAME,CMB-USD-1,LL-USD-SAME',
  ].join('\n'), 'utf8'), 'CMB_USD_Receipt.csv')
  const consUsd = buildConsolidatedReconcile([llUsdSame, cmbUsd], { fxRates: { USD: 7.24 } })
  assert.equal(consUsd.fundChain.stage3VerificationStatus, 'matched')
  assert.equal(consUsd.fundChain.bankReceivedCny, 108455.2)
  assert.equal(consUsd.fundChain.stage3.stage3MatchedCny, 108455.2)
  const bankRow = consUsd.breakdown.find((r) => r.role === 'bank_receipt')
  assert.equal(bankRow.bankCreditCny, 108455.2)
  assert.equal(bankRow.bankFeeCny, 144.8)
  const mdUsd = renderDiagnosticReportMd({ summaries: [llUsdSame, cmbUsd], consolidated: consUsd })
  const htmlUsd = renderDiagnosticReportHtml({ summaries: [llUsdSame, cmbUsd], consolidated: consUsd })
  assert.ok(mdUsd.includes('108455.20') && mdUsd.includes('144.80'))
  assert.ok(htmlUsd.includes('108455.20') && htmlUsd.includes('144.80'))
})

// ════════════════════════════════════════════════════════════════
// 11. [#75 P1-1, P2-1, P2-2 + #73 P1-1 + ChatGPT P1] 欧陆金额/分号CSV/日期/DMY/混排歧义/Lazada空状态/Returned/orderCount/18模块import
// ════════════════════════════════════════════════════════════════
test('[R2 #75 P1-1/P2-1/P2-2 + #73 P1-1 + ChatGPT P1] 欧陆负号括号千位、法站分号CSV、fév/西语de日期、混排歧义阻断、DMY透传、Returned剔除、全11渠道 orderCount 与 18/18 lib 独立 import', () => {
  // 11a) 欧陆负号/括号/多级千位金额变体
  for (const [raw, expected] of [
    ['−1 234,50', '-1234.50'],
    ['–1.234,50', '-1234.50'],
    ['－1,234.50', '-1234.50'],
    ['€(1 234,50)', '-1234.50'],
    ['$(1,234.50)', '-1234.50'],
    ['(1.234,50) EUR', '-1234.50'],
    ['1.234.567', '1234567.00'],
  ]) {
    const parsed = parseAmountCell(raw)
    assert.equal(parsed.state, 'value', `parseAmountCell(${raw}) 应解析为有效金额`)
    assert.equal(fmtAmount(parsed.value), expected)
  }
  assert.equal(parseAmountCell(NaN).state, 'invalid')

  // 11b) 10 行标准法站 Amazon 分号 CSV（每行 6 个 `;`，引号逗号 + 3 列欧式小数逗号共 7 个 `,`）不崩溃且精准解析
  const frLines = ['date/heure;numéro de versement;type;numéro de la commande;description;ventes de produits;frais de vente;total']
  for (let i = 1; i <= 10; i++) {
    frLines.push(`05/11/2026;SET-FR-1;Commande;402-${i};"Article A, lot B, réf C, noir";1 234,50;-185,18;1 049,32`)
  }
  const [frAmz] = parseStatementBuffer(Buffer.from(frLines.join('\n'), 'utf8'), 'Amazon_FR_Semi.csv')
  assert.equal(frAmz.platform, 'Amazon')
  assert.equal(frAmz.period, '2026-11')
  assert.equal(frAmz.orderCount, 10)
  assert.equal(fmtAmount(frAmz.grossSales), '12345.00')

  // 11c) 法语 fév. / 西班牙语 de / 德语 Jän. 与非法日历日 31/11/2026 告警 + 未知站点混排确定日期与歧义日期阻断
  assert.equal(transactionMonth('15 fév. 2026'), '2026-02')
  assert.equal(transactionMonth('15 de nov. de 2026'), '2026-11')
  assert.equal(transactionMonth('15 de noviembre de 2026'), '2026-11')
  assert.equal(transactionMonth('15 Jän. 2026'), '2026-01')

  const [badCal] = parseStatementBuffer(Buffer.from([
    'Transaction Date,Type,Order,Financial Status,Currency,Amount,Fee,Net',
    '31/11/2026,charge,#901,paid,EUR,100.00,3.00,97.00',
  ].join('\n'), 'utf8'), 'Shopify_BadDate.csv')
  assert.equal(badCal.period, '待确认期间')
  assert.ok(badCal.anomalies.some((a) => a.category.includes('日历日期')))

  const [mixedAmbig] = parseStatementBuffer(Buffer.from([
    'Created,ID,Type,Description,Currency,Amount,Fee,Net',
    '2026-11-21,txn_1,charge,Sale A,USD,100.00,3.00,97.00',
    '04/11/2026,txn_2,charge,Sale B,USD,200.00,6.00,194.00',
  ].join('\n'), 'utf8'), 'Stripe_Global.csv')
  assert.equal(mixedAmbig.period, '待确认期间', '未知站点混排 ISO 与歧义斜杠日期严禁静默并入 2026-11')
  assert.ok(mixedAmbig.anomalies.some((a) => a.category.includes('日/月歧义')))

  // 11d) [#75 P2-1] TikTok / Stripe / Temu / Shopify / PayPal / AliExpress 欧洲站月初斜杠日期透传 DMY -> 2026-11
  const euCases = [
    ['TikTok_EU.csv', 'Statement ID,Statement Date,Type,Order ID,Region,Currency,Gross Sales,Total Settlement Amount\nST-1,05/11/2026,Order,TT-1,DE,EUR,100.00,100.00'],
    ['Stripe_EU.csv', 'Created,ID,Type,Description,Currency,Amount,Fee,Net\n05/11/2026,txn_eu,charge,Sale,EUR,100.00,3.00,97.00'],
    ['Temu_EU.csv', '结算时间,订单号,经营模式,账务类型,站点,币种,商品零售价,应结金额\n05/11/2026,PO-1,半托管,销售,DE,EUR,100.00,100.00'],
    ['Shopify_EU.csv', 'Transaction Date,Type,Order,Financial Status,Currency,Amount,Fee,Net\n05/11/2026,charge,#1,paid,EUR,100.00,3.00,97.00'],
    ['PayPal_EU.csv', 'Date,Name,Type,Status,Currency,Gross,Fee,Net,Sales Tax,Transaction ID\n05/11/2026,Buyer,Express Checkout Payment,Completed,EUR,100.00,-3.00,97.00,0.00,PP-1'],
    ['AE_EU.csv', '入账时间,订单号,业务模式,交易类型,站点,币种,商品金额,联盟佣金,平台代扣税费,放款净额\n05/11/2026,AE-1,POP自运营,放款,ES,EUR,100.00,0.00,20.00,100.00'],
  ]
  for (const [fn, csv] of euCases) {
    const [sum] = parseStatementBuffer(Buffer.from(csv, 'utf8'), fn)
    assert.equal(sum.period, '2026-11', `${fn} 欧洲站 05/11/2026 应按 DMY 归入 2026-11`)
    assert.equal(sum.orderCount, 1, `${fn} 应统计 1 笔有效订单`)
  }

  // 11e) Lazada 存在 Paid Status 列但单元格空白时不计已放款；单条 status=Returned 对公提现不入分母
  const [lzBlank] = parseV9PlatformRows('lazada', csvRows([
    'Transaction Date,Transaction Type,Fee Name,Order No.,Statement,Paid Status,Amount,VAT in Amount,WHT Amount,Currency',
    '2026-11-10,Orders,Item Price Credit,LZ-ORD-1,LZ-ST-1,,500.00,0.00,0.00,SGD',
  ]), { fileName: 'Lazada_SG.csv' })
  assert.equal(lzBlank.actualPayout, 0n)
  assert.equal(lzBlank.orderCount, 1)

  const [llRetOnly] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,收款户名,收款银行账号,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-20,LL-RET-ONLY,结汇提现,深圳星海跨境科技有限公司,755901238821,USD,8000.00,0.00,-8000.00,7.2400,57920.00,Returned',
  ]), { fileName: 'll_ret_only.csv' })
  assert.equal(llRetOnly.walletMetrics.fxWithdrawToCorporate, 0n)
  assert.equal(reconcileStage3([llRetOnly], []).stage2CorporateExpectedCny, 0)

  // 11f) 全部 11 大销售渠道沙盒（demo:full + demo:v9 + TikTok + Stripe）均稳定输出正整数 orderCount 并透传 serializeSummary / breakdown
  const allSales = [
    ...parsePlatformStatement('demo:full'),
    ...parsePlatformStatement('demo:v9').filter((s) => s.role === 'sales_platform'),
  ]
  for (const s of allSales) {
    assert.ok(Number.isInteger(s.orderCount) && s.orderCount >= 1, `${s.platform} orderCount 应 >= 1，实际 ${s.orderCount}`)
    assert.equal(serializeSummary(s).orderCount, s.orderCount)
  }
  const consSales = buildConsolidatedReconcile(allSales, {
    fxRates: { USD: 7.25, EUR: 7.85, MYR: 1.65, SGD: 5.4 },
  })
  assert.ok(consSales.breakdown.filter((b) => b.role === 'sales_platform').every((b) => Number.isInteger(b.orderCount) && b.orderCount >= 1))
  // 独立站 + PayPal 网关并存时，payment_gateway_overlap 条目 orderCount 置 0 防重复计笔数
  assert.ok(consSales.breakdown.filter((b) => b.role === 'payment_gateway_overlap').every((b) => b.orderCount === 0 && b.gatewayOrderCount >= 1))

  // 11g) [ChatGPT P1] 全仓 lib/*.js（含 parse_worker.js 共 18 个模块）主线程独立 import() 100% 零报错
  const libFiles = readdirSync(join(REPO_ROOT, 'lib')).filter((f) => f.endsWith('.js')).sort()
  assert.ok(libFiles.length >= 18 && libFiles.includes('parse_worker.js'))
  for (const f of libFiles) {
    const mod = `./lib/${f}`
    const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(mod)}).then(() => console.log('IMPORT_OK'))`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    assert.match(out, /IMPORT_OK/, `独立 import(${mod}) 必须零报错`)
  }
})

// ════════════════════════════════════════════════════════════════
// 12. [#92 P1 回归 / P1 / P2] 借方冲正参考号排他、长表同单多 SKU 去重计单、全表空币种回单不默认 CNY
// ════════════════════════════════════════════════════════════════
test('[R2 #92] 借方冲正不连坐无辜等额回单、Amazon V2/Lazada/Walmart 同单多 SKU 计 1 单、全表空币种银行回单报缺汇率', () => {
  // 12a) 同月同户 2 笔等额结汇：仅 LL-WD-B 被冲正，LL-WD-A 必须正常核销（partial），绝不连坐冻结
  const [llAB] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,收款户名,收款银行账号,收款银行,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-20,LL-WD-A,结汇提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
    '2026-11-21,LL-WD-B,结汇提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
  ]), { fileName: 'll_ab.csv' })
  const bankAB = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-20,108600.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-WD-A,CMB-CR-A,LL-WD-A',
    '2026-11-21,108600.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-WD-B,CMB-CR-B,LL-WD-B',
    '2026-11-22,0.00,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,冲正退票 LL-WD-B,CMB-DR-B,LL-WD-B',
  ]), { fileName: 'cmb_ab.csv', bank: 'CMB' })
  const resAB = reconcileStage3([llAB], [bankAB])
  assert.equal(resAB.stage3MatchedCny, 108600)
  assert.equal(resAB.stats.matchedCount, 1)
  assert.equal(resAB.stage3Status, 'partial')
  assert.equal(resAB.abnormalReceipts.filter((x) => x.status === 'debit_reversed').length, 1)

  // 12b) 无参考号或带银行内部「孤儿冲正流水号」（RVS-778899，不对应任何已知回单/结汇单）的同户等额借方冲正必须保守冻结
  const [llOne] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,收款户名,收款银行账号,收款银行,币种,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-20,LL-WD-N,结汇提现,深圳星海跨境科技有限公司,755901238821,招商银行,USD,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
  ]), { fileName: 'll_one.csv' })
  const bankNoRefRev = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-20,108600.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-WD-N,CMB-CR-N,LL-WD-N',
    '2026-11-22,0.00,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,冲正退票,CMB-DR-N,',
  ]), { fileName: 'cmb_noref.csv', bank: 'CMB' })
  assert.equal(reconcileStage3([llOne], [bankNoRefRev]).stage3MatchedCny, 0)

  const bankOrphanColRev = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-20,108600.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-WD-N,CMB-CR-N,LL-WD-N',
    '2026-11-22,0.00,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,冲正退票,CMB-DR-9,RVS-778899',
  ]), { fileName: 'cmb_orphan_col.csv', bank: 'CMB' })
  const resOrphanCol = reconcileStage3([llOne], [bankOrphanColRev])
  assert.equal(resOrphanCol.stage3MatchedCny, 0)
  assert.notEqual(resOrphanCol.stage3Status, 'matched')

  const bankOrphanSummaryRev = parseBankReceiptRows(csvRows([
    '交易日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-20,108600.00,0.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-WD-N,CMB-CR-N,LL-WD-N',
    '2026-11-22,0.00,108600.00,CNY,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,冲正退票 RVS-778899,CMB-DR-9,',
  ]), { fileName: 'cmb_orphan_sum.csv', bank: 'CMB' })
  const resOrphanSum = reconcileStage3([llOne], [bankOrphanSummaryRev])
  assert.equal(resOrphanSum.stage3MatchedCny, 0)
  assert.notEqual(resOrphanSum.stage3Status, 'matched')

  // 12c) Amazon V2 / Lazada / Walmart 长表：同一订单多 SKU 明细行仅计 1 单，Gift Wrap 等杂项行不计单
  const [amzV2] = parseStatementBuffer(Buffer.from([
    'settlement-id,settlement-end-date,deposit-date,total-amount,currency,transaction-type,order-id,marketplace-name,amount-type,amount-description,amount,posted-date',
    'SET-1,,,,USD,Order,114-SAME-ORD,Amazon.com,ItemPrice,Principal,50.00,2026-11-05',
    'SET-1,,,,USD,Order,114-SAME-ORD,Amazon.com,ItemPrice,Principal,30.00,2026-11-05',
    'SET-1,,,,USD,Order,114-OTHER,Amazon.com,ItemPrice,Principal,20.00,2026-11-06',
  ].join('\n'), 'utf8'), 'Amazon_V2_US.csv')
  assert.equal(amzV2.platform, 'Amazon')
  assert.equal(amzV2.orderCount, 2)

  const [lzSame] = parseStatementBuffer(Buffer.from([
    'Transaction Date,Transaction Type,Fee Name,Order No.,Statement,Paid Status,Amount,VAT in Amount,WHT Amount,Currency',
    '2026-11-10,Orders,Item Price Credit,LZ-ORD-SAME,LZ-ST-1,paid,300.00,0.00,0.00,SGD',
    '2026-11-10,Orders,Item Price Credit,LZ-ORD-SAME,LZ-ST-1,paid,200.00,0.00,0.00,SGD',
  ].join('\n'), 'utf8'), 'Lazada_SG.csv')
  assert.equal(lzSame.platform, 'Lazada')
  assert.equal(lzSame.orderCount, 1)

  const [wmSame] = parseStatementBuffer(Buffer.from([
    'Period End Date,Order #,Transaction Type,Amount Type,Amount,Currency',
    '2026-11-30,WM-SAME-ORD,Sale,Product Price,40.00,USD',
    '2026-11-30,WM-SAME-ORD,Sale,Product Price,25.00,USD',
    '2026-11-30,WM-SAME-ORD,Sale,Gift Wrap,3.00,USD',
  ].join('\n'), 'utf8'), 'Walmart_Recon.csv')
  assert.equal(wmSame.platform, 'Walmart')
  assert.equal(wmSame.orderCount, 1)

  // 12d) 无币种列的国内银行回单：保持 UNKNOWN，不阻塞整份合并报告 ready，明细显示币种待核/待确认币种，Stage 3 靠 blankCurrency 阻断核销
  const [bankNoCcyCol] = parseStatementBuffer(Buffer.from([
    '交易日期,贷方发生额,借方发生额,手续费,对方户名,本方户名,本方账号,摘要,银行回单号,关联流水号',
    '2026-11-20,108600.00,0.00,0.00,连连银通,深圳星海跨境科技有限公司,755901238821,结汇 LL-WD-N,CMB-BL-1,LL-WD-N',
  ].join('\n'), 'utf8'), 'CMB_NoCcyCol_Receipt.csv')
  assert.equal(bankNoCcyCol.role, 'bank_receipt')
  assert.equal(bankNoCcyCol.currency, 'UNKNOWN')

  const amzSummaries = parsePlatformStatement('demo:amazon').filter((s) => s.currency === 'USD')
  const [llUsd] = parseV9PlatformRows('lianlian', csvRows([
    '交易时间,连连流水号,交易类型,对方名称,收款户名,收款银行账号,收款银行,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-18,LL-IN-1,平台收款,Amazon Services LLC,,,,USD,20000.00,0.00,0.00,20000.00,,,Completed',
    '2026-11-20,LL-WD-N,结汇提现,,深圳星海跨境科技有限公司,755901238821,招商银行,USD,0.00,15000.00,0.00,-15000.00,7.2400,108600.00,Completed',
  ]), { fileName: 'll_usd.csv' })
  const allSummaries = [...amzSummaries, llUsd, bankNoCcyCol]
  const consNoCcy = buildConsolidatedReconcile(allSummaries, { fxRates: { USD: 7.24 } })
  assert.equal(consNoCcy.ready, true)
  assert.ok(consNoCcy.fundChain)
  assert.ok(consNoCcy.totals.netSalesCny > 0)
  assert.notEqual(consNoCcy.fundChain.stage3VerificationStatus, 'matched')
  assert.equal(consNoCcy.fundChain.stage3.stage3MatchedCny, 0)
  assert.ok(consNoCcy.fundChain.alerts.some((a) => a.includes('币种缺失')))
  const bankBd = consNoCcy.breakdown.find((b) => b.role === 'bank_receipt')
  assert.equal(bankBd.currency, '币种待核')
  assert.equal(bankBd.bankCreditCny, null)
  assert.equal(bankBd.bankFeeCny, null)
  const mdOut = renderDiagnosticReportMd({ summaries: allSummaries, consolidated: consNoCcy })
  const htmlOut = renderDiagnosticReportHtml({ summaries: allSummaries, consolidated: consNoCcy })
  assert.ok(!mdOut.includes('人民币折算待核'))
  assert.match(mdOut, /币种待核/)
  assert.match(mdOut, /待确认币种/)
  assert.match(htmlOut, /币种待核/)
  assert.match(htmlOut, /待确认币种/)
})

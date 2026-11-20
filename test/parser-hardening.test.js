import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
  AMOUNT_SCALE, createStatementBudget, fmtAmount, parseAmount, parseAmountCell,
  parseStatementBuffer, readTabularSheetsFromBuffer,
} from '../lib/statement.js'
import { buildConsolidatedReconcile, serializeSummary } from '../lib/report.js'

const stripeHeader = 'Date,Transaction ID,Type,Description,Currency,Amount,Fee,Net'
const walletHeader = 'Date,Transaction ID,Type,Description,Counterparty,Currency,Amount,Fee,Net,Status'
const parse = (name, lines) => parseStatementBuffer(Buffer.from(lines.join('\n'), 'utf8'), name)

function packWorkbook(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, xml] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const txt = Buffer.from(xml)
    const compressed = deflateRawSync(txt)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(txt.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    local.push(localHeader, nameBytes, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(txt.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBytes)
    offset += localHeader.length + nameBytes.length + compressed.length
  }
  const directory = Buffer.concat(central)
  const footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50)
  footer.writeUInt16LE(Object.keys(entries).length, 8)
  footer.writeUInt16LE(Object.keys(entries).length, 10)
  footer.writeUInt32LE(directory.length, 12)
  footer.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, footer])
}

function sheetXml(lines) {
  const rows = lines.map((line, i) => {
    const cells = line.split(',').map((value) => '<c t="inlineStr"><is><t>' + value + '</t></is></c>').join('')
    return '<row r="' + (i + 1) + '">' + cells + '</row>'
  })
  return '<worksheet><sheetData>' + rows.join('') + '</sheetData></worksheet>'
}

test('核对每张工作表，钱包名称不改变 Stripe 归类，未知页只给安全诊断', () => {
  const wf = [
    'Date,Transaction ID,Transaction Type,Counterparty,Currency,Credit,Debit',
    '2026-11-02,WF-1,Platform payout,Amazon,CNY,50,0',
  ]
  const stripe = [stripeHeader, '2026-11-02,txn_1,charge,Airwallex reference,RMB,100,5,95']
  const archive = packWorkbook({
    'xl/worksheets/sheet1.xml': sheetXml(wf),
    'xl/worksheets/sheet2.xml': sheetXml(stripe),
    'xl/worksheets/sheet3.xml': sheetXml(['Date,Names,Personal-Info', '2026-11-02,PRIVATE_NOTE,1234']),
  })
  const summaries = parseStatementBuffer(archive, 'Payoneer destination.xlsx')
  assert.deepEqual(summaries.map((item) => item.platform), ['WorldFirst', 'Stripe'])
  assert.equal(summaries[1].currency, 'CNY')
  assert.equal(fmtAmount(summaries[1].grossSales), '100.00')
  assert.deepEqual(summaries[0].parseDiagnostics, [{
    code: 'STATEMENT_UNKNOWN_FORMAT', sheetIndex: 3, candidateRows: [{ row: 1, fields: ['date'] }],
  }])
  const budget = createStatementBudget()
  readTabularSheetsFromBuffer(archive, 'valid.xlsx', budget)
  assert.equal(budget.entries, 3)
  assert.equal(budget.rows, 6)
  budget.expandedBytes = 120 * 1024 * 1024
  assert.throws(() => readTabularSheetsFromBuffer(archive, 'valid.xlsx', budget), { code: 'STATEMENT_LIMIT' })
})

test('表头和交易枚举重叠时显式回报候选冲突', () => {
  assert.throws(
    () => parse('rename.csv', [
      'Date,Transaction ID,Type,Description,Counterparty,Currency,Amount,Fee,Status',
      '2026-11-02,WF-1,Withdrawal,Bank,Business Ltd,CNY,-100,0,Completed',
      '2026-11-03,PY-1,Withdrawal,Bank,Business Ltd,CNY,-100,0,Completed',
    ]),
    (error) => {
      assert.equal(error.code, 'STATEMENT_CANDIDATE_CONFLICT')
      assert.deepEqual(error.diagnostics[0].candidates, ['WorldFirst', 'Payoneer'])
      return true
    },
  )
})

test('单列 Credit/Debit 与正负号费用均遵守原始净额', () => {
  const [summary] = parse('unknown.csv', [
    walletHeader.replace(',Amount,', ',Credit/Debit,'),
    '2026-11-01,PY-1,Incoming,Platform payout,Amazon,CNY,100,-5,95,Completed',
    '2026-11-02,PY-2,Withdrawal,Bank payout,Business Ltd,CNY,-100,-3,-100,Completed',
    '2026-11-03,PY-3,Fee refund,Annual fee refund,Wallet,CNY,2,0,2,Completed',
  ])
  const wm = summary.walletMetrics
  assert.equal(summary.platform, 'Payoneer')
  assert.equal(fmtAmount(wm.signedNetFlow), '-3.00')
  assert.equal(fmtAmount(wm.walletFees), '6.00')
  assert.equal(wm.netVerifiedRows, 3)
  assert.equal(wm.netPendingCount, 0)
  assert.equal(wm.unrepatriatedNet, null)
})

test('提现缺净额且手续费可能已含时保留待核，暂停展示期间净流和占比', () => {
  const [summary] = parse('download.csv', [
    walletHeader,
    '2026-11-01,PY-1,Incoming,Platform payout,Amazon,CNY,200,0,200,Completed',
    '2026-11-02,PY-2,Withdrawal,Bank payout,Business Ltd,CNY,-100,5,,Completed',
  ])
  assert.equal(summary.walletMetrics.netPendingCount, 1)
  assert.equal(serializeSummary(summary).walletMetrics.signedNetFlow, null)
  const fundChain = buildConsolidatedReconcile([summary]).fundChain
  assert.equal(fundChain.signedNetFlowCny, null)
  assert.equal(fundChain.corporateRepatriationRatePct, null)
})

test('原流水关联退汇冲减转出，普通企业订阅不计提现，返回说明不含私密字段', () => {
  const [summary] = parse('download.csv', [
    walletHeader + ',Original Transaction ID,Wallet Account ID,Opening Balance,Closing Balance',
    '2026-11-01,PY-SENSITIVE-01,Incoming,PRIVATE-MEMO,Amazon,CNY,100,0,100,Completed,,ACCOUNT-123,50,',
    '2026-11-02,PY-SENSITIVE-02,Withdrawal,PRIVATE-MEMO,Example Holdings Ltd,CNY,-100,0,-100,Returned,,ACCOUNT-123,,',
    '2026-11-03,PY-SENSITIVE-03,Returned payout,PRIVATE-MEMO,Example Holdings Ltd,CNY,100,0,100,Completed,PY-SENSITIVE-02,ACCOUNT-123,,',
    '2026-11-04,PY-SENSITIVE-04,Subscription,PRIVATE-MEMO,Example Holdings Ltd,CNY,-10,0,-10,Completed,,ACCOUNT-123,,140',
  ])
  assert.equal(summary.walletMetrics.grossCorporateWithdraw, parseAmount('100'))
  assert.equal(summary.walletMetrics.fxWithdrawToCorporate, 0n)
  assert.equal(summary.walletMetrics.matchedCorporateReturn, parseAmount('100'))
  assert.equal(summary.walletMetrics.pendingReturnCount, 0)
  assert.equal(summary.walletMetrics.directSpend, parseAmount('10'))
  assert.equal(summary.walletMetrics.signedNetFlow, parseAmount('90'))
  assert.equal(summary.walletMetrics.openingBalance, parseAmount('50'))
  assert.equal(summary.walletMetrics.closingBalance, parseAmount('140'))
  assert.doesNotMatch(JSON.stringify(summary.anomalies), /PRIVATE-MEMO|PY-SENSITIVE|Example Holdings|ACCOUNT-123/)

  const [returned] = parse('download.csv', [
    walletHeader,
    '2026-11-02,PY-01,Withdrawal,Bank payout,Example Ltd,CNY,-100,0,-100,Returned',
  ])
  assert.equal(returned.walletMetrics.pendingReturnCount, 1)
  assert.equal(returned.walletMetrics.matchedCorporateReturn, 0n)
})

test('保留放款正负和精确位移，金额缺失与坏值分别标记', () => {
  const [stripe] = parse('download.csv', [
    stripeHeader,
    '2026-10-03,po_1,payout,Bank,RMB,-100,0,-100',
    '2026-11-02,po_2,payout_failure,Refunded,RMB,20,0,20',
    '2026-11-03,po_3,payout,Bank,CNY,0,0,0',
  ])
  assert.equal(stripe.payoutEvidenceCount, 3)
  assert.equal(stripe.actualPayout, parseAmount('80'))
  assert.equal(stripe.period, '跨期（待核）')
  assert.deepEqual(stripe.payoutEvidence.map((event) => event.period), ['2026-10', '2026-11', '2026-11'])
  assert.deepEqual(stripe.payoutEvidence.map((event) => event.amount), [parseAmount('100'), parseAmount('-20'), 0n])
  assert.equal(parseAmountCell(' ').state, 'missing')
  assert.equal(parseAmountCell('12 USD 34').state, 'invalid')
  assert.equal(fmtAmount(parseAmount('-.25')), '-0.25')
  assert.equal(fmtAmount(parseAmount('(-4.00)')), '-4.00')
  assert.equal(parseAmount('9007199254740993e0'), 9007199254740993n * AMOUNT_SCALE)
  assert.equal(parseAmount('0.00400001'), 400001n)
})


import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKUP_SCHEMA,
  HISTORY_SCHEMA,
  HistoryInputError,
  buildAnnualSummary,
  clearHistory,
  computeBackupChecksum,
  computeRolling12m,
  createHistoryStore,
  deleteSnapshot,
  exportArchiveBackup,
  importArchiveBackup,
  loadHistory,
  reassignArchiveEntity,
  saveSnapshot,
} from '../lib/history.js'
import { renderAnnualSummaryHtml, renderAnnualSummaryMarkdown } from '../lib/annual_report.js'
import { createParseCache, estimateValueBytes } from '../lib/parse_cache.js'

function useIsolatedDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-v09-hist-'))
  const prev = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir
  t.after(() => {
    if (prev === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('v0.9 归档引擎 v3→v4 无损向后兼容与新增 6 通道白名单支持', (t) => {
  const dir = useIsolatedDir(t)
  const histPath = join(dir, 'fintax_history.json')
  const v3Payload = {
    schema: 'dsh-fintax-history-v3',
    entries: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        revision: '22222222-2222-4222-8222-222222222222',
        month: '2026-06',
        savedAt: '2026-07-02T08:00:00.000Z',
        label: 'v3六月旧档',
        platforms: ['Amazon', 'WorldFirst'],
        entityName: '深圳星海贸易有限公司',
        ownershipStatus: 'claimed',
        storeScope: 'Amazon-US主店',
        vatTaxpayerType: 'small_scale',
        citAssessedMode: 'assessed_4pct',
        zeroSalesConfirmed: false,
        importMode: 'new',
        sheetCount: 2,
        rowCount: 320,
        grossCny: 620000,
        refundCny: 20000,
        netSalesCny: 600000,
        feesCny: 110000,
        payoutCny: 490000,
        declaredVatSalesCny: 595000,
        p0Count: 0,
        p1Count: 1,
        p2Count: 2,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        month: '2026-05',
        savedAt: '2026-06-03T08:00:00.000Z',
        label: 'v3未认领旧档',
        platforms: ['Payoneer'],
        entityName: '待认领',
        storeScope: '默认店铺',
        grossCny: 150000,
        refundCny: 0,
        netSalesCny: 150000,
        feesCny: 10000,
        payoutCny: 140000,
        p0Count: 1,
      },
    ],
  }
  writeFileSync(histPath, JSON.stringify(v3Payload, null, 2), 'utf8')

  const loaded = loadHistory()
  assert.equal(loaded.length, 2)
  const jun = loaded.find((x) => x.month === '2026-06')
  const may = loaded.find((x) => x.month === '2026-05')
  assert.equal(jun.entityName, '深圳星海贸易有限公司')
  assert.equal(jun.entityLabel, '深圳星海贸易有限公司')
  assert.equal(jun.entityKey, '深圳星海贸易有限公司')
  assert.equal(jun.shopLabel, 'Amazon-US主店')
  assert.equal(jun.period, '2026-06')
  assert.equal(jun.declaredVatSalesCny, 595000)
  assert.equal(jun.stage2WalletInboundCny, null)
  assert.equal(jun.stage3BankReceivedCny, null)
  assert.equal(jun.stage3Verified, false)
  assert.equal(may.ownershipStatus, 'unclaimed')
  assert.equal(may.entityKey, 'unclaimed')

  // 写入新快照后自动升级落盘至 v4，保留旧档字段且支持新 6 通道白名单同时剔除脏通道
  const saved = saveSnapshot({
    month: '2026-07',
    entityName: '深圳星海贸易有限公司',
    storeScope: '多平台七月店',
    platforms: ['SHEIN', 'Walmart', 'Lazada', 'LianLian', 'PingPong', 'Sunrate', 'bad@pii.local'],
    grossCny: 800000,
    refundCny: 40000,
    netSalesCny: 760000,
    feesCny: 120000,
    payoutCny: 640000,
    stage2WalletInboundCny: 635000,
    stage3BankReceivedCny: 634000,
    sites: ['US', 'DE'],
    currencies: ['USD', 'EUR'],
  })
  assert.equal(saved.conflict, false)
  assert.deepEqual(saved.entry.platforms, ['SHEIN', 'Walmart', 'Lazada', 'LianLian', 'PingPong', 'Sunrate'])
  assert.equal(saved.entry.stage2WalletInboundCny, 635000)
  assert.equal(saved.entry.stage3BankReceivedCny, 634000)
  assert.equal(saved.entry.stage3Verified, true)

  const diskObj = JSON.parse(readFileSync(histPath, 'utf8'))
  assert.equal(diskObj.schema, HISTORY_SCHEMA)
  assert.equal(diskObj.entries.length, 3)
  assert.equal(diskObj.entries.find((e) => e.id === jun.id).declaredVatSalesCny, 595000)

  const rolling = computeRolling12m(saved.history, { entityName: '深圳星海贸易有限公司' })
  assert.equal(rolling.totalNetSalesCny, 1360000)
  assert.equal(rolling.thresholdApplicable, true)
})

test('v0.9 自然年 Q1–Q4 汇总：季度/全年口径、缺失月份、零收入分离、Stage2/3 核销缺口与分平台拆解', (t) => {
  const dir = useIsolatedDir(t)
  const store = createHistoryStore({ dir })
  const rows = [
    { month: '2026-01', platforms: ['Amazon'], grossCny: 300000, refundCny: 10000, netSalesCny: 290000, feesCny: 50000, payoutCny: 240000, stage2WalletInboundCny: 239000, stage3BankReceivedCny: 238500, declaredVatSalesCny: 290000, p0Count: 0, p1Count: 1 },
    { month: '2026-02', platforms: ['Amazon'], grossCny: 200000, refundCny: 5000, netSalesCny: 195000, feesCny: 35000, payoutCny: 160000, stage2WalletInboundCny: 160000, stage3BankReceivedCny: 159500, declaredVatSalesCny: 195000, p0Count: 0, p1Count: 0 },
    // 2026-03 刻意缺档
    { month: '2026-04', platforms: ['TikTok Shop'], grossCny: 400000, refundCny: 20000, netSalesCny: 380000, feesCny: 60000, payoutCny: 320000, stage2WalletInboundCny: 318000, stage3BankReceivedCny: 317000, declaredVatSalesCny: 375000, p0Count: 1, p1Count: 1 },
    { month: '2026-05', platforms: ['TikTok Shop'], grossCny: 350000, refundCny: 10000, netSalesCny: 340000, feesCny: 55000, payoutCny: 285000, stage2WalletInboundCny: 285000, stage3BankReceivedCny: null, p0Count: 0, p1Count: 2 },
    { month: '2026-06', platforms: ['SHEIN'], grossCny: 250000, refundCny: 5000, netSalesCny: 245000, feesCny: 30000, payoutCny: 215000, stage2WalletInboundCny: 215000, stage3BankReceivedCny: 214500, p0Count: 0, p1Count: 0 },
    { month: '2026-07', platforms: ['Walmart'], grossCny: 500000, refundCny: 25000, netSalesCny: 475000, feesCny: 75000, payoutCny: 400000, stage2WalletInboundCny: 398000, stage3BankReceivedCny: 397000, p0Count: 0, p1Count: 1 },
    { month: '2026-08', platforms: ['Walmart'], grossCny: 0, refundCny: 0, netSalesCny: 0, feesCny: 0, payoutCny: 0, zeroSalesConfirmed: true, p0Count: 0, p1Count: 0 },
    // 2026-09 刻意缺档
    { month: '2026-10', platforms: ['Amazon'], grossCny: 600000, refundCny: 30000, netSalesCny: 570000, feesCny: 90000, payoutCny: 480000, stage2WalletInboundCny: 479000, stage3BankReceivedCny: null, p0Count: 0, p1Count: 1 },
    { month: '2026-11', platforms: ['Amazon'], grossCny: 900000, refundCny: 45000, netSalesCny: 855000, feesCny: 135000, payoutCny: 720000, stage2WalletInboundCny: 718000, stage3BankReceivedCny: null, p0Count: 0, p1Count: 2, p2Count: 3 },
    { month: '2026-12', platforms: ['Amazon'], grossCny: 700000, refundCny: 35000, netSalesCny: 665000, feesCny: 105000, payoutCny: 560000, stage2WalletInboundCny: 558000, stage3BankReceivedCny: null, p0Count: 0, p1Count: 0 },
  ]
  for (const r of rows) {
    saveSnapshot({ ...r, entityKey: 'sz_xinghai', entityLabel: '深圳星海贸易有限公司', shopKey: 'main_shop', shopLabel: '北美主店' })
  }

  const summary = buildAnnualSummary(store, { year: 2026, entityKey: 'sz_xinghai' })
  assert.equal(summary.year, 2026)
  assert.equal(summary.deadlineDate, '2027-01-31')
  assert.equal(summary.crossEntityMixed, false)
  assert.equal(summary.declarable, true)
  assert.equal(summary.thresholdApplicable, true)
  assert.deepEqual(summary.missingMonths, ['2026-03', '2026-09'])
  assert.deepEqual(summary.zeroSalesMonths, ['2026-08'])
  assert.equal(summary.coveredMonths.length, 10)
  assert.equal(summary.monthlySeries.length, 12)
  assert.equal(summary.monthlySeries[2].status, 'missing')
  assert.equal(summary.monthlySeries[7].status, 'zero_confirmed')

  // Q1–Q4 精确校验
  const [q1, q2, q3, q4] = summary.quarters
  assert.equal(q1.netSalesCny, 485000)
  assert.deepEqual(q1.missingMonths, ['2026-03'])
  assert.equal(q1.stage2WalletInboundCny, 399000)
  assert.equal(q1.stage3BankReceivedCny, 398000)
  assert.equal(q1.stage1to2GapCny, -1000)
  assert.equal(q1.stage2to3GapCny, -1000)

  assert.equal(q2.netSalesCny, 965000)
  assert.equal(q2.p0Count, 1)
  assert.equal(q3.netSalesCny, 475000)
  assert.deepEqual(q3.zeroSalesMonths, ['2026-08'])
  assert.equal(q4.netSalesCny, 2090000)
  assert.equal(q4.stage3BankReceivedCny, null)

  // 全年合计精确对齐
  assert.equal(summary.annual.grossCny, 4200000)
  assert.equal(summary.annual.refundCny, 185000)
  assert.equal(summary.annual.netSalesCny, 4015000)
  assert.equal(summary.annual.feesCny, 635000)
  assert.equal(summary.annual.payoutCny, 3380000)
  assert.equal(summary.annual.stage2WalletInboundCny, 3370000)
  assert.equal(summary.annual.stage3BankReceivedCny, 1326500)
  assert.equal(summary.annual.stage1to2GapCny, -10000)
  assert.equal(summary.annual.p0Count, 1)
  assert.equal(summary.annual.p1Count, 8)
  assert.equal(summary.annual.p2Count, 3)

  // 平台拆解金额总和与全年净额精确轧平
  const platNetSum = summary.byPlatform.reduce((acc, p) => acc + p.netSalesCny, 0)
  assert.equal(platNetSum, summary.annual.netSalesCny)
  assert.equal(summary.byPlatform[0].platform, 'Amazon')

  // 支持按 shopKey 过滤及直接传 options 对象读默认库
  const byShop = buildAnnualSummary({ year: 2026, entityKey: 'sz_xinghai', shopKey: 'main_shop' })
  assert.equal(byShop.annual.netSalesCny, 4015000)
  const emptyShop = buildAnnualSummary(store, { year: 2026, shopKey: 'other_shop' })
  assert.equal(emptyShop.snapshotCount, 0)
})

test('v0.9 跨主体混算保护：未指定主体时强制拆表并阻断合并申报与门槛误判', () => {
  const list = [
    { id: 'aaaa0001-1111-4111-8111-111111111111', month: '2026-01', entityKey: 'co_a', entityLabel: '深圳甲科技有限公司', shopKey: 's1', shopLabel: '店1', platforms: ['Amazon'], grossCny: 3200000, netSalesCny: 3100000, feesCny: 400000, payoutCny: 2700000 },
    { id: 'aaaa0002-1111-4111-8111-111111111111', month: '2026-02', entityKey: 'co_b', entityLabel: '广州乙贸易有限公司', shopKey: 's2', shopLabel: '店2', platforms: ['Temu'], grossCny: 2800000, netSalesCny: 2700000, feesCny: 300000, payoutCny: 2400000 },
    { id: 'aaaa0003-1111-4111-8111-111111111111', month: '2026-03', entityName: '待认领', storeScope: '老店', platforms: ['Shopee'], grossCny: 400000, netSalesCny: 380000, feesCny: 40000, payoutCny: 340000 },
  ]

  const mixed = buildAnnualSummary(list, { year: 2026 })
  assert.equal(mixed.crossEntityMixed, true)
  assert.equal(mixed.cannotMergeForTaxFiling, true)
  assert.equal(mixed.declarable, false)
  assert.equal(mixed.thresholdApplicable, false)
  assert.equal(mixed.annual.referenceOnly, true)
  assert.equal(mixed.annual.threshold5mPct, null)
  assert.equal(mixed.annual.cliff75mPct, null)
  assert.match(mixed.mixingProtectionWarning, /不可直接合并申报/)
  assert.equal(mixed.hasUnclaimed, true)
  assert.equal(mixed.byEntity.length, 3)

  // 分主体各自独立核算且单主体门槛安全（各主体均未超 500 万，尽管合并为 618 万！）
  const entA = mixed.byEntity.find((e) => e.entityKey === 'co_a')
  const entB = mixed.byEntity.find((e) => e.entityKey === 'co_b')
  const entUnclaimed = mixed.byEntity.find((e) => e.entityKey === 'unclaimed')
  assert.equal(entA.annual.netSalesCny, 3100000)
  assert.equal(entA.annual.threshold5mLevel, 'safe')
  assert.equal(entB.annual.netSalesCny, 2700000)
  assert.equal(entUnclaimed.declarable, false)
  assert.equal(entUnclaimed.annual.threshold5mLevel, null)

  // 指定单一主体过滤后解除混算阻断
  const scopedA = buildAnnualSummary(list, { year: 2026, entityKey: 'co_a' })
  assert.equal(scopedA.crossEntityMixed, false)
  assert.equal(scopedA.declarable, true)
  assert.equal(scopedA.annual.netSalesCny, 3100000)
  assert.equal(scopedA.annual.threshold5mLevel, 'safe')
})

test('v0.9 2027-01-31 三地平台数据交卷自检：中国 810 号令 / 欧盟 DAC7 / 美国 IRS 1099-K 双门槛与州级提示', () => {
  // 场景 1：纯英国 GBP（非欧盟 DAC7）+ 美国双门槛均超（>$20,000 且 >200 笔）
  const usDualAndUk = buildAnnualSummary([
    {
      id: 'bbbb0001-1111-4111-8111-111111111111', month: '2026-10',
      entityKey: 'ent1', entityLabel: '主体一', shopKey: 'us1', shopLabel: 'Amazon US',
      platforms: ['Amazon'], sites: ['US'], currencies: ['USD'],
      grossCny: 216000, netSalesCny: 200000, feesCny: 30000, payoutCny: 170000,
      declaredVatSalesCny: 120000, // 明显四层口径差额
      usSalesUsd: 30000, usTransactionCount: 260, p0Count: 0,
    },
    {
      id: 'bbbb0002-1111-4111-8111-111111111111', month: '2026-11',
      entityKey: 'ent1', entityLabel: '主体一', shopKey: 'uk1', shopLabel: 'Amazon UK',
      platforms: ['Amazon'], sites: ['UK'], currencies: ['GBP'],
      grossCny: 90000, netSalesCny: 85000, feesCny: 15000, payoutCny: 70000,
    },
  ], { year: 2026, entityKey: 'ent1' })

  const tj1 = usDualAndUk.threeJurisdictions
  assert.equal(tj1.deadline, '2027-01-31')
  assert.equal(tj1.china810.status, 'danger') // Q4 缺 12 月 + 显著申报差额
  assert.ok(tj1.china810.alerts.some((a) => a.includes('2026-12')))
  assert.ok(tj1.china810.alerts.some((a) => a.includes('差额')))
  // UK 脱欧不误触发欧盟 DAC7
  assert.equal(tj1.euDac7.triggered, false)
  assert.equal(tj1.euDac7.status, 'not_applicable')
  // 美国 OBBBA 双门槛全部满足 -> danger
  assert.equal(tj1.us1099k.triggered, true)
  assert.equal(tj1.us1099k.status, 'danger')
  assert.equal(tj1.us1099k.metrics.federalUsdThreshold, 20000)
  assert.equal(tj1.us1099k.metrics.federalTxnThreshold, 200)
  assert.equal(tj1.us1099k.metrics.meetsFederalDualThreshold, true)
  assert.ok(tj1.us1099k.alerts.some((a) => a.includes('$20,000') && a.includes('200')))

  // 场景 2：完整 12 个月下，美国超 $20,000 但仅 50 笔（未同时满足 OBBBA 双门槛，须保留州级低门槛预警）+ 欧盟 DE/EUR 触发 DAC7
  const zeroMonthsEnt2 = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '12'].map((mm, idx) => ({
    id: `bbbb10${String(idx + 1).padStart(2, '0')}-1111-4111-8111-111111111111`,
    month: `2026-${mm}`,
    entityKey: 'ent2', entityLabel: '主体二', shopKey: 'us2', shopLabel: 'B2B US',
    platforms: ['Stripe'], grossCny: 0, netSalesCny: 0, feesCny: 0, payoutCny: 0, zeroSalesConfirmed: true,
  }))
  const usSingleAndEu = buildAnnualSummary([
    ...zeroMonthsEnt2,
    {
      id: 'bbbb0003-1111-4111-8111-111111111111', month: '2026-10',
      entityKey: 'ent2', entityLabel: '主体二', shopKey: 'us2', shopLabel: 'B2B US',
      platforms: ['Stripe'], sites: ['US'], currencies: ['USD'],
      grossCny: 250000, netSalesCny: 250000, feesCny: 8000, payoutCny: 242000,
      usSalesUsd: 35000, usTransactionCount: 50,
    },
    {
      id: 'bbbb0004-1111-4111-8111-111111111111', month: '2026-11',
      entityKey: 'ent2', entityLabel: '主体二', shopKey: 'eu1', shopLabel: 'Amazon DE',
      platforms: ['Amazon'], sites: ['DE', 'FR'], currencies: ['EUR'],
      grossCny: 40000, netSalesCny: 38000, feesCny: 6000, payoutCny: 32000,
      euSalesEur: 5200, euOrderCount: 65,
    },
  ], { year: 2026, entityKey: 'ent2' })

  const tj2 = usSingleAndEu.threeJurisdictions
  assert.equal(tj2.us1099k.metrics.meetsUsdThreshold, true)
  assert.equal(tj2.us1099k.metrics.meetsTxnThreshold, false)
  assert.equal(tj2.us1099k.metrics.meetsFederalDualThreshold, false)
  assert.equal(tj2.us1099k.metrics.stateThresholdWarning, true)
  assert.equal(tj2.us1099k.status, 'warn')
  assert.ok(tj2.us1099k.alerts.some((a) => a.includes('州') && a.includes('$600')))

  assert.equal(tj2.euDac7.triggered, true)
  assert.equal(tj2.euDac7.status, 'danger')
  assert.equal(tj2.euDac7.metrics.exceedsThreshold, true)
  assert.deepEqual(tj2.euDac7.metrics.euSites, ['DE', 'FR'])

  // 场景 3：仅 1 个月归档时缺月必须返 pending_data（绝不误判 ok）；补齐 12 个月（含零收入确认月）后方返 ok
  const belowPartial = buildAnnualSummary([
    {
      id: 'bbbb0005-1111-4111-8111-111111111111', month: '2026-12',
      entityKey: 'ent3', entityLabel: '小微主体', shopKey: 'mix', shopLabel: '测试店',
      platforms: ['Shopify'], sites: ['DE', 'US'], currencies: ['EUR', 'USD'],
      grossCny: 10000, netSalesCny: 10000, feesCny: 500, payoutCny: 9500,
      euSalesEur: 900, euOrderCount: 12, usSalesUsd: 350, usTransactionCount: 5,
    },
  ], { year: 2026, entityKey: 'ent3' })
  assert.equal(belowPartial.threeJurisdictions.euDac7.status, 'pending_data')
  assert.equal(belowPartial.threeJurisdictions.euDac7.metrics.exceedsThreshold, null)
  assert.equal(belowPartial.threeJurisdictions.us1099k.status, 'pending_data')

  const zeroMonthsEnt3 = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'].map((mm, idx) => ({
    id: `bbbb20${String(idx + 1).padStart(2, '0')}-1111-4111-8111-111111111111`,
    month: `2026-${mm}`,
    entityKey: 'ent3', entityLabel: '小微主体', shopKey: 'mix', shopLabel: '测试店',
    platforms: ['Shopify'], grossCny: 0, netSalesCny: 0, feesCny: 0, payoutCny: 0, zeroSalesConfirmed: true,
  }))
  const belowBoth = buildAnnualSummary([
    ...zeroMonthsEnt3,
    {
      id: 'bbbb0005-1111-4111-8111-111111111111', month: '2026-12',
      entityKey: 'ent3', entityLabel: '小微主体', shopKey: 'mix', shopLabel: '测试店',
      platforms: ['Shopify'], sites: ['DE', 'US'], currencies: ['EUR', 'USD'],
      grossCny: 10000, netSalesCny: 10000, feesCny: 500, payoutCny: 9500,
      euSalesEur: 900, euOrderCount: 12, usSalesUsd: 350, usTransactionCount: 5,
    },
  ], { year: 2026, entityKey: 'ent3' })
  assert.equal(belowBoth.threeJurisdictions.euDac7.status, 'ok')
  assert.equal(belowBoth.threeJurisdictions.euDac7.metrics.exceedsThreshold, false)
  assert.equal(belowBoth.threeJurisdictions.us1099k.status, 'ok')
  assert.equal(belowBoth.threeJurisdictions.us1099k.metrics.stateThresholdWarning, false)
})

test('v0.9 一键认领/重分配待认领主体：防串账 409 冲突保护、force 安全覆盖与审计时间戳', (t) => {
  const dir = useIsolatedDir(t)
  const store = createHistoryStore({ dir })

  const unclaimed1 = saveSnapshot({
    month: '2026-10',
    entityName: '待认领',
    storeScope: '旧美站',
    platforms: ['Amazon'],
    grossCny: 500000,
    netSalesCny: 480000,
    feesCny: 70000,
    payoutCny: 410000,
  }).entry
  assert.equal(unclaimed1.ownershipStatus, 'unclaimed')

  // 1) 无冲突一键认领成功，记录审计时间戳与来源追踪
  const claimed = reassignArchiveEntity(store, unclaimed1.id, {
    entityKey: 'sz_xinghai',
    entityLabel: '深圳星海贸易有限公司',
    shopKey: 'amz_us',
    shopLabel: 'Amazon US 主店',
  })
  assert.equal(claimed.conflict, false)
  assert.equal(claimed.overwritten, false)
  assert.equal(claimed.entry.entityKey, 'sz_xinghai')
  assert.equal(claimed.entry.entityLabel, '深圳星海贸易有限公司')
  assert.equal(claimed.entry.entityName, '深圳星海贸易有限公司')
  assert.equal(claimed.entry.shopKey, 'amz_us')
  assert.equal(claimed.entry.shopLabel, 'Amazon US 主店')
  assert.equal(claimed.entry.ownershipStatus, 'claimed')
  assert.equal(claimed.entry.netSalesCny, 480000)
  assert.ok(claimed.entry.reassignedAt && Number.isFinite(Date.parse(claimed.entry.reassignedAt)))
  assert.equal(claimed.entry.reassignedFrom.entityKey, 'unclaimed')

  // 2) 再建一条同月(2026-10)另一待认领记录，尝试重分配到相同主体+店铺 -> 返回 conflict: true (409)，不改盘！
  const unclaimed2 = saveSnapshot({
    month: '2026-10',
    entityName: '待认领',
    storeScope: '另一旧档',
    platforms: ['Amazon'],
    grossCny: 520000,
    netSalesCny: 500000,
    feesCny: 72000,
    payoutCny: 428000,
  }).entry

  const collided = reassignArchiveEntity(store, unclaimed2.id, {
    entityKey: 'sz_xinghai',
    entityLabel: '深圳星海贸易有限公司',
    shopKey: 'amz_us',
    shopLabel: 'Amazon US 主店',
  })
  assert.equal(collided.conflict, true)
  assert.equal(collided.statusCode, 409)
  assert.equal(collided.reason, 'source_key_collision')
  assert.equal(collided.existing.id, unclaimed1.id)
  assert.equal(store.load().length, 2)

  // 3) 传 force: true 安全覆盖旧冲突档并记录 overwrittenIds 与审计时间戳
  const forced = reassignArchiveEntity(store, unclaimed2.id, {
    entityKey: 'sz_xinghai',
    entityLabel: '深圳星海贸易有限公司',
    shopKey: 'amz_us',
    shopLabel: 'Amazon US 主店',
    force: true,
  })
  assert.equal(forced.conflict, false)
  assert.equal(forced.overwritten, true)
  assert.equal(forced.overwrittenCount, 1)
  assert.deepEqual(forced.overwrittenIds, [unclaimed1.id])
  assert.equal(forced.entry.netSalesCny, 500000)
  assert.ok(forced.entry.reassignedAt)
  assert.deepEqual(forced.entry.reassignedFrom.overwrittenIds, [unclaimed1.id])
  assert.equal(store.load().length, 1)

  // 4) expectedRevision 冲突与非法入参拦截
  const revMismatch = reassignArchiveEntity(store, unclaimed2.id, {
    entityLabel: '改名测试',
    expectedRevision: '11111111-1111-4111-8111-111111111111',
  })
  assert.equal(revMismatch.conflict, true)
  assert.equal(revMismatch.reason, 'revision_mismatch')

  assert.throws(() => reassignArchiveEntity(store, 'not-a-uuid', { entityLabel: 'A' }), { code: 'INVALID_SNAPSHOT_ID' })
  assert.throws(() => reassignArchiveEntity(store, '99999999-9999-4999-8999-999999999999', { entityLabel: 'A' }), { code: 'SNAPSHOT_NOT_FOUND' })
  assert.throws(() => reassignArchiveEntity(store, unclaimed2.id, { entityLabel: '   ' }), { code: 'INVALID_ENTITY' })
  assert.throws(() => reassignArchiveEntity(store, unclaimed2.id, JSON.parse('{"entityLabel":"A","__proto__":{"x":1}}')), { code: 'INVALID_REASSIGN_PATCH' })
})

test('v0.9 归档 JSON 安全备份导出与导入：SHA-256 校验、防原型污染、非法字段与 merge_skip / merge_overwrite', (t) => {
  const dir1 = useIsolatedDir(t)
  const store1 = createHistoryStore({ dir: dir1 })
  const dir2 = mkdtempSync(join(tmpdir(), 'fintax-v09-bk2-'))
  t.after(() => rmSync(dir2, { recursive: true, force: true }))
  const store2 = createHistoryStore({ dir: dir2 })

  const s1 = saveSnapshot({
    month: '2026-09', entityKey: 'ent_a', entityLabel: '主体A', shopKey: 'us', shopLabel: 'US店',
    platforms: ['Amazon'], grossCny: 300000, netSalesCny: 290000, feesCny: 40000, payoutCny: 250000,
    stage2WalletInboundCny: 249000, stage3BankReceivedCny: 248500, sites: ['US'], currencies: ['USD'],
  }).entry
  saveSnapshot({
    month: '2026-10', entityKey: 'ent_a', entityLabel: '主体A', shopKey: 'eu', shopLabel: 'EU店',
    platforms: ['SHEIN'], grossCny: 200000, netSalesCny: 195000, feesCny: 25000, payoutCny: 170000,
    sites: ['DE'], currencies: ['EUR'], euSalesEur: 25000, euOrderCount: 400,
  })

  // 1) 导出结构与 SHA-256 校验摘要
  const backup = exportArchiveBackup(store1)
  assert.equal(backup.schemaVersion, BACKUP_SCHEMA)
  assert.equal(backup.recordCount, 2)
  assert.equal(backup.records.length, 2)
  assert.match(backup.checksum, /^[0-9a-f]{64}$/)
  assert.equal(backup.checksum, computeBackupChecksum(backup.records))

  // 2) 导入全新空库
  const imp1 = importArchiveBackup(store2, JSON.stringify(backup))
  assert.equal(imp1.imported, 2)
  assert.equal(imp1.skipped, 0)
  assert.equal(imp1.overwritten, 0)
  assert.deepEqual(imp1.conflicts, [])
  assert.equal(store2.load().length, 2)

  // 3) 篡改任意字段触发 SHA-256 阻断；recordCount 截断阻断；可选关闭严格校验
  const tampered = JSON.parse(JSON.stringify(backup))
  tampered.records[0].grossCny += 0.01
  assert.throws(() => importArchiveBackup(store2, tampered), { code: 'BACKUP_CHECKSUM_MISMATCH' })

  const truncated = JSON.parse(JSON.stringify(backup))
  truncated.records.pop()
  assert.throws(() => importArchiveBackup(store2, truncated), { code: 'BACKUP_RECORD_COUNT_MISMATCH' })

  // 4) 严格安全校验：非对象、原型污染键（__proto__/constructor/prototype）、超限条数、非法字段、非法版本
  for (const bad of [null, undefined, 123, 'not-json', [], true]) {
    assert.throws(() => importArchiveBackup(store2, bad), { code: 'INVALID_BACKUP_PAYLOAD' })
  }
  const protoJson = `{"schemaVersion":"dsh-fintax-backup-v1","recordCount":0,"records":[],"__proto__":{"polluted":true},"checksum":"${computeBackupChecksum([])}"}`
  assert.throws(() => importArchiveBackup(store2, protoJson), { code: 'BACKUP_UNSAFE_KEYS' })
  assert.equal(({}).polluted, undefined)

  const ctorJson = `{"schemaVersion":"dsh-fintax-backup-v1","recordCount":1,"records":[{"month":"2026-10","grossCny":100,"constructor":{"prototype":{"pwn":1}}}],"checksum":"${computeBackupChecksum([])}"}`
  assert.throws(() => importArchiveBackup(store2, ctorJson, { verifyChecksum: false }), { code: 'BACKUP_UNSAFE_KEYS' })

  const protoObj = Object.create({ inheritedEvil: 1 })
  protoObj.schemaVersion = BACKUP_SCHEMA
  protoObj.records = []
  assert.throws(() => importArchiveBackup(store2, protoObj, { verifyChecksum: false }), { code: 'BACKUP_UNSAFE_KEYS' })

  assert.throws(() => importArchiveBackup(store2, backup, { maxRecords: 1 }), { code: 'BACKUP_TOO_MANY_RECORDS' })
  assert.throws(() => importArchiveBackup(store2, { schemaVersion: 'wrong-v99', records: [] }, { verifyChecksum: false }), { code: 'INVALID_BACKUP_SCHEMA' })

  const badFieldRec = [{ month: '2026-11', grossCny: 100, rawOrders: ['secret_buyer'] }]
  assert.throws(
    () => importArchiveBackup(store2, { schemaVersion: BACKUP_SCHEMA, recordCount: 1, records: badFieldRec, checksum: computeBackupChecksum(badFieldRec) }),
    { code: 'INVALID_BACKUP_RECORD' },
  )

  // 5) merge_skip（默认）vs merge_overwrite 冲突统计
  const updatedBatch = [
    { ...s1, grossCny: 333333, netSalesCny: 320000 }, // 与 store2 中 s1 碰撞
    {
      id: 'cccc0001-1111-4111-8111-111111111111', month: '2026-11', entityKey: 'ent_a', entityLabel: '主体A',
      shopKey: 'us', shopLabel: 'US店', platforms: ['Amazon'], grossCny: 400000, netSalesCny: 390000, feesCny: 50000, payoutCny: 340000,
    },
  ]
  const batchPayload = {
    schemaVersion: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    recordCount: updatedBatch.length,
    records: updatedBatch,
    checksum: computeBackupChecksum(updatedBatch),
  }

  const skipRes = importArchiveBackup(store2, batchPayload, { mode: 'merge_skip' })
  assert.equal(skipRes.imported, 1)
  assert.equal(skipRes.skipped, 1)
  assert.equal(skipRes.overwritten, 0)
  assert.equal(skipRes.conflicts.length, 1)
  assert.equal(skipRes.conflicts[0].action, 'skipped')
  assert.equal(store2.load().find((x) => x.id === s1.id).grossCny, 300000) // 原值未被覆盖

  const overwriteRes = importArchiveBackup(store2, batchPayload, { mode: 'merge_overwrite' })
  assert.equal(overwriteRes.imported, 0)
  assert.equal(overwriteRes.skipped, 0)
  assert.equal(overwriteRes.overwritten, 2)
  assert.equal(store2.load().find((x) => x.id === s1.id).grossCny, 333333) // 已安全覆盖更新
})

test('v0.9 年度老板报表渲染（HTML/MD）：Braun 样式、A4 打印、三地清单、防 XSS 逃逸、默认纯洁模式与护城河门禁', () => {
  const xssEntity = '星海<script>alert("xss")</script>&"测试"公司'
  const summary = buildAnnualSummary([
    {
      id: 'dddd0001-1111-4111-8111-111111111111', month: '2026-01',
      entityKey: 'ent_xss', entityLabel: xssEntity, shopKey: 's1', shopLabel: '店<img src=x onerror=alert(1)>',
      platforms: ['Amazon'], sites: ['US', 'DE'], currencies: ['USD', 'EUR'],
      grossCny: 500000, refundCny: 10000, netSalesCny: 490000, feesCny: 80000, payoutCny: 410000,
      stage2WalletInboundCny: 409000, stage3BankReceivedCny: 408500,
      euSalesEur: 12000, euOrderCount: 150, usSalesUsd: 32000, usTransactionCount: 280, p0Count: 1,
    },
    {
      id: 'dddd0002-1111-4111-8111-111111111111', month: '2026-10',
      entityKey: 'ent_other', entityLabel: '第二主体有限公司', shopKey: 's2', shopLabel: 'TikTok店',
      platforms: ['TikTok Shop'], grossCny: 300000, netSalesCny: 290000, feesCny: 45000, payoutCny: 245000,
    },
  ], { year: 2026 })

  const html = renderAnnualSummaryHtml(summary, { title: '2026 老板报表<script>evil()</script>', version: '0.9.0' })
  const md = renderAnnualSummaryMarkdown(summary, { title: '2026 老板报表<script>evil()</script>', version: '0.9.0' })

  // 关键业务板块齐备
  assert.ok(html.includes('<svg'))
  assert.ok(html.includes('@page{size:A4'))
  assert.ok(html.includes('Q1–Q4'))
  assert.ok(html.includes('分主体独立拆表'))
  assert.ok(html.includes('2027-01-31'))
  assert.ok(html.includes('810 号令'))
  assert.ok(html.includes('DAC7'))
  assert.ok(html.includes('1099-K'))
  assert.ok(html.includes('$20,000'))
  assert.ok(md.includes('Q1 (01–03月)'))
  assert.ok(md.includes('分主体独立拆表'))
  assert.ok(md.includes('2027-01-31'))

  // 严格防 XSS 逃逸
  assert.equal(html.includes('<script>alert("xss")</script>'), false)
  assert.equal(html.includes('<script>evil()</script>'), false)
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'))
  assert.equal(md.includes('<script>'), false)

  // 默认纯洁老板模式 & 护城河禁词 0 泄露
  for (const doc of [html, md]) {
    for (const forbidden of ['197 篇', '一表通母表', '借方科目', '贷方科目', 'VLOOKUP(', 'SUMIFS(', '借：应收账款', '--profile default', 'CTPAT-certified']) {
      assert.equal(doc.includes(forbidden), false, `年度报表不应包含：${forbidden}`)
    }
  }
  const htmlOptIn = renderAnnualSummaryHtml(summary, { includeResourceAppendix: true })
  assert.ok(htmlOptIn.includes('扩展参考附页'))
})

test('v0.9 纯内存解析结果缓存：不透明 Token、上下文隔离、BigInt 安全、TTL 过期与 LRU/字节上限驱逐', () => {
  // 静态断言 lib/parse_cache.js 绝不引入 node:fs（严禁写盘）
  const cacheSrc = readFileSync(new URL('../lib/parse_cache.js', import.meta.url), 'utf8')
  assert.equal(cacheSrc.includes('node:fs'), false)

  let fakeNow = 1_700_000_000_000
  const cache = createParseCache({
    maxEntries: 3,
    ttlMs: 10_000,
    maxTotalBytes: 2048,
    now: () => fakeNow,
  })

  // 1) BigInt 安全估算与存储 + 不透明 32 位随机 hex token + 会话上下文隔离
  const parseResultA = { summaries: [{ platform: 'Amazon', grossSales: 123456789000000n }], text: 'A'.repeat(200) }
  assert.ok(estimateValueBytes(parseResultA) > 200)
  const pA = cache.put(parseResultA, { scopeKey: 'session-A', files: ['a.csv'] })
  assert.equal(pA.cached, true)
  assert.match(pA.cacheToken, /^[0-9a-f]{32}$/)

  const hitA = cache.get(pA.cacheToken, 'session-A')
  assert.ok(hitA)
  assert.equal(hitA.result.summaries[0].grossSales, 123456789000000n)
  assert.deepEqual(hitA.meta.files, ['a.csv'])

  // 跨会话隔离拦截：其他 session 或空 session 无法读取或删除
  assert.equal(cache.get(pA.cacheToken, 'session-B'), null)
  assert.equal(cache.get(pA.cacheToken), null)
  assert.equal(cache.delete(pA.cacheToken, 'session-B'), false)
  assert.equal(cache.stats().scopeMismatches, 3)

  // 2) LRU 容量驱逐（maxEntries = 3）：放入 A、B、C -> 访问 A -> 放入 D -> 应驱逐最久未用的 B！
  const pB = cache.put({ tag: 'B', payload: 'x'.repeat(100) }, { scopeKey: 's1' })
  const pC = cache.put({ tag: 'C', payload: 'x'.repeat(100) }, { scopeKey: 's1' })
  assert.ok(cache.get(pA.cacheToken, 'session-A')) // 刷新 A 为最近使用
  const pD = cache.put({ tag: 'D', payload: 'x'.repeat(100) }, { scopeKey: 's1' })

  assert.equal(cache.get(pB.cacheToken, 's1'), null) // B 被 LRU 驱逐
  assert.ok(cache.get(pA.cacheToken, 'session-A'))
  assert.ok(cache.get(pC.cacheToken, 's1'))
  assert.ok(cache.get(pD.cacheToken, 's1'))
  assert.equal(cache.stats().evictedLru, 1)

  // 3) 字节预算驱逐 & 单条超限保护（不驱逐已有健康缓存）
  const oversized = cache.put({ huge: 'Z'.repeat(3000) }, { scopeKey: 's1' })
  assert.equal(oversized.cached, false)
  assert.equal(oversized.cacheToken, null)
  assert.equal(oversized.reason, 'ENTRY_TOO_LARGE')
  assert.equal(cache.stats().entries, 3) // 现有 3 条完好无损

  const bigFit = cache.put({ big: 'Y'.repeat(1400) }, { scopeKey: 's1' })
  assert.equal(bigFit.cached, true)
  assert.ok(cache.stats().totalBytes <= 2048)
  assert.ok(cache.stats().evictedBytes >= 1)

  // 4) TTL 过期自动淘汰
  fakeNow += 10_001
  assert.equal(cache.get(bigFit.cacheToken, 's1'), null)
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().totalBytes, 0)
  assert.ok(cache.stats().evictedExpired >= 1)

  // 5) 手动 delete 与 clear
  const pE = cache.put({ ok: 1 }, { scopeKey: 's2' })
  assert.equal(cache.delete(pE.cacheToken, 's2'), true)
  assert.equal(cache.get(pE.cacheToken, 's2'), null)
  cache.put({ ok: 2 }, { scopeKey: 's2' })
  cache.clear()
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().totalBytes, 0)
})

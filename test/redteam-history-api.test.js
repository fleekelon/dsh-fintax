import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { deflateRawSync } from 'node:zlib'
import { createFintaxApiHandler } from '../index.js'
import {
  BACKUP_SCHEMA,
  buildAnnualSummary,
  computeBackupChecksum,
  computeRolling12m,
  createHistoryStore,
  deleteSnapshot,
  exportArchiveBackup,
  findSnapshotById,
  importArchiveBackup,
  loadHistory,
  reassignArchiveEntity,
  saveSnapshot,
} from '../lib/history.js'
import { renderAnnualSummaryHtml, renderAnnualSummaryMarkdown } from '../lib/annual_report.js'
import { createParseCache } from '../lib/parse_cache.js'
import { clearImaCache } from '../lib/ima.js'

function useIsolatedDir(t, prefix = 'fintax-rt-c-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const prev = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir
  t.after(() => {
    if (prev === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

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

function buildMinimalZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const compressed = deflateRawSync(dataBuf)
    let crc = 0xffffffff
    for (let i = 0; i < dataBuf.length; i++) {
      crc ^= dataBuf[i]
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(8, 8)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(compressed.length, 18)
    lfh.writeUInt32LE(dataBuf.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    localParts.push(lfh, nameBuf, compressed)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(8, 10)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(compressed.length, 20)
    cdh.writeUInt32LE(dataBuf.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt32LE(offset, 42)
    centralParts.push(cdh, nameBuf)
    offset += lfh.length + nameBuf.length + compressed.length
  }
  const cdBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, cdBuf, eocd])
}

function buildMinimalXlsm() {
  const workbook = '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Stripe" sheetId="1" r:id="rId1"/></sheets></workbook>'
  const sheet1 = [
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Created</t></is></c><c r="B1" t="inlineStr"><is><t>ID</t></is></c><c r="C1" t="inlineStr"><is><t>Type</t></is></c><c r="D1" t="inlineStr"><is><t>Description</t></is></c><c r="E1" t="inlineStr"><is><t>Currency</t></is></c><c r="F1" t="inlineStr"><is><t>Amount</t></is></c><c r="G1" t="inlineStr"><is><t>Fee</t></is></c><c r="H1" t="inlineStr"><is><t>Net</t></is></c></row>',
    '<row r="2"><c r="A2" t="inlineStr"><is><t>2026-11-05</t></is></c><c r="B2" t="inlineStr"><is><t>ch_xlsm_1</t></is></c><c r="C2" t="inlineStr"><is><t>charge</t></is></c><c r="D2" t="inlineStr"><is><t>Sale</t></is></c><c r="E2" t="inlineStr"><is><t>CNY</t></is></c><c r="F2"><v>500</v></c><c r="G2"><v>0</v></c><c r="H2"><v>500</v></c></row>',
    '</sheetData></worksheet>',
  ].join('')
  return buildMinimalZip([
    ['xl/workbook.xml', workbook],
    ['xl/worksheets/sheet1.xml', sheet1],
    ['xl/vbaProject.bin', Buffer.from('DUMMY_MACRO_BYTES')],
  ])
}

// ── 1. 红队反例：同名不同 entityKey 判混算 + 两法人各 $11,000/110 笔与 $15,000/150 笔严禁顶层触发联邦 1099-K ──
test('红队 Track C-1A：同名不同 entityKey 必须判跨主体混算；两独立法人各 $11k/110笔 或 $15k/150笔 不得合并触发联邦 1099-K 或 EU DAC7', () => {
  const twoSameNameEntities = [
    {
      id: 'aa000001-1111-4111-8111-111111111111', month: '2026-10',
      entityKey: 'ent_sz_corp', entityLabel: '星海跨境贸易', shopKey: 'us_1', shopLabel: '美站A',
      platforms: ['Amazon'], sites: ['US'], currencies: ['USD'],
      grossCny: 79200, netSalesCny: 75000, feesCny: 10000, payoutCny: 65000,
      usSalesUsd: 11000, usTransactionCount: 110,
    },
    {
      id: 'aa000002-1111-4111-8111-111111111111', month: '2026-10',
      entityKey: 'ent_hk_corp', entityLabel: '星海跨境贸易', shopKey: 'us_2', shopLabel: '美站B',
      platforms: ['Amazon'], sites: ['US'], currencies: ['USD'],
      grossCny: 79200, netSalesCny: 75000, feesCny: 10000, payoutCny: 65000,
      usSalesUsd: 11000, usTransactionCount: 110,
    },
  ]

  // 即使按共享显示名筛选，唯一 entityKey 数量为 2 -> 仍必须判跨主体混算且不可申报！
  const byName = buildAnnualSummary(twoSameNameEntities, { year: 2026, entityName: '星海跨境贸易' })
  assert.equal(byName.crossEntityMixed, true)
  assert.equal(byName.declarable, false)
  assert.equal(byName.thresholdApplicable, false)
  assert.equal(byName.byEntity.length, 2)
  assert.notEqual(byName.threeJurisdictions.us1099k.status, 'danger')
  assert.equal(byName.threeJurisdictions.us1099k.metrics.meetsFederalDualThreshold, false)
  assert.equal(byName.threeJurisdictions.us1099k.metrics.thresholdApplicable, false)

  // rolling12m 按同名筛选同样不得允许跨 entityKey 判阈值
  const r12 = computeRolling12m(twoSameNameEntities, { entityName: '星海跨境贸易' })
  assert.equal(r12.thresholdApplicable, false)

  // 未筛选多法人各 $15,000 / 150 笔 + 各 €1,200 / 16 笔：合并虽超 $30k/300笔 与 €2,400/32笔，但顶层绝不得判 danger！
  const twoDistinct = [
    {
      id: 'aa000003-1111-4111-8111-111111111111', month: '2026-11',
      entityKey: 'corp_alpha', entityLabel: '甲公司', shopKey: 's1', shopLabel: '店1',
      platforms: ['Amazon'], sites: ['US', 'DE'], currencies: ['USD', 'EUR'],
      grossCny: 120000, netSalesCny: 115000, feesCny: 15000, payoutCny: 100000,
      usSalesUsd: 15000, usTransactionCount: 150, euSalesEur: 1200, euOrderCount: 16,
    },
    {
      id: 'aa000004-1111-4111-8111-111111111111', month: '2026-11',
      entityKey: 'corp_beta', entityLabel: '乙公司', shopKey: 's2', shopLabel: '店2',
      platforms: ['Amazon'], sites: ['US', 'FR'], currencies: ['USD', 'EUR'],
      grossCny: 120000, netSalesCny: 115000, feesCny: 15000, payoutCny: 100000,
      usSalesUsd: 15000, usTransactionCount: 150, euSalesEur: 1200, euOrderCount: 16,
    },
  ]
  const multi = buildAnnualSummary(twoDistinct, { year: 2026 })
  assert.equal(multi.crossEntityMixed, true)
  assert.notEqual(multi.threeJurisdictions.us1099k.status, 'danger')
  assert.equal(multi.threeJurisdictions.us1099k.metrics.meetsFederalDualThreshold, false)
  assert.notEqual(multi.threeJurisdictions.euDac7.status, 'danger')
  assert.equal(multi.threeJurisdictions.euDac7.metrics.exceedsThreshold, null)
  for (const ent of multi.byEntity) {
    assert.notEqual(ent.threeJurisdictions.us1099k.status, 'danger')
    assert.equal(ent.threeJurisdictions.us1099k.metrics.meetsFederalDualThreshold, false)
    assert.notEqual(ent.threeJurisdictions.euDac7.status, 'danger')
  }

  // 按稳定 entityKey 精确筛选可以严格隔离单主体
  const onlySz = buildAnnualSummary(twoSameNameEntities, { year: 2026, entityKey: 'ent_sz_corp' })
  assert.equal(onlySz.crossEntityMixed, false)
  assert.equal(onlySz.declarable, true)
  assert.equal(onlySz.snapshotCount, 1)
  assert.equal(onlySz.threeJurisdictions.us1099k.metrics.usSalesUsd, 11000)
})

// ── 2. 红队反例：混合原币 + CNY 折算绝不丢月 (100 USD/1笔 + 216,000 CNY/250笔 -> 30,100 USD / 251笔 -> danger) ──
test('红队 Track C-1B：混合原币与 CNY 折算精准合并 mixed_estimated（30,100 USD / 251 笔 -> danger），缺月/缺笔数返 pending_data', () => {
  const mixedOrigAndCny = [
    {
      id: 'bb000001-1111-4111-8111-111111111111', month: '2026-10',
      entityKey: 'ent_mix', entityLabel: '混估测试主体', shopKey: 'amz_us', shopLabel: 'US主店',
      platforms: ['Amazon'], sites: ['US'], currencies: ['USD'],
      grossCny: 720, netSalesCny: 700, feesCny: 100, payoutCny: 600,
      usSalesUsd: 100, usTransactionCount: 1,
    },
    {
      id: 'bb000002-1111-4111-8111-111111111111', month: '2026-11',
      entityKey: 'ent_mix', entityLabel: '混估测试主体', shopKey: 'amz_us', shopLabel: 'US主店',
      platforms: ['Amazon'], sites: ['US'], currencies: ['USD'],
      grossCny: 216000, netSalesCny: 200000, feesCny: 30000, payoutCny: 170000,
      usSalesUsd: null, usTransactionCount: 250,
    },
  ]
  const res = buildAnnualSummary(mixedOrigAndCny, { year: 2026, entityKey: 'ent_mix', fxRateUsdToCny: 7.2 })
  const us = res.threeJurisdictions.us1099k
  assert.equal(us.metrics.usSalesBasis, 'mixed_estimated')
  assert.equal(us.metrics.usSalesUsd, 30100)
  assert.equal(us.metrics.usTransactionCount, 251)
  assert.equal(us.metrics.meetsFederalDualThreshold, true)
  assert.equal(us.status, 'danger')
  assert.ok(us.alerts.some((a) => a.includes('mixed_estimated')))

  // 缺笔数场景（全年 12 月齐备但有 1 月缺笔数）：保留已知下限并必须返回 pending_data，绝不返回 ok
  const twelveMonthsMissingTxn = Array.from({ length: 12 }, (_, idx) => ({
    id: `bb1000${String(idx + 1).padStart(2, '0')}-1111-4111-8111-111111111111`,
    month: `2026-${String(idx + 1).padStart(2, '0')}`,
    entityKey: 'ent_gap', entityLabel: '缺笔数主体', shopKey: 'us', shopLabel: 'US店',
    platforms: ['Shopify'], sites: ['US'], currencies: ['USD'],
    grossCny: 200, netSalesCny: 200, feesCny: 10, payoutCny: 190,
    usSalesUsd: 30, usTransactionCount: idx === 11 ? null : 2,
  }))
  const gapRes = buildAnnualSummary(twelveMonthsMissingTxn, { year: 2026, entityKey: 'ent_gap' })
  assert.equal(gapRes.threeJurisdictions.us1099k.status, 'pending_data')
  assert.equal(gapRes.threeJurisdictions.us1099k.metrics.usSalesUsd, 360)
  assert.equal(gapRes.threeJurisdictions.us1099k.metrics.usTransactionCount, 22)
  assert.equal(gapRes.threeJurisdictions.us1099k.metrics.usMissingTxnCount, 1)
  assert.equal(gapRes.threeJurisdictions.us1099k.metrics.knownLowerBound, true)
  assert.ok(gapRes.threeJurisdictions.us1099k.dataGaps.length >= 1)
})

// ── 3. 红队反例：纯 UK 站点 + EUR 不误触 EU DAC7 + 三地期限、报送主体与支付类型精细化 ──
test('红队 Track C-1C/1D：纯 UK+EUR（€2,100/4笔、€3,000/31笔）不触发 DAC7 danger，三地期限/报送人/TPSO vs PSE 精确', () => {
  const ukEurCase1 = buildAnnualSummary([
    {
      id: 'cc000001-1111-4111-8111-111111111111', month: '2026-10',
      entityKey: 'ent_uk', entityLabel: '英站主体', shopKey: 'amz_uk', shopLabel: 'Amazon UK',
      platforms: ['Amazon'], sites: ['UK'], currencies: ['EUR'],
      grossCny: 16380, netSalesCny: 15600, feesCny: 2000, payoutCny: 13600,
      euSalesEur: 2100, euOrderCount: 4,
    },
  ], { year: 2026, entityKey: 'ent_uk' })
  assert.equal(ukEurCase1.threeJurisdictions.euDac7.triggered, false)
  assert.notEqual(ukEurCase1.threeJurisdictions.euDac7.status, 'danger')
  assert.equal(ukEurCase1.threeJurisdictions.euDac7.metrics.exceedsThreshold, false)
  assert.equal(ukEurCase1.threeJurisdictions.euDac7.metrics.eurCurrencyOnlyHint, true)
  assert.deepEqual(ukEurCase1.threeJurisdictions.euDac7.metrics.euSites, [])
  assert.ok(ukEurCase1.threeJurisdictions.euDac7.alerts.some((a) => a.includes('人工核查') && a.includes('税务居民')))

  const ukEurCase2 = buildAnnualSummary([
    {
      id: 'cc000002-1111-4111-8111-111111111111', month: '2026-11',
      entityKey: 'ent_uk2', entityLabel: '英站主体二', shopKey: 'amz_uk', shopLabel: 'Amazon UK',
      platforms: ['Amazon'], sites: ['UK'], currencies: ['EUR'],
      grossCny: 23400, netSalesCny: 22000, feesCny: 3000, payoutCny: 19000,
      platformBreakdown: [{ platform: 'Amazon', site: 'UK', currency: 'EUR', grossCny: 23400, grossOrig: 3000, transactionCount: 31 }],
    },
  ], { year: 2026, entityKey: 'ent_uk2' })
  assert.equal(ukEurCase2.threeJurisdictions.euDac7.triggered, false)
  assert.notEqual(ukEurCase2.threeJurisdictions.euDac7.status, 'danger')
  assert.equal(ukEurCase2.threeJurisdictions.euDac7.metrics.exceedsThreshold, false)

  // 三地期限、报送主体与支付类型核验（2026 自然年 -> 2027 交卷）
  const cn = ukEurCase1.threeJurisdictions.china810
  const eu = ukEurCase1.threeJurisdictions.euDac7
  const us = ukEurCase1.threeJurisdictions.us1099k
  assert.match(cn.scheduleNote, /每季报送上季/)
  assert.match(cn.scheduleNote, /内部/)
  assert.equal(eu.platformReportDeadline, '2027-01-31')
  assert.equal(eu.authorityExchangeDeadline, '2027-02-28')
  assert.match(eu.scheduleNote, /2027-01-31.*2027-02-28/)
  assert.equal(us.recipientDeadline, '2027-02-01')
  assert.equal(us.deadline, '2027-02-01')
  assert.equal(us.irsEfileDeadline, '2027-03-31')
  assert.match(us.paymentScopeNote, /TPSO/)
  assert.match(us.paymentScopeNote, /支付卡收单/)

  const html = renderAnnualSummaryHtml(ukEurCase1)
  const md = renderAnnualSummaryMarkdown(ukEurCase1)
  for (const doc of [html, md]) {
    assert.ok(doc.includes('2027-02-01'))
    assert.ok(doc.includes('2027-03-31'))
    assert.ok(doc.includes('2027-02-28'))
  }
})

// ── 4. 红队反例：改店名保留原 entityKey + 双边同覆盖期差额（不把未补期混成虚假巨额差额） ──
test('红队 Track C-1E：仅改店名强制保留原 entityKey；申报与银行差额仅按双边同覆盖期计算并另列待补期数与金额', (t) => {
  const dir = useIsolatedDir(t)
  const store = createHistoryStore({ dir })
  const s1 = saveSnapshot({
    month: '2026-10', entityKey: 'ent_stable_01', entityLabel: '深圳稳健跨境有限公司',
    shopKey: 'shop_old', shopLabel: '北美老店', platforms: ['Amazon'],
    grossCny: 200000, netSalesCny: 190000, feesCny: 30000, payoutCny: 160000,
    declaredVatSalesCny: 190000, stage2WalletInboundCny: 159500, stage3BankReceivedCny: 159000,
  }).entry
  saveSnapshot({
    month: '2026-11', entityKey: 'ent_stable_01', entityLabel: '深圳稳健跨境有限公司',
    shopKey: 'shop_old', shopLabel: '北美老店', platforms: ['Amazon'],
    grossCny: 300000, netSalesCny: 290000, feesCny: 40000, payoutCny: 250000,
    declaredVatSalesCny: null, stage2WalletInboundCny: 249000, stage3BankReceivedCny: null,
  })

  // 仅修改店名（即便传入原 entityLabel 而不传 entityKey），必须保留原 entityKey 不拆散法人！
  const renamed = reassignArchiveEntity(store, s1.id, {
    entityLabel: '深圳稳健跨境有限公司',
    shopLabel: '北美旗舰新店',
  })
  assert.equal(renamed.conflict, false)
  assert.equal(renamed.entry.entityKey, 'ent_stable_01')
  assert.equal(renamed.entry.shopLabel, '北美旗舰新店')

  const ann = buildAnnualSummary(store, { year: 2026 })
  assert.equal(ann.crossEntityMixed, false, '改店名后绝不可按显示名派生新键拆散同一法人')
  assert.equal(ann.availableEntities.length, 1)
  assert.equal(ann.availableEntities[0].entityKey, 'ent_stable_01')

  // 双边同覆盖期差额：10 月双方齐全（申报差 0、s1->s3 差 -1000、s2->s3 差 -500）；11 月缺申报与银行回单归入待补，绝不混入差额！
  assert.equal(ann.annual.declaredGapCny, 0)
  assert.equal(ann.annual.declaredMatchedMonthCount, 1)
  assert.equal(ann.annual.declaredPendingMonthCount, 1)
  assert.equal(ann.annual.declaredPendingNetSalesCny, 290000)
  assert.equal(ann.annual.stage2to3GapCny, -500)
  assert.equal(ann.annual.stage2to3PendingMonthCount, 1)
  assert.equal(ann.annual.stage2to3PendingStage2Cny, 249000)
  assert.equal(ann.annual.stage1to3GapCny, -1000)
  assert.equal(ann.annual.stage1to3PendingMonthCount, 1)
  assert.equal(ann.annual.stage1to3PendingPayoutCny, 250000)
})

// ── 5. 红队反例：2 条合法追加 UUID 备份恢复空库得 imported=2, skipped=0 + HTTP 强制校验 + v3 legacyId 兼容 ──
test('红队 Track C-2：备份按 UUID 判幂等（合法追加 2 条恢复不丢）、HTTP 禁止 verifyChecksum:false 绕过、v3 legacyId 兼容查找/重分配/删除', async (t) => {
  const dir1 = useIsolatedDir(t, 'fintax-rt-bk1-')
  const store1 = createHistoryStore({ dir: dir1 })
  const dir2 = mkdtempSync(join(tmpdir(), 'fintax-rt-bk2-'))
  t.after(() => rmSync(dir2, { recursive: true, force: true }))
  const store2 = createHistoryStore({ dir: dir2 })

  // 同主体同店同月写入 2 条合法追加记录（不同 UUID，相同 sourceKey）
  const rec1 = saveSnapshot({
    month: '2026-11', entityKey: 'corp_dup', entityLabel: '追加测试公司', shopKey: 'amz_us', shopLabel: 'US主店',
    platforms: ['Amazon'], grossCny: 100000, netSalesCny: 95000, feesCny: 15000, payoutCny: 80000,
  }).entry
  const rec2 = saveSnapshot({
    month: '2026-11', entityKey: 'corp_dup', entityLabel: '追加测试公司', shopKey: 'amz_us', shopLabel: 'US主店',
    platforms: ['Amazon'], grossCny: 50000, netSalesCny: 48000, feesCny: 8000, payoutCny: 40000,
    conflictMode: 'append',
  }).entry
  assert.equal(rec1.sourceKey, rec2.sourceKey)
  assert.notEqual(rec1.id, rec2.id)

  const backup = exportArchiveBackup(store1)
  assert.equal(backup.recordCount, 2)

  // 默认 merge_skip 恢复到空库：必须 imported=2, skipped=0，逐条 ID/金额/修订号/总数 100% 一致！
  const restored = importArchiveBackup(store2, backup)
  assert.equal(restored.imported, 2)
  assert.equal(restored.skipped, 0)
  assert.equal(restored.overwritten, 0)
  assert.equal(restored.totalInStore, 2)
  const loaded2 = store2.load()
  const r1 = loaded2.find((x) => x.id === rec1.id)
  const r2 = loaded2.find((x) => x.id === rec2.id)
  assert.ok(r1 && r2)
  assert.equal(r1.grossCny, rec1.grossCny)
  assert.equal(r1.revision, rec1.revision)
  assert.equal(r2.grossCny, rec2.grossCny)
  assert.equal(r2.revision, rec2.revision)
  assert.equal(r2.importMode, 'append')

  // 二次导入同一备份按 UUID 幂等跳过 2 条
  const again = importArchiveBackup(store2, backup)
  assert.equal(again.imported, 0)
  assert.equal(again.skipped, 2)

  // HTTP POST /api/fintax/history/backup 强制校验：传 verifyChecksum:false 绝不能绕过篡改检测！
  const handler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: { sessionId: 'bk-sess' } }) }) })
  const tampered = structuredClone(backup)
  tampered.records[0].grossCny += 100
  const bypassAttempt = await mockApiCall(handler, 'POST', '/api/fintax/history/backup', {
    backup: tampered,
    verifyChecksum: false,
    strictChecksum: false,
  })
  assert.equal(bypassAttempt.statusCode, 400)
  assert.equal(bypassAttempt.json.code, 'BACKUP_CHECKSUM_MISMATCH')

  // v3 旧非 UUID 迁移保留 legacyId，兼容按 legacyId 查找、重分配与删除
  const histPath = join(dir1, 'fintax_history.json')
  writeFileSync(histPath, JSON.stringify({
    schema: 'dsh-fintax-history-v3',
    entries: [
      { id: 'legacy_snap_2026_08', month: '2026-08', platforms: ['Amazon'], grossCny: 88000, netSalesCny: 85000, payoutCny: 70000 },
    ],
  }), 'utf8')
  const migratedList = loadHistory()
  assert.equal(migratedList.length, 1)
  assert.equal(migratedList[0].legacyId, 'legacy_snap_2026_08')
  assert.ok(findSnapshotById(migratedList, 'legacy_snap_2026_08'))

  const reassignedLegacy = reassignArchiveEntity(null, 'legacy_snap_2026_08', { entityLabel: '旧档认领主体' })
  assert.equal(reassignedLegacy.conflict, false)
  assert.equal(reassignedLegacy.entry.entityLabel, '旧档认领主体')
  assert.equal(reassignedLegacy.entry.legacyId, 'legacy_snap_2026_08')

  const delLegacyHttp = await mockApiCall(handler, 'DELETE', '/api/fintax/history/legacy_snap_2026_08')
  assert.equal(delLegacyHttp.statusCode, 200)
  assert.equal(delLegacyHttp.json.deleted, true)
  assert.equal(loadHistory().length, 0)
})

// ── 6. 红队反例：会话隔离（无独占身份禁跨请求缓存复用 + archiveToken 跨会话拦截 + 软预算标注） ──
test('红队 Track C-3：无宿主独占会话身份时 parseCache 返 cacheToken:null；archiveToken 严格按会话隔离；软预算显式标注', async (t) => {
  useIsolatedDir(t)
  const cache = createParseCache()
  assert.equal(cache.stats().budgetKind, 'estimated_soft_budget')
  const unscopedPut = cache.put({ x: 1 }, {})
  assert.equal(unscopedPut.cached, false)
  assert.equal(unscopedPut.cacheToken, null)
  assert.equal(unscopedPut.reason, 'UNSCOPED_SESSION')

  // 老宿主（requestRejection 无 cookie/auth）或仅 remoteAddress / 伪造 x-fintax-session / Origin -> 严禁写入跨请求缓存！
  const legacyHandler = createFintaxApiHandler({
    getConnection: () => ({ requestRejection: () => undefined }),
  })
  const legacyParsed = await mockApiCall(legacyHandler, 'POST', '/api/fintax/parse', {
    demo: 'v9',
    reportFormat: 'data',
    fxRates: { USD: 7.24 },
  }, { 'x-fintax-session': 'spoofed-client-header', origin: 'http://localhost:3000' })
  assert.equal(legacyParsed.statusCode, 200)
  assert.equal(legacyParsed.json.cacheToken, null, '缺失宿主独占会话身份时绝不得退回全局公共作用域')

  const ipOnlyHandler = createFintaxApiHandler({
    getConnection: () => ({ admit: () => ({ peer: { remoteAddress: '127.0.0.1' } }) }),
  })
  const ipOnlyParsed = await mockApiCall(ipOnlyHandler, 'POST', '/api/fintax/parse', {
    demo: 'v9',
    reportFormat: 'data',
    fxRates: { USD: 7.24 },
  })
  assert.equal(ipOnlyParsed.statusCode, 200)
  assert.equal(ipOnlyParsed.json.cacheToken, null, '共享 127.0.0.1 remoteAddress 不可作为独占会话身份')

  // 现代宿主提供独占 peer.sessionId：Session B 盗用 Session A 的 archiveToken 必须被拦截！
  const scopedHandler = createFintaxApiHandler({
    getConnection: () => ({ admit: (req) => ({ peer: { sessionId: req.headers['x-host-peer-sess'] } }) }),
  })
  const csv = 'Created,ID,Type,Description,Currency,Amount,Fee,Net\n2026-11-05,ch_1,charge,Sale,CNY,1000,0,1000'
  const parsedA = await mockApiCall(scopedHandler, 'POST', '/api/fintax/parse', {
    reportFormat: 'data',
    files: [{ name: 'sale.csv', dataBase64: Buffer.from(csv).toString('base64') }],
  }, { 'x-host-peer-sess': 'session-A' })
  assert.equal(parsedA.statusCode, 200)
  assert.match(parsedA.json.cacheToken, /^[0-9a-f]{32}$/)
  assert.ok(parsedA.json.archiveToken)

  const stolenArchive = await mockApiCall(scopedHandler, 'POST', '/api/fintax/history', {
    month: '2026-11',
    entityName: '盗用测试',
    archiveToken: parsedA.json.archiveToken,
  }, { 'x-host-peer-sess': 'session-B' })
  assert.equal(stolenArchive.statusCode, 400)
  assert.equal(stolenArchive.json.code, 'ARCHIVE_EVIDENCE_REQUIRED')

  // 原会话 A 仍可正常提交归档（未因 B 的探测失效）
  const okArchiveA = await mockApiCall(scopedHandler, 'POST', '/api/fintax/history', {
    month: '2026-11',
    entityName: '合法会话A',
    archiveToken: parsedA.json.archiveToken,
  }, { 'x-host-peer-sess': 'session-A' })
  assert.equal(okArchiveA.statusCode, 200)
})

// ── 7. 红队反例：/calc/specs 14 引擎 + /ima-quick 严格 3 字段纯文本 + .xlsm 上传端到端解析 ──
test('红队 Track C-4/5A：/calc/specs 返全部 14 引擎、/ima-quick 严格 3 字段纯文本、.xlsm 上传端到端解析成功', async (t) => {
  useIsolatedDir(t)
  const savedEnv = [process.env.IMA_CLIENT_ID, process.env.IMA_API_KEY, process.env.IMA_DEFAULT_KB_ID]
  process.env.IMA_CLIENT_ID = 'rt-cid'
  process.env.IMA_API_KEY = 'rt-key'
  process.env.IMA_DEFAULT_KB_ID = 'rt-kb'
  clearImaCache()
  t.after(() => {
    clearImaCache()
    for (const [i, k] of ['IMA_CLIENT_ID', 'IMA_API_KEY', 'IMA_DEFAULT_KB_ID'].entries()) {
      if (savedEnv[i] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[i]
    }
  })

  const handler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: { sessionId: 'rt-s1' } }) }) })
  const specsRes = await mockApiCall(handler, 'GET', '/api/fintax/calc/specs')
  assert.equal(specsRes.statusCode, 200)
  assert.equal(specsRes.json.calcEngineCount, 14)
  assert.equal(specsRes.json.specs.length, 14)
  assert.equal(new Set(specsRes.json.scenarios).size, 14)
  const calcMod = await import('../lib/calc.js')
  if (typeof calcMod.getAllCalcSpecs === 'function') {
    assert.deepEqual(specsRes.json.scenarios, calcMod.getAllCalcSpecs().map((s) => s.code))
  }

  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(JSON.stringify({
    code: 0,
    data: {
      info_list: [{
        media_id: 'secret-media-999',
        kb_id: 'secret-kb-888',
        update_time: '2026-11-27',
        title: '<script>x()</script><b>政策标题</b> https://leak.example.com/a.pdf\u0007',
        folder_path: '<div>目录/欧盟</div> https://leak.example.com/dir\u0000',
        highlight_content: '<i>摘录内容</i> <=€150 https://leak.example.com/doc',
      }],
    },
  }))))
  const imaRes = await mockApiCall(handler, 'POST', '/api/fintax/ima-quick', { query: '欧盟' })
  assert.equal(imaRes.statusCode, 200)
  assert.equal(imaRes.json.hits.length, 1)
  const [hit] = imaRes.json.hits
  assert.deepEqual(Object.keys(hit).sort(), ['folderPath', 'snippet', 'title'])
  assert.equal(hit.mediaId, undefined)
  assert.equal(hit.kbId, undefined)
  assert.equal(hit.updatedAt, undefined)
  assert.equal(JSON.stringify(hit).includes('leak.example.com'), false)
  assert.equal(JSON.stringify(hit).includes('<script>'), false)
  assert.ok(hit.snippet.includes('<=€150'))

  // .xlsm 上传契约端到端解析通过
  const xlsmBuf = buildMinimalXlsm()
  const xlsmRes = await mockApiCall(handler, 'POST', '/api/fintax/parse', {
    reportFormat: 'data',
    files: [{ name: 'stripe_macro.xlsm', dataBase64: xlsmBuf.toString('base64') }],
  })
  assert.equal(xlsmRes.statusCode, 200)
  assert.equal(xlsmRes.json.ok, true)
  assert.equal(xlsmRes.json.consolidated.totals.grossCny, 500)
})

// ── 8. 红队反例（前端 client.js VM 实测）：404 回退存新 cacheToken、市场空 {} 拒绝误判、409 版本冲突分流、年度列表过滤与改店名保 entityKey、欧盟 UI 取分与 >€150 拦截 ──
function runClientHarness(fetchFn) {
  const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let mounted
  const styles = new Map()
  const document = {
    baseURI: 'https://localhost/',
    documentElement: { lang: 'zh' },
    getElementById: (id) => styles.get(id),
    head: { appendChild: (style) => styles.set(style.id, style) },
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ dataset: {}, click() {}, remove() { styles.delete(this.id) } }),
  }
  const same = (a, b) => a?.length === b?.length && b.every((v, i) => Object.is(a[i], v))
  const cell = (init) => { const idx = mounted.index++; return mounted.cells[idx] ??= init() }
  const useMemo = (fn, deps) => { const it = cell(() => ({})); if (!same(it.deps, deps)) Object.assign(it, { deps, value: fn() }); return it.value }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: (current) => cell(() => ({ current })),
    useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    useState(init) {
      const it = cell(() => ({ value: typeof init === 'function' ? init() : init }))
      return [it.value, (next) => { it.value = typeof next === 'function' ? next(it.value) : next }]
    },
    useEffect(fn, deps) {
      const it = cell(() => ({}))
      if (same(it.deps, deps)) return
      it.deps = deps
      mounted.effects.push(() => { it.undo?.(); it.undo = fn() })
    },
  }
  const slots = new Map()
  const window = {
    __ModuleLoader__: {
      load: (mod) => mod.factory(() => React).apply({
        locale: { bind: () => (k) => k, register() {}, getLocale: () => ({ active: 'zh' }) },
        effect: (fn) => fn(),
        slots: { inject: (_, fn) => fn(), register: (meta, render) => slots.set(meta.name, render) },
      }),
    },
  }
  runInNewContext(clientSrc, {
    window, document, navigator: { clipboard: { writeText: async () => {} } },
    FileReader: class {}, fetch: fetchFn, AbortController, URL, Blob, setTimeout, clearTimeout, console,
  })
  const fibers = []
  const unmount = (f) => { if (!f.closed) { for (const c of f.cells) c.undo?.(); f.closed = true } }
  const mount = (render) => {
    const fiber = { cells: [], effects: [] }
    fibers.push(fiber)
    const run = () => {
      const parent = mounted; mounted = fiber; fiber.index = 0
      try { const out = render(); for (const ef of fiber.effects.splice(0)) ef(); return out } finally { mounted = parent }
    }
    return run
  }
  function* walk(node) {
    if (Array.isArray(node)) { for (const c of node) yield* walk(c) }
    else if (node?.props) { yield node; yield* walk(node.children) }
  }
  const byText = (node, type, txt) => [...walk(node)].find((el) => el.type === type && el.children.includes(txt))
  const panel = slots.get('main')().children[0]
  const renderRoot = mount(() => panel.type(panel.props))
  const child = (name) => mount(() => {
    const c = [...walk(renderRoot())].find((el) => el.type?.name === name)
    return c ? c.type(c.props) : null
  })
  return {
    walk, byText, renderRoot,
    radar: child('StatementRadarTab'),
    calc: child('CalculatorTab'),
    annual: child('AnnualArchiveTab'),
    settings: child('SettingsTab'),
    unmount: () => fibers.forEach(unmount),
  }
}

test('红队 Track C-5B/5C/5D/5E：404 回退存新 token、dsh-market 空 {} 拒误判、409 版本冲突分流、年度列表过滤与改店名保 entityKey、欧盟 UI 取分一致', async (t) => {
  const flush = () => new Promise((r) => setImmediate(r))
  const resp = (data, status = 200) => new Response(JSON.stringify(data), { status })
  const exportCalls = []
  const reassignBodies = []
  let exportStep = 0
  let reassignStep = 0
  let euMockMode = 'ceil_edge' // 'ceil_edge' | 'exceeds_150'

  const histRecords = [
    { id: '11111111-1111-4111-8111-111111111111', revision: '22222222-2222-4222-8222-222222222222', month: '2026-10', entityKey: 'ent_sz_1', entityLabel: '深圳甲公司', entityName: '深圳甲公司', ownershipStatus: 'claimed', shopKey: 's1', shopLabel: '老店名', storeScope: '老店名', netSalesCny: 100000 },
    { id: '33333333-3333-4333-8333-333333333333', revision: '44444444-4444-4444-8444-444444444444', month: '2026-11', entityKey: 'ent_hk_2', entityLabel: '香港乙公司', entityName: '香港乙公司', ownershipStatus: 'claimed', shopKey: 's2', shopLabel: '港店', storeScope: '港店', netSalesCny: 200000 },
    { id: '55555555-5555-4555-8555-555555555555', revision: '66666666-6666-4666-8666-666666666666', month: '2025-12', entityKey: 'ent_sz_1', entityLabel: '深圳甲公司', entityName: '深圳甲公司', ownershipStatus: 'claimed', shopKey: 's1', shopLabel: '2025旧档', storeScope: '2025旧档', netSalesCny: 50000 },
  ]
  const annualSummary = {
    year: 2026, deadlineDate: '2027-01-31', scopeLabel: '深圳甲公司',
    availableEntities: [
      { entityKey: 'ent_sz_1', entityLabel: '深圳甲公司', ownershipStatus: 'claimed', snapshotCount: 1 },
      { entityKey: 'ent_hk_2', entityLabel: '香港乙公司', ownershipStatus: 'claimed', snapshotCount: 1 },
    ],
    crossEntityMixed: false, missingMonthsCount: 11, missingMonthsNote: '缺 11 月',
    monthlySeries: [], quarters: [], annual: { grossCny: 100000, netSalesCny: 100000, payoutCny: 80000, p0Count: 0, missingMonthCount: 11 },
    threeJurisdictions: {
      deadline: '2027-01-31',
      cards: [{
        id: 'us_1099k', jurisdiction: 'US', title: '美国 · IRS Form 1099-K', deadline: '2027-02-01',
        policyRef: 'IRC §6050W', status: 'pending_data', summary: '资料待补',
        dataGaps: ['全年缺档 11 个月', '1 份快照缺交易笔数'],
        alerts: ['严禁判定未触发', '州级 $600 门槛额外提醒'],
        metrics: { stateThresholdWarning: true },
        checklist: ['核对 W-8BEN-E'],
      }],
    },
  }

  const ui = runClientHarness((path, init) => {
    if (path.endsWith('/status')) return resp({ version: '0.9.0', capabilities: { dshMarketUpdateV1: true } })
    if (path.endsWith('/dsh-market/api/v1/capabilities')) return resp({}) // 空对象绝不得误判支持/已是最新！
    if (path.endsWith('/history')) return resp({ history: histRecords })
    if (path.includes('/history/annual')) return resp({ ok: true, summary: annualSummary })
    if (path.endsWith('/history/reassign')) {
      const body = JSON.parse(init.body)
      reassignBodies.push(body)
      reassignStep++
      if (reassignStep === 1) return resp({ conflict: true, code: 'REVISION_CONFLICT', conflictType: 'revision_conflict', reason: 'revision_mismatch' }, 409)
      return resp({ ok: true, conflict: false, overwritten: false })
    }
    if (path.endsWith('/parse/export')) {
      const body = JSON.parse(init.body)
      exportCalls.push(body)
      exportStep++
      if (exportStep === 1) return resp({ ok: false, error: 'CACHE_EXPIRED' }, 404)
      return resp({ ok: true, format: body.format, content: '<html>cached-new</html>', fromCache: true })
    }
    if (path.endsWith('/parse')) {
      const body = JSON.parse(init.body)
      if (body.reportFormat === 'html') return resp({ reportHtml: '<html>fallback</html>', cacheToken: 'b'.repeat(32) })
      return resp({
        summaries: [{ platform: 'Stripe', role: 'sales', period: '2026-11', currency: 'CNY', rawRowCount: 1, anomalies: [] }],
        consolidated: { ready: true, totals: { grossCny: 100, netSalesCny: 100, feesCny: 0 } },
        elapsedMs: 1,
        cacheToken: 'a'.repeat(32),
      })
    }
    if (path.endsWith('/calc')) {
      if (euMockMode === 'ceil_edge') {
        return resp({
          result: {
            scenario: '欧盟低值包裹', scenarioCode: 'eu_low_value_parcel', currency: 'EUR',
            euCustomsLevyTotalEur: 10, netProfitEur: 1.67, returnSunkHandlingFeeEur: 0.32,
            breakdown: {
              inputs: { sellingPriceEur: 30 },
              customsLevies: { totalCustomsLevyEur: 10 },
              planComparison: { mixedDirect: { netProfitEur: 1.67 }, singleHsDirect: { netProfitEur: 6.67 } },
              reversePricing: { mixedDirect: { feasible: true, minSellingPriceEur: 30.01, minSellingPriceCeilEur: 30.01, priceIncreaseNeededEur: 0.01 } },
            },
          },
        })
      }
      return resp({
        result: {
          scenario: '欧盟低值包裹', scenarioCode: 'eu_low_value_parcel', currency: 'EUR',
          euCustomsLevyTotalEur: 10, netProfitEur: 1.67, returnSunkHandlingFeeEur: 0.32,
          breakdown: {
            inputs: { sellingPriceEur: 35.7 },
            planComparison: { mixedDirect: { netProfitEur: 1.67 }, singleHsDirect: { netProfitEur: 6.67 } },
            reversePricing: { mixedDirect: { feasible: false, minSellingPriceEur: null, unconstrainedMinSellingPriceEur: 414.56, exceeds150Threshold: true, feasibleUnderLowValueRegime: false } },
          },
        },
      })
    }
    return resp({})
  })
  t.after(() => ui.unmount())

  // 1) Tab 1: 404 回退重解析后保存新 cacheToken，下一次导出直接命中 /parse/export 且携带新 token 'bbbb...'
  await ui.byText(ui.radar(), 'button', '用示例看一张核对单').props.onClick()
  await ui.byText(ui.radar(), 'button', '导出老板版 HTML 核对单').props.onClick() // 首次 404 -> 回退 /parse 拿到 'b'.repeat(32)
  await ui.byText(ui.radar(), 'button', '导出 Markdown (.md)').props.onClick() // 第二次应直接带新 token 命中 /parse/export！
  assert.equal(exportCalls.length, 2)
  assert.equal(exportCalls[0].cacheToken, 'a'.repeat(32))
  assert.equal(exportCalls[1].cacheToken, 'b'.repeat(32))

  // 2) Settings: dsh-market 返回空 {} 不得误判“已支持/已是最新”
  await ui.byText(ui.settings(), 'button', '检查 dsh-market 更新').props.onClick()
  const settingsJson = JSON.stringify(ui.settings())
  assert.match(settingsJson, /未启用 dsh-market Update API v1/)
  assert.doesNotMatch(settingsJson, /当前已是最新版本/)

  // 3) Annual tab: 完整渲染 alerts/dataGaps/州级提醒；按 year+entityKey 精确过滤；改店名传原 entityKey；409 revision_conflict 显示「刷新最新数据」不显 force
  ui.byText(ui.renderRoot(), 'button', '年度汇算与归档').props.onClick()
  ui.annual()
  await flush()
  const annInit = JSON.stringify(ui.annual())
  assert.match(annInit, /严禁判定未触发/)
  assert.match(annInit, /资料缺口/)
  assert.match(annInit, /州级提醒/)
  assert.doesNotMatch(annInit, /2025旧档/, '2026 年列表绝不可混入 2025 归档')

  // 切换到 ent_sz_1 后，操作列表只展示 ent_sz_1 的 2026 归档，不展示 ent_hk_2 的「港店」
  const entSelect = [...ui.walk(ui.annual())].find((el) => el.props['aria-label'] === '筛选年度主体')
  entSelect.props.onChange({ target: { value: 'ent_sz_1' } })
  ui.annual()
  await flush()
  const annFiltered = JSON.stringify(ui.annual())
  assert.match(annFiltered, /老店名/)
  assert.doesNotMatch(annFiltered, /港店/)

  // 仅修改店名提交 -> 请求必须携带原 entityKey: 'ent_sz_1'；收到 409 revision_mismatch 时显示「刷新最新数据」且不得显示 force 按钮！
  ui.byText(ui.annual(), 'button', '认领 / 重分配').props.onClick()
  const shopInput = [...ui.walk(ui.annual())].find((el) => el.type === 'input' && el.props.placeholder === '店铺/范围（可选）')
  shopInput.props.onChange({ target: { value: '旗舰新店名' } })
  await ui.byText(ui.annual(), 'button', '提交认领 / 重分配').props.onClick()
  assert.equal(reassignBodies[0].entityKey, 'ent_sz_1')
  assert.equal(reassignBodies[0].shopLabel, '旗舰新店名')
  const revView = ui.annual()
  assert.ok(ui.byText(revView, 'button', '刷新最新数据'))
  assert.equal(ui.byText(revView, 'button', '确认强制覆盖 (force)'), undefined)

  // 4) Calc tab: 欧盟保毛利最低价向上取分 €30.01 与调价 +€0.01 一致，且超 €150 标为红线不可行
  const navBtns = [...ui.walk(ui.calc())].filter((el) => el.props.className?.includes('ftx-nav-btn'))
  navBtns.find((el) => JSON.stringify(el).includes('欧盟低值包裹')).props.onClick()
  await ui.byText(ui.calc(), 'button', '立即代码精算（0 Token）').props.onClick()
  const euCeilTxt = JSON.stringify(ui.calc())
  assert.match(euCeilTxt, /€30\.01/)
  assert.match(euCeilTxt, /\+€0\.01/)

  euMockMode = 'exceeds_150'
  await ui.byText(ui.calc(), 'button', '立即代码精算（0 Token）').props.onClick()
  const euOver150Txt = JSON.stringify(ui.calc())
  assert.match(euOver150Txt, /超 €150/)
  assert.match(euOver150Txt, /不适用低值包裹/)
})


// ── 9. 二轮红队清零回归（#73 P0-1/P1-2/P1-3/P1-4/P2-1/P2-2 + #82 P0-5/P1-5/P1-6a） ──
test('二轮红队 R2-A：非美站 USD 不误触 1099-K、显式 0 不污染管辖区、单平台/单 TPSO 独立判定、entityKey 精确匹配与补单整月申报去重', (t) => {
  const dir = useIsolatedDir(t, 'fintax-r2a-')
  const store = createHistoryStore({ dir })

  // 1) [#73 P0-1] 明确非美站点 ['AE', 'UK'] 使用 USD 结算：绝不进入 1099-K 折算，status === 'not_applicable'
  const nonUsUsd12m = Array.from({ length: 12 }, (_, i) => ({
    id: `dd1000${String(i + 1).padStart(2, '0')}-1111-4111-8111-111111111111`,
    month: `2026-${String(i + 1).padStart(2, '0')}`,
    entityKey: 'ent_mena_uk', entityLabel: '中东英站主体', shopKey: 'ae_uk', shopLabel: 'Amazon AE+UK',
    platforms: ['Amazon'], sites: ['AE', 'UK'], currencies: ['USD'],
    grossCny: 216000, netSalesCny: 200000, feesCny: 30000, payoutCny: 170000,
  }))
  const nonUsSummary = buildAnnualSummary(nonUsUsd12m, { year: 2026, entityKey: 'ent_mena_uk' })
  assert.equal(nonUsSummary.threeJurisdictions.us1099k.triggered, false)
  assert.equal(nonUsSummary.threeJurisdictions.us1099k.status, 'not_applicable')
  assert.equal(nonUsSummary.threeJurisdictions.us1099k.metrics.usSalesUsd, null)
  assert.equal(nonUsSummary.threeJurisdictions.us1099k.metrics.usdCurrencyOnlyHint, true)
  assert.deepEqual(nonUsSummary.threeJurisdictions.us1099k.metrics.nonUsSitesWithUsd, ['AE', 'UK'])

  // 显式传 usSalesUsd: 0, usTransactionCount: 0 绝不误置 entryUsFlag=true 掐死德国站 CNY->EUR 折算；显式 euSalesEur: 0 不误报提示
  const deWithZeroUs = buildAnnualSummary([{
    id: 'dd200001-1111-4111-8111-111111111111', month: '2026-11',
    entityKey: 'ent_de_zero', entityLabel: '德站主体', shopKey: 'amz_de', shopLabel: 'Amazon DE',
    platforms: ['Amazon'], sites: ['DE'], currencies: ['EUR'],
    grossCny: 78000, netSalesCny: 75000, feesCny: 10000, payoutCny: 65000,
    euSalesEur: null, euOrderCount: 40, usSalesUsd: 0, usTransactionCount: 0,
  }], { year: 2026, entityKey: 'ent_de_zero', fxRateEurToCny: 7.8 })
  assert.equal(deWithZeroUs.threeJurisdictions.us1099k.triggered, false)
  assert.equal(deWithZeroUs.threeJurisdictions.euDac7.metrics.euSalesEur, 10000)
  assert.equal(deWithZeroUs.threeJurisdictions.euDac7.status, 'danger')

  const usWithZeroEu = buildAnnualSummary([{
    id: 'dd200002-1111-4111-8111-111111111111', month: '2026-11',
    entityKey: 'ent_us_zero_eu', entityLabel: '纯美站', shopKey: 'amz_us', shopLabel: 'Amazon US',
    platforms: ['Amazon'], sites: ['US'], currencies: ['USD'],
    grossCny: 7200, netSalesCny: 7000, payoutCny: 6000,
    usSalesUsd: 1000, usTransactionCount: 10, euSalesEur: 0, euOrderCount: 0,
  }], { year: 2026, entityKey: 'ent_us_zero_eu' })
  assert.equal(usWithZeroEu.threeJurisdictions.euDac7.triggered, false)
  assert.equal(usWithZeroEu.threeJurisdictions.euDac7.metrics.eurCurrencyOnlyHint, false)

  // 2) [#82 P1-5] 单主体跨两个独立平台/TPSO：各平台未超单平台门槛时，顶层返回 warn 绝不误报 danger！
  const multiPlat12m = Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, '0')
    if (i < 10) {
      return {
        id: `dd3000${mm}-1111-4111-8111-111111111111`, month: `2026-${mm}`,
        entityKey: 'ent_multi_plat', entityLabel: '多平台单法人', shopKey: 'all', shopLabel: '全店',
        platforms: ['Amazon'], grossCny: 0, netSalesCny: 0, feesCny: 0, payoutCny: 0, zeroSalesConfirmed: true,
      }
    }
    const isAmz = i === 10
    return {
      id: `dd3000${mm}-1111-4111-8111-111111111111`, month: `2026-${mm}`,
      entityKey: 'ent_multi_plat', entityLabel: '多平台单法人',
      shopKey: isAmz ? 'amz' : 'tts', shopLabel: isAmz ? 'Amazon' : 'TikTok',
      platforms: [isAmz ? 'Amazon' : 'TikTok Shop'], sites: ['DE', 'US'], currencies: ['EUR', 'USD'],
      grossCny: 96000, netSalesCny: 90000, feesCny: 10000, payoutCny: 80000,
      platformBreakdown: [
        { platform: isAmz ? 'Amazon' : 'TikTok Shop', site: 'DE', currency: 'EUR', grossCny: 9000, grossOrig: isAmz ? 1200 : 1000, transactionCount: isAmz ? 16 : 15 },
        { platform: isAmz ? 'Amazon' : 'TikTok Shop', site: 'US', currency: 'USD', grossCny: 87000, grossOrig: 12000, transactionCount: 110 },
      ],
    }
  })
  const mpRes = buildAnnualSummary(multiPlat12m, { year: 2026, entityKey: 'ent_multi_plat' })
  assert.equal(mpRes.threeJurisdictions.euDac7.metrics.euSalesEur, 2200)
  assert.equal(mpRes.threeJurisdictions.euDac7.metrics.euOrderCount, 31)
  assert.equal(mpRes.threeJurisdictions.euDac7.metrics.exceedsThreshold, false)
  assert.equal(mpRes.threeJurisdictions.euDac7.status, 'warn')
  assert.equal(mpRes.threeJurisdictions.us1099k.metrics.usSalesUsd, 24000)
  assert.equal(mpRes.threeJurisdictions.us1099k.metrics.usTransactionCount, 220)
  assert.equal(mpRes.threeJurisdictions.us1099k.metrics.meetsFederalDualThreshold, false)
  assert.equal(mpRes.threeJurisdictions.us1099k.status, 'warn')

  // 3) [#82 P0-5] entityKey 精确匹配不回退 entityLabel；同名已认领主体未传 entityKey 拦截 AMBIGUOUS_ENTITY_KEY
  const e1 = saveSnapshot({
    month: '2026-09', entityKey: 'uscc_91440300ma5', entityLabel: '星辰跨境科技', shopKey: 's1', shopLabel: '店1',
    platforms: ['Amazon'], grossCny: 100000, netSalesCny: 95000, payoutCny: 80000, declaredVatSalesCny: 150000,
  }).entry
  // 同月 append 补单记录整月增值税申报同值 150000（或留空）不重复翻倍且计入已覆盖月份
  saveSnapshot({
    month: '2026-09', entityKey: 'uscc_91440300ma5', entityLabel: '星辰跨境科技', shopKey: 's1', shopLabel: '店1',
    platforms: ['Amazon'], grossCny: 55000, netSalesCny: 55000, payoutCny: 45000, declaredVatSalesCny: 150000, conflictMode: 'append',
  })
  // 另一主体故意把 entityLabel 起名为上一主体的 entityKey！
  saveSnapshot({
    month: '2026-09', entityKey: 'other_corp_key', entityLabel: 'uscc_91440300ma5', shopKey: 's2', shopLabel: '店2',
    platforms: ['Temu'], grossCny: 888888, netSalesCny: 888888, payoutCny: 700000,
  })
  const strictKeyAnn = buildAnnualSummary(store, { year: 2026, entityKey: 'uscc_91440300ma5' })
  assert.equal(strictKeyAnn.snapshotCount, 2)
  assert.equal(strictKeyAnn.annual.netSalesCny, 150000)
  assert.equal(strictKeyAnn.annual.declaredVatSalesCny, 150000)
  assert.equal(strictKeyAnn.annual.declaredGapCny, 0)
  assert.equal(strictKeyAnn.annual.declaredPendingMonthCount, 0)
  const strictKeyR12 = computeRolling12m(store.load(), { entityKey: 'uscc_91440300ma5' })
  assert.equal(strictKeyR12.totalNetSalesCny, 150000)

  assert.throws(() => saveSnapshot({
    month: '2026-10', entityName: '星辰跨境科技', storeScope: '店1', grossCny: 50000,
  }), { code: 'AMBIGUOUS_ENTITY_KEY' })
  assert.throws(() => saveSnapshot({
    month: '2026-10', entityName: '全新同名公司', distinctNewEntity: true, storeScope: '店1', grossCny: 50000,
  }), { code: 'ENTITY_KEY_REQUIRED' })

  // [#73 P2-1] 待认领快照重分配至唯一同名已认领主体时自动复用其 entityKey ('uscc_91440300ma5')
  const uncl = saveSnapshot({ month: '2026-10', entityName: '待认领', storeScope: '店1', grossCny: 60000 }).entry
  const claimedAuto = reassignArchiveEntity(store, uncl.id, { entityLabel: '星辰跨境科技', euOrderCount: 18, usTransactionCount: 25 })
  assert.equal(claimedAuto.entry.entityKey, e1.entityKey)
  assert.equal(claimedAuto.entry.euOrderCount, 18)
  assert.equal(claimedAuto.entry.usTransactionCount, 25)
})

// ── 10. 二轮红队备份/legacyId/UTF-16 码点安全与 HTTP 全链路（#73 P0-2/P1-1/P1-2/P1-3/P1-4 + #82 P0-6/P0-7/P1-6） ──
test('二轮红队 R2-B：备份阻断异 UUID 非追加翻倍、无 id 确定性幂等、legacyId 全局唯一与优先级、Emoji 截断安全、跨连接 c-1->c-3 与 HTTP 12 月订单笔数/Stage3 partial', async (t) => {
  const dir = useIsolatedDir(t, 'fintax-r2b-')
  const store = createHistoryStore({ dir })

  // 1) [#73 P1-2 & #82 P1-6a] 不同 UUID 的同 sourceKey 非追加主记录拦截翻倍，保留合法 append 补单，无 id 幂等，同内容不改 revision
  const primary = saveSnapshot({
    month: '2026-08', entityKey: 'ent_bk', entityLabel: '备份测试', shopKey: 's1', shopLabel: '店1',
    platforms: ['Amazon'], grossCny: 100000, netSalesCny: 95000, feesCny: 5000, payoutCny: 90000,
  }).entry
  const supplement = saveSnapshot({
    month: '2026-08', entityKey: 'ent_bk', entityLabel: '备份测试', shopKey: 's1', shopLabel: '店1',
    platforms: ['Amazon'], grossCny: 40000, netSalesCny: 38000, feesCny: 2000, payoutCny: 36000, conflictMode: 'append',
  }).entry

  const foreignUuidPrimary = {
    id: 'ee999999-1111-4111-8111-999999999999',
    month: '2026-08', entityKey: 'ent_bk', entityLabel: '备份测试', shopKey: 's1', shopLabel: '店1',
    platforms: ['Amazon'], grossCny: 120000, netSalesCny: 114000, feesCny: 6000, payoutCny: 108000, importMode: 'new',
  }
  const idlessRec = {
    month: '2026-07', entityKey: 'ent_bk', entityLabel: '备份测试', shopKey: 's1', shopLabel: '店1',
    platforms: ['Amazon'], grossCny: 80000, netSalesCny: 76000, feesCny: 4000, payoutCny: 72000,
  }
  const bkSkip = {
    schemaVersion: BACKUP_SCHEMA, recordCount: 2, records: [foreignUuidPrimary, idlessRec],
    checksum: computeBackupChecksum([foreignUuidPrimary, idlessRec]),
  }
  const rSkip = importArchiveBackup(store, bkSkip, { mode: 'merge_skip' })
  assert.equal(rSkip.imported, 1) // 仅 idlessRec 导入
  assert.equal(rSkip.skipped, 1) // foreignUuidPrimary 因 source_key_collision 跳过，绝不翻倍！
  assert.equal(rSkip.conflicts[0].reason, 'source_key_collision')
  // 再次导入无 id 记录必须按确定性指纹幂等跳过！
  const rSkipAgain = importArchiveBackup(store, bkSkip, { mode: 'merge_skip' })
  assert.equal(rSkipAgain.imported, 0)
  assert.equal(rSkipAgain.skipped, 2)

  // merge_overwrite 精确替换非追加主记录，保留同月 append 补单记录不误删；同 ID 同内容保持 revision 不变
  const rOw = importArchiveBackup(store, bkSkip, { mode: 'merge_overwrite' })
  assert.equal(rOw.overwritten, 2)
  assert.equal(rOw.conflicts.find((c) => c.reason === 'id_collision').revisionChanged, false)
  const afterOw = store.load()
  assert.equal(afterOw.filter((x) => x.month === '2026-08').length, 2)
  assert.ok(afterOw.some((x) => x.id === supplement.id && x.grossCny === 40000))
  assert.ok(afterOw.some((x) => x.id === foreignUuidPrimary.id && x.grossCny === 120000))
  assert.equal(afterOw.some((x) => x.id === primary.id), false)

  // 2) [#73 P1-3] legacyId 空白 trim、全局唯一校验与 migrateId 优先查找
  const dupLegacyRecs = [
    { id: 'ff000001-1111-4111-8111-111111111111', legacyId: 'old_1', month: '2026-05', grossCny: 100 },
    { id: 'ff000002-1111-4111-8111-111111111111', legacyId: ' old_1 ', month: '2026-06', grossCny: 200 },
  ]
  assert.throws(() => importArchiveBackup(store, {
    schemaVersion: BACKUP_SCHEMA, recordCount: 2, records: dupLegacyRecs, checksum: computeBackupChecksum(dupLegacyRecs),
  }), { code: 'INVALID_BACKUP_RECORD' })

  clearImaCache()
  const histPath = join(dir, 'fintax_history.json')
  writeFileSync(histPath, JSON.stringify({ entries: [
    { id: 'legacy_prio', month: '2026-04', grossCny: 500 },
    { id: 'ff000009-1111-4111-8111-111111111111', legacyId: 'other_leg', month: '2026-03', grossCny: 300 },
  ] }), 'utf8')
  const prioList = loadHistory()
  assert.equal(findSnapshotById(prioList, '  legacy_prio  ').grossCny, 500)
  assert.equal(deleteSnapshot('  other_leg  ').deleted, true)

  // 3) [#73 P1-4 & #82 P1-6c] Emoji 代理对截断安全 + <br/> 与 //domain.tld 剥离
  const emojiLabelSnap = saveSnapshot({
    month: '2026-02', entityName: '极光' + 'A'.repeat(77) + '🔋X', storeScope: '店' + 'B'.repeat(78) + '🔋Y',
    label: 'C'.repeat(79) + '🔋Z', grossCny: 1000,
  }).entry
  assert.equal(emojiLabelSnap.entityLabel.isWellFormed(), true)
  assert.equal(emojiLabelSnap.shopLabel.isWellFormed(), true)
  assert.equal(emojiLabelSnap.label.isWellFormed(), true)

  // 4) [#73 P0-2 & P1-1 & #82 P0-6/P0-7/P1-6b/d] 跨连接 c-1->c-2->c-3 缓存与归档、跨标签隔离、12 月 HTTP 订单笔数闭环与 Stage3 partial 阻断 ok
  let connSeq = 0
  const dynHandler = createFintaxApiHandler({
    getConnection: () => ({ admit: () => ({ peer: { connectionId: `c-${++connSeq}`, remotePort: 50000 + connSeq } }) }),
  })
  const sessTabA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const sessTabB = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'

  // 混合 Amazon DE 原币 EUR + Temu DE 人民币 + Stage3 partial 在途差额 + 波动非鉴权 Cookie
  const amzDeCsv = [
    '"Includes Amazon DE transactions"',
    '"datum/uhrzeit","abrechnungsnummer","typ","bestellnummer","beschreibung","marketplace","umsätze","verkaufsgebühren","gebühren zu versand durch amazon","andere","gesamt"',
    '"2026-11-05","SET-DE-1","Bestellung","302-1","Item","amazon.de","1500.00","-200.00","-100.00","0.00","1200.00"',
  ].join('\n')
  const llPartialCsv = [
    '交易时间,连连流水号,交易类型,平台来源,收款户名,收款银行账号,主体编号,币种,入账金额,提现金额,手续费,净额,结汇汇率,实收人民币,状态',
    '2026-11-19,LL-IN-P1,平台回款,Amazon,Amazon.de,,ENT-DE,EUR,1200.00,0.00,0.00,1200.00,,,Completed',
    '2026-11-20,LL-WD-P1,结汇提现,Amazon,深圳极光跨境科技有限公司,7559012345108821,ENT-DE,EUR,0.00,1000.00,0.00,-1000.00,7.8000,7800.00,Completed',
    '2026-11-21,LL-WD-P2,结汇提现,Amazon,深圳极光跨境科技有限公司,7559012345108821,ENT-DE,EUR,0.00,200.00,0.00,-200.00,7.8000,1560.00,Completed',
  ].join('\n')
  const bankPartialCsv = [
    '交易日期,记账日期,贷方发生额,借方发生额,币种,手续费,对方户名,本方户名,本方账号,主体编号,摘要,银行回单号,关联流水号',
    '2026-11-20,2026-11-20,7800.00,0.00,CNY,0.00,连连银通,深圳极光跨境科技有限公司,7559012345108821,ENT-DE,连连结汇 LL-WD-P1,CMB-P1,LL-WD-P1',
  ].join('\n')

  const pConn1 = await mockApiCall(dynHandler, 'POST', '/api/fintax/parse', {
    reportFormat: 'data', fxRates: { EUR: 7.8 }, fxConfirmed: true,
    files: [
      { name: 'amz_de.csv', dataBase64: Buffer.from(amzDeCsv).toString('base64') },
      { name: 'LianLian_202611.csv', dataBase64: Buffer.from(llPartialCsv).toString('base64') },
      { name: 'CMB_BankReceipt_202611.csv', dataBase64: Buffer.from(bankPartialCsv).toString('base64') },
    ],
  }, { 'x-fintax-client-session': sessTabA, cookie: 'theme=light; _ga=111' })
  assert.equal(pConn1.statusCode, 200)
  assert.match(pConn1.json.cacheToken, /^[0-9a-f]{32}$/)
  assert.ok(pConn1.json.archiveToken)

  // c-2 连接：Tab B 跨会话盗用失败 (404 / 400)；Tab A 波动 Cookie 仍命中导出缓存！
  const expTabB = await mockApiCall(dynHandler, 'POST', '/api/fintax/parse/export', {
    cacheToken: pConn1.json.cacheToken, format: 'md',
  }, { 'x-fintax-client-session': sessTabB })
  assert.equal(expTabB.statusCode, 404)
  const archTabB = await mockApiCall(dynHandler, 'POST', '/api/fintax/history', {
    month: '2026-11', entityKey: 'ent_aurora_eu', entityLabel: '极光欧洲公司', archiveToken: pConn1.json.archiveToken,
  }, { 'x-fintax-client-session': sessTabB })
  assert.equal(archTabB.statusCode, 400)

  const expTabA = await mockApiCall(dynHandler, 'POST', '/api/fintax/parse/export', {
    cacheToken: pConn1.json.cacheToken, format: 'md',
  }, { 'x-fintax-client-session': sessTabA, cookie: 'theme=dark; _ga=999' })
  assert.equal(expTabA.statusCode, 200)
  assert.equal(expTabA.json.fromCache, true)

  // c-3 连接：Tab A 成功归档，验证 Stage3 partial -> stage3Verified === false & euOrderCount === 1
  const archTabA = await mockApiCall(dynHandler, 'POST', '/api/fintax/history', {
    month: '2026-11', entityKey: 'ent_aurora_eu', entityLabel: '极光欧洲公司', shopKey: 'de_main', shopLabel: 'DE店',
    declaredVatSalesCny: 11700, archiveToken: pConn1.json.archiveToken,
  }, { 'x-fintax-client-session': sessTabA, cookie: 'theme=dark; _ga=999' })
  assert.equal(archTabA.statusCode, 200)
  assert.equal(archTabA.json.entry.euOrderCount, 1)
  assert.equal(archTabA.json.entry.stage3Status, 'partial')
  assert.equal(archTabA.json.entry.stage3Verified, false)
  assert.equal(archTabA.json.entry.stage3UnmatchedCny, 1560)

  // 补齐其余 11 个零收入月后查 /history/annual：因 11 月 Stage3 partial 未全额核销，china810 绝不得返回 ok！
  for (const mm of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '12']) {
    saveSnapshot({
      month: `2026-${mm}`, entityKey: 'ent_aurora_eu', entityLabel: '极光欧洲公司', shopKey: 'de_main', shopLabel: 'DE店',
      platforms: ['Amazon'], sites: ['DE'], currencies: ['EUR'], grossCny: 0, netSalesCny: 0, payoutCny: 0, zeroSalesConfirmed: true,
    })
  }
  const annPartial = await mockApiCall(dynHandler, 'GET', '/api/fintax/history/annual?year=2026&entityKey=ent_aurora_eu')
  assert.equal(annPartial.json.summary.threeJurisdictions.china810.status, 'warn')
  assert.equal(annPartial.json.summary.threeJurisdictions.china810.dataComplete, false)
  assert.equal(annPartial.json.summary.threeJurisdictions.euDac7.status, 'ok') // €1,500 / 1 笔 12 月齐备 -> ok！

  // HTTP 12 个月 Amazon US 账单（每月 $3,000 / 20 笔 Order -> 全年 $36,000 / 240 笔）端到端触发 us1099k danger！
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0')
    const rows = ['"date/time","settlement id","type","order id","marketplace","product sales","selling fees","fba fees","other","total"']
    for (let k = 1; k <= 20; k++) {
      rows.push(`"2026-${mm}-05","S-${mm}","Order","O-${mm}-${k}","amazon.com","150.00","-22.50","0.00","0.00","127.50"`)
    }
    const pUs = await mockApiCall(dynHandler, 'POST', '/api/fintax/parse', {
      reportFormat: 'data', fxRates: { USD: 7.2 }, fxConfirmed: true,
      files: [{ name: `amz_us_${mm}.csv`, dataBase64: Buffer.from(rows.join('\n')).toString('base64') }],
    }, { 'x-fintax-client-session': sessTabA })
    const sUs = await mockApiCall(dynHandler, 'POST', '/api/fintax/history', {
      month: `2026-${mm}`, entityKey: 'ent_us_full12', entityLabel: '美线十二月法人', shopKey: 'us_1', shopLabel: 'US店',
      archiveToken: pUs.json.archiveToken,
    }, { 'x-fintax-client-session': sessTabA })
    assert.equal(sUs.statusCode, 200)
    assert.equal(sUs.json.entry.usTransactionCount, 20)
  }
  const annUs12 = await mockApiCall(dynHandler, 'GET', '/api/fintax/history/annual?year=2026&entityKey=ent_us_full12')
  assert.equal(annUs12.json.summary.threeJurisdictions.us1099k.metrics.usSalesUsd, 36000)
  assert.equal(annUs12.json.summary.threeJurisdictions.us1099k.metrics.usTransactionCount, 240)
  assert.equal(annUs12.json.summary.threeJurisdictions.us1099k.status, 'danger')
})

test('二轮红队 R2-C：HTTP POST /history 409 REVISION_CONFLICT 分流、files 直验重算、同批混合 EUR+CNY 归档与 /ima-quick 剥离 <br/> //domain 及 Emoji 边界', async (t) => {
  useIsolatedDir(t, 'fintax-r2c-')
  const savedEnv = [process.env.IMA_CLIENT_ID, process.env.IMA_API_KEY, process.env.IMA_DEFAULT_KB_ID]
  process.env.IMA_CLIENT_ID = 'r2c-cid'
  process.env.IMA_API_KEY = 'r2c-key'
  process.env.IMA_DEFAULT_KB_ID = 'r2c-kb'
  clearImaCache()
  t.after(() => {
    clearImaCache()
    for (const [i, k] of ['IMA_CLIENT_ID', 'IMA_API_KEY', 'IMA_DEFAULT_KB_ID'].entries()) {
      if (savedEnv[i] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[i]
    }
  })

  const handler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: { sessionId: 'r2c-sess' } }) }) })

  // 1) 同批混合 Amazon DE (EUR) + Temu DE (CNY)，直接走 POST /history (files 重算，免 archiveToken) 归档：CNY 表折算并入 euSalesEur (mixed_estimated)
  const amzDe = [
    '"Includes Amazon DE transactions"',
    '"datum/uhrzeit","abrechnungsnummer","typ","bestellnummer","beschreibung","marketplace","umsätze","verkaufsgebühren","gebühren zu versand durch amazon","andere","gesamt"',
    '"2026-10-05","SET-DE-1","Bestellung","302-99","Item","amazon.de","1500.00","-200.00","-100.00","0.00","1200.00"',
  ].join('\n')
  const ttsDeCny = [
    'statement id,statement date,type,order id,region,currency,gross sales,tiktok shop commission fee,total settlement amount',
    'TTS-DE-1,2026-10-12,Order,TT-DE-1,DE,CNY,7800.00,0.00,7800.00',
  ].join('\n')

  const directSaved = await mockApiCall(handler, 'POST', '/api/fintax/history', {
    month: '2026-10',
    entityKey: 'ent_mix_http',
    entityLabel: '混合币种HTTP主体',
    shopKey: 'de_mix',
    shopLabel: 'DE双平台',
    fxRates: { EUR: 7.8 },
    fxConfirmed: true,
    files: [
      { name: 'amz_de.csv', dataBase64: Buffer.from(amzDe).toString('base64') },
      { name: 'tiktok_de_cny.csv', dataBase64: Buffer.from(ttsDeCny).toString('base64') },
    ],
  })
  assert.equal(directSaved.statusCode, 200)
  assert.equal(directSaved.json.entry.currencySource, 'mixed_estimated')
  assert.equal(directSaved.json.entry.euSalesEur, 2500)
  assert.equal(directSaved.json.entry.euOrderCount, 2)

  // 2) POST /history 409 严格区分 ARCHIVE_CONFLICT (source_key_collision) 与 REVISION_CONFLICT (revision_conflict)
  const check409 = await mockApiCall(handler, 'POST', '/api/fintax/history', {
    month: '2026-10', entityKey: 'ent_mix_http', entityLabel: '混合币种HTTP主体', shopKey: 'de_mix',
    fxRates: { EUR: 7.8 }, fxConfirmed: true, conflictMode: 'check',
    files: [{ name: 'amz_de.csv', dataBase64: Buffer.from(amzDe).toString('base64') }],
  })
  assert.equal(check409.statusCode, 409)
  assert.equal(check409.json.code, 'ARCHIVE_CONFLICT')
  assert.equal(check409.json.conflictType, 'source_key_collision')

  const rev409 = await mockApiCall(handler, 'POST', '/api/fintax/history', {
    month: '2026-10', entityKey: 'ent_mix_http', entityLabel: '混合币种HTTP主体', shopKey: 'de_mix',
    fxRates: { EUR: 7.8 }, fxConfirmed: true, conflictMode: 'replace',
    targetId: directSaved.json.entry.id,
    expectedRevision: '99999999-9999-4999-8999-999999999999',
    files: [{ name: 'amz_de.csv', dataBase64: Buffer.from(amzDe).toString('base64') }],
  })
  assert.equal(rev409.statusCode, 409)
  assert.equal(rev409.json.code, 'REVISION_CONFLICT')
  assert.equal(rev409.json.conflictType, 'revision_conflict')

  // 3) /ima-quick 剥离 <br/>、<img/>、//domain.tld/... 且在 Emoji 边界截断保证 isWellFormed() === true
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(JSON.stringify({
    code: 0,
    data: {
      info_list: [{
        title: `${'标'.repeat(118)}🔋尾部<br/>//cdn.leak.example.com/t`,
        folder_path: '/EU/2026<hr/>//files.leak.example.org/dir',
        highlight_content: `${'摘'.repeat(158)}🔋截断<br/><img src="x"/>//static.leak.example.net/doc.pdf <=€150`,
      }],
    },
  }))))
  const qEmoji = `${'搜'.repeat(199)}🔋词`
  const imaRes = await mockApiCall(handler, 'POST', '/api/fintax/ima-quick', { query: qEmoji })
  assert.equal(imaRes.statusCode, 200)
  assert.equal(imaRes.json.query.isWellFormed(), true)
  const [hit] = imaRes.json.hits
  assert.equal(hit.title.isWellFormed(), true)
  assert.equal(hit.folderPath.isWellFormed(), true)
  assert.equal(hit.snippet.isWellFormed(), true)
  assert.equal(/<br\s*\/?>|<hr\s*\/?>|<img|leak\.example/i.test(JSON.stringify(hit)), false)
  assert.ok(hit.folderPath.includes('/EU/2026'))
})

test('二轮红队复检闭环 #90：冷启动/并发断言零漂移、同平台多站点混其他辖区平台触发 danger、子串 entityKey 与多同名重分配门禁、跨辖区原币+CNY 估算口径、无 savedAt 往返幂等', async (t) => {
  const dir = useIsolatedDir(t, 'fintax-r2-90-')
  const store = createHistoryStore({ dir })

  // 1) [#90 P0] 冷启动 /parse (无断言) -> 携带回写 x-fintax-session-assertion 调 /parse/export 与 /history 100% 命中，并发请求断言确定性一致
  const localHandler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: {} }) }) })
  const clientSess = '9876543210fedcba0123456789abcdef'
  const callWithHeaders = (method, urlPath, bodyObj, headers = {}) => new Promise((resolve, reject) => {
    const raw = bodyObj !== undefined ? JSON.stringify(bodyObj) : ''
    const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : [])
    req.method = method
    req.url = urlPath
    req.headers = { 'content-type': 'application/json', ...headers }
    let statusCode = 0
    let resHeaders = {}
    const chunks = []
    const res = {
      writeHead(code, hdrs) { statusCode = code; resHeaders = hdrs || {} },
      end(data) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'))
        resolve({ statusCode, headers: resHeaders, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      },
    }
    Promise.resolve(localHandler(req, res)).catch(reject)
  })

  // 模拟首屏并发 GET /status 与 GET /history（均未携带断言）
  const [stRes, hiRes] = await Promise.all([
    callWithHeaders('GET', '/api/fintax/status', undefined, { 'x-fintax-client-session': clientSess }),
    callWithHeaders('GET', '/api/fintax/history', undefined, { 'x-fintax-client-session': clientSess }),
  ])
  assert.ok(stRes.headers['x-fintax-session-assertion'])
  assert.equal(stRes.headers['x-fintax-session-assertion'], hiRes.headers['x-fintax-session-assertion'])

  // 模拟冷启动直接调 POST /parse（未携带断言），再携带响应头返回的断言调 /parse/export 与 /history
  const csv = 'Created,ID,Type,Description,Currency,Amount,Fee,Net\n2026-11-05,ch_cold,charge,Sale,CNY,2000,0,2000'
  const coldParse = await callWithHeaders('POST', '/api/fintax/parse', {
    reportFormat: 'data',
    files: [{ name: 'sale.csv', dataBase64: Buffer.from(csv).toString('base64') }],
  }, { 'x-fintax-client-session': clientSess })
  assert.equal(coldParse.statusCode, 200)
  const mintedHdr = coldParse.headers['x-fintax-session-assertion']
  assert.ok(mintedHdr)

  const warmExport = await callWithHeaders('POST', '/api/fintax/parse/export', {
    cacheToken: coldParse.json.cacheToken, format: 'html',
  }, { 'x-fintax-client-session': clientSess, 'x-fintax-session-assertion': mintedHdr })
  assert.equal(warmExport.statusCode, 200)
  assert.equal(warmExport.json.fromCache, true)

  const warmArchive = await callWithHeaders('POST', '/api/fintax/history', {
    month: '2026-11', entityName: '冷启动会话主体', archiveToken: coldParse.json.archiveToken,
  }, { 'x-fintax-client-session': clientSess, 'x-fintax-session-assertion': mintedHdr })
  assert.equal(warmArchive.statusCode, 200)

  // 2) [#90 P1-2] 同月 Amazon DE + Amazon FR + Shopify UK（全年 €2,400 / 36 笔）：必须归属单一平台 Amazon 触发 danger！
  const multiSite12m = Array.from({ length: 12 }, (_, idx) => ({
    id: `90a000${String(idx + 1).padStart(2, '0')}-1111-4111-8111-111111111111`,
    month: `2026-${String(idx + 1).padStart(2, '0')}`,
    entityKey: 'ent_amz_eu_multi', entityLabel: '欧英多站点法人', shopKey: 'eu_uk', shopLabel: 'EU+UK',
    platforms: ['Amazon', 'Shopify'], sites: ['DE', 'FR', 'UK'], currencies: ['EUR', 'GBP'],
    grossCny: 9000, netSalesCny: 8500, feesCny: 1000, payoutCny: 7500,
    platformBreakdown: [
      { platform: 'Amazon', site: 'DE', currency: 'EUR', grossCny: 936, grossOrig: 120, transactionCount: 2 },
      { platform: 'Amazon', site: 'FR', currency: 'EUR', grossCny: 624, grossOrig: 80, transactionCount: 1 },
      { platform: 'Shopify', site: 'UK', currency: 'GBP', grossCny: 7440, grossOrig: 750, transactionCount: 10 },
    ],
  }))
  const msSummary = buildAnnualSummary(multiSite12m, { year: 2026, entityKey: 'ent_amz_eu_multi' })
  assert.equal(msSummary.threeJurisdictions.euDac7.status, 'danger')
  assert.equal(msSummary.threeJurisdictions.euDac7.metrics.exceedsThreshold, true)
  assert.equal(msSummary.threeJurisdictions.euDac7.metrics.platformVerdicts[0].platform, 'Amazon')
  assert.equal(msSummary.threeJurisdictions.euDac7.metrics.platformVerdicts[0].unsplitMultiPlatform, false)

  // 3) [#90 P1-3] 自定义 entityKey 含公司名子串不可绕过 AMBIGUOUS_ENTITY_KEY；多同名主体认领不传 entityKey 必须阻断
  saveSnapshot({
    month: '2026-01', entityName: '深圳跨境科技有限公司', entityKey: '深圳跨境科技有限公司-91440300MA5F',
    storeScope: '店A', grossCny: 50000,
  })
  assert.throws(() => saveSnapshot({
    month: '2026-02', entityName: '深圳跨境科技有限公司', storeScope: '店A', grossCny: 60000,
  }), { code: 'AMBIGUOUS_ENTITY_KEY' })

  saveSnapshot({ month: '2026-01', entityLabel: '同名集团', entityKey: 'uscc-111', storeScope: '店1', grossCny: 10000 })
  saveSnapshot({ month: '2026-01', entityLabel: '同名集团', entityKey: 'uscc-222', storeScope: '店2', grossCny: 20000 })
  const unclSnap = saveSnapshot({ month: '2026-03', entityName: '待认领', storeScope: '店3', grossCny: 30000 }).entry
  assert.throws(() => reassignArchiveEntity(store, unclSnap.id, { entityLabel: '同名集团' }), { code: 'AMBIGUOUS_ENTITY_KEY' })

  // 4) [#90 P1-4] 同月 Amazon US ($1,000 USD 原币) + TikTok DE (¥23,400 CNY -> €3,000 折算)：EU 口径必须标为 estimated_from_cny！
  const amzUs = [
    '"date/time","settlement id","type","order id","marketplace","product sales","selling fees","fba fees","other","total"',
    '"2026-09-05","SET-US-9","Order","114-9","amazon.com","1000.00","-150.00","0.00","0.00","850.00"',
  ].join('\n')
  const ttsDe = [
    'statement id,statement date,type,order id,region,currency,gross sales,tiktok shop commission fee,total settlement amount',
    'TTS-DE-9,2026-09-12,Order,TT-DE-9,DE,CNY,23400.00,0.00,23400.00',
  ].join('\n')
  const crossCurrSaved = await callWithHeaders('POST', '/api/fintax/history', {
    month: '2026-09', entityKey: 'ent_cross_curr', entityLabel: '跨币种法人', shopKey: 'us_de', shopLabel: 'US+DE',
    fxRates: { USD: 7.2, EUR: 7.8 }, fxConfirmed: true,
    files: [
      { name: 'amz_us.csv', dataBase64: Buffer.from(amzUs).toString('base64') },
      { name: 'tts_de.csv', dataBase64: Buffer.from(ttsDe).toString('base64') },
    ],
  }, { 'x-fintax-client-session': clientSess })
  assert.equal(crossCurrSaved.statusCode, 200)
  const crossAnn = buildAnnualSummary(store, { year: 2026, entityKey: 'ent_cross_curr' })
  assert.equal(crossAnn.threeJurisdictions.euDac7.metrics.euSalesBasis, 'estimated_from_cny')
  assert.equal(crossAnn.threeJurisdictions.euDac7.metrics.euEstimatedEur, 3000)
  assert.equal(crossAnn.threeJurisdictions.us1099k.metrics.usSalesBasis, 'recorded_orig')
  assert.equal(crossAnn.threeJurisdictions.us1099k.metrics.usRecordedUsd, 1000)

  // 5) [#90 P2-1] 旧版空 savedAt 记录经 exportArchiveBackup -> importArchiveBackup(merge_overwrite) 往返保持 revisionChanged: false
  const dirLegacy = mkdtempSync(join(tmpdir(), 'fintax-r2-legsav-'))
  t.after(() => rmSync(dirLegacy, { recursive: true, force: true }))
  writeFileSync(join(dirLegacy, 'fintax_history.json'), JSON.stringify({
    entries: [{ id: '90b00001-1111-4111-8111-111111111111', month: '2026-05', grossCny: 8800, netSalesCny: 8800, payoutCny: 8000 }],
  }), 'utf8')
  const legStore = createHistoryStore({ dir: dirLegacy })
  const legBk = exportArchiveBackup(legStore)
  const legImp = importArchiveBackup(legStore, legBk, { mode: 'merge_overwrite' })
  assert.equal(legImp.overwritten, 1)
  assert.equal(legImp.conflicts[0].revisionChanged, false)
})

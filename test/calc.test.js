import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { deflateRawSync } from 'node:zlib'
import {
  crossBorderImport,
  vat,
  calculate,
  annualBonusIit,
  exportRebate,
  cbecAssessedCit,
  exportInvoiceBreakeven,
  platformTaxReconcile,
} from '../lib/calc.js'
import { parseAmount, fmtAmount, parsePlatformStatement } from '../lib/statement.js'
import { imaCall, clearImaCache, loadCredentials, getPublicStatus, loadFintaxSettings, saveFintaxSettings, saveCredentials } from '../lib/ima.js'

test('跨境电商综合税：普通商品 13%×70%=9.1%', () => {
  const r = crossBorderImport({ price: 1000 })
  assert.equal(r.taxPayable, 91)
  assert.equal(r.effectiveRate, '9.10%')
  assert.equal(r.withinLimit, true)
  assert.equal(r.warnings.length, 0)
})

test('跨境电商综合税：消费税商品组成计税价格', () => {
  const r = crossBorderImport({ price: 1000, consumptionTaxRate: 0.15 })
  assert.equal(r.taxBase, 1176.47)
  assert.ok(Math.abs(r.taxPayable - 230.59) <= 0.01, `got ${r.taxPayable}`)
})

test('跨境电商综合税：单次超限预警', () => {
  const r = crossBorderImport({ price: 6000 })
  assert.equal(r.withinLimit, false)
  assert.ok(r.warnings.some((w) => w.includes('单次')))
  assert.ok(r.warnings.some((w) => w.includes('一般贸易')))
})

test('跨境电商综合税：年度累计超限预警', () => {
  const r = crossBorderImport({ price: 3000, annualUsed: 24000 })
  assert.equal(r.withinLimit, false)
  assert.ok(r.warnings.some((w) => w.includes('年度')))
})

test('跨境电商综合税：9% 税率商品', () => {
  const r = crossBorderImport({ price: 1000, vatRate: 0.09 })
  assert.equal(r.taxPayable, 63)
})

test('增值税：含税价分离', () => {
  const r = vat({ amount: 1130, rate: 0.13, inclusive: true })
  assert.equal(r.netAmount, 1000)
  assert.equal(r.taxAmount, 130)
  assert.equal(r.grossAmount, 1130)
})

test('增值税：不含税价计税', () => {
  const r = vat({ amount: 1000, rate: 0.06, inclusive: false })
  assert.equal(r.taxAmount, 60)
  assert.equal(r.grossAmount, 1060)
})

test('非法参数抛错', () => {
  assert.throws(() => crossBorderImport({ price: -1 }))
  assert.throws(() => crossBorderImport({ price: 100, vatRate: 13 }))
  assert.throws(() => vat({ amount: 'abc' }))
  assert.throws(() => calculate('unknown', {}))
})

test('calculate 分发（覆盖全部 7 大场景）', () => {
  assert.equal(calculate('cross_border_import', { price: 100 }).taxPayable, 9.1)
  assert.equal(calculate('vat', { amount: 113 }).taxAmount, 13)
  assert.equal(calculate('annual_bonus_iit', { bonus: 36000 }).taxPayable, 1080)
  assert.equal(calculate('export_rebate', { purchaseAmount: 10000 }).taxRefund, 1300)
  assert.equal(calculate('cbec_assessed_cit', { revenue: 1000000 }).taxPayable, 10000)
  assert.equal(calculate('export_invoice_breakeven', { barePurchaseAmount: 100000, supplierMarkupRate: 0.08 }).breakevenMarkupRate, '13.00%')
  assert.equal(calculate('platform_tax_reconcile', { reportedGrossRevenue: 6000000, refunds: 450000 }).reportedNetRevenue, 5550000)
})

// ── 年终奖个税 ──
test('年终奖：36000 临界点内 3%', () => {
  const r = annualBonusIit({ bonus: 36000 })
  assert.equal(r.taxPayable, 1080)
  assert.equal(r.afterTax, 34920)
  assert.equal(r.trap, null)
})

test('年终奖：36001 多发一元陷阱', () => {
  const r = annualBonusIit({ bonus: 36001 })
  assert.ok(Math.abs(r.taxPayable - 3390.1) < 0.01)
  assert.ok(r.trap, '应检测到陷阱区间')
  assert.equal(r.trap.boundary, 36000)
  assert.ok(Math.abs(r.trap.breakEven - 38566.67) < 0.01)
  assert.ok(r.warnings.some((w) => w.includes('临界点陷阱')))
})

test('年终奖：陷阱区间外不预警（40000 > 38566.67）', () => {
  const r = annualBonusIit({ bonus: 40000 })
  assert.equal(r.trap, null)
  assert.equal(r.taxPayable, 40000 * 0.1 - 210)
})

test('年终奖：144000 档与 45000 示例', () => {
  assert.equal(annualBonusIit({ bonus: 144000 }).taxPayable, 14190)
  assert.equal(annualBonusIit({ bonus: 45000 }).taxPayable, 4290)
})

test('年终奖：高档 45%', () => {
  const r = annualBonusIit({ bonus: 1200000 })
  assert.equal(r.taxPayable, 1200000 * 0.45 - 15160)
})

test('年终奖：非法参数', () => {
  assert.throws(() => annualBonusIit({ bonus: 0 }))
  assert.throws(() => annualBonusIit({ bonus: -5 }))
})

// ── 出口退税与 2026 法规严谨度 ──
test('出口退税：13% 专票全额退，且逾期提示区分 2026年第11号第六条免税与第七条征税', () => {
  const r = exportRebate({ purchaseAmount: 20000, vatRate: 0.13, rebateRate: 0.13 })
  assert.equal(r.taxRefund, 2600)
  assert.equal(r.nonRefundableToCost, 0)
  assert.ok(r.warnings.some((w) => w.includes('第六条') && w.includes('第七条') && w.includes('不得一刀切概括为征税')))
})

test('出口退税：退税率低于征税率，差额转成本', () => {
  const r = exportRebate({ purchaseAmount: 10000, vatRate: 0.13, rebateRate: 0.09 })
  assert.equal(r.taxRefund, 900)
  assert.equal(r.nonRefundableToCost, 400)
})

test('出口退税：小规模专票孰低规则', () => {
  const r = exportRebate({ purchaseAmount: 10000, vatRate: 0.03, rebateRate: 0.13 })
  assert.equal(r.effectiveRebateRate, 0.03)
  assert.equal(r.taxRefund, 300)
})

test('出口退税：退税率缺省=适用税率', () => {
  const r = exportRebate({ purchaseAmount: 10000 })
  assert.equal(r.rebateRate, 0.13)
  assert.equal(r.taxRefund, 1300)
  assert.ok(r.policyRefs.some((p) => p.ref.includes('2026年第11号')))
})

test('出口退税：非法参数', () => {
  assert.throws(() => exportRebate({ purchaseAmount: -1 }))
  assert.throws(() => exportRebate({ purchaseAmount: 100, rebateRate: 13 }))
})

// ── 综试区核定征收 ──
test('核定征收：4% × 25%', () => {
  const r = cbecAssessedCit({ revenue: 5000000 })
  assert.equal(r.taxableIncome, 200000)
  assert.equal(r.taxPayable, 50000)
  assert.equal(r.effectiveRateOnRevenue, '1.00%')
})

test('核定征收：小微叠加实际 5%', () => {
  const r = cbecAssessedCit({ revenue: 5000000, smallLowProfit: true })
  assert.equal(r.citRateApplied, 0.05)
  assert.equal(r.taxPayable, 10000)
})

test('核定征收：超 300 万不享受小微', () => {
  const r = cbecAssessedCit({ revenue: 80000000, smallLowProfit: true })
  assert.equal(r.taxableIncome, 3200000)
  assert.equal(r.citRateApplied, 0.25)
  assert.equal(r.taxPayable, 800000)
  assert.ok(r.warnings.some((w) => w.includes('超过300万')))
})

test('核定征收：9810 口径预警恒在', () => {
  const r = cbecAssessedCit({ revenue: 100 })
  assert.ok(r.warnings.some((w) => w.includes('9810')))
})

// ── 新增场景 6：供应商开票加点毛利临界测算 ──
test('开票加点临界测算：13%全额退税品加点 8% 拿票退税比裸采净省 4.42 万，且联动企业所得税', () => {
  const r = exportInvoiceBreakeven({
    barePurchaseAmount: 1000000,
    supplierMarkupRate: 0.08,
    vatRate: 0.13,
    rebateRate: 0.13,
    exportRevenue: 1500000,
  })
  assert.equal(r.breakevenMarkupRate, '13.00%')
  assert.equal(r.invoicedGrossOutflow, 1080000)
  // 1080000 / 1.13 = 955752.21, 退税 = 124247.79, 净成本 = 955752.21, 比 100万裸采省 44247.79
  assert.ok(Math.abs(r.cashSavingWithInvoice - 44247.79) <= 0.02, `got ${r.cashSavingWithInvoice}`)
  assert.ok(r.citComparison)
  assert.ok(r.citComparison.afterTaxAdvantageOfInvoice > 20000)
})

test('开票加点临界测算：9%退税品临界点 8.65%，加点 10% 时提示高于增值税临界点', () => {
  const r = exportInvoiceBreakeven({
    barePurchaseAmount: 500000,
    supplierMarkupRate: 0.1,
    vatRate: 0.13,
    rebateRate: 0.09,
  })
  assert.equal(r.breakevenMarkupRate, '8.65%')
  assert.ok(r.cashSavingWithInvoice < 0)
  assert.ok(r.nonRefundableVatToCost > 0)
})

// ── 新增场景 7：平台涉税报送四层口径差额桥接核对 ──
test('平台报送桥接：对齐 IMA 底稿示例（72万报送 vs 52.92万实际放款，放款差额精确轧平为 0）', () => {
  const r = platformTaxReconcile({
    reportedGrossRevenue: 720000,
    refunds: 36000,
    subsidies: 7200,
    platformFees: 147600,
    reserveChange: 14400,
    actualPayout: 529200,
  })
  assert.equal(r.reportedNetRevenue, 684000)
  assert.ok(r.payoutReconciliation)
  assert.equal(r.payoutReconciliation.theoreticalPayout, 529200)
  assert.equal(r.payoutReconciliation.unexplainedCashGap, 0)
})

test('平台报送桥接：600万报送 vs 420万申报（精准剥离120万口径差，并自动识别60万回款净额漏报雷区）', () => {
  const r = platformTaxReconcile({
    reportedGrossRevenue: 6000000,
    refunds: 450000,
    marketplaceWithheldTax: 350000,
    cutoffAndFxDiff: 400000,
    platformFees: 600000,
    declaredVatSales: 4200000,
  })
  assert.equal(r.legitimateBridgeAdjustments, 1200000)
  assert.equal(r.referenceGrossSales, 4800000)
  assert.ok(r.declarationDiagnosis)
  assert.equal(r.declarationDiagnosis.rawReportingDiff, 1800000)
  assert.equal(r.declarationDiagnosis.unexplainedSalesGap, 600000)
  assert.equal(r.declarationDiagnosis.nettingTrapDetected, true)
  assert.ok(r.warnings.some((w) => w.includes('回款净额报税')))
})

// ── 边界防御与全链路集成测试 ──
test('边界防御：必填参数传入 null / 空字符串 / 布尔值必须抛错（不得静默当 0）', () => {
  for (const bad of [null, undefined, '', '   ', false, true, {}, []]) {
    assert.throws(() => crossBorderImport({ price: bad }))
    assert.throws(() => vat({ amount: bad }))
    assert.throws(() => annualBonusIit({ bonus: bad }))
    assert.throws(() => exportRebate({ purchaseAmount: bad }))
    assert.throws(() => cbecAssessedCit({ revenue: bad }))
    assert.throws(() => exportInvoiceBreakeven({ barePurchaseAmount: bad, supplierMarkupRate: 0.08 }))
    assert.throws(() => platformTaxReconcile({ reportedGrossRevenue: bad }))
  }
})

test('边界防御：可选参数传入 null 或空字符串时回退到默认值（不得静默变 0）', () => {
  const r1 = crossBorderImport({ price: 1000, vatRate: '', discount: null })
  assert.equal(r1.taxPayable, 91)

  const r2 = exportRebate({ purchaseAmount: 10000, vatRate: '', rebateRate: '' })
  assert.equal(r2.rebateRate, 0.13)
  assert.equal(r2.taxRefund, 1300)

  const r3 = cbecAssessedCit({ revenue: 1000000, taxableIncomeRate: '', citRate: null })
  assert.equal(r3.taxPayable, 10000)
})

test('边界防御：consumptionTaxRate >= 1 抛错防止除零 Infinity', () => {
  assert.throws(() => crossBorderImport({ price: 1000, consumptionTaxRate: 1 }))
  assert.throws(() => crossBorderImport({ price: 1000, consumptionTaxRate: 1.2 }))
})

test('合规自查技能回归：已移除废止的“对外贸易经营者备案”正项核查要求', () => {
  const md = readFileSync(new URL('../skills/fintax-crossborder-check/SKILL.md', import.meta.url), 'utf8')
  assert.ok(md.includes('全国取消'), '应明确提示原对外贸易经营者备案已取消')
  assert.ok(!md.includes('出口业务：对外贸易经营者备案'), '不得再把已取消备案列为出口必备项')
})

test('工具层与图形化设置接口集成：准入防线、密钥脱敏、默认知识库绑定与 client.js 挂载', async () => {
  const tmpCfg = mkdtempSync(join(tmpdir(), 'fintax-test-'))
  const prevDir = process.env.FINTAX_CONFIG_DIR
  const prevCid = process.env.IMA_CLIENT_ID
  const prevKey = process.env.IMA_API_KEY
  const prevDefKb = process.env.IMA_DEFAULT_KB_ID
  process.env.FINTAX_CONFIG_DIR = tmpCfg
  delete process.env.IMA_CLIENT_ID
  delete process.env.IMA_API_KEY
  delete process.env.IMA_DEFAULT_KB_ID

  try {
    const { apply, createFintaxApiHandler } = await import('../index.js')
    const tools = {}
    const skills = {}
    let mountedRoute = null
    apply({
      tools: { register: (t) => { tools[t.name] = t } },
      skills: { register: (s) => { skills[s.name] = s } },
      inject: (_deps, cb) => {
        cb({
          webServer: { register: (r) => { mountedRoute = r; return () => {} } },
          get: () => ({ admit: () => ({}) }),
          effect: (fn) => fn(),
        })
      },
    })

    assert.ok(mountedRoute && mountedRoute.path === '/api/fintax', '应向 webServer 注册 /api/fintax 路由')
    assert.deepEqual(
      Object.keys(tools).sort(),
      ['fintax_calc', 'fintax_parse_statement', 'ima_browse', 'ima_list_kbs', 'ima_read', 'ima_search'],
    )
    assert.deepEqual(Object.keys(skills).sort(), ['fintax-calc', 'fintax-crossborder-check', 'fintax-mode-select', 'fintax-policy-qa'])

    // 未绑定默认库时，ima_browse 空参应返回可读错误提示
    assert.ok((await tools.ima_browse.execute({ knowledge_base_id: '   ' })).includes('[错误]'))

    // helper 调用 createFintaxApiHandler
    async function invokeApi(handler, method, urlPath, bodyObj) {
      const raw = bodyObj ? JSON.stringify(bodyObj) : ''
      const req = Readable.from(raw ? [Buffer.from(raw)] : [])
      req.method = method
      req.url = urlPath
      let statusCode = 0
      let out = ''
      const res = {
        writeHead(s) { statusCode = s },
        end(b) { out = b || '' },
      }
      await handler(req, res)
      return { status: statusCode, json: out ? JSON.parse(out) : {} }
    }

    // 1) 无 connection 服务时必须 503 fail-closed
    const unauthHandler = createFintaxApiHandler({ getConnection: () => undefined })
    const r503 = await invokeApi(unauthHandler, 'GET', '/api/fintax/status')
    assert.equal(r503.status, 503)

    // 2) connection 拒绝 401 时必须原样拦截
    const rejectHandler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ rejection: 401 }) }) })
    const r401 = await invokeApi(rejectHandler, 'GET', '/api/fintax/status')
    assert.equal(r401.status, 401)

    // 3) 正常已授权会话：保存凭证与默认库，且绝不回传明文密钥
    const okHandler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({}) }) })
    const saveRes = await invokeApi(okHandler, 'POST', '/api/fintax/credentials', {
      clientId: 'cid_secret_123',
      apiKey: 'key_secret_456',
    })
    assert.equal(saveRes.status, 200)
    assert.equal(saveRes.json.configured, true)
    assert.equal(saveRes.json.clientIdSet, true)
    assert.equal(saveRes.json.apiKeySet, true)
    assert.equal(JSON.stringify(saveRes.json).includes('cid_secret_123'), false, '绝不可回传 clientId 明文')
    assert.equal(JSON.stringify(saveRes.json).includes('key_secret_456'), false, '绝不可回传 apiKey 明文')

    const kbRes = await invokeApi(okHandler, 'POST', '/api/fintax/settings', {
      defaultKbId: 'ima_kb_qTKZid0k',
      defaultKbName: '跨境电商财税合规',
    })
    assert.equal(kbRes.status, 200)
    assert.equal(kbRes.json.defaultKbId, 'ima_kb_qTKZid0k')

    // 清除凭证后再调 ima_search（不传 knowledge_base_id）应已自动采用默认库并走到 CREDENTIALS_HELP，而非报缺 knowledge_base_id！
    await invokeApi(okHandler, 'DELETE', '/api/fintax/credentials')
    const searchNoCreds = await tools.ima_search.execute({ query: '报送' })
    assert.ok(searchNoCreds.includes('设置 → 财税工作台'), '绑定默认库后省略 knowledge_base_id 应通过参数校验并给出图形化配置提示')

    // 4) 验证新算税工具在 fintax_calc 工具层的格式化输出
    const outRecon = await tools.fintax_calc.execute({
      scenario: 'platform_tax_reconcile',
      params: {
        reportedGrossRevenue: 6000000,
        refunds: 450000,
        marketplaceWithheldTax: 350000,
        cutoffAndFxDiff: 400000,
        platformFees: 600000,
        declaredVatSales: 4200000,
      },
    })
    assert.ok(outRecon.includes('回款净额报税') && outRecon.includes('4800000'))

    // 5) 验证浏览器半身 client.js 能正常通过 ModuleLoader 加载并注册 settings.section
    let loadedModule = null
    globalThis.window = {
      __ModuleLoader__: {
        load(def) { loadedModule = def },
      },
    }
    await import('../client.js')
    assert.equal(loadedModule?.id, 'dsh-fintax')
    const fakeReact = {
      createElement: (tag, props, ...children) => ({ tag, props, children }),
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
    }
    const clientPlugin = loadedModule.factory((mod) => {
      assert.equal(mod, 'react')
      return fakeReact
    })
    let registeredSlot = null
    clientPlugin.apply({
      locale: {
        bind: () => (k) => k,
        register: () => () => {},
        getLocale: () => ({ active: 'zh-CN' }),
      },
      effect: (fn) => fn(),
      slots: {
        inject: (_slot, fn) => fn(),
        register: (meta, renderFn) => { registeredSlot = { meta, renderFn } },
      },
    })
    assert.equal(registeredSlot?.meta?.name, 'settings.section')
    assert.equal(registeredSlot?.meta?.id, 'fintax')
  } finally {
    delete globalThis.window
    if (prevDir === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = prevDir
    if (prevCid !== undefined) process.env.IMA_CLIENT_ID = prevCid
    if (prevKey !== undefined) process.env.IMA_API_KEY = prevKey
    if (prevDefKb !== undefined) process.env.IMA_DEFAULT_KB_ID = prevDefKb
    rmSync(tmpCfg, { recursive: true, force: true })
  }
})

// ── v0.4.0 原始结算账单离线解析与异常雷达测试 ────────────────────
/** 构造最小标准 ZIP/XLSX Buffer 用于零依赖测试多表 XLSX 解析 */
function buildTestXlsx(namedXmlEntries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const [name, xmlStr] of Object.entries(namedXmlEntries)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const rawData = Buffer.from(xmlStr, 'utf8')
    const compData = deflateRawSync(rawData)

    const localHdr = Buffer.alloc(30)
    localHdr.writeUInt32LE(0x04034b50, 0)
    localHdr.writeUInt16LE(20, 4)
    localHdr.writeUInt16LE(8, 8) // deflate
    localHdr.writeUInt32LE(compData.length, 18)
    localHdr.writeUInt32LE(rawData.length, 22)
    localHdr.writeUInt16LE(nameBuf.length, 26)

    const cdHdr = Buffer.alloc(46)
    cdHdr.writeUInt32LE(0x02014b50, 0)
    cdHdr.writeUInt16LE(20, 4)
    cdHdr.writeUInt16LE(20, 6)
    cdHdr.writeUInt16LE(8, 10)
    cdHdr.writeUInt32LE(compData.length, 20)
    cdHdr.writeUInt32LE(rawData.length, 24)
    cdHdr.writeUInt16LE(nameBuf.length, 28)
    cdHdr.writeUInt32LE(offset, 42)

    localParts.push(localHdr, nameBuf, compData)
    centralParts.push(cdHdr, nameBuf)
    offset += 30 + nameBuf.length + compData.length
  }

  const cdBuf = Buffer.concat(centralParts)
  const count = Object.keys(namedXmlEntries).length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, cdBuf, eocd])
}

test('BigInt 金额解析精度：兼容美式、欧式千分位、括号负数且零浮点误差', () => {
  assert.equal(fmtAmount(parseAmount('$1,234.56')), '1234.56')
  assert.equal(fmtAmount(parseAmount('($45.20)')), '-45.20')
  assert.equal(fmtAmount(parseAmount('-1.234,56 €')), '-1234.56')
  assert.equal(fmtAmount(parseAmount('0.1') + parseAmount('0.2')), '0.30')
})

test('Amazon Date Range CSV：跳过前置说明头、剥离商城代扣税、水平守恒与篡改行 P0 阻断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-dr-'))
  try {
    const csvLines = [
      '"Includes Amazon Marketplace, Fulfillment by Amazon (FBA), and Amazon Webstore transactions"',
      '"All amounts in USD, unless specified"',
      '"Definitions:"',
      '"Sales tax collected: Includes sales tax collected from buyers"',
      '""',
      '"date/time","settlement id","type","order id","sku","description","marketplace","product sales","product sales tax","shipping credits","shipping credits tax","gift wrap credits","giftwrap credits tax","promotional rebates","promotional rebates tax","marketplace withheld tax","selling fees","fba fees","other transaction fees","other","total"',
      // 正常订单：商品 100 + 运费 10 - 促销 5 + 买方税 8 - 代扣税 8 - 佣金 15 - FBA 20 = 70.00
      '"Oct 5, 2026","S1","Order","111-001","SKU1","Widget","amazon.com","100.00","8.00","10.00","0.00","0.00","0.00","-5.00","0.00","-8.00","-15.00","-20.00","0.00","0.00","70.00"',
      // 退款行：退商品 -50 + 退佣金 6 = -44.00
      '"Oct 8, 2026","S1","Refund","111-002","SKU1","Refund","amazon.com","-50.00","0.00","0.00","0.00","0.00","0.00","0.00","0.00","0.00","6.00","0.00","0.00","0.00","-44.00"',
      // 广告扣费：-12.00
      '"Oct 10, 2026","S1","Service Fee","AD-01","","Cost of Advertising","amazon.com","0","0","0","0","0","0","0","0","0","0","0","-12.00","0","-12.00"',
      // 准备金新增冻结：-4.00 -> Q = +4.00
      '"Oct 15, 2026","S1","Reserve","RES-1","","Account Level Reserve","amazon.com","0","0","0","0","0","0","0","0","0","0","0","0","-4.00","-4.00"',
      // 银行打款 Transfer：-10.00 -> R = 10.00（70 - 44 - 12 - 4 = 10.00 完全轧平！）
      '"Oct 20, 2026","S1","Transfer","TR-1","","To Ending Balance","amazon.com","0","0","0","0","0","0","0","0","0","0","0","0","-10.00","-10.00"',
    ]
    const p = join(dir, 'Amazon_US_Oct.csv')
    writeFileSync(p, csvLines.join('\n'), 'utf8')

    const [s] = parsePlatformStatement(p)
    assert.equal(s.platform, 'Amazon')
    assert.equal(s.currency, 'USD')
    assert.equal(s.period, '2026-10')
    assert.equal(fmtAmount(s.grossSales), '110.00')
    assert.equal(fmtAmount(s.sellerDiscount), '5.00')
    assert.equal(fmtAmount(s.taxReportingGrossRef), '105.00')
    assert.equal(fmtAmount(s.customerRefund), '50.00')
    assert.equal(fmtAmount(s.facilitatorTaxStripped), '8.00')
    assert.equal(fmtAmount(s.platformCommission), '9.00')
    assert.equal(fmtAmount(s.logisticsWarehousing), '20.00')
    assert.equal(fmtAmount(s.inPlatformAds), '12.00')
    assert.equal(fmtAmount(s.reserveNetChange), '4.00')
    assert.equal(fmtAmount(s.theoreticalPayout), '10.00')
    assert.equal(fmtAmount(s.actualPayout), '10.00')
    assert.equal(fmtAmount(s.statementPayoutDiff), '0.00')
    assert.equal(fmtAmount(s.horizontalDiffTotal), '0.00')

    // 注入一行篡改数据测试 P0 水平不守恒阻断
    const badFile = join(dir, 'Amazon_Tampered.csv')
    writeFileSync(
      badFile,
      [...csvLines, '"Oct 21, 2026","S1","Order","BAD-999","SKU1","Tampered","amazon.com","100.00","0","0","0","0","0","0","0","0","-10.00","0","0","0","999.00"'].join('\n'),
      'utf8',
    )
    const [badS] = parsePlatformStatement(badFile)
    assert.ok(badS.anomalies.some((a) => a.severity.startsWith('P0') && a.refId === 'BAD-999'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TikTok Shop 多工作表 XLSX 零依赖解析：还原平台补贴、达人佣金并拦截全托管混表 P0 异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tts-xlsx-'))
  try {
    const xlsxBuf = buildTestXlsx({
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        '<sheet name="Order details" sheetId="1" r:id="rId1"/>' +
        '<sheet name="Statements" sheetId="2" r:id="rId2"/>' +
        '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships>' +
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
        '</Relationships>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1">' +
        '<c r="A1" t="inlineStr"><is><t>Statement date</t></is></c>' +
        '<c r="B1" t="inlineStr"><is><t>Type</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t>Order ID</t></is></c>' +
        '<c r="D1" t="inlineStr"><is><t>Shop mode</t></is></c>' +
        '<c r="E1" t="inlineStr"><is><t>Currency</t></is></c>' +
        '<c r="F1" t="inlineStr"><is><t>Gross sales</t></is></c>' +
        '<c r="G1" t="inlineStr"><is><t>Seller discount</t></is></c>' +
        '<c r="H1" t="inlineStr"><is><t>Platform discount</t></is></c>' +
        '<c r="I1" t="inlineStr"><is><t>Commission fee</t></is></c>' +
        '<c r="J1" t="inlineStr"><is><t>Affiliate commission</t></is></c>' +
        '<c r="K1" t="inlineStr"><is><t>Total settlement amount</t></is></c>' +
        '</row>' +
        // POP 订单：200 - 商家折扣 20 + 平台补贴 15 - 佣金 10 - 达人佣金 25 = 160.00
        '<row r="2">' +
        '<c r="A2" t="inlineStr"><is><t>2026-10-12</t></is></c>' +
        '<c r="B2" t="inlineStr"><is><t>Order</t></is></c>' +
        '<c r="C2" t="inlineStr"><is><t>TT-001</t></is></c>' +
        '<c r="D2" t="inlineStr"><is><t>POP</t></is></c>' +
        '<c r="E2" t="inlineStr"><is><t>USD</t></is></c>' +
        '<c r="F2"><v>200</v></c>' +
        '<c r="G2"><v>-20</v></c>' +
        '<c r="H2"><v>15</v></c>' +
        '<c r="I2"><v>-10</v></c>' +
        '<c r="J2"><v>-25</v></c>' +
        '<c r="K2"><v>160</v></c>' +
        '</row>' +
        // 混入一笔全托管记录 -> 必须触发 P0 阻断！
        '<row r="3">' +
        '<c r="A3" t="inlineStr"><is><t>2026-10-13</t></is></c>' +
        '<c r="B3" t="inlineStr"><is><t>Order</t></is></c>' +
        '<c r="C3" t="inlineStr"><is><t>TT-FM-99</t></is></c>' +
        '<c r="D3" t="inlineStr"><is><t>全托管</t></is></c>' +
        '<c r="E3" t="inlineStr"><is><t>USD</t></is></c>' +
        '<c r="F3"><v>50</v></c>' +
        '<c r="G3"><v>0</v></c>' +
        '<c r="H3"><v>0</v></c>' +
        '<c r="I3"><v>0</v></c>' +
        '<c r="J3"><v>0</v></c>' +
        '<c r="K3"><v>50</v></c>' +
        '</row>' +
        '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml':
        '<worksheet><sheetData>' +
        '<row r="1">' +
        '<c r="A1" t="inlineStr"><is><t>Statement ID</t></is></c>' +
        '<c r="B1" t="inlineStr"><is><t>Reserve held</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t>Reserve released</t></is></c>' +
        '<c r="D1" t="inlineStr"><is><t>Payout amount</t></is></c>' +
        '</row>' +
        '<row r="2">' +
        '<c r="A2" t="inlineStr"><is><t>ST-100</t></is></c>' +
        '<c r="B2"><v>10</v></c>' +
        '<c r="C2"><v>0</v></c>' +
        '<c r="D2"><v>200</v></c>' +
        '</row>' +
        '</sheetData></worksheet>',
    })

    const xlsxPath = join(dir, 'TikTok_US_202610.xlsx')
    writeFileSync(xlsxPath, xlsxBuf)

    const [s] = parsePlatformStatement(xlsxPath)
    assert.equal(s.platform, 'TikTok Shop')
    assert.equal(fmtAmount(s.grossSales), '250.00')
    assert.equal(fmtAmount(s.sellerDiscount), '20.00')
    assert.equal(fmtAmount(s.platformSubsidy), '15.00')
    assert.equal(fmtAmount(s.affiliateCommission), '25.00')
    assert.equal(fmtAmount(s.reserveNetChange), '10.00')
    assert.equal(fmtAmount(s.actualPayout), '200.00')
    assert.equal(fmtAmount(s.statementPayoutDiff), '0.00')
    assert.ok(s.anomalies.some((a) => a.severity.startsWith('P0') && a.category.includes('全托管')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Stripe 独立站 CSV + 工具端到端调用：过滤未捕获废单、拦截坐支广告费、分离拒付争议费且不泄露内部母表列名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-csv-'))
  try {
    const csv = [
      'id,type,created,currency,amount,fee,net,status,captured,description,tax_collected',
      // 正常成交 1000（含待自申报 VAT 50），手续费 30，净额 970 -> 商品销售额 950
      'txn_1,charge,2026-10-03,USD,1000.00,30.00,970.00,succeeded,true,Order #101,50.00',
      // 未捕获预授权废单 -> 自动剔除不入收入
      'txn_2,charge,2026-10-04,USD,300.00,0.00,300.00,uncaptured,false,Auth only,0.00',
      // 虚拟卡直付海外广告费 -120 -> 触发 P1 防坐支预警
      'iss_3,issuing_transaction,2026-10-06,USD,-120.00,0.00,-120.00,succeeded,true,Meta Ads Spend,0.00',
      // 拒付争议：本金 -100，不可退争议费 15，净额 -115
      'du_4,dispute,2026-10-08,USD,-100.00,15.00,-115.00,lost,true,Chargeback lost,0.00',
      // 提现 Payout：970 - 120 - 115 = 735.00
      'po_5,payout,2026-10-15,USD,-735.00,0.00,-735.00,paid,true,Stripe Payout,0.00',
    ].join('\n')
    const p = join(dir, 'Stripe_Oct.csv')
    writeFileSync(p, csv, 'utf8')

    const { apply } = await import('../index.js')
    const tools = {}
    apply({
      tools: { register: (t) => { tools[t.name] = t } },
      skills: { register: () => {} },
    })

    const report = await tools.fintax_parse_statement.execute({
      file_path: p,
      fx_rate_to_cny: 7.0,
      declared_vat_sales_cny: 5000,
    })

    assert.ok(report.includes('950.00'), '应准确剥离 50 USD 待自申报税后得出 950.00 商品原价')
    assert.ok(report.includes('防坐支预警'), '应触发虚拟卡直付广告防坐支预警')
    assert.ok(report.includes('Chargeback/Dispute'), '应识别拒付争议并分离争议费')
    assert.ok(report.includes('300.00 USD'), '应统计已过滤未捕获废单金额')
    assert.ok(report.includes('账单内放款差额：0.00 USD'), '理论放款与实际 Payout 应精确轧平为 0.00')
    assert.equal(report.includes('未轧平'), false, '独立站待自申报流转税联动四层桥接时应精确轧平为 0，不得误报资金链未轧平')
    // 验证商业护城河红线：不得暴露内部母表坐标或记账凭证字样
    assert.equal(report.includes('02表'), false, '开源报告不得暴露私域母表列坐标')
    assert.equal(report.includes('记-01'), false, '开源报告不得暴露私域会计分录模板')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.4.1 回归：platformTaxReconcile 计入待自申报流转税 + Stripe 失败提现与退款税额符号 + XLSX 注音标签剔除', async () => {
  // 1) platformTaxReconcile 直接传 selfRemitTaxNet 精确轧平
  const rec = platformTaxReconcile({
    reportedGrossRevenue: 135280,
    refunds: 3560,
    platformFees: 24314.8,
    selfRemitTaxNet: 7120,
    actualPayout: 114525.2,
  })
  assert.equal(rec.payoutReconciliation.theoreticalPayout, 114525.2)
  assert.equal(rec.payoutReconciliation.unexplainedCashGap, 0)
  assert.equal(rec.warnings.some((w) => w.includes('未轧平')), false)

  // 2) /api/fintax/status 返回 version 与 package.json 一致
  const { apply, createFintaxApiHandler } = await import('../index.js')
  const pkgVer = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  const okHandler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({}) }) })
  const req = Readable.from([])
  req.method = 'GET'
  req.url = '/api/fintax/status'
  let statusBody = ''
  await okHandler(req, { writeHead() {}, end(b) { statusBody = b } })
  assert.equal(JSON.parse(statusBody).version, pkgVer)

  const dir = mkdtempSync(join(tmpdir(), 'v041-edge-'))
  try {
    // 3) Stripe: 失败提现不计入未捕获废单；paid payout 带 captured=false 不被误过滤；退款行正数税额自动转负冲减
    const stripeCsv = [
      'id,type,created,currency,amount,fee,net,status,captured,description,tax_collected',
      'ch_1,charge,2026-10-02,USD,1050.00,30.00,1020.00,succeeded,true,Order #1,50.00',
      're_2,refund,2026-10-05,USD,-210.00,0.00,-210.00,succeeded,true,Refund #1,10.00',
      'po_fail,payout,2026-10-10,USD,-500.00,0.00,-500.00,failed,false,Bank reject,0.00',
      'po_ok,payout,2026-10-15,USD,-810.00,0.00,-810.00,paid,false,Payout succeeded,0.00',
    ].join('\n')
    const sp = join(dir, 'stripe_edge.csv')
    writeFileSync(sp, stripeCsv, 'utf8')
    const [ss] = parsePlatformStatement(sp, 'stripe')
    assert.equal(fmtAmount(ss.grossSales), '1000.00')
    assert.equal(fmtAmount(ss.customerRefund), '200.00')
    assert.equal(fmtAmount(ss.selfRemitTaxNet), '40.00')
    assert.equal(fmtAmount(ss.actualPayout), '810.00')
    assert.equal(fmtAmount(ss.statementPayoutDiff), '0.00')
    assert.equal(fmtAmount(ss.uncapturedVoidExcluded), '0.00')
    assert.ok(ss.anomalies.some((a) => a.category.includes('提现/打款失败') && a.refId === 'po_fail'))

    // 4) XLSX sharedStrings 含 <rPh> 注音引导标签时不污染单元格文本
    const xlsxBuf = buildTestXlsx({
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        '<sheet name="Order details" sheetId="1" r:id="rId1"/>' +
        '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml':
        '<?xml version="1.0"?><sst>' +
        '<si><t>Type</t></si>' +
        '<si><t>Order ID</t></si>' +
        '<si><t>Currency</t></si>' +
        '<si><t>Gross sales</t><rPh sb="0" eb="5"><t>GROSS</t></rPh></si>' +
        '<si><t>Total settlement amount</t></si>' +
        '<si><t>Order</t></si>' +
        '<si><t>TT-RPH-1</t><rPh sb="0" eb="2"><t>RUBY</t></rPh></si>' +
        '<si><t>USD</t></si>' +
        '</sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2" t="s"><v>7</v></c><c r="D2"><v>100</v></c><c r="E2"><v>100</v></c></row>' +
        '</sheetData></worksheet>',
    })
    const xp = join(dir, 'tts_rph.xlsx')
    writeFileSync(xp, xlsxBuf)
    const [ts] = parsePlatformStatement(xp, 'tiktok')
    assert.equal(ts.platform, 'TikTok Shop')
    assert.equal(fmtAmount(ts.grossSales), '100.00')
    assert.equal(fmtAmount(ts.horizontalDiffTotal), '0.00')
    assert.ok(apply)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.4.2 回归：科学计数法、Amazon V2 AU/DD-MM-YYYY/佣金税分离、TikTok 长别名匹配与 Stripe payout_cancel', async () => {
  // 1) parseAmount 科学计数法
  assert.equal(fmtAmount(parseAmount('1.5e2')), '150.00')
  assert.equal(fmtAmount(parseAmount('1.5E+3')), '1500.00')
  assert.equal(fmtAmount(parseAmount('0E-8')), '0.00')
  assert.equal(fmtAmount(parseAmount('-2.5e1')), '-25.00')
  assert.equal(fmtAmount(parseAmount('1.5e2 EUR')), '150.00')
  assert.equal(fmtAmount(parseAmount('(1.5E-2)')), '-0.02')

  // 2) 跨期调增（负数）不再输出“调减 -xxx 元”；超 7500 万营收恒提示小微红线
  const incRec = platformTaxReconcile({ reportedGrossRevenue: 100000, cutoffAndFxDiff: -5000 })
  assert.equal(incRec.referenceGrossSales, 105000)
  assert.ok(incRec.steps[1].includes('调增合计 5000 元') && !incRec.steps[1].includes('调减合计 -5000'))
  assert.ok(incRec.summaryLine.includes('已叠加口径/时点调增 5000 元'))
  assert.ok(cbecAssessedCit({ revenue: 80000000 }).warnings.some((w) => w.includes('300万元')))

  const dir = mkdtempSync(join(tmpdir(), 'v042-stmt-'))
  try {
    // 3) Amazon Flat File V2（AU 站 + DD/MM/YYYY + ItemFees ServiceFeeTax 不误计入买家税）
    const amzV2Tsv = [
      'settlement-id\tsettlement-end-date\ttotal-amount\ttransaction-type\torder-id\tmarketplace-name\tamount-type\tamount-description\tamount\tposted-date',
      'STL-AU-1\t15/10/2026\t167.00\t\t\t\t\t\t\t',
      'STL-AU-1\t\t\tOrder\tAU-1001\tAmazon.com.au\tItemPrice\tPrincipal\t200.00\t15/10/2026',
      'STL-AU-1\t\t\tOrder\tAU-1001\tAmazon.com.au\tItemPrice\tTax\t20.00\t15/10/2026',
      'STL-AU-1\t\t\tOrder\tAU-1001\tAmazon.com.au\tItemWithheldTax\tMarketplaceFacilitatorTax-Principal\t-20.00\t15/10/2026',
      'STL-AU-1\t\t\tOrder\tAU-1001\tAmazon.com.au\tItemFees\tCommission\t-30.00\t15/10/2026',
      'STL-AU-1\t\t\tOrder\tAU-1001\tAmazon.com.au\tItemFees\tServiceFeeTax\t-3.00\t15/10/2026',
    ].join('\n')
    const av2Path = join(dir, 'amz_au_v2.txt')
    writeFileSync(av2Path, amzV2Tsv, 'utf8')
    const [as] = parsePlatformStatement(av2Path, 'amazon')
    assert.equal(as.site, 'AU')
    assert.equal(as.currency, 'AUD')
    assert.equal(as.period, '2026-10')
    assert.equal(fmtAmount(as.grossSales), '200.00')
    assert.equal(fmtAmount(as.platformCommission), '33.00')
    assert.equal(fmtAmount(as.selfRemitTaxNet), '0.00')
    assert.equal(fmtAmount(as.statementPayoutDiff), '0.00')

    // 4) TikTok 二轮模糊表头长别名优先 + 全托管混表折算输出 P0 提示
    const ttCsv = [
      'Type,Order ID,Shop mode,Currency,Gross sales,Customer-paid shipping fee after discount,Actual shipping fee net,Total settlement amount',
      'Order,TT-POP-1,POP,RMB,100.00,10.00,-12.00,98.00',
      'Order,TT-FM-1,Fully managed,RMB,50.00,0.00,0.00,50.00',
    ].join('\n')
    const ttPath = join(dir, 'tt_mix.csv')
    writeFileSync(ttPath, ttCsv, 'utf8')
    const [ts] = parsePlatformStatement(ttPath, 'tiktok')
    assert.equal(fmtAmount(ts.grossSales), '160.00')
    assert.equal(fmtAmount(ts.logisticsWarehousing), '12.00')
    assert.equal(fmtAmount(ts.horizontalDiffTotal), '0.00')

    const { apply } = await import('../index.js')
    const tools = {}
    apply({ tools: { register: (t) => { tools[t.name] = t } }, skills: { register: () => {} } })
    const ttReport = await tools.fintax_parse_statement.execute({ file_path: ttPath })
    assert.ok(ttReport.includes('阻断级混表提示'))

    // 5) Stripe payout_cancel 被识别为异常提现，带 captured=false 退款不误算入未捕获废单
    const stCsv = [
      'id,type,created,currency,amount,fee,net,status,captured',
      'ch_1,charge,2026-10-02,USD,100.00,3.00,97.00,succeeded,true',
      're_1,refund,2026-10-03,USD,-20.00,0.00,-20.00,succeeded,false',
      'pc_1,payout_cancel,2026-10-04,USD,-50.00,0.00,-50.00,succeeded,false',
      'po_1,payout,2026-10-05,USD,-77.00,0.00,-77.00,paid,false',
    ].join('\n')
    const stPath = join(dir, 'stripe_cancel.csv')
    writeFileSync(stPath, stCsv, 'utf8')
    const [ss] = parsePlatformStatement(stPath, 'stripe')
    assert.equal(fmtAmount(ss.customerRefund), '20.00')
    assert.equal(fmtAmount(ss.uncapturedVoidExcluded), '0.00')
    assert.equal(fmtAmount(ss.actualPayout), '77.00')
    assert.equal(fmtAmount(ss.statementPayoutDiff), '0.00')
    assert.ok(ss.anomalies.some((a) => a.refId === 'pc_1' && a.category.includes('提现/打款失败')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.4.2 回归：IMA 配置一致性、imaCall 调度与 ima_read 全分支覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v042-ima-'))
  const origFetch = globalThis.fetch
  const savedEnv = {
    FINTAX_CONFIG_DIR: process.env.FINTAX_CONFIG_DIR,
    IMA_CLIENT_ID: process.env.IMA_CLIENT_ID,
    IMA_API_KEY: process.env.IMA_API_KEY,
    IMA_DEFAULT_KB_ID: process.env.IMA_DEFAULT_KB_ID,
    IMA_DEFAULT_KB_NAME: process.env.IMA_DEFAULT_KB_NAME,
  }
  process.env.FINTAX_CONFIG_DIR = dir
  delete process.env.IMA_CLIENT_ID
  delete process.env.IMA_API_KEY
  delete process.env.IMA_DEFAULT_KB_ID
  delete process.env.IMA_DEFAULT_KB_NAME

  try {
    // 1) 混合来源凭证一致性（env clientId + file apiKey）与环境变量覆盖 defaultKbName 防错位
    saveCredentials({ apiKey: 'file_key_1' })
    process.env.IMA_CLIENT_ID = 'env_cid_1'
    const creds = loadCredentials()
    assert.equal(creds?.clientId, 'env_cid_1')
    assert.equal(creds?.apiKey, 'file_key_1')
    assert.equal(getPublicStatus().configured, true)

    saveFintaxSettings({ defaultKbId: 'kb_local', defaultKbName: '本地旧库名' })
    process.env.IMA_DEFAULT_KB_ID = 'kb_env_override'
    const envSet = loadFintaxSettings()
    assert.equal(envSet.defaultKbId, 'kb_env_override')
    assert.equal(envSet.defaultKbName, '环境变量指定知识库')
    delete process.env.IMA_DEFAULT_KB_ID

    // 2) mock globalThis.fetch 测试 imaCall、ima_search/ima_browse 空白传参回退默认库、ima_read 多分支
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('search_knowledge')) {
        const body = JSON.parse(init.body)
        assert.equal(body.knowledge_base_id, 'kb_local')
        return new Response(JSON.stringify({ code: 0, data: { info_list: [{ media_id: 'md_1', title: '2026新规', media_type: 7 }], is_end: true } }))
      }
      if (u.includes('get_media_info')) {
        const { media_id } = JSON.parse(init.body)
        if (media_id === 'err_biz') return new Response(JSON.stringify({ code: 4001, msg: '无权限' }))
        if (media_id === 'md_1') return new Response(JSON.stringify({ code: 0, data: { media_type: 7, url_info: { url: 'https://ima.qq.com/raw/doc.md' } } }))
        if (media_id === 'pdf_1') return new Response(JSON.stringify({ code: 0, data: { media_type: 1, title: '财税汇编.pdf' } }))
        if (media_id === 'note_1') return new Response(JSON.stringify({ code: 0, data: { media_type: 11, notebook_ext_info: { notebook_id: 'nb_1' } } }))
        return new Response(JSON.stringify({ code: 0, data: { media_type: 99 } }))
      }
      if (u.includes('get_doc_content')) {
        return new Response(JSON.stringify({ code: 0, data: { content: '笔记正文：公告2026年第11号' } }))
      }
      if (u === 'https://ima.qq.com/raw/doc.md') {
        return new Response('# Markdown 原文\n税总2025年第15号')
      }
      return new Response('not found', { status: 404 })
    }

    const { apply } = await import('../index.js')
    const tools = {}
    apply({ tools: { register: (t) => { tools[t.name] = t } }, skills: { register: () => {} } })

    const searchOut = await tools.ima_search.execute({ knowledge_base_id: '   ', query: '2026' })
    assert.ok(searchOut.includes('[库 kb_local] 命中 1 条'))

    const folderOut = await tools.ima_read.execute({ media_id: 'folder_123' })
    assert.ok(folderOut.includes('请调用 ima_browse'))

    const mdOut = await tools.ima_read.execute({ media_id: 'md_1' })
    assert.ok(mdOut.includes('税总2025年第15号'))

    const noteOut = await tools.ima_read.execute({ media_id: 'note_1' })
    assert.ok(noteOut.includes('公告2026年第11号'))

    const pdfOut = await tools.ima_read.execute({ media_id: 'pdf_1' })
    assert.ok(pdfOut.includes('二进制文档'))

    await assert.rejects(() => imaCall('openapi/wiki/v1/get_media_info', { media_id: 'err_biz' }), /code=4001/)
  } finally {
    globalThis.fetch = origFetch
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
})


// ── v0.5.0 回归测试套件：UTF-16、.zip 原包、Temu/Shopify、多币种合并对账与 HTML/MD 体检单导出 ──

function encodeUtf16LE(str, withBom = true) {
  const body = Buffer.from(str, 'utf16le')
  return withBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body
}

function encodeUtf16BE(str, withBom = true) {
  const le = Buffer.from(str, 'utf16le')
  const be = Buffer.alloc(le.length)
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1]
    be[i + 1] = le[i]
  }
  return withBom ? Buffer.concat([Buffer.from([0xfe, 0xff]), be]) : be
}

test('v0.5.0 回归：UTF-16LE (含/无 BOM) 与 UTF-16BE Unicode TSV 原始账单解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-utf16-'))
  try {
    const v2Tsv = [
      'settlement-id\tsettlement-start-date\ttransaction-type\torder-id\tmarketplace-name\tamount-type\tamount-description\tamount\tcurrency',
      'S-UTF16\t2026-10-01\tOrder\t114-01\tamazon.com.au\tItemPrice\tPrincipal\t1000.00\tAUD',
      'S-UTF16\t2026-10-01\tOrder\t114-01\tamazon.com.au\tItemFees\tCommission\t-150.00\tAUD',
    ].join('\r\n')

    const fLeBom = join(dir, 'v2_le_bom.txt')
    const fLeRaw = join(dir, 'v2_le_nobom.tsv')
    const fBeBom = join(dir, 'v2_be_bom.txt')
    writeFileSync(fLeBom, encodeUtf16LE(v2Tsv, true))
    writeFileSync(fLeRaw, encodeUtf16LE(v2Tsv, false))
    writeFileSync(fBeBom, encodeUtf16BE(v2Tsv, true))

    for (const fp of [fLeBom, fLeRaw, fBeBom]) {
      const [s] = parsePlatformStatement(fp)
      assert.equal(s.platform, 'Amazon')
      assert.equal(s.site, 'AU')
      assert.equal(s.currency, 'AUD')
      assert.equal(fmtAmount(s.grossSales), '1000.00')
      assert.equal(fmtAmount(s.platformCommission), '150.00')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.5.0 回归：Temu 半托管/全托管混同 P0 拦截、履约罚款分离与水平守恒轧平', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-temu-'))
  try {
    const temuCsv = [
      '结算时间,订单号,经营模式,账务类型,站点,币种,商品零售价,供货结算价,买家支付运费,商家优惠券,平台补贴,售后退款,技术服务费,尾程物流费,履约罚款,平台代扣税费,保证金变动,应结金额',
      '2026-10-06,PO-8801,半托管,销售结算,US,USD,45000.00,0.00,1500.00,1500.00,1200.00,0.00,2250.00,6300.00,0.00,3600.00,0.00,37650.00',
      '2026-10-12,PO-8802,半托管,售后退款,US,USD,0.00,0.00,0.00,0.00,0.00,2000.00,0.00,180.00,0.00,160.00,0.00,-2180.00',
      '2026-10-16,PO-8803,半托管,违规扣款,US,USD,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,450.00,0.00,0.00,-450.00',
      '2026-10-19,JIT-7701,全托管,供货货款,US,USD,0.00,12000.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,-1000.00,11000.00',
      '2026-10-28,WD-1028,,提现打款,US,USD,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,46020.00',
    ].join('\n')
    const fp = join(dir, 'Temu_US_202610.csv')
    writeFileSync(fp, temuCsv, 'utf8')

    const [s] = parsePlatformStatement(fp)
    assert.equal(s.platform, 'Temu')
    assert.equal(fmtAmount(s.grossSales), '58500.00')
    assert.equal(fmtAmount(s.sellerDiscount), '1500.00')
    assert.equal(fmtAmount(s.taxReportingGrossRef), '57000.00')
    assert.equal(fmtAmount(s.gatewayDisputeFee), '450.00')
    assert.equal(fmtAmount(s.reserveNetChange), '1000.00')
    assert.equal(fmtAmount(s.horizontalDiffTotal), '0.00')
    assert.equal(fmtAmount(s.statementPayoutDiff), '0.00')
    assert.ok(s.anomalies.some((a) => a.severity.startsWith('P0') && a.category.includes('全托管')))
    assert.ok(s.anomalies.some((a) => a.severity.startsWith('P1') && a.category.includes('履约违规罚款')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.5.0 回归：Shopify 独立站自收境外 VAT 剥离、渠道代扣税、弃单过滤与拒付争议分离', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-shopify-'))
  try {
    const shpCsv = [
      'Transaction Date,Type,Order,Financial Status,Currency,Amount,Discount Amount,Tax,Marketplace Facilitator Tax,Fee,Net,Payout ID',
      '2026-10-04,charge,#2041,paid,EUR,24000.00,1000.00,4000.00,0.00,720.00,23280.00,SHP-PO-101',
      '2026-10-09,charge,#2042,paid,EUR,11500.00,500.00,0.00,1500.00,345.00,9655.00,SHP-PO-101',
      '2026-10-14,charge,#2043,pending,EUR,4200.00,0.00,700.00,0.00,0.00,0.00,',
      '2026-10-18,dispute,#2019,chargeback,EUR,-1200.00,0.00,-200.00,0.00,15.00,-1215.00,SHP-PO-102',
      '2026-10-29,payout,,paid,EUR,31720.00,0.00,0.00,0.00,0.00,31720.00,SHP-PO-102',
    ].join('\n')
    const fp = join(dir, 'Shopify_EU_202610.csv')
    writeFileSync(fp, shpCsv, 'utf8')

    const [s] = parsePlatformStatement(fp)
    assert.equal(s.platform, 'Shopify')
    assert.equal(s.currency, 'EUR')
    assert.equal(fmtAmount(s.taxReportingGrossRef), '30000.00') // 20000 + 10000
    assert.equal(fmtAmount(s.selfRemitTaxNet), '3800.00') // 4000 - 200
    assert.equal(fmtAmount(s.facilitatorTaxStripped), '1500.00')
    assert.equal(fmtAmount(s.customerRefund), '1000.00')
    assert.equal(fmtAmount(s.gatewayDisputeFee), '15.00')
    assert.equal(fmtAmount(s.uncapturedVoidExcluded), '4200.00')
    assert.equal(fmtAmount(s.horizontalDiffTotal), '0.00')
    assert.equal(fmtAmount(s.statementPayoutDiff), '0.00')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.5.0 回归：.zip 压缩包免解压直拖 + 多币种 fx_rates 合并总对账 + 7500万小微生死崖预警 + HTML/MD 报告导出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-zip-v05-'))
  try {
    const zipBuf = buildTestXlsx({
      '__MACOSX/._Temu.csv': 'ignored-macos-resource-fork',
      '2026Q4/Temu_Big_US.csv': [
        '结算时间,订单号,经营模式,账务类型,站点,币种,商品零售价,商家优惠券,技术服务费,应结金额',
        '2026-11-10,PO-BIG-1,半托管,销售结算,US,USD,10000000.00,0.00,500000.00,9500000.00',
        '2026-11-25,WD-BIG,,提现打款,US,USD,0.00,0.00,0.00,9500000.00',
      ].join('\n'),
      '2026Q4/Shopify_Big_EUR.csv': [
        'Transaction Date,Type,Order,Financial Status,Currency,Amount,Tax,Fee,Net,Payout ID',
        '2026-11-12,charge,#9001,paid,EUR,1200000.00,200000.00,30000.00,1170000.00,P1',
        '2026-11-28,payout,,paid,EUR,1170000.00,0.00,0.00,1170000.00,P1',
      ].join('\n'),
    })
    const zipPath = join(dir, 'Annual_2026_Statements.zip')
    writeFileSync(zipPath, zipBuf)

    const { apply } = await import('../index.js')
    const tools = {}
    apply({ tools: { register: (t) => { tools[t.name] = t } }, skills: { register: () => {} } })

    const htmlPath = join(dir, 'boss_report.html')
    const mdPath = join(dir, 'boss_report.md')

    // 10M USD * 7.18 = 71.8M CNY + 1M EUR * 7.82 = 7.82M CNY => 79.62M CNY (> 75M 小微生死崖红线！)
    const out = await tools.fintax_parse_statement.execute({
      file_path: zipPath,
      fx_rates: { USD: 7.18, EUR: 7.82 },
      declared_vat_sales_cny: 79_620_000,
      export_report_path: htmlPath,
    })
    assert.ok(out.includes('共合并 2 张结算单'))
    assert.ok(out.includes('放款差额 = 0 元'))
    assert.ok(out.includes('7,500万小微生死崖红灯'))

    const htmlText = readFileSync(htmlPath, 'utf8')
    assert.ok(htmlText.includes('跨境店铺原始结算账单 · 税务初筛体检诊断书'))
    assert.ok(htmlText.includes('7,500万小微生死崖红灯'))
    assert.ok(!htmlText.includes('借：应收账款')) // 严守护城河，不泄露正式会计分录

    // 验证 demo:all 沙盒与 Markdown 导出
    const demoOut = await tools.fintax_parse_statement.execute({
      file_path: 'demo:all',
      fx_rates: '{"USD": 7.18, "EUR": 7.82}',
      export_report_path: mdPath,
    })
    assert.ok(demoOut.includes('放款差额 = 0 元'))
    const mdText = readFileSync(mdPath, 'utf8')
    assert.ok(mdText.includes('# 跨境店铺原始结算单税务初筛体检诊断书'))
    assert.ok(mdText.includes('Temu 全托管供货与半托管自营混同'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ── v0.6.0 回归测试套件：IMA 重试与 60s 缓存、工作台 HTTP API (/parse & /calc) 与侧边栏多槽位挂载 ──

test('v0.6.0 回归：IMA 5xx 指数退避重试、60s 只读目录缓存命中与凭证变更自动清缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-ima-v06-'))
  const savedEnv = {
    FINTAX_CONFIG_DIR: process.env.FINTAX_CONFIG_DIR,
    IMA_CLIENT_ID: process.env.IMA_CLIENT_ID,
    IMA_API_KEY: process.env.IMA_API_KEY,
  }
  const origFetch = globalThis.fetch
  try {
    process.env.FINTAX_CONFIG_DIR = dir
    delete process.env.IMA_CLIENT_ID
    delete process.env.IMA_API_KEY
    saveCredentials({ clientId: 'cid_v06', apiKey: 'key_v06' })
    clearImaCache()

    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return new Response('upstream error', { status: 502 })
      return new Response(JSON.stringify({ code: 0, data: { info_list: [{ kb_id: 'kb_ok', kb_name: '跨境财税主库' }] } }))
    }

    // 第 1 次 502 自动重试并在第 2 次成功
    const d1 = await imaCall('openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 10 }, { retryBaseMs: 1 })
    assert.equal(d1.info_list[0].kb_id, 'kb_ok')
    assert.equal(callCount, 2)

    // 紧接着同参再查：命中 60s 缓存，不再发起网络请求
    const d2 = await imaCall('openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 10 }, { retryBaseMs: 1 })
    assert.equal(d2.info_list[0].kb_id, 'kb_ok')
    assert.equal(callCount, 2)

    // noCache: true 绕过缓存重新请求
    await imaCall('openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 10 }, { noCache: true, retryBaseMs: 1 })
    assert.equal(callCount, 3)

    // 更新凭证自动清缓存
    saveCredentials({ clientId: 'cid_v06', apiKey: 'key_v06_new' })
    await imaCall('openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 10 }, { retryBaseMs: 1 })
    assert.equal(callCount, 4)
  } finally {
    clearImaCache()
    globalThis.fetch = origFetch
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.6.0 回归：工作台后端 /api/fintax/parse 与 /api/fintax/calc 全链路（含 base64 多文件、沙盒与权限拦截）', async () => {
  const { createFintaxApiHandler } = await import('../index.js')

  const invoke = (handler, method, path, bodyObj) =>
    new Promise((resolve) => {
      const payload = bodyObj !== undefined ? JSON.stringify(bodyObj) : ''
      const req = Readable.from(payload ? [Buffer.from(payload)] : [])
      req.method = method
      req.url = path
      const res = {
        status: 200,
        body: '',
        writeHead(s) { this.status = s },
        end(b) { this.body = b; resolve({ status: this.status, json: JSON.parse(b) }) },
      }
      handler(req, res)
    })

  // 未登录拦截（401）
  const denyHandler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ rejection: 401 }) }) })
  const r401 = await invoke(denyHandler, 'POST', '/api/fintax/parse', { demo: 'all' })
  assert.equal(r401.status, 401)

  const okHandler = createFintaxApiHandler({ getConnection: () => ({ admit: () => ({}) }) })

  // 1. /api/fintax/calc 全 7 大场景确定性试算校验
  const guiDefaults = [
    ['platform_tax_reconcile', { reportedGrossRevenue: 6000000, refunds: 450000, marketplaceWithheldTax: 350000, cutoffAndFxDiff: 400000, platformFees: 600000, declaredVatSales: 4200000 }],
    ['export_invoice_breakeven', { barePurchaseAmount: 1000000, supplierMarkupRate: 0.08, vatRate: 0.13, rebateRate: 0.13, exportRevenue: 1500000 }],
    ['cbec_assessed_cit', { revenue: 80000000, taxableIncomeRate: 0.04, smallLowProfit: true }],
    ['export_rebate', { purchaseAmount: 500000, vatRate: 0.13, rebateRate: 0.09 }],
    ['annual_bonus_iit', { bonus: 36001 }],
    ['cross_border_import', { price: 1200, vatRate: 0.13, consumptionTaxRate: 0.15, annualUsed: 0 }],
    ['vat', { amount: 1130000, rate: 0.13, inclusive: true }],
  ]
  for (const [sc, params] of guiDefaults) {
    const r = await invoke(okHandler, 'POST', '/api/fintax/calc', { scenario: sc, params })
    assert.equal(r.status, 200, `GUI default calc failed for ${sc}: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.ok, true)
    if (sc === 'annual_bonus_iit') assert.ok(r.json.result.trap && r.json.result.trap.boundary === 36000)
  }

  const rCalcBad = await invoke(okHandler, 'POST', '/api/fintax/calc', { scenario: 'vat', params: { amount: -10 } })
  assert.equal(rCalcBad.status, 400)

  // 2. /api/fintax/parse 沙盒演示 + 合并折算 + HTML/MD 诊断书
  const rDemo = await invoke(okHandler, 'POST', '/api/fintax/parse', {
    demo: 'all',
    fxRates: { USD: 7.18, EUR: 7.82 },
    declaredVatSalesCny: 580000,
  })
  assert.equal(rDemo.status, 200)
  assert.equal(rDemo.json.ok, true)
  assert.equal(rDemo.json.summaries.length, 3)
  assert.equal(rDemo.json.consolidated.ready, true)
  assert.ok(rDemo.json.reportHtml.includes('跨境店铺原始结算账单 · 税务初筛体检诊断书'))
  assert.ok(rDemo.json.reportMd.includes('# 跨境店铺原始结算单税务初筛体检诊断书'))

  // 3. /api/fintax/parse Base64 真实账单文件内存直解析
  const temuCsv = [
    '结算时间,订单号,经营模式,账务类型,站点,币种,商品零售价,供货结算价,技术服务费,应结金额',
    '2026-11-10,PO-GUI-1,半托管,销售结算,US,USD,100000.00,0.00,5000.00,95000.00',
    '2026-11-12,JIT-GUI-2,全托管,供货货款,US,USD,0.00,20000.00,0.00,20000.00',
  ].join('\n')
  const rFile = await invoke(okHandler, 'POST', '/api/fintax/parse', {
    files: [{ name: 'Temu_Upload.csv', dataBase64: Buffer.from(temuCsv, 'utf8').toString('base64') }],
    fxRates: { USD: 7.18 },
  })
  assert.equal(rFile.status, 200)
  assert.equal(rFile.json.summaries[0].platform, 'Temu')
  assert.equal(rFile.json.summaries[0].taxReportingGrossRef, '120000.00')
  assert.ok(rFile.json.summaries[0].anomalies.some((a) => a.severity.startsWith('P0')))
})

test('v0.6.0 回归：client.js 同时注册 sidebar.panellist + main + settings.section.icon + settings.section 且带崩溃隔离', async () => {
  let loadedModule = null
  globalThis.window = {
    __ModuleLoader__: {
      load(def) { loadedModule = def },
    },
  }
  try {
    await import(`../client.js?v06=${Date.now()}`)
    const fakeReact = {
      createElement: (tag, props, ...children) => ({ tag, props, children }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
    }
    const plugin = loadedModule.factory(() => fakeReact)
    const registered = []
    plugin.apply({
      locale: { bind: () => (k) => k, register: () => () => {}, getLocale: () => ({ active: 'zh-CN' }) },
      effect: (fn) => fn(),
      slots: {
        inject: (_slot, fn) => fn(),
        register: (meta, renderFn) => {
          registered.push({ meta, renderFn })
          return () => {}
        },
      },
    })
    const names = registered.map((r) => r.meta.name)
    assert.ok(names.includes('main'))
    assert.ok(names.includes('sidebar.panellist'))
    assert.ok(names.includes('settings.section.icon'))
    assert.equal(names[names.length - 1], 'settings.section')

    // 确认渲染函数可无报错构造虚拟树，且宿主抛出异常时 apply 不向外抛错拖垮桌面端
    const mainEntry = registered.find((r) => r.meta.name === 'main')
    assert.ok(mainEntry.renderFn())
    assert.doesNotThrow(() => {
      plugin.apply({
        locale: { bind: () => { throw new Error('simulated old host crash') } },
        effect: () => {},
        slots: { inject: () => {}, register: () => {} },
      })
    })
  } finally {
    delete globalThis.window
  }
})

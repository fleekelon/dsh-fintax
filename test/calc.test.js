import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
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
    assert.deepEqual(Object.keys(tools).sort(), ['fintax_calc', 'ima_browse', 'ima_list_kbs', 'ima_read', 'ima_search'])
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

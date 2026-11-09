import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crossBorderImport, vat, calculate, annualBonusIit, exportRebate, cbecAssessedCit } from '../lib/calc.js'

test('跨境电商综合税：普通商品 13%×70%=9.1%', () => {
  const r = crossBorderImport({ price: 1000 })
  assert.equal(r.taxPayable, 91)
  assert.equal(r.effectiveRate, '9.10%')
  assert.equal(r.withinLimit, true)
  assert.equal(r.warnings.length, 0)
})

test('跨境电商综合税：消费税商品组成计税价格', () => {
  // 高档化妆品：消费税 15%，增值税 13%，完税价格 1000
  // 组成计税价格 = 1000/0.85 = 1176.47；消费税 176.47；增值税 152.94
  // 应纳 = (176.47+152.94)×0.7 ≈ 230.59
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
  assert.equal(r.taxPayable, 63) // 1000×9%×70%
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

test('calculate 分发', () => {
  assert.equal(calculate('cross_border_import', { price: 100 }).taxPayable, 9.1)
  assert.equal(calculate('vat', { amount: 113 }).taxAmount, 13)
  assert.equal(calculate('annual_bonus_iit', { bonus: 36000 }).taxPayable, 1080)
  assert.equal(calculate('export_rebate', { purchaseAmount: 10000 }).taxRefund, 1300)
  assert.equal(calculate('cbec_assessed_cit', { revenue: 1000000 }).taxPayable, 10000)
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

// ── 出口退税 ──
test('出口退税：13% 专票全额退', () => {
  const r = exportRebate({ purchaseAmount: 20000, vatRate: 0.13, rebateRate: 0.13 })
  assert.equal(r.taxRefund, 2600)
  assert.equal(r.nonRefundableToCost, 0)
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
  const r = cbecAssessedCit({ revenue: 100000000, smallLowProfit: true })
  assert.equal(r.taxableIncome, 4000000)
  assert.equal(r.citRateApplied, 0.25)
  assert.ok(r.warnings.some((w) => w.includes('超过300万')))
})

test('核定征收：9810 口径预警恒在', () => {
  const r = cbecAssessedCit({ revenue: 100 })
  assert.ok(r.warnings.some((w) => w.includes('9810')))
})

// ── 边界防御与工具层集成测试 ──
test('边界防御：必填参数传入 null / 空字符串 / 布尔值必须抛错（不得静默当 0）', () => {
  for (const bad of [null, undefined, '', '   ', false, true, {}, []]) {
    assert.throws(() => crossBorderImport({ price: bad }), `price=${JSON.stringify(bad)} 应抛错`)
    assert.throws(() => vat({ amount: bad }), `amount=${JSON.stringify(bad)} 应抛错`)
    assert.throws(() => annualBonusIit({ bonus: bad }), `bonus=${JSON.stringify(bad)} 应抛错`)
    assert.throws(() => exportRebate({ purchaseAmount: bad }), `purchaseAmount=${JSON.stringify(bad)} 应抛错`)
    assert.throws(() => cbecAssessedCit({ revenue: bad }), `revenue=${JSON.stringify(bad)} 应抛错`)
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

test('工具层集成：fintax_calc 输出核定征收实际税负率、超限提示及扁平参数兜底', async () => {
  const { apply } = await import('../index.js')
  const tools = {}
  const skills = {}
  apply({
    tools: { register: (t) => { tools[t.name] = t } },
    skills: { register: (s) => { skills[s.name] = s } },
  })

  // 验证 5 个工具与 4 个技能全部完整注册
  assert.deepEqual(Object.keys(tools).sort(), ['fintax_calc', 'ima_browse', 'ima_list_kbs', 'ima_read', 'ima_search'])
  assert.deepEqual(Object.keys(skills).sort(), ['fintax-calc', 'fintax-crossborder-check', 'fintax-mode-select', 'fintax-policy-qa'])
  for (const s of Object.values(skills)) {
    assert.ok(s.description && s.description.length > 10, `技能 ${s.name} description 不应为空`)
    assert.ok(s.content && s.content.length > 50, `技能 ${s.name} content 不应为空`)
  }

  // 验证 IMA 工具空参拦截与文件夹误调拦截
  assert.ok((await tools.ima_search.execute({})).includes('[错误]'))
  assert.ok((await tools.ima_browse.execute({ knowledge_base_id: '   ' })).includes('[错误]'))
  assert.ok((await tools.ima_read.execute({ media_id: '' })).includes('[错误]'))
  const folderIntercept = await tools.ima_read.execute({ media_id: 'folder_7491123161363408' })
  assert.ok(folderIntercept.includes('是文件夹，不能用 ima_read 读取') && folderIntercept.includes('ima_browse'))

  const outCit = await tools.fintax_calc.execute({
    scenario: 'cbec_assessed_cit',
    params: { revenue: 5000000, smallLowProfit: true },
  })
  assert.ok(outCit.includes('实际税负率 0.20%'), `应包含实际税负率，实际输出：${outCit}`)

  const outOver = await tools.fintax_calc.execute({
    scenario: 'cross_border_import',
    params: { price: 6000 },
  })
  assert.ok(outOver.includes('已超限，不适用限额内优惠口径'), `超限结果行应包含明确提示，实际输出：${outOver}`)

  const outFlat = await tools.fintax_calc.execute({
    scenario: 'vat',
    amount: 113,
  })
  assert.ok(outFlat.includes('应纳税额 13 元'), `应兼容顶层扁平参数，实际输出：${outFlat}`)
})

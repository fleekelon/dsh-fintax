import assert from 'node:assert/strict'
import test from 'node:test'
import { cbecAssessedCit, platformTaxReconcile } from '../lib/calc.js'
import { finalizeSummary, fmtAmount, makeEmptySummary, parseAmount } from '../lib/statement.js'

test('四层口径分列，各用独立来源，资金桥接另列', () => {
  const r = platformTaxReconcile({
    reportedGrossRevenue: 1000,
    refunds: 75,
    accountingRevenue: 800,
    declaredVatSales: 810,
    citTaxableIncome: -40,
    actualPayout: 900,
  })
  assert.deepEqual(r.layers, {
    platformReporting: { source: 'platform', grossRevenue: 1000, refunds: 75, netRevenue: 925 },
    financialAccounting: { principalRole: 'principal', accountingRevenue: 800 },
    vatAndExport: { declaredVatSales: 810, referenceSales: 925 },
    corporateIncomeTax: { taxableIncome: -40 },
  })
  assert.equal(r.payoutReconciliation.gapFormula, '实际放款 − 理论放款')
  assert.equal(r.payoutReconciliation.unexplainedCashGap, -25)
  const withoutDeclarations = platformTaxReconcile({ reportedGrossRevenue: 1000 })
  assert.equal(withoutDeclarations.layers.financialAccounting.accountingRevenue, null)
  assert.equal(withoutDeclarations.layers.vatAndExport.declaredVatSales, null)
  assert.equal(withoutDeclarations.layers.corporateIncomeTax.taxableIncome, null)
  assert.equal(withoutDeclarations.payoutReconciliation, null)
})

test('账单与算税工具的放款差额均为实际减理论，正负和零同向', () => {
  for (const [actualPayout, expectedGap] of [[125, 5], [115, -5], [120, 0]]) {
    const statement = makeEmptySummary({ currency: 'CNY' })
    statement.grossSales = parseAmount('140')
    statement.customerRefund = parseAmount('20')
    statement.actualPayout = parseAmount(actualPayout)
    finalizeSummary(statement)

    const r = platformTaxReconcile({ reportedGrossRevenue: 140, refunds: 20, actualPayout })
    assert.equal(Number(fmtAmount(statement.statementPayoutDiff)), expectedGap)
    assert.equal(r.payoutReconciliation.unexplainedCashGap, expectedGap)
    assert.equal(r.payoutReconciliation.gapFormula, statement.statementPayoutDiffFormula)
    assert.equal(statement.taxReportingGrossRefSource, 'statement_reference')
  }
})

test('申报差额的符号来自报送总额或参考销售额减已申报销售额', () => {
  const positive = platformTaxReconcile({ reportedGrossRevenue: 120, refunds: 10, declaredVatSales: 100 })
  const negative = platformTaxReconcile({ reportedGrossRevenue: 120, refunds: 10, declaredVatSales: 125 })
  assert.equal(positive.declarationDiagnosis.rawReportingDiff, 20)
  assert.equal(positive.declarationDiagnosis.unexplainedSalesGap, 10)
  assert.equal(negative.declarationDiagnosis.rawReportingDiff, -5)
  assert.equal(negative.declarationDiagnosis.unexplainedSalesGap, -15)
  assert.equal(positive.declarationDiagnosis.rawReportingDiffFormula, '平台报送总额 − 已申报销售额')
  assert.equal(positive.declarationDiagnosis.unexplainedSalesGapFormula, '参考销售额 − 已申报销售额')
})

test('按源金额是否含代扣税和补贴归一，避免重复扣加', () => {
  const alreadyNormalized = platformTaxReconcile({
    reportedGrossRevenue: 120,
    reportedGrossSource: 'platform',
    marketplaceWithheldTax: 15,
    withheldTaxIncludedInGross: false,
    subsidies: 20,
    subsidiesIncludedInGross: true,
    actualPayout: 120,
    declaredVatSales: 120,
  })
  assert.equal(alreadyNormalized.referenceGrossSales, 120)
  assert.equal(alreadyNormalized.payoutReconciliation.theoreticalPayout, 120)
  assert.equal(alreadyNormalized.payoutReconciliation.unexplainedCashGap, 0)
  const statementReference = platformTaxReconcile({
    reportedGrossRevenue: 100,
    reportedGrossSource: 'statement_reference',
    marketplaceWithheldTax: 15,
    subsidies: 20,
    subsidiesIncludedInGross: false,
    actualPayout: 120,
    declaredVatSales: 110,
  })
  assert.equal(statementReference.layers.platformReporting.source, 'statement_reference')
  assert.equal(statementReference.declarationDiagnosis.rawReportingDiffFormula, '账单参考总额 − 已申报销售额')
  assert.equal(statementReference.payoutReconciliation.unexplainedCashGap, 0)
})

test('小型微利的所得额、人数、资产、行业和政策年度均须符合', () => {
  const eligible = {
    revenue: 15_000_000,
    annualTaxableIncome: 3_000_000,
    annualAverageEmployees: 300,
    annualAverageAssets: 50_000_000,
    nonRestrictedIndustry: true,
    assessedQualificationConfirmed: true,
    taxYear: 2027,
  }
  const r = cbecAssessedCit(eligible)
  assert.equal(r.taxableIncome, 600_000)
  assert.equal(r.annualTaxableIncome, 3_000_000)
  assert.equal(r.assessedQualificationConfirmed, true)
  assert.equal(r.smallLowProfitApplied, true)
  assert.equal(r.citRateApplied, 0.05)
  assert.equal(r.taxPayable, 30_000)
  for (const changed of [
    { annualTaxableIncome: 3_000_000.01 },
    { annualAverageEmployees: 300.25 },
    { annualAverageAssets: 50_000_000.01 },
    { nonRestrictedIndustry: false },
    { taxYear: 2028 },
  ]) {
    const ineligible = cbecAssessedCit({ ...eligible, ...changed, smallLowProfit: true })
    assert.equal(ineligible.smallLowProfitApplied, false)
    assert.equal(ineligible.citRateApplied, 0.25)
  }
  assert.equal(cbecAssessedCit({ ...eligible, annualAverageEmployees: undefined }).smallLowProfitApplied, false)
})

test('4%假设下7500万元仅为等值收入，9810预退税资格另行判断', () => {
  const atBoundary = cbecAssessedCit({ revenue: 75_000_000, smallLowProfit: true })
  const overBoundary = cbecAssessedCit({ revenue: 75_000_001, smallLowProfit: true })
  assert.equal(atBoundary.taxPayable, 150_000)
  assert.equal(overBoundary.taxPayable, 750_000.01)
  assert.equal(atBoundary.assessedQualificationConfirmed, false)
  assert.ok(atBoundary.warnings.some((warning) => warning.includes('主管税务机关鉴定待确认')))
  assert.ok(atBoundary.warnings.some((warning) => warning.includes('9810') && warning.includes('另行确认')))
  assert.ok(atBoundary.warnings.some((warning) => warning.includes('滚动账单只用于风险提示')))
  assert.ok(atBoundary.warnings.some((warning) => warning.includes('2027-12-31')))
})

// dsh-fintax v0.5.0 多表/多币种合并人民币总对账、7500万小微悬崖雷达与可汇报体检单导出器。
// 严格遵循《产品指导原则与验收标准》：四套口径永不混用，只输出初筛排雷与下一步动作，严守正式关账母表护城河。

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { platformTaxReconcile } from './calc.js'
import { fmtAmount, toNumber2 } from './statement.js'

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** 解析多币种汇率输入（兼容 Object 或 JSON 字符串）。 */
export function normalizeFxMap(fxRatesRaw) {
  if (!fxRatesRaw) return {}
  let obj = fxRatesRaw
  if (typeof fxRatesRaw === 'string') {
    const trimmed = fxRatesRaw.trim()
    if (!trimmed) return {}
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const num = Number(v)
    if (Number.isFinite(num) && num > 0) out[String(k).trim().toUpperCase()] = num
  }
  return out
}

export function resolveCurrencyFx(currency, singleFx, fxMap, uniqueForeignCount) {
  const ccy = String(currency || '').toUpperCase()
  if (ccy === 'RMB' || ccy === 'CNY') return 1
  if (fxMap && fxMap[ccy]) return fxMap[ccy]
  if (singleFx !== null && singleFx !== undefined && String(singleFx).trim() !== '') {
    const n = Number(singleFx)
    if (Number.isFinite(n) && n > 0 && uniqueForeignCount <= 1) return n
  }
  return null
}

/**
 * 合并账单人民币折算，生成报送、申报比对与独立资金桥接的初筛结果。
 * v0.8.0 分轨规则：销售平台（sales_platform）汇总报送参考额；第三方结汇通道（settlement_wallet）
 * 严禁重复计入销售报送额，独立归集并与平台放款执行三段资金链交叉核对（fundChain）。
 */
export function buildConsolidatedReconcile(summaries, { fxRateToCny, fxRates, declaredVatSalesCny } = {}) {
  if (!Array.isArray(summaries) || summaries.length === 0) return null
  const fxMap = normalizeFxMap(fxRates)
  const foreignCcys = new Set(
    summaries.map((s) => String(s.currency || '').toUpperCase()).filter((c) => c !== 'RMB' && c !== 'CNY'),
  )

  const missingCcys = []
  const perSheetFx = []
  for (const s of summaries) {
    const fx = resolveCurrencyFx(s.currency, fxRateToCny, fxMap, foreignCcys.size)
    if (!fx) missingCcys.push(s.currency)
    perSheetFx.push(fx)
  }
  if (missingCcys.length > 0) {
    return {
      ready: false,
      missingCurrencies: [...new Set(missingCcys)],
    }
  }

  let grossCny = 0
  let refundCny = 0
  let feesCny = 0
  let subsidyCny = 0
  let selfRemitTaxCny = 0
  let reserveCny = 0
  let payoutCny = 0
  let hasAnyPayout = false
  let p0Count = 0
  let salesSheetCount = 0
  let walletSheetCount = 0

  // 按原币种追踪第一段（平台放款）与第二/三段（结汇入账/对公/私户/待核/坐支/冻结/换汇净流）
  const ccyChainMap = new Map()
  const ensureCcy = (ccy, fx) => {
    const code = String(ccy || 'UNKNOWN').toUpperCase()
    if (!ccyChainMap.has(code)) {
      ccyChainMap.set(code, {
        currency: code,
        fx,
        platformPayout: 0,
        walletInbound: 0,
        otherInbound: 0,
        returnedInbound: 0,
        corporateWithdraw: 0,
        personalWithdraw: 0,
        unverifiedWithdraw: 0,
        directSpend: 0,
        walletFees: 0,
        frozenOutflow: 0,
        internalFxNet: 0,
        internalFxStripped: 0,
        signedNetFlow: 0,
        retainedOffshore: 0,
      })
    }
    return ccyChainMap.get(code)
  }

  const breakdown = summaries.map((s, idx) => {
    const fx = perSheetFx[idx]
    // 严格按 role 隔离结汇通道（绝不依赖 walletMetrics 是否存在，防止缺失指标的钱包误计入销售）
    const isWallet = s.role === 'settlement_wallet'
    p0Count += (s.anomalies || []).filter((a) => String(a.severity || '').startsWith('P0')).length
    const ccySlot = ensureCcy(s.currency, fx)

    if (isWallet) {
      walletSheetCount += 1
      const wm = s.walletMetrics || {}
      const wIn = toNumber2(wm.platformInbound || 0n)
      const wOther = toNumber2(wm.otherInbound || 0n)
      const wRetIn = toNumber2(wm.returnedInbound || 0n)
      const wCorp = toNumber2(wm.fxWithdrawToCorporate || 0n)
      const wPers = toNumber2(wm.fxWithdrawToPersonal || 0n)
      const wUnv = toNumber2(wm.unverifiedWithdraw || 0n)
      const wSpend = toNumber2(wm.directSpend || 0n)
      const wFee = toNumber2(wm.walletFees || 0n)
      const wFrozOut = toNumber2(wm.frozenOutflow || 0n)
      const wFxNet = toNumber2(wm.internalFxNet || 0n)
      const wFxStrip = toNumber2(wm.internalFxStripped || 0n)
      ccySlot.walletInbound = r2(ccySlot.walletInbound + wIn)
      ccySlot.otherInbound = r2(ccySlot.otherInbound + wOther)
      ccySlot.returnedInbound = r2(ccySlot.returnedInbound + wRetIn)
      ccySlot.corporateWithdraw = r2(ccySlot.corporateWithdraw + wCorp)
      ccySlot.personalWithdraw = r2(ccySlot.personalWithdraw + wPers)
      ccySlot.unverifiedWithdraw = r2(ccySlot.unverifiedWithdraw + wUnv)
      ccySlot.directSpend = r2(ccySlot.directSpend + wSpend)
      ccySlot.walletFees = r2(ccySlot.walletFees + wFee)
      ccySlot.frozenOutflow = r2(ccySlot.frozenOutflow + wFrozOut)
      ccySlot.internalFxNet = r2(ccySlot.internalFxNet + wFxNet)
      ccySlot.internalFxStripped = r2(ccySlot.internalFxStripped + wFxStrip)
      return {
        label: `${s.platform}·${s.site}(${s.period})`,
        role: 'settlement_wallet',
        currency: s.currency,
        fx,
        grossOrig: '0.00',
        grossCny: 0,
        netSalesCny: 0,
        walletInboundCny: r2(wIn * fx),
        corporateWithdrawCny: r2(wCorp * fx),
      }
    }

    salesSheetCount += 1
    const g = r2(toNumber2(s.taxReportingGrossRef) * fx)
    const rf = r2(toNumber2(s.customerRefund) * fx)
    const fe = r2(toNumber2(s.totalFees) * fx)
    const sb = r2(toNumber2(s.platformSubsidy) * fx)
    const st = r2(toNumber2(s.selfRemitTaxNet) * fx)
    const rv = r2(toNumber2(s.reserveNetChange) * fx)
    const poOrig = toNumber2(s.actualPayout)
    const po = r2(poOrig * fx)

    grossCny += g
    refundCny += rf
    feesCny += fe
    subsidyCny += sb
    selfRemitTaxCny += st
    reserveCny += rv
    if (s.actualPayout > 0n) {
      hasAnyPayout = true
      payoutCny += po
      ccySlot.platformPayout = r2(ccySlot.platformPayout + poOrig)
    }
    return {
      label: `${s.platform}·${s.site}(${s.period})`,
      role: 'sales_platform',
      currency: s.currency,
      fx,
      grossOrig: fmtAmount(s.taxReportingGrossRef),
      grossCny: g,
      netSalesCny: r2(g - rf),
    }
  })

  grossCny = r2(grossCny)
  refundCny = r2(refundCny)
  feesCny = r2(feesCny)
  subsidyCny = r2(subsidyCny)
  selfRemitTaxCny = r2(selfRemitTaxCny)
  reserveCny = r2(reserveCny)
  payoutCny = r2(payoutCny)

  // 构建三段资金链交叉核对对象（只要存在至少 1 份结汇通道账单即激活）
  let fundChain = null
  if (walletSheetCount > 0) {
    const hasSalesEvidence = salesSheetCount > 0
    // 跨文件合并同币种后再算有符号净流与滞留，避免文件 A 入账 + 文件 B 提现产生假滞留
    const byCurrency = [...ccyChainMap.values()].map((c) => {
      const signedNetFlow = r2(
        c.walletInbound + c.otherInbound + c.returnedInbound + c.internalFxNet -
        (c.corporateWithdraw + c.personalWithdraw + c.unverifiedWithdraw + c.directSpend + c.walletFees + c.frozenOutflow),
      )
      return {
        ...c,
        signedNetFlow,
        retainedOffshore: signedNetFlow > 0 ? signedNetFlow : 0,
        stage1to2Gap: hasSalesEvidence ? r2(c.walletInbound - c.platformPayout) : null,
      }
    })
    const stage1PlatformPayoutCny = hasSalesEvidence ? r2(byCurrency.reduce((acc, c) => acc + c.platformPayout * c.fx, 0)) : null
    const stage2WalletInboundCny = r2(byCurrency.reduce((acc, c) => acc + c.walletInbound * c.fx, 0))
    const stage2OtherInboundCny = r2(byCurrency.reduce((acc, c) => acc + c.otherInbound * c.fx, 0))
    const returnedInboundCny = r2(byCurrency.reduce((acc, c) => acc + c.returnedInbound * c.fx, 0))
    const stage1to2GapCny = hasSalesEvidence ? r2(stage2WalletInboundCny - stage1PlatformPayoutCny) : null
    const stage3CorporateRepatriatedCny = r2(byCurrency.reduce((acc, c) => acc + c.corporateWithdraw * c.fx, 0))
    const stage3PersonalWithdrawCny = r2(byCurrency.reduce((acc, c) => acc + c.personalWithdraw * c.fx, 0))
    const stage3UnverifiedWithdrawCny = r2(byCurrency.reduce((acc, c) => acc + c.unverifiedWithdraw * c.fx, 0))
    const directSpendCny = r2(byCurrency.reduce((acc, c) => acc + c.directSpend * c.fx, 0))
    const walletFeesCny = r2(byCurrency.reduce((acc, c) => acc + c.walletFees * c.fx, 0))
    const frozenOutflowCny = r2(byCurrency.reduce((acc, c) => acc + c.frozenOutflow * c.fx, 0))
    const internalFxNetCny = r2(byCurrency.reduce((acc, c) => acc + c.internalFxNet * c.fx, 0))
    const internalFxStrippedCny = r2(byCurrency.reduce((acc, c) => acc + c.internalFxStripped * c.fx, 0))
    const retainedOffshoreCny = r2(byCurrency.reduce((acc, c) => acc + c.retainedOffshore * c.fx, 0))
    const totalInboundCny = r2(stage2WalletInboundCny + stage2OtherInboundCny)
    const corporateRepatriationRatePct = totalInboundCny > 0 ? r2((stage3CorporateRepatriatedCny / totalInboundCny) * 100) : null

    const alerts = []
    if (stage3PersonalWithdrawCny > 0) {
      alerts.push(`【P0 优先核查 · 个人私户】检出结汇/提现流向疑似个人账户折合 ${stage3PersonalWithdrawCny.toFixed(2)} 元，存在公私混收与出口收汇核销风险，请立即核查银行回单并整改。`)
    }
    if (stage3UnverifiedWithdrawCny > 0) {
      alerts.push(`【P1 待核凭证 · 收款户性质不明】折合 ${stage3UnverifiedWithdrawCny.toFixed(2)} 元提现记录未标明企业户名标识，已排除在企业户转出占比之外，请调取国内银行收款回单确认收款主体。`)
    }
    if (hasSalesEvidence) {
      // 逐币种检验单边未匹配（防止 USD 多 + EUR 少折合人民币恰好抵消掩盖真实缺口！）
      const unmatchedCcys = byCurrency.filter((c) => Math.abs((c.stage1to2Gap || 0) * c.fx) > 100)
      if (Math.abs(stage1to2GapCny) > 100) {
        if (stage1to2GapCny < 0) {
          alerts.push(`【一/二段差额待解释】结汇通道入账较已导入销售平台放款少 ${Math.abs(stage1to2GapCny).toFixed(2)} 元，请排查跨月在途未到账、漏导其他收款通道或分流去向。`)
        } else {
          alerts.push(`【一/二段差额待解释】结汇通道入账较已导入销售平台放款多 ${stage1to2GapCny.toFixed(2)} 元，请排查是否漏导某店铺/站点销售账单或为上期在途款本期到账。`)
        }
      } else if (unmatchedCcys.length > 0) {
        const desc = unmatchedCcys.map((c) => `${c.currency} ${c.stage1to2Gap >= 0 ? '+' : ''}${c.stage1to2Gap.toFixed(2)}`).join('、')
        alerts.push(`【一/二段跨币种单边未匹配】虽然折合人民币总差较小，但分币种存在未匹配差额（${desc}），请逐币种核对平台放款与收款户入账记录。`)
      }
    }
    if (directSpendCny > 0) {
      alerts.push(`【P1 待补凭证 · 境外余额坐支】结汇账户直接支付境外供应商/物流/广告或云汇卡折合 ${directSpendCny.toFixed(2)} 元${corporateRepatriationRatePct !== null ? `（钱包转出至企业户占比 ${corporateRepatriationRatePct}%，待核银行回单）` : ''}，须补齐对应合同/发票并核对出口收汇差额。`)
    }
    if (retainedOffshoreCny > 0 && totalInboundCny > 0 && retainedOffshoreCny / totalInboundCny >= 0.25) {
      alerts.push(`【滞留境外未结汇】当期约 ${retainedOffshoreCny.toFixed(2)} 元资金滞留境外收款钱包尚未转出，若涉出口退税请关注收汇核销截止期限。`)
    }
    if (!hasSalesEvidence) {
      alerts.push(`【独立体检模式】本次仅导入第三方结汇流水（未导入电商销售账单），第一段销售放款待导入；合并拖入平台结算单可自动激活「平台放款 vs 通道入账」一/二段交叉比对。`)
    }

    fundChain = {
      mode: hasSalesEvidence ? 'three_stage_cross_check' : 'wallet_only',
      hasSalesEvidence,
      stage3VerificationStatus: 'pending_bank_receipt',
      stage3StatusNote: '钱包流水仅显示向疑似企业账户转出，无法单独证明收款账户归属本主体、位于境内或已入账；请核对国内银行收款回单（主体/日期/币种/实收金额）后再标为已复核。',
      salesSheetCount,
      walletCount: walletSheetCount,
      stage1PlatformPayoutCny,
      stage2WalletInboundCny,
      stage2OtherInboundCny,
      returnedInboundCny,
      stage1to2GapCny,
      stage3CorporateRepatriatedCny,
      stage3PersonalWithdrawCny,
      stage3UnverifiedWithdrawCny,
      directSpendCny,
      walletFeesCny,
      frozenOutflowCny,
      internalFxNetCny,
      retainedOffshoreCny,
      internalFxStrippedCny,
      corporateRepatriationRatePct,
      byCurrency,
      alerts,
    }
  }

  const rec = salesSheetCount > 0
    ? platformTaxReconcile({
        reportedGrossRevenue: grossCny,
        reportedGrossSource: 'statement_reference',
        refunds: refundCny,
        marketplaceWithheldTax: 0,
        withheldTaxIncludedInGross: false,
        platformFees: feesCny,
        subsidies: subsidyCny,
        subsidiesIncludedInGross: false,
        selfRemitTaxNet: selfRemitTaxCny,
        reserveChange: reserveCny,
        actualPayout: hasAnyPayout ? payoutCny : undefined,
        declaredVatSales: declaredVatSalesCny,
      })
    : {
        summary: '本次仅导入第三方结汇通道流水（未计入销售报送额），三段核对结论与风险提示请见资金链路分析区块。',
        steps: [],
        warnings: [],
      }

  // 以 4% 假设计得的核定收入等值作为账单初筛指标（严格仅统计销售平台净额，绝不含结汇通道入账）。
  const netSalesCny = r2(grossCny - refundCny)
  const cliffLimit = 75_000_000
  const cliffRatioPct = r2((netSalesCny / cliffLimit) * 100)
  let cliffAlert = null
  if (netSalesCny > cliffLimit) {
    cliffAlert = `【4% 核定收入等值初筛】合并报送参考净额 ${netSalesCny.toFixed(2)} 元超过 7,500 万元等值（${cliffRatioPct}%）。请按主体和纳税年度核验应纳税所得额及小型微利条件。`
  } else if (netSalesCny >= 55_000_000) {
    cliffAlert = `【4% 核定收入等值初筛】合并报送参考净额为 7,500 万元等值的 ${cliffRatioPct}%。请按主体和纳税年度复核。`
  }

  return {
    ready: true,
    breakdown,
    totals: { grossCny, refundCny, netSalesCny, feesCny, subsidyCny, selfRemitTaxCny, reserveCny, payoutCny },
    reconcile: rec,
    fundChain,
    p0Count,
    cliffRatioPct,
    cliffAlert,
  }
}
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function resolveExportTarget(exportPath, firstInputPath) {
  const raw = String(exportPath ?? '').trim()
  if (!raw) return null
  const isDemo = !firstInputPath || /^demo(?::|$)/i.test(firstInputPath)
  const baseDir = isDemo ? tmpdir() : dirname(resolve(firstInputPath))
  const stem = isDemo ? 'dsh_fintax_demo' : basename(firstInputPath, extname(firstInputPath))

  if (['auto', 'auto.html', 'html'].includes(raw.toLowerCase())) {
    return join(baseDir, `${stem}_税务初筛体检单.html`)
  }
  if (['auto.md', 'md', 'markdown'].includes(raw.toLowerCase())) {
    return join(baseDir, `${stem}_税务初筛体检单.md`)
  }
  if (['auto.csv', 'csv'].includes(raw.toLowerCase())) {
    return join(baseDir, `${stem}_异常排雷清单.csv`)
  }
  return resolve(raw)
}

/** 将含 BigInt 金额的账单摘要安全序列化为前端工作台可读的精确 JSON 对象。 */
export function serializeSummary(s) {
  const base = {
    role: s.role || 'sales_platform',
    period: s.period,
    platform: s.platform,
    site: s.site,
    currency: s.currency,
    formatLabel: s.formatLabel,
    fileName: s.fileName,
    rawRowCount: s.rawRowCount,
    grossSales: fmtAmount(s.grossSales),
    sellerDiscount: fmtAmount(s.sellerDiscount),
    taxReportingGrossRef: fmtAmount(s.taxReportingGrossRef),
    taxReportingGrossRefSource: s.taxReportingGrossRefSource,
    platformSubsidy: fmtAmount(s.platformSubsidy),
    customerRefund: fmtAmount(s.customerRefund),
    totalFees: fmtAmount(s.totalFees),
    platformCommission: fmtAmount(s.platformCommission),
    affiliateCommission: fmtAmount(s.affiliateCommission),
    logisticsWarehousing: fmtAmount(s.logisticsWarehousing),
    inPlatformAds: fmtAmount(s.inPlatformAds),
    gatewayDisputeFee: fmtAmount(s.gatewayDisputeFee),
    facilitatorTaxStripped: fmtAmount(s.facilitatorTaxStripped),
    selfRemitTaxNet: fmtAmount(s.selfRemitTaxNet),
    reserveNetChange: fmtAmount(s.reserveNetChange),
    theoreticalPayout: fmtAmount(s.theoreticalPayout),
    actualPayout: fmtAmount(s.actualPayout),
    statementPayoutDiff: fmtAmount(s.statementPayoutDiff),
    statementPayoutDiffFormula: s.statementPayoutDiffFormula,
    uncapturedVoidExcluded: fmtAmount(s.uncapturedVoidExcluded),
    freeSampleCount: s.freeSampleCount || 0,
    horizontalDiffTotal: fmtAmount(s.horizontalDiffTotal),
    horizontalBalanced: s.horizontalDiffTotal === 0n,
    anomalies: s.anomalies || [],
  }
  if (s.walletMetrics) {
    const wm = s.walletMetrics
    base.walletMetrics = {
      platformInbound: fmtAmount(wm.platformInbound || 0n),
      otherInbound: fmtAmount(wm.otherInbound || 0n),
      returnedInbound: fmtAmount(wm.returnedInbound || 0n),
      fxWithdrawToCorporate: fmtAmount(wm.fxWithdrawToCorporate || 0n),
      fxWithdrawToPersonal: fmtAmount(wm.fxWithdrawToPersonal || 0n),
      unverifiedWithdraw: fmtAmount(wm.unverifiedWithdraw || 0n),
      directSpend: fmtAmount(wm.directSpend || 0n),
      walletFees: fmtAmount(wm.walletFees || 0n),
      internalFxStripped: fmtAmount(wm.internalFxStripped || 0n),
      internalFxNet: fmtAmount(wm.internalFxNet || 0n),
      internalFxCount: wm.internalFxCount || 0,
      frozenOutflow: fmtAmount(wm.frozenOutflow || 0n),
      frozenOrReturned: fmtAmount(wm.frozenOrReturned || 0n),
      voidExcludedCount: wm.voidExcludedCount || 0,
      netVerifiedRows: wm.netVerifiedRows || 0,
      unrepatriatedNet: fmtAmount(wm.unrepatriatedNet || 0n),
      signedNetFlow: fmtAmount(wm.signedNetFlow || 0n),
    }
  }
  return base
}

function buildReportContext(summaries) {
  const allAnoms = summaries.flatMap((s) =>
    s.anomalies.map((a) => ({ ...a, scope: `${s.platform}·${s.site}(${s.currency})` })),
  )
  const p0 = allAnoms.filter((a) => a.severity.startsWith('P0'))
  const p1 = allAnoms.filter((a) => a.severity.startsWith('P1'))
  const p2 = allAnoms.filter((a) => a.severity.startsWith('P2'))
  const totalRows = summaries.reduce((acc, s) => acc + s.rawRowCount, 0)
  const genTime = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const overallBadge =
    p0.length > 0
      ? { level: 'P0 阻断级风险（申报前须先剥离/修正）', color: '#DC2626', bg: '#FEF2F2' }
      : p1.length > 0
        ? { level: 'P1 高危涉税预警（须核对桥接口径与凭证）', color: '#D97706', bg: '#FFFBEB' }
        : { level: '初筛勾稽平衡（未检出阻断与高危项）', color: '#15803D', bg: '#F0FDF4' }
  return { allAnoms, p0, p1, p2, totalRows, genTime, overallBadge }
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八']

export function inferNextAction(anom) {
  const txt = `${anom?.category || ''} ${anom?.detail || ''}`
  if (/个人私户|私卡|公私混收/.test(txt)) {
    return '补核个人卡收款流水及往来性质说明；按企业对公收汇规范整改，若属分红或借款请核实个税与协议'
  }
  if (/收款户性质待核|待核银行回单|主体待核/.test(txt)) {
    return '调取银行入账回单，核验户名是否属于本境内经营主体、入账日期、币种及实收金额'
  }
  if (/坐支|广告|供应商|物流/.test(txt)) {
    return '补齐境外费用发票、广告账单或采购合同及支付水单，单独列支成本费用，勿直接冲减收入'
  }
  if (/非标准|其他入账|漏导/.test(txt)) {
    return '核实付款方身份与资金来源，确认是否漏导销售平台账单、退税款或关联方往来'
  }
  if (/全托管|供货/.test(txt)) {
    return '将全托管供货结算单从自营零售清单剥离，按国内供货/一般贸易开票口径单独核算'
  }
  if (/自申报|流转税|VAT|Sales Tax/i.test(txt)) {
    return '核对境外税局申报表及缴款回单，代收待缴税款计入往来科目，勿混入主营业务收入'
  }
  if (/冻结|退回|准备金|Reserve/i.test(txt)) {
    return '留存平台/通道冻结或退汇通知，跨期跟踪后续解冻释放或重新打款记录'
  }
  if (/水平守恒|不平衡|差额/.test(txt)) {
    return '回到原表定位对应单号行，排查是否存在未映射新费用列、跨月在途放款或手续费差额'
  }
  return '回到原始账单核对对应单号明细，补齐业务佐证凭证后再标注已复核'
}

export function renderDiagnosticReportMd({ summaries, consolidated, version = '0.8.1', includeResourceAppendix = false }) {
  const { allAnoms, p0, p1, p2, totalRows, genTime, overallBadge } = buildReportContext(summaries)
  const salesSummaries = summaries.filter((s) => s.role !== 'settlement_wallet')
  const walletSummaries = summaries.filter((s) => s.role === 'settlement_wallet')
  const periods = [...new Set(summaries.map((s) => s.period).filter(Boolean))].join(' / ') || '未识别'
  let sec = 0
  const nextSec = () => `${CN_NUM[sec++] || sec}、`

  const md = [
    `# 跨境月结核对单（原始账单离线初筛）`,
    ``,
    `> **核查结论**：**${overallBadge.level}**（P0 优先核查 ${p0.length} 项 · P1 待补凭证 ${p1.length} 项 · P2 关注 ${p2.length} 项；注：P0/P1 表示核查优先级）  `,
    `> **生成引擎**：\`dsh-fintax v${version}\`（BigInt 本地离线初筛）｜**生成时间**：${genTime}｜**识别账期**：${periods}｜**覆盖文件**：${summaries.length} 份（${totalRows} 行明细）`,
    ``,
    `## ${nextSec()}本期核对范围与老板一页结论`,
    `- **已核对销售账单（${salesSummaries.length} 份）**：${salesSummaries.length ? salesSummaries.map((s) => `${s.platform}·${s.site}(${s.currency}, ${s.fileName})`).join('；') : '本次未导入销售平台账单'}`,
    `- **已核对结汇流水（${walletSummaries.length} 份）**：${walletSummaries.length ? walletSummaries.map((s) => `${s.platform}·${s.site}(${s.currency}, ${s.fileName})`).join('；') : '本次未导入第三方结汇流水'}`,
  ]
  if (consolidated?.ready) {
    const fc = consolidated.fundChain
    const salesLine = salesSummaries.length
      ? `报送参考净额 \`¥${consolidated.totals.netSalesCny.toFixed(2)}\` ｜ 平台放款 \`¥${consolidated.totals.payoutCny.toFixed(2)}\``
      : '未导入销售账单'
    const walletLine = fc
      ? ` ｜ 钱包平台入账 \`¥${fc.stage2WalletInboundCny.toFixed(2)}\` ｜ 钱包转出至企业户（待核银行回单）\`¥${fc.stage3CorporateRepatriatedCny.toFixed(2)}\``
      : ''
    md.push(`- **本期已对齐参考额**：${salesLine}${walletLine}`)
    if (fc && fc.hasSalesEvidence && fc.stage1to2GapCny !== 0) {
      md.push(`- **待解释跨段差额**：一/二段差额（②钱包入账 − ①平台放款）\`¥${fc.stage1to2GapCny.toFixed(2)}\`，请优先排查跨月在途放款、提现手续费或漏导账户。`)
    }
  }
  md.push(
    `- **下一步派活摘要**：${allAnoms.length ? `共检出 ${allAnoms.length} 项待核事项（P0 ${p0.length} / P1 ${p1.length} / P2 ${p2.length}），详见下方「财务待核派活清单」。` : '本次覆盖的账单明细未检出 P0/P1/P2 异常，仍请按银行入账回单复核对公实收。'}`,
    ``,
  )
  if (salesSummaries.length > 0) {
    md.push(
      `## ${nextSec()}各平台／站点原币报送参考与结算项目`,
      `| 平台·站点 | 期间 | 币种 | ①商品含运费原价 | ★报送参考毛收入(①-②) | ④客户退款 | ⑤~⑨佣金与履约费 | 待自申报境外税 | 实际打款 | 水平守恒 |`,
      `|---|---|---|---:|---:|---:|---:|---:|---:|---|`,
      ...salesSummaries.map(
        (s) =>
          `| ${s.platform}·${s.site} | ${s.period} | ${s.currency} | ${fmtAmount(s.grossSales)} | **${fmtAmount(s.taxReportingGrossRef)}** | ${fmtAmount(s.customerRefund)} | ${fmtAmount(s.totalFees)} | ${fmtAmount(s.selfRemitTaxNet)} | ${fmtAmount(s.actualPayout)} | ${s.horizontalDiffTotal === 0n ? '✔ 通过' : '❌ 失衡'} |`,
      ),
      ``,
    )
  }
  if (walletSummaries.length > 0) {
    md.push(
      `## ${nextSec()}结汇收款通道原币资金流水拆解（不重复计入销售报送额）`,
      `| 结汇通道 | 期间 | 币种 | 平台回款入账 | 转出企业户(待核回单) | 个人私户(P0) | 待核提现(P1) | 境外坐支(P1) | 手续费 | 滞留未结汇 |`,
      `|---|---|---|---:|---:|---:|---:|---:|---:|---:|`,
      ...walletSummaries.map((s) => {
        const wm = s.walletMetrics || {}
        return `| ${s.platform}·${s.site} | ${s.period} | ${s.currency} | ${fmtAmount(wm.platformInbound || 0n)} | **${fmtAmount(wm.fxWithdrawToCorporate || 0n)}** | ${fmtAmount(wm.fxWithdrawToPersonal || 0n)} | ${fmtAmount(wm.unverifiedWithdraw || 0n)} | ${fmtAmount(wm.directSpend || 0n)} | ${fmtAmount(wm.walletFees || 0n)} | ${fmtAmount(wm.unrepatriatedNet || 0n)} |`
      }),
      ``,
    )
  }
  if (consolidated?.fundChain) {
    const fc = consolidated.fundChain
    const s1Txt = fc.hasSalesEvidence ? `\`¥${fc.stage1PlatformPayoutCny.toFixed(2)}\`` : '待导入销售账单'
    const gapTxt = fc.hasSalesEvidence ? `\`¥${fc.stage1to2GapCny.toFixed(2)}\`` : '待核对'
    const rateTxt = fc.corporateRepatriationRatePct !== null ? `**${fc.corporateRepatriationRatePct}%**` : '待核'
    md.push(
      `## ${nextSec()}三段资金链路交叉核对（平台放款 → 结汇通道 → 钱包转出至企业户[待核银行回单]）`,
      `- ① 销售平台实际放款合计：${s1Txt} ｜ ② 结汇通道平台入账合计：\`¥${fc.stage2WalletInboundCny.toFixed(2)}\`${fc.stage2OtherInboundCny > 0 ? `（另含其他入账 \`¥${fc.stage2OtherInboundCny.toFixed(2)}\`）` : ''} ｜ 一/二段差额（②−①）：${gapTxt}`,
      `- ③ 钱包显示转出至企业户（待核银行回单）：\`¥${fc.stage3CorporateRepatriatedCny.toFixed(2)}\`（企业户转出占比 ${rateTxt}）｜个人私户提现(P0)：\`¥${fc.stage3PersonalWithdrawCny.toFixed(2)}\`｜待核提现(P1)：\`¥${(fc.stage3UnverifiedWithdrawCny || 0).toFixed(2)}\`｜境外余额坐支(P1)：\`¥${fc.directSpendCny.toFixed(2)}\`｜滞留未结汇：\`¥${fc.retainedOffshoreCny.toFixed(2)}\`｜手续费：\`¥${fc.walletFeesCny.toFixed(2)}\``,
      ...(fc.stage3StatusNote ? [`- 口径提示：${fc.stage3StatusNote}`] : []),
      ...fc.alerts.map((a) => `- ${a}`),
      ``,
    )
  }
  if (consolidated?.ready && salesSummaries.length > 0) {
    md.push(`## ${nextSec()}多表合并人民币折算与申报比对诊断`)
    for (const st of consolidated.reconcile.steps) md.push(`- ${st}`)
    for (const w of consolidated.reconcile.warnings) md.push(`- ⚠ **预警**：${w}`)
    if (consolidated.cliffAlert) md.push(`- ${consolidated.cliffAlert}`)
    md.push(``)
  }
  md.push(`## ${nextSec()}财务待核派活清单（P0 优先: ${p0.length}｜P1 待核: ${p1.length}｜P2 关注: ${p2.length}）`)
  if (!allAnoms.length) md.push(`- ✔ 本次覆盖账单未检出异常交易记录；仍请结合银行入账回单完成对公实收复核。`)
  for (const a of [...p0, ...p1, ...p2].slice(0, 30)) {
    md.push(`- **[${a.severity}] [${a.scope}] ${a.category}**（单号 \`${a.refId}\`，金额 \`${a.amount}\`）：${a.detail}`)
    md.push(`  - 下一步待补凭证：${inferNextAction(a)}`)
  }
  md.push(
    ``,
    `## ${nextSec()}口径边界与核验声明`,
    `1. **四套口径区分**：平台涉税信息报送（国家税务总局公告2025年第15号，由平台按季报送；佣金不直接从报送收入总额扣除）、财务会计收入、增值税申报与企业所得税口径须分别勾稽，切勿直接按银行回款净额申报收入。`,
    `2. **本机初筛边界**：本核对单由本机离线基于已导入账单生成，钱包侧「转出至企业户」仅据收款户名特征归类，须经财务核对银行入账回单（主体、日期、币种、实收金额）后方可确认为已复核。`,
  )
  if (includeResourceAppendix) {
    md.push(
      `3. **扩展参考附页（由导出者勾选附带）**：可在 DSH 侧边栏「财税工作台」按需绑定腾讯 IMA 实战知识库检索现行政策与差额复核 SOP，或结合《跨境电商月结四层口径一表通母表》持续跟进跨期差额与关账底稿。`,
    )
  }
  return md.join('\n')
}

export function renderDiagnosticReportHtml({ summaries, consolidated, version = '0.8.1', includeResourceAppendix = false }) {
  const { allAnoms, p0, p1, p2, totalRows, genTime, overallBadge } = buildReportContext(summaries)
  const salesSummaries = summaries.filter((s) => s.role !== 'settlement_wallet')
  const walletSummaries = summaries.filter((s) => s.role === 'settlement_wallet')
  const periods = [...new Set(summaries.map((s) => s.period).filter(Boolean))].join(' / ') || '未识别'
  let sec = 0
  const nextSec = () => `${CN_NUM[sec++] || sec}、`

  const fc = consolidated?.fundChain
  const fmtY = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const bossSummaryHtml = `<div class="card" style="background:#FAF9F5;border-color:#94A3B8">
    <h2>${nextSec()}本期核对范围与老板一页结论</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
      <div style="border:1px solid #CBD5E1;padding:10px 12px;background:#FFF">
        <div style="font-size:12px;color:#475569">本期覆盖账期与文件</div>
        <div style="font-size:15px;font-weight:800;margin-top:4px">${esc(periods)}</div>
        <div style="font-size:12px;color:#64748B;margin-top:3px">销售表 ${salesSummaries.length} 份 · 结汇流水 ${walletSummaries.length} 份 · 共 ${totalRows} 行</div>
      </div>
      <div style="border:1px solid #CBD5E1;padding:10px 12px;background:#FFF">
        <div style="font-size:12px;color:#475569">${consolidated?.ready && salesSummaries.length ? '报送参考净额 / 平台放款' : '钱包入账 / 转出企业户(待核回单)'}</div>
        <div class="num" style="font-size:15px;font-weight:800;text-align:left;margin-top:4px">${consolidated?.ready
          ? (salesSummaries.length
              ? `${fmtY(consolidated.totals.netSalesCny)} / ${fmtY(consolidated.totals.payoutCny)}`
              : fc ? `${fmtY(fc.stage2WalletInboundCny)} / ${fmtY(fc.stage3CorporateRepatriatedCny)}` : '待补汇率')
          : '待补汇率折算'}</div>
        <div style="font-size:12px;color:#64748B;margin-top:3px">${fc && fc.hasSalesEvidence ? `一/二段差额（②−①）：${fmtY(fc.stage1to2GapCny)}` : '对外交接前请核验对应银行入账回单'}</div>
      </div>
      <div style="border:1px solid ${p0.length > 0 ? '#FECACA' : p1.length > 0 ? '#FDE68A' : '#BBF7D0'};padding:10px 12px;background:${p0.length > 0 ? '#FEF2F2' : p1.length > 0 ? '#FFFBEB' : '#F0FDF4'}">
        <div style="font-size:12px;color:#475569">待补凭证与优先核查事项</div>
        <div style="font-size:15px;font-weight:800;color:${p0.length > 0 ? '#B91C1C' : p1.length > 0 ? '#B45309' : '#15803D'};margin-top:4px">P0 ${p0.length} 项 · P1 ${p1.length} 项 · P2 ${p2.length} 项</div>
        <div style="font-size:12px;color:#475569;margin-top:3px">${allAnoms.length ? '注：P0/P1 表示核查优先级，详见下方派活清单' : '本次覆盖明细无异常，仍须核对银行回单实收'}</div>
      </div>
    </div>
    <div style="font-size:12.5px;color:#334155;line-height:1.65">
      <div><b>本次已核对销售账单：</b>${salesSummaries.length ? esc(salesSummaries.map((s) => `${s.platform}·${s.site}(${s.currency}) [${s.fileName}]`).join('；')) : '无（未导入销售平台账单）'}</div>
      <div><b>本次已核对结汇流水：</b>${walletSummaries.length ? esc(walletSummaries.map((s) => `${s.platform}·${s.site}(${s.currency}) [${s.fileName}]`).join('；')) : '无（未导入第三方结汇流水）'}</div>
    </div>
  </div>`

  const rowsHtml = salesSummaries
    .map(
      (s) => `<tr>
      <td><b>${esc(s.platform)} · ${esc(s.site)}</b><br/><span style="color:#64748B;font-size:12px">${esc(s.fileName)}</span></td>
      <td>${esc(s.period)}</td><td><b>${esc(s.currency)}</b></td>
      <td class="num">${fmtAmount(s.grossSales)}</td>
      <td class="num hi">${fmtAmount(s.taxReportingGrossRef)}</td>
      <td class="num">${fmtAmount(s.customerRefund)}</td>
      <td class="num">${fmtAmount(s.totalFees)}</td>
      <td class="num">${fmtAmount(s.selfRemitTaxNet)}</td>
      <td class="num">${fmtAmount(s.actualPayout)}</td>
      <td>${s.horizontalDiffTotal === 0n ? '<span style="color:#15803D;font-weight:700">✔ 守恒</span>' : '<span style="color:#DC2626;font-weight:700">❌ 失衡</span>'}</td>
    </tr>`,
    )
    .join('')

  const salesCardHtml = salesSummaries.length
    ? `<div class="card"><h2>${nextSec()}各站点原币报送参考与结算项目（精确到 0.01）</h2>
        <table><thead><tr><th>平台·站点</th><th>期间</th><th>币种</th><th class="num">①商品含运费</th><th class="num">★报送参考毛额</th><th class="num">④客户退款</th><th class="num">⑤~⑨平台履约费</th><th class="num">⑩待自报税</th><th class="num">实际放款</th><th>守恒</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      </div>`
    : ''

  const walletTableHtml = walletSummaries.length
    ? `<div class="card"><h2>${nextSec()}结汇收款通道资金拆解（不重复计入销售报送额）</h2>
        <table><thead><tr><th>结汇通道</th><th>期间</th><th>币种</th><th class="num">平台入账</th><th class="num">转出企业户(待核回单)</th><th class="num">私户(P0)</th><th class="num">待核提现</th><th class="num">坐支(P1)</th><th class="num">手续费</th><th class="num">滞留未结汇</th></tr></thead><tbody>${walletSummaries
          .map((s) => {
            const wm = s.walletMetrics || {}
            return `<tr>
              <td><b>${esc(s.platform)} · ${esc(s.site)}</b><br/><span style="color:#64748B;font-size:12px">${esc(s.fileName)}</span></td>
              <td>${esc(s.period)}</td><td><b>${esc(s.currency)}</b></td>
              <td class="num">${fmtAmount(wm.platformInbound || 0n)}</td>
              <td class="num" style="color:#15803D;font-weight:700">${fmtAmount(wm.fxWithdrawToCorporate || 0n)}</td>
              <td class="num" style="color:${(wm.fxWithdrawToPersonal || 0n) > 0n ? '#DC2626;font-weight:800' : '#475569'}">${fmtAmount(wm.fxWithdrawToPersonal || 0n)}</td>
              <td class="num" style="color:${(wm.unverifiedWithdraw || 0n) > 0n ? '#B45309;font-weight:700' : '#475569'}">${fmtAmount(wm.unverifiedWithdraw || 0n)}</td>
              <td class="num" style="color:${(wm.directSpend || 0n) > 0n ? '#B45309;font-weight:700' : '#475569'}">${fmtAmount(wm.directSpend || 0n)}</td>
              <td class="num">${fmtAmount(wm.walletFees || 0n)}</td>
              <td class="num">${fmtAmount(wm.unrepatriatedNet || 0n)}</td>
            </tr>`
          })
          .join('')}</tbody></table>
      </div>`
    : ''

  const fundChainHtml = fc
    ? `<div class="card"><h2>${nextSec()}三段资金链路交叉核对（平台放款 → 结汇通道 → 钱包转出至企业户[待核银行回单]）</h2>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px">
          <div style="border:1px solid #CBD5E1;padding:10px;background:#F8FAFC"><div style="font-size:12px;color:#475569">① 销售平台实际放款</div><div class="num" style="font-size:16px;font-weight:800;text-align:left;margin-top:4px">${fc.hasSalesEvidence ? `¥${fc.stage1PlatformPayoutCny.toFixed(2)}` : '待导入销售账单'}</div></div>
          <div style="border:1px solid #CBD5E1;padding:10px;background:#F8FAFC"><div style="font-size:12px;color:#475569">② 结汇通道入账${fc.hasSalesEvidence ? `（差 ¥${fc.stage1to2GapCny.toFixed(2)}）` : ''}${fc.stage2OtherInboundCny > 0 ? ` +其他 ¥${fc.stage2OtherInboundCny.toFixed(2)}` : ''}</div><div class="num" style="font-size:16px;font-weight:800;text-align:left;margin-top:4px">¥${fc.stage2WalletInboundCny.toFixed(2)}</div></div>
          <div style="border:1px solid #86EFAC;padding:10px;background:#F0FDF4"><div style="font-size:12px;color:#15803D">③ 转出至企业户·待核回单（${fc.corporateRepatriationRatePct !== null ? `${fc.corporateRepatriationRatePct}%` : '待核'}）</div><div class="num" style="font-size:16px;font-weight:800;color:#15803D;text-align:left;margin-top:4px">¥${fc.stage3CorporateRepatriatedCny.toFixed(2)}</div></div>
          <div style="border:1px solid ${fc.stage3PersonalWithdrawCny > 0 ? '#FECACA' : '#CBD5E1'};padding:10px;background:${fc.stage3PersonalWithdrawCny > 0 ? '#FEF2F2' : '#F8FAFC'}"><div style="font-size:12px;color:${fc.stage3PersonalWithdrawCny > 0 ? '#B91C1C' : '#475569'}">私户 P0 / 待核 / 坐支 P1</div><div class="num" style="font-size:14px;font-weight:800;color:${fc.stage3PersonalWithdrawCny > 0 ? '#DC2626' : '#0F172A'};text-align:left;margin-top:4px">¥${fc.stage3PersonalWithdrawCny.toFixed(2)} / ¥${(fc.stage3UnverifiedWithdrawCny || 0).toFixed(2)} / ¥${fc.directSpendCny.toFixed(2)}</div></div>
        </div>
        ${fc.stage3StatusNote ? `<div style="font-size:12px;color:#475569;padding:6px 10px;background:#F8FAFC;border-left:3px solid #64748B;margin-bottom:6px">${esc(fc.stage3StatusNote)}</div>` : ''}
        ${fc.alerts.map((a) => `<div style="font-size:13px;margin-top:5px;color:${a.includes('P0') ? '#B91C1C;font-weight:700' : a.includes('P1') || a.includes('差额') || a.includes('未匹配') ? '#B45309;font-weight:700' : '#334155'}">${esc(a)}</div>`).join('')}
      </div>`
    : ''

  const consHtml = consolidated?.ready && salesSummaries.length > 0
    ? `<div class="card"><h2>${nextSec()}多表合并人民币初筛与申报比对</h2>
        <ul>${consolidated.reconcile.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ul>
        ${consolidated.reconcile.warnings.map((w) => `<div style="color:#B45309;font-weight:700;margin-top:6px">⚠ ${esc(w)}</div>`).join('')}
        ${consolidated.cliffAlert ? `<div style="color:#B91C1C;font-weight:800;margin-top:8px;padding:8px 12px;background:#FEF2F2;border-radius:6px">${esc(consolidated.cliffAlert)}</div>` : ''}
      </div>`
    : ''

  const anomHtml = allAnoms.length
    ? [...p0, ...p1, ...p2]
        .slice(0, 30)
        .map((a) => {
          const c = a.severity.startsWith('P0') ? '#DC2626' : a.severity.startsWith('P1') ? '#D97706' : '#2563EB'
          return `<div class="anom-row" style="border-left:4px solid ${c};background:#F8FAFC;padding:10px 14px;margin-bottom:8px;border-radius:6px">
            <div style="font-weight:700;color:${c}">[${esc(a.severity)}] [${esc(a.scope)}] ${esc(a.category)} <span style="color:#475569;font-family:monospace;font-size:12px">(${esc(a.refId)} | ${esc(a.amount)})</span></div>
            <div style="font-size:13px;color:#334155;margin-top:3px">${esc(a.detail)}</div>
            <div style="font-size:12.5px;color:#0F172A;margin-top:5px;padding-top:5px;border-top:1px dashed #CBD5E1"><b>下一步待补凭证：</b>${esc(inferNextAction(a))}</div>
          </div>`
        })
        .join('')
    : '<div style="color:#15803D;font-weight:700">✔ 全部明细行扫描完毕，未检出异常交易记录（仍请对照银行回单复核对公实收）。</div>'

  const anomSectionTitle = `${nextSec()}财务待核派活清单与待补凭证`
  const appendixHtml = includeResourceAppendix
    ? `<br/>3. <b>扩展参考附页（由导出者勾选附带）</b>：可在 DSH 侧边栏「财税工作台」按需绑定腾讯 IMA 实战知识库检索现行政策与差额复核 SOP，或结合《跨境电商月结四层口径一表通母表》持续跟进跨期差额。`
    : ''

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/>
<title>跨境月结核对单 — dsh-fintax</title>
<style>
  body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:#F1F5F9;color:#0F172A;margin:0;padding:28px}
  .page{max-width:1080px;margin:0 auto;background:#FFF;border:2px solid #0F172A;padding:32px 36px}
  h1{font-size:24px;margin:0 0 8px;letter-spacing:-0.3px} h2{font-size:17px;margin:0 0 12px;border-left:4px solid #0F172A;padding-left:10px}
  .meta{font-size:13px;color:#475569;margin-bottom:18px}
  .banner{padding:14px 18px;background:${overallBadge.bg};color:${overallBadge.color};font-weight:800;font-size:16px;margin-bottom:20px;border:2px solid ${overallBadge.color}}
  .card{border:1.5px solid #CBD5E1;padding:18px 20px;margin-bottom:18px}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{border-bottom:1px solid #E2E8F0;padding:9px 8px;text-align:left}
  th{background:#F8FAFC;color:#0F172A;font-weight:700;border-bottom:2px solid #0F172A} .num{text-align:right;font-family:Consolas,monospace;font-variant-numeric:tabular-nums} .hi{color:#1D4ED8;font-weight:800}
  ul{margin:0;padding-left:18px;font-size:13.5px;line-height:1.65}
  .footer{background:#0F172A;color:#F8FAFC;padding:16px 20px;font-size:13px;line-height:1.65}
  @media print{body{background:#FFF;padding:0}.page{border:none;padding:10px}thead{display:table-header-group}tr,.card,.anom-row,.footer{break-inside:avoid;page-break-inside:avoid}}
</style></head><body><div class="page">
  <h1>跨境月结核对单（原始账单本机初筛）</h1>
  <div class="meta">生成工具：DeepSeek Harness 财税工作台 (dsh-fintax v${esc(version)}) ｜ 生成时间：${genTime} ｜ 识别账期：${esc(periods)} ｜ 扫描范围：${summaries.length} 张账单 / 共 ${totalRows} 行明细（本地离线核算，原始账单未上传）</div>
  <div class="banner">核查结论：${esc(overallBadge.level)}（P0 优先核查 ${p0.length} 项 · P1 待补凭证 ${p1.length} 项 · P2 关注 ${p2.length} 项）</div>
  ${bossSummaryHtml}
  ${salesCardHtml}
  ${walletTableHtml}
  ${fundChainHtml}
  ${consHtml}
  <div class="card"><h2>${anomSectionTitle}</h2>${anomHtml}</div>
  <div class="footer">
    <b>口径边界与核验声明：</b><br/>
    1. <b>严禁混用四套口径</b>：平台涉税信息报送（国家税务总局公告2025年第15号，由平台按季报送，佣金不直接从报送收入总额扣除）、财务会计收入、增值税申报与企业所得税口径须分别勾稽，严禁直接按银行回款净额申报收入。<br/>
    2. <b>本机初筛与回单核验边界</b>：本核对单仅基于已导入账单本机离线生成，供内部月结核对与待补凭证跟进；钱包侧「转出至企业户」仅据收款户名特征归类，须财务核对银行入账回单（主体、日期、币种、实收金额）后方可确认为已复核。${appendixHtml}
  </div>
</div></body></html>`
}

export function exportDiagnosticReport({ summaries, consolidated, exportPath, firstInputPath, version = '0.8.1', includeResourceAppendix = false }) {
  const target = resolveExportTarget(exportPath, firstInputPath)
  if (!target) return null
  mkdirSync(dirname(target), { recursive: true })
  const lower = target.toLowerCase()
  const content = lower.endsWith('.csv')
    ? renderAnomaliesCsv({ summaries })
    : lower.endsWith('.md')
      ? renderDiagnosticReportMd({ summaries, consolidated, version, includeResourceAppendix })
      : renderDiagnosticReportHtml({ summaries, consolidated, version, includeResourceAppendix })
  writeFileSync(target, content, 'utf8')
  return target
}

function csvCell(v) {
  const s = String(v ?? '').replace(/\r?\n/g, ' ')
  // 防止 Excel 公式注入（以 =/+/-/@ 开头的异常文本加单引号转义，纯数字除外）
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s) ? `'${s}` : s
  return /[",]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * 导出全量异常排雷清单 CSV（UTF-8 BOM，Excel 双击不乱码）。
 * 严守商业护城河：仅含待核查异常项、排雷说明与待补凭证指引，绝不包含正式关账母表公式或会计借贷分录。
 */
export function renderAnomaliesCsv({ summaries }) {
  const all = (summaries || []).flatMap((s) =>
    (s.anomalies || []).map((a) => ({
      severity: a.severity || '',
      platform: s.platform || '',
      site: s.site || '',
      currency: s.currency || '',
      fileName: s.fileName || '',
      category: a.category || '',
      refId: a.refId || '',
      amount: a.amount || '',
      detail: a.detail || '',
      nextAction: inferNextAction(a),
    })),
  )
  const rank = (sev) => (sev.startsWith('P0') ? 0 : sev.startsWith('P1') ? 1 : 2)
  all.sort((a, b) => rank(a.severity) - rank(b.severity))

  const rows = [
    ['核查优先级', '平台', '站点', '币种', '来源文件', '异常类别', '参考单号', '异常金额(原币)', '命中原因与说明', '下一步待补凭证'],
    ...all.map((a) => [a.severity, a.platform, a.site, a.currency, a.fileName, a.category, a.refId, a.amount, a.detail, a.nextAction]),
  ]
  if (all.length === 0) {
    rows.push(['正常', '-', '-', '-', '-', '无异常项', '-', '0.00', '全部明细行扫描完毕，未检出 P0/P1/P2 异常记录', '对照银行入账回单完成对公实收复核'])
  }
  rows.push(['声明', '-', '-', '-', '-', '初筛边界说明', '-', '-', '本清单仅用于内部异常交易排雷与待补凭证跟进，非正式月结关账底稿或会计凭证', '-'])
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}


/**
 * 导出 12 个月滚动财税风控趋势月报（独立可打印 A4 HTML，Braun 工业仪器风排版）。
 * 仅使用 fintax_history.json 中的脱敏月度 KPI 汇总，绝不含原始订单明细、会计分录或私域母表公式。
 */
export function renderRollingTrendReportHtml({ history = [], rolling12m = null, version = '0.8.1' } = {}) {
  const genTime = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const r = rolling12m || {
    snapshotCount: 0, monthCount: 0, missingMonthsCount: 12, zeroSalesMonthsCount: 0, activeEntity: '', entities: [],
    windowStart: '', windowEnd: '', taxYear: '', taxYearMonthCount: 0, taxYearNetSalesCny: 0,
    taxYearCliff75mPct: 0, taxYearCliff75mRemainWan: 7500,
    totalGrossCny: 0, totalRefundCny: 0, totalNetSalesCny: 0, totalFeesCny: 0, totalPayoutCny: 0,
    totalP0: 0, totalP1: 0, cliff75mPct: 0, cliff75mRemainWan: 7500, cliff75mLevel: 'safe',
    threshold5mPct: 0, threshold5mRemainWan: 500, threshold5mLevel: 'safe', monthlySeries: [],
  }
  const series = Array.isArray(r.monthlySeries) ? r.monthlySeries : []
  const maxVal = Math.max(1, ...series.map((m) => Math.max(Math.abs(Number(m.netSalesCny || 0)), Math.abs(Number(m.payoutCny || 0)))))
  const fmtCny = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtWan = (n) => `${(Number(n || 0) / 10000).toFixed(2)} 万`

  // 纯内联 SVG 12 个月净销售 vs 实际回款趋势柱状图（双序列联合量程、零值不画假柱、负净销标零轴下提醒）
  const svgW = 860
  const svgH = 228
  const padL = 62
  const padR = 20
  const padT = 22
  const padB = 38
  const plotW = svgW - padL - padR
  const plotH = svgH - padT - padB
  const barStep = series.length ? plotW / Math.max(series.length, 6) : plotW / 6
  const barsSvg = series.length
    ? series
        .map((m, i) => {
          const cx = padL + i * barStep + barStep * 0.14
          const bw = Math.max(12, Math.min(34, barStep * 0.34))
          const netVal = Number(m.netSalesCny || 0)
          const payVal = Number(m.payoutCny || 0)
          const netH = netVal > 0 ? Math.max(3, (netVal / maxVal) * plotH) : 0
          const payH = payVal > 0 ? Math.max(3, (payVal / maxVal) * plotH) : 0
          const yNet = padT + plotH - netH
          const yPay = padT + plotH - payH
          const lbl = esc(String(m.month || '').slice(2))
          const hasP0 = Number(m.p0Count || 0) > 0
          const negBar = netVal < 0 ? `<rect x="${cx.toFixed(1)}" y="${(padT + plotH + 1).toFixed(1)}" width="${bw.toFixed(1)}" height="8" fill="#DC2626" rx="1"/>` : ''
          return `<g>
            ${netH > 0 ? `<rect x="${cx.toFixed(1)}" y="${yNet.toFixed(1)}" width="${bw.toFixed(1)}" height="${netH.toFixed(1)}" fill="${hasP0 ? '#C54B1E' : '#3F5E39'}" rx="2"/>` : negBar}
            ${payH > 0 ? `<rect x="${(cx + bw + 3).toFixed(1)}" y="${yPay.toFixed(1)}" width="${bw.toFixed(1)}" height="${payH.toFixed(1)}" fill="#8A8E80" rx="2"/>` : ''}
            <text x="${(cx + bw + 1.5).toFixed(1)}" y="${(padT + plotH + 22).toFixed(1)}" text-anchor="middle" font-size="11" fill="#4E514A" font-family="Consolas,monospace">${lbl}</text>
            <text x="${(cx + bw / 2).toFixed(1)}" y="${(Math.min(yNet, padT + plotH) - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#1C1E1B" font-family="Consolas,monospace">${(netVal / 10000).toFixed(1)}w</text>
          </g>`
        })
        .join('')
    : `<text x="${svgW / 2}" y="${svgH / 2}" text-anchor="middle" font-size="13" fill="#6F716A">暂无归档快照，请在财税工作台 Tab 1 点击「归档至 12 个月滚年监控」后导出</text>`

  const clampPct = (p) => Math.max(0, Math.min(100, Number(p || 0)))
  const lvlColor = (lv) => (lv === 'danger' ? '#C54B1E' : lv === 'warn' ? '#B45309' : '#3F5E39')
  const allHist = Array.isArray(history) ? history : []
  const entityHist = r.activeEntity
    ? allHist.filter((h) => (h.entityName || '待认领') === r.activeEntity)
    : allHist
  const inWinHist = r.windowStart && r.windowEnd
    ? entityHist.filter((h) => h.month >= r.windowStart && h.month <= r.windowEnd)
    : entityHist
  const shownHist = inWinHist.slice(0, 60)
  const missingMonths = r.missingMonthsCount !== undefined ? Number(r.missingMonthsCount) : Math.max(0, 12 - Number(r.monthCount || 0))
  const zeroMonths = Number(r.zeroSalesMonthsCount || 0)
  const entityScopeText = r.activeEntity
    ? `核算主体：${r.activeEntity}`
    : (Array.isArray(r.entities) && r.entities.length > 1
        ? `核算主体：全部 ${r.entities.length} 个主体汇总（提示：涉及跨主体汇总，请按单一主体筛选核对）`
        : `核算主体：${r.entities?.[0]?.name || '未指定主体'}`)
  const snapsScopeNote = `窗口内 ${inWinHist.length} 份${inWinHist.length > 60 ? '（仅展示前 60 份）' : ''} / 本主体共 ${entityHist.length} 份`

  const tyPct = r.taxYearCliff75mPct !== undefined ? Number(r.taxYearCliff75mPct) : Number(r.cliff75mPct || 0)
  const tyRemain = r.taxYearCliff75mRemainWan !== undefined ? Number(r.taxYearCliff75mRemainWan) : Number(r.cliff75mRemainWan || 7500)
  const tyNet = r.taxYearNetSalesCny !== undefined ? Number(r.taxYearNetSalesCny) : Number(r.totalNetSalesCny || 0)
  const tyLvl = tyNet > 75_000_000 ? 'danger' : tyNet >= 55_000_000 ? 'warn' : 'safe'

  const snapsRows = shownHist
    .map(
      (h) => {
        const ent = h.entityName || '待认领'
        const isUnclaimed = ent === '待认领'
        return `<tr>
          <td class="mono"><b>${esc(h.month)}</b>${h.zeroSalesConfirmed ? '<br/><span style="font-size:11px;color:#4E514A">确认零收入</span>' : ''}</td>
          <td><span style="font-weight:700;color:${isUnclaimed ? '#B45309' : '#1C1E1B'}">${esc(ent)}</span><br/><span style="font-size:11.5px;color:#5A5D55">${esc(h.storeScope || '-')}</span></td>
          <td>${esc(h.label || '-')}</td>
          <td>${esc((h.platforms || []).join(' / ') || '-')}</td>
          <td class="num">${fmtCny(h.grossCny)}</td>
          <td class="num"><b>${fmtCny(h.netSalesCny)}</b></td>
          <td class="num">${fmtCny(h.feesCny)}</td>
          <td class="num">${fmtCny(h.payoutCny)}</td>
          <td class="num" style="color:${h.p0Count > 0 ? '#C54B1E;font-weight:800' : '#3F5E39'}">P0:${Number(h.p0Count || 0)} / P1:${Number(h.p1Count || 0)}</td>
        </tr>`
      },
    )
    .join('')

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/>
<title>12 个月滚动财税风控趋势月报 — dsh-fintax</title>
<style>
  body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:#E9E9DF;color:#1C1E1B;margin:0;padding:24px}
  .page{max-width:1040px;margin:0 auto;background:#F4F3ED;border:1.5px solid #B8B7AC;padding:28px 34px;box-shadow:0 8px 24px rgba(0,0,0,0.08)}
  .top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1C1E1B;padding-bottom:12px;margin-bottom:18px}
  h1{font-size:22px;margin:0;letter-spacing:-0.2px} .sub{font-size:12.5px;color:#5A5D55;margin-top:4px}
  h2{font-size:15px;margin:0 0 10px;border-left:4px solid #C54B1E;padding-left:9px;text-transform:uppercase;letter-spacing:0.3px}
  .lcd{background:#D5DEC8;border:1.5px solid #9DA78F;padding:16px 20px;margin-bottom:18px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  .kpi-l{font-size:11.5px;color:#3F4A38} .kpi-v{font:700 20px Consolas,monospace;color:#1A2416;margin-top:4px;font-variant-numeric:tabular-nums}
  .card{background:#FAF9F5;border:1px solid #CECDC2;padding:16px 18px;margin-bottom:16px}
  .gauges{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
  .bar-bg{height:12px;background:#E2E1D7;border-radius:2px;overflow:hidden;margin:8px 0 6px}
  .bar-fill{height:100%}
  table{width:100%;border-collapse:collapse;font-size:12.5px} th,td{border-bottom:1px solid #DFDED4;padding:8px 7px;text-align:left}
  th{background:#ECECE3;border-bottom:1.5px solid #1C1E1B;font-weight:700}
  .num{text-align:right;font-family:Consolas,monospace;font-variant-numeric:tabular-nums} .mono{font-family:Consolas,monospace}
  .footer{background:#1C1E1B;color:#E9E9DF;padding:14px 18px;font-size:12.5px;line-height:1.65}
  @media print{body{background:#FFF;padding:0}.page{border:none;box-shadow:none;padding:10px}thead{display:table-header-group}tr,.card,.lcd,.gauges,.footer{break-inside:avoid;page-break-inside:avoid}}
</style></head><body><div class="page">
  <div class="top">
    <div>
      <h1>跨境财税 12 个月滚动风控趋势月报</h1>
      <div class="sub">${esc(entityScopeText)} ｜ 滚动窗口：${esc(r.windowStart || '—')} 至 ${esc(r.windowEnd || '—')}（已覆盖 ${Number(r.monthCount || 0)}/12 月 · 缺档 ${missingMonths} 月${zeroMonths > 0 ? ` · 确认零收入 ${zeroMonths} 月` : ''} / ${Number(r.snapshotCount || 0)} 份快照）</div>
    </div>
    <div class="mono" style="font-size:12px;color:#5A5D55;text-align:right">DSH / FINTAX v${esc(version)}<br/>${genTime}</div>
  </div>
  <div class="lcd">
    <div><div class="kpi-l">滚年报送参考净额（初筛）</div><div class="kpi-v">${fmtCny(r.totalNetSalesCny)}</div></div>
    <div><div class="kpi-l">滚年报送参考毛额</div><div class="kpi-v">${fmtCny(r.totalGrossCny)}</div></div>
    <div><div class="kpi-l">滚年实际平台放款</div><div class="kpi-v">${fmtCny(r.totalPayoutCny)}</div></div>
    <div><div class="kpi-l">累计待核异常（P0 / P1）</div><div class="kpi-v" style="color:${r.totalP0 > 0 ? '#C54B1E' : '#1A2416'}">${Number(r.totalP0 || 0)} / ${Number(r.totalP1 || 0)}</div></div>
  </div>
  <div class="gauges">
    <div class="card" style="margin-bottom:0">
      <h2>本纳税年度情景估算（4% 核定假设 · ${esc(r.taxYear || '本年')}）</h2>
      <div class="mono" style="font-size:13px">年度累计：<b>${fmtCny(tyNet)}</b>（${Number(r.taxYearMonthCount || r.monthCount || 0)} 个月）｜占 7,500 万等值 <b>${tyPct.toFixed(2)}%</b>（余 <b>${tyRemain.toFixed(2)} 万</b>）</div>
      <div class="bar-bg"><div class="bar-fill" style="width:${clampPct(tyPct)}%;background:${lvlColor(tyLvl)}"></div></div>
      <div style="font-size:12px;color:#5A5D55">情景说明：7,500 万系按 4% 应税所得率倒推 300 万年度应纳税所得额的情景估算值，仅适用于具备综试区核定资格主体，且小型微利企业仍须满足人数、资产总额等法定条件。</div>
    </div>
    <div class="card" style="margin-bottom:0">
      <h2>滚动登记参考（连续 12 月 / 4 季 · 500 万）</h2>
      <div class="mono" style="font-size:13px">当前进度：<b>${Number(r.threshold5mPct || 0).toFixed(2)}%</b> ｜ 距 500 万参考值剩余 <b>${Number(r.threshold5mRemainWan || 0).toFixed(2)} 万</b></div>
      <div class="bar-bg"><div class="bar-fill" style="width:${clampPct(r.threshold5mPct)}%;background:${lvlColor(r.threshold5mLevel)}"></div></div>
      <div style="font-size:12px;color:#5A5D55">注：同一纳税人连续不超过 12 个月或四个季度累计应征增值税销售额超过 500 万元须按规定登记为一般纳税人；缺档月份未计入，与“确认零收入”已分开标示。</div>
    </div>
  </div>
  <div class="card">
    <h2>逐月净销售（深绿 / P0 预警橙）与实际放款（冷灰）趋势图（单位：万元 CNY）</h2>
    <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" style="display:block;max-height:245px">
      <line x1="${padL}" y1="${padT + plotH}" x2="${svgW - padR}" y2="${padT + plotH}" stroke="#9E9D92" stroke-width="1"/>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#9E9D92" stroke-width="1"/>
      <text x="${padL - 8}" y="${padT + 8}" text-anchor="end" font-size="10" fill="#6F716A" font-family="Consolas,monospace">${fmtWan(maxVal)}</text>
      <text x="${padL - 8}" y="${padT + plotH}" text-anchor="end" font-size="10" fill="#6F716A" font-family="Consolas,monospace">0</text>
      ${barsSvg}
    </svg>
  </div>
  <div class="card">
    <h2>滚动窗口内已归档月度脱敏快照台账（${esc(snapsScopeNote)} · 不含原始订单行）</h2>
    <table><thead><tr><th>归档月份</th><th>主体 / 店铺</th><th>用户备注</th><th>覆盖通道</th><th class="num">参考毛额</th><th class="num">参考净额</th><th class="num">平台费用</th><th class="num">实际放款</th><th class="num">异常数</th></tr></thead>
    <tbody>${snapsRows || '<tr><td colspan="9" style="text-align:center;color:#6F716A;padding:18px">暂无月度归档记录</td></tr>'}</tbody></table>
  </div>
  <div class="footer">
    <b>隐私与初筛声明：</b>本趋势月报由本机月度汇总（<code>~/.config/ima/fintax_history.json</code>，<code>0600</code>）离线生成，绝不包含原始订单明细（注：「主体 / 店铺」与「用户备注」原样显示您自行填写的文本，对外分享前请注意复核）；本报告不构成正式月结关账底稿、税务申报依据或会计凭证。
  </div>
</div></body></html>`
}

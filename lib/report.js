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

  const breakdown = summaries.map((s, idx) => {
    const fx = perSheetFx[idx]
    const g = r2(toNumber2(s.taxReportingGrossRef) * fx)
    const rf = r2(toNumber2(s.customerRefund) * fx)
    const fe = r2(toNumber2(s.totalFees) * fx)
    const sb = r2(toNumber2(s.platformSubsidy) * fx)
    const st = r2(toNumber2(s.selfRemitTaxNet) * fx)
    const rv = r2(toNumber2(s.reserveNetChange) * fx)
    const po = r2(toNumber2(s.actualPayout) * fx)

    grossCny += g
    refundCny += rf
    feesCny += fe
    subsidyCny += sb
    selfRemitTaxCny += st
    reserveCny += rv
    if (s.actualPayout > 0n) {
      hasAnyPayout = true
      payoutCny += po
    }
    p0Count += s.anomalies.filter((a) => a.severity.startsWith('P0')).length
    return {
      label: `${s.platform}·${s.site}(${s.period})`,
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

  const rec = platformTaxReconcile({
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

  // 以 4% 假设计得的核定收入等值作为账单初筛指标。
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
  return {
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

export function renderDiagnosticReportMd({ summaries, consolidated, version = '0.7.1' }) {
  const { allAnoms, p0, p1, p2, totalRows, genTime, overallBadge } = buildReportContext(summaries)
  const md = [
    `# 跨境店铺原始结算单税务初筛体检诊断书`,
    ``,
    `> **综合风险评级**：**${overallBadge.level}**  `,
    `> **生成引擎**：\`dsh-fintax v${version}\`（BigInt 离线定点初筛）｜**体检时间**：${genTime}｜**扫描账单**：${summaries.length} 份（共 ${totalRows} 行明细）`,
    ``,
    `## 一、各平台／站点原币报送参考与结算项目`,
    `| 平台·站点 | 期间 | 币种 | ①商品含运费原价 | ★报送参考毛收入(①-②) | ④客户退款 | ⑤~⑨佣金与履约费 | 待自申报境外税 | 实际打款 | 水平守恒 |`,
    `|---|---|---|---:|---:|---:|---:|---:|---:|---|`,
    ...summaries.map(
      (s) =>
        `| ${s.platform}·${s.site} | ${s.period} | ${s.currency} | ${fmtAmount(s.grossSales)} | **${fmtAmount(s.taxReportingGrossRef)}** | ${fmtAmount(s.customerRefund)} | ${fmtAmount(s.totalFees)} | ${fmtAmount(s.selfRemitTaxNet)} | ${fmtAmount(s.actualPayout)} | ${s.horizontalDiffTotal === 0n ? '✔ 通过' : '❌ 失衡'} |`,
    ),
    ``,
  ]
  if (consolidated?.ready) {
    md.push(`## 二、多表合并人民币折算与申报比对诊断`)
    for (const st of consolidated.reconcile.steps) md.push(`- ${st}`)
    for (const w of consolidated.reconcile.warnings) md.push(`- ⚠ **预警**：${w}`)
    if (consolidated.cliffAlert) md.push(`- ${consolidated.cliffAlert}`)
    md.push(``)
  }
  md.push(`## 三、异常交易雷达清单（P0: ${p0.length}｜P1: ${p1.length}｜P2: ${p2.length}）`)
  if (!allAnoms.length) md.push(`- ✔ 未检出异常交易记录。`)
  for (const a of [...p0, ...p1, ...p2].slice(0, 30)) {
    md.push(`- **[${a.severity}] [${a.scope}] ${a.category}**（单号 \`${a.refId}\`，金额 \`${a.amount}\`）：${a.detail}`)
  }
  md.push(
    ``,
    `## 四、下一步可执行动作与正式关账升级指引`,
    `1. **四套口径严禁混用**：平台涉税报送口径（税总2025年第15号）、财务会计口径、增值税出口退（免）税口径与企业所得税口径须分别通过桥接表勾稽，切勿直接拿银行回款净额申报收入。`,
    `2. **法规依据与整改 SOP**：针对上述检出的 P0/P1 异常，可在 DeepSeek Harness 侧边栏「财税工作台」绑定腾讯 IMA 实战知识库（197 篇现行法规与差额整改 SOP）检索对应文号与处理流程。`,
    `3. **正式月结关账边界**：本诊断书仅作原始账单离线初筛排雷，不包含多店铺主体映射、央行基准汇率重算、第三方收款机构期初期末资金池轧平及正式会计分录（需使用配套《跨境电商月结四层口径一表通母表》并经执业税务师复核）。`,
  )
  return md.join('\n')
}

export function renderDiagnosticReportHtml({ summaries, consolidated, version = '0.7.1' }) {
  const { allAnoms, p0, p1, p2, totalRows, genTime, overallBadge } = buildReportContext(summaries)
  const rowsHtml = summaries
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

  const anomHtml = allAnoms.length
    ? [...p0, ...p1, ...p2]
        .slice(0, 30)
        .map((a) => {
          const c = a.severity.startsWith('P0') ? '#DC2626' : a.severity.startsWith('P1') ? '#D97706' : '#2563EB'
          return `<div style="border-left:4px solid ${c};background:#F8FAFC;padding:10px 14px;margin-bottom:8px;border-radius:6px">
            <div style="font-weight:700;color:${c}">[${esc(a.severity)}] [${esc(a.scope)}] ${esc(a.category)} <span style="color:#475569;font-family:monospace;font-size:12px">(${esc(a.refId)} | ${esc(a.amount)})</span></div>
            <div style="font-size:13px;color:#334155;margin-top:3px">${esc(a.detail)}</div>
          </div>`
        })
        .join('')
    : '<div style="color:#15803D;font-weight:700">✔ 全部明细行扫描完毕，未检出异常交易记录。</div>'

  const consHtml = consolidated?.ready
    ? `<div class="card"><h2>二、多表合并人民币初筛与申报比对</h2>
        <ul>${consolidated.reconcile.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ul>
        ${consolidated.reconcile.warnings.map((w) => `<div style="color:#B45309;font-weight:700;margin-top:6px">⚠ ${esc(w)}</div>`).join('')}
        ${consolidated.cliffAlert ? `<div style="color:#B91C1C;font-weight:800;margin-top:8px;padding:8px 12px;background:#FEF2F2;border-radius:6px">${esc(consolidated.cliffAlert)}</div>` : ''}
      </div>`
    : ''

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/>
<title>跨境店铺原始账单税务初筛体检诊断书</title>
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
  @media print{body{background:#FFF;padding:0}.page{border:none;padding:10px}}
</style></head><body><div class="page">
  <h1>跨境店铺原始结算账单 · 税务初筛体检诊断书</h1>
  <div class="meta">生成工具：DeepSeek Harness 财税工作台 (dsh-fintax v${esc(version)}) ｜ 体检时间：${genTime} ｜ 扫描范围：${summaries.length} 张结算表 / 共 ${totalRows} 行交易明细（本地离线定点核算，原始订单未外传）</div>
  <div class="banner">综合体检结论：${esc(overallBadge.level)}（P0 阻断 ${p0.length} 项 · P1 高危 ${p1.length} 项 · P2 关注 ${p2.length} 项）</div>
  <div class="card"><h2>一、各站点原币报送参考与结算项目（精确到 0.01）</h2>
    <table><thead><tr><th>平台·站点</th><th>期间</th><th>币种</th><th class="num">①商品含运费</th><th class="num">★报送参考毛额</th><th class="num">④客户退款</th><th class="num">⑤~⑨平台履约费</th><th class="num">⑩待自报税</th><th class="num">实际放款</th><th>守恒</th></tr></thead><tbody>${rowsHtml}</tbody></table>
  </div>
  ${consHtml}
  <div class="card"><h2>${consolidated?.ready ? '三' : '二'}、异常交易雷达与优先排查事项</h2>${anomHtml}</div>
  <div class="footer">
    <b>下一步可执行动作与正式月结关账边界：</b><br/>
    1. <b>严禁混用四套口径</b>：平台涉税信息报送（税总2025年第15号）、财务会计收入、增值税出口退（免）税与企业所得税口径必须通过差额桥接表逐层勾稽，严禁直接按回款净额或冲减佣金后申报收入。<br/>
    2. <b>查阅现行法规与异常整改 SOP</b>：在 DSH 桌面端打开「财税工作台」绑定配套腾讯 IMA 实战知识库（197 篇 2026 现行法规与异常处置指南），可逐项核实政策文号与主管机关事前鉴定要求。<br/>
    3. <b>正式关账声明</b>：本初筛体检单用于内部管理排雷，不包含多店铺主体映射、央行基准汇率重算、第三方收款池期初期末轧平及标准会计分录生成（正式月结请结合《跨境电商月结四层口径一表通母表》并经执业税务师复核）。
  </div>
</div></body></html>`
}

export function exportDiagnosticReport({ summaries, consolidated, exportPath, firstInputPath, version = '0.7.1' }) {
  const target = resolveExportTarget(exportPath, firstInputPath)
  if (!target) return null
  mkdirSync(dirname(target), { recursive: true })
  const lower = target.toLowerCase()
  const content = lower.endsWith('.csv')
    ? renderAnomaliesCsv({ summaries })
    : lower.endsWith('.md')
      ? renderDiagnosticReportMd({ summaries, consolidated, version })
      : renderDiagnosticReportHtml({ summaries, consolidated, version })
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
 * 严守商业护城河：仅含待核查异常项与排雷说明，绝不包含正式关账母表公式或会计借贷分录。
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
    })),
  )
  const rank = (sev) => (sev.startsWith('P0') ? 0 : sev.startsWith('P1') ? 1 : 2)
  all.sort((a, b) => rank(a.severity) - rank(b.severity))

  const rows = [
    ['风险级别', '平台', '站点', '币种', '来源文件', '异常类别', '参考单号', '异常金额(原币)', '风险说明与排查要点'],
    ...all.map((a) => [a.severity, a.platform, a.site, a.currency, a.fileName, a.category, a.refId, a.amount, a.detail]),
  ]
  if (all.length === 0) {
    rows.push(['正常', '-', '-', '-', '-', '无异常项', '-', '0.00', '全部明细行扫描完毕，未检出 P0/P1/P2 异常记录'])
  }
  rows.push(['声明', '-', '-', '-', '-', '初筛边界说明', '-', '-', '本清单仅用于内部异常交易排雷核查，非正式月结关账底稿或会计凭证'])
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

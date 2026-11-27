// dsh-fintax v0.9.0 自然年 Q1–Q4 老板汇总报表与 2027-01-31 全球三地报送自检渲染器（HTML + Markdown）。
// 遵循 Braun 精密财务单据美学、严格 HTML/Markdown 实体逃逸防 XSS、A4 打印适配与默认纯洁老板模式（零推广广告）。

import { createRequire } from 'node:module'

const { version: VERSION } = createRequire(import.meta.url)('../package.json')

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const mdText = (s) =>
  String(s ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[&<>"'\\\x60*_\[\]|~#]/g, (char) => `&#${char.charCodeAt(0)};`)

const fmtCny = (n) =>
  n === null || n === undefined
    ? '待核'
    : `¥${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtSignedCny = (n) => {
  if (n === null || n === undefined) return '待核'
  const num = Number(n)
  const sign = num > 0 ? '+' : num < 0 ? '-' : ''
  return `${sign}¥${Math.abs(num).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const fmtWan = (n) => `${(Number(n || 0) / 10_000).toFixed(1)}w`

function statusMeta(status) {
  switch (status) {
    case 'danger':
      return { label: '红线预警 / 须立即核对', color: '#C54B1E', bg: '#FEF2F2', border: '#E8A58F' }
    case 'warn':
      return { label: '待核资料与口径', color: '#B45309', bg: '#FFFBEB', border: '#E5C675' }
    case 'pending_data':
      return { label: '资料待补（仅已知下限）', color: '#B45309', bg: '#FFFBEB', border: '#E5C675' }
    case 'ok':
      return { label: '初筛通过（待回单终核）', color: '#3F5E39', bg: '#EFF5EC', border: '#A7BEA0' }
    case 'not_applicable':
      return { label: '本期未检出触发信号', color: '#5A5D55', bg: '#F1F0E8', border: '#CECDC2' }
    default:
      return { label: '待补档', color: '#5A5D55', bg: '#F1F0E8', border: '#CECDC2' }
  }
}

function renderQuarterlyBarSvg(quarters = []) {
  const list = Array.isArray(quarters) && quarters.length === 4
    ? quarters
    : ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => ({ quarter: q, netSalesCny: 0, payoutCny: 0, stage3BankReceivedCny: null, p0Count: 0 }))

  const maxVal = Math.max(
    1,
    ...list.map((q) => Math.max(
      Math.abs(Number(q.netSalesCny || 0)),
      Math.abs(Number(q.payoutCny || 0)),
      Math.abs(Number(q.stage3BankReceivedCny ?? q.stage2WalletInboundCny ?? 0)),
    )),
  )

  const svgW = 860
  const svgH = 224
  const padL = 68
  const padR = 24
  const padT = 26
  const padB = 40
  const plotW = svgW - padL - padR
  const plotH = svgH - padT - padB
  const step = plotW / 4

  const groups = list.map((q, idx) => {
    const baseX = padL + idx * step + step * 0.14
    const bw = Math.min(36, step * 0.21)
    const gap = 5
    const netVal = Number(q.netSalesCny || 0)
    const payVal = Number(q.payoutCny || 0)
    const s3Val = q.stage3BankReceivedCny !== null && q.stage3BankReceivedCny !== undefined
      ? Number(q.stage3BankReceivedCny)
      : (q.stage2WalletInboundCny !== null && q.stage2WalletInboundCny !== undefined ? Number(q.stage2WalletInboundCny) : 0)

    const hNet = netVal > 0 ? Math.max(3, (netVal / maxVal) * plotH) : 0
    const hPay = payVal > 0 ? Math.max(3, (payVal / maxVal) * plotH) : 0
    const hS3 = s3Val > 0 ? Math.max(3, (s3Val / maxVal) * plotH) : 0

    const yNet = padT + plotH - hNet
    const yPay = padT + plotH - hPay
    const yS3 = padT + plotH - hS3
    const hasP0 = Number(q.p0Count || 0) > 0
    const centerX = baseX + bw * 1.5 + gap

    return `<g>
      ${hNet > 0 ? `<rect x="${baseX.toFixed(1)}" y="${yNet.toFixed(1)}" width="${bw.toFixed(1)}" height="${hNet.toFixed(1)}" fill="${hasP0 ? '#C54B1E' : '#3F5E39'}" rx="2"/>` : ''}
      ${hPay > 0 ? `<rect x="${(baseX + bw + gap).toFixed(1)}" y="${yPay.toFixed(1)}" width="${bw.toFixed(1)}" height="${hPay.toFixed(1)}" fill="#8A8E80" rx="2"/>` : ''}
      ${hS3 > 0 ? `<rect x="${(baseX + (bw + gap) * 2).toFixed(1)}" y="${yS3.toFixed(1)}" width="${bw.toFixed(1)}" height="${hS3.toFixed(1)}" fill="#3B6E8C" rx="2"/>` : ''}
      <text x="${(baseX + bw / 2).toFixed(1)}" y="${(Math.min(yNet, padT + plotH) - 6).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#1C1E1B" font-family="Consolas,monospace">${fmtWan(netVal)}</text>
      <text x="${centerX.toFixed(1)}" y="${(padT + plotH + 20).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#1C1E1B" font-family="Consolas,monospace">${esc(q.quarter)}</text>
      <text x="${centerX.toFixed(1)}" y="${(padT + plotH + 34).toFixed(1)}" text-anchor="middle" font-size="10" fill="#5A5D55">${Number((q.coveredMonths || []).length)}/3月</text>
    </g>`
  }).join('')

  return `<svg viewBox="0 0 ${svgW} ${svgH}" width="100%" role="img" aria-label="Q1至Q4季度销售与放款对比柱状图" style="display:block;max-height:240px">
    <line x1="${padL}" y1="${padT + plotH}" x2="${svgW - padR}" y2="${padT + plotH}" stroke="#9E9D92" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#9E9D92" stroke-width="1"/>
    <line x1="${padL}" y1="${(padT + plotH / 2).toFixed(1)}" x2="${svgW - padR}" y2="${(padT + plotH / 2).toFixed(1)}" stroke="#DFDED4" stroke-dasharray="4 4" stroke-width="1"/>
    <text x="${padL - 8}" y="${padT + 8}" text-anchor="end" font-size="10" fill="#5A5D55" font-family="Consolas,monospace">${fmtWan(maxVal)}</text>
    <text x="${padL - 8}" y="${(padT + plotH / 2 + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#5A5D55" font-family="Consolas,monospace">${fmtWan(maxVal / 2)}</text>
    <text x="${padL - 8}" y="${padT + plotH}" text-anchor="end" font-size="10" fill="#5A5D55" font-family="Consolas,monospace">0</text>
    ${groups}
  </svg>`
}

function renderMonthGridHtml(monthlySeries = []) {
  if (!Array.isArray(monthlySeries) || !monthlySeries.length) return ''
  return `<div class="month-grid">${monthlySeries.map((m) => {
    const isMissing = m.status === 'missing'
    const isZero = m.status === 'zero_confirmed'
    const cls = isMissing ? 'mo-cell mo-miss' : isZero ? 'mo-cell mo-zero' : Number(m.p0Count || 0) > 0 ? 'mo-cell mo-p0' : 'mo-cell mo-ok'
    const statusTxt = isMissing ? '缺档' : isZero ? '确认零收入' : `${fmtWan(m.netSalesCny)}${m.p0Count > 0 ? ` · P0:${m.p0Count}` : ''}`
    return `<div class="${cls}"><div class="mo-id">${esc(String(m.month || '').slice(5))}月</div><div class="mo-st">${esc(statusTxt)}</div></div>`
  }).join('')}</div>`
}

function renderJurisdictionCardHtml(card) {
  if (!card) return ''
  const st = statusMeta(card.status)
  const alertsHtml = (card.alerts || []).length
    ? `<ul class="jur-alerts">${card.alerts.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
    : `<div class="jur-ok">${esc(card.summary || '未检出异常告警。')}</div>`
  const checksHtml = (card.checklist || []).length
    ? `<ul class="jur-checks">${card.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
    : ''

  let kpiLine = ''
  if (card.id === 'china_810' && card.metrics) {
    const m = card.metrics
    const pendTxt = m.declaredPendingMonthCount > 0 ? ` ｜ 待补申报 ${m.declaredPendingMonthCount} 期 (${fmtCny(m.declaredPendingNetSalesCny)})` : ''
    kpiLine = `Q4 净销 ${fmtCny(m.q4NetSalesCny)} ｜ 全年净销 ${fmtCny(m.annualNetSalesCny)} ｜ 同覆盖期申报差额 ${fmtSignedCny(m.declaredGapCny)}${pendTxt}`
  } else if (card.id === 'eu_dac7' && card.metrics) {
    const m = card.metrics
    const eurTxt = m.euSalesEur !== null ? `€${Number(m.euSalesEur).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '待核'
    const ordTxt = m.euOrderCount !== null ? `${m.euOrderCount} 笔` : '笔数待核'
    const lbTag = m.knownLowerBound ? '[已知下限] ' : ''
    kpiLine = `EU 信号：${m.euDetected ? (m.euSites.length ? m.euSites.join('/') : 'EU') : (m.eurCurrencyOnlyHint ? '仅非欧盟站点 EUR 提示' : '未检出')} ｜ ${lbTag}金额 ${eurTxt} ｜ ${ordTxt}（门槛 €2,000 / 30 笔）`
  } else if (card.id === 'us_1099k' && card.metrics) {
    const m = card.metrics
    const usdTxt = m.usSalesUsd !== null ? `$${Number(m.usSalesUsd).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '待核'
    const txnTxt = m.usTransactionCount !== null ? `${m.usTransactionCount} 笔` : '笔数待核'
    const lbTag = m.knownLowerBound ? '[已知下限] ' : ''
    kpiLine = `US 信号：${m.usDetected ? (m.usSites.length ? m.usSites.join('/') : 'USD') : '未检出'} ｜ ${lbTag}金额 ${usdTxt} ｜ ${txnTxt}（TPSO 联邦双门槛 >$20,000 且 >200 笔；支付卡收单另核）`
  }
  const metaExtra = [card.reporter ? `报送人：${card.reporter}` : '', card.scheduleNote || '', card.paymentScopeNote || ''].filter(Boolean).join(' ｜ ')
  const gapsHtml = (card.dataGaps || []).length
    ? `<div class="jur-ref" style="color:#92400E"><b>资料缺口：</b>${esc(card.dataGaps.join('；'))}</div>`
    : ''

  return `<div class="jur-card" style="border-color:${st.border};background:${st.bg}">
    <div class="jur-head">
      <span class="jur-badge" style="color:${st.color};border-color:${st.border}">${esc(card.jurisdiction || '')} · ${esc(st.label)}</span>
      <span class="mono" style="font-size:11.5px;color:#5A5D55">截止 ${esc(card.deadline || '')}</span>
    </div>
    <h3>${esc(card.title)}</h3>
    <div class="jur-ref">${esc(card.policyRef || '')}</div>
    ${metaExtra ? `<div class="jur-ref">${esc(metaExtra)}</div>` : ''}
    ${kpiLine ? `<div class="jur-kpi mono">${esc(kpiLine)}</div>` : ''}
    ${gapsHtml}
    ${alertsHtml}
    ${checksHtml ? `<div class="jur-sub">交卷前核对清单：</div>${checksHtml}` : ''}
  </div>`
}

/**
 * 渲染自然年 Q1–Q4 汇总与 2027-01-31 三地报送自检 HTML 老板报表（Braun 精密财务单据美学 + A4 打印 + 默认纯洁零广告）。
 */
export function renderAnnualSummaryHtml(summary, options = {}) {
  const s = summary || {}
  const version = options.version || VERSION
  const includeResourceAppendix = options.includeResourceAppendix === true
  const customTitle = options.title ? String(options.title) : `${s.yearLabel || s.year || ''} 年度跨境财税汇总与三地报送自检报表`
  const genTime = options.generatedAt || new Date().toISOString().slice(0, 19).replace('T', ' ')
  const annual = s.annual || {}
  const quarters = Array.isArray(s.quarters) ? s.quarters : []
  const byPlatform = Array.isArray(s.byPlatform) ? s.byPlatform : []
  const byEntity = Array.isArray(s.byEntity) ? s.byEntity : []
  const cards = s.threeJurisdictions?.cards || [
    s.threeJurisdictions?.china810,
    s.threeJurisdictions?.euDac7,
    s.threeJurisdictions?.us1099k,
  ].filter(Boolean)

  const mixingBannerHtml = s.crossEntityMixed
    ? `<div class="alert-banner alert-danger"><b>${esc(s.mixingProtectionWarning || '【跨主体混算保护】当前包含多个主体，不可直接合并申报，已按主体拆表展示。')}</b></div>`
    : ''
  const unclaimedBannerHtml = s.hasUnclaimed
    ? `<div class="alert-banner alert-warn">${esc(s.unclaimedWarning || '当前包含「待认领」归档，请先完成主体归属重分配。')}</div>`
    : ''

  const quarterRowsHtml = quarters.map((q) => `<tr>
    <td class="mono"><b>${esc(q.label || q.quarter)}</b></td>
    <td class="mono">${Number((q.coveredMonths || []).length)}/3${q.missingMonths?.length ? `<br/><span style="font-size:11px;color:#B45309">缺 ${esc(q.missingMonths.map((m) => m.slice(5)).join('/'))}月</span>` : ''}</td>
    <td class="num">${fmtCny(q.grossCny)}</td>
    <td class="num">${fmtCny(q.refundCny)}</td>
    <td class="num"><b>${fmtCny(q.netSalesCny)}</b></td>
    <td class="num">${fmtCny(q.feesCny)}</td>
    <td class="num">${fmtCny(q.payoutCny)}</td>
    <td class="num">${fmtCny(q.stage2WalletInboundCny)}</td>
    <td class="num">${fmtCny(q.stage3BankReceivedCny)}</td>
    <td class="num" style="color:${Number(q.p0Count || 0) > 0 ? '#C54B1E;font-weight:800' : '#3F5E39'}">${Number(q.p0Count || 0)} / ${Number(q.p1Count || 0)} / ${Number(q.p2Count || 0)}</td>
  </tr>`).join('')

  const annualTotalRowHtml = `<tr class="total-row">
    <td class="mono"><b>${esc(s.yearLabel || s.year || '')} 全年合计${s.crossEntityMixed ? '（仅参考）' : ''}</b></td>
    <td class="mono"><b>${Number(annual.coveredMonthCount || 0)}/12</b></td>
    <td class="num"><b>${fmtCny(annual.grossCny)}</b></td>
    <td class="num"><b>${fmtCny(annual.refundCny)}</b></td>
    <td class="num"><b>${fmtCny(annual.netSalesCny)}</b></td>
    <td class="num"><b>${fmtCny(annual.feesCny)}</b></td>
    <td class="num"><b>${fmtCny(annual.payoutCny)}</b></td>
    <td class="num"><b>${fmtCny(annual.stage2WalletInboundCny)}</b></td>
    <td class="num"><b>${fmtCny(annual.stage3BankReceivedCny)}</b></td>
    <td class="num" style="color:${Number(annual.p0Count || 0) > 0 ? '#C54B1E' : '#1C1E1B'}"><b>${Number(annual.p0Count || 0)} / ${Number(annual.p1Count || 0)} / ${Number(annual.p2Count || 0)}</b></td>
  </tr>`

  const entitySplitHtml = s.crossEntityMixed && byEntity.length > 1
    ? `<div class="card">
      <h2>分主体独立拆表（防跨主体混算 · 严禁合并申报）</h2>
      <div class="table-scroll"><table><thead><tr><th>核算主体</th><th>状态</th><th>覆盖月数</th><th class="num">全年毛额</th><th class="num">全年参考净额</th><th class="num">平台费用</th><th class="num">Stage1 净放款</th><th class="num">Stage2 钱包实收</th><th class="num">Stage3 银行实收</th><th class="num">P0 / P1</th></tr></thead><tbody>
        ${byEntity.map((ent) => `<tr>
          <td><b>${esc(ent.entityLabel)}</b></td>
          <td>${ent.ownershipStatus === 'unclaimed' ? '<span style="color:#B45309;font-weight:700">待认领</span>' : '<span style="color:#3F5E39;font-weight:700">已认领</span>'}</td>
          <td class="mono">${Number((ent.coveredMonths || []).length)}/12${ent.missingMonths?.length ? `（缺 ${ent.missingMonths.length} 月）` : ''}</td>
          <td class="num">${fmtCny(ent.annual?.grossCny)}</td>
          <td class="num"><b>${fmtCny(ent.annual?.netSalesCny)}</b></td>
          <td class="num">${fmtCny(ent.annual?.feesCny)}</td>
          <td class="num">${fmtCny(ent.annual?.payoutCny)}</td>
          <td class="num">${fmtCny(ent.annual?.stage2WalletInboundCny)}</td>
          <td class="num">${fmtCny(ent.annual?.stage3BankReceivedCny)}</td>
          <td class="num" style="color:${Number(ent.annual?.p0Count || 0) > 0 ? '#C54B1E;font-weight:800' : '#3F5E39'}">${Number(ent.annual?.p0Count || 0)} / ${Number(ent.annual?.p1Count || 0)}</td>
        </tr>`).join('')}
      </tbody></table></div>
    </div>`
    : ''

  const platformRowsHtml = byPlatform.length
    ? byPlatform.map((p) => `<tr>
      <td><b>${esc(p.platform)}</b>${p.multiPlatform ? ' <span class="tag">组合归档</span>' : ''}</td>
      <td class="num">${fmtCny(p.grossCny)}</td>
      <td class="num">${fmtCny(p.refundCny)}</td>
      <td class="num"><b>${fmtCny(p.netSalesCny)}</b></td>
      <td class="num">${fmtCny(p.feesCny)}</td>
      <td class="num">${fmtCny(p.payoutCny)}</td>
      <td class="num">${Number(p.shareOfNetPct || 0).toFixed(2)}%</td>
    </tr>`).join('')
    : '<tr><td colspan="7" style="text-align:center;color:#5A5D55;padding:16px">本年度暂无已归档平台数据</td></tr>'

  const appendixHtml = includeResourceAppendix
    ? '<br/>3. <b>扩展参考附页（由导出者主动勾选）</b>：如需复核现行跨境政策原文与差额处理流程，可在 DSH 侧边栏「财税工作台」接入本地已授权的知识库检索对照。'
    : ''

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(customTitle)} — dsh-fintax</title>
<style>
  @page{size:A4;margin:12mm}
  body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:#E9E9DF;color:#1C1E1B;margin:0;padding:24px}
  .page{max-width:1060px;margin:0 auto;background:#F4F3ED;border:1.5px solid #B8B7AC;padding:28px 34px;box-shadow:0 8px 24px rgba(0,0,0,0.08)}
  .top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1C1E1B;padding-bottom:12px;margin-bottom:16px;gap:12px}
  h1{font-size:21px;margin:0;letter-spacing:-0.2px} .sub{font-size:12.5px;color:#5A5D55;margin-top:4px;line-height:1.5}
  h2{font-size:14.5px;margin:0 0 10px;border-left:4px solid #C54B1E;padding-left:9px;letter-spacing:0.2px}
  h3{font-size:13.5px;margin:8px 0 4px;line-height:1.4}
  .lcd{background:#D5DEC8;border:1.5px solid #9DA78F;padding:15px 18px;margin-bottom:16px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
  .kpi-l{font-size:11.5px;color:#3F4A38} .kpi-v{font:700 18px Consolas,monospace;color:#1A2416;margin-top:4px;font-variant-numeric:tabular-nums}
  .kpi-s{font-size:11px;color:#4A5643;margin-top:3px}
  .alert-banner{padding:11px 14px;margin-bottom:14px;font-size:13px;line-height:1.6;border:1.5px solid}
  .alert-danger{background:#FEF2F2;border-color:#C54B1E;color:#991B1B}
  .alert-warn{background:#FFFBEB;border-color:#B45309;color:#92400E}
  .card{background:#FAF9F5;border:1px solid #CECDC2;padding:16px 18px;margin-bottom:16px;overflow-wrap:anywhere;min-width:0}
  .legend{display:flex;gap:14px;font-size:11.5px;color:#4E514A;margin-bottom:8px;flex-wrap:wrap}
  .dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
  .table-scroll{overflow-x:auto}.table-scroll table{min-width:740px}
  table{width:100%;border-collapse:collapse;font-size:12.5px} th,td{border-bottom:1px solid #DFDED4;padding:8px 7px;text-align:left}
  th{background:#ECECE3;border-bottom:1.5px solid #1C1E1B;font-weight:700}
  .total-row td{background:#ECECE3;border-top:1.5px solid #1C1E1B;border-bottom:2px solid #1C1E1B}
  .num{text-align:right;font-family:Consolas,monospace;font-variant-numeric:tabular-nums} .mono{font-family:Consolas,monospace}
  .tag{display:inline-block;font-size:10.5px;padding:1px 5px;background:#ECECE3;border:1px solid #B8B7AC;color:#4E514A;border-radius:2px}
  .month-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:10px 0}
  .mo-cell{border:1px solid #CECDC2;padding:7px 8px;background:#FFF} .mo-id{font:700 12px Consolas,monospace} .mo-st{font-size:11px;margin-top:2px;font-family:Consolas,monospace}
  .mo-ok{border-color:#A7BEA0;background:#F3F8F1} .mo-p0{border-color:#E8A58F;background:#FEF2F2;color:#991B1B}
  .mo-zero{border-color:#CBD5E1;background:#F8FAFC;color:#475569} .mo-miss{border-style:dashed;border-color:#D97706;background:#FFFBEB;color:#92400E}
  .stage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}
  .stage-box{border:1px solid #CECDC2;padding:10px 12px;background:#FFF}
  .jur-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
  .jur-card{border:1.5px solid;padding:13px 14px;display:flex;flex-direction:column}
  .jur-head{display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap}
  .jur-badge{font-size:11px;font-weight:800;padding:2px 6px;border:1px solid;background:#FFF}
  .jur-ref{font-size:11px;color:#5A5D55;margin-bottom:6px}
  .jur-kpi{font-size:11.5px;background:rgba(255,255,255,0.75);border:1px solid #DFDED4;padding:6px 8px;margin-bottom:8px;line-height:1.45}
  .jur-alerts,.jur-checks{margin:0 0 8px;padding-left:16px;font-size:12px;line-height:1.55}
  .jur-alerts li{color:#991B1B;font-weight:600;margin-bottom:4px} .jur-ok{font-size:12px;color:#3F5E39;margin-bottom:8px}
  .jur-sub{font-size:11.5px;font-weight:700;color:#1C1E1B;margin-bottom:4px}
  .footer{background:#1C1E1B;color:#E9E9DF;padding:14px 18px;font-size:12px;line-height:1.65}
  @media(max-width:820px){body{padding:8px}.page,.card{padding:12px}.top{display:block}.lcd,.stage-grid,.jur-grid{grid-template-columns:minmax(0,1fr)}.month-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
  @media print{body{background:#FFF;padding:0}.page{border:none;box-shadow:none;padding:0;background:#FFF}.card{background:#FFF}thead{display:table-header-group}tr,.card,.lcd,.jur-card,.footer,.alert-banner{break-inside:avoid;page-break-inside:avoid}}
</style></head><body><div class="page">
  <div class="top">
    <div>
      <h1>${esc(customTitle)}</h1>
      <div class="sub">核算范围：${esc(s.scopeLabel || '未指定')} ｜ 自然年度：${esc(s.yearLabel || s.year || '')}（已覆盖 ${Number(annual.coveredMonthCount || 0)}/12 月 · 缺档 ${Number(annual.missingMonthCount || 0)} 月 · 共 ${Number(s.snapshotCount || 0)} 份快照）｜ 交卷节点：${esc(s.deadlineDate || '')}</div>
    </div>
    <div class="mono" style="font-size:11.5px;color:#5A5D55;text-align:right">DSH / FINTAX v${esc(version)}<br/>${esc(genTime)}</div>
  </div>
  ${mixingBannerHtml}${unclaimedBannerHtml}
  <div class="lcd">
    <div><div class="kpi-l">全年报送参考净额（初筛）</div><div class="kpi-v">${fmtCny(annual.netSalesCny)}</div><div class="kpi-s">毛额 ${fmtCny(annual.grossCny)} ｜ 退款 ${fmtCny(annual.refundCny)}</div></div>
    <div><div class="kpi-l">Stage 1 平台净放款合计</div><div class="kpi-v">${fmtCny(annual.payoutCny)}</div><div class="kpi-s">平台费用 ${fmtCny(annual.feesCny)}</div></div>
    <div><div class="kpi-l">Stage 2 钱包实收 / Stage 3 银行实收</div><div class="kpi-v">${fmtCny(annual.stage2WalletInboundCny)} / ${fmtCny(annual.stage3BankReceivedCny)}</div><div class="kpi-s">一/二段差 ${fmtSignedCny(annual.stage1to2GapCny)} ｜ 二/三段差 ${fmtSignedCny(annual.stage2to3GapCny)}</div></div>
    <div><div class="kpi-l">全年异常红线（P0 / P1 / P2）</div><div class="kpi-v" style="color:${Number(annual.p0Count || 0) > 0 ? '#C54B1E' : '#1A2416'}">${Number(annual.p0Count || 0)} / ${Number(annual.p1Count || 0)} / ${Number(annual.p2Count || 0)}</div><div class="kpi-s">${s.declarable ? '单主体可核算状态' : '存在混算或待认领阻断'}</div></div>
  </div>
  ${entitySplitHtml}
  <div class="card">
    <h2>一、Q1–Q4 季度柱状对比与全年财务汇总表（单位：CNY）</h2>
    <div class="legend">
      <span><i class="dot" style="background:#3F5E39"></i>报送参考净额（含 P0 标橙 <i class="dot" style="background:#C54B1E;margin:0 2px"></i>）</span>
      <span><i class="dot" style="background:#8A8E80"></i>Stage 1 平台净放款</span>
      <span><i class="dot" style="background:#3B6E8C"></i>Stage 3 银行实收（未核销时展示 Stage 2 钱包实收）</span>
    </div>
    ${renderQuarterlyBarSvg(quarters)}
    <div class="table-scroll" style="margin-top:12px"><table><thead><tr><th>季度</th><th>覆盖月</th><th class="num">销售毛额</th><th class="num">客户退款</th><th class="num">报送参考净额</th><th class="num">平台费用</th><th class="num">Stage1 净放款</th><th class="num">Stage2 钱包实收</th><th class="num">Stage3 银行实收</th><th class="num">P0/P1/P2</th></tr></thead><tbody>${quarterRowsHtml}${annualTotalRowHtml}</tbody></table></div>
  </div>
  <div class="card">
    <h2>二、缺失月份核查与三段资金核销缺口汇总</h2>
    <div style="font-size:12.5px;color:#334155">${esc(s.missingMonthsNote || '')}</div>
    ${renderMonthGridHtml(s.monthlySeries)}
    <div class="stage-grid">
      <div class="stage-box"><div style="font-size:11.5px;color:#5A5D55">Stage 1 平台放款 → Stage 2 钱包实收（同覆盖期）</div><div class="mono" style="font-size:14px;font-weight:800;margin-top:4px">差额 ${fmtSignedCny(annual.stage1to2GapCny)}</div><div style="font-size:11.5px;color:#5A5D55;margin-top:3px">已双边对齐 ${Number(annual.stage1to2MatchedMonthCount || 0)} 期${annual.stage1to2PendingMonthCount > 0 ? ` ｜ 待补 ${annual.stage1to2PendingMonthCount} 期 (${fmtCny(annual.stage1to2PendingPayoutCny)})` : ''}</div></div>
      <div class="stage-box"><div style="font-size:11.5px;color:#5A5D55">Stage 2 钱包实收 → Stage 3 银行实收（同覆盖期）</div><div class="mono" style="font-size:14px;font-weight:800;margin-top:4px">差额 ${fmtSignedCny(annual.stage2to3GapCny)}</div><div style="font-size:11.5px;color:#5A5D55;margin-top:3px">已双边对齐 ${Number(annual.stage2to3MatchedMonthCount || 0)} 期${annual.stage2to3PendingMonthCount > 0 ? ` ｜ 待补 ${annual.stage2to3PendingMonthCount} 期 (${fmtCny(annual.stage2to3PendingStage2Cny)})` : ''}</div></div>
      <div class="stage-box"><div style="font-size:11.5px;color:#5A5D55">Stage 1 平台放款 → Stage 3 银行实收（同覆盖期）</div><div class="mono" style="font-size:14px;font-weight:800;margin-top:4px">差额 ${fmtSignedCny(annual.stage1to3GapCny)}</div><div style="font-size:11.5px;color:#5A5D55;margin-top:3px">${annual.stage3VerifiedCount > 0 ? `已双边对齐 ${Number(annual.stage1to3MatchedMonthCount || 0)} 期${annual.stage1to3PendingMonthCount > 0 ? ` ｜ 待补 ${annual.stage1to3PendingMonthCount} 期 (${fmtCny(annual.stage1to3PendingPayoutCny)})` : '（请核对汇兑损益与在途款项）'}` : '尚未导入 Stage 3 国内对公银行回单'}</div></div>
    </div>
  </div>
  <div class="card">
    <h2>三、${esc(s.deadlineDate || '2027-01-31')} 全球三地平台数据交卷自检清单（810 号令 / DAC7 / IRS 1099-K）</h2>
    <div class="jur-grid">${cards.map(renderJurisdictionCardHtml).join('')}</div>
  </div>
  <div class="card">
    <h2>四、各销售与收款通道全年汇总明细</h2>
    <div class="table-scroll"><table><thead><tr><th>平台 / 通道</th><th class="num">销售毛额</th><th class="num">客户退款</th><th class="num">报送参考净额</th><th class="num">平台费用</th><th class="num">净放款</th><th class="num">净额占比</th></tr></thead><tbody>${platformRowsHtml}</tbody></table></div>
  </div>
  <div class="footer">
    <b>口径边界与离线声明：</b><br/>
    1. <b>本地脱敏汇总</b>：本年度报表完全基于本机脱敏归档 KPI（<code>fintax_history.json</code>）离线生成，绝不包含原始订单明细或买家隐私；不同主体归档严禁合并申报。<br/>
    2. <b>四套口径区分</b>：平台涉税信息报送（中国 810 号令 / 欧盟 DAC7 / 美国 IRS 1099-K）、财务会计收入、增值税与企业所得税口径须分别勾稽，严禁直接按银行回款净额申报收入。${appendixHtml}
  </div>
</div></body></html>`
}

/**
 * 渲染自然年 Q1–Q4 汇总与 2027-01-31 三地报送自检 Markdown 老板报表（默认纯洁零广告 + 严格转义）。
 */
export function renderAnnualSummaryMarkdown(summary, options = {}) {
  const s = summary || {}
  const version = options.version || VERSION
  const includeResourceAppendix = options.includeResourceAppendix === true
  const customTitle = options.title ? String(options.title) : `${s.yearLabel || s.year || ''} 年度跨境财税汇总与三地报送自检报表`
  const genTime = options.generatedAt || new Date().toISOString().slice(0, 19).replace('T', ' ')
  const annual = s.annual || {}
  const quarters = Array.isArray(s.quarters) ? s.quarters : []
  const byPlatform = Array.isArray(s.byPlatform) ? s.byPlatform : []
  const byEntity = Array.isArray(s.byEntity) ? s.byEntity : []
  const cards = s.threeJurisdictions?.cards || [
    s.threeJurisdictions?.china810,
    s.threeJurisdictions?.euDac7,
    s.threeJurisdictions?.us1099k,
  ].filter(Boolean)

  const lines = [
    `# ${mdText(customTitle)}`,
    ``,
    `> **核算范围**：${mdText(s.scopeLabel || '未指定')} ｜ **自然年度**：${mdText(s.yearLabel || s.year || '')} ｜ **覆盖月数**：${Number(annual.coveredMonthCount || 0)}/12 月（缺档 ${Number(annual.missingMonthCount || 0)} 月）｜ **交卷节点**：${mdText(s.deadlineDate || '')}  `,
    `> **生成引擎**：dsh-fintax v${mdText(version)}（本地离线脱敏汇总）｜ **生成时间**：${mdText(genTime)}`,
    ``,
  ]

  if (s.crossEntityMixed) {
    lines.push(`> ⚠ **跨主体混算阻断**：${mdText(s.mixingProtectionWarning || '包含多个主体，不可直接合并申报。')}`, ``)
  }
  if (s.hasUnclaimed) {
    lines.push(`> ⚠ **待认领提醒**：${mdText(s.unclaimedWarning || '存在待认领历史归档，请先完成主体重分配。')}`, ``)
  }

  lines.push(
    `## 一、年度老板一页总览与 Q1–Q4 季度汇总（CNY）`,
    `- **全年报送参考净额**：${fmtCny(annual.netSalesCny)}（销售毛额 ${fmtCny(annual.grossCny)} ｜ 客户退款 ${fmtCny(annual.refundCny)} ｜ 平台费用 ${fmtCny(annual.feesCny)}）`,
    `- **三段资金闭环**：Stage 1 平台净放款 ${fmtCny(annual.payoutCny)} ｜ Stage 2 钱包实收 ${fmtCny(annual.stage2WalletInboundCny)}（一/二段差 ${fmtSignedCny(annual.stage1to2GapCny)}）｜ Stage 3 银行实收 ${fmtCny(annual.stage3BankReceivedCny)}（二/三段差 ${fmtSignedCny(annual.stage2to3GapCny)}）`,
    `- **全年异常红线**：P0 阻断 ${Number(annual.p0Count || 0)} 项 ｜ P1 高危 ${Number(annual.p1Count || 0)} 项 ｜ P2 关注 ${Number(annual.p2Count || 0)} 项`,
    `- **缺失月份提示**：${mdText(s.missingMonthsNote || '')}`,
    ``,
    `| 季度 | 覆盖月数 | 销售毛额 | 客户退款 | 报送参考净额 | 平台费用 | Stage1 净放款 | Stage2 钱包实收 | Stage3 银行实收 | P0/P1/P2 |`,
    `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|`,
    ...quarters.map((q) => `| ${mdText(q.label || q.quarter)} | ${Number((q.coveredMonths || []).length)}/3${q.missingMonths?.length ? ` (缺 ${mdText(q.missingMonths.join(','))})` : ''} | ${fmtCny(q.grossCny)} | ${fmtCny(q.refundCny)} | **${fmtCny(q.netSalesCny)}** | ${fmtCny(q.feesCny)} | ${fmtCny(q.payoutCny)} | ${fmtCny(q.stage2WalletInboundCny)} | ${fmtCny(q.stage3BankReceivedCny)} | ${Number(q.p0Count || 0)}/${Number(q.p1Count || 0)}/${Number(q.p2Count || 0)} |`),
    `| **${mdText(s.yearLabel || s.year || '')} 全年合计${s.crossEntityMixed ? '(仅参考)' : ''}** | **${Number(annual.coveredMonthCount || 0)}/12** | **${fmtCny(annual.grossCny)}** | **${fmtCny(annual.refundCny)}** | **${fmtCny(annual.netSalesCny)}** | **${fmtCny(annual.feesCny)}** | **${fmtCny(annual.payoutCny)}** | **${fmtCny(annual.stage2WalletInboundCny)}** | **${fmtCny(annual.stage3BankReceivedCny)}** | **${Number(annual.p0Count || 0)}/${Number(annual.p1Count || 0)}/${Number(annual.p2Count || 0)}** |`,
    ``,
  )

  if (s.crossEntityMixed && byEntity.length > 1) {
    lines.push(
      `## 二、分主体独立拆表（严禁跨主体合并申报）`,
      `| 核算主体 | 状态 | 覆盖月数 | 销售毛额 | 报送参考净额 | 平台费用 | Stage1 净放款 | Stage2 钱包实收 | Stage3 银行实收 | P0/P1 |`,
      `|---|---|---|---:|---:|---:|---:|---:|---:|---:|`,
      ...byEntity.map((ent) => `| ${mdText(ent.entityLabel)} | ${ent.ownershipStatus === 'unclaimed' ? '待认领' : '已认领'} | ${Number((ent.coveredMonths || []).length)}/12 | ${fmtCny(ent.annual?.grossCny)} | **${fmtCny(ent.annual?.netSalesCny)}** | ${fmtCny(ent.annual?.feesCny)} | ${fmtCny(ent.annual?.payoutCny)} | ${fmtCny(ent.annual?.stage2WalletInboundCny)} | ${fmtCny(ent.annual?.stage3BankReceivedCny)} | ${Number(ent.annual?.p0Count || 0)}/${Number(ent.annual?.p1Count || 0)} |`),
      ``,
    )
  }

  lines.push(`## ${s.crossEntityMixed && byEntity.length > 1 ? '三' : '二'}、${mdText(s.deadlineDate || '2027-01-31')} 全球三地平台数据交卷自检清单`)
  for (const card of cards) {
    const st = statusMeta(card.status)
    lines.push(`### ${mdText(card.title)} [${mdText(st.label)}]`)
    lines.push(`- **政策依据**：${mdText(card.policyRef || '')} ｜ **截止日期**：${mdText(card.deadline || '')}`)
    if (card.reporter) lines.push(`- **报送主体与范围**：${mdText(card.reporter)}`)
    if (card.scheduleNote) lines.push(`- **分期节点**：${mdText(card.scheduleNote)}`)
    if (card.paymentScopeNote) lines.push(`- **支付类型边界**：${mdText(card.paymentScopeNote)}`)
    if ((card.dataGaps || []).length) lines.push(`- **资料缺口**：${mdText(card.dataGaps.join('；'))}`)
    if ((card.alerts || []).length) {
      for (const a of card.alerts) lines.push(`- ⚠ ${mdText(a)}`)
    } else {
      lines.push(`- ✔ ${mdText(card.summary || '未检出异常告警。')}`)
    }
    for (const c of card.checklist || []) lines.push(`  - [ ] ${mdText(c)}`)
    lines.push(``)
  }

  lines.push(`## ${s.crossEntityMixed && byEntity.length > 1 ? '四' : '三'}、各平台全年汇总`)
  if (byPlatform.length) {
    lines.push(
      `| 平台 / 通道 | 销售毛额 | 客户退款 | 报送参考净额 | 平台费用 | 净放款 | 净额占比 |`,
      `|---|---:|---:|---:|---:|---:|---:|`,
      ...byPlatform.map((p) => `| ${mdText(p.platform)}${p.multiPlatform ? ' (组合归档)' : ''} | ${fmtCny(p.grossCny)} | ${fmtCny(p.refundCny)} | **${fmtCny(p.netSalesCny)}** | ${fmtCny(p.feesCny)} | ${fmtCny(p.payoutCny)} | ${Number(p.shareOfNetPct || 0).toFixed(2)}% |`),
    )
  } else {
    lines.push(`- 本年度暂无已归档平台数据。`)
  }

  lines.push(
    ``,
    `## 口径边界与离线声明`,
    `1. 本年度报表基于本机脱敏汇总 KPI 离线生成，绝不含原始订单明细或买家隐私；不同法人/个体户严禁跨主体合并申报。`,
    `2. 中国 810 号令、欧盟 DAC7、美国 IRS 1099-K 报送口径与会计收入、增值税、企业所得税口径须分别勾稽，严禁直接按银行回款净额申报。`,
  )
  if (includeResourceAppendix) {
    lines.push(`3. 扩展参考附页（由导出者主动勾选）：可在 DSH 侧边栏「财税工作台」接入本地已授权的知识库对照核查现行政策原文。`)
  }
  return lines.join('\n')
}

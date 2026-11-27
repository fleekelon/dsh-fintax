// Lower dual-column audit panels: Original-currency table + 17-channel indicators & Anomaly Radar.

import { ADAPTERS, WALLET_ADAPTERS, BANK_ADAPTERS, ANOMALY_PAGE_SIZE } from './constants.js'
import { Icon } from './components.js'

export function renderAuditLowerSection({
  t, data, busy, platform, onPlatformChange, handleFiles, handleDemo,
  loadedPlats, declDiag, anomalyGroups, anomalyCount, sevFilter, onSeverityFilter,
  platFilter, onPlatFilter, anomPlatforms, visibleAnoms, filteredCount, anomalyPage,
  setAnomalyPage, hasPartialCoverage, onCopyText, copiedKey, onOpenIma,
}) {
  const { P0: p0, P1: p1, P2: p2 } = anomalyGroups
  const bankLoaded = (data?.summaries || []).some((s) => s.role === 'bank_receipt') || Boolean(data?.consolidated?.fundChain?.stage3?.stats?.totalReceipts)

  return h(
    'div',
    { className: 'ftx-lower' },
    h(
      'section',
      { className: 'ftx-block' },
      h('div', { className: 'ftx-bhead' }, h('h2', null, '原币对账'), h('span', { className: 'ftx-secmeta' }, 'FX / 17 CHANNELS + BANK')),
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--ftx-mut)', gap: 8, flexWrap: 'wrap' } },
        h('span', null, data ? `${data.summaries.length} 份账单 · 逐表 BigInt 定点核验` : '支持 11 销售平台 + 6 结汇通道 + 国内对公银行回单及 .ZIP 直拖'),
        h(
          'select',
          { value: platform, onChange: (e) => onPlatformChange(e.target.value), className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5 } },
          h('option', { value: 'auto' }, t.platformAuto),
          h('option', { value: 'amazon' }, 'Amazon'), h('option', { value: 'tiktok' }, 'TikTok Shop'),
          h('option', { value: 'temu' }, 'Temu'), h('option', { value: 'aliexpress' }, '速卖通 AliExpress'),
          h('option', { value: 'shopee' }, 'Shopee 虾皮'), h('option', { value: 'shopify' }, 'Shopify'),
          h('option', { value: 'paypal' }, 'PayPal'), h('option', { value: 'stripe' }, 'Stripe'),
          h('option', { value: 'shein' }, 'SHEIN 希音'), h('option', { value: 'walmart' }, 'Walmart 沃尔玛'),
          h('option', { value: 'lazada' }, 'Lazada'),
          h('option', { value: 'worldfirst' }, '万里汇 WorldFirst'), h('option', { value: 'payoneer' }, '派安盈 Payoneer'),
          h('option', { value: 'airwallex' }, '空中云汇 Airwallex'), h('option', { value: 'lianlian' }, '连连国际 LianLian'),
          h('option', { value: 'pingpong' }, 'PingPong'), h('option', { value: 'sunrate' }, '寻汇 SUNRATE'),
          h('option', { value: 'bank_receipt' }, '国内对公银行回单 (招行/中行/工农建交)'),
        ),
      ),
      data
        ? h(
            'div',
            { style: { overflowX: 'auto' } },
            h(
              'table',
              { className: 'ftx-tbl' },
              h('thead', null, h('tr', null, h('th', null, '通道 · 站点'), h('th', null, '参考毛额 / 通道入账'), h('th', null, '放款 / 转出 / 银行实收'), h('th', null, '资金核验'))),
              h(
                'tbody',
                null,
                ...data.summaries.map((s, idx) => {
                  const isW = s.role === 'settlement_wallet' && s.walletMetrics
                  const isB = s.role === 'bank_receipt'
                  return h(
                    'tr',
                    { key: idx },
                    h(
                      'td',
                      null,
                      h('strong', null, isB ? `${s.bankLabel || s.platform || '对公银行'}` : `${s.platform} · ${s.site}`),
                      isW && h('span', { className: 'ftx-tag-w' }, '结汇'),
                      isB && h('span', { className: 'ftx-tag-b' }, '银行回单'),
                      h('div', { style: { fontSize: 10.5, color: 'var(--ftx-mut)', fontFamily: 'var(--ftx-mono)' } }, isB ? `${s.period} · 贷方 ${s.creditRowCount ?? 0} 笔` : isW ? `${s.period} · 费 ${s.walletMetrics.walletFees}` : `${s.period} · 佣金 ${s.totalFees}`),
                    ),
                    h('td', null, isB ? `${s.currency || 'CNY'} ${s.totalCreditCny ?? 0}` : isW ? `${s.currency} ${s.walletMetrics.platformInbound}` : `${s.currency} ${s.taxReportingGrossRef}`),
                    h(
                      'td',
                      null,
                      isB ? `手续费 ${s.totalBankFeeCny ?? 0}` : isW ? s.walletMetrics.fxWithdrawToCorporate : s.actualPayout,
                      isW
                        ? h(
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 } },
                            Number(s.walletMetrics.fxWithdrawToPersonal) > 0 && h('span', { style: { fontSize: 10.5, color: 'var(--ftx-orange)', fontWeight: 700 } }, `私户 P0: ${s.walletMetrics.fxWithdrawToPersonal}`),
                            Number(s.walletMetrics.unverifiedWithdraw) > 0 && h('span', { style: { fontSize: 10.5, color: 'var(--ftx-orange)' } }, `待核: ${s.walletMetrics.unverifiedWithdraw}`),
                            Number(s.walletMetrics.directSpend) > 0 && h('span', { style: { fontSize: 10.5, color: 'var(--ftx-mut)' } }, `坐支 ${s.walletMetrics.directSpend}`),
                          )
                        : !isB && Number(s.actualPayout) !== 0 && h('div', { title: t.payoutDiffHelp, style: { fontSize: 10.5, color: 'var(--ftx-mut)' } }, `${t.payoutDiff} ${s.statementPayoutDiff}`),
                    ),
                    h(
                      'td',
                      null,
                      isB
                        ? h('span', { style: { color: 'var(--ftx-ok)', fontWeight: 700, fontSize: 11, fontFamily: 'inherit' } }, '回单已读')
                        : isW && s.walletMetrics.netVerifiedRows === 0
                          ? h('span', { style: { color: 'var(--ftx-mut)', fontSize: 11, fontFamily: 'inherit' } }, '无 Net 列')
                          : h('span', { style: { color: s.horizontalBalanced ? 'var(--ftx-ok)' : 'var(--ftx-orange)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'inherit' } }, s.horizontalBalanced ? h(Icon, { kind: 'check', size: 12 }) : '!', s.horizontalBalanced ? '守恒' : `差 ${s.horizontalDiffTotal}`),
                    ),
                  )
                }),
              ),
            ),
          )
        : h(
            'div',
            { style: { padding: '20px 16px', border: '1px dashed var(--ftx-chassis-bd)', borderRadius: 4, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' } },
            h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--ftx-ink)' } }, '本机离线核对 17 通道账单 + 国内对公银行回单三段资金链'),
            h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, '无需配置 IMA，原始账单留在本机内存不上传，10ms 输出老板与财务核对单'),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' } },
              h('button', { type: 'button', className: 'ftx-act pri', style: { height: 38, padding: '0 14px' }, disabled: busy, onClick: () => handleDemo('v9') }, t.runDemoV9),
              h('button', { type: 'button', className: 'ftx-act', style: { height: 38, padding: '0 14px' }, disabled: busy, onClick: () => handleDemo('v8') }, t.runDemoV8),
              h(
                'label',
                { className: 'ftx-act drop', style: { height: 38, padding: '0 14px' } },
                h(Icon, { kind: 'upload', size: 15 }),
                h('span', null, busy ? t.parsing : '核对我的账单'),
                h('input', { type: 'file', multiple: true, accept: '.csv,.tsv,.txt,.xlsx,.xlsm,.zip', style: { display: 'none' }, onChange: (e) => { handleFiles(e.target.files); e.target.value = '' } }),
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', fontSize: 11, color: 'var(--ftx-mut)', alignItems: 'center' } },
              h('span', null, '其他示例：'),
              h('button', { type: 'button', className: 'ftx-btn-sm', style: { padding: '2px 7px', fontSize: 11 }, disabled: busy, onClick: () => handleDemo('v7') }, t.runDemoV7),
              h('button', { type: 'button', className: 'ftx-btn-sm', style: { padding: '2px 7px', fontSize: 11 }, disabled: busy, onClick: () => handleDemo('all') }, t.runDemo),
            ),
          ),
      h(
        'div',
        { className: 'ftx-adapters', style: { marginTop: 'auto' } },
        h('span', { style: { fontWeight: 700, color: 'var(--ftx-ink)' } }, '销售 11'),
        ...ADAPTERS.map((adp) => {
          const used = [...loadedPlats].some((p) => p.toLowerCase().includes(adp.toLowerCase().split(' ')[0]))
          return h('span', { key: adp, className: `ftx-adp${used ? ' used' : ''}` }, h('i', null), adp)
        }),
        h('span', { style: { fontWeight: 700, color: 'var(--ftx-ok)', marginLeft: 4 } }, '结汇 06'),
        ...WALLET_ADAPTERS.map((adp) => {
          const used = [...loadedPlats].some((p) => p.toLowerCase().includes(adp.toLowerCase()))
          return h('span', { key: adp, className: `ftx-adp wallet${used ? ' used' : ''}` }, h('i', null), adp)
        }),
        h('span', { style: { fontWeight: 700, color: 'var(--ftx-ink)', marginLeft: 4 } }, '回单'),
        h('span', { className: `ftx-adp bank${bankLoaded ? ' used' : ''}` }, h('i', null), '招行/中行/工农建交'),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--ftx-mut)' } }, h(Icon, { kind: 'chip', size: 14 }), '原始账单明细仅在本机内存解析 · 不外传'),
    ),
    h(
      'section',
      { className: 'ftx-block' },
      h(
        'div',
        { className: 'ftx-bhead' },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 12 } }, h('h2', null, '异常雷达'), h('span', { className: 'ftx-mono', style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, h('b', { style: { color: p0.length ? 'var(--ftx-orange)' : 'inherit' } }, `P0:${p0.length}`), ` / P1:${p1.length} / P2:${p2.length}`)),
        h('span', { className: 'ftx-secmeta' }, 'RISK / PRIORITY'),
      ),
      declDiag &&
        h(
          'div',
          { className: 'ftx-gap' },
          h('i', { className: 'att' }, '!'),
          h('span', { title: t.salesGapHelp, style: { fontSize: 12 } }, t.salesGap),
          h('b', null, `¥${Number(declDiag.unexplainedSalesGap).toLocaleString(undefined, { maximumFractionDigits: 2 })}`),
          h('small', { style: { marginLeft: 'auto', fontSize: 11.5, fontWeight: 600 } }, declDiag.nettingTrapDetected ? '高危 · 疑似回款净额报税' : '需核对跨口径差额'),
        ),
      anomalyCount > 0 &&
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
          h('button', { type: 'button', className: `ftx-btn-sm${sevFilter === 'ALL' ? ' on' : ''}`, onClick: () => onSeverityFilter('ALL') }, `全部 (${anomalyCount})`),
          h('button', { type: 'button', className: `ftx-btn-sm${sevFilter === 'P0' ? ' on' : ''}`, onClick: () => onSeverityFilter('P0') }, `P0 (${p0.length})`),
          h('button', { type: 'button', className: `ftx-btn-sm${sevFilter === 'P1' ? ' on' : ''}`, onClick: () => onSeverityFilter('P1') }, `P1 (${p1.length})`),
          h('button', { type: 'button', className: `ftx-btn-sm${sevFilter === 'P2' ? ' on' : ''}`, onClick: () => onSeverityFilter('P2') }, `P2 (${p2.length})`),
          anomPlatforms.length > 1 &&
            h(
              'select',
              { value: platFilter, onChange: (e) => onPlatFilter(e.target.value), className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5, marginLeft: 'auto' } },
              h('option', { value: 'ALL' }, '全部平台'),
              ...anomPlatforms.map((pl) => h('option', { key: pl, value: pl }, pl)),
            ),
        ),
      !data
        ? h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', padding: '18px 4px', lineHeight: 1.6 } }, '载入账单后自动扫描：私户结汇拦截（P0）、全托管/半托管混表阻断（P0）、余额坐支海外广告、2027 FBA 新费用与 Stage 3 银行回单 5 键核销异常。')
        : filteredCount === 0
          ? h('div', { style: { fontSize: 12.5, color: hasPartialCoverage ? 'var(--ftx-orange)' : 'var(--ftx-mut)', fontWeight: 700, padding: '10px 2px' } }, anomalyCount === 0 ? '已解析明细未检出异常交易。' : '当前筛选条件下无匹配异常。')
          : h(
              'div',
              { key: `anomalies-${sevFilter}-${platFilter}-${anomalyPage}`, className: 'ftx-risk-list' },
              ...visibleAnoms.map(({ anomaly: a, platform: adapter, scope }, idx) => {
                const sevCode = a.severity.slice(0, 2)
                const sevCls = sevCode === 'P0' ? 'p0' : sevCode === 'P1' ? 'p1' : ''
                const channel = ADAPTERS.includes(adapter) || WALLET_ADAPTERS.includes(adapter) || BANK_ADAPTERS.includes(adapter) ? adapter : '跨境账单'
                const qaPrompt = `请检索我的 IMA 财税知识库，列出 ${channel} 账单「${a.category}」的现行政策文号、应核对的凭证与财务处理步骤。`
                const copyKey = `anom-${sevFilter}-${platFilter}-${anomalyPage}-${idx}`
                return h(
                  'div',
                  { key: idx, className: 'ftx-risk-row', title: a.detail },
                  h('span', { className: `ftx-sev ${sevCls}` }, sevCode),
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h('div', { style: { fontWeight: 600, lineHeight: 1.35 } }, `${a.category} `, h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `· ${scope}`)),
                    h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', marginTop: 2, lineHeight: 1.4 } }, a.detail),
                  ),
                  h(
                    'div',
                    { className: 'ftx-risk-action' },
                    h('b', { className: 'ftx-mono', style: { fontSize: 12 } }, a.amount),
                    h(
                      'div',
                      { style: { display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' } },
                      h('button', { type: 'button', className: 'ftx-btn-sm', style: { padding: '2px 7px', fontSize: 10.5 }, onClick: () => onCopyText(copyKey, qaPrompt) }, copiedKey === copyKey ? t.copied : '查 IMA SOP'),
                      typeof onOpenIma === 'function' &&
                        h('button', { type: 'button', className: 'ftx-btn-sm', style: { padding: '2px 7px', fontSize: 10.5 }, onClick: () => onOpenIma(`${channel} ${a.category}`) }, t.imaQuickBtn),
                    ),
                  ),
                )
              }),
            ),
      filteredCount > ANOMALY_PAGE_SIZE &&
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
          h('button', { type: 'button', className: 'ftx-btn-sm', disabled: anomalyPage === 0, onClick: () => setAnomalyPage((page) => page - 1) }, '上一页'),
          h('span', { className: 'ftx-mono', style: { fontSize: 11.5 } }, `${anomalyPage + 1} / ${Math.ceil(filteredCount / ANOMALY_PAGE_SIZE)} 页`),
          h('button', { type: 'button', className: 'ftx-btn-sm', disabled: (anomalyPage + 1) * ANOMALY_PAGE_SIZE >= filteredCount, onClick: () => setAnomalyPage((page) => page + 1) }, '下一页'),
        ),
    ),
  )
}

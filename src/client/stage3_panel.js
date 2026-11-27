// Stage 1 -> Stage 2 -> Stage 3 (Domestic Bank Receipt 5-key fail-closed vs reference candidates) panel.

import { money } from './api.js'

const STAGE3_STATUS_MAP = {
  matched: { label: '5 键已全部核销', cls: 'ok' },
  partial: { label: '部分核销 · 存在在途/待核', cls: 'p1' },
  candidate_only: { label: '仅有参考候选 · 尚未法定核销', cls: 'p1' },
  pending_bank_receipt: { label: '待导国内对公银行回单', cls: 'p0' },
}

export function renderStage3FundChainPanel({ fc }) {
  if (!fc) return null
  const s3 = fc.stage3 || null
  const hasStage3Evidence = Boolean(
    s3 && (
      (fc.bankReceiptCount || 0) > 0 ||
      (s3.stats?.matchedCount || 0) > 0 ||
      (s3.stats?.candidateCount || 0) > 0 ||
      (s3.stats?.totalReceipts || 0) > 0
    ),
  )
  const hasGapDanger = fc.hasSalesStatements && fc.stage1to2Status !== 'matched'
  const stage3VerifiedCny = hasStage3Evidence && ((s3.stats?.matchedCount || 0) > 0 || fc.bankReceivedCny != null)
    ? (s3.stage3MatchedCny != null ? s3.stage3MatchedCny : fc.bankReceivedCny)
    : (!hasStage3Evidence ? fc.bankReceivedCny : null)
  const bankPending = hasStage3Evidence
    ? (s3.stage3Status === 'pending_bank_receipt' || s3.stage3Status === 'candidate_only')
    : (fc.stage3VerificationStatus === 'pending_bank_receipt' || fc.bankReceivedCny == null)
  const s3Badge = hasStage3Evidence ? (STAGE3_STATUS_MAP[s3.stage3Status] || STAGE3_STATUS_MAP.pending_bank_receipt) : null

  return h(
    'section',
    { className: 'ftx-chain' },
    h(
      'div',
      { className: 'ftx-bhead' },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
        h('h2', null, '三段资金链路交叉核对'),
        h('span', { style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, '平台放款 → 结汇通道入账 → 国内对公银行回单 5 键核销（结汇流水绝不重复计税）'),
      ),
      h('span', { className: 'ftx-secmeta' }, hasStage3Evidence ? `3-STAGE / ${String(s3.stage3Status || '').toUpperCase()}` : fc.hasSalesStatements ? '3-STAGE / PENDING RECEIPT' : 'WALLET ONLY'),
    ),
    h(
      'div',
      { className: 'ftx-chain-grid' },
      h(
        'div',
        { className: 'ftx-chain-cell' },
        h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '① 销售平台实际放款'),
        h('b', { className: 'ftx-mono', style: { fontSize: fc.hasSalesStatements ? 18 : 14, color: fc.hasSalesEvidence ? 'var(--ftx-ink)' : 'var(--ftx-mut)' } }, fc.hasSalesStatements ? money(fc.stage1PlatformPayoutCny) : '待导入销售账单'),
        h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, fc.hasSalesStatements ? `${fc.salesSheetCount} 份销售账单 · ${fc.stage1PayoutEvidenceCount ?? 0} 条放款凭证` : '合并拖入电商账单激活比对'),
      ),
      h(
        'div',
        { className: `ftx-chain-cell${hasGapDanger ? ' danger' : ''}` },
        h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '② 结汇通道平台入账'),
        h('b', { className: 'ftx-mono', style: { fontSize: 18 } }, money(fc.stage2WalletInboundCny)),
        h(
          'span',
          { className: 'ftx-mono', style: { fontSize: 11, color: hasGapDanger ? 'var(--ftx-orange)' : 'var(--ftx-mut)', fontWeight: 700 } },
          fc.hasSalesStatements
            ? `一/二段差 ${money(fc.stage1to2GapCny)}${fc.stage1to2GapCny == null ? ` · 未匹配放款 ${money(fc.stage1UnmatchedPayoutCny)} · 未匹配入账 ${money(fc.stage2UnmatchedInboundCny)}` : ''}`
            : `${fc.walletCount} 份结汇流水`,
        ),
        fc.stage2OtherInboundCny > 0 && h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `其他入账 ${money(fc.stage2OtherInboundCny)}`),
      ),
      h(
        'div',
        { className: `ftx-chain-cell${bankPending ? ' danger' : ' ok'}`, title: fc.stage3StatusNote },
        h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '③ 钱包转出企业户 / 银行实收'),
        h('b', { className: 'ftx-mono', style: { fontSize: 18, color: bankPending ? 'var(--ftx-orange)' : 'var(--ftx-ok)' } }, money(fc.stage3CorporateRepatriatedCny)),
        h('span', { className: 'ftx-mono', style: { fontSize: 11, color: bankPending ? 'var(--ftx-orange)' : 'var(--ftx-ok)', fontWeight: 700 } }, stage3VerifiedCny != null ? `法定 5 键银行实收 ${money(stage3VerifiedCny)}` : '银行实收 待核回单'),
        h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `钱包转出占比 ${fc.corporateRepatriationRatePct == null ? '待核' : `${fc.corporateRepatriationRatePct}%`}`),
      ),
      h(
        'div',
        { className: `ftx-chain-cell${fc.stage3PersonalWithdrawCny > 0 || (fc.stage3UnverifiedWithdrawCny || 0) > 0 ? ' danger' : ''}` },
        h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '私户 P0 / 待核 / 坐支 P1'),
        h('b', { className: 'ftx-mono', style: { fontSize: 15, color: fc.stage3PersonalWithdrawCny > 0 ? 'var(--ftx-orange)' : 'var(--ftx-ink)' } }, `${money(fc.stage3PersonalWithdrawCny)} / ${money(fc.stage3UnverifiedWithdrawCny)} / ${money(fc.directSpendCny)}`),
        h('span', { className: 'ftx-mono', style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `钱包手续费 ${money(fc.walletFeesCny)}`),
      ),
    ),
    hasStage3Evidence &&
      h(
        'div',
        { className: 'ftx-stage3-panel' },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
          h('strong', { style: { fontSize: 13 } }, 'Stage 3 国内对公银行回单核销明细（法定 5 键严格审计口径）'),
          s3Badge && h('span', { className: `ftx-sev ${s3Badge.cls}`, style: { width: 'auto', padding: '0 8px' } }, s3Badge.label),
        ),
        h(
          'div',
          { className: 'ftx-chain-grid' },
          h(
            'div',
            { className: 'ftx-chain-cell ok' },
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '法定 5 键已核销实收 CNY'),
            h('b', { className: 'ftx-mono', style: { fontSize: 17, color: 'var(--ftx-ok)' } }, money(s3.stage3MatchedCny)),
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `已核销 ${s3.matchedMatches?.length ?? s3.stats?.matchedCount ?? 0} 笔 / 应回流 ${money(s3.stage2CorporateExpectedCny)}`),
          ),
          h(
            'div',
            { className: 'ftx-chain-cell' },
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '银行扣费 CNY'),
            h('b', { className: 'ftx-mono', style: { fontSize: 17 } }, money(s3.bankFeeCny)),
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '入账回单手续费及实收短差'),
          ),
          h(
            'div',
            { className: `ftx-chain-cell${Number(s3.fxGapOrInTransitCny || 0) !== 0 ? ' danger' : ''}` },
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '汇损与在途差额 CNY'),
            h('b', { className: 'ftx-mono', style: { fontSize: 17, color: Number(s3.fxGapOrInTransitCny || 0) !== 0 ? 'var(--ftx-orange)' : 'var(--ftx-ink)' } }, money(s3.fxGapOrInTransitCny)),
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `在途未核销 ${money(s3.inTransitUnmatchedCny)} · 结汇汇差 ${money(s3.fxSpreadCny)}`),
          ),
        ),
        Array.isArray(s3.matchedMatches) && s3.matchedMatches.length > 0 &&
          h(
            'div',
            { style: { overflowX: 'auto' } },
            h(
              'table',
              { className: 'ftx-tbl' },
              h('thead', null, h('tr', null, h('th', null, '结汇通道 → 国内对公银行'), h('th', null, '账期 / 尾号'), h('th', null, '预期实收'), h('th', null, '银行实收'), h('th', null, '银行扣费 / 汇差'))),
              h(
                'tbody',
                null,
                ...s3.matchedMatches.map((m, idx) =>
                  h(
                    'tr',
                    { key: `s3m-${idx}` },
                    h('td', null, h('strong', null, `${m.walletPlatform} → ${m.bankLabel || m.bank}`)),
                    h('td', null, `${m.period}${m.accountSuffix ? ` · *${m.accountSuffix}` : ''}`),
                    h('td', null, `${m.currency} ${Number(m.expectedAmount || 0).toLocaleString()}`),
                    h('td', { style: { color: 'var(--ftx-ok)', fontWeight: 700 } }, `${m.currency} ${Number(m.receivedAmount || 0).toLocaleString()}`),
                    h('td', null, `费 ${Number(m.bankFee || 0).toLocaleString()} / 差 ${Number(m.fxDiff || 0).toLocaleString()}`),
                  ),
                ),
              ),
            ),
          ),
        Array.isArray(s3.stage3CandidateMatches) && s3.stage3CandidateMatches.length > 0 &&
          h(
            'div',
            { className: 'ftx-stage3-cand', 'data-testid': 'stage3-candidates' },
            h('div', { style: { fontSize: 11.8, fontWeight: 700, color: 'var(--ftx-gap-fg)' } }, `参考级待确认回单（不计入法定 5 键已核销 · 共 ${s3.stage3CandidateMatches.length} 组）`),
            ...s3.stage3CandidateMatches.map((cm, idx) =>
              h(
                'div',
                { key: `s3c-${idx}`, className: 'ftx-mono ftx-hist-text', title: cm.matchBasis, style: { fontSize: 11.2, color: 'var(--ftx-mut)', padding: '3px 7px', border: '1px solid var(--ftx-line)', borderRadius: 3, background: 'var(--ftx-paper)' } },
                `[参考待确认] ${cm.walletPlatform} → ${cm.bankLabel || cm.bank} (${cm.period}) ${cm.currency} 预期 ${Number(cm.expectedAmount || 0).toLocaleString()} / 实收 ${Number(cm.receivedAmount || 0).toLocaleString()} · 差 ${Number(cm.diffAmount || 0).toLocaleString()} — ${cm.matchBasis || '缺强凭证'}`,
              ),
            ),
          ),
        Array.isArray(s3.alerts) && s3.alerts.length > 0 &&
          h(
            'div',
            { className: 'ftx-gap', style: { flexDirection: 'column', alignItems: 'flex-start', gap: 4, fontSize: 11.8 } },
            ...s3.alerts.map((al, i) => h('div', { key: i }, al)),
          ),
      ),
    h('div', { className: 'ftx-hist-text', style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, `钱包期间净流 ${money(fc.signedNetFlowCny)} · 期初余额 ${money(fc.openingBalanceCny)} · 期末余额 ${money(fc.closingBalanceCny)} · 滞留境外 ${money(fc.retainedOffshoreCny)}`),
    (fc.matchedCorporateReturnCny > 0 || fc.unmatchedReturnCny > 0) && h('div', { className: 'ftx-hist-text', style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, `企业户毛转出 ${money(fc.grossCorporateWithdrawCny)} · 已匹配企业户退汇 ${money(fc.matchedCorporateReturnCny)} · 待核退汇 ${money(fc.unmatchedReturnCny)}`),
    fc.candidateMatches && fc.candidateMatches.length > 0 &&
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 10px', border: '1px dashed var(--ftx-gap-bd)', borderRadius: 4, background: 'var(--ftx-surface)' } },
        h('div', { style: { fontSize: 11.5, fontWeight: 700, color: 'var(--ftx-gap-fg)' } }, `一/二段参考级候选配对（待补主体/账号/回单确认，不替代法定 5 键核销 · ${fc.candidateMatches.length} 组）`),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, color: 'var(--ftx-mut)' } },
          ...fc.candidateMatches.map((m, i) =>
            h(
              'span',
              { key: `${m.platform}-${m.currency}-${i}`, className: 'ftx-mono ftx-hist-text', title: m.matchBasis, style: { padding: '2px 7px', border: '1px solid var(--ftx-line)', borderRadius: 3, background: 'var(--ftx-paper)' } },
              `${m.platform}(${m.period}) ${m.currency} ${Number(m.payoutAmount).toLocaleString()} → ${Number(m.inboundAmount).toLocaleString()} · 差 ${Number(m.diffAmount).toLocaleString()} [待确认]`,
            ),
          ),
        ),
      ),
    fc.stage3StatusNote && h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', lineHeight: 1.45 } }, `口径提示：${fc.stage3StatusNote}`),
    fc.byCurrency && fc.byCurrency.length > 0 &&
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11.5, color: 'var(--ftx-mut)' } },
        ...fc.byCurrency.map((c) =>
          h(
            'span',
            { key: c.currency, className: 'ftx-mono ftx-hist-text', style: { padding: '2px 7px', border: '1px solid var(--ftx-line)', borderRadius: 3, background: 'var(--ftx-surface)' } },
            fc.hasSalesStatements
              ? `${c.currency} 放款 ${c.platformPayout?.toLocaleString() ?? '待核'} → 入账 ${c.walletInbound?.toLocaleString() ?? '待核'} · 差额 ${c.stage1to2Gap?.toLocaleString() ?? '待核'} → 转出企业户 ${c.corporateWithdraw?.toLocaleString() ?? '待核'}`
              : `${c.currency} 入账 ${c.walletInbound?.toLocaleString() ?? '待核'} → 转出企业户 ${c.corporateWithdraw?.toLocaleString() ?? '待核'}`,
          ),
        ),
      ),
  )
}

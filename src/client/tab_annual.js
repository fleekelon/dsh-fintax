// Tab 3: Annual Q1-Q4 Summary, 2027-01-31 3-Jurisdiction Compliance Cards, Entity Reassign & Backup.

import { callApi, downloadText, money, readTextFile, useLatestRequest } from './api.js'
import { Icon } from './components.js'

const STATUS_BADGE = {
  ok: { zh: '正常', en: 'OK', cls: 'ok' },
  warn: { zh: '关注', en: 'WARN', cls: 'p1' },
  pending_data: { zh: '待补资料', en: 'PENDING DATA', cls: 'p1' },
  danger: { zh: '高危', en: 'ALERT', cls: 'p0' },
  pending: { zh: '待录', en: 'PENDING', cls: '' },
  not_applicable: { zh: '不适用', en: 'N/A', cls: '' },
}

function buildAnnualQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

export function AnnualArchiveTab({ active, t, isZh, onOpenIma }) {
  const [year, setYear] = useState('2026')
  const [entityKey, setEntityKey] = useState('')
  const [summary, setSummary] = useState(null)
  const [historyList, setHistoryList] = useState([])
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [includeAppendix, setIncludeAppendix] = useState(false)
  const [err, setErr] = useState('')
  const [infoMsg, setInfoMsg] = useState('')
  const [reassignTarget, setReassignTarget] = useState(null)
  const [reassignEntity, setReassignEntity] = useState('')
  const [reassignEntityKey, setReassignEntityKey] = useState('')
  const [reassignShop, setReassignShop] = useState('')
  const [reassignEuOrders, setReassignEuOrders] = useState('')
  const [reassignUsTxns, setReassignUsTxns] = useState('')
  const [reassignConflict, setReassignConflict] = useState(null)
  const [reassignBusy, setReassignBusy] = useState(false)
  const [importMode, setImportMode] = useState('merge_skip')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState('')
  const [startLoad] = useLatestRequest()
  const [startExport] = useLatestRequest()
  const [startReassign] = useLatestRequest()

  const loadAnnual = useCallback(async (targetYear = year, targetEntity = entityKey) => {
    const req = startLoad()
    setBusy(true)
    setErr('')
    try {
      const qs = buildAnnualQuery({ year: String(targetYear), entityKey: targetEntity || undefined })
      const [annualRes, histRes] = await Promise.all([
        callApi(`/history/annual?${qs}`, { signal: req.signal }),
        callApi('/history', { signal: req.signal }),
      ])
      if (!req.isCurrent()) return
      setSummary(annualRes?.summary || null)
      setHistoryList(Array.isArray(histRes?.history) ? histRes.history : [])
    } catch (e) {
      if (req.isCurrent()) setErr(e.message || (isZh ? '读取年度汇总失败' : 'Failed to load annual summary'))
    } finally {
      if (req.isCurrent()) setBusy(false)
    }
  }, [year, entityKey, startLoad, isZh])

  useEffect(() => {
    if (!active) return
    loadAnnual(year, entityKey)
  }, [active, year, entityKey, loadAnnual])

  const handleExportAnnual = async (format) => {
    const req = startExport()
    setExporting(true)
    setErr('')
    try {
      const qs = buildAnnualQuery({
        year: String(year),
        entityKey: entityKey || undefined,
        format,
        includeResourceAppendix: includeAppendix ? 'true' : 'false',
      })
      const res = await callApi(`/history/annual?${qs}`, { signal: req.signal })
      if (!req.isCurrent()) return
      if (typeof res?.content !== 'string') throw new Error('服务未返回年度报表内容')
      downloadText(res.content, res.filename || `fintax-annual-${year}.${format}`, res.mimeType || (format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8'))
      setInfoMsg(isZh ? `已导出 ${year} 年度报表 (${format.toUpperCase()}) ✓` : `Exported ${year} annual report (${format.toUpperCase()})`)
    } catch (e) {
      if (req.isCurrent()) setErr(e.message || '导出年度报表失败')
    } finally {
      if (req.isCurrent()) setExporting(false)
    }
  }

  const openReassign = (entry) => {
    setReassignTarget(entry)
    setReassignEntity(entry.entityLabel && entry.entityLabel !== '待认领' ? entry.entityLabel : '')
    setReassignEntityKey('')
    setReassignShop(entry.shopLabel || entry.storeScope || '')
    setReassignEuOrders(entry.euOrderCount != null ? String(entry.euOrderCount) : '')
    setReassignUsTxns(entry.usTransactionCount != null ? String(entry.usTransactionCount) : '')
    setReassignConflict(null)
    setInfoMsg('')
    setErr('')
  }

  const submitReassign = async (force = false) => {
    if (!reassignTarget || !reassignEntity.trim()) return
    const req = startReassign()
    setReassignBusy(true)
    setErr('')
    try {
      const origLabel = reassignTarget.entityLabel || reassignTarget.entityName || ''
      const nextEntityLabel = reassignEntity.trim()
      const explicitKey = reassignEntityKey.trim()
      const sameClaimedEntity = !explicitKey &&
        reassignTarget.ownershipStatus === 'claimed' &&
        Boolean(reassignTarget.entityKey) &&
        nextEntityLabel === origLabel
      const euOrdTrim = reassignEuOrders.trim()
      const usTxnTrim = reassignUsTxns.trim()
      const origEuStr = reassignTarget.euOrderCount != null ? String(reassignTarget.euOrderCount) : ''
      const origUsStr = reassignTarget.usTransactionCount != null ? String(reassignTarget.usTransactionCount) : ''
      const res = await callApi('/history/reassign', {
        method: 'POST',
        signal: req.signal,
        body: JSON.stringify({
          archiveId: reassignTarget.id,
          ...(explicitKey
            ? { entityKey: explicitKey, entityLabel: nextEntityLabel }
            : sameClaimedEntity
              ? { entityKey: reassignTarget.entityKey, entityLabel: nextEntityLabel }
              : { entityLabel: nextEntityLabel }),
          shopLabel: reassignShop.trim() || undefined,
          ...(euOrdTrim !== origEuStr ? { euOrderCount: euOrdTrim === '' ? null : Number(euOrdTrim) } : {}),
          ...(usTxnTrim !== origUsStr ? { usTransactionCount: usTxnTrim === '' ? null : Number(usTxnTrim) } : {}),
          expectedRevision: reassignTarget.revision || undefined,
          force,
        }),
      })
      if (!req.isCurrent()) return
      setReassignTarget(null)
      setReassignConflict(null)
      setInfoMsg(res.overwritten ? '已强制覆盖并完成主体重分配 ✓' : '已完成主体认领与重分配 ✓')
      await loadAnnual(year, entityKey)
    } catch (e) {
      if (!req.isCurrent()) return
      if (e.status === 409 && e.data?.conflict) {
        setReassignConflict(e.data)
      } else {
        setErr(e.message || '主体重分配失败')
      }
    } finally {
      if (req.isCurrent()) setReassignBusy(false)
    }
  }

  const handleExportBackup = async () => {
    setBackupBusy(true)
    setBackupMsg('')
    setErr('')
    try {
      const res = await callApi('/history/backup')
      const content = JSON.stringify(res.backup || res, null, 2)
      downloadText(content, res.filename || 'dsh-fintax-history-backup.json', 'application/json;charset=utf-8')
      setBackupMsg(isZh ? `已导出 ${res.backup?.recordCount ?? 0} 条归档安全备份（含 SHA-256 校验摘要）✓` : `Exported ${res.backup?.recordCount ?? 0} archived records`)
    } catch (e) {
      setErr(e.message || '导出备份失败')
    } finally {
      setBackupBusy(false)
    }
  }

  const handleImportBackupFile = async (file) => {
    if (!file) return
    setBackupBusy(true)
    setBackupMsg('')
    setErr('')
    try {
      const rawText = await readTextFile(file)
      const parsed = JSON.parse(rawText)
      const res = await callApi('/history/backup', {
        method: 'POST',
        body: JSON.stringify({ backup: parsed, mode: importMode, verifyChecksum: true }),
      })
      setBackupMsg(isZh
        ? `备份导入完成：新增 ${res.imported ?? 0} 条 / 跳过 ${res.skipped ?? 0} 条 / 覆盖 ${res.overwritten ?? 0} 条（库内共 ${res.totalInStore ?? 0} 条）✓`
        : `Import done: +${res.imported ?? 0} / skipped ${res.skipped ?? 0} / overwritten ${res.overwritten ?? 0}`)
      await loadAnnual(year, entityKey)
    } catch (e) {
      setErr(`导入备份失败：${e.message}`)
    } finally {
      setBackupBusy(false)
    }
  }

  const years = [...new Set(['2025', '2026', '2027', ...historyList.map((x) => String(x.month || '').slice(0, 4)).filter((y) => /^\d{4}$/.test(y))])].sort()
  const entities = summary?.availableEntities || []
  const entityLabelCounts = new Map()
  for (const ent of entities) {
    entityLabelCounts.set(ent.entityLabel, (entityLabelCounts.get(ent.entityLabel) || 0) + 1)
  }
  const cards = summary?.threeJurisdictions?.cards || []
  const quarters = summary?.quarters || []
  const byEntity = Array.isArray(summary?.byEntity) ? summary.byEntity : []
  const displayArchives = historyList
    .filter((it) => {
      if (!String(it.month || '').startsWith(`${year}-`)) return false
      if (entityKey) {
        const itKey = it.entityKey || (it.ownershipStatus === 'unclaimed' ? 'unclaimed' : '')
        return itKey === entityKey
      }
      return true
    })
    .sort((a, b) => {
      const aUncl = a.ownershipStatus === 'unclaimed' || (a.entityLabel || a.entityName || '待认领') === '待认领' ? 0 : 1
      const bUncl = b.ownershipStatus === 'unclaimed' || (b.entityLabel || b.entityName || '待认领') === '待认领' ? 0 : 1
      return aUncl - bUncl
    })
  const isRevisionConflict = Boolean(
    reassignConflict && (
      reassignConflict.reason === 'revision_mismatch' ||
      reassignConflict.reason === 'revision_conflict' ||
      reassignConflict.conflictType === 'revision_conflict' ||
      reassignConflict.code === 'REVISION_CONFLICT'
    ),
  )

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    h(
      'section',
      { className: 'ftx-panel' },
      h(
        'div',
        { className: 'ftx-bhead' },
        h('div', null, h('h2', null, t.annualTitle), h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', marginTop: 2 } }, summary ? `统计口径：${summary.scopeLabel} · 截止节点 ${summary.deadlineDate}` : '按自然年聚合 Q1–Q4 归档与全球三地报送红线')),
        h('span', { className: 'ftx-secmeta' }, `ANNUAL / ${year}`),
      ),
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
        h(
          'select',
          { value: year, onChange: (e) => setYear(e.target.value), className: 'ftx-input', 'aria-label': '选择自然年' },
          ...years.map((y) => h('option', { key: y, value: y }, `${y} 自然年`)),
        ),
        h(
          'select',
          { value: entityKey, onChange: (e) => setEntityKey(e.target.value), className: 'ftx-input', 'aria-label': '筛选年度主体' },
          h('option', { value: '' }, t.annualAllEntities),
          ...entities.map((ent) => {
            const dupLabel = (entityLabelCounts.get(ent.entityLabel) || 0) > 1
            return h(
              'option',
              { key: ent.entityKey, value: ent.entityKey },
              `${ent.entityLabel}${dupLabel ? ` [${ent.entityKey}]` : ''}${ent.ownershipStatus === 'unclaimed' ? ' [待认领]' : ''} (${ent.snapshotCount})`,
            )
          }),
        ),
        h('button', { type: 'button', className: 'ftx-btn-sm', disabled: busy, onClick: () => loadAnnual(year, entityKey) }, busy ? '刷新中…' : t.annualRefresh),
        h('button', { type: 'button', className: 'ftx-btn-sm on', disabled: exporting || !summary, onClick: () => handleExportAnnual('html') }, t.annualExportHtml),
        h('button', { type: 'button', className: 'ftx-btn-sm', disabled: exporting || !summary, onClick: () => handleExportAnnual('md') }, t.annualExportMd),
        h(
          'label',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--ftx-mut)', cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: includeAppendix, onChange: (e) => setIncludeAppendix(e.target.checked) }),
          '附带参考指引',
        ),
      ),
      err && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, err)),
      infoMsg && h('div', { style: { fontSize: 12, fontWeight: 700, color: 'var(--ftx-ok)' } }, infoMsg),
      summary?.mixingProtectionWarning && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, summary.mixingProtectionWarning)),
      summary?.unclaimedWarning && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, summary.unclaimedWarning)),
      summary?.missingMonthsNote && h('div', { style: { fontSize: 12, color: summary.missingMonthsCount > 0 ? 'var(--ftx-orange)' : 'var(--ftx-ok)', fontWeight: 600 } }, summary.missingMonthsNote),
      Array.isArray(summary?.monthlySeries) && summary.monthlySeries.length > 0 &&
        h(
          'div',
          { className: 'ftx-month-strip' },
          ...summary.monthlySeries.map((m) =>
            h(
              'div',
              { key: m.month, className: `ftx-month-pill ${m.status === 'missing' ? 'miss' : 'rec'}`, title: `${m.month}: ${m.status === 'missing' ? '缺失' : money(m.netSalesCny)}` },
              h('div', null, m.month.slice(5)),
              h('div', { style: { fontSize: 9.5, fontWeight: 500 } }, m.status === 'missing' ? '缺档' : m.status === 'zero_confirmed' ? '零收入' : `${m.snapshotCount}档`),
            ),
          ),
        ),
      summary &&
        h(
          'div',
          { style: { overflowX: 'auto' } },
          h(
            'table',
            { className: 'ftx-tbl' },
            h('thead', null, h('tr', null, h('th', null, '季度 / 汇总'), h('th', null, '报送参考毛额'), h('th', null, '净销售额'), h('th', null, '平台放款'), h('th', null, 'Stage 2 结汇'), h('th', null, 'Stage 3 银行实收'), h('th', null, 'P0 / 缺月'))),
            h(
              'tbody',
              null,
              ...quarters.map((q) =>
                h(
                  'tr',
                  { key: q.quarter },
                  h('td', null, h('strong', null, q.label || q.quarter)),
                  h('td', null, money(q.grossCny)),
                  h('td', null, money(q.netSalesCny)),
                  h('td', null, money(q.payoutCny)),
                  h('td', null, money(q.stage2WalletInboundCny)),
                  h('td', null, money(q.stage3BankReceivedCny)),
                  h('td', { style: { color: (q.p0Count > 0 || q.missingMonths?.length > 0) ? 'var(--ftx-orange)' : 'var(--ftx-ok)' } }, `P0:${q.p0Count || 0} / 缺${q.missingMonths?.length || 0}月`),
                ),
              ),
              summary.annual &&
                h(
                  'tr',
                  { style: { fontWeight: 700, background: 'var(--ftx-th-bg)' } },
                  h('td', null, h('strong', null, `${year} 全年合计${summary.annual.referenceOnly ? ' (参考)' : ''}`)),
                  h('td', null, money(summary.annual.grossCny)),
                  h('td', null, money(summary.annual.netSalesCny)),
                  h('td', null, money(summary.annual.payoutCny)),
                  h('td', null, money(summary.annual.stage2WalletInboundCny)),
                  h('td', null, money(summary.annual.stage3BankReceivedCny)),
                  h('td', null, `P0:${summary.annual.p0Count || 0} / 缺${summary.annual.missingMonthCount || 0}月`),
                ),
            ),
          ),
        ),
    ),
    cards.length > 0 &&
      h(
        'section',
        { className: 'ftx-panel' },
        h(
          'div',
          { className: 'ftx-bhead' },
          h('h2', null, `${summary?.deadlineDate || '2027-01-31'} 全球三地报送自检卡`),
          h('span', { className: 'ftx-secmeta' }, 'CN 810 / EU DAC7 / US 1099-K'),
        ),
        h(
          'div',
          { className: 'ftx-juris-grid' },
          ...cards.map((card) => {
            const st = STATUS_BADGE[card.status] || STATUS_BADGE.pending
            const queryHint = card.jurisdiction === 'CN' ? '810号令 四层口径' : card.jurisdiction === 'EU' ? 'DAC7 欧盟报送' : '1099-K W-8BEN-E'
            const cardAlerts = Array.isArray(card.alerts) ? card.alerts : []
            const cardGaps = Array.isArray(card.dataGaps) ? card.dataGaps : []
            const showStateBadge = card.id === 'us_1099k' && card.metrics?.stateThresholdWarning === true
            return h(
              'article',
              { key: card.id, className: `ftx-juris-card${card.status === 'danger' ? ' danger' : card.status === 'ok' ? ' ok' : ''}` },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
                h('strong', { style: { fontSize: 13 } }, card.title),
                h('span', { className: `ftx-sev ${st.cls}`, style: { width: 'auto', padding: '0 6px' } }, isZh ? st.zh : st.en),
              ),
              h('div', { className: 'ftx-mono', style: { fontSize: 10.5, color: 'var(--ftx-mut)' } }, `${card.policyRef || ''} · 截止 ${card.deadline || '2027-01-31'}`),
              (card.reporter || card.scheduleNote || card.paymentScopeNote) &&
                h('div', { style: { fontSize: 11, color: 'var(--ftx-mut)', lineHeight: 1.45 } }, [card.reporter ? `报送主体：${card.reporter}` : '', card.scheduleNote || '', card.paymentScopeNote || ''].filter(Boolean).join(' ｜ ')),
              h('div', { style: { fontSize: 12, lineHeight: 1.48 } }, card.summary),
              cardGaps.length > 0 &&
                h(
                  'div',
                  { className: 'ftx-juris-gaps', style: { fontSize: 11.2, color: 'var(--ftx-orange)', background: 'rgba(197,75,30,0.06)', border: '1px solid var(--ftx-line)', borderRadius: 4, padding: '5px 8px', lineHeight: 1.45 } },
                  h('strong', null, '资料缺口（仅掌握已知下限）：'),
                  cardGaps.join('；'),
                ),
              showStateBadge &&
                h(
                  'div',
                  { className: 'ftx-juris-state-note', style: { fontSize: 11.2, fontWeight: 650, color: 'var(--ftx-orange)' } },
                  '州级提醒：美国部分州 1099-K 门槛低至 $600（MD/MA/VT/VA）或 $1,000（IL/NJ），须逐州核对。',
                ),
              cardAlerts.length > 0 &&
                h(
                  'ul',
                  { className: 'ftx-juris-alerts', style: { margin: '2px 0 0', paddingInlineStart: 16, fontSize: 11.4, color: 'var(--ftx-orange)', fontWeight: 600, lineHeight: 1.48 } },
                  ...cardAlerts.map((item, idx) => h('li', { key: `alert-${idx}` }, item)),
                ),
              Array.isArray(card.checklist) && card.checklist.length > 0 &&
                h('ul', { style: { margin: '2px 0 0', paddingInlineStart: 16, fontSize: 11.3, color: 'var(--ftx-mut)', lineHeight: 1.45 } }, ...card.checklist.map((item, idx) => h('li', { key: `chk-${idx}` }, item))),
              typeof onOpenIma === 'function' &&
                h('button', { type: 'button', className: 'ftx-btn-sm', style: { alignSelf: 'flex-start', marginTop: 'auto' }, onClick: () => onOpenIma(queryHint) }, t.imaQuickBtn),
            )
          }),
        ),
        summary?.crossEntityMixed && byEntity.length > 1 &&
          h(
            'div',
            { style: { overflowX: 'auto', marginTop: 8 } },
            h(
              'table',
              { className: 'ftx-tbl' },
              h('thead', null, h('tr', null, h('th', null, '独立法人主体（分主体判定）'), h('th', null, '全年净额'), h('th', null, 'CN 810'), h('th', null, 'EU DAC7'), h('th', null, 'US 1099-K'))),
              h(
                'tbody',
                null,
                ...byEntity.map((ent) => {
                  const cnSt = STATUS_BADGE[ent.threeJurisdictions?.china810?.status] || STATUS_BADGE.pending
                  const euSt = STATUS_BADGE[ent.threeJurisdictions?.euDac7?.status] || STATUS_BADGE.not_applicable
                  const usSt = STATUS_BADGE[ent.threeJurisdictions?.us1099k?.status] || STATUS_BADGE.not_applicable
                  return h(
                    'tr',
                    { key: ent.entityKey },
                    h('td', null, h('strong', null, ent.entityLabel), h('span', { className: 'ftx-mono', style: { fontSize: 10.5, color: 'var(--ftx-mut)', marginLeft: 4 } }, `[${ent.entityKey}]`)),
                    h('td', null, money(ent.annual?.netSalesCny)),
                    h('td', null, isZh ? cnSt.zh : cnSt.en),
                    h('td', null, isZh ? euSt.zh : euSt.en),
                    h('td', null, isZh ? usSt.zh : usSt.en),
                  )
                }),
              ),
            ),
          ),
      ),
    h(
      'div',
      { className: 'ftx-lower' },
      h(
        'section',
        { className: 'ftx-panel' },
        h('div', { className: 'ftx-inst-head' }, h('span', null, t.annualReassignTitle), h('small', null, `${displayArchives.length} SNAPSHOTS`)),
        reassignTarget &&
          h(
            'div',
            { className: 'ftx-stage3-panel', role: 'region', 'aria-label': '主体重分配表单' },
            h('div', { style: { fontSize: 12.5, fontWeight: 700 } }, `重分配快照：${reassignTarget.month} · ${reassignTarget.entityLabel || reassignTarget.entityName || '待认领'} · ${reassignTarget.storeScope || ''}`),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              h('input', { type: 'text', className: 'ftx-input', style: { flex: '1 1 140px' }, value: reassignEntity, placeholder: '目标法人/公司主体名称', onChange: (e) => { setReassignEntity(e.target.value); setReassignConflict(null) } }),
              h('input', { type: 'text', className: 'ftx-input', style: { flex: '1 1 135px' }, value: reassignEntityKey, 'aria-label': '目标主体唯一编码', placeholder: '主体唯一编码/信用代码（可选）', onChange: (e) => { setReassignEntityKey(e.target.value); setReassignConflict(null) } }),
              h('input', { type: 'text', className: 'ftx-input', style: { flex: '1 1 120px' }, value: reassignShop, placeholder: '店铺/范围（可选）', onChange: (e) => { setReassignShop(e.target.value); setReassignConflict(null) } }),
              h('input', { type: 'number', min: 0, step: 1, className: 'ftx-input', style: { flex: '1 1 115px' }, value: reassignEuOrders, 'aria-label': '补录欧盟订单笔数', placeholder: '补录欧盟订单数（可选）', onChange: (e) => setReassignEuOrders(e.target.value) }),
              h('input', { type: 'number', min: 0, step: 1, className: 'ftx-input', style: { flex: '1 1 115px' }, value: reassignUsTxns, 'aria-label': '补录美国交易笔数', placeholder: '补录美国交易笔数（可选）', onChange: (e) => setReassignUsTxns(e.target.value) }),
            ),
            reassignConflict
              ? isRevisionConflict
                ? h(
                    'div',
                    { className: 'ftx-gap', style: { fontSize: 11.8 } },
                    h('i', { className: 'att' }, '!'),
                    h('span', { style: { flex: '1 1 180px' } }, '该归档快照版本已过期（可能已在别处更新），请刷新最新数据后再提交重分配。'),
                    h('button', { type: 'button', className: 'ftx-btn-sm on', disabled: busy, onClick: async () => { setReassignConflict(null); setReassignTarget(null); await loadAnnual(year, entityKey) } }, '刷新最新数据'),
                    h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => setReassignConflict(null) }, '取消'),
                  )
                : h(
                    'div',
                    { className: 'ftx-gap', style: { fontSize: 11.8 } },
                    h('i', { className: 'att' }, '!'),
                    h('span', { style: { flex: '1 1 180px' } }, `目标主体+店铺+账期已存在冲突归档（${reassignConflict.conflicts?.length || 1} 份）。确认覆盖现有归档吗？`),
                    h('button', { type: 'button', className: 'ftx-btn-sm on', disabled: reassignBusy, onClick: () => submitReassign(true) }, '确认强制覆盖 (force)'),
                    h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => setReassignConflict(null) }, '取消'),
                  )
              : h(
                  'div',
                  { style: { display: 'flex', gap: 6 } },
                  h('button', { type: 'button', className: 'ftx-btn-sm on', disabled: reassignBusy || !reassignEntity.trim(), onClick: () => submitReassign(false) }, reassignBusy ? '提交中…' : '提交认领 / 重分配'),
                  h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => { setReassignTarget(null); setReassignConflict(null) } }, '取消'),
                ),
          ),
        displayArchives.length === 0
          ? h('div', { style: { fontSize: 12, color: 'var(--ftx-mut)' } }, `当前筛选范围（${year} 年${entityKey ? ` · ${entityKey}` : ''}）下尚无历史归档快照，请在「账单离线排雷」页解析后点击归档。`)
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' } },
              ...displayArchives.map((it) => {
                const ent = it.entityLabel || it.entityName || '待认领'
                const isUnclaimed = it.ownershipStatus === 'unclaimed' || ent === '待认领'
                return h(
                  'div',
                  { key: it.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--ftx-line)', fontSize: 12 } },
                  h(
                    'div',
                    { className: 'ftx-hist-text', style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
                    h('span', { className: 'ftx-sev' }, String(it.month || '').slice(2)),
                    h('span', { className: `ftx-sev ftx-hist-entity ${isUnclaimed ? 'p0' : ''}`, style: { width: 'auto', padding: '0 6px' } }, ent),
                    h('strong', null, it.shopLabel || it.storeScope || it.label),
                    h('b', { className: 'ftx-mono' }, money(it.netSalesCny)),
                  ),
                  h('button', { type: 'button', className: `ftx-btn-sm${isUnclaimed ? ' on' : ''}`, onClick: () => openReassign(it) }, t.annualReassignBtn),
                )
              }),
            ),
      ),
      h(
        'section',
        { className: 'ftx-panel' },
        h('div', { className: 'ftx-inst-head' }, h('span', null, t.annualBackupTitle), h('small', null, 'SHA-256 / V1')),
        h('div', { style: { fontSize: 12, color: 'var(--ftx-mut)', lineHeight: 1.5 } }, '导出带 SHA-256 完整性防损校验摘要的归档 JSON 备份（用于防截断/防损坏，区别于密码学来源签名）；导入强制校验摘要，支持按 UUID 幂等合并恢复（merge_skip / merge_overwrite）。'),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
          h('button', { type: 'button', className: 'ftx-act pri', style: { height: 38 }, disabled: backupBusy, onClick: handleExportBackup }, h(Icon, { kind: 'download', size: 15 }), t.annualBackupExport),
          h(
            'select',
            { value: importMode, onChange: (e) => setImportMode(e.target.value), className: 'ftx-input', 'aria-label': '备份导入模式' },
            h('option', { value: 'merge_skip' }, '合并跳过冲突 (merge_skip)'),
            h('option', { value: 'merge_overwrite' }, '合并覆盖冲突 (merge_overwrite)'),
          ),
          h(
            'label',
            { className: 'ftx-act drop', style: { height: 38, padding: '0 14px' } },
            h(Icon, { kind: 'upload', size: 15 }),
            h('span', null, backupBusy ? '处理中…' : t.annualBackupImport),
            h('input', { type: 'file', accept: '.json,application/json', 'aria-label': '选择备份文件', style: { display: 'none' }, onChange: (e) => { const f = e.target.files?.[0]; if (f) handleImportBackupFile(f); e.target.value = '' } }),
          ),
        ),
        backupMsg && h('div', { style: { fontSize: 12, fontWeight: 700, color: 'var(--ftx-ok)' } }, backupMsg),
      ),
    ),
  )
}

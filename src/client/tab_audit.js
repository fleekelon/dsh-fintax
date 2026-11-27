// Tab 1: Offline Statement Radar (17 channels + bank receipts, demo:v9, Stage 3, parseCache export).

import { DEMO_FX, MAX_UPLOAD_FILES, MAX_UPLOAD_BYTES, ANOMALY_PAGE_SIZE } from './constants.js'
import { callApi, downloadText, fileToBase64, money, numericFxRates, useLatestRequest } from './api.js'
import { CoverageDetails, DialGauge, Icon } from './components.js'
import { renderStage3FundChainPanel } from './stage3_panel.js'
import { renderAuditLowerSection } from './audit_tables.js'

export function StatementRadarTab({ active = true, t, status, refreshStatus, onCopyText, copiedKey, onJumpToCalc, onOpenIma }) {
  const [dragging, setDragging] = useState(false)
  const [platform, setPlatform] = useState('auto')
  const [source, setSource] = useState(null)
  const [reportPayload, setReportPayload] = useState(null)
  const [cacheToken, setCacheToken] = useState(null)
  const [fxMap, setFxMap] = useState({})
  const fxEditVersion = useRef(0)
  const fxSaveLock = useRef(false)
  const [startFxSave] = useLatestRequest()
  const [fxSaving, setFxSaving] = useState(false)
  const [fxSaveMsg, setFxSaveMsg] = useState('')
  const [declaredCny, setDeclaredCny] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [failedCoverage, setFailedCoverage] = useState(null)
  const [data, setData] = useState(null)
  const [startParse, invalidateParse] = useLatestRequest()
  const [startReportExport, invalidateReportExport] = useLatestRequest()
  const [reportExporting, setReportExporting] = useState(false)
  const [inputsChanged, setInputsChanged] = useState(false)
  const [sevFilter, setSevFilter] = useState('ALL')
  const [platFilter, setPlatFilter] = useState('ALL')
  const [anomalyPage, setAnomalyPage] = useState(0)
  const [showFxBar, setShowFxBar] = useState(false)
  const [showHistList, setShowHistList] = useState(false)
  const [histState, setHistState] = useState({ history: [], rolling12m: null })
  const [historyRevision, setHistoryRevision] = useState(0)
  const [historyPage, setHistoryPage] = useState(0)
  const [historyError, setHistoryError] = useState('')
  const [startHistory, invalidateHistory] = useLatestRequest()
  const [startHistoryDelete] = useLatestRequest()
  const [startTrend, invalidateTrend] = useLatestRequest()
  const [startSnapshot, invalidateSnapshot] = useLatestRequest()
  const [snapSaving, setSnapSaving] = useState(false)
  const snapshotSaveLock = useRef(false)
  const [activeEntityFilter, setActiveEntityFilter] = useState('')
  const [snapEntity, setSnapEntity] = useState('')
  const [snapEntityKey, setSnapEntityKey] = useState('')
  const [snapDistinctNewEntity, setSnapDistinctNewEntity] = useState(false)
  const [snapStore, setSnapStore] = useState('')
  const [snapVatType, setSnapVatType] = useState('unknown')
  const [snapCitMode, setSnapCitMode] = useState('unknown')
  const [snapZeroSales, setSnapZeroSales] = useState(false)
  const [snapConflict, setSnapConflict] = useState(null)
  const [snapLabel, setSnapLabel] = useState('')
  const [snapMonth, setSnapMonth] = useState('')
  const [snapMsg, setSnapMsg] = useState('')
  const [includeAppendix, setIncludeAppendix] = useState(false)

  useEffect(() => {
    if (fxEditVersion.current !== 0 || !status?.customFxRates) return
    setFxMap(numericFxRates(status.customFxRates))
  }, [status?.customFxRates])

  const refreshHistory = useCallback(() => {
    invalidateHistory()
    setHistoryRevision((previous) => previous + 1)
  }, [invalidateHistory])

  useEffect(() => {
    if (!active) return
    const request = startHistory()
    const qs = activeEntityFilter ? `?entity=${encodeURIComponent(activeEntityFilter)}` : ''
    setHistoryError('')
    callApi(`/history${qs}`, { signal: request.signal }).then((res) => {
      if (!request.isCurrent()) return
      setHistState({ entity: activeEntityFilter, history: res.history || [], rolling12m: res.rolling12m || null })
    }).catch((e) => {
      if (request.isCurrent()) setHistoryError(`读取归档失败：${e.message}`)
    })
  }, [active, activeEntityFilter, historyRevision, startHistory])

  const selectEntity = (entity) => {
    invalidateHistory(); invalidateTrend(); setActiveEntityFilter(entity); setHistoryPage(0)
  }

  const markInputsChanged = () => {
    invalidateParse(); invalidateReportExport(); invalidateSnapshot()
    setReportExporting(false); setSnapSaving(false); setBusy(false)
    setCacheToken(null)
    setInputsChanged(Boolean(source || data))
    setSnapConflict(null); setSnapMsg('')
  }

  const beginParse = () => {
    invalidateReportExport(); setReportExporting(false)
    invalidateSnapshot(); setSnapSaving(false)
    setData(null); setReportPayload(null); setCacheToken(null)
    setBusy(true); setErr(''); setFailedCoverage(null)
    setSnapMsg(''); setSnapConflict(null); setInputsChanged(false)
    return startParse()
  }

  const runParse = async (batch, options = {}) => {
    const { request = beginParse(), declared = declaredCny, isNew = false, confirmFx = false } = options
    try {
      const fxRates = numericFxRates(batch.demo ? { ...DEMO_FX, ...fxMap } : fxMap)
      const declNum = declared !== '' && Number.isFinite(Number(declared)) ? Number(declared) : undefined
      const payload = {
        platform, fxRates, fxConfirmed: !batch.demo && confirmFx, declaredVatSalesCny: declNum,
        ...(batch.demo ? { demo: batch.demo } : { files: batch.files }),
      }
      const res = await callApi('/parse', {
        method: 'POST', body: JSON.stringify({ ...payload, reportFormat: 'data' }),
        timeout: 45000, signal: request.signal,
      })
      if (!request.isCurrent()) return
      setData(res)
      setReportPayload(payload)
      setCacheToken(typeof res?.cacheToken === 'string' && res.cacheToken ? res.cacheToken : null)
      setSevFilter('ALL'); setPlatFilter('ALL'); setAnomalyPage(0)
      if (!isNew) return
      const summaries = res.summaries || []
      const plats = [...new Set(summaries.map((s) => s.platform).filter(Boolean))]
      const sales = summaries.filter((s) => s.role !== 'settlement_wallet' && s.role !== 'bank_receipt')
      const salesPlats = [...new Set(sales.map((s) => s.platform).filter(Boolean))]
      const periods = new Set((sales.length ? sales : summaries).map((s) => s.period))
      const period = periods.values().next().value
      const firstPeriod = periods.size === 1 && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period) ? period : ''
      setSnapMonth(res.archiveMonth || firstPeriod)
      setSnapStore((salesPlats.length ? salesPlats : plats).join('+'))
      setSnapLabel(`${firstPeriod} ${plats.join('+')} 月结核对`.trim())
      setSnapZeroSales(false)
    } catch (e) {
      if (request.isCurrent()) {
        if (isNew) setSource(null)
        setErr(e.message || '解析失败')
        setFailedCoverage(e.data?.coverage || null)
      }
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }

  const handlePersistFxRates = async (reset) => {
    if (fxSaveLock.current) return
    const request = startFxSave()
    const draftVersion = ++fxEditVersion.current
    fxSaveLock.current = true; setFxSaving(true); setFxSaveMsg('')
    try {
      const res = await callApi('/settings', {
        method: 'POST', signal: request.signal,
        body: JSON.stringify({ customFxRates: reset ? null : numericFxRates(fxMap) }),
      })
      if (!request.isCurrent()) return
      refreshStatus(res)
      if (fxEditVersion.current !== draftVersion) { setFxSaveMsg('已更新预设，保留较新的未保存输入'); return }
      if (reset) { markInputsChanged(); setFxMap({}) }
      setFxSaveMsg(reset ? '已清除保存的汇率' : '汇率预设已保存 ✓')
    } catch (e) {
      if (request.isCurrent()) setFxSaveMsg(`保存失败：${e.message}`)
    } finally {
      fxSaveLock.current = false
      if (request.isCurrent()) setFxSaving(false)
    }
  }

  const handleExportTrendReport = async () => {
    const request = startTrend()
    try {
      const qs = activeEntityFilter ? `?entity=${encodeURIComponent(activeEntityFilter)}` : ''
      const res = await callApi(`/history/report${qs}`, { signal: request.signal })
      if (request.isCurrent() && res?.reportHtml) downloadText(res.reportHtml, '跨境财税12个月滚动风控趋势月报.html', 'text/html;charset=utf-8')
    } catch (e) {
      if (request.isCurrent()) setErr(`导出趋势月报失败：${e.message}`)
    }
  }

  const handleFiles = async (fileList) => {
    const arr = Array.from(fileList || [])
    if (!arr.length) return
    const request = beginParse()
    setSource(null)
    if (arr.length > MAX_UPLOAD_FILES || arr.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) {
      setErr(`本次选择 ${arr.length} 份账单，超过单批 24 份或 20 MiB 上限。尚未读取任何文件，请分批选择。`)
      setBusy(false); return
    }
    try {
      const encoded = []
      for (const f of arr) encoded.push({ name: f.name, dataBase64: await fileToBase64(f, request.signal) })
      if (!request.isCurrent()) return
      const batch = { files: encoded }
      setSource(batch)
      await runParse(batch, { request, isNew: true })
    } catch (e) {
      if (request.isCurrent()) { setErr(e.message); setBusy(false) }
    }
  }

  const handleDemo = async (modeKey) => {
    const batch = { demo: modeKey }
    setSource(batch)
    const presetDeclared = modeKey === 'v7' ? '330000' : modeKey === 'v9' ? '400000' : '580000'
    setDeclaredCny(presetDeclared)
    await runParse(batch, { declared: presetDeclared, isNew: true })
  }

  const handleExportReport = async (format) => {
    if (!canExport || reportExporting) return
    const request = startReportExport()
    const fields = { html: 'reportHtml', csv: 'anomaliesCsv', md: 'reportMd' }
    const names = { html: '跨境月结核对单.html', csv: '财务待核派活清单.csv', md: '跨境月结核对单.md' }
    const mime = { html: 'text/html', csv: 'text/csv', md: 'text/markdown' }
    setReportExporting(true)
    try {
      if (cacheToken) {
        try {
          const cachedRes = await callApi('/parse/export', {
            method: 'POST', timeout: 30000, signal: request.signal,
            body: JSON.stringify({ cacheToken, format, includeResourceAppendix: includeAppendix }),
          })
          if (!request.isCurrent()) return
          if (typeof cachedRes?.content === 'string') {
            downloadText(cachedRes.content, cachedRes.filename || names[format], cachedRes.mimeType || `${mime[format]};charset=utf-8`)
            return
          }
        } catch (cacheErr) {
          if (!request.isCurrent()) return
          if (cacheErr?.status === 404 || cacheErr?.data?.error === 'CACHE_EXPIRED') {
            setCacheToken(null)
          } else {
            throw cacheErr
          }
        }
      }
      const res = await callApi('/parse', {
        method: 'POST', timeout: 45000, signal: request.signal,
        body: JSON.stringify({ ...reportPayload, reportFormat: format, includeResourceAppendix: includeAppendix }),
      })
      if (!request.isCurrent()) return
      if (typeof res?.cacheToken === 'string' && res.cacheToken) {
        setCacheToken(res.cacheToken)
      }
      const content = res?.[fields[format]]
      if (typeof content !== 'string') throw new Error('服务未返回导出内容')
      downloadText(content, names[format], `${mime[format]};charset=utf-8`)
    } catch (e) {
      if (request.isCurrent()) setErr(`导出失败：${e.message}`)
    } finally {
      if (request.isCurrent()) setReportExporting(false)
    }
  }

  const handleSaveSnapshot = async (conflictMode = 'check', target = null) => {
    if (!canArchive || snapshotSaveLock.current) return
    const trimmedName = snapEntity.trim()
    const trimmedKey = snapEntityKey.trim()
    if (trimmedName && trimmedName !== '待认领' && !trimmedKey) {
      const normDesired = normalizedEntity(trimmedName)
      const matchedKeys = new Set(
        (histState.history || [])
          .filter((it) => it.ownershipStatus === 'claimed' && it.entityKey && it.entityKey !== 'unclaimed' &&
            normalizedEntity(it.entityLabel || it.entityName) === normDesired)
          .map((it) => it.entityKey),
      )
      if (snapDistinctNewEntity || matchedKeys.size > 1 || (matchedKeys.size === 1 && [...matchedKeys][0] !== normDesired)) {
        setSnapMsg('失败：已存在同名独立主体或勾选了新建同名法人，请点击复用已有主体编码或填写统一社会信用代码（entityKey）后再归档')
        return
      }
    }
    const request = startSnapshot()
    snapshotSaveLock.current = true; setSnapSaving(true); setSnapMsg('')
    try {
      const plats = [...new Set((data.summaries || []).map((s) => s.platform).filter(Boolean))]
      const res = await callApi('/history', {
        method: 'POST', signal: request.signal,
        body: JSON.stringify({
          archiveToken: data.archiveToken, month: snapMonth, entityName: trimmedName || '待认领',
          ...(trimmedKey ? { entityKey: trimmedKey } : {}),
          ...(snapDistinctNewEntity ? { distinctNewEntity: true } : {}),
          storeScope: snapStore.trim() || plats.join('+'), vatTaxpayerType: snapVatType, citAssessedMode: snapCitMode,
          zeroSalesConfirmed: snapZeroSales, conflictMode,
          ...(target ? { targetId: target.id, expectedRevision: target.revision } : {}),
          filterEntity: activeEntityFilter, label: snapLabel,
        }),
      })
      if (!request.isCurrent()) return
      setSnapConflict(null)
      setData((current) => ({ ...current, archiveToken: undefined }))
      refreshHistory()
      setSnapMsg(res.deduplicated ? '已覆盖更新原档 ✓' : conflictMode === 'append' ? '已作为补充另存 ✓' : '已归档 ✓')
    } catch (e) {
      if (!request.isCurrent()) return
      if (e.status === 409 && e.data?.conflict) {
        const isRev = e.data.code === 'REVISION_CONFLICT' || e.data.conflictType === 'revision_conflict' || e.data.reason === 'revision_mismatch'
        const candidates = e.data.candidates?.length ? e.data.candidates : [e.data.existing].filter(Boolean)
        setSnapConflict(candidates.length ? {
          candidates,
          targetId: (!isRev && candidates.length === 1) ? candidates[0].id : '',
          conflictType: isRev ? 'revision_conflict' : 'source_key_collision',
        } : null)
        if (isRev) refreshHistory()
        setSnapMsg(candidates.length ? '' : '原归档已不存在，请重新提交。')
      } else {
        setSnapMsg(`失败：${e.message}`)
      }
    } finally {
      snapshotSaveLock.current = false
      if (request.isCurrent()) setSnapSaving(false)
    }
  }

  const handleDeleteSnapshot = async (id) => {
    const request = startHistoryDelete()
    try {
      const qs = activeEntityFilter ? `?entity=${encodeURIComponent(activeEntityFilter)}` : ''
      await callApi(`/history/${encodeURIComponent(id)}${qs}`, { method: 'DELETE', signal: request.signal })
      if (request.isCurrent()) refreshHistory()
    } catch (e) {
      if (request.isCurrent()) setErr(e.message)
    }
  }

  const { anomalyGroups, anomPlatforms } = useMemo(() => {
    const anomalyGroups = { P0: [], P1: [], P2: [] }
    const platforms = new Set()
    for (const { anomalies, platform: plat, bankLabel, site, currency } of data?.summaries || []) {
      const pName = plat || bankLabel || 'BankReceipt'
      const scope = `${pName}·${site || 'CN'}(${currency || 'CNY'})`
      for (const anomaly of anomalies || []) {
        const group = anomalyGroups[anomaly.severity?.slice(0, 2)]
        if (!group) continue
        group.push({ anomaly, platform: pName, scope })
        platforms.add(pName)
      }
    }
    return { anomalyGroups, anomPlatforms: [...platforms] }
  }, [data])

  const anomalyCount = anomalyGroups.P0.length + anomalyGroups.P1.length + anomalyGroups.P2.length
  const { count: filteredCount, rows: visibleAnoms } = useMemo(() => {
    const groups = sevFilter === 'ALL' ? Object.values(anomalyGroups) : [anomalyGroups[sevFilter]]
    const start = anomalyPage * ANOMALY_PAGE_SIZE
    const rows = []
    let count = 0
    for (const group of groups) {
      for (const item of group) {
        if (platFilter !== 'ALL' && item.platform !== platFilter) continue
        if (count >= start && rows.length < ANOMALY_PAGE_SIZE) rows.push(item)
        count++
      }
    }
    return { count, rows }
  }, [anomalyGroups, sevFilter, platFilter, anomalyPage])

  const loadedPlats = new Set((data?.summaries || []).map((s) => s.platform).filter(Boolean))
  const totalRows = (data?.summaries || []).reduce((acc, s) => acc + (s.rawRowCount || 0), 0)
  const sheetCcys = [...new Set((data?.summaries || []).map((s) => s.currency).filter((c) => /^[A-Z]{3}$/.test(c) && c !== 'RMB' && c !== 'CNY'))]
  const activeCcys = data ? sheetCcys : [...new Set(['USD', 'EUR', 'GBP', 'AUD', 'MYR', 'SGD', ...Object.keys(fxMap)])]
  const r12 = histState.entity === activeEntityFilter ? histState.rolling12m : null
  const hasHistory = Boolean(r12?.snapshotCount || (histState?.history || []).length)
  const currentResult = Boolean(data && !busy && !inputsChanged)
  const hasPartialCoverage = data?.coverage?.complete === false
  const canExport = Boolean(currentResult && reportPayload && !hasPartialCoverage)
  const consTotals = data?.consolidated?.ready ? data.consolidated.totals : null
  const canArchive = Boolean(currentResult && consTotals && data.archiveToken && !data.fxConfirmationNeeded && !hasPartialCoverage && snapMonth)
  const fundChain = data?.consolidated?.fundChain || null
  const isWalletOnly = Boolean(data?.summaries?.length && data.summaries.every((item) => item.role === 'settlement_wallet' || item.role === 'bank_receipt'))
  const gaugeNetCny = r12?.snapshotCount ? r12.totalNetSalesCny : (consTotals?.netSalesCny || 0)
  const thresholdsApplicable = Boolean(activeEntityFilter && r12?.thresholdApplicable === true)
  const gaugeAFoot = r12?.taxYear ? `${r12.taxYear} 年 ${r12.taxYearMonthCount || r12.monthCount} 月 · 4% 情景估算` : t.assessedGaugeHelp
  const gaugeBFoot = r12 && `覆盖 ${r12.monthCount}/12 月 · 缺档 ${r12.missingMonthsCount ?? Math.max(0, 12 - r12.monthCount)} 月${r12.zeroSalesMonthsCount > 0 ? ` · 零收入 ${r12.zeroSalesMonthsCount} 月` : ''}`
  const normalizedEntity = (name) => String(name || '待认领').trim().toLowerCase().replace(/\s+/g, ' ')
  const matchingClaimedEntities = useMemo(() => {
    const trimmed = snapEntity.trim()
    if (!trimmed || normalizedEntity(trimmed) === normalizedEntity('待认领')) return []
    const normDesired = normalizedEntity(trimmed)
    const map = new Map()
    for (const it of histState.history || []) {
      const lbl = it.entityLabel || it.entityName || ''
      if (it.ownershipStatus === 'claimed' && it.entityKey && it.entityKey !== 'unclaimed' && normalizedEntity(lbl) === normDesired) {
        if (!map.has(it.entityKey)) map.set(it.entityKey, { entityKey: it.entityKey, entityLabel: lbl })
      }
    }
    return [...map.values()]
  }, [histState.history, snapEntity])
  const historyList = activeEntityFilter ? histState.history.filter((entry) => normalizedEntity(entry.entityName) === normalizedEntity(activeEntityFilter)) : histState.history
  const lastHistoryPage = Math.max(0, Math.ceil(historyList.length / 12) - 1)
  const visibleHistoryPage = Math.min(historyPage, lastHistoryPage)
  const currentTarget = snapConflict?.candidates.find((item) => item.id === snapConflict.targetId)
  const declDiag = data?.consolidated?.ready && !isWalletOnly ? data.consolidated.reconcile?.declarationDiagnosis : null

  const jumpBridge = () => {
    if (isWalletOnly) { setErr('当前为纯结汇通道/银行回单模式（不含销售报送额），请合并拖入电商平台结算单后再一键带入四层桥接精算。'); return }
    if (!consTotals) return onJumpToCalc('platform_tax_reconcile', {})
    onJumpToCalc('platform_tax_reconcile', {
      reportedGrossRevenue: String(consTotals.grossCny), reportedGrossSource: 'statement_reference',
      refunds: String(Math.max(consTotals.refundCny, 0)), refundReversal: String(Math.max(-consTotals.refundCny, 0)),
      marketplaceWithheldTax: '0', cutoffAndFxDiff: '0',
      platformFees: String(Math.max(consTotals.feesCny, 0)), platformFeeRebate: String(Math.max(-consTotals.feesCny, 0)),
      subsidies: String(Math.max(consTotals.subsidyCny, 0)), subsidyReversal: String(Math.max(-consTotals.subsidyCny, 0)),
      subsidiesIncludedInGross: false, withheldTaxIncludedInGross: false,
      selfRemitTaxNet: String(consTotals.selfRemitTaxCny), reserveChange: String(consTotals.reserveCny),
      actualPayout: consTotals.payoutEvidenceCount ? String(consTotals.payoutCny) : '', declaredVatSales: declaredCny || '',
    })
  }

  return h(
    'div',
    {
      style: { display: 'flex', flexDirection: 'column', gap: 18 },
      onDragOver: (e) => { e.preventDefault(); setDragging(true) },
      onDragLeave: () => setDragging(false),
      onDrop: (e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer?.files) },
    },
    err && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, err)),
    hasPartialCoverage && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, `本批有 ${data.coverage.files.filter((file) => file.status !== 'parsed').length} 份账单未完整解析。请拆分账单或核对表头后重新导入。`)),
    h(CoverageDetails, { coverage: hasPartialCoverage ? data.coverage : failedCoverage }),
    source && inputsChanged && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, '口径已修改，请复算后再导出或归档。')),
    data?.fxConfirmationNeeded && !hasPartialCoverage && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, '汇率待核。请确认本批采用的汇率并复算后归档。')),
    data?.consolidated?.missingCurrencies?.includes('待确认币种') && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, '账单有未确认的币种。请在来源账单中核对币种后重新导入。')),
    h(
      'section',
      { className: 'ftx-instrument' },
      h('span', { className: 'ftx-screw tl', 'aria-hidden': 'true' }), h('span', { className: 'ftx-screw tr', 'aria-hidden': 'true' }),
      h('span', { className: 'ftx-screw bl', 'aria-hidden': 'true' }), h('span', { className: 'ftx-screw br', 'aria-hidden': 'true' }),
      h(
        'div',
        { className: 'ftx-inst-left' },
        h('div', { className: 'ftx-inst-head' }, h('span', null, isWalletOnly ? '结汇通道独立排雷' : '账单合并对账'), h('small', null, isWalletOnly ? 'WALLET / LOCAL' : 'CNY / LOCAL')),
        h(
          'div',
          { className: 'ftx-lcd' },
          h('div', { className: 'ftx-lcd-lbl' }, h('span', null, isWalletOnly ? '结汇通道入账折合（不计入销售）' : '合并报送参考毛额'), h('span', { className: 'ftx-mono', style: { fontSize: 10.5 } }, isWalletOnly ? 'WALLET ONLY' : consTotals ? 'CNY' : 'STANDBY')),
          h(
            'div',
            { className: 'ftx-lcd-big' },
            h('span', { className: 'unit' }, '¥'),
            isWalletOnly
              ? (fundChain?.stage2WalletInboundCny == null || fundChain?.stage2OtherInboundCny == null ? '待核' : (fundChain.stage2WalletInboundCny + fundChain.stage2OtherInboundCny).toLocaleString())
              : consTotals ? consTotals.grossCny.toLocaleString() : data ? '待核' : '0',
          ),
          !data && h('div', { style: { fontSize: 11.5, color: 'var(--ftx-lcd-ink)', opacity: 0.7, marginTop: 4 } }, '拖入原始账单/.ZIP/对公银行回单，或点击下方 demo:v9 体验三段核销'),
        ),
        h(
          'div',
          { className: 'ftx-metrics' },
          isWalletOnly
            ? h('div', null, h('label', null, '转出企业户(待核回单)'), h('b', { style: { color: 'var(--ftx-orange)' } }, money(fundChain?.stage3CorporateRepatriatedCny)))
            : h('div', null, h('label', null, '合并净销售额'), h('b', null, money(consTotals?.netSalesCny))),
          isWalletOnly
            ? h('div', null, h('label', null, '结汇通道手续费'), h('b', null, money(fundChain?.walletFeesCny)))
            : h('div', null, h('label', null, '平台佣金及履约费'), h('b', null, money(consTotals?.feesCny))),
        ),
        h(
          'div',
          { className: 'ftx-scan' },
          h('i', { className: 'probe' }),
          h('span', null, data ? `已扫描 ${data.summaries.length} 份账单 / ${totalRows} 行` : '待载入原始结算账单'),
          h('span', { className: 'vsep' }),
          h('b', { className: 'ftx-mono' }, data ? `${data.elapsedMs} ms` : '0 ms'),
          h('span', { className: 'vsep' }),
          h('b', { className: 'ftx-mono' }, cacheToken ? 'CACHE READY' : '0 Token'),
          h('button', { type: 'button', className: 'ftx-btn-sm', style: { marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }, onClick: () => setShowFxBar(!showFxBar) }, showFxBar ? '收起汇率/申报 ▲' : '汇率与申报额 ▼'),
        ),
      ),
      h(
        'div',
        { className: 'ftx-inst-right' },
        h(
          'div',
          { className: 'ftx-inst-head' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', null, r12?.snapshotCount ? `滚动监控（${r12.snapshotCount} 份归档）` : '12 个月滚动监控'),
            Boolean(histState.rolling12m?.entities?.length) &&
              h(
                'select',
                { value: activeEntityFilter, onChange: (e) => selectEntity(e.target.value), className: 'ftx-input', style: { padding: '2px 6px', fontSize: 11 }, title: '按公司主体筛选滚动口径，防止多主体串账' },
                h('option', { value: '' }, `全部主体 (${histState.history.length})`),
                ...histState.rolling12m.entities.map((ent) => h('option', { key: ent.name, value: ent.name }, `${ent.name}${ent.unclaimed ? ' [旧档]' : ''} (${ent.count})`)),
              ),
          ),
          h('span', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', fontWeight: 400 } }, r12?.snapshotCount ? '滚动净额 ' : '当期净额 ', h('b', { className: 'ftx-mono', style: { fontSize: 16, color: 'var(--ftx-ink)' } }, `¥${Math.round(gaugeNetCny).toLocaleString()}`)),
        ),
        thresholdsApplicable
          ? h('div', { className: 'ftx-meters' }, h(DialGauge, { code: 'A', title: t.assessedGauge, pct: r12.taxYearCliff75mPct ?? r12.cliff75mPct, warnPct: 73.3, footNote: gaugeAFoot }), h(DialGauge, { code: 'B', title: '滚动登记参考 · 500万', pct: r12.threshold5mPct, warnPct: 80, footNote: gaugeBFoot }))
          : h('div', { style: { marginTop: 10, fontSize: 12, color: 'var(--ftx-mut)' } }, activeEntityFilter === '待认领' ? '待认领归档需要先确认主体，再核对阈值。' : '选择已归档的单一主体，查看登记阈值与核定情景。'),
        historyError && h('div', { className: 'ftx-gap' }, h('span', null, historyError)),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 } },
          data && consTotals &&
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
              h('input', { type: 'month', value: snapMonth, disabled: snapSaving, readOnly: Boolean(data.archiveMonth), onChange: (e) => { setSnapMonth(e.target.value); setSnapConflict(null) }, className: 'ftx-input', style: { padding: '3px 6px', fontSize: 11.5 } }),
              h('input', { type: 'text', value: snapEntity, disabled: snapSaving, onChange: (e) => { setSnapEntity(e.target.value); setSnapConflict(null) }, placeholder: '公司主体(防串账)', className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5, flex: '1 1 110px', minWidth: 0 } }),
              h('input', { type: 'text', value: snapEntityKey, disabled: snapSaving, 'aria-label': '主体唯一编码', onChange: (e) => { setSnapEntityKey(e.target.value); setSnapConflict(null) }, placeholder: '信用代码/entityKey(同名必填)', className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5, flex: '1 1 115px', minWidth: 0 } }),
              h('input', { type: 'text', value: snapStore, disabled: snapSaving, onChange: (e) => { setSnapStore(e.target.value); setSnapConflict(null) }, placeholder: '店铺/范围', className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5, flex: '1 1 90px', minWidth: 0 } }),
              h('button', { type: 'button', className: 'ftx-btn-sm on', disabled: !canArchive || snapSaving, onClick: () => handleSaveSnapshot('check') }, '归档'),
            ),
          data && consTotals && matchingClaimedEntities.length > 0 && !snapEntityKey.trim() &&
            h(
              'div',
              { 'data-testid': 'entity-key-guard', style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', fontSize: 11, color: 'var(--ftx-orange)' } },
              h('span', null, `库内已有同名主体（${matchingClaimedEntities.length} 个编码）：`),
              ...matchingClaimedEntities.map((ent) =>
                h('button', { key: ent.entityKey, type: 'button', className: 'ftx-btn-sm', style: { fontSize: 10.5, padding: '1px 6px' }, onClick: () => { setSnapEntityKey(ent.entityKey); setSnapDistinctNewEntity(false); setSnapMsg('') } }, `复用 [${ent.entityKey}]`),
              ),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer', color: 'var(--ftx-mut)' } },
                h('input', { type: 'checkbox', checked: snapDistinctNewEntity, onChange: (e) => setSnapDistinctNewEntity(e.target.checked) }),
                '新建同名独立法人(须填新信用代码)',
              ),
            ),
          data && consTotals &&
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', fontSize: 11 } },
              h('input', { type: 'text', value: snapLabel, onChange: (e) => setSnapLabel(e.target.value), placeholder: '显示备注(改名不改归档身份)', className: 'ftx-input', style: { padding: '2px 6px', fontSize: 11, flex: '1 1 110px', minWidth: 90 } }),
              h('select', { value: snapVatType, onChange: (e) => setSnapVatType(e.target.value), className: 'ftx-input', style: { padding: '2px 5px', fontSize: 11 }, title: '增值税纳税人身份' }, h('option', { value: 'unknown' }, '增值税:未设'), h('option', { value: 'small_scale' }, '小规模'), h('option', { value: 'general' }, '一般纳税人')),
              h('select', { value: snapCitMode, onChange: (e) => setSnapCitMode(e.target.value), className: 'ftx-input', style: { padding: '2px 5px', fontSize: 11 }, title: '企业所得税核定状态' }, h('option', { value: 'unknown' }, '所得税:未设'), h('option', { value: 'assessed_4pct' }, '4%核定'), h('option', { value: 'audit_actual' }, '查账征收')),
              (consTotals.grossCny <= 0 && consTotals.netSalesCny <= 0) && h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--ftx-mut)', cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: snapZeroSales, onChange: (e) => setSnapZeroSales(e.target.checked) }), '确认零收入'),
            ),
          snapConflict &&
            h(
              'div',
              { className: 'ftx-gap', style: { padding: '7px 10px', fontSize: 11.5, gap: 6 } },
              h('i', { className: 'att' }, '!'),
              h(
                'span',
                { style: { flex: '1 1 180px' } },
                snapConflict.conflictType === 'revision_conflict'
                  ? '目标归档快照版本已过期（REVISION_CONFLICT），请刷新并重新选择最新快照版本后再覆盖。'
                  : `此主体、店铺和账期已有 ${snapConflict.candidates.length} 份归档。`,
              ),
              h('select', { className: 'ftx-input', value: snapConflict.targetId, onChange: (e) => { const targetId = e.target.value; setSnapConflict((prev) => ({ ...prev, targetId })) }, 'aria-label': '选择要覆盖的归档' }, h('option', { value: '' }, '选择要覆盖的归档'), ...snapConflict.candidates.map((item) => h('option', { key: item.id, value: item.id }, `${item.month} · ${item.label || item.storeScope} · ${money(item.netSalesCny)} · ${item.savedAt}`))),
              snapConflict.conflictType === 'revision_conflict' &&
                h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => refreshHistory() }, '刷新归档列表'),
              h('button', { type: 'button', className: 'ftx-btn-sm on', disabled: !canArchive || !currentTarget || snapSaving, onClick: () => handleSaveSnapshot('replace', currentTarget) }, '覆盖替换原档'),
              h('button', { type: 'button', className: 'ftx-btn-sm', disabled: !canArchive || snapSaving, onClick: () => handleSaveSnapshot('append') }, '作为补充另存'),
              h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => setSnapConflict(null) }, '取消'),
            ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            currentResult && consTotals && !canArchive && !data.fxConfirmationNeeded && !hasPartialCoverage && data.archiveBlockReason && h('span', { className: 'ftx-hist-text', style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, data.archiveBlockReason),
            snapMsg && h('span', { style: { fontSize: 11.5, fontWeight: 700, color: snapMsg.includes('失败') ? 'var(--ftx-orange)' : 'var(--ftx-ok)' } }, snapMsg),
            hasHistory && h('button', { type: 'button', className: 'ftx-btn-sm', style: { marginLeft: 'auto' }, onClick: () => setShowHistList(!showHistList) }, showHistList ? '收起归档明细 ▲' : `管理 ${histState.history.length} 份归档 ▼`),
          ),
        ),
      ),
    ),
    (showFxBar || (source && (inputsChanged || (data && (!consTotals || data.fxConfirmationNeeded))))) &&
      h(
        'div',
        { className: 'ftx-panel', style: { padding: '12px 16px', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 } },
        ...activeCcys.map((ccy) =>
          h(
            'div',
            { key: ccy, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
            h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--ftx-mut)', fontWeight: 600 } },
              `${ccy} 折人民币汇率`,
              h('input', { type: 'number', step: 'any', min: 0, value: fxMap[ccy] ?? (source?.demo ? DEMO_FX[ccy] ?? '' : ''), onChange: (e) => { const value = e.target.value; fxEditVersion.current++; markInputsChanged(); setFxMap((prev) => ({ ...prev, [ccy]: value })) }, className: 'ftx-input', style: { width: 110 } }),
            ),
          ),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } }, h('label', { style: { fontSize: 11, color: 'var(--ftx-mut)', fontWeight: 600 } }, t.declaredLabel), h('input', { type: 'number', placeholder: '如 330000', value: declaredCny, onChange: (e) => { markInputsChanged(); setDeclaredCny(e.target.value) }, className: 'ftx-input', style: { width: 165 } })),
        h('button', { type: 'button', className: 'ftx-btn-sm on', style: { height: 32, padding: '0 14px' }, disabled: busy || !source, onClick: () => runParse(source, { confirmFx: true }) }, !source?.demo && sheetCcys.length > 0 ? '确认汇率并复算' : t.recalcBtn),
        h('button', { type: 'button', className: 'ftx-btn-sm', style: { height: 32 }, disabled: fxSaving, onClick: () => handlePersistFxRates(false) }, t.saveFxDefault),
        h('button', { type: 'button', className: 'ftx-btn-sm', style: { height: 32 }, disabled: fxSaving, onClick: () => handlePersistFxRates(true) }, t.resetFxDefault),
        source?.demo && h('span', { style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, '示例汇率仅用于演示。'),
        fxSaveMsg && h('span', { style: { fontSize: 11.5, fontWeight: 700, color: fxSaveMsg.includes('失败') ? 'var(--ftx-orange)' : 'var(--ftx-ok)', alignSelf: 'center' } }, fxSaveMsg),
      ),
    showHistList && hasHistory &&
      h(
        'div',
        { className: 'ftx-panel', style: { padding: '12px 16px', gap: 8 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
          h('strong', { style: { fontSize: 13 } }, r12?.snapshotCount ? `12 个月滚动归档（${r12.windowStart} ~ ${r12.windowEnd} · ${r12.snapshotCount} 份快照）` : '归档明细'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('button', { type: 'button', className: 'ftx-btn-sm on', onClick: handleExportTrendReport }, t.exportTrendHtml),
            h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => onJumpToCalc('vat_taxpayer_threshold', { rolling12mTaxableSales: '', projectedAnnualGrossSales: '' }, false) }, '核对应税销售额与登记'),
            h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => onJumpToCalc('cbec_assessed_cit', {}, false) }, '按主体试算 4% 核定'),
          ),
        ),
        ...historyList.slice(visibleHistoryPage * 12, (visibleHistoryPage + 1) * 12).map((it) => {
          const ent = it.entityName || '待认领'
          return h('div', { key: it.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 8px', borderBottom: '1px solid var(--ftx-line)' } },
            h('div', { className: 'ftx-hist-text', style: { display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' } },
              h('span', { className: 'ftx-sev' }, it.month.slice(2)),
              h('span', { className: `ftx-sev ftx-hist-entity ${ent === '待认领' ? 'p1' : ''}`, style: { width: 'auto', padding: '0 6px' } }, ent),
              h('strong', null, it.storeScope || it.label),
              it.label && it.label !== it.storeScope && h('span', { style: { color: 'var(--ftx-mut)' } }, it.label),
              it.zeroSalesConfirmed && h('span', { style: { fontSize: 10.5, color: 'var(--ftx-mut)' } }, '[零收入]'),
              h('b', { className: 'ftx-mono' }, `¥${Number(it.netSalesCny || 0).toLocaleString()}`),
            ),
            h('button', { type: 'button', className: 'ftx-btn-sm danger', style: { flexShrink: 0 }, onClick: () => handleDeleteSnapshot(it.id) }, '删除'),
          )
        }),
        lastHistoryPage > 0 && h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
          h('button', { type: 'button', className: 'ftx-btn-sm', disabled: visibleHistoryPage === 0, onClick: () => setHistoryPage(visibleHistoryPage - 1) }, '上一页'),
          h('span', null, `${visibleHistoryPage + 1} / ${lastHistoryPage + 1} 页`),
          h('button', { type: 'button', className: 'ftx-btn-sm', disabled: visibleHistoryPage === lastHistoryPage, onClick: () => setHistoryPage(visibleHistoryPage + 1) }, '下一页'),
        ),
      ),
    renderStage3FundChainPanel({ fc: fundChain }),
    renderAuditLowerSection({
      t, data, busy, platform, onPlatformChange: (v) => { markInputsChanged(); setPlatform(v) },
      handleFiles, handleDemo, loadedPlats, declDiag, anomalyGroups, anomalyCount, sevFilter,
      onSeverityFilter: (severity) => { setAnomalyPage(0); setSevFilter(severity) },
      platFilter, onPlatFilter: (v) => { setAnomalyPage(0); setPlatFilter(v) },
      anomPlatforms, visibleAnoms, filteredCount, anomalyPage, setAnomalyPage,
      hasPartialCoverage, onCopyText, copiedKey, onOpenIma,
    }),
    h(
      'section',
      { className: 'ftx-actions' },
      h('label', { className: `ftx-act drop${dragging ? ' is-drag' : ''}` }, h(Icon, { kind: 'upload', size: 16 }), h('span', null, busy ? t.parsing : t.pickFiles), h('small', { style: { fontSize: 10.5, color: 'var(--ftx-mut)', fontWeight: 500 } }, '17 通道+回单'), h('input', { type: 'file', multiple: true, accept: '.csv,.tsv,.txt,.xlsx,.xlsm,.zip', style: { display: 'none' }, onChange: (e) => { handleFiles(e.target.files); e.target.value = '' } })),
      h('button', { type: 'button', className: 'ftx-act pri', disabled: busy || inputsChanged || isWalletOnly || hasPartialCoverage || Boolean(data && !consTotals), title: isWalletOnly ? '纯结汇通道未含销售报送额，请合并拖入电商账单' : '', onClick: jumpBridge }, h('span', null, isWalletOnly ? '需合并销售账单方能桥接' : '一键带入四层桥接精算 →')),
      h('button', { type: 'button', className: 'ftx-act', disabled: !canExport || reportExporting, onClick: () => handleExportReport('html') }, h(Icon, { kind: 'download', size: 16 }), t.exportHtml),
      h('button', { type: 'button', className: 'ftx-act', disabled: !canExport || reportExporting || anomalyCount === 0, onClick: () => handleExportReport('csv') }, h(Icon, { kind: 'download', size: 16 }), t.exportCsv),
    ),
    data &&
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 11.5, color: 'var(--ftx-mut)' } },
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('button', { type: 'button', className: 'ftx-btn-sm on', onClick: () => handleDemo('v9') }, t.runDemoV9),
          h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => handleDemo('v8') }, t.runDemoV8),
          h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => handleDemo('v7') }, t.runDemoV7),
          h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => handleDemo('all') }, t.runDemo),
          h('button', { type: 'button', className: 'ftx-btn-sm', disabled: !canExport || reportExporting, onClick: () => handleExportReport('md') }, t.exportMd),
          hasHistory && h('button', { type: 'button', className: 'ftx-btn-sm', onClick: handleExportTrendReport }, t.exportTrendHtml),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--ftx-mut)' }, title: '对外核对单默认纯洁无推广，勾选后在文末附带 IMA 与母表参考指引' }, h('input', { type: 'checkbox', checked: includeAppendix, onChange: (e) => setIncludeAppendix(e.target.checked) }), '导出时附带参考指引附页'),
        ),
        h('span', null, '边界声明：对外导出默认纯洁无推广；Stage 3 银行实收仅认法定 5 键精确核销，参考级候选须人工复核'),
      ),
  )
}

/**
 * dsh-fintax — 桌面端独立财税工作台 + 图形化设置页（免构建 ModuleLoader 模块，v0.6.0）。
 *
 * 挂载槽位（按宿主能力渐进增强，内置 try/catch 防崩隔离）：
 *   1. sidebar.panellist + main（dsh >= 0.2.1）：左侧边栏独立「财税工作台」全屏应用（0 Token 本地直算）；
 *   2. settings.section.icon（dsh >= 0.2.2）：自定义矢量工作台图标；
 *   3. settings.section（全版本兼容）：设置页内完整配置与快捷工作台。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fintax',
  factory(require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const NS = 'settings.fintax'
    const PANEL_ID = 'dsh-fintax'
    const inject = ['slots', 'locale']

    const COPY = {
      zh: {
        nav: '财税工作台',
        title: '财税工作台 · dsh-fintax',
        subtitle: '五大跨境平台原始账单离线排雷、7 大代码级确定性算税与腾讯 IMA 法规引证。',
        tabRadar: '账单离线排雷',
        tabCalc: '7 大确定性算税',
        tabSettings: 'IMA 知识库与设置',
        statusReadyFile: 'IMA 凭证就绪（本机文件）',
        statusReadyEnv: 'IMA 凭证就绪（环境变量）',
        statusReadyMixed: 'IMA 凭证就绪（混合来源）',
        statusMissing: '未配 IMA（排雷与 7 大算税离线可用）',
        defaultKbBound: '默认库：',
        defaultKbNone: '未绑定默认库',
        dropTitle: '拖入原始结算账单或 .zip 压缩包',
        dropSub: '支持 Amazon / TikTok Shop / Temu / Shopify / Stripe 的 CSV / TSV / XLSX / UTF-16 / .zip（可多选，数据 100% 留在本机内存）',
        pickFiles: '选择本地账单文件',
        runDemo: '载入三平台沙盒体验',
        parsing: '定点解析中…',
        recalcBtn: '按汇率重算总对账',
        exportHtml: '导出老板汇报体检单 (.html)',
        exportMd: '导出 Markdown (.md)',
        declaredLabel: '已申报增值税/出口销售额（元）',
        platformAuto: '自动识别平台',
        credTitle: '1. 腾讯 IMA OpenAPI 只读凭证',
        credDesc: '前往 https://ima.qq.com/agent-interface 获取 Client ID 与 API Key。密钥只写不回显明文，仅作为请求头发送至官方 ima.qq.com。',
        cidLabel: 'Client ID',
        keyLabel: 'API Key',
        savedPlaceholder: '•••••••• 已配置（留空保持原值）',
        emptyCidPlaceholder: '粘贴 IMA Client ID',
        emptyKeyPlaceholder: '粘贴 IMA API Key',
        saveBtn: '保存凭证',
        savingBtn: '保存中…',
        testBtn: '测试连接并刷新知识库',
        testingBtn: '拉取中…',
        clearBtn: '清除本地凭证',
        kbTitle: '2. 绑定默认优先检索知识库',
        kbDesc: '绑定默认财税库后，对话工具将直查该库政策与整改 SOP，避免扫描无关库。',
        kbManualPlaceholder: '或直接输入知识库 ID（如 ima_kb_xxx）',
        kbSaveManual: '绑定 ID',
        kbClearDefault: '取消默认',
        kbSetDefault: '设为默认',
        kbCurrentBadge: '当前默认',
        kbEmptyHint: '点击上方「测试连接并刷新知识库」即可直接点选。',
        copyPrompt: '复制提问给 AI',
        copied: '已复制 ✓',
        savedOk: '凭证已安全保存至 ~/.config/ima/',
        clearedOk: '本地凭证已清除',
        kbBoundOk: '默认知识库已更新',
      },
      en: {
        nav: 'FinTax Workbench',
        title: 'FinTax Workbench · dsh-fintax',
        subtitle: '5-platform offline statement audit radar, 7 deterministic tax engines, and read-only Tencent IMA citations.',
        tabRadar: 'Statement Radar',
        tabCalc: '7 Tax Calculators',
        tabSettings: 'IMA & Settings',
        statusReadyFile: 'IMA ready (local file)',
        statusReadyEnv: 'IMA ready (env)',
        statusReadyMixed: 'IMA ready (mixed)',
        statusMissing: 'IMA unset (radar & calculators work offline)',
        defaultKbBound: 'Default KB: ',
        defaultKbNone: 'No default KB bound',
        dropTitle: 'Drop raw settlement statements or .zip archives here',
        dropSub: 'Supports Amazon, TikTok Shop, Temu, Shopify, and Stripe (.csv / .tsv / .xlsx / UTF-16 / .zip). Parsed 100% locally in memory.',
        pickFiles: 'Choose files',
        runDemo: 'Load 3-platform sandbox demo',
        parsing: 'Analyzing…',
        recalcBtn: 'Recalculate FX & Reconciliation',
        exportHtml: 'Export printable report (.html)',
        exportMd: 'Export Markdown (.md)',
        declaredLabel: 'Declared VAT / Export Sales (CNY)',
        platformAuto: 'Auto-detect platform',
        credTitle: '1. Tencent IMA OpenAPI Credentials',
        credDesc: 'Get Client ID & API Key at https://ima.qq.com/agent-interface. Write-only, sent exclusively to ima.qq.com.',
        cidLabel: 'Client ID',
        keyLabel: 'API Key',
        savedPlaceholder: '•••••••• Configured (leave blank to keep)',
        emptyCidPlaceholder: 'Paste IMA Client ID',
        emptyKeyPlaceholder: 'Paste IMA API Key',
        saveBtn: 'Save credentials',
        savingBtn: 'Saving…',
        testBtn: 'Test & refresh KBs',
        testingBtn: 'Loading…',
        clearBtn: 'Clear local credentials',
        kbTitle: '2. Default Tax Knowledge Base',
        kbDesc: 'Pin your primary tax KB so ima_search and ima_browse query it directly.',
        kbManualPlaceholder: 'Or paste KB ID (e.g. ima_kb_xxx)',
        kbSaveManual: 'Bind ID',
        kbClearDefault: 'Clear default',
        kbSetDefault: 'Set default',
        kbCurrentBadge: 'Default',
        kbEmptyHint: 'Click "Test & refresh KBs" above to pick from your IMA account.',
        copyPrompt: 'Copy AI prompt',
        copied: 'Copied ✓',
        savedOk: 'Credentials saved to ~/.config/ima/',
        clearedOk: 'Local IMA credentials cleared',
        kbBoundOk: 'Default knowledge base updated',
      },
    }

    const DEFAULT_FX = { USD: 7.18, EUR: 7.82, GBP: 9.15, AUD: 4.72, CAD: 5.18, JPY: 0.047, SGD: 5.36, MXN: 0.36, RMB: 1, CNY: 1 }

    const CALC_SCENARIOS = [
      {
        code: 'platform_tax_reconcile',
        zh: '平台报送四层口径桥接',
        en: '4-Layer Platform Tax Bridge',
        desc: '核对税总 15 号文报送总额、银行放款与已申报销售额，自动排查回款净额漏报佣金。',
        fields: [
          { key: 'reportedGrossRevenue', label: '平台报送收入总额（元）', def: '6000000' },
          { key: 'refunds', label: '当期客户退款（元）', def: '450000' },
          { key: 'marketplaceWithheldTax', label: '商城代扣境外流转税（元）', def: '350000' },
          { key: 'cutoffAndFxDiff', label: '跨期与汇率折算差（正调减/负调增）', def: '400000' },
          { key: 'platformFees', label: '平台佣金与履约费（元）', def: '600000' },
          { key: 'declaredVatSales', label: '当期已申报销售额（元，可选）', def: '4200000' },
          { key: 'actualPayout', label: '实际银行放款（元，可选）', def: '' },
        ],
      },
      {
        code: 'export_invoice_breakeven',
        zh: '供应商开票加点毛利临界',
        en: 'Invoice Markup Breakeven g*',
        desc: '对比加税点拿专票走免退税 vs 综试区合规无票免税，算出盈亏临界点 g* 与税后净利。',
        fields: [
          { key: 'barePurchaseAmount', label: '无票裸采成本（元）', def: '1000000' },
          { key: 'supplierMarkupRate', label: '供应商开票加点率（小数，如 0.08）', def: '0.08' },
          { key: 'vatRate', label: '专票增值税率（如 0.13）', def: '0.13' },
          { key: 'rebateRate', label: '出口退税率（如 0.13 或 0.09）', def: '0.13' },
          { key: 'exportRevenue', label: '预计出口营收（元，可选联动所得税）', def: '1500000' },
        ],
      },
      {
        code: 'cbec_assessed_cit',
        zh: '综试区 4% 核定与 300万崖',
        en: 'CBEC 4% Assessed CIT & 3M Cliff',
        desc: '精算 4% 应税所得率叠加小微 5% 优惠，预警 7,500 万营收（300 万所得额）5 倍跳档。',
        fields: [
          { key: 'revenue', label: '年度无票免税出口营收（元）', def: '80000000' },
          { key: 'taxableIncomeRate', label: '核定应税所得率（默认 0.04）', def: '0.04' },
          { key: 'smallLowProfit', label: '是否符合小型微利条件', type: 'bool', def: true },
        ],
      },
      {
        code: 'export_rebate',
        zh: '外贸企业出口免退税',
        en: 'Export VAT Rebate',
        desc: '按专票不含税额与征退税率孰低规则精算应退税额及征退税率差转成本。',
        fields: [
          { key: 'purchaseAmount', label: '进项专票不含税金额（元）', def: '500000' },
          { key: 'vatRate', label: '专票适用征税率（如 0.13）', def: '0.13' },
          { key: 'rebateRate', label: '商品出口退税率（如 0.09）', def: '0.09' },
        ],
      },
      {
        code: 'annual_bonus_iit',
        zh: '年终奖个税与一元陷阱',
        en: 'Annual Bonus IIT Cliff',
        desc: '除以 12 找档单独计税，检测多发 1 元到手反少几千元的临界倒挂区间。',
        fields: [
          { key: 'bonus', label: '全年一次性奖金总额（元）', def: '36001' },
        ],
      },
      {
        code: 'cross_border_import',
        zh: '跨境零售进口综合税',
        en: 'Cross-Border Retail Import Tax',
        desc: '限额内 0 关税 + 70% 折算与消费税组成计税价格反算，含单次 5000 / 年度 26000 预警。',
        fields: [
          { key: 'price', label: '单笔完税价格（元）', def: '1200' },
          { key: 'vatRate', label: '增值税率（默认 0.13）', def: '0.13' },
          { key: 'consumptionTaxRate', label: '消费税率（如高档护肤品 0.15）', def: '0.15' },
          { key: 'annualUsed', label: '本年已用个人额度（元）', def: '0' },
        ],
      },
      {
        code: 'vat',
        zh: '增值税价税分离',
        en: 'VAT Split',
        desc: '对齐 2026《增值税法》口径的含税/不含税双向精确换算。',
        fields: [
          { key: 'amount', label: '合同金额（元）', def: '1130000' },
          { key: 'rate', label: '适用税率（如 0.13 / 0.06 / 0.01）', def: '0.13' },
          { key: 'inclusive', label: '金额是否含税', type: 'bool', def: true },
        ],
      },
    ]

    function FinTaxMark({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
        h('path', { d: 'M8 7l4 4.5L16 7' }),
        h('path', { d: 'M12 11.5V17' }),
        h('path', { d: 'M8.5 13h7' }),
        h('path', { d: 'M8.5 15.5h7' }),
      )
    }

    const API_BASE = (() => {
      try {
        return new URL('api/fintax', document.baseURI).pathname
      } catch {
        return '/api/fintax'
      }
    })()

    async function callApi(path, options = {}) {
      const { timeout = 25000, ...rest } = options
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const res = await fetch(`${API_BASE}${path}`, {
          ...rest,
          headers: { 'content-type': 'application/json', ...(rest.headers || {}) },
          redirect: 'error',
          signal: ctrl.signal,
        })
        const txt = await res.text()
        let json = {}
        try {
          json = txt ? JSON.parse(txt) : {}
        } catch {
          json = { error: txt.slice(0, 200) }
        }
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
        return json
      } finally {
        clearTimeout(timer)
      }
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const raw = String(reader.result || '')
          const idx = raw.indexOf(',')
          resolve(idx >= 0 ? raw.slice(idx + 1) : raw)
        }
        reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
        reader.readAsDataURL(file)
      })
    }

    function downloadText(content, filename, mime) {
      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    }

    function getLang(ctx) {
      try {
        const snapshot = typeof ctx?.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx?.locale?.getSnapshot?.()
        const raw = snapshot?.active ?? ctx?.locale?.locale ?? document.documentElement?.lang ?? navigator.language ?? 'zh'
        return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    const S = {
      wrap: (wide) => ({ maxWidth: wide ? 1120 : 860, width: '100%', margin: wide ? '0 auto' : 0, padding: wide ? '24px 32px 48px' : '8px 4px 36px', display: 'flex', flexDirection: 'column', gap: 18, color: 'inherit', fontFamily: 'inherit' }),
      topHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12, paddingBottom: 14, borderBottom: '2px solid currentColor' },
      h1: { fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: '-0.4px' },
      sub: { fontSize: 13, opacity: 0.72, margin: '4px 0 0', lineHeight: 1.5 },
      tabs: { display: 'flex', gap: 6, borderBottom: '1px solid rgba(128,128,128,0.28)', paddingBottom: 0 },
      tab: (on) => ({ padding: '9px 16px', fontSize: 13.5, fontWeight: on ? 800 : 600, background: 'transparent', color: 'inherit', border: 'none', borderBottom: on ? '3px solid currentColor' : '3px solid transparent', opacity: on ? 1 : 0.62, cursor: 'pointer', marginBottom: -1 }),
      panel: { border: '1.5px solid rgba(128,128,128,0.32)', borderRadius: 4, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14, background: 'rgba(128,128,128,0.03)' },
      dropzone: (drag) => ({ border: `2px dashed ${drag ? '#dc2626' : 'rgba(128,128,128,0.45)'}`, borderRadius: 4, padding: '26px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, background: drag ? 'rgba(220,38,38,0.06)' : 'rgba(128,128,128,0.04)', transition: 'border-color 0.15s' }),
      btnSolid: { padding: '8px 16px', borderRadius: 3, border: '1.5px solid currentColor', background: 'currentColor', cursor: 'pointer', fontSize: 13, fontWeight: 700 },
      btnPrimary: { padding: '8px 16px', borderRadius: 3, border: '1.5px solid #0f172a', background: '#0f172a', color: '#ffffff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
      btnAccent: { padding: '8px 16px', borderRadius: 3, border: '1.5px solid #dc2626', background: '#dc2626', color: '#ffffff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
      btnLine: { padding: '7px 14px', borderRadius: 3, border: '1.5px solid rgba(128,128,128,0.45)', background: 'transparent', color: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
      btnDanger: { padding: '7px 14px', borderRadius: 3, border: '1.5px solid rgba(220,38,38,0.6)', background: 'transparent', color: '#dc2626', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
      input: { padding: '7px 10px', borderRadius: 3, border: '1.5px solid rgba(128,128,128,0.38)', background: 'transparent', color: 'inherit', fontSize: 13.5, outline: 'none', fontVariantNumeric: 'tabular-nums' },
      badge: (tone) => {
        const map = {
          ok: { bg: 'rgba(22,163,74,0.14)', fg: '#15803d', bd: 'rgba(22,163,74,0.4)' },
          warn: { bg: 'rgba(217,119,6,0.14)', fg: '#b45309', bd: 'rgba(217,119,6,0.45)' },
          err: { bg: 'rgba(220,38,38,0.14)', fg: '#dc2626', bd: 'rgba(220,38,38,0.45)' },
          info: { bg: 'rgba(128,128,128,0.12)', fg: 'inherit', bd: 'rgba(128,128,128,0.35)' },
        }[tone || 'info']
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 9px', borderRadius: 2, fontSize: 12, fontWeight: 700, background: map.bg, color: map.fg, border: `1px solid ${map.bd}` }
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      th: { textAlign: 'left', padding: '8px 8px', borderBottom: '2px solid rgba(128,128,128,0.45)', fontWeight: 800, fontSize: 12, opacity: 0.85 },
      td: { padding: '9px 8px', borderBottom: '1px solid rgba(128,128,128,0.2)', verticalAlign: 'top' },
      num: { textAlign: 'right', fontFamily: 'Consolas, ui-monospace, monospace', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 },
      kpiCard: { border: '1.5px solid rgba(128,128,128,0.3)', borderRadius: 3, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 },
      kpiVal: { fontSize: 22, fontWeight: 800, fontFamily: 'Consolas, ui-monospace, monospace', fontVariantNumeric: 'tabular-nums' },
    }

    function StatementRadarTab({ t, onCopyText, copiedKey }) {
      const [dragging, setDragging] = useState(false)
      const [platform, setPlatform] = useState('auto')
      const [uploadedFiles, setUploadedFiles] = useState([])
      const [demoMode, setDemoMode] = useState('')
      const [fxMap, setFxMap] = useState({ USD: '7.18', EUR: '7.82', GBP: '9.15', AUD: '4.72' })
      const [declaredCny, setDeclaredCny] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [data, setData] = useState(null)

      const runParse = useCallback(async ({ files, demo, fxOverrides, declaredOverride, platOverride }) => {
        setBusy(true)
        setErr('')
        try {
          const useFx = fxOverrides || fxMap
          const numericFx = {}
          for (const [k, v] of Object.entries(useFx)) {
            const n = Number(v)
            if (Number.isFinite(n) && n > 0) numericFx[k] = n
          }
          const declRaw = declaredOverride !== undefined ? declaredOverride : declaredCny
          const declNum = declRaw !== '' && Number.isFinite(Number(declRaw)) ? Number(declRaw) : undefined
          const payload = {
            platform: platOverride || platform,
            fxRates: numericFx,
            declaredVatSalesCny: declNum,
          }
          if (demo) payload.demo = demo
          else payload.files = files

          const res = await callApi('/parse', { method: 'POST', body: JSON.stringify(payload), timeout: 45000 })
          setData(res)
          // 补充新识别出的外币默认汇率输入框
          const nextFx = { ...useFx }
          for (const s of res.summaries || []) {
            if (s.currency && s.currency !== 'RMB' && s.currency !== 'CNY' && !nextFx[s.currency]) {
              nextFx[s.currency] = String(DEFAULT_FX[s.currency] || 7.0)
            }
          }
          setFxMap(nextFx)
        } catch (e) {
          setErr(e.message || '解析失败')
        } finally {
          setBusy(false)
        }
      }, [fxMap, declaredCny, platform])

      const handleFiles = async (fileList) => {
        const arr = Array.from(fileList || [])
        if (!arr.length) return
        setBusy(true)
        setErr('')
        try {
          const encoded = []
          for (const f of arr.slice(0, 24)) {
            const dataBase64 = await fileToBase64(f)
            encoded.push({ name: f.name, dataBase64 })
          }
          setUploadedFiles(encoded)
          setDemoMode('')
          await runParse({ files: encoded, demo: '' })
        } catch (e) {
          setErr(e.message)
          setBusy(false)
        }
      }

      const handleDemo = async () => {
        setUploadedFiles([])
        setDemoMode('all')
        setDeclaredCny('580000')
        await runParse({ files: [], demo: 'all', declaredOverride: '580000' })
      }

      const allAnoms = (data?.summaries || []).flatMap((s) =>
        (s.anomalies || []).map((a) => ({ ...a, scope: `${s.platform}·${s.site}(${s.currency})` })),
      )
      const p0 = allAnoms.filter((a) => a.severity.startsWith('P0'))
      const p1 = allAnoms.filter((a) => a.severity.startsWith('P1'))
      const p2 = allAnoms.filter((a) => a.severity.startsWith('P2'))
      const totalRows = (data?.summaries || []).reduce((acc, s) => acc + (s.rawRowCount || 0), 0)
      const activeCcys = [...new Set((data?.summaries || []).map((s) => s.currency).filter((c) => c && c !== 'RMB' && c !== 'CNY'))]

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        // 拖拽上传区（已载入账单后自动折叠为紧凑顶条，把首屏让给数据报表）
        h(
          'div',
          {
            style: data
              ? { ...S.dropzone(dragging), padding: '12px 16px', flexDirection: 'row', justifyContent: 'space-between', textAlign: 'left', flexWrap: 'wrap' }
              : S.dropzone(dragging),
            onDragOver: (e) => { e.preventDefault(); setDragging(true) },
            onDragLeave: () => setDragging(false),
            onDrop: (e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer?.files) },
          },
          data
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                h('div', { style: { fontSize: 13.5, fontWeight: 800 } }, demoMode ? '三平台脱敏沙盒演示（Amazon + Temu + Shopify）' : `已载入：${uploadedFiles.map((f) => f.name).join('、')}`),
                h('div', { style: { fontSize: 11.5, opacity: 0.68 } }, '可继续拖入新账单或 .zip 压缩包覆盖重扫（原始订单行 100% 留在本机内存）'),
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 } },
                h('div', { style: { fontSize: 16, fontWeight: 800 } }, t.dropTitle),
                h('div', { style: { fontSize: 12.5, opacity: 0.72, maxWidth: 680, lineHeight: 1.5 } }, t.dropSub),
              ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', alignItems: 'center' } },
            h(
              'label',
              { style: { ...S.btnPrimary, display: 'inline-flex', alignItems: 'center' } },
              busy ? t.parsing : t.pickFiles,
              h('input', {
                type: 'file',
                multiple: true,
                accept: '.csv,.tsv,.txt,.xlsx,.xlsm,.zip',
                style: { display: 'none' },
                onChange: (e) => { handleFiles(e.target.files); e.target.value = '' },
              }),
            ),
            h('button', { type: 'button', style: S.btnLine, disabled: busy, onClick: handleDemo }, t.runDemo),
            h(
              'select',
              { value: platform, onChange: (e) => setPlatform(e.target.value), style: { ...S.input, fontSize: 12.5 } },
              h('option', { value: 'auto' }, t.platformAuto),
              h('option', { value: 'amazon' }, 'Amazon'),
              h('option', { value: 'temu' }, 'Temu'),
              h('option', { value: 'tiktok' }, 'TikTok Shop'),
              h('option', { value: 'shopify' }, 'Shopify'),
              h('option', { value: 'stripe' }, 'Stripe'),
            ),
          ),
        ),
        err && h('div', { style: { ...S.badge('err'), padding: '10px 14px', fontSize: 13 } }, err),
        data &&
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
            // 顶部审计状态横幅与导出栏
            h(
              'div',
              { style: { ...S.panel, borderColor: p0.length ? '#dc2626' : p1.length ? '#d97706' : '#15803d', borderWidth: 2 } },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                  h('span', { style: S.badge(p0.length ? 'err' : p1.length ? 'warn' : 'ok') }, p0.length ? `P0 阻断 ${p0.length} 项` : p1.length ? `P1 高危 ${p1.length} 项` : '初筛勾稽平衡'),
                  h('span', { style: { fontSize: 13.5, fontWeight: 700 } }, `扫描 ${data.summaries.length} 张表 / ${totalRows} 行明细 · 耗时 ${data.elapsedMs} ms`),
                  p1.length > 0 && p0.length > 0 && h('span', { style: S.badge('warn') }, `P1 高危 ${p1.length}`),
                  p2.length > 0 && h('span', { style: S.badge('info') }, `P2 关注 ${p2.length}`),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('button', { type: 'button', style: S.btnPrimary, onClick: () => downloadText(data.reportHtml, '跨境店铺税务初筛体检诊断书.html', 'text/html;charset=utf-8') }, t.exportHtml),
                  h('button', { type: 'button', style: S.btnLine, onClick: () => downloadText(data.reportMd, '跨境店铺税务初筛体检诊断书.md', 'text/markdown;charset=utf-8') }, t.exportMd),
                ),
              ),
              // 实时汇率与申报额重算条
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', paddingTop: 10, borderTop: '1px dashed rgba(128,128,128,0.3)' } },
                ...activeCcys.map((ccy) =>
                  h(
                    'div',
                    { key: ccy, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                    h('label', { style: { fontSize: 11.5, fontWeight: 700, opacity: 0.78 } }, `${ccy} 折人民币汇率`),
                    h('input', {
                      type: 'number',
                      step: '0.01',
                      value: fxMap[ccy] ?? '',
                      onChange: (e) => setFxMap({ ...fxMap, [ccy]: e.target.value }),
                      style: { ...S.input, width: 105 },
                    }),
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                  h('label', { style: { fontSize: 11.5, fontWeight: 700, opacity: 0.78 } }, t.declaredLabel),
                  h('input', {
                    type: 'number',
                    placeholder: '可选，如 580000',
                    value: declaredCny,
                    onChange: (e) => setDeclaredCny(e.target.value),
                    style: { ...S.input, width: 180 },
                  }),
                ),
                h('button', {
                  type: 'button',
                  style: S.btnLine,
                  disabled: busy,
                  onClick: () => runParse({ files: uploadedFiles, demo: demoMode }),
                }, t.recalcBtn),
              ),
            ),
            // 7,500 万小微生死崖可视化进度条 + 合并 KPI
            data.consolidated?.ready &&
              h(
                'div',
                { style: S.panel },
                h('div', { style: { fontSize: 14.5, fontWeight: 800 } }, '一、多表合并人民币总对账 & 7,500 万小微核定红线监控'),
                h(
                  'div',
                  { style: S.kpiGrid },
                  h('div', { style: S.kpiCard }, h('span', { style: { fontSize: 12, opacity: 0.7 } }, '合并报送参考毛额 (CNY)'), h('span', { style: S.kpiVal }, `¥${data.consolidated.totals.grossCny.toLocaleString()}`)),
                  h('div', { style: S.kpiCard }, h('span', { style: { fontSize: 12, opacity: 0.7 } }, '合并净销售额 (CNY)'), h('span', { style: S.kpiVal }, `¥${data.consolidated.totals.netSalesCny.toLocaleString()}`)),
                  h('div', { style: S.kpiCard }, h('span', { style: { fontSize: 12, opacity: 0.7 } }, '合并平台佣金及履约费'), h('span', { style: S.kpiVal }, `¥${data.consolidated.totals.feesCny.toLocaleString()}`)),
                  data.consolidated.reconcile.declarationDiagnosis &&
                    h(
                      'div',
                      { style: { ...S.kpiCard, borderColor: Math.abs(data.consolidated.reconcile.declarationDiagnosis.unexplainedSalesGap) > 1 ? '#dc2626' : '#15803d' } },
                      h('span', { style: { fontSize: 12, fontWeight: 700, color: '#dc2626' } }, '待核查申报缺口 (CNY)'),
                      h('span', { style: { ...S.kpiVal, color: '#dc2626' } }, `¥${Number(data.consolidated.reconcile.declarationDiagnosis.unexplainedSalesGap).toLocaleString()}`),
                    ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700 } },
                    h('span', null, '7,500 万元小微红线占比（4% 核定下对应 300 万应税所得额上限）'),
                    h('span', { style: { color: data.consolidated.cliffRatioPct >= 80 ? '#dc2626' : 'inherit' } }, `${data.consolidated.cliffRatioPct}%`),
                  ),
                  h(
                    'div',
                    { style: { height: 10, background: 'rgba(128,128,128,0.2)', borderRadius: 2, overflow: 'hidden' } },
                    h('div', { style: { width: `${Math.min(100, Math.max(1.5, data.consolidated.cliffRatioPct))}%`, height: '100%', background: data.consolidated.cliffRatioPct >= 100 ? '#dc2626' : data.consolidated.cliffRatioPct >= 75 ? '#d97706' : '#0f172a' } }),
                  ),
                  data.consolidated.cliffAlert && h('div', { style: { fontSize: 13, fontWeight: 700, color: '#dc2626' } }, data.consolidated.cliffAlert),
                ),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, lineHeight: 1.55, opacity: 0.88 } },
                  ...data.consolidated.reconcile.steps.map((st, idx) => h('div', { key: idx }, `· ${st}`)),
                  ...data.consolidated.reconcile.warnings.map((w, idx) => h('div', { key: `w${idx}`, style: { color: '#b45309', fontWeight: 700 } }, `⚠ ${w}`)),
                ),
              ),
            // 原币四层口径表
            h(
              'div',
              { style: { ...S.panel, overflowX: 'auto' } },
              h('div', { style: { fontSize: 14.5, fontWeight: 800 } }, '二、各站点原币四层口径精确拆解（BigInt 精确到 0.01）'),
              h(
                'table',
                { style: S.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: S.th }, '平台 · 站点'),
                    h('th', { style: S.th }, '期间 / 币种'),
                    h('th', { style: { ...S.th, textAlign: 'right' } }, '报送参考毛额'),
                    h('th', { style: { ...S.th, textAlign: 'right' } }, '客户退款'),
                    h('th', { style: { ...S.th, textAlign: 'right' } }, '佣金履约费'),
                    h('th', { style: { ...S.th, textAlign: 'right' } }, '待自报税'),
                    h('th', { style: { ...S.th, textAlign: 'right' } }, '实际打款'),
                    h('th', { style: S.th }, '水平守恒'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  ...data.summaries.map((s, idx) =>
                    h(
                      'tr',
                      { key: idx },
                      h('td', { style: S.td }, h('strong', null, `${s.platform} · ${s.site}`), h('div', { style: { fontSize: 11.5, opacity: 0.65 } }, s.fileName)),
                      h('td', { style: S.td }, `${s.period} · `, h('strong', null, s.currency)),
                      h('td', { style: { ...S.td, ...S.num, fontWeight: 800 } }, s.taxReportingGrossRef),
                      h('td', { style: { ...S.td, ...S.num } }, s.customerRefund),
                      h('td', { style: { ...S.td, ...S.num } }, s.totalFees),
                      h('td', { style: { ...S.td, ...S.num } }, s.selfRemitTaxNet),
                      h('td', { style: { ...S.td, ...S.num } }, s.actualPayout),
                      h('td', { style: S.td }, h('span', { style: S.badge(s.horizontalBalanced ? 'ok' : 'err') }, s.horizontalBalanced ? '守恒' : `差 ${s.horizontalDiffTotal}`)),
                    ),
                  ),
                ),
              ),
            ),
            // 异常雷达与 IMA 法规整改导流
            h(
              'div',
              { style: S.panel },
              h('div', { style: { fontSize: 14.5, fontWeight: 800 } }, `三、异常交易雷达清单（P0: ${p0.length} / P1: ${p1.length} / P2: ${p2.length}）`),
              allAnoms.length === 0
                ? h('div', { style: { fontSize: 13, color: '#15803d', fontWeight: 700 } }, '全部明细行扫描完毕，未检出异常交易。')
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                    ...[...p0, ...p1, ...p2].slice(0, 20).map((a, idx) => {
                      const tone = a.severity.startsWith('P0') ? 'err' : a.severity.startsWith('P1') ? 'warn' : 'info'
                      const qaPrompt = `我在账单体检中检出 [${a.severity}] ${a.scope} ${a.category}（金额 ${a.amount}）：${a.detail}。请先检索我的 IMA 财税知识库，给出对应的现行政策文号与合规整改步骤。`
                      return h(
                        'div',
                        { key: idx, style: { borderLeft: `4px solid ${tone === 'err' ? '#dc2626' : tone === 'warn' ? '#d97706' : '#64748b'}`, padding: '8px 12px', background: 'rgba(128,128,128,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 } },
                        h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                          h('div', { style: { fontSize: 13.5, fontWeight: 800 } }, `[${a.severity}] [${a.scope}] ${a.category} `, h('span', { style: { fontFamily: 'Consolas, monospace', fontSize: 12, opacity: 0.72 } }, `(${a.refId} · ${a.amount})`)),
                          h('div', { style: { fontSize: 12.5, opacity: 0.85, lineHeight: 1.5 } }, a.detail),
                        ),
                        h('button', { type: 'button', style: { ...S.btnLine, fontSize: 12, whiteSpace: 'nowrap' }, onClick: () => onCopyText(`anom-${idx}`, qaPrompt) }, copiedKey === `anom-${idx}` ? t.copied : '查 IMA 整改 SOP'),
                      )
                    }),
                  ),
              h('div', { style: { fontSize: 12, opacity: 0.68, paddingTop: 8, borderTop: '1px dashed rgba(128,128,128,0.3)', lineHeight: 1.55 } }, '边界声明：本面板仅输出原始账单离线初筛与排雷结论；多店铺主体映射、第三方收款池期初期末轧平及标准会计分录请结合配套 IMA 实战库与《跨境月结四层口径一表通母表》并经执业税务师复核。'),
            ),
          ),
      )
    }

    function buildInitialValues(sc) {
      const obj = {}
      for (const f of sc.fields) obj[f.key] = f.def
      return obj
    }

    function CalculatorTab({ t, isZh, onCopyText, copiedKey }) {
      const [activeCode, setActiveCode] = useState(CALC_SCENARIOS[0].code)
      const [forms, setForms] = useState(() => {
        const init = {}
        for (const sc of CALC_SCENARIOS) init[sc.code] = buildInitialValues(sc)
        return init
      })
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [result, setResult] = useState(null)

      const sc = CALC_SCENARIOS.find((x) => x.code === activeCode) || CALC_SCENARIOS[0]
      const vals = forms[sc.code] || {}

      const setField = (k, v) => {
        setForms({ ...forms, [sc.code]: { ...vals, [k]: v } })
      }

      const runCalc = async (targetSc = sc, targetVals = vals) => {
        setBusy(true)
        setErr('')
        try {
          const params = {}
          for (const f of targetSc.fields) {
            const raw = targetVals[f.key]
            if (f.type === 'bool') {
              params[f.key] = Boolean(raw)
            } else if (raw !== '' && raw !== null && raw !== undefined) {
              params[f.key] = Number(raw)
            }
          }
          const res = await callApi('/calc', { method: 'POST', body: JSON.stringify({ scenario: targetSc.code, params }) })
          setResult(res.result)
        } catch (e) {
          setErr(e.message || '试算失败')
        } finally {
          setBusy(false)
        }
      }

      const formatHeadline = (r) => {
        if (!r) return ''
        if (r.summaryLine) return r.summaryLine
        if (r.taxRefund !== undefined) return `应退增值税 ${r.taxRefund} 元｜征退差转成本 ${r.nonRefundableToCost} 元`
        if (r.afterTax !== undefined) return `应纳个税 ${r.taxPayable} 元（实际税负 ${r.effectiveRate}）｜税后到手 ${r.afterTax} 元`
        if (r.taxAmount !== undefined) return `不含税额 ${r.netAmount} 元｜税额 ${r.taxAmount} 元｜价税合计 ${r.grossAmount} 元`
        if (r.taxPayable !== undefined) return `应纳税额 ${r.taxPayable} 元（综合税负 ${r.effectiveRate || r.effectiveRateOnRevenue || '—'}）`
        return r.scenario || ''
      }
      const refText = (item) => (typeof item === 'string' ? item : item?.ref || '')
      const headline = formatHeadline(result)
      const aiPrompt = result
        ? `我已用财税工作台本地引擎完成【${result.scenario}】精算（结论：${headline}）。请结合我的 IMA 财税知识库核对相关现行政策文号（${(result.policyRefs || []).map(refText).filter(Boolean).join('、')}）及实操注意事项。`
        : ''

      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '235px 1fr', gap: 16, alignItems: 'start' } },
        // 左侧 7 场景切换栏
        h(
          'div',
          { style: { border: '1.5px solid rgba(128,128,128,0.32)', borderRadius: 4, overflow: 'hidden' } },
          ...CALC_SCENARIOS.map((item) => {
            const on = item.code === sc.code
            return h(
              'button',
              {
                key: item.code,
                type: 'button',
                onClick: () => { setActiveCode(item.code); setResult(null); setErr('') },
                style: {
                  width: '100%',
                  textAlign: 'left',
                  padding: '11px 14px',
                  border: 'none',
                  borderBottom: '1px solid rgba(128,128,128,0.2)',
                  background: on ? 'rgba(128,128,128,0.16)' : 'transparent',
                  color: 'inherit',
                  fontWeight: on ? 800 : 600,
                  fontSize: 13,
                  cursor: 'pointer',
                  borderLeft: on ? '4px solid currentColor' : '4px solid transparent',
                },
              },
              isZh ? item.zh : item.en,
            )
          }),
        ),
        // 右侧表单 + 实时精算结果
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h(
            'div',
            { style: { ...S.panel, padding: '14px 18px', gap: 10 } },
            h('div', { style: { fontSize: 15.5, fontWeight: 800 } }, isZh ? sc.zh : sc.en),
            h('div', { style: { fontSize: 12.5, opacity: 0.74, lineHeight: 1.45 } }, sc.desc),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 10 } },
              ...sc.fields.map((f) =>
                h(
                  'div',
                  { key: f.key, style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                  h('label', { style: { fontSize: 12, fontWeight: 700, opacity: 0.85 } }, f.label),
                  f.type === 'bool'
                    ? h(
                        'select',
                        { value: vals[f.key] ? 'true' : 'false', onChange: (e) => setField(f.key, e.target.value === 'true'), style: S.input },
                        h('option', { value: 'true' }, '是 (True)'),
                        h('option', { value: 'false' }, '否 (False)'),
                      )
                    : h('input', {
                        type: 'number',
                        step: 'any',
                        value: vals[f.key] ?? '',
                        onChange: (e) => setField(f.key, e.target.value),
                        style: S.input,
                      }),
                ),
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 } },
              h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => runCalc() }, busy ? '计算中…' : '立即代码精算（0 Token）'),
              result && h('button', { type: 'button', style: S.btnLine, onClick: () => onCopyText('calc-ai', aiPrompt) }, copiedKey === 'calc-ai' ? t.copied : '复制结果去查 IMA 原文'),
            ),
            err && h('div', { style: { ...S.badge('err'), padding: '8px 12px', fontSize: 13 } }, err),
          ),
          result &&
            h(
              'div',
              { style: { ...S.panel, borderColor: (result.warnings || []).length ? '#d97706' : '#15803d', borderWidth: 2 } },
              h('div', { style: { fontSize: 15.5, fontWeight: 800, lineHeight: 1.45 } }, headline),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, lineHeight: 1.6 } },
                ...(result.steps || []).map((st, i) => h('div', { key: i }, `· ${st}`)),
              ),
              (result.warnings || []).length > 0 &&
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10, borderTop: '1px dashed rgba(128,128,128,0.35)' } },
                  ...result.warnings.map((w, i) => h('div', { key: i, style: { fontSize: 13, fontWeight: 700, color: '#dc2626', lineHeight: 1.5 } }, `⚠ ${w}`)),
                ),
              (result.policyRefs || []).length > 0 &&
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 6 } },
                  ...result.policyRefs.map((item, i) => h('span', { key: i, title: item?.note || '', style: S.badge('info') }, refText(item))),
                ),
            ),
        ),
      )
    }

    function SettingsTab({ t, status, refreshStatus }) {
      const [clientId, setClientId] = useState('')
      const [apiKey, setApiKey] = useState('')
      const [manualKbId, setManualKbId] = useState('')
      const [kbs, setKbs] = useState([])
      const [saving, setSaving] = useState(false)
      const [testing, setTesting] = useState(false)
      const [msg, setMsg] = useState(null)

      const onSaveCreds = async () => {
        setSaving(true)
        setMsg(null)
        try {
          const data = await callApi('/credentials', { method: 'POST', body: JSON.stringify({ clientId, apiKey }) })
          setClientId('')
          setApiKey('')
          setMsg({ ok: true, text: t.savedOk })
          await refreshStatus(data)
        } catch (err) {
          setMsg({ ok: false, text: err.message })
        } finally {
          setSaving(false)
        }
      }

      const onClearCreds = async () => {
        setSaving(true)
        setMsg(null)
        try {
          const data = await callApi('/credentials', { method: 'DELETE' })
          setKbs([])
          setMsg({ ok: true, text: t.clearedOk })
          await refreshStatus(data)
        } catch (err) {
          setMsg({ ok: false, text: err.message })
        } finally {
          setSaving(false)
        }
      }

      const onTestAndLoadKbs = async () => {
        setTesting(true)
        setMsg(null)
        try {
          if (clientId.trim() || apiKey.trim()) {
            await callApi('/credentials', { method: 'POST', body: JSON.stringify({ clientId, apiKey }) })
            setClientId('')
            setApiKey('')
            await refreshStatus()
          }
          const data = await callApi('/kbs?refresh=1')
          setKbs(Array.isArray(data.kbs) ? data.kbs : [])
          setMsg({ ok: true, text: `连接成功，共拉取 ${data.kbs?.length || 0} 个 IMA 知识库` })
        } catch (err) {
          setMsg({ ok: false, text: err.message })
        } finally {
          setTesting(false)
        }
      }

      const onBindKb = async (kbId, kbName) => {
        setMsg(null)
        try {
          const data = await callApi('/settings', { method: 'POST', body: JSON.stringify({ defaultKbId: kbId, defaultKbName: kbName }) })
          setManualKbId('')
          setMsg({ ok: true, text: kbId ? `${t.kbBoundOk}：${kbName || kbId}` : '已取消默认知识库绑定' })
          await refreshStatus(data)
        } catch (err) {
          setMsg({ ok: false, text: err.message })
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h(
          'section',
          { style: S.panel },
          h('div', { style: { fontSize: 15, fontWeight: 800 } }, t.credTitle),
          h('div', { style: { fontSize: 12.5, opacity: 0.74, lineHeight: 1.5 } }, t.credDesc),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, h('label', { style: { fontSize: 12, fontWeight: 700 } }, t.cidLabel), h('input', { type: 'password', autoComplete: 'off', style: S.input, value: clientId, placeholder: status.clientIdSet ? t.savedPlaceholder : t.emptyCidPlaceholder, onChange: (e) => setClientId(e.target.value) })),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, h('label', { style: { fontSize: 12, fontWeight: 700 } }, t.keyLabel), h('input', { type: 'password', autoComplete: 'off', style: S.input, value: apiKey, placeholder: status.apiKeySet ? t.savedPlaceholder : t.emptyKeyPlaceholder, onChange: (e) => setApiKey(e.target.value) })),
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
            h('button', { type: 'button', style: S.btnPrimary, disabled: saving || (!clientId.trim() && !apiKey.trim()), onClick: onSaveCreds }, saving ? t.savingBtn : t.saveBtn),
            h('button', { type: 'button', style: S.btnLine, disabled: testing, onClick: onTestAndLoadKbs }, testing ? t.testingBtn : t.testBtn),
            status.configured && !status.envOverride && h('button', { type: 'button', style: S.btnDanger, disabled: saving, onClick: onClearCreds }, t.clearBtn),
          ),
          msg && h('div', { style: { fontSize: 13, fontWeight: 700, color: msg.ok ? '#15803d' : '#dc2626' } }, msg.text),
        ),
        h(
          'section',
          { style: S.panel },
          h('div', { style: { fontSize: 15, fontWeight: 800 } }, t.kbTitle),
          h('div', { style: { fontSize: 12.5, opacity: 0.74, lineHeight: 1.5 } }, t.kbDesc),
          kbs.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                ...kbs.map((kb) => {
                  const isDef = status.defaultKbId && status.defaultKbId === kb.id
                  return h(
                    'div',
                    { key: kb.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 3, border: isDef ? '2px solid currentColor' : '1px solid rgba(128,128,128,0.28)' } },
                    h('div', null, h('div', { style: { fontSize: 13.5, fontWeight: 700 } }, kb.name), h('div', { style: { fontSize: 12, opacity: 0.68, fontFamily: 'Consolas, monospace' } }, `ID: ${kb.id}${kb.count ? ` · ${kb.count} 篇` : ''}`)),
                    isDef
                      ? h('span', { style: S.badge('ok') }, t.kbCurrentBadge)
                      : h('button', { type: 'button', style: S.btnLine, onClick: () => onBindKb(kb.id, kb.name) }, t.kbSetDefault),
                  )
                }),
              )
            : h('div', { style: { fontSize: 12.5, opacity: 0.7 } }, t.kbEmptyHint),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } },
            h('input', { type: 'text', style: { ...S.input, flex: 1, minWidth: 220 }, value: manualKbId, placeholder: t.kbManualPlaceholder, onChange: (e) => setManualKbId(e.target.value) }),
            h('button', { type: 'button', style: S.btnLine, disabled: !manualKbId.trim(), onClick: () => onBindKb(manualKbId.trim(), '') }, t.kbSaveManual),
            status.defaultKbId && status.defaultKbSource !== 'env' && h('button', { type: 'button', style: S.btnDanger, onClick: () => onBindKb('', '') }, t.kbClearDefault),
          ),
        ),
      )
    }

    function FinTaxWorkbench({ lang, surface = 'settings' }) {
      const isZh = lang !== 'en'
      const t = COPY[isZh ? 'zh' : 'en']
      const [tab, setTab] = useState(surface === 'sidebar' ? 'radar' : 'settings')
      const [status, setStatus] = useState({ loading: true, configured: false, source: 'none', defaultKbId: '', defaultKbName: '', version: '' })
      const [copiedKey, setCopiedKey] = useState('')

      const refreshStatus = useCallback(async (direct) => {
        try {
          const data = direct || (await callApi('/status'))
          setStatus({ loading: false, ...data })
        } catch {
          setStatus((prev) => ({ ...prev, loading: false }))
        }
      }, [])

      useEffect(() => { refreshStatus() }, [refreshStatus])

      const onCopyText = async (key, text) => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
          setCopiedKey(key)
          setTimeout(() => setCopiedKey(''), 1800)
        } catch {
          // ignore clipboard denial
        }
      }

      const credBadge = status.configured
        ? status.source === 'env'
          ? t.statusReadyEnv
          : status.source === 'mixed'
            ? t.statusReadyMixed
            : t.statusReadyFile
        : t.statusMissing

      return h(
        'div',
        { style: S.wrap(surface === 'sidebar') },
        h(
          'div',
          { style: S.topHead },
          h(
            'div',
            null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, h(FinTaxMark, { size: 22 }), h('h1', { style: S.h1 }, `${t.title}${status.version ? ` v${status.version}` : ''}`)),
            h('p', { style: S.sub }, t.subtitle),
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            h('span', { style: S.badge(status.configured ? 'ok' : 'warn') }, credBadge),
            h('span', { style: S.badge('info') }, status.defaultKbId ? `${t.defaultKbBound}${status.defaultKbName || status.defaultKbId}` : t.defaultKbNone),
          ),
        ),
        h(
          'div',
          { style: S.tabs },
          h('button', { type: 'button', style: S.tab(tab === 'radar'), onClick: () => setTab('radar') }, t.tabRadar),
          h('button', { type: 'button', style: S.tab(tab === 'calc'), onClick: () => setTab('calc') }, t.tabCalc),
          h('button', { type: 'button', style: S.tab(tab === 'settings'), onClick: () => setTab('settings') }, t.tabSettings),
        ),
        tab === 'radar' && h(StatementRadarTab, { t, onCopyText, copiedKey }),
        tab === 'calc' && h(CalculatorTab, { t, isZh, onCopyText, copiedKey }),
        tab === 'settings' && h(SettingsTab, { t, status, refreshStatus }),
      )
    }

    return {
      name: 'fintax',
      inject,
      apply(ctx) {
        try {
          const t = ctx.locale.bind(NS)
          ctx.effect(() => ctx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), 'fintax: dictionaries')

          // 1. 左侧边栏独立全屏财税工作台（DSH >= 0.2.1 支持 sidebar.panellist + main）
          ctx.slots.inject('sidebar.panellist', () => {
            const offPanel = ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
              },
              () => h('div', { style: { height: '100%', width: '100%', overflow: 'auto' } }, h(FinTaxWorkbench, { lang: getLang(ctx), surface: 'sidebar' })),
            )
            const offRow = ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 22,
                label: () => t('nav'),
                locale: NS,
              },
              (owner = {}) => h(FinTaxMark, { size: owner?.size ?? 16 }),
            )
            return () => {
              if (typeof offRow === 'function') offRow()
              if (typeof offPanel === 'function') offPanel()
            }
          })

          // 2. 设置导航自定义矢量图标（DSH >= 0.2.2 支持 settings.section.icon）
          ctx.slots.inject('settings.section.icon', () => {
            const off = ctx.slots.register(
              { name: 'settings.section.icon', id: 'fintax' },
              (owner = {}) => h(FinTaxMark, { size: owner?.size ?? 16 }),
            )
            return typeof off === 'function' ? off : () => {}
          })

          // 3. 设置页完整入口（全版本保底，保持最后注册以兼容既有测试契约）
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'fintax',
                order: 38,
                label: () => t('nav'),
                locale: NS,
              },
              (props) => h(FinTaxWorkbench, { ...props, lang: getLang(ctx), surface: 'settings' }),
            ),
          )
        } catch (err) {
          console.error('[dsh-fintax] client mount failed cleanly without crashing host:', err)
        }
      },
    }
  },
})

/**
 * dsh-fintax — 浏览器设置页半身（免构建 ModuleLoader 模块）。
 *
 * 在 DSH 桌面端 / Web 端「设置」侧边栏注册「财税工作台 (FinTax workbench)」配置面板：
 *   1. 免命令行填写/更新/清除腾讯 IMA OpenAPI 凭证（密钥只写不回显）；
 *   2. 一键测试 IMA 连通性并拉取账号下知识库列表，点选绑定「默认优先检索财税库」；
 *   3. 展示内置 7 大离线即用确定性算税与对账引擎及一键复制提问模板。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fintax',
  factory(require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const NS = 'settings.fintax'
    const inject = ['slots', 'locale']

    const COPY = {
      zh: {
        nav: '财税工作台',
        title: '财税工作台 · dsh-fintax',
        subtitle: '连接你的腾讯 IMA 专业财税知识库，并启用 7 大代码级确定性算税与差额桥接引擎。',
        statusReadyFile: 'IMA 凭证已就绪（本机安全文件）',
        statusReadyEnv: 'IMA 凭证已就绪（环境变量覆盖生效）',
        statusMissing: '未配置 IMA 凭证（下方 7 大算税与对账引擎仍可正常离线使用）',
        defaultKbBound: '当前默认检索库：',
        defaultKbNone: '未绑定默认库（对话时自动检索全部知识库）',
        credTitle: '1. 腾讯 IMA 知识库凭证（免命令行配置）',
        credDesc: '前往 https://ima.qq.com/agent-interface 获取 Client ID 与 API Key。凭证仅以请求头发送至官方 ima.qq.com（只读检索，绝不回显明文）。',
        cidLabel: 'Client ID',
        keyLabel: 'API Key',
        savedPlaceholder: '•••••••• 已配置（留空则保持原值不变）',
        emptyCidPlaceholder: '粘贴 IMA Client ID',
        emptyKeyPlaceholder: '粘贴 IMA API Key',
        saveBtn: '保存凭证',
        savingBtn: '保存中…',
        testBtn: '测试连接并拉取知识库',
        testingBtn: '拉取中…',
        clearBtn: '清除本地凭证',
        kbTitle: '2. 绑定默认优先检索知识库（告别多库盲翻）',
        kbDesc: '账号下有多个知识库时，绑定默认财税库后 Agent 将直接在该库检索政策与对账底稿，省去每次先扫描无关库的耗时与 Token。',
        kbManualPlaceholder: '也可直接输入或粘贴知识库 ID（如 ima_kb_xxx）',
        kbSaveManual: '绑定此 ID',
        kbClearDefault: '取消默认绑定',
        kbSetDefault: '设为默认库',
        kbCurrentBadge: '当前默认',
        kbEmptyHint: '点击上方「测试连接并拉取知识库」即可在此直接点选你的财税知识库。',
        calcTitle: '3. 原始账单离线体检雷达 + 7 大确定性算税引擎（免配置离线可用）',
        calcDesc: '支持直接拖入 Amazon / TikTok Shop / Stripe 官方原始导出账单（CSV/TSV/XLSX）做精确到分的离线初筛与异常排雷，所有算术均由确定性代码完成：',
        copyPrompt: '复制提问示例',
        copied: '已复制 ✓',
        savedOk: '凭证已安全保存至本机 ~/.config/ima/',
        clearedOk: '本地保存的 IMA 凭证已清除',
        kbBoundOk: '默认优先检索知识库已更新',
      },
      en: {
        nav: 'FinTax workbench',
        title: 'FinTax workbench · dsh-fintax',
        subtitle: 'Connect your read-only Tencent IMA tax knowledge base and run 7 deterministic tax & reconciliation calculators.',
        statusReadyFile: 'IMA credentials ready (local file)',
        statusReadyEnv: 'IMA credentials ready (environment variable override)',
        statusMissing: 'IMA credentials not set (all 7 deterministic calculators still work offline)',
        defaultKbBound: 'Default knowledge base: ',
        defaultKbNone: 'No default bound (agent lists knowledge bases automatically)',
        credTitle: '1. Tencent IMA OpenAPI credentials',
        credDesc: 'Get your Client ID and API Key from https://ima.qq.com/agent-interface. Keys are write-only in this UI and sent exclusively to ima.qq.com.',
        cidLabel: 'Client ID',
        keyLabel: 'API Key',
        savedPlaceholder: '•••••••• Configured (leave blank to keep existing value)',
        emptyCidPlaceholder: 'Paste IMA Client ID',
        emptyKeyPlaceholder: 'Paste IMA API Key',
        saveBtn: 'Save credentials',
        savingBtn: 'Saving…',
        testBtn: 'Test & load knowledge bases',
        testingBtn: 'Loading…',
        clearBtn: 'Clear local credentials',
        kbTitle: '2. Default tax knowledge base',
        kbDesc: 'Pin your primary tax knowledge base so ima_search and ima_browse query it directly without scanning unrelated bases first.',
        kbManualPlaceholder: 'Or paste a knowledge base ID directly (e.g. ima_kb_xxx)',
        kbSaveManual: 'Bind ID',
        kbClearDefault: 'Clear default',
        kbSetDefault: 'Set as default',
        kbCurrentBadge: 'Default',
        kbEmptyHint: 'Click "Test & load knowledge bases" above to pick from your IMA account.',
        calcTitle: '3. Raw statement diagnostic parser + 7 deterministic calculators (work offline)',
        calcDesc: 'Drop raw Amazon / TikTok Shop / Stripe exports (CSV/TSV/XLSX) for exact cent-level local diagnostics and P0/P1 anomaly detection.',
        copyPrompt: 'Copy sample prompt',
        copied: 'Copied ✓',
        savedOk: 'Credentials saved to ~/.config/ima/',
        clearedOk: 'Local IMA credentials cleared',
        kbBoundOk: 'Default knowledge base updated',
      },
    }

    const SCENARIOS = [
      {
        code: 'fintax_parse_statement',
        zhName: '★ 原始结算账单离线体检与异常雷达',
        enName: '★ Raw platform statement diagnostic radar',
        zhDesc: '直接读取本地 Amazon Date Range CSV / Flat File V2、TikTok Shop XLSX/CSV、Stripe 流水 CSV，BigInt 精确到分拆解四层口径并扫描全托管混表、坐支广告、A-to-z 拒付等异常。',
        enDesc: 'Offline cent-accurate parser for Amazon, TikTok Shop, and Stripe CSV/TSV/XLSX exports with P0/P1 anomaly radar.',
        prompt: '帮我调用 fintax_parse_statement 解析这份本地账单文件：<在此粘贴你的 Amazon/TikTok/Stripe 账单 CSV 或 XLSX 路径>，并按当月汇率 7.12 做四层口径初筛体检与异常排查。',
      },
      {
        code: 'platform_tax_reconcile',
        zhName: '平台涉税报送四层口径差额桥接',
        enName: 'Platform tax reporting 4-layer reconciliation',
        zhDesc: '拆解平台报送总额 vs 银行实际放款 vs 增值税已申报额，自动识别“拿回款净额报税、佣金违规冲收入”高危雷区。',
        enDesc: 'Reconciles platform-reported gross revenue, actual payout, and VAT filings; detects fee-netting errors.',
        prompt: '亚马逊本季向税局报送收入总额 600 万，其中当期买家退款 45 万、平台代扣境外流转税 35 万、跨期及汇率差 40 万、平台佣金与 FBA 费 60 万，我们增值税只按回款报了 420 万，帮我用四层口径桥接核对差额并排雷。',
      },
      {
        code: 'export_invoice_breakeven',
        zhName: '供应商开票加点毛利临界测算',
        enName: 'Supplier VAT invoice markup breakeven',
        zhDesc: '对比「加税点拿专票走出口免退税」与「综试区/1039合规无票免税」净现金成本、临界加点率 g* 与企业所得税后净利。',
        enDesc: 'Compares invoiced export rebate vs. tax-exempt no-invoice procurement and computes exact breakeven markup g*.',
        prompt: '一批出口美国货物裸采价 100 万，出口退税率 13%，上游工厂开 13% 增值税专票要加收 8 个点税点，预计出口营收 150 万，帮我测算拿专票退税划算还是走合规无票免税划算？',
      },
      {
        code: 'cbec_assessed_cit',
        zhName: '综试区 4% 核定所得税与 300 万小微崖点',
        enName: 'CBEC 4% assessed CIT & 3M cliff',
        zhDesc: '测算 4% 应税所得率叠加小型微利优惠，精准预警 7,500 万营收（300 万所得额）5 倍税负跳涨悬崖与 9810 口径风险。',
        enDesc: 'Computes 4% assessed corporate income tax and warns on the 75M CNY revenue small-low-profit cliff.',
        prompt: '已获批综试区 4% 核定征收且符合小微条件，帮我对比年营收 7500 万和冲到 8000 万时，企业所得税分别要交多少？',
      },
      {
        code: 'export_rebate',
        zhName: '外贸企业出口免退税精算',
        enName: 'Foreign-trade export VAT rebate',
        zhDesc: '按专票不含税金额与商品退税率孰低规则精算应退增值税及征退税率差转成本金额（2026年第11号公告口径）。',
        enDesc: 'Calculates export VAT refund and non-refundable VAT cost transfer under Announcement 2026 No. 11.',
        prompt: '外贸企业购进一批出口货物，增值税专用发票不含税金额 50 万，征税率 13%，该商品最新出口退税率为 9%，帮我算应退增值税和转成本金额。',
      },
      {
        code: 'annual_bonus_iit',
        zhName: '全年一次性奖金个税与多发一元陷阱',
        enName: 'Annual bonus IIT & 1-yuan cliff detector',
        zhDesc: '除以 12 找档单独计税，自动检测 (36000, 38566.67) 等全档位“多发一元到手反少几千”临界陷阱区间。',
        enDesc: 'Computes standalone annual bonus IIT and detects marginal cliff zones where +1 CNY lowers take-home pay.',
        prompt: '准备给员工发 37000 元年终奖（单独计税），帮我算个税和到手金额，看看有没有踩临界点陷阱？',
      },
      {
        code: 'cross_border_import',
        zhName: '跨境电商零售进口综合税',
        enName: 'Cross-border retail import tax',
        zhDesc: '限额内（单次 5000 / 年度 26000）0 关税 + 增值税/消费税 70% 折算及消费税组成计税价格与超限预警。',
        enDesc: 'Computes 70%-discounted import VAT/consumption tax within single/annual limits.',
        prompt: '跨境电商保税进口一瓶完税价格 1200 元的高档护肤品（消费税率 15%，增值税率 13%），帮我算综合税。',
      },
      {
        code: 'vat',
        zhName: '增值税价税分离试算',
        enName: 'VAT inclusive/exclusive split',
        zhDesc: '含税价与不含税价双向确定性拆分（支持 13% / 9% / 6% / 3% / 1% 任意税率参数）。',
        enDesc: 'Deterministic inclusive/exclusive VAT decomposition.',
        prompt: '含税合同总价 113 万元（适用 13% 增值税率），帮我做价税分离。',
      },
    ]

    const API_BASE = (() => {
      try {
        return new URL('api/fintax', document.baseURI).pathname
      } catch {
        return '/api/fintax'
      }
    })()

    async function callApi(path, options = {}) {
      const { timeout = 12000, ...rest } = options
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

    function getLang(ctx) {
      try {
        const snapshot = typeof ctx?.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx?.locale?.getSnapshot?.()
        const raw = snapshot?.active ?? ctx?.locale?.locale ?? document.documentElement?.lang ?? navigator.language ?? 'zh'
        return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    const styles = {
      wrap: { maxWidth: 820, padding: '8px 4px 36px 4px', display: 'flex', flexDirection: 'column', gap: 18, color: 'inherit' },
      header: { display: 'flex', flexDirection: 'column', gap: 6 },
      h1: { fontSize: 20, fontWeight: 700, margin: 0 },
      sub: { fontSize: 13.5, opacity: 0.75, margin: 0, lineHeight: 1.5 },
      statusRow: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 4 },
      badgeOk: { padding: '4px 10px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, background: 'rgba(34,197,94,0.14)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.3)' },
      badgeWarn: { padding: '4px 10px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, background: 'rgba(234,179,8,0.14)', color: '#ca8a04', border: '1px solid rgba(234,179,8,0.3)' },
      badgeBlue: { padding: '4px 10px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, background: 'rgba(59,130,246,0.14)', color: '#2563eb', border: '1px solid rgba(59,130,246,0.3)' },
      card: { border: '1px solid rgba(128,128,128,0.22)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, background: 'rgba(128,128,128,0.03)' },
      cardTitle: { fontSize: 15.5, fontWeight: 700, margin: 0 },
      cardDesc: { fontSize: 13, opacity: 0.75, margin: 0, lineHeight: 1.55 },
      fieldGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
      fieldCol: { display: 'flex', flexDirection: 'column', gap: 5 },
      label: { fontSize: 12.5, fontWeight: 600, opacity: 0.85 },
      input: { padding: '8px 11px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.32)', background: 'transparent', color: 'inherit', fontSize: 13.5, outline: 'none' },
      btnRow: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 2 },
      btnPrimary: { padding: '7px 14px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
      btnSecondary: { padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.32)', background: 'transparent', color: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
      btnDanger: { padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#dc2626', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
      msgOk: { fontSize: 13, color: '#16a34a', fontWeight: 600 },
      msgErr: { fontSize: 13, color: '#dc2626', fontWeight: 600 },
      kbList: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 },
      kbItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 9, border: '1px solid rgba(128,128,128,0.2)' },
      scenItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, padding: '11px 13px', borderRadius: 9, border: '1px solid rgba(128,128,128,0.18)' },
      codePill: { fontFamily: 'Consolas, monospace', fontSize: 11.5, padding: '2px 7px', borderRadius: 5, background: 'rgba(128,128,128,0.13)', marginLeft: 8 },
    }

    function FinTaxSettingsPage({ lang }) {
      const t = COPY[lang] || COPY.zh
      const isZh = lang !== 'en'
      const [status, setStatus] = useState(null)
      const [clientId, setClientId] = useState('')
      const [apiKey, setApiKey] = useState('')
      const [manualKbId, setManualKbId] = useState('')
      const [kbs, setKbs] = useState([])
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [copiedCode, setCopiedCode] = useState('')

      const refreshStatus = useCallback(async () => {
        try {
          const s = await callApi('/status')
          setStatus(s)
          if (s.defaultKbId) setManualKbId(s.defaultKbId)
        } catch (err) {
          setNotice({ kind: 'err', text: err.message })
        }
      }, [])

      useEffect(() => {
        refreshStatus()
      }, [refreshStatus])

      const onSaveCreds = async () => {
        setBusy('save')
        setNotice(null)
        try {
          const s = await callApi('/credentials', {
            method: 'POST',
            body: JSON.stringify({ clientId, apiKey }),
          })
          setStatus(s)
          setClientId('')
          setApiKey('')
          setNotice({ kind: 'ok', text: t.savedOk })
        } catch (err) {
          setNotice({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }

      const onClearCreds = async () => {
        setBusy('clear')
        setNotice(null)
        try {
          const s = await callApi('/credentials', { method: 'DELETE' })
          setStatus(s)
          setKbs([])
          setNotice({ kind: 'ok', text: t.clearedOk })
        } catch (err) {
          setNotice({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }

      const onLoadKbs = async () => {
        setBusy('test')
        setNotice(null)
        try {
          if (clientId.trim() || apiKey.trim()) {
            const s = await callApi('/credentials', {
              method: 'POST',
              body: JSON.stringify({ clientId, apiKey }),
            })
            setStatus(s)
            setClientId('')
            setApiKey('')
          }
          const res = await callApi('/kbs', { timeout: 25000 })
          setKbs(res.kbs || [])
          setNotice({
            kind: 'ok',
            text: isZh ? `连接成功，共读取到 ${(res.kbs || []).length} 个 IMA 知识库` : `Connected: ${(res.kbs || []).length} knowledge bases loaded`,
          })
        } catch (err) {
          setNotice({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }

      const onBindKb = async (kbId, kbName) => {
        setBusy('kb')
        setNotice(null)
        try {
          const s = await callApi('/settings', {
            method: 'POST',
            body: JSON.stringify({ defaultKbId: kbId, defaultKbName: kbName }),
          })
          setStatus(s)
          setManualKbId(s.defaultKbId || '')
          setNotice({ kind: 'ok', text: t.kbBoundOk })
        } catch (err) {
          setNotice({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }

      const onCopyPrompt = async (code, promptText) => {
        try {
          await navigator.clipboard.writeText(promptText)
          setCopiedCode(code)
          setTimeout(() => setCopiedCode((cur) => (cur === code ? '' : cur)), 1800)
        } catch {
          // clipboard permission denied fallback
        }
      }

      const credBadge = status?.configured
        ? h('span', { style: styles.badgeOk }, status.source === 'env' ? t.statusReadyEnv : t.statusReadyFile)
        : h('span', { style: styles.badgeWarn }, t.statusMissing)

      const kbBadge = status?.defaultKbId
        ? h('span', { style: styles.badgeBlue }, `${t.defaultKbBound}${status.defaultKbName || status.defaultKbId}`)
        : h('span', { style: { fontSize: 12.5, opacity: 0.7 } }, t.defaultKbNone)

      return h('div', { style: styles.wrap },
        h('div', { style: styles.header },
          h('h2', { style: styles.h1 }, t.title),
          h('p', { style: styles.sub }, t.subtitle),
          h('div', { style: styles.statusRow }, credBadge, kbBadge),
        ),

        notice && h('div', { style: notice.kind === 'ok' ? styles.msgOk : styles.msgErr }, notice.text),

        // Card 1: Credentials
        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.credTitle),
          h('p', { style: styles.cardDesc }, t.credDesc),
          h('div', { style: styles.fieldGrid },
            h('div', { style: styles.fieldCol },
              h('label', { style: styles.label }, t.cidLabel),
              h('input', {
                type: 'password',
                autoComplete: 'off',
                style: styles.input,
                value: clientId,
                onChange: (e) => setClientId(e.target.value),
                placeholder: status?.clientIdSet ? t.savedPlaceholder : t.emptyCidPlaceholder,
              }),
            ),
            h('div', { style: styles.fieldCol },
              h('label', { style: styles.label }, t.keyLabel),
              h('input', {
                type: 'password',
                autoComplete: 'off',
                style: styles.input,
                value: apiKey,
                onChange: (e) => setApiKey(e.target.value),
                placeholder: status?.apiKeySet ? t.savedPlaceholder : t.emptyKeyPlaceholder,
              }),
            ),
          ),
          h('div', { style: styles.btnRow },
            h('button', {
              type: 'button',
              style: styles.btnPrimary,
              disabled: Boolean(busy),
              onClick: onSaveCreds,
            }, busy === 'save' ? t.savingBtn : t.saveBtn),
            h('button', {
              type: 'button',
              style: styles.btnSecondary,
              disabled: Boolean(busy),
              onClick: onLoadKbs,
            }, busy === 'test' ? t.testingBtn : t.testBtn),
            status?.configured && !status?.envOverride && h('button', {
              type: 'button',
              style: styles.btnDanger,
              disabled: Boolean(busy),
              onClick: onClearCreds,
            }, t.clearBtn),
          ),
        ),

        // Card 2: Default KB Selection
        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.kbTitle),
          h('p', { style: styles.cardDesc }, t.kbDesc),
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            h('input', {
              type: 'text',
              style: { ...styles.input, flex: 1 },
              value: manualKbId,
              onChange: (e) => setManualKbId(e.target.value),
              placeholder: t.kbManualPlaceholder,
            }),
            h('button', {
              type: 'button',
              style: styles.btnSecondary,
              disabled: Boolean(busy) || !manualKbId.trim(),
              onClick: () => {
                const matched = kbs.find((x) => x.id === manualKbId.trim())
                onBindKb(manualKbId.trim(), matched ? matched.name : '')
              },
            }, t.kbSaveManual),
            status?.defaultKbId && h('button', {
              type: 'button',
              style: styles.btnSecondary,
              disabled: Boolean(busy),
              onClick: () => onBindKb('', ''),
            }, t.kbClearDefault),
          ),
          kbs.length > 0
            ? h('div', { style: styles.kbList },
                kbs.map((kb) => {
                  const active = status?.defaultKbId === kb.id
                  return h('div', { key: kb.id, style: styles.kbItem },
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                      h('div', { style: { fontSize: 13.5, fontWeight: 700 } },
                        kb.name,
                        kb.count ? h('span', { style: { fontWeight: 500, opacity: 0.65, marginLeft: 8, fontSize: 12 } }, `(${kb.count})`) : null,
                      ),
                      h('div', { style: { fontSize: 12, fontFamily: 'Consolas, monospace', opacity: 0.65 } }, kb.id),
                    ),
                    active
                      ? h('span', { style: styles.badgeBlue }, t.kbCurrentBadge)
                      : h('button', {
                          type: 'button',
                          style: styles.btnSecondary,
                          disabled: Boolean(busy),
                          onClick: () => onBindKb(kb.id, kb.name),
                        }, t.kbSetDefault),
                  )
                }),
              )
            : h('div', { style: { fontSize: 12.5, opacity: 0.65 } }, t.kbEmptyHint),
        ),

        // Card 3: 7 Built-in Deterministic Calculators
        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t.calcTitle),
          h('p', { style: styles.cardDesc }, t.calcDesc),
          h('div', { style: styles.kbList },
            SCENARIOS.map((sc) =>
              h('div', { key: sc.code, style: styles.scenItem },
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 } },
                  h('div', { style: { fontSize: 13.5, fontWeight: 700 } },
                    isZh ? sc.zhName : sc.enName,
                    h('span', { style: styles.codePill }, sc.code),
                  ),
                  h('div', { style: { fontSize: 12.5, opacity: 0.78, lineHeight: 1.45 } }, isZh ? sc.zhDesc : sc.enDesc),
                ),
                h('button', {
                  type: 'button',
                  style: { ...styles.btnSecondary, whiteSpace: 'nowrap' },
                  onClick: () => onCopyPrompt(sc.code, sc.prompt),
                }, copiedCode === sc.code ? t.copied : t.copyPrompt),
              ),
            ),
          ),
        ),
      )
    }

    return {
      name: 'fintax',
      inject,
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), 'fintax: dictionaries')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'fintax',
              order: 38,
              label: () => t('nav'),
              locale: NS,
            },
            (props) => h(FinTaxSettingsPage, { ...props, lang: getLang(ctx) }),
          ),
        )
      },
    }
  },
})

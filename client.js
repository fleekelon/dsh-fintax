/**
 * AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.
 * Generated from `src/client/*` via `node scripts/build-client.mjs` (zero-dependency deterministic build).
 * Modules (15): constants.js, i18n.js, styles.js, api.js, components.js, calc_specs_base.js, calc_specs.js, ima_drawer.js, stage3_panel.js, audit_tables.js, tab_audit.js, tab_calc.js, tab_annual.js, settings.js, main.js
 * Source SHA-256 (prefix): 6f3ba26976422aea
 *
 * dsh-fintax v0.9.0 — 桌面端独立财税工作台 + 图形化设置页（免构建 ModuleLoader 单文件产物）。
 * 设计语言：Dieter Rams / Braun 精密计算仪器风（哑光铝壳 + 橄榄绿 LCD 屏 + 动态双指针红线表盘 + 信号橙预警）。
 * 挂载槽位：sidebar.panellist + main、settings.section.icon、settings.section、conversation.input.dock（DSH 0.2.3+ 安全探测）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fintax',
  factory(require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo, useRef } = React

    // ── module: src/client/constants.js ──
    // Shared constants, channel whitelists, and diagnostic maps for dsh-fintax client.

    const NS = 'settings.fintax'
    const PANEL_ID = 'dsh-fintax'
    const CLIENT_VERSION = '0.9.0'
    const inject = ['slots', 'locale']

    const DEMO_FX = {
      USD: 7.18, EUR: 7.82, GBP: 9.15, AUD: 4.72, CAD: 5.18, JPY: 0.047,
      SGD: 5.36, MYR: 1.62, THB: 0.21, VND: 0.00028, PHP: 0.125, IDR: 0.00046,
      BRL: 1.26, MXN: 0.36, TWD: 0.22, HKD: 0.92, RMB: 1, CNY: 1,
    }

    // 11 sales platforms + 6 settlement wallets = 17 channels, plus Stage 3 domestic corporate bank receipts.
    const ADAPTERS = [
      'PayPal', 'AliExpress', 'Shopee', 'Amazon', 'TikTok Shop', 'Temu',
      'Shopify', 'Stripe', 'SHEIN', 'Walmart', 'Lazada',
    ]

    const WALLET_ADAPTERS = [
      'WorldFirst', 'Payoneer', 'Airwallex', 'LianLian', 'PingPong', 'SUNRATE',
    ]

    const BANK_ADAPTERS = [
      'CMB', 'BOC', 'ICBC', 'CCB', 'ABC', 'BOCOM', 'GENERIC_BANK',
      '招商银行', '中国银行', '工商银行', '建设银行', '农业银行', '交通银行', '国内对公银行',
    ]

    const MAX_UPLOAD_FILES = 24
    const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
    const ANOMALY_PAGE_SIZE = 12
    const IMA_SNIPPET_MAX_LEN = 160

    const DIAGNOSTIC_LABELS = new Map([
      ['STATEMENT_UNKNOWN_FORMAT', '未识别表头'],
      ['STATEMENT_CANDIDATE_CONFLICT', '候选格式冲突'],
      ['STATEMENT_EMPTY', '无可解析明细'],
      ['STATEMENT_AMOUNT_INVALID', '金额格式待核'],
      ['STATEMENT_LIMIT', '超过解析上限'],
      ['STATEMENT_INVALID_ARCHIVE', '压缩包或工作簿无效'],
      ['STATEMENT_NESTED_ARCHIVE', '压缩包内含不支持的文件'],
      ['STATEMENT_INVALID_FILE', '账单文件无效'],
    ])

    // ── module: src/client/i18n.js ──
    // Bilingual dictionary (zh/en), safe HTML escaping, and dynamic host locale subscription.

    const COPY = {
      zh: {
        fourLayers: '四层口径依次核对平台报送、财务会计、增值税与出口、企业所得税。资金桥接单独核对实际与理论放款。',
        payoutDiff: '放款差额（实际 − 理论）',
        payoutDiffHelp: '正值表示实放较多，负值表示实放较少。',
        salesGap: '申报比对差额（调整后参考额 − 已申报额）',
        salesGapHelp: '正值表示参考额较高，负值表示已申报额较高。',
        assessedGauge: '本纳税年度情景估算',
        assessedGaugeHelp: '4% 核定假设 · 按主体年度核验',
        unverified: '待核实',
        nav: '财税工作台',
        title: '财税工作台',
        subtitle: 'dsh-fintax',
        tabRadar: '账单离线排雷',
        tabCalc: '14 大确定性算税',
        tabAnnual: '年度汇算与归档',
        tabSettings: 'IMA 知识库与设置',
        localPill: '本地离线初筛',
        statusReadyFile: 'IMA 知识库 · 已就绪',
        statusReadyEnv: 'IMA 知识库 · 环境变量',
        statusReadyMixed: 'IMA 知识库 · 混合凭证',
        statusMissing: '未配 IMA（排雷与 14 大算税离线可用）',
        defaultKbBound: '已绑定 ',
        defaultKbNone: '未绑定默认库',
        dropTitle: '拖入原始结算账单 / .ZIP',
        dropSub: '支持 11 大销售平台 + 6 大结汇通道 + 国内对公银行回单 · 原始明细 100% 留在本机内存',
        pickFiles: '核对我的账单 / .ZIP',
        runDemo: '经典三平台沙盒',
        runDemoV7: 'v0.7 新三平台沙盒',
        runDemoV8: '用示例看一张核对单',
        runDemoV9: '体验 v0.9 完整三段资金链（含银行回单）',
        parsing: '解析中…',
        recalcBtn: '按汇率重算总对账',
        saveFxDefault: '保存为默认汇率',
        resetFxDefault: '清除保存的汇率',
        exportHtml: '导出老板版 HTML 核对单',
        exportMd: '导出 Markdown (.md)',
        exportCsv: '导出财务待核 CSV',
        exportTrendHtml: '导出滚年趋势月报',
        declaredLabel: '已申报增值税/出口销售额（元）',
        platformAuto: '自动识别（17 通道 + 银行回单）',
        imaQuickBtn: '就地查 IMA 出处',
        imaDrawerTitle: 'IMA 法规出处轻检索',
        imaDrawerSub: '只读摘要护城河模式 · 单条严格 ≤160 字摘要，不渲染或下载全文',
        imaDrawerPlaceholder: '输入关键词（如 欧盟2欧 / FIOR / 拆单 / 810号令）',
        imaDrawerSearch: '检索出处',
        imaDrawerSearching: '检索中…',
        imaDrawerUnconfigured: '尚未配置腾讯 IMA 只读凭证。配置后可在工作台内就地核对政策出处与目录位置。',
        imaDrawerGoSettings: '前往设置页配置 IMA',
        imaDrawerEmpty: '未命中匹配摘要，请尝试缩短或更换法规关键词。',
        imaDrawerCopyAsk: '复制提问去对话',
        imaDrawerAskInChat: '在 DSH 对话中发起追问',
        imaDrawerClose: '关闭',
        annualTitle: '自然年 Q1–Q4 汇总与三地报送自检',
        annualExportHtml: '导出年度老板版 HTML',
        annualExportMd: '导出年度 Markdown',
        annualRefresh: '刷新年度数据',
        annualAllEntities: '全部主体（跨主体自动防混算）',
        annualReassignTitle: '待认领与历史归档主体重分配',
        annualReassignBtn: '认领 / 重分配',
        annualBackupTitle: '归档 JSON 安全备份与恢复',
        annualBackupExport: '一键导出备份 (.json)',
        annualBackupImport: '导入备份文件',
        dockLabel: '财税速问',
        dockTitle: '发起跨境财税政策或账单核对提问',
        updateAvailable: '发现新版本',
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
        kbDesc: '绑定默认财税库后，对话工具与侧抽屉将直查该库政策与整改 SOP，避免扫描无关库。',
        kbManualPlaceholder: '或直接输入知识库 ID（如 ima_kb_xxx）',
        kbSaveManual: '绑定 ID',
        kbClearDefault: '取消默认',
        kbSetDefault: '设为默认',
        kbCurrentBadge: '当前默认',
        kbEmptyHint: '点击上方「测试连接并刷新知识库」即可直接点选。',
        copied: '已复制 ✓',
        savedOk: '凭证已安全保存至 ~/.config/ima/',
        clearedOk: '本地凭证已清除',
        kbBoundOk: '默认知识库已更新',
      },
      en: {
        fourLayers: 'Reconcile platform reporting, financial accounting, VAT and exports, and corporate income tax. Reconcile actual and expected payouts separately.',
        payoutDiff: 'Payout difference (actual − expected)',
        payoutDiffHelp: 'Positive means paid above expected. Negative means paid below expected.',
        salesGap: 'Filing difference (adjusted reference − filed sales)',
        salesGapHelp: 'Positive means the reference is higher. Negative means filed sales are higher.',
        assessedGauge: '75M assessed revenue equivalent',
        assessedGaugeHelp: '4% assumption · net reporting estimate',
        unverified: 'Unverified',
        nav: 'FinTax Workbench',
        title: 'FinTax Workbench',
        subtitle: 'dsh-fintax',
        tabRadar: 'Statement Radar',
        tabCalc: '14 Tax Calculators',
        tabAnnual: 'Annual & Archives',
        tabSettings: 'IMA & Settings',
        localPill: 'Local Offline Audit',
        statusReadyFile: 'IMA Ready',
        statusReadyEnv: 'IMA Ready (Env)',
        statusReadyMixed: 'IMA Ready (Mixed)',
        statusMissing: 'IMA unset (offline engines ready)',
        defaultKbBound: 'KB: ',
        defaultKbNone: 'No default KB',
        dropTitle: 'Drop statements / .ZIP',
        dropSub: 'Supports 11 sales platforms + 6 settlement wallets + domestic bank receipts · 100% local in-memory parsing',
        pickFiles: 'Drop / Pick .ZIP',
        runDemo: 'Classic 3-platform demo',
        runDemoV7: 'v0.7 PayPal/AE/Shopee demo',
        runDemoV8: 'v0.8 3-stage fund chain demo',
        runDemoV9: 'Try v0.9 Full 3-Stage Chain + Bank Receipts',
        parsing: 'Parsing…',
        recalcBtn: 'Recalculate FX',
        saveFxDefault: 'Save default FX',
        resetFxDefault: 'Clear saved FX rates',
        exportHtml: 'Export HTML Report',
        exportMd: 'Export Markdown',
        exportCsv: 'Export Anomaly CSV',
        exportTrendHtml: 'Export 12M Trend HTML',
        declaredLabel: 'Declared VAT / Export Sales (CNY)',
        platformAuto: 'Auto (17 channels + bank receipts)',
        imaQuickBtn: 'Quick IMA Source',
        imaDrawerTitle: 'IMA Quick Source Drawer',
        imaDrawerSub: 'Read-only snippet mode (<=160 chars per hit; no full text or downloads)',
        imaDrawerPlaceholder: 'Search policy keywords (e.g. EU EUR 2, FIOR, 9810, DAC7)',
        imaDrawerSearch: 'Search',
        imaDrawerSearching: 'Searching…',
        imaDrawerUnconfigured: 'Tencent IMA credentials are not configured yet. Configure them in Settings to verify policy citations inline.',
        imaDrawerGoSettings: 'Open IMA Settings',
        imaDrawerEmpty: 'No matching snippets found. Try shorter keywords.',
        imaDrawerCopyAsk: 'Copy Follow-Up Prompt',
        imaDrawerAskInChat: 'Ask in DSH Chat',
        imaDrawerClose: 'Close',
        annualTitle: 'Annual Q1–Q4 Summary & 3-Jurisdiction Filing Check',
        annualExportHtml: 'Export Annual HTML',
        annualExportMd: 'Export Annual Markdown',
        annualRefresh: 'Refresh Annual View',
        annualAllEntities: 'All Entities (Cross-Entity Safeguard)',
        annualReassignTitle: 'Unclaimed & Archive Entity Reassignment',
        annualReassignBtn: 'Claim / Reassign',
        annualBackupTitle: 'Archive JSON Backup & Restore',
        annualBackupExport: 'Export Backup (.json)',
        annualBackupImport: 'Import Backup JSON',
        dockLabel: 'FinTax Ask',
        dockTitle: 'Start a cross-border tax or statement reconciliation prompt',
        updateAvailable: 'Update available',
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
        kbDesc: 'Pin your primary tax KB so ima_search and the quick drawer query it directly.',
        kbManualPlaceholder: 'Or paste KB ID (e.g. ima_kb_xxx)',
        kbSaveManual: 'Bind ID',
        kbClearDefault: 'Clear default',
        kbSetDefault: 'Set default',
        kbCurrentBadge: 'Default',
        kbEmptyHint: 'Click "Test & refresh KBs" above to pick from your IMA account.',
        copied: 'Copied ✓',
        savedOk: 'Credentials saved to ~/.config/ima/',
        clearedOk: 'Local IMA credentials cleared',
        kbBoundOk: 'Default knowledge base updated',
      },
    }

    function escHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    function normalizeLang(raw) {
      return String(raw || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh'
    }

    function getLang(ctx) {
      try {
        const snapshot = typeof ctx?.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx?.locale?.getSnapshot?.()
        const raw = snapshot?.active ?? ctx?.locale?.locale ?? document?.documentElement?.lang ?? navigator?.language ?? 'zh'
        return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    function subscribeLang(ctx, onChange) {
      const cleanups = []
      const emit = (maybeLang) => {
        try {
          const next = typeof maybeLang === 'string'
            ? normalizeLang(maybeLang)
            : typeof maybeLang?.active === 'string'
              ? normalizeLang(maybeLang.active)
              : getLang(ctx)
          onChange(next)
        } catch { /* ignore */ }
      }
      try {
        const loc = ctx?.locale
        if (typeof loc?.onLanguageChange === 'function') {
          const off = loc.onLanguageChange(emit)
          if (typeof off === 'function') cleanups.push(off)
        } else if (typeof loc?.onChange === 'function') {
          const off = loc.onChange(emit)
          if (typeof off === 'function') cleanups.push(off)
        } else if (typeof loc?.subscribe === 'function') {
          const off = loc.subscribe(emit)
          if (typeof off === 'function') cleanups.push(off)
        }
      } catch { /* host without reactive locale subscription */ }
      try {
        if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
          const obs = new MutationObserver(() => emit(document.documentElement.lang))
          obs.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
          cleanups.push(() => obs.disconnect())
        }
      } catch { /* headless / test environment without MutationObserver */ }
      return () => {
        for (const fn of cleanups) {
          try { fn() } catch { /* ignore */ }
        }
      }
    }

    // ── module: src/client/styles.js ──
    // Braun / Dieter Rams precision instrument stylesheet with light/dark skins & container queries.

    const FTX_CSS = `
          .ftx-root {
            --ftx-paper: #f4f3ed;
            --ftx-surface: #ebede2;
            --ftx-chassis: linear-gradient(118deg, #e9e9df 4%, #e2e3d9 58%, #e9e9df 100%);
            --ftx-well: linear-gradient(#e4e5d9 0%, #f3f2e6 5%, #f6f5eb 100%);
            --ftx-lcd: linear-gradient(180deg, #d3dbc4, #e2e8d5);
            --ftx-lcd-warn: linear-gradient(180deg, #f3e0d3, #f8ece3);
            --ftx-lcd-bd: #a5ac98;
            --ftx-lcd-ink: #293322;
            --ftx-ink: #242720;
            --ftx-mut: #62675d;
            --ftx-line: #cccfc2;
            --ftx-line-strong: #747a6b;
            --ftx-chassis-bd: #b1b5a8;
            --ftx-orange: #c54b1e;
            --ftx-needle: #d95122;
            --ftx-ok: #3f5e39;
            --ftx-btn-pri-bg: #393f33;
            --ftx-btn-pri-fg: #f7f7ed;
            --ftx-btn-bg: #ebede2;
            --ftx-btn-hover: #e2e5d8;
            --ftx-th-bg: #e8eae0;
            --ftx-gap-bg: #f1e7d9;
            --ftx-gap-bd: #ddc1ad;
            --ftx-gap-fg: #6f3c23;
            --ftx-input-bg: #fafaf4;
            --ftx-tick: #555950;
            --ftx-tick-warn: #a85535;
            --ftx-arc-bg: #cfcec3;
            --ftx-cap-out: #5b5b52;
            --ftx-cap-in: #c5c4b8;
            --ftx-cap-hi: #f6f5eb;
            --ftx-mono: Consolas, "Cascadia Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
            --ftx-disp: "Bahnschrift", "DIN Alternate", Consolas, ui-monospace, monospace;
            background: var(--ftx-paper);
            color: var(--ftx-ink);
            border-radius: 6px;
            -webkit-font-smoothing: antialiased;
          }
          body.dark .ftx-root, .dark .ftx-root, [data-theme="dark"] .ftx-root, body[data-ds-dark-theme] .ftx-root, [data-ds-dark-theme] .ftx-root {
            --ftx-paper: #161815;
            --ftx-surface: #20231e;
            --ftx-chassis: linear-gradient(125deg, #222620 4%, #1b1e19 58%, #222620 100%);
            --ftx-well: linear-gradient(#171a16 0%, #1d201b 10%, #1f221d 100%);
            --ftx-lcd: linear-gradient(180deg, #1b281c, #223223);
            --ftx-lcd-warn: linear-gradient(180deg, #321f18, #281914);
            --ftx-lcd-bd: #3e523d;
            --ftx-lcd-ink: #d4e8bf;
            --ftx-ink: #ecece2;
            --ftx-mut: #9ca295;
            --ftx-line: #343930;
            --ftx-line-strong: #676e60;
            --ftx-chassis-bd: #3c4237;
            --ftx-orange: #ea6b38;
            --ftx-needle: #f26c38;
            --ftx-ok: #84cc6c;
            --ftx-btn-pri-bg: #e4e5d9;
            --ftx-btn-pri-fg: #1d201a;
            --ftx-btn-bg: #232721;
            --ftx-btn-hover: #2c3129;
            --ftx-th-bg: #222620;
            --ftx-gap-bg: #2d201a;
            --ftx-gap-bd: #6b3d27;
            --ftx-gap-fg: #f3c4ab;
            --ftx-input-bg: #1c1f1a;
            --ftx-tick: #8f9688;
            --ftx-tick-warn: #ea6b38;
            --ftx-arc-bg: #3e443a;
            --ftx-cap-out: #8e9487;
            --ftx-cap-in: #2f332c;
            --ftx-cap-hi: #e9e9df;
          }
          .ftx-root * { box-sizing: border-box; }
          .ftx-host-wrap { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow-x: hidden; }
          .ftx-root { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow-x: hidden; container-type: inline-size; container-name: ftx; position: relative; }
          .ftx-mono { font-family: var(--ftx-mono); font-variant-numeric: tabular-nums; }
          .ftx-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px 12px; min-width: 0; max-width: 100%; }
          .ftx-h1 { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; font-size: 24px; font-weight: 700; letter-spacing: -0.8px; margin: 0; line-height: 1.25; min-width: 0; }
          .ftx-h1 span { font: 12.5px var(--ftx-mono); color: var(--ftx-mut); letter-spacing: 0; font-weight: 500; }
          .ftx-kb-pill { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-width: 0; border: 1px solid var(--ftx-chassis-bd); border-radius: 4px; padding: 6px 11px; font-size: 12px; color: var(--ftx-ink); background: var(--ftx-surface); }
          .ftx-kb-pill-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
          .ftx-kb-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
          .ftx-upd-pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--ftx-orange); border-radius: 4px; padding: 4px 9px; font: 600 11px var(--ftx-mono); color: var(--ftx-orange); background: var(--ftx-gap-bg); }
          .ftx-tabs { display: flex; align-items: stretch; flex-wrap: wrap; gap: 4px 20px; border-bottom: 1px solid var(--ftx-chassis-bd); min-width: 0; max-width: 100%; }
          .ftx-tab { position: relative; padding: 10px 2px 11px; font-size: 13.5px; font-weight: 500; color: var(--ftx-mut); background: transparent; border: none; cursor: pointer; transition: color 0.15s; white-space: nowrap; }
          .ftx-tab:hover { color: var(--ftx-ink); }
          .ftx-tab.is-active { color: var(--ftx-ink); font-weight: 700; }
          .ftx-tab.is-active::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 3px; background: var(--ftx-ink); }
          .ftx-local-tag { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--ftx-mut); padding: 8px 0; white-space: nowrap; }
          .ftx-local-tag i { width: 7px; height: 7px; border: 1.2px solid var(--ftx-mut); border-radius: 50%; display: inline-block; flex-shrink: 0; }
          .ftx-instrument {
            display: grid; grid-template-columns: minmax(0, 44.5%) minmax(0, 55.5%);
            width: 100%; max-width: 100%;
            background: var(--ftx-chassis); border: 1px solid var(--ftx-chassis-bd); border-radius: 7px;
            box-shadow: inset 0 1px rgba(255,255,246,0.55), 0 2px 5px rgba(45,50,38,0.12);
            position: relative;
          }
          @container ftx (max-width: 960px) { .ftx-instrument { grid-template-columns: minmax(0, 1fr); } .ftx-inst-left { border-right: none !important; border-bottom: 1px solid var(--ftx-line); } }
          @media (max-width: 960px) { .ftx-instrument { grid-template-columns: minmax(0, 1fr); } .ftx-inst-left { border-right: none !important; border-bottom: 1px solid var(--ftx-line); } }
          .ftx-screw { position: absolute; width: 9px; height: 9px; border-radius: 50%; background: linear-gradient(135deg, #fbfbf1, #9fa495); border: 1px solid #9ea395; pointer-events: none; z-index: 2; }
          .ftx-screw::after { content: ""; position: absolute; height: 1px; left: 1px; right: 1px; top: 3.5px; background: #6d7265; transform: rotate(-38deg); }
          .ftx-screw.tl { top: 8px; left: 8px; } .ftx-screw.tr { top: 8px; right: 8px; } .ftx-screw.bl { bottom: 8px; left: 8px; } .ftx-screw.br { bottom: 8px; right: 8px; }
          .ftx-inst-left, .ftx-inst-right { min-width: 0; max-width: 100%; padding: 15px 19px 14px; display: flex; flex-direction: column; }
          .ftx-inst-left { border-right: 1px solid var(--ftx-chassis-bd); }
          .ftx-inst-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; font-size: 14px; font-weight: 700; gap: 6px 8px; min-width: 0; }
          .ftx-inst-head small { color: var(--ftx-mut); font: 10.5px var(--ftx-mono); letter-spacing: 1.1px; }
          .ftx-lcd { margin: 11px 0 13px; padding: 14px 16px 12px; border: 1px solid var(--ftx-lcd-bd); border-radius: 3px; background: var(--ftx-lcd); box-shadow: inset 0 2px 5px rgba(70,84,52,0.22); min-width: 0; }
          .ftx-lcd.warn { background: var(--ftx-lcd-warn); border-color: var(--ftx-gap-bd); }
          .ftx-lcd-lbl { font-size: 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ftx-lcd-ink); opacity: 0.78; }
          .ftx-lcd-big { margin-top: 3px; font: 600 clamp(32px, 5.2cqi, 54px)/1.08 var(--ftx-disp); font-variant-numeric: tabular-nums; letter-spacing: -1.6px; color: var(--ftx-lcd-ink); word-break: break-all; }
          .ftx-lcd-big .unit { font-size: 0.64em; vertical-align: 4px; margin-right: 4px; font-weight: 400; }
          .ftx-metrics { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
          .ftx-metrics > div { min-width: 0; }
          .ftx-metrics > div + div { padding-left: 12px; border-left: 1px solid var(--ftx-line); }
          .ftx-metrics label { font-size: 11.5px; color: var(--ftx-mut); display: block; margin-bottom: 3px; }
          .ftx-metrics b { font: 600 clamp(17px, 2.8cqi, 24px)/1.1 var(--ftx-mono); letter-spacing: -0.6px; word-break: break-all; }
          .ftx-scan { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; border-top: 1px solid var(--ftx-line); margin-top: auto; padding-top: 11px; color: var(--ftx-mut); font-size: 11.5px; min-width: 0; }
          .ftx-scan .probe { width: 6px; height: 6px; border-radius: 50%; background: var(--ftx-ok); flex-shrink: 0; }
          .ftx-scan .vsep { height: 10px; width: 1px; background: var(--ftx-line); }
          .ftx-meters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); margin-top: 10px; border-radius: 4px; border: 1px solid var(--ftx-chassis-bd); background: var(--ftx-well); box-shadow: inset 0 2px 4px rgba(80,86,72,0.14); width: 100%; max-width: 100%; }
          @container ftx (max-width: 440px) { .ftx-meters { grid-template-columns: minmax(0, 1fr); } .ftx-gauge + .ftx-gauge { border-left: none !important; border-top: 1px solid var(--ftx-line); } }
          @media (max-width: 440px) { .ftx-meters { grid-template-columns: minmax(0, 1fr); } .ftx-gauge + .ftx-gauge { border-left: none !important; border-top: 1px solid var(--ftx-line); } }
          .ftx-gauge { min-width: 0; text-align: center; display: flex; flex-direction: column; align-items: center; padding: 12px 6px 10px; }
          .ftx-gauge + .ftx-gauge { border-left: 1px solid var(--ftx-line); }
          .ftx-ghead { font-size: 12.5px; font-weight: 650; display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 6px; align-items: center; line-height: 1.3; }
          .ftx-ghead span { font: 10px var(--ftx-mono); color: var(--ftx-mut); border: 1px solid var(--ftx-line); padding: 0 4px; border-radius: 2px; flex-shrink: 0; }
          .ftx-meter { width: 100%; max-width: 210px; height: auto; aspect-ratio: 220 / 132; margin-top: -2px; display: block; }
          .ftx-tick { stroke: var(--ftx-tick); } .ftx-tick-warn { stroke: var(--ftx-tick-warn); }
          .ftx-arc-bg { stroke: var(--ftx-arc-bg); } .ftx-arc-warn { stroke: var(--ftx-orange); }
          .ftx-dial-lbl { fill: var(--ftx-mut); font-family: var(--ftx-mono); }
          .ftx-gval { margin-top: -6px; font: 700 clamp(18px, 2.8cqi, 22px)/1.1 var(--ftx-mono); letter-spacing: -0.8px; }
          .ftx-gfoot { font-size: 10.5px; color: var(--ftx-mut); margin-top: 2px; line-height: 1.35; padding: 0 4px; }
          .ftx-gfoot i { font-style: normal; color: var(--ftx-orange); }
          .ftx-lower { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 18px; width: 100%; max-width: 100%; }
          .ftx-block { border-top: 2px solid var(--ftx-line-strong); padding-top: 13px; min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 10px; }
          .ftx-bhead { display: flex; align-items: center; justify-content: space-between; gap: 8px 10px; flex-wrap: wrap; min-width: 0; }
          .ftx-bhead h2 { font-size: 18px; font-weight: 700; letter-spacing: -0.4px; margin: 0; }
          .ftx-secmeta { font: 10px var(--ftx-mono); color: var(--ftx-mut); letter-spacing: 0.9px; }
          .ftx-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
          .ftx-tbl th { font-size: 11px; color: var(--ftx-mut); padding: 7px 8px; font-weight: 600; background: var(--ftx-th-bg); text-align: right; white-space: nowrap; }
          .ftx-tbl th:first-child, .ftx-tbl td:first-child { text-align: left; }
          .ftx-tbl td { padding: 10px 8px; border-bottom: 1px solid var(--ftx-line); font-family: var(--ftx-mono); text-align: right; white-space: nowrap; vertical-align: middle; }
          .ftx-tbl tr:hover td { background: color-mix(in srgb, currentColor 3.5%, transparent); }
          .ftx-tbl strong { font-family: inherit; font-weight: 700; font-size: 13px; }
          .ftx-gap { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; border: 1px solid var(--ftx-gap-bd); color: var(--ftx-gap-fg); background: var(--ftx-gap-bg); padding: 9px 12px; border-radius: 3px; min-width: 0; max-width: 100%; }
          .ftx-gap .att { display: inline-grid; place-items: center; color: #fff7e9; background: var(--ftx-orange); border-radius: 3px; width: 19px; height: 19px; font: 700 13px var(--ftx-mono); flex-shrink: 0; }
          .ftx-gap b { font: 700 21px/1 var(--ftx-mono); color: var(--ftx-orange); letter-spacing: -0.6px; }
          .ftx-risk-list { display: flex; flex-direction: column; min-width: 0; max-height: 225px; overflow-y: auto; }
          .ftx-risk-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) fit-content(42%); align-items: start; gap: 10px; padding: 9px 2px; border-bottom: 1px solid var(--ftx-line); font-size: 12.8px; }
          .ftx-risk-row > div, .ftx-hist-text, .ftx-gap > span { min-width: 0; overflow-wrap: anywhere; }
          .ftx-risk-action { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
          .ftx-risk-action > * { max-width: 100%; }
          .ftx-hist-entity { min-width: 0; max-width: 100%; height: auto !important; white-space: normal; overflow-wrap: anywhere; }
          @container ftx (max-width: 440px) { .ftx-risk-row { grid-template-columns: 30px minmax(0, 1fr); } .ftx-risk-action { grid-column: 2; flex-direction: row; align-items: center; flex-wrap: wrap; } }
          .ftx-sev { display: inline-grid; place-items: center; font: 600 10.5px var(--ftx-mono); height: 20px; border-radius: 2px; width: 28px; background: var(--ftx-th-bg); color: var(--ftx-mut); border: 1px solid var(--ftx-line); margin-top: 1px; }
          .ftx-sev.p0 { background: var(--ftx-orange); border-color: var(--ftx-orange); color: #fff8e9; }
          .ftx-sev.p1 { background: var(--ftx-gap-bg); border-color: var(--ftx-gap-bd); color: var(--ftx-gap-fg); }
          .ftx-sev.ok { background: var(--ftx-lcd); border-color: var(--ftx-lcd-bd); color: var(--ftx-ok); }
          .ftx-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 175px), 1fr)); gap: 9px; border-top: 1px solid var(--ftx-chassis-bd); padding-top: 14px; width: 100%; max-width: 100%; }
          .ftx-act { height: 44px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--ftx-chassis-bd); border-radius: 4px; background: var(--ftx-btn-bg); color: var(--ftx-ink); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background 0.14s, border-color 0.14s, transform 0.12s; min-width: 0; max-width: 100%; }
          @container ftx (max-width: 620px) { .ftx-inst-left, .ftx-inst-right { padding: 13px 14px 12px; } .ftx-h1 { font-size: 20px; } }
          .ftx-act:hover:not(:disabled) { background: var(--ftx-btn-hover); transform: translateY(-0.5px); }
          .ftx-act:disabled { opacity: 0.5; cursor: not-allowed; }
          .ftx-act.pri { background: var(--ftx-btn-pri-bg); color: var(--ftx-btn-pri-fg); border-color: var(--ftx-btn-pri-bg); }
          .ftx-act.pri:hover:not(:disabled) { background: var(--ftx-btn-pri-bg); filter: brightness(1.12); }
          .ftx-act.drop { border-style: dashed; background: var(--ftx-paper); }
          .ftx-act.drop.is-drag { border-color: var(--ftx-orange); background: var(--ftx-gap-bg); }
          .ftx-btn-sm { padding: 5px 10px; border-radius: 3px; border: 1px solid var(--ftx-chassis-bd); background: var(--ftx-btn-bg); color: var(--ftx-ink); font-size: 11.8px; font-weight: 600; cursor: pointer; transition: all 0.14s; }
          .ftx-btn-sm:hover:not(:disabled) { background: var(--ftx-btn-hover); }
          .ftx-btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
          .ftx-btn-sm.on { background: var(--ftx-btn-pri-bg); color: var(--ftx-btn-pri-fg); border-color: var(--ftx-btn-pri-bg); }
          .ftx-btn-sm.danger { color: var(--ftx-orange); border-color: var(--ftx-gap-bd); background: transparent; }
          .ftx-input { padding: 7px 10px; border-radius: 3px; border: 1px solid var(--ftx-chassis-bd); background: var(--ftx-input-bg); color: var(--ftx-ink); font-size: 13px; font-family: var(--ftx-mono); outline: none; max-width: 100%; min-width: 0; }
          .ftx-input:focus { border-color: var(--ftx-orange); box-shadow: 0 0 0 2px rgba(197,75,30,0.18); }
          .ftx-panel { background: var(--ftx-chassis); border: 1px solid var(--ftx-chassis-bd); border-radius: 6px; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
          .ftx-nav-btn { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 6px; text-align: left; padding: 8.5px 11px; border: none; border-radius: 3px; background: transparent; color: var(--ftx-ink); font-size: 12.8px; font-weight: 500; cursor: pointer; }
          .ftx-nav-btn:hover { background: var(--ftx-btn-hover); }
          .ftx-nav-btn.is-active { background: var(--ftx-btn-pri-bg); color: var(--ftx-btn-pri-fg); font-weight: 650; }
          .ftx-adapters { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 8px 10px; border-radius: 4px; background: var(--ftx-surface); border: 1px solid var(--ftx-line); font: 11px var(--ftx-mono); color: var(--ftx-mut); }
          .ftx-adp { display: inline-flex; align-items: center; gap: 5px; }
          .ftx-adp i { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--ftx-mut); display: inline-block; }
          .ftx-adp.used { color: var(--ftx-ink); font-weight: 700; }
          .ftx-adp.used i { background: var(--ftx-orange); border-color: var(--ftx-orange); }
          .ftx-adp.wallet.used i { background: var(--ftx-ok); border-color: var(--ftx-ok); }
          .ftx-adp.bank.used i { background: var(--ftx-ink); border-color: var(--ftx-ink); }
          .ftx-chain { background: var(--ftx-chassis); border: 1px solid var(--ftx-chassis-bd); border-radius: 6px; padding: 14px 18px; display: flex; flex-direction: column; gap: 11px; }
          .ftx-chain-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 175px), 1fr)); gap: 10px; }
          .ftx-chain-cell { background: var(--ftx-surface); border: 1px solid var(--ftx-line); border-radius: 4px; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
          .ftx-chain-cell.ok { border-color: var(--ftx-ok); }
          .ftx-chain-cell.danger { border-color: var(--ftx-orange); background: var(--ftx-gap-bg); }
          .ftx-tag-w { display: inline-block; font: 600 10px var(--ftx-mono); padding: 1px 5px; border-radius: 2px; background: var(--ftx-th-bg); color: var(--ftx-ok); border: 1px solid var(--ftx-line); margin-left: 5px; vertical-align: middle; }
          .ftx-tag-b { display: inline-block; font: 600 10px var(--ftx-mono); padding: 1px 5px; border-radius: 2px; background: var(--ftx-lcd); color: var(--ftx-lcd-ink); border: 1px solid var(--ftx-lcd-bd); margin-left: 5px; vertical-align: middle; }
          .ftx-stage3-panel { border: 1px solid var(--ftx-line-strong); border-radius: 5px; padding: 12px 14px; background: var(--ftx-paper); display: flex; flex-direction: column; gap: 10px; }
          .ftx-stage3-cand { border: 1px dashed var(--ftx-gap-bd); border-radius: 4px; padding: 9px 11px; background: var(--ftx-surface); display: flex; flex-direction: column; gap: 6px; }
          .ftx-juris-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }
          .ftx-juris-card { background: var(--ftx-surface); border: 1px solid var(--ftx-chassis-bd); border-radius: 5px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
          .ftx-juris-card.danger { border-color: var(--ftx-orange); background: var(--ftx-gap-bg); }
          .ftx-juris-card.ok { border-color: var(--ftx-ok); }
          .ftx-month-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(56px, 1fr)); gap: 5px; }
          .ftx-month-pill { padding: 5px 4px; text-align: center; border-radius: 3px; border: 1px solid var(--ftx-line); font: 600 11px var(--ftx-mono); background: var(--ftx-surface); color: var(--ftx-mut); }
          .ftx-month-pill.rec { background: var(--ftx-lcd); border-color: var(--ftx-lcd-bd); color: var(--ftx-lcd-ink); }
          .ftx-month-pill.miss { border-style: dashed; border-color: var(--ftx-gap-bd); color: var(--ftx-orange); background: var(--ftx-gap-bg); }
          .ftx-drawer-backdrop { position: fixed; inset: 0; background: rgba(20, 22, 18, 0.36); z-index: 9998; display: flex; justify-content: flex-end; }
          .ftx-drawer { width: min(100%, 440px); height: 100%; background: var(--ftx-paper); color: var(--ftx-ink); border-left: 1px solid var(--ftx-chassis-bd); box-shadow: -8px 0 24px rgba(0,0,0,0.22); padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; z-index: 9999; }
          .ftx-drawer-hit { background: var(--ftx-surface); border: 1px solid var(--ftx-line); border-radius: 4px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
          .ftx-calc-compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 175px), 1fr)); gap: 9px; }
          .ftx-dock-btn { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 4px; border: 1px solid currentColor; background: transparent; color: inherit; font-size: 12px; font-weight: 600; cursor: pointer; opacity: 0.86; }
          .ftx-dock-btn:hover { opacity: 1; }
        `

    function retainStyles() {
      if (typeof document === 'undefined') return
      const id = 'dsh-fintax-styles'
      let el = document.getElementById(id)
      if (!el) {
        el = document.createElement('style')
        el.id = id
        el.textContent = FTX_CSS
        document.head.appendChild(el)
      }
      el.dataset.ftxUsers = String(Number(el.dataset.ftxUsers || 0) + 1)
      return () => {
        const remaining = Number(el.dataset.ftxUsers) - 1
        if (remaining <= 0) el.remove()
        else el.dataset.ftxUsers = String(remaining)
      }
    }

    // ── module: src/client/api.js ──
    // API transport, request deduplication hook, file encoders, and passive dsh-market Update API v1 probe.

    function useLatestRequest() {
      const state = useRef({ version: 0, controller: null })
      const invalidate = useCallback(() => {
        state.current.version++
        state.current.controller?.abort()
        state.current.controller = null
      }, [])
      useEffect(() => invalidate, [invalidate])
      const start = useCallback(() => {
        invalidate()
        const version = state.current.version
        const controller = new AbortController()
        state.current.controller = controller
        return {
          signal: controller.signal,
          isCurrent: () => state.current.version === version,
        }
      }, [invalidate])
      return [start, invalidate]
    }

    const API_BASE = (() => {
      try { return new URL('api/fintax', document.baseURI).pathname } catch { return '/api/fintax' }
    })()

    // 仅保存在客户端工作台闭包内存中的 128-bit 会话随机标识与服务端 HMAC 会话断言（严禁写入 localStorage / Cookie）
    const CLIENT_SESSION_ID = (() => {
      try {
        const bytes = new Uint8Array(16)
        if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
          globalThis.crypto.getRandomValues(bytes)
          return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
        }
      } catch { /* fallback for non-WebCrypto VM test sandboxes */ }
      let hex = ''
      for (let i = 0; i < 4; i++) {
        const chunk = ((Math.random() * 0xffffffff) >>> 0) ^ (((Date.now() + i * 0x9e3779b9) & 0xffffffff) >>> 0)
        hex += (chunk >>> 0).toString(16).padStart(8, '0')
      }
      return hex
    })()
    let sessionAssertion = ''

    async function callApi(path, options = {}) {
      const { timeout = 25000, signal, ...rest } = options
      const ctrl = new AbortController()
      const abort = () => ctrl.abort()
      signal?.throwIfAborted()
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const res = await fetch(`${API_BASE}${path}`, {
          ...rest,
          headers: {
            'content-type': 'application/json',
            'x-fintax-client-session': CLIENT_SESSION_ID,
            ...(sessionAssertion ? { 'x-fintax-session-assertion': sessionAssertion } : {}),
            ...(rest.headers || {}),
          },
          redirect: 'error',
          signal: ctrl.signal,
        })
        try {
          const nextAssertion = res?.headers?.get?.('x-fintax-session-assertion')
          if (typeof nextAssertion === 'string' && nextAssertion.trim()) {
            sessionAssertion = nextAssertion.trim()
          }
        } catch { /* ignore mock Response without headers */ }
        const txt = await res.text()
        let json = {}
        try { json = txt ? JSON.parse(txt) : {} } catch { throw new Error(`服务响应格式无效（HTTP ${res.status}）`) }
        if (!res.ok) {
          const apiErr = new Error(json?.message || json?.error || `HTTP ${res.status}`)
          apiErr.status = res.status
          apiErr.data = json
          throw apiErr
        }
        return json
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }

    function fileToBase64(file, signal) {
      return new Promise((resolve, reject) => {
        signal.throwIfAborted()
        const reader = new FileReader()
        const abort = () => reader.abort()
        signal.addEventListener('abort', abort, { once: true })
        reader.onloadend = () => signal.removeEventListener('abort', abort)
        reader.onload = () => {
          const raw = String(reader.result || '')
          const idx = raw.indexOf(',')
          resolve(idx >= 0 ? raw.slice(idx + 1) : raw)
        }
        reader.onabort = () => reject(signal.reason || new Error('读取已取消'))
        reader.onerror = () => reject(new Error('读取账单文件失败'))
        reader.readAsDataURL(file)
      })
    }

    function readTextFile(file, signal) {
      return new Promise((resolve, reject) => {
        if (typeof file?.text === 'function') {
          file.text().then(resolve, reject)
          return
        }
        if (signal?.aborted) {
          reject(signal.reason || new Error('读取已取消'))
          return
        }
        const reader = new FileReader()
        const abort = () => reader.abort()
        signal?.addEventListener('abort', abort, { once: true })
        reader.onloadend = () => signal?.removeEventListener('abort', abort)
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onabort = () => reject(signal?.reason || new Error('读取已取消'))
        reader.onerror = () => reject(new Error('读取备份文件失败'))
        if (typeof reader.readAsText === 'function') reader.readAsText(file)
        else reader.readAsDataURL(file)
      })
    }

    function numericFxRates(draft) {
      const rates = {}
      for (const [currency, value] of Object.entries(draft || {})) {
        const raw = String(value).trim()
        const amount = Number(raw)
        if (raw && Number.isFinite(amount) && amount > 0) rates[currency] = raw
      }
      return rates
    }

    function money(value) {
      return value == null ? '待核' : `¥${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    }

    function downloadText(content, filename, mime) {
      if (typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function' || typeof document === 'undefined') return
      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body?.appendChild?.(a)
      a.click?.()
      document.body?.removeChild?.(a)
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    }

    function compareSemver(a, b) {
      const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
      const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return 1
        if ((pa[i] || 0) < (pb[i] || 0)) return -1
      }
      return 0
    }

    const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

    /**
     * Passive, read-only probe against dsh-market Update API v1.
     * Validates explicit protocol fields (capabilities object, non-empty version/apiVersion, or catalog list)
     * so an empty `{}` or non-market JSON response is never misclassified as supported/up-to-date.
     */
    async function probeMarketUpdate(currentVersion, signal) {
      const ctrl = new AbortController()
      const abort = () => ctrl.abort()
      if (signal?.aborted) return null
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => ctrl.abort(), 3500)
      try {
        let url = '/dsh-market/api/v1/capabilities'
        try { url = new URL('/dsh-market/api/v1/capabilities', document.baseURI).pathname } catch { /* fallback */ }
        const res = await fetch(url, { method: 'GET', redirect: 'error', signal: ctrl.signal })
        if (!res.ok) return null
        const data = await res.json()
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null
        const hasCapabilitiesObj = Boolean(data.capabilities && typeof data.capabilities === 'object' && !Array.isArray(data.capabilities))
        const hasProtocolVersion = (typeof data.version === 'string' && data.version.trim().length > 0) ||
          (typeof data.apiVersion === 'string' && data.apiVersion.trim().length > 0)
        const hasCatalog = Array.isArray(data.plugins) || Array.isArray(data.updates) ||
          Boolean(data.packages && typeof data.packages === 'object' && !Array.isArray(data.packages))
        if (!hasCapabilitiesObj && !hasProtocolVersion && !hasCatalog) return null
        const plugins = Array.isArray(data.plugins) ? data.plugins : Array.isArray(data.updates) ? data.updates : []
        const match = plugins.find((p) => p?.id === 'dsh-fintax' || p?.name === 'dsh-fintax') || data.packages?.['dsh-fintax'] || null
        const rawLatest = match?.latestVersion || match?.version || (typeof data.latestVersion === 'string' ? data.latestVersion : null)
        const latestVersion = typeof rawLatest === 'string' && SEMVER_RE.test(rawLatest.trim()) ? rawLatest.trim().replace(/^v/i, '') : null
        const hasUpdate = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0)
        return {
          supported: true,
          latestVersion,
          versionChecked: Boolean(latestVersion),
          hasUpdate,
          notes: typeof match?.summary === 'string' ? match.summary : (typeof match?.releaseNotes === 'string' ? match.releaseNotes : ''),
        }
      } catch {
        return null
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }

    // ── module: src/client/components.js ──
    // Reusable vector marks, Braun dual-needle DialGauge, and fail-closed CoverageDetails.


    function FinTaxMark({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 3.5, y: 4, width: 17, height: 16, rx: 2 }),
        h('path', { d: 'm6.8 14 3.7-3.5 3 2 4-5M7 17h10' }),
      )
    }

    function Icon({ kind, size = 15 }) {
      const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0 } }
      if (kind === 'book') return h('svg', p, h('path', { d: 'M3.5 4.5c3.4-1.1 6.1-.4 8.5 1.3 2.6-1.7 5-2.3 8.5-1.3v14c-2.9-.8-5.7-.5-8.5 1.4-2.8-1.9-5.6-2.2-8.5-1.4zM12 6v14' }))
      if (kind === 'upload') return h('svg', p, h('path', { d: 'M12 16V3m-4.5 4.5L12 3l4.5 4.5M4 14v6h16v-6' }))
      if (kind === 'download') return h('svg', p, h('path', { d: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4' }))
      if (kind === 'arrow') return h('svg', p, h('path', { d: 'M3 12h16m-6-6 6 6-6 6' }))
      if (kind === 'chip') return h('svg', p, h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }), h('rect', { x: 8, y: 8, width: 8, height: 8 }), h('path', { d: 'M8 2v2m8-2v2M8 20v2m8-2v2M2 8h2m-2 8h2m16-8h2m-2 8h2' }))
      if (kind === 'check') return h('svg', p, h('path', { d: 'm5 12 4 4L19 6' }))
      if (kind === 'search') return h('svg', p, h('circle', { cx: 11, cy: 11, r: 7 }), h('path', { d: 'm20 20-3.8-3.8' }))
      if (kind === 'calendar') return h('svg', p, h('rect', { x: 3.5, y: 5, width: 17, height: 15, rx: 2 }), h('path', { d: 'M8 3v4m8-4v4M3.5 10h17' }))
      if (kind === 'close') return h('svg', p, h('path', { d: 'M6 6l12 12M18 6 6 18' }))
      return h('svg', p, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 8v4l2.5 2' }))
    }

    /** Dieter Rams precision analog dial gauge (101 ticks, warning red arc, animated signal-orange needle). */
    function DialGauge({ code, title, pct, warnPct = 73.3, footNote, subNote }) {
      const clamped = Math.max(0, Math.min(100, Number(pct) || 0))
      const cx = 119
      const cy = 102
      const rOuter = 82
      const startDeg = -109
      const sweepDeg = 218
      const toRad = (deg) => ((deg - 90) * Math.PI) / 180
      const pt = (deg, rad) => [cx + rad * Math.cos(toRad(deg)), cy + rad * Math.sin(toRad(deg))]

      const [sx, sy] = pt(startDeg, rOuter)
      const [ex, ey] = pt(startDeg + sweepDeg, rOuter)
      const warnDeg = startDeg + (warnPct / 100) * sweepDeg
      const [wx, wy] = pt(warnDeg, rOuter)
      const warnLargeArc = sweepDeg * (1 - warnPct / 100) > 180 ? 1 : 0

      const ticks = []
      for (let i = 0; i <= 100; i++) {
        const deg = startDeg + (i / 100) * sweepDeg
        const isMajor = i % 10 === 0
        const isMid = !isMajor && i % 5 === 0
        const r1 = rOuter - 4
        const r2 = r1 - (isMajor ? 11.5 : isMid ? 8.2 : 5.2)
        const [x1, y1] = pt(deg, r1)
        const [x2, y2] = pt(deg, r2)
        const inWarn = i >= warnPct
        ticks.push(
          h('line', {
            key: `t${i}`,
            x1: x1.toFixed(2),
            y1: y1.toFixed(2),
            x2: x2.toFixed(2),
            y2: y2.toFixed(2),
            className: inWarn ? 'ftx-tick-warn' : 'ftx-tick',
            strokeWidth: isMajor || isMid ? 1.3 : 0.8,
          }),
        )
      }

      const labels = [0, 20, 40, 60, 80, 100].map((v) => {
        const deg = startDeg + (v / 100) * sweepDeg
        const [lx, ly] = pt(deg, 57)
        return h('text', { key: `l${v}`, x: lx.toFixed(1), y: (ly + 3.2).toFixed(1), textAnchor: 'middle', fontSize: 9.2, className: 'ftx-dial-lbl' }, String(v))
      })

      const needleAngle = startDeg + (clamped / 100) * sweepDeg

      return h(
        'div',
        { className: 'ftx-gauge' },
        h('div', { className: 'ftx-ghead' }, h('span', null, code), title),
        h(
          'svg',
          { viewBox: '0 0 238 145', className: 'ftx-meter', role: 'img', 'aria-label': `${title} ${clamped.toFixed(2)}%` },
          h('path', { d: `M${sx.toFixed(2)} ${sy.toFixed(2)} A${rOuter} ${rOuter} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`, fill: 'none', className: 'ftx-arc-bg', strokeWidth: 1.1 }),
          h('path', { d: `M${wx.toFixed(2)} ${wy.toFixed(2)} A${rOuter} ${rOuter} 0 ${warnLargeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`, fill: 'none', className: 'ftx-arc-warn', strokeWidth: 2.4 }),
          ...ticks,
          ...labels,
          h(
            'g',
            { style: { transformOrigin: `${cx}px ${cy}px`, transform: `rotate(${needleAngle.toFixed(2)}deg)`, transition: 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)' } },
            h('path', { d: `M${cx - 1.5} ${cy + 10} L${cx - 1.8} ${cy - 2} L${cx} ${cy - 74} L${cx + 2.1} ${cy - 2} L${cx + 2} ${cy + 10} Z`, transform: 'translate(0.9 1.3)', fill: 'rgba(90,82,68,0.28)' }),
            h('path', { d: `M${cx - 2.3} ${cy + 12} L${cx - 1.7} ${cy - 2} L${cx} ${cy - 75} L${cx + 1.7} ${cy - 2} L${cx + 2.3} ${cy + 12} Z`, fill: 'var(--ftx-needle)' }),
          ),
          h('circle', { cx, cy, r: 7, fill: 'var(--ftx-cap-out)' }),
          h('circle', { cx, cy, r: 4, fill: 'var(--ftx-cap-in)' }),
          h('circle', { cx: cx - 1, cy: cy - 1, r: 1.2, fill: 'var(--ftx-cap-hi)' }),
        ),
        h('div', { className: 'ftx-gval', style: clamped >= warnPct ? { color: 'var(--ftx-orange)' } : undefined }, `${Number(pct || 0).toFixed(2)}%`),
        h('div', { className: 'ftx-gfoot' }, h('i', null, footNote), subNote ? ` · ${subNote}` : ''),
      )
    }

    function CoverageDetails({ coverage }) {
      const index = (value) => Number.isSafeInteger(value) && value > 0
      const lines = []
      for (const file of coverage?.files || []) {
        if (file.status === 'parsed' || !index(file.fileIndex)) continue
        const diagnostics = file.diagnostics?.length ? file.diagnostics : [{ code: file.code }]
        for (const detail of diagnostics) {
          const location = [
            `第 ${file.fileIndex} 份账单`,
            index(detail.entryIndex) && `ZIP 条目 ${detail.entryIndex}`,
            index(detail.sheetIndex) && `工作表 ${detail.sheetIndex}`,
          ].filter(Boolean).join(' / ')
          const candidates = (detail.candidates || []).filter(
            (name) => ADAPTERS.includes(name) || WALLET_ADAPTERS.includes(name) || BANK_ADAPTERS.includes(name),
          )
          const rows = (detail.candidateRows || []).map((row) => (typeof row === 'number' ? row : row?.row)).filter(index)
          const label = DIAGNOSTIC_LABELS.get(detail.code) || '解析待核'
          lines.push(`${location} · ${label}${candidates.length ? `（${candidates.join('、')}）` : ''}${rows.length ? ` · 待核行 ${rows.join('、')}` : ''}`)
        }
      }
      if (!lines.length) return null
      return h(
        'details',
        { className: 'ftx-hist-text', style: { fontSize: 12, color: 'var(--ftx-gap-fg)' } },
        h('summary', { style: { cursor: 'pointer' } }, `查看 ${lines.length} 项解析待核位置`),
        h(
          'ul',
          { style: { margin: '5px 0', paddingInlineStart: 20, maxHeight: 160, overflowY: 'auto' } },
          ...lines.map((line, i) => h('li', { key: i }, line)),
        ),
      )
    }

    // ── module: src/client/calc_specs_base.js ──
    // Core 11 deterministic tax calculator scenario specs (v0.7-v0.8.6 baseline).

    const BASE_CALC_SCENARIOS = [
      {
        code: 'platform_tax_reconcile', group: 'audit', zh: '平台报送四层口径桥接', en: '4-Layer Platform Tax Bridge',
        imaKeywords: ['810号令', '四层口径', '平台报送', '总额法'],
        fields: [
          { key: 'reportedGrossRevenue', label: '平台报送总额或账单参考毛额（元）', def: '6000000' },
          { key: 'reportedGrossSource', label: '报送金额来源', type: 'select', def: 'platform', options: [{ value: 'platform', label: '平台实际报送数据' }, { value: 'statement_reference', label: '根据账单推算的参考额' }] },
          { key: 'refunds', label: '当期客户退款（元）', def: '450000' },
          { key: 'accountingRevenue', label: '会计确认收入（元，可选）', def: '' },
          { key: 'declaredVatSales', label: '增值税与出口已申报销售额（元，可选）', def: '4200000' },
          { key: 'citTaxableIncome', label: '企业所得税应纳税所得额（元，可选）', def: '' },
          { key: 'marketplaceWithheldTax', label: '商城代扣境外流转税（元）', def: '350000' },
          { key: 'cutoffAndFxDiff', label: '跨期与汇率折算差（正调减/负调增）', def: '400000' },
          { key: 'platformFees', label: '平台佣金与履约费（元）', def: '600000' },
          { key: 'actualPayout', label: '平台放款净额（元，可选）', def: '' },
        ],
        advancedFields: [
          { key: 'subsidies', label: '平台出资补贴/赔付（元）', def: '0' },
          { key: 'refundReversal', label: '客户退款冲回（元）', def: '0' },
          { key: 'platformFeeRebate', label: '平台手续费返还（元）', def: '0' },
          { key: 'subsidyReversal', label: '平台补贴/赔付冲回（元）', def: '0' },
          { key: 'subsidiesIncludedInGross', label: '上述毛额已含本次填写的补贴', type: 'bool', def: true },
          { key: 'withheldTaxIncludedInGross', label: '上述毛额已含本次填写的境外代扣税', type: 'bool', def: true },
          { key: 'selfRemitTaxNet', label: '非代扣待自申报税净额（元）', def: '0' },
          { key: 'reserveChange', label: '准备金净变动（+冻结/-释放）', def: '0' },
          { key: 'principalRole', label: '会计主体责任角色', type: 'select', def: 'principal', options: [{ value: 'principal', label: '主要责任人（总额法）' }, { value: 'agent', label: '代理人（净额法）' }] },
        ],
      },
      {
        code: 'vat_taxpayer_threshold', group: 'audit', zh: '500 万一般纳税人临界拐点', en: '5M General Taxpayer Cliff',
        desc: '核对年应征增值税销售额、一般纳税人登记与小规模月／季起征点，并试算进项抵扣的临界成本。',
        imaKeywords: ['一般纳税人', '500万', '小规模起征点', '增值税法'],
        fields: [
          { key: 'rolling12mTaxableSales', label: '近12个月累计应税销售额（元）', def: '4400000' },
          { key: 'projectedAnnualGrossSales', label: '预计未来年含税营收（元）', def: '4800000' },
          { key: 'deductibleCostRatio', label: '可获专票含税成本占比（如 0.70）', def: '0.70' },
          { key: 'hasExportRebateDemand', label: '是否有专票出口退税需求', type: 'bool', def: true },
          { key: 'taxPeriod', label: '小规模纳税期限（可选）', type: 'select', def: '', options: [{ value: '', label: '请选择计税期间' }, { value: 'month', label: '按月（起征点 10 万元）' }, { value: 'quarter', label: '按季（起征点 30 万元）' }] },
          { key: 'periodTaxableSales', label: '当月／当季不含税销售额（元）', def: '' },
        ],
        advancedFields: [
          { key: 'inputVatRate', label: '取得进项专票税率（默认 0.13）', def: '0.13' },
          { key: 'generalOutputRate', label: '一般纳税人销项税率（默认 0.13）', def: '0.13' },
          { key: 'smallScaleRate', label: '小规模征收率（默认 0.01）', def: '0.01' },
          { key: 'periodWaivedSales', label: '放弃起征点免税的不含税销售额（元）', def: '0' },
        ],
      },
      {
        code: 'cbec_assessed_cit', group: 'audit', zh: '综试区 4% 核定与小型微利', en: 'CBEC Assessed CIT & Small-Profit Relief',
        desc: '4% 核定适用于经主管税务机关鉴定的综试区零售出口。小型微利按同一主体的年度应纳税所得额、人数、资产和行业核验，5% 实际税负政策至 2027-12-31。',
        imaKeywords: ['综试区', '4%核定', '小型微利', '300万'],
        fields: [
          { key: 'revenue', label: '该主体本纳税年度可准确核算的收入总额（元）', def: '' },
          { key: 'assessedQualificationConfirmed', label: '主管税务机关已鉴定适用综试区零售出口核定', type: 'confirmation', def: '' },
          { key: 'taxableIncomeRate', label: '核定应税所得率（默认 0.04）', def: '0.04' },
          { key: 'taxYear', label: '纳税年度', def: '2026' },
          { key: 'annualTaxableIncome', label: '主体年度应纳税所得额（元，≤300 万）', def: '' },
          { key: 'annualAverageEmployees', label: '全年季度平均从业人数（≤300）', def: '' },
          { key: 'annualAverageAssets', label: '全年季度平均资产总额（元，≤5,000 万）', def: '' },
          { key: 'nonRestrictedIndustry', label: '从事国家非限制和禁止行业', type: 'confirmation', def: '' },
        ],
        advancedFields: [
          { key: 'citRate', label: '法定企业所得税率（默认 0.25）', def: '0.25' },
          { key: 'marginalTaxableIncomeRate', label: '新增收入适用边际所得率（可选，默认沿用核定所得率）', def: '' },
          { key: 'assumeMarginalRateSameAsAssessed', label: '允许沿用核定所得率推算 300 万临界收入空间', type: 'bool', def: true },
          { key: 'smallLowProfit', label: '已按同一主体确认全部小型微利条件（可选）', type: 'confirmation', def: '' },
        ],
      },
      {
        code: 'export_invoice_breakeven', group: 'export', zh: '供应商开票加点毛利临界', en: 'Invoice Markup Breakeven g*',
        desc: '对比加税点拿专票走免退税 vs 综试区合规无票免税，算出盈亏临界点 g* 与税后净利。',
        imaKeywords: ['开票加点', '无票免税', '免退税'],
        fields: [
          { key: 'barePurchaseAmount', label: '无票裸采成本（元）', def: '1000000' },
          { key: 'supplierMarkupRate', label: '供应商开票加点率（如 0.08）', def: '0.08' },
          { key: 'vatRate', label: '专票增值税率（如 0.13）', def: '0.13' },
          { key: 'rebateRate', label: '出口退税率（如 0.13 或 0.09）', def: '0.13' },
          { key: 'exportRevenue', label: '预计出口营收（元，可选）', def: '1500000' },
        ],
        advancedFields: [
          { key: 'otherDeductibleExpenses', label: '其他有票可扣成本费用（元）', def: '0' },
          { key: 'invoicedCitRate', label: '查账征收所得税率（默认 0.05）', def: '0.05' },
          { key: 'noInvoiceRevenueCitRate', label: '无票核定综合所得税率（默认 0.002）', def: '0.002' },
        ],
      },
      {
        code: 'cbec_return_duty_exempt', group: 'export', zh: '2026 第16号退运免税测算', en: '2026 #16 Return Duty Exemption',
        desc: '核验 2026–2027 年申报的跨境电商出口批次，按原状非食品、滞销或退货、六个月期限和出口退税证明判断专项资格。',
        imaKeywords: ['退运免税', '2026年第16号', '9610', '9810'],
        fields: [
          { key: 'customsCode', label: '原出口海关监管代码', type: 'select', def: '', options: [
            { value: '', label: '请选择监管代码' },
            { value: '9610', label: '9610（跨境直邮出口）' }, { value: '9710', label: '9710（跨境B2B直接出口）' },
            { value: '9810', label: '9810（跨境出口海外仓）' }, { value: '1210', label: '1210（特殊监管区域出口）' },
            { value: '0110', label: '0110（一般贸易）' }, { value: '1039', label: '1039（市场采购）' },
          ] },
          { key: 'exportValueCny', label: '退运商品原出口货值（元）', def: '300000' },
          { key: 'exportDate', label: '原出口申报日期', type: 'date', def: '' },
          { key: 'returnDate', label: '退运进境日期', type: 'date', def: '' },
          { key: 'zoneExitDate', label: '1210 出区离境日期', type: 'date', def: '', customsCode: '1210' },
          { key: 'returnedOutsideZone', label: '1210 退回境内区外', type: 'confirmation', def: '', customsCode: '1210' },
          { key: 'returnReason', label: '退运原因', type: 'select', def: '', options: [{ value: '', label: '请选择退运原因' }, { value: 'unsold', label: '滞销' }, { value: 'customer_return', label: '退货' }, { value: 'other', label: '其他' }] },
          { key: 'inOriginalCondition', label: '是否原状退运进境', type: 'confirmation', def: '' },
          { key: 'isFood', label: '是否为食品类商品', type: 'confirmation', def: '' },
          { key: 'refundedExportTax', label: '原出口已退税额（元，未退填 0）', def: '' },
          { key: 'exportRefundRepaid', label: '已退出口税款已缴回', type: 'confirmation', def: '' },
          { key: 'hasTaxCertificate', label: '已取得《出口货物已补税/未退税证明》', type: 'confirmation', def: '' },
        ],
        advancedFields: [
          { key: 'departureDate', label: '实际出口离境日期（与申报日不同时填写，1210 除外）', type: 'date', def: '', excludeCustomsCode: '1210' },
          { key: 'tariffRate', label: '测算用进口关税率（默认 0.10）', def: '0.10' },
          { key: 'importVatRate', label: '测算用进口增值税率（默认 0.13）', def: '0.13' },
          { key: 'consumptionTaxRate', label: '进口消费税率（默认 0）', def: '0' },
        ],
      },
      {
        code: 'export_rebate_manufacturer', group: 'export', zh: '生产企业“免、抵、退”税', en: 'Manufacturer Exempt-Credit-Refund',
        desc: '工贸一体/工厂卖家出口自产货物五步法精算：应退税额、免抵税额（含城建附加税预警）与留抵结转。',
        imaKeywords: ['免抵退', '生产企业出口退税'],
        fields: [
          { key: 'exportFobCny', label: '当期出口离岸价 FOB（元）', def: '2000000' },
          { key: 'totalInputVat', label: '当期全部可抵扣进项税（元）', def: '220000' },
          { key: 'vatRate', label: '出口适用征税率（如 0.13）', def: '0.13' },
          { key: 'rebateRate', label: '商品出口退税率（如 0.13）', def: '0.13' },
          { key: 'domesticOutputVat', label: '当期内销销项税额（元）', def: '40000' },
        ],
        advancedFields: [
          { key: 'dutyFreeMaterialsCny', label: '海关核销免税购进料件价（元）', def: '0' },
          { key: 'priorCreditCarryover', label: '上期期末留抵税额（元）', def: '0' },
        ],
      },
      {
        code: 'export_rebate_cancel_impact', group: 'export', zh: '退税取消与电池消费税双税冲击', en: 'Rebate Cancellation & Battery Excise Impact',
        desc: '对比保留原退税 vs 取消退税适用 2026#11 第七条视同内销征税（含 2026#20 电池消费税 2%→4% CMA 门禁、成品充电宝豁免及保毛利需涨价测算）。',
        imaKeywords: ['退税取消', '电池消费税', '2026年第11号', 'CMA'],
        fields: [
          { key: 'purchaseGrossCny', label: '含税采购金额（元，如 113）', def: '113' },
          { key: 'exportFobCny', label: '出口离岸价 FOB（元，如 135.60）', def: '135.60' },
          { key: 'oldRebateRate', label: '原出口退税率（如电池 0.06 / 光伏 0.13）', def: '0.06' },
          { key: 'newRebateRate', label: '调整后退税率（归零填 0 / 新能源车填 0.09）', def: '0' },
          { key: 'isConsumptionTaxItem', label: '属 2026#20 列明应税电池/光伏电池', type: 'bool', def: false },
          { key: 'isFinishedPowerBank', label: '为成品充电宝（用电充电系统，不在电池消费税范围）', type: 'bool', def: false },
        ],
        advancedFields: [
          { key: 'vatRate', label: '增值税税率（默认 0.13）', def: '0.13' },
          { key: 'cancelAppliesDeemedDomesticVat', label: '退税归零按 2026#11 第七条视同内销征税', type: 'bool', def: true },
          { key: 'consumptionTaxRate', label: '消费税率（备齐国标+CMA过渡 0.02 / 法定 0.04）', def: '0.02' },
          { key: 'hasValidCmaReport', label: '首次申报减免前已备齐有效 CMA 附表覆盖报告', type: 'confirmation', def: '' },
          { key: 'meetsNationalStandard', label: '符合强制性国家标准要求（2026#20 减免前提）', type: 'confirmation', def: '' },
          { key: 'cmaScopeCovered', label: 'CMA 检测报告附表完整覆盖申报电池型号', type: 'confirmation', def: '' },
          { key: 'exportConsumptionTaxExempt', label: '调整后出口消费税退（免）税适用（2026#2/#29第三条）', type: 'bool', def: true },
          { key: 'oldConsumptionTaxExempt', label: '原口径下出口消费税退（免）税适用', type: 'bool', def: true },
          { key: 'purchasePriceIncludesConsumptionTax', label: '采购价已含生产环节消费税（外贸购进退消费税口径）', type: 'bool', def: false },
          { key: 'otherCostsCny', label: '其他物流/报关/佣金成本（元）', def: '0' },
        ],
      },
      {
        code: 'export_rebate', group: 'export', zh: '外贸企业出口免退税', en: 'Trading Export VAT Rebate',
        desc: '按专票不含税额与征退税率孰低规则精算应退税额及征退税率差转成本。',
        imaKeywords: ['外贸企业出口退税', '免退税'],
        fields: [
          { key: 'purchaseAmount', label: '进项专票不含税金额（元）', def: '500000' },
          { key: 'vatRate', label: '专票适用征税率（如 0.13）', def: '0.13' },
          { key: 'rebateRate', label: '商品出口退税率（如 0.09）', def: '0.09' },
        ],
      },
      {
        code: 'annual_bonus_iit', group: 'general', zh: '年终奖双轨比选与 6 盲区', en: 'Annual Bonus Dual-Track IIT',
        desc: '支持「单独计税 vs 并入综合所得」双向最优比选（留空综合所得则仅算单独计税），同步检测 6 档多发 1 元倒挂陷阱。',
        imaKeywords: ['年终奖', '单独计税', '个人所得税'],
        fields: [
          { key: 'bonus', label: '全年一次性奖金总额（元）', def: '36001' },
          { key: 'annualComprehensiveTaxableIncome', label: '不含奖金年综合所得应纳税所得额（元，可填负值/留空）', def: '' },
          { key: 'annualSalary', label: '或填年税前工资薪金（元，自动扣 6 万及下方项）', def: '' },
        ],
        advancedFields: [
          { key: 'basicDeduction', label: '年度基本减除费用（默认 60000）', def: '60000' },
          { key: 'socialInsurance', label: '全年三险一金个人缴纳（元）', def: '0' },
          { key: 'specialAdditionalDeduction', label: '全年专项附加扣除（元）', def: '0' },
          { key: 'otherDeductions', label: '其他依法扣除（元）', def: '0' },
        ],
      },
      {
        code: 'cross_border_import', group: 'general', zh: '跨境零售进口综合税', en: 'Cross-Border Retail Import Tax',
        desc: '限额内 0 关税 + 70% 折算与消费税组成计税价格反算，含单次 5000 / 年度 26000 预警。',
        imaKeywords: ['跨境零售进口', '综合税', '1210'],
        fields: [
          { key: 'price', label: '单笔完税价格（元）', def: '1200' },
          { key: 'vatRate', label: '增值税率（默认 0.13）', def: '0.13' },
          { key: 'consumptionTaxRate', label: '消费税率（如高档护肤品 0.15）', def: '0.15' },
          { key: 'annualUsed', label: '本年已用个人额度（元）', def: '0' },
        ],
        advancedFields: [
          { key: 'discount', label: '综合税折算比例（默认 0.70）', def: '0.7' },
          { key: 'singleLimit', label: '单次交易限值（默认 5000）', def: '5000' },
          { key: 'annualLimit', label: '年度个人限值（默认 26000）', def: '26000' },
        ],
      },
      {
        code: 'vat', group: 'general', zh: '增值税价税分离', en: 'VAT Split',
        desc: '对齐 2026《增值税法》口径的含税/不含税双向精确换算。',
        imaKeywords: ['增值税法', '价税分离'],
        fields: [
          { key: 'amount', label: '合同金额（元）', def: '1130000' },
          { key: 'rate', label: '适用税率（如 0.13 / 0.06 / 0.01）', def: '0.13' },
          { key: 'inclusive', label: '金额是否含税', type: 'bool', def: true },
        ],
      },
    ]

    // ── module: src/client/calc_specs.js ──
    // v0.9.0 new cross-border tariff & mixed procurement split specs (3 engines -> 14 total).


    const V9_CALC_SCENARIOS = [
      {
        code: 'eu_low_value_parcel',
        group: 'crossborder',
        isNew: true,
        currency: 'EUR',
        zh: '欧盟低值包裹 €3+€2 与 PID 反推售价',
        en: 'EU Low-Value Parcel (€3+€2 & PID Pricing)',
        desc: '按欧委会指引测算欧盟 ≤€150 低值包裹 €3/项临时关税（自 2026-07-01 适用）+ €2/项退货不退处理费（自 2026-11-01 适用，IOSS 均不代收），支持 PID 含税抽佣向上取分反推售价（含 €150 复核阻断）及「同篮混装直邮 vs 同篮按项拆包 vs 单税则 SKU 归并 vs 欧盟海外仓」对比。',
        enDesc: 'Models EU <=EUR 150 parcel EUR 3 per-item temporary duty (from 2026-07-01) + EUR 2 per-item non-refundable handling fee (from 2026-11-01, excluded from IOSS), cent-ceiled PID reverse pricing with EUR 150 re-check, and physical split vs single-HS bundle vs EU warehouse comparison.',
        fields: [
          { key: 'sellingPriceEur', label: '商品含税零售价（EUR）', enLabel: 'VAT-Inclusive Selling Price (EUR)', def: '35.7' },
          { key: 'vatRate', label: '目标国 VAT 税率（如德 0.19 / 法 0.20）', enLabel: 'EU VAT Rate (e.g. 0.19)', def: '0.19' },
          { key: 'hsLineCount', label: '包裹内不同申报项/税则项数（1~20）', enLabel: 'Distinct Declared / HS Items (1-20)', def: '2' },
          { key: 'purchaseCostEur', label: '采购成本（EUR）', enLabel: 'Purchase Cost (EUR)', def: '7' },
          { key: 'directShippingEur', label: '国际直邮运费（EUR）', enLabel: 'Direct Parcel Shipping (EUR)', def: '4' },
          { key: 'commissionRate', label: '平台抽佣率（如 0.15）', enLabel: 'Platform Commission Rate', def: '0.15' },
          { key: 'returnRate', label: '退货率（如 0.08，体现 €2×项数 退货不退）', enLabel: 'Return Rate (e.g. 0.08)', def: '0.08' },
          { key: 'targetMarginRate', label: '目标净利率（可选，用于反推最低含税售价）', enLabel: 'Target Net Margin Rate (optional)', def: '0.15' },
        ],
        advancedFields: [
          { key: 'commissionOnVatInclusive', label: '平台按含税零售价基数抽佣（PID）', enLabel: 'Commission on VAT-Inclusive Price', type: 'bool', def: true },
          { key: 'marginBasis', label: '净利率与反推售价口径', enLabel: 'Margin Basis', type: 'select', def: 'vat_inclusive', options: [{ value: 'vat_inclusive', label: '含税有效销售额口径' }, { value: 'ex_vat', label: '不含税有效净营收口径' }] },
          { key: 'separateShippingInPriceEur', label: '售价内单独列明且不计入内在价值的运费（EUR，可选）', enLabel: 'Separately Stated Shipping in Price (EUR)', def: '' },
          { key: 'otherVariableCostEur', label: '其他变动成本/包材广告（EUR）', enLabel: 'Other Variable Cost (EUR)', def: '0' },
          { key: 'splitParcelShippingEur', label: '同购物篮按项拆包每小包直邮运费（EUR，默认同直邮运费）', enLabel: 'Split Parcel Shipping Per Parcel (EUR)', def: '' },
          { key: 'returnGoodsRecoveryRate', label: '直邮退货商品残值回收率（0~1）', enLabel: 'Direct Return Goods Recovery Rate', def: '0' },
          { key: 'euWarehouseReturnRecoveryRate', label: '欧盟海外仓退货商品回收率（0~1，默认同直邮）', enLabel: 'EU Warehouse Return Recovery Rate', def: '' },
          { key: 'euWarehouseFirstLegEur', label: '欧盟海外仓单件头程运费（EUR，可选）', enLabel: 'EU Warehouse First-Leg Freight (EUR)', def: '' },
          { key: 'euWarehouseDutyRate', label: '欧盟海外仓一般贸易关税率（默认 0.04）', enLabel: 'EU Warehouse MFN Duty Rate', def: '0.04' },
          { key: 'euWarehouseLocalDeliveryEur', label: '欧盟海外仓本地尾程派送费（EUR，可选）', enLabel: 'EU Warehouse Local Delivery (EUR)', def: '' },
          { key: 'euWarehouseStorageEur', label: '欧盟海外仓月均仓储费（EUR）', enLabel: 'EU Warehouse Monthly Storage (EUR)', def: '0' },
          { key: 'monthlyOrders', label: '月订单量（用于放大月度利差，可选）', enLabel: 'Monthly Orders (optional)', def: '1000' },
        ],
        imaKeywords: ['欧盟2欧', '150欧元', 'IOSS', 'PID', 'VAT'],
      },
      {
        code: 'us_t86_vs_9810_ddp',
        group: 'crossborder',
        isNew: true,
        currency: 'USD',
        zh: '美线 Type 11 vs 9810 DDP 与 IEEPA/FIOR',
        en: 'US Type 11 vs 9810 DDP & IEEPA/FIOR',
        desc: '对比美线 T86 暂停后 Type 11 直邮 vs 9810 海外仓 DDP 单件毛利（含 2027-01-15 Amazon US FBA 涨价 $0.19 敏感度），严格校验 IEEPA/CAPE 退税窗口与 ACE ACH Hold，并附 2027-01-05 FIOR+CTPAT-validated 红线。',
        enDesc: 'Compares US Type 11 direct mail vs 9810 overseas warehouse DDP unit margins (with 2027-01-15 FBA +$0.19 hike sensitivity), strict IEEPA/CAPE refund gating, ACE ACH Hold alerts, and 2027-01-05 FIOR + CTPAT-validated compliance.',
        fields: [
          { key: 'sellingPriceUsd', label: '商品售价（USD）', enLabel: 'Selling Price (USD)', def: '39.99' },
          { key: 'purchaseCostUsd', label: '采购成本（USD）', enLabel: 'Purchase Cost (USD)', def: '8' },
          { key: 'declaredValueUsd', label: '申报完税价 / FOB 价（USD）', enLabel: 'Declared Customs / FOB Value (USD)', def: '10' },
          { key: 'tariffRate', label: '适用总关税率（如 0.45 = 45%）', enLabel: 'Total Tariff Rate (decimal)', def: '0.45' },
          { key: 'type11ShippingUsd', label: 'Type 11 直邮国际运费（USD）', enLabel: 'Type 11 Direct Shipping (USD)', def: '9.5' },
          { key: 'type11ClearanceFeeUsd', label: 'Type 11 单票清关/MPF 杂费（USD）', enLabel: 'Type 11 Clearance & MPF Fee (USD)', def: '3.5' },
          { key: 'ddpFirstLegUsd', label: '9810 头程海运分摊（USD）', enLabel: '9810 Ocean First-Leg (USD)', def: '2.2' },
          { key: 'localDeliveryUsd', label: '海外仓/FBA 本土派送费（USD）', enLabel: 'US Local / FBA Delivery (USD)', def: '5.4' },
          { key: 'monthlyStorageUsd', label: '海外仓/FBA 月均仓储费（USD）', enLabel: 'Monthly Storage Fee (USD)', def: '0.35' },
          { key: 'commissionRate', label: '平台佣金率（默认 0.15）', enLabel: 'Platform Commission Rate', def: '0.15' },
        ],
        advancedFields: [
          { key: 'monthlyVolume', label: '月销量（件，默认 1000）', enLabel: 'Monthly Volume (units)', def: '2000' },
          { key: 'ddpClearanceAmortizedUsd', label: '9810 清关/MPF/HMF 分摊（USD）', enLabel: '9810 Clearance Amortized (USD)', def: '0.3' },
          { key: 'apply2027FbaHike', label: '直接计入 2027-01-15 FBA 敏感度涨价', enLabel: 'Include 2027-01-15 FBA Delta', type: 'bool', def: false },
          { key: 'fba2027DeltaUsd', label: '2027 FBA 单件涨价幅度（默认 $0.19 全盘平均假设，可覆盖）', enLabel: '2027 FBA Unit Fee Delta (USD)', def: '0.19' },
          { key: 'ieepaPaidUsd', label: '已缴拟申报 CAPE 退税金额（USD，可选）', enLabel: 'Paid Tariff for CAPE Estimate (USD)', def: '' },
          { key: 'tariffProgram', label: '关税项目（须显式选择，仅 IEEPA 适用 CAPE）', enLabel: 'Tariff Program (explicit)', type: 'select', def: '', options: [{ value: '', label: '请选择实缴税种（未选不放行）' }, { value: 'IEEPA', label: 'IEEPA（适用窗口内 CAPE 退税）' }, { value: 'Section301', label: 'Section 301（不适用 CAPE）' }, { value: 'Section232', label: 'Section 232（不适用 CAPE）' }, { value: 'Section122', label: 'Section 122（不适用 CAPE）' }] },
          { key: 'entryDate', label: '单票独立入境/缴税日（YYYY-MM-DD，可选）', enLabel: 'Single Entry Date (optional)', type: 'date', def: '' },
          { key: 'entryPeriodStart', label: '缴税开始日期（YYYY-MM-DD，须与结束日配对）', enLabel: 'Entry Period Start', type: 'date', def: '' },
          { key: 'entryPeriodEnd', label: '缴税结束日期（YYYY-MM-DD，须与开始日配对）', enLabel: 'Entry Period End', type: 'date', def: '' },
          { key: 'aceAchBound', label: '已在 CBP ACE Portal 绑定 ACH 账户', enLabel: 'ACE ACH Account Bound', type: 'confirmation', def: '' },
        ],
        imaKeywords: ['FIOR', 'CTPAT', 'IEEPA', '美国关税', '境外进口商', 'T86', '9810'],
      },
      {
        code: 'fba_mixed_procurement_split',
        group: 'export',
        isNew: true,
        currency: 'CNY',
        zh: '50 万 FBA 有票+无票混合采购拆单',
        en: 'FBA Mixed Procurement Split (0110 + 9810/9610)',
        desc: '测算有票专票与无票采购混合发 FBA 时「硬混一票退税被拒/全额视同内销」vs「有票 0110 退税 + 无票合规拆单」vs「加点补票全走 0110」净收益对比与操作边界。',
        enDesc: 'Compares mixed single-entry deemed-domestic-VAT risk vs compliant split (0110 rebate + 9810/9610/1039/agency) vs supplier-markup full-invoiced 0110.',
        fields: [
          { key: 'totalExportCny', label: '总出货额 / 出口 FOB 金额（元）', enLabel: 'Total Export Value (CNY)', def: '500000' },
          { key: 'invoicedPurchaseGrossCny', label: '有票专票采购批次含税金额（元）', enLabel: 'Invoiced Purchase Gross (CNY)', def: '339000' },
          { key: 'noInvoicePurchaseCny', label: '无票采购批次裸采金额（元）', enLabel: 'Non-Invoiced Bare Purchase (CNY)', def: '100000' },
          { key: 'invoicedVatRate', label: '有票进项专票税率（默认 0.13）', enLabel: 'Input VAT Rate', def: '0.13' },
          { key: 'invoicedRebateRate', label: '有票商品出口退税率（默认 0.13）', enLabel: 'Export Rebate Rate', def: '0.13' },
          { key: 'supplierInvoiceMarkupRate', label: '无票供应商加点开专票报价（如 0.08）', enLabel: 'Supplier Invoice Markup Rate', def: '0.08' },
          { key: 'splitNoInvoiceMode', label: '无票批次合规拆单模式', enLabel: 'Non-Invoiced Split Mode', type: 'select', def: '9810', options: [{ value: '9810', label: '9810 海外仓无票免税' }, { value: '9610', label: '9610 直邮无票免税' }, { value: '1039', label: '1039 市场采购无票免税' }, { value: 'agent_export', label: '合规委托代理出口' }] },
        ],
        advancedFields: [
          { key: 'invoicedPurchaseInclusive', label: '有票采购金额已含进项增值税', enLabel: 'Invoiced Purchase VAT-Inclusive', type: 'bool', def: true },
          { key: 'mixedSingleDeclarationCostCny', label: '硬混一票报关杂费（元）', enLabel: 'Mixed Single Declaration Cost (CNY)', def: '1500' },
          { key: 'split0110CostCny', label: '0110 一般贸易独立报关费（元）', enLabel: '0110 Declaration Cost (CNY)', def: '1500' },
          { key: 'splitNoInvoiceCostCny', label: '无票拆单/代理出口增量费用（元）', enLabel: 'Non-Invoiced Split Cost (CNY)', def: '2500' },
          { key: 'surtaxRate', label: '城建税及附加比例（默认 0.12）', enLabel: 'Surtax Rate on VAT', def: '0.12' },
        ],
        imaKeywords: ['拆单', '无票免税', '出口退税', '9810', '0110', '代理出口'],
      },
    ]

    const CALC_SCENARIOS = [
      ...BASE_CALC_SCENARIOS.filter((s) => s.group === 'audit'),
      ...V9_CALC_SCENARIOS.filter((s) => s.group === 'crossborder'),
      ...V9_CALC_SCENARIOS.filter((s) => s.group === 'export'),
      ...BASE_CALC_SCENARIOS.filter((s) => s.group === 'export'),
      ...BASE_CALC_SCENARIOS.filter((s) => s.group === 'general'),
    ]

    function buildInitialValues(sc) {
      const obj = {}
      for (const f of [...(sc.fields || []), ...(sc.advancedFields || [])]) obj[f.key] = f.def
      return obj
    }

    function fieldApplies(field, values) {
      return (!field.customsCode || field.customsCode === values.customsCode) &&
        (!field.excludeCustomsCode || field.excludeCustomsCode !== values.customsCode)
    }

    // ── module: src/client/ima_drawer.js ──
    // In-workbench IMA Quick Source Drawer (read-only snippet moat <=160 chars, tag-stripped plain text).


    function toWellFormedText(raw) {
      const s = String(raw ?? '')
      let out = ''
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
          if (next >= 0xdc00 && next <= 0xdfff) {
            out += s[i] + s[i + 1]
            i++
          }
        } else if (code < 0xdc00 || code > 0xdfff) {
          out += s[i]
        }
      }
      return out
    }

    function sliceUtf16CodePointSafe(raw, maxLen) {
      const clean = toWellFormedText(raw)
      if (maxLen <= 0) return ''
      if (clean.length <= maxLen) return clean
      let end = maxLen
      const lastCode = clean.charCodeAt(end - 1)
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) end--
      return clean.slice(0, end)
    }

    function clampImaSnippet(raw, maxLen = IMA_SNIPPET_MAX_LEN) {
      const plain = toWellFormedText(raw).replace(/\s+/g, ' ').trim()
      if (plain.length <= maxLen) return plain
      return `${sliceUtf16CodePointSafe(plain, Math.max(0, maxLen - 1))}…`
    }

    function sanitizeImaDisplayText(raw) {
      return toWellFormedText(raw)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<!DOCTYPE[^>]*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/?[a-z][a-z0-9:-]*(?:(?:\s+[^<>]*?)?\/?|\/)>/gi, '')
        .replace(/(?:https?:\/\/|ftp:\/\/|mailto:|www\.)\S+/gi, '')
        .replace(/(?<!:)\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[/:?#][^\s"'<>)]*)?/gi, '')
        .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    function ImaQuickDrawer({ open, initialQuery, status, t, isZh, onClose, onGoSettings, onCopyText, copiedKey, onSendToChat }) {
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [payload, setPayload] = useState(null)
      const [startSearch, invalidateSearch] = useLatestRequest()

      const runSearch = useCallback(async (rawQuery) => {
        const q = String(rawQuery ?? '').trim()
        if (!q) return
        const req = startSearch()
        setBusy(true)
        setErr('')
        try {
          const res = await callApi('/ima-quick', {
            method: 'POST',
            signal: req.signal,
            body: JSON.stringify({ query: q, kbId: status?.defaultKbId || undefined, limit: 6 }),
          })
          if (req.isCurrent()) setPayload(res)
        } catch (e) {
          if (req.isCurrent()) setErr(e.message || (isZh ? 'IMA 轻检索失败' : 'IMA quick search failed'))
        } finally {
          if (req.isCurrent()) setBusy(false)
        }
      }, [startSearch, status?.defaultKbId, isZh])

      useEffect(() => {
        if (!open) {
          invalidateSearch()
          return
        }
        const q = String(initialQuery || '').trim()
        setQuery(q)
        setErr('')
        if (q) runSearch(q)
        else setPayload(null)
      }, [open, initialQuery, runSearch, invalidateSearch])

      if (!open) return null

      const hits = Array.isArray(payload?.hits) ? payload.hits.slice(0, 8) : []
      const unconfigured = payload?.configured === false || (!payload && status && !status.configured && !status.loading)
      const quickChips = isZh
        ? ['欧盟2欧', 'FIOR', '810号令', '拆单', 'DAC7', '1099-K']
        : ['EU EUR 2', 'FIOR', 'DAC7', '1099-K', '9810', 'IOSS']

      const buildFollowUpPrompt = (hit) => {
        const safeTitle = sliceUtf16CodePointSafe(hit?.title || query || '', 80)
        const safeFolder = sliceUtf16CodePointSafe(hit?.folderPath || '', 80)
        const safeQuery = sliceUtf16CodePointSafe(query || '', 120)
        return isZh
          ? `请结合我的 IMA 财税知识库出处《${safeTitle}》${safeFolder ? `（目录：${safeFolder}）` : ''}，针对「${safeQuery}」给出适用边界、现行文号与操作核对清单。`
          : `Using IMA tax citation "${safeTitle}"${safeFolder ? ` (${safeFolder})` : ''}, explain applicable rules, thresholds, and compliance steps for "${safeQuery}".`
      }

      return h(
        'div',
        { className: 'ftx-drawer-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.imaDrawerTitle, onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h(
          'aside',
          { className: 'ftx-drawer' },
          h(
            'div',
            { className: 'ftx-inst-head', style: { borderBottom: '1px solid var(--ftx-line)', paddingBottom: 10 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } }, h(Icon, { kind: 'book', size: 16 }), h('span', null, t.imaDrawerTitle)),
            h('button', { type: 'button', className: 'ftx-btn-sm', onClick: onClose, 'aria-label': t.imaDrawerClose }, h(Icon, { kind: 'close', size: 13 })),
          ),
          h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', lineHeight: 1.45 } }, t.imaDrawerSub),
          h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('input', {
              type: 'text',
              className: 'ftx-input',
              style: { flex: 1 },
              value: query,
              placeholder: t.imaDrawerPlaceholder,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runSearch(query) },
            }),
            h('button', { type: 'button', className: 'ftx-btn-sm on', disabled: busy || !query.trim(), onClick: () => runSearch(query) }, busy ? t.imaDrawerSearching : t.imaDrawerSearch),
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
            ...quickChips.map((chip) =>
              h('button', { key: chip, type: 'button', className: 'ftx-btn-sm', style: { fontSize: 11, padding: '2px 7px' }, onClick: () => { setQuery(chip); runSearch(chip) } }, chip),
            ),
          ),
          err && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, err)),
          unconfigured
            ? h(
                'div',
                { className: 'ftx-panel', style: { padding: '14px 16px', gap: 10 } },
                h('div', { style: { fontSize: 12.5, lineHeight: 1.55, color: 'var(--ftx-ink)' } }, payload?.message || t.imaDrawerUnconfigured),
                h('button', { type: 'button', className: 'ftx-act pri', style: { height: 36 }, onClick: () => { onClose(); onGoSettings() } }, t.imaDrawerGoSettings),
              )
            : busy
              ? h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', padding: '12px 2px' } }, t.imaDrawerSearching)
              : payload && hits.length === 0
                ? h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', padding: '10px 2px', lineHeight: 1.5 } }, sanitizeImaDisplayText(payload.message) || t.imaDrawerEmpty)
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
                    payload?.usedFallback && Array.isArray(payload.fallbackTerms) && payload.fallbackTerms.length > 0 &&
                      h('div', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `短词回退检索：${payload.fallbackTerms.join(' / ')}`),
                    ...hits.map((hit, idx) => {
                      const titleText = sanitizeImaDisplayText(hit.title) || (isZh ? '未命名文档' : 'Untitled')
                      const folderText = sanitizeImaDisplayText(hit.folderPath || '')
                      const snippetText = clampImaSnippet(sanitizeImaDisplayText(hit.snippet), IMA_SNIPPET_MAX_LEN)
                      const copyKey = `ima-drawer-${idx}`
                      const prompt = buildFollowUpPrompt({ title: titleText, folderPath: folderText })
                      return h(
                        'article',
                        { key: `ima-hit-${idx}`, className: 'ftx-drawer-hit' },
                        h('div', { style: { fontWeight: 700, fontSize: 13, lineHeight: 1.4 } }, titleText),
                        folderText && h('div', { className: 'ftx-mono', style: { fontSize: 11, color: 'var(--ftx-mut)' } }, folderText),
                        h('div', { className: 'ftx-drawer-snippet', style: { fontSize: 12, lineHeight: 1.5, color: 'var(--ftx-ink)' } }, snippetText),
                        h(
                          'div',
                          { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2, alignItems: 'center' } },
                          h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => onCopyText(copyKey, prompt) }, copiedKey === copyKey ? t.copied : t.imaDrawerCopyAsk),
                          typeof onSendToChat === 'function' &&
                            h('button', { type: 'button', className: 'ftx-btn-sm on', onClick: () => { onSendToChat(prompt); onClose() } }, t.imaDrawerAskInChat),
                        ),
                      )
                    }),
                  ),
          payload?.disclaimer &&
            h('div', { style: { marginTop: 'auto', paddingTop: 10, borderTop: '1px solid var(--ftx-line)', fontSize: 11, color: 'var(--ftx-mut)', lineHeight: 1.45 } }, sanitizeImaDisplayText(payload.disclaimer)),
        ),
      )
    }

    // ── module: src/client/stage3_panel.js ──
    // Stage 1 -> Stage 2 -> Stage 3 (Domestic Bank Receipt 5-key fail-closed vs reference candidates) panel.


    const STAGE3_STATUS_MAP = {
      matched: { label: '5 键已全部核销', cls: 'ok' },
      partial: { label: '部分核销 · 存在在途/待核', cls: 'p1' },
      candidate_only: { label: '仅有参考候选 · 尚未法定核销', cls: 'p1' },
      pending_bank_receipt: { label: '待导国内对公银行回单', cls: 'p0' },
    }

    function renderStage3FundChainPanel({ fc }) {
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

    // ── module: src/client/audit_tables.js ──
    // Lower dual-column audit panels: Original-currency table + 17-channel indicators & Anomaly Radar.


    function renderAuditLowerSection({
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

    // ── module: src/client/tab_audit.js ──
    // Tab 1: Offline Statement Radar (17 channels + bank receipts, demo:v9, Stage 3, parseCache export).


    function StatementRadarTab({ active = true, t, status, refreshStatus, onCopyText, copiedKey, onJumpToCalc, onOpenIma }) {
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

    // ── module: src/client/tab_calc.js ──
    // Tab 2: 14 deterministic tax calculators (incl. EU EUR 3+2 parcel, US Type11 vs 9810 DDP, FBA mixed split).


    function toFiniteOrNull(v) {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }

    function renderV9ResultCards({ code, result, isZh }) {
      if (!result || typeof result !== 'object') return null
      if (code === 'eu_low_value_parcel' && result.breakdown) {
        const b = result.breakdown
        const planCmp = b.planComparison || {}
        const mixed = planCmp.mixedDirect || {}
        const splitByHs = planCmp.splitParcelByHsDirect || null
        const singleHs = planCmp.singleHsDirect || {}
        const wh = planCmp.euWarehouse || null
        const rp = b.reversePricing?.mixedDirect || null
        const levyTotal = result.euCustomsLevyTotalEur ?? b.customsLevies?.totalCustomsLevyEur ?? '—'
        const mixedProfit = result.netProfitEur ?? mixed.netProfitEur ?? '—'
        const sunkFee = result.returnSunkHandlingFeeEur ?? b.returnSunkCosts?.returnSunkHandlingFeeEur ?? 0
        const rawMinMain = toFiniteOrNull(rp?.minSellingPriceEur)
        const rawMinCeil = toFiniteOrNull(rp?.minSellingPriceCeilEur)
        const minPriceEur = rawMinMain !== null && rawMinCeil !== null
          ? Math.max(rawMinMain, rawMinCeil)
          : rawMinMain !== null
            ? rawMinMain
            : rawMinCeil
        const currentPriceEur = toFiniteOrNull(b.inputs?.sellingPriceEur ?? b.revenueAndTax?.sellingPriceEur ?? result.sellingPriceEur ?? result.inputs?.sellingPriceEur)
        const rawIncCeil = toFiniteOrNull(rp?.priceIncreaseNeededCeilEur)
        const increaseNeededEur = rawIncCeil !== null
          ? rawIncCeil
          : (minPriceEur !== null && currentPriceEur !== null)
            ? Math.max(0, Math.round((minPriceEur - currentPriceEur + Number.EPSILON) * 100) / 100)
            : (toFiniteOrNull(rp?.priceIncreaseNeededEur) ?? 0)
        const exceeds150 = rp?.exceeds150Threshold === true
        const displayOver150Eur = toFiniteOrNull(rp?.unconstrainedMinSellingPriceEur) ?? minPriceEur
        const rpFeasibleUnderRegime = Boolean(rp?.feasible) && !exceeds150 && minPriceEur !== null
        return h(
          'div',
          { className: 'ftx-calc-compare' },
          h(
            'div',
            { className: 'ftx-chain-cell' },
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, isZh ? '混装直邮税费（€3×N + €2×N）' : 'Mixed Direct Levy'),
            h('b', { className: 'ftx-mono', style: { fontSize: 16, color: 'var(--ftx-orange)' } }, `€${levyTotal}`),
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `净利 €${mixedProfit} · 退货沉没 €${sunkFee}（€3自2026-07-01/€2自2026-11-01）`),
          ),
          h(
            'div',
            { className: 'ftx-chain-cell ok' },
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, isZh ? '同篮按项拆包 vs 单税则SKU归并 / 海外仓' : 'Physical Split vs Single-HS / Warehouse'),
            h(
              'b',
              { className: 'ftx-mono', style: { fontSize: 15.5 } },
              wh?.configured
                ? `海外仓 €${wh.netProfitEur}`
                : splitByHs?.netProfitEur != null
                  ? `同篮拆包 €${splitByHs.netProfitEur} ｜ 单税则SKU €${singleHs.netProfitEur ?? '—'}`
                  : `单税则SKU €${singleHs.netProfitEur ?? '—'}`,
            ),
            h(
              'span',
              { style: { fontSize: 11, color: 'var(--ftx-mut)' } },
              wh?.breakevenTotalLogisticsVsMixedEur != null
                ? `海外仓盈亏平衡履约线 €${wh.breakevenTotalLogisticsVsMixedEur}/单（物理拆包多付运费不省税）`
                : '',
            ),
          ),
          rp &&
            h(
              'div',
              { className: `ftx-chain-cell${rpFeasibleUnderRegime ? '' : ' danger'}` },
              h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, isZh ? '含税抽佣保毛利反推最低价' : 'Reverse Min Selling Price'),
              h(
                'b',
                { className: 'ftx-mono', style: { fontSize: 16 } },
                exceeds150
                  ? (displayOver150Eur !== null ? `€${displayOver150Eur}（超 €150）` : '超 €150 不可行')
                  : (!rp.feasible || minPriceEur === null)
                    ? (isZh ? '目标净利率不可达' : 'Infeasible')
                    : `€${minPriceEur}`,
              ),
              h(
                'span',
                { style: { fontSize: 11, color: exceeds150 ? 'var(--ftx-orange)' : 'var(--ftx-mut)' } },
                exceeds150
                  ? '反推不含税价已超 €150 门槛，不适用低值包裹'
                  : (!rp.feasible || minPriceEur === null)
                    ? `理论净利率上限 ${((rp.maxTheoreticalMarginRate || 0) * 100).toFixed(1)}%`
                    : `需调价 +€${increaseNeededEur}`,
              ),
            ),
        )
      }
      if (code === 'us_t86_vs_9810_ddp') {
        const ieepa = result.breakdown?.ieepaRefund || null
        const achHold = ieepa?.achHoldAlert === true || result.achHoldAlert === true || result.summary?.achHoldAlert === true
        const type11Ineligible = result.type11Eligible === false || result.breakdown?.type11Direct?.type11Eligible === false
        const t11Profit = result.type11NetProfitUsd ?? result.summary?.type11NetProfitUsd ?? result.breakdown?.type11Direct?.netProfitUsd ?? '—'
        const t11Duty = result.breakdown?.type11Direct?.dutyUsd ?? '—'
        const ddpProfit = result.ddpNetProfitUsd ?? result.summary?.ddpNetProfitUsd ?? result.breakdown?.warehouse9810Ddp?.netProfitUsd ?? '—'
        const unitDiff = result.unitProfitDiffUsd ?? result.summary?.unitProfitDiffUsd ?? result.breakdown?.comparison?.unitProfitDiffUsd ?? '—'
        const afterHike = result.ddpProfitAfter2027FbaHikeUsd ?? result.breakdown?.warehouse9810Ddp?.profitAfter2027FbaHikeUsd
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(
            'div',
            { className: 'ftx-calc-compare' },
            h(
              'div',
              { className: `ftx-chain-cell${type11Ineligible ? ' danger' : ''}` },
              h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, 'Type 11 直邮单件净利'),
              h('b', { className: 'ftx-mono', style: { fontSize: 16 } }, type11Ineligible ? '不适用 Type 11' : `$${t11Profit}`),
              h('span', { style: { fontSize: 11, color: type11Ineligible ? 'var(--ftx-orange)' : 'var(--ftx-mut)' } }, type11Ineligible ? '完税价 >$2,500 须走 Type 01 正式报关' : `单件关税 $${t11Duty}`),
            ),
            h(
              'div',
              { className: 'ftx-chain-cell ok' },
              h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '9810 海外仓 DDP 单件净利'),
              h('b', { className: 'ftx-mono', style: { fontSize: 16 } }, `$${ddpProfit}`),
              h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `单件利差 $${unitDiff}${afterHike != null ? ` · 2027 FBA+$0.19后 $${afterHike}` : ''}`),
            ),
            ieepa &&
              h(
                'div',
                { className: `ftx-chain-cell${achHold ? ' danger' : ''}` },
                h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, 'IEEPA/CAPE 核定退税 & ACE ACH'),
                h('b', { className: 'ftx-mono', style: { fontSize: 16, color: achHold ? 'var(--ftx-orange)' : 'var(--ftx-ink)' } }, `$${result.ieepaEligibleRefundUsd ?? ieepa.eligibleRefundUsd ?? 0}`),
                h('span', { style: { fontSize: 11, color: achHold ? 'var(--ftx-orange)' : 'var(--ftx-mut)', fontWeight: achHold ? 700 : 400 } }, achHold ? 'P0: ACE ACH Hold 阻断退税' : (ieepa.status || '窗口已校验')),
              ),
          ),
          h(
            'div',
            { className: 'ftx-gap', style: { fontSize: 11.8, padding: '7px 10px' } },
            h('i', { className: 'att' }, '!'),
            h('span', null, '2027-01-05 美线红线：境外进口商（FIOR）须满足 CBP FIOR + CTPAT-validated 清关资质要求（111.29 延期至 2027-05-06 不顺延 FIOR 生效日）。'),
          ),
        )
      }
      if (code === 'fba_mixed_procurement_split') {
        return h(
          'div',
          { className: 'ftx-calc-compare' },
          h(
            'div',
            { className: 'ftx-chain-cell danger' },
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '方案 A · 硬混一票（A1 视同内销 / A2 不退）'),
            h('b', { className: 'ftx-mono', style: { fontSize: 16, color: 'var(--ftx-orange)' } }, `¥${Number(result.mixedDeemedNetProfitCny ?? 0).toLocaleString()}`),
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `免税不退对照 ¥${Number(result.mixedNoRefundNetProfitCny ?? 0).toLocaleString()}`),
          ),
          h(
            'div',
            { className: `ftx-chain-cell${result.recommendedPlan === 'split_0110_and_no_invoice' ? ' ok' : ''}` },
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `方案 B · 0110 退税 + ${result.splitNoInvoiceMode || '9810'} 拆单`),
            h('b', { className: 'ftx-mono', style: { fontSize: 16 } }, `¥${Number(result.splitNetProfitCny ?? 0).toLocaleString()}`),
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `较硬混多保住 ¥${Number(result.gainVsMixedDeemedVatCny ?? 0).toLocaleString()}`),
          ),
          h(
            'div',
            { className: `ftx-chain-cell${result.recommendedPlan === 'all_invoiced_0110' ? ' ok' : ''}` },
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '方案 C · 加点补票全走 0110'),
            h('b', { className: 'ftx-mono', style: { fontSize: 16 } }, `¥${Number(result.allInvoiced0110NetProfitCny ?? 0).toLocaleString()}`),
            h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `临界加点率 g* = ${result.noInvoiceBreakevenMarkupPct ?? '—'}%`),
          ),
        )
      }
      return null
    }

    function CalculatorTab({ t, isZh, onCopyText, copiedKey, calcSeed, onOpenIma }) {
      const [activeCode, setActiveCode] = useState(CALC_SCENARIOS[0].code)
      const [forms, setForms] = useState(() => {
        const init = {}
        for (const sc of CALC_SCENARIOS) init[sc.code] = buildInitialValues(sc)
        return init
      })
      const [showAdv, setShowAdv] = useState(false)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [result, setResult] = useState(null)
      const [startCalculation, invalidateCalculation] = useLatestRequest()

      const sc = CALC_SCENARIOS.find((x) => x.code === activeCode) || CALC_SCENARIOS[0]
      const vals = forms[sc.code] || {}

      const resetCalculation = () => {
        invalidateCalculation()
        setResult(null)
        setErr('')
        setBusy(false)
      }

      const setField = (k, v) => {
        resetCalculation()
        setForms((prev) => ({ ...prev, [sc.code]: { ...(prev[sc.code] || {}), [k]: v } }))
      }

      const runCalc = useCallback(async (targetSc, targetVals) => {
        const request = startCalculation()
        setBusy(true)
        setErr('')
        setResult(null)
        try {
          const params = {}
          for (const f of [...(targetSc.fields || []), ...(targetSc.advancedFields || [])]) {
            if (!fieldApplies(f, targetVals)) continue
            const raw = targetVals[f.key]
            if (raw === '' || raw === null || raw === undefined) continue
            if (f.type === 'bool' || f.type === 'confirmation') params[f.key] = raw === true || raw === 'true'
            else if (f.type === 'select' || f.type === 'date') params[f.key] = String(raw)
            else params[f.key] = Number(raw)
          }
          if (targetSc.code === 'export_rebate_cancel_impact' && params.purchasePriceIncludesConsumptionTax !== undefined && params.purchaseIncludesConsumptionTax === undefined) {
            params.purchaseIncludesConsumptionTax = params.purchasePriceIncludesConsumptionTax
          }
          const res = await callApi('/calc', { method: 'POST', signal: request.signal, body: JSON.stringify({ scenario: targetSc.code, params }) })
          if (request.isCurrent()) setResult(res.result)
        } catch (e) {
          if (request.isCurrent()) setErr(e.message || '试算失败')
        } finally {
          if (request.isCurrent()) setBusy(false)
        }
      }, [startCalculation])

      useEffect(() => {
        if (!calcSeed?.scenario) return
        const targetSc = CALC_SCENARIOS.find((x) => x.code === calcSeed.scenario)
        if (!targetSc) return
        const merged = { ...buildInitialValues(targetSc), ...(calcSeed.values || {}) }
        setActiveCode(targetSc.code)
        setForms((prev) => ({ ...prev, [targetSc.code]: merged }))
        invalidateCalculation()
        setResult(null)
        setErr('')
        setBusy(false)
        const hasAdvOverride = (targetSc.advancedFields || []).some(
          (f) => calcSeed.values?.[f.key] !== undefined && String(calcSeed.values[f.key]) !== '' && String(calcSeed.values[f.key]) !== '0',
        )
        setShowAdv(hasAdvOverride)
        if (calcSeed.autoRun !== false) runCalc(targetSc, merged)
      }, [calcSeed, runCalc, invalidateCalculation])

      const renderFieldControl = (f) => {
        if (f.type === 'confirmation') {
          return h('select', { value: String(vals[f.key] ?? ''), onChange: (e) => setField(f.key, e.target.value), className: 'ftx-input' }, h('option', { value: '' }, t.unverified), h('option', { value: 'true' }, isZh ? '是' : 'Yes'), h('option', { value: 'false' }, isZh ? '否' : 'No'))
        }
        if (f.type === 'bool') {
          return h('select', { value: vals[f.key] ? 'true' : 'false', onChange: (e) => setField(f.key, e.target.value === 'true'), className: 'ftx-input' }, h('option', { value: 'true' }, '是 (True)'), h('option', { value: 'false' }, '否 (False)'))
        }
        if (f.type === 'select') {
          return h('select', { value: String(vals[f.key] ?? f.def ?? ''), onChange: (e) => setField(f.key, e.target.value), className: 'ftx-input' }, ...(f.options || []).map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)))
        }
        if (f.type === 'date') {
          return h('input', { type: 'date', value: vals[f.key] ?? '', onChange: (e) => setField(f.key, e.target.value), className: 'ftx-input' })
        }
        return h('input', { type: 'number', step: 'any', value: vals[f.key] ?? '', onChange: (e) => setField(f.key, e.target.value), className: 'ftx-input' })
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
      const imaQuery = (result?.imaKeywords || sc.imaKeywords || [sc.zh]).slice(0, 3).join(' ')

      const groups = [
        { key: 'audit', label: isZh ? '01 · 对账与红线监控' : '01 · Reconcile & Thresholds' },
        { key: 'crossborder', label: isZh ? '02 · 跨境关税与低值包裹' : '02 · Cross-Border Tariffs' },
        { key: 'export', label: isZh ? '03 · 出口退税与拆单退运' : '03 · Export Rebate & Split' },
        { key: 'general', label: isZh ? '04 · 个税与基础计税' : '04 · IIT & Core Tax' },
      ]

      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' } },
        h(
          'div',
          { className: 'ftx-panel', style: { flex: '1 1 235px', minWidth: 0, maxWidth: '100%', padding: '12px 10px', gap: 10 } },
          ...groups.map((grp) => {
            const list = CALC_SCENARIOS.filter((x) => x.group === grp.key)
            return h(
              'div',
              { key: grp.key, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
              h('div', { className: 'ftx-mono', style: { fontSize: 10.5, fontWeight: 700, color: 'var(--ftx-mut)', padding: '2px 10px 4px', letterSpacing: '0.04em' } }, grp.label),
              ...list.map((item) => {
                const on = item.code === sc.code
                return h(
                  'button',
                  { key: item.code, type: 'button', className: `ftx-nav-btn${on ? ' is-active' : ''}`, onClick: () => { if (!on) { resetCalculation(); setActiveCode(item.code); setShowAdv(false) } } },
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, isZh ? item.zh : item.en),
                  item.isNew && h('span', { className: 'ftx-sev p0', style: { width: 'auto', padding: '0 5px', height: 17, fontSize: 9.5 } }, 'NEW'),
                )
              }),
            )
          }),
        ),
        h(
          'div',
          { style: { flex: '999 1 360px', minWidth: 0, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 16 } },
          h(
            'div',
            { className: 'ftx-panel' },
            h(
              'div',
              { className: 'ftx-inst-head' },
              h('span', { style: { fontSize: 16.5 } }, isZh ? sc.zh : sc.en),
              h('small', null, sc.currency ? `${sc.currency} / 0 TOKEN` : '0 TOKEN / LOCAL'),
            ),
            h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', lineHeight: 1.5, marginTop: -6 } }, (!isZh && sc.enDesc) ? sc.enDesc : (sc.desc || t.fourLayers)),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 185px), 1fr))', gap: 12 } },
              ...sc.fields.filter((f) => fieldApplies(f, vals)).map((f) => h('div', { key: f.key, style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } }, h('label', { style: { fontSize: 11.8, fontWeight: 650, color: 'var(--ftx-mut)' } }, (!isZh && f.enLabel) ? f.enLabel : f.label), renderFieldControl(f))),
            ),
            (sc.advancedFields || []).length > 0 &&
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--ftx-line)', paddingTop: 10 } },
                h('button', { type: 'button', className: 'ftx-btn-sm', style: { alignSelf: 'flex-start' }, onClick: () => setShowAdv(!showAdv) }, showAdv ? '收起高级口径参数 ▲' : `展开高级口径参数（${sc.advancedFields.length} 项）▼`),
                showAdv &&
                  h(
                    'div',
                    { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 185px), 1fr))', gap: 12 } },
                    ...sc.advancedFields.filter((f) => fieldApplies(f, vals)).map((f) => h('div', { key: f.key, style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } }, h('label', { style: { fontSize: 11.8, fontWeight: 650, color: 'var(--ftx-mut)' } }, (!isZh && f.enLabel) ? f.enLabel : f.label), renderFieldControl(f))),
                  ),
              ),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } },
              h('button', { type: 'button', className: 'ftx-act pri', style: { height: 40, padding: '0 20px' }, disabled: busy, onClick: () => runCalc(sc, vals) }, busy ? '计算中…' : '立即代码精算（0 Token）'),
              result && h('button', { type: 'button', className: 'ftx-act', style: { height: 40 }, onClick: () => onCopyText('calc-ai', aiPrompt) }, copiedKey === 'calc-ai' ? t.copied : '复制结果去查 IMA 原文'),
              result && typeof onOpenIma === 'function' && h('button', { type: 'button', className: 'ftx-act', style: { height: 40 }, onClick: () => onOpenIma(imaQuery) }, t.imaQuickBtn),
            ),
            err && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, err)),
          ),
          result &&
            h(
              'div',
              { className: 'ftx-panel', style: { gap: 12 } },
              h(
                'div',
                { className: `ftx-lcd${result.eligible === false || result.exceeded === true ? ' warn' : ''}`, style: { margin: 0 } },
                h('div', { className: 'ftx-lcd-lbl' }, h('span', null, '确定性引擎精算结论'), h('span', { className: 'ftx-mono', style: { fontSize: 10 } }, sc.code.toUpperCase())),
                h('div', { style: { fontSize: 17.5, fontWeight: 700, lineHeight: 1.45, color: 'var(--ftx-lcd-ink)', marginTop: 4 } }, headline),
              ),
              renderV9ResultCards({ code: sc.code, result, isZh }),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.8, lineHeight: 1.6 } },
                ...(result.steps || []).map((st, i) => h('div', { key: i, style: { display: 'flex', gap: 9, alignItems: 'flex-start' } }, h('span', { className: 'ftx-sev', style: { flexShrink: 0 } }, String(i + 1).padStart(2, '0')), h('span', null, st))),
              ),
              (result.warnings || []).length > 0 &&
                h(
                  'div',
                  { className: 'ftx-gap', style: { flexDirection: 'column', alignItems: 'flex-start', gap: 6 } },
                  ...result.warnings.map((w, i) => h('div', { key: i, style: { fontSize: 12.5, fontWeight: 650, lineHeight: 1.5 } }, `⚠ ${w}`)),
                ),
              (result.policyRefs || []).length > 0 &&
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: 6, borderTop: '1px solid var(--ftx-line)', paddingTop: 10 } },
                  ...result.policyRefs.map((item, i) => h('span', { key: i, title: item?.note || '', className: 'ftx-kb-pill', style: { padding: '3px 9px', fontSize: 11.5 } }, refText(item))),
                ),
            ),
        ),
      )
    }

    // ── module: src/client/tab_annual.js ──
    // Tab 3: Annual Q1-Q4 Summary, 2027-01-31 3-Jurisdiction Compliance Cards, Entity Reassign & Backup.


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

    function AnnualArchiveTab({ active, t, isZh, onOpenIma }) {
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

    // ── module: src/client/settings.js ──
    // Settings tab: Tencent IMA OpenAPI credentials, default KB binding, and passive dsh-market Update API v1 check.


    function SettingsTab({ t, isZh, status, refreshStatus, marketUpdate, onUpdateProbe }) {
      const [clientId, setClientId] = useState('')
      const [apiKey, setApiKey] = useState('')
      const [manualKbId, setManualKbId] = useState('')
      const [kbs, setKbs] = useState([])
      const [saving, setSaving] = useState(false)
      const [testing, setTesting] = useState(false)
      const [probingUpdate, setProbingUpdate] = useState(false)
      const [updateMsg, setUpdateMsg] = useState('')
      const [msg, setMsg] = useState(null)

      const onSaveCreds = async () => {
        setSaving(true); setMsg(null)
        try {
          const data = await callApi('/credentials', { method: 'POST', body: JSON.stringify({ clientId, apiKey }) })
          setClientId(''); setApiKey('')
          setMsg({ ok: true, text: t.savedOk })
          await refreshStatus(data)
        } catch (err) { setMsg({ ok: false, text: err.message }) } finally { setSaving(false) }
      }

      const onClearCreds = async () => {
        setSaving(true); setMsg(null)
        try {
          const data = await callApi('/credentials', { method: 'DELETE' })
          setKbs([]); setMsg({ ok: true, text: t.clearedOk })
          await refreshStatus(data)
        } catch (err) { setMsg({ ok: false, text: err.message }) } finally { setSaving(false) }
      }

      const onTestAndLoadKbs = async () => {
        setTesting(true); setMsg(null)
        try {
          if (clientId.trim() || apiKey.trim()) {
            await callApi('/credentials', { method: 'POST', body: JSON.stringify({ clientId, apiKey }) })
            setClientId(''); setApiKey(''); await refreshStatus()
          }
          const data = await callApi('/kbs?refresh=1')
          setKbs(Array.isArray(data.kbs) ? data.kbs : [])
          setMsg({ ok: true, text: `连接成功，共拉取 ${data.kbs?.length || 0} 个 IMA 知识库` })
        } catch (err) { setMsg({ ok: false, text: err.message }) } finally { setTesting(false) }
      }

      const onBindKb = async (kbId, kbName) => {
        setMsg(null)
        try {
          const data = await callApi('/settings', { method: 'POST', body: JSON.stringify({ defaultKbId: kbId, defaultKbName: kbName }) })
          setManualKbId('')
          setMsg({ ok: true, text: kbId ? `${t.kbBoundOk}：${kbName || kbId}` : '已取消默认知识库绑定' })
          await refreshStatus(data)
        } catch (err) { setMsg({ ok: false, text: err.message }) }
      }

      const onCheckMarketUpdate = async () => {
        setProbingUpdate(true)
        setUpdateMsg('')
        try {
          const ver = status?.version || CLIENT_VERSION
          const res = await probeMarketUpdate(ver)
          if (typeof onUpdateProbe === 'function') onUpdateProbe(res)
          if (!res) setUpdateMsg(isZh ? '当前宿主未启用 dsh-market Update API v1（不影响离线功能）' : 'dsh-market Update API v1 not available on this host')
          else if (res.hasUpdate) setUpdateMsg(isZh ? `检测到新版本 v${res.latestVersion}（当前 v${ver}），可在 DSH 插件市场一键更新` : `New version v${res.latestVersion} available (current v${ver})`)
          else if (!res.latestVersion) setUpdateMsg(isZh ? '已连接 dsh-market Update API v1，但暂未返回 dsh-fintax 版本目录' : 'Connected to dsh-market Update API v1, but no dsh-fintax version entry was returned')
          else setUpdateMsg(isZh ? `当前已是最新版本 v${ver}` : `Already on latest version v${ver}`)
        } finally {
          setProbingUpdate(false)
        }
      }

      const verText = status?.version || CLIENT_VERSION
      const channelsCount = status?.supportedChannels || 17
      const enginesCount = status?.calcEngineCount || 14

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
        h(
          'section',
          { className: 'ftx-panel' },
          h('div', { className: 'ftx-inst-head' }, h('span', null, t.credTitle), h('small', null, 'READ-ONLY / 0O600')),
          h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', lineHeight: 1.5 } }, t.credDesc),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 } },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } }, h('label', { style: { fontSize: 12, fontWeight: 650, color: 'var(--ftx-mut)' } }, t.cidLabel), h('input', { type: 'password', autoComplete: 'off', className: 'ftx-input', value: clientId, placeholder: status.clientIdSet ? t.savedPlaceholder : t.emptyCidPlaceholder, onChange: (e) => setClientId(e.target.value) })),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } }, h('label', { style: { fontSize: 12, fontWeight: 650, color: 'var(--ftx-mut)' } }, t.keyLabel), h('input', { type: 'password', autoComplete: 'off', className: 'ftx-input', value: apiKey, placeholder: status.apiKeySet ? t.savedPlaceholder : t.emptyKeyPlaceholder, onChange: (e) => setApiKey(e.target.value) })),
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
            h('button', { type: 'button', className: 'ftx-act pri', style: { height: 38 }, disabled: saving || (!clientId.trim() && !apiKey.trim()), onClick: onSaveCreds }, saving ? t.savingBtn : t.saveBtn),
            h('button', { type: 'button', className: 'ftx-act', style: { height: 38 }, disabled: testing, onClick: onTestAndLoadKbs }, testing ? t.testingBtn : t.testBtn),
            status.configured && !status.envOverride && h('button', { type: 'button', className: 'ftx-btn-sm danger', style: { height: 38, padding: '0 14px' }, disabled: saving, onClick: onClearCreds }, t.clearBtn),
          ),
          msg && h('div', { style: { fontSize: 12.8, fontWeight: 700, color: msg.ok ? 'var(--ftx-ok)' : 'var(--ftx-orange)' } }, msg.text),
        ),
        h(
          'section',
          { className: 'ftx-panel' },
          h('div', { className: 'ftx-inst-head' }, h('span', null, t.kbTitle), h('small', null, 'DEFAULT KB')),
          h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', lineHeight: 1.5 } }, t.kbDesc),
          kbs.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                ...kbs.map((kb) => {
                  const isDef = status.defaultKbId && status.defaultKbId === kb.id
                  return h(
                    'div',
                    { key: kb.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 4, border: `1px solid ${isDef ? 'var(--ftx-ink)' : 'var(--ftx-line)'}`, background: 'var(--ftx-paper)' } },
                    h('div', null, h('div', { style: { fontSize: 13.5, fontWeight: 700 } }, kb.name), h('div', { className: 'ftx-mono', style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, `ID: ${kb.id}${kb.count ? ` · ${kb.count} 篇` : ''}`)),
                    isDef ? h('span', { className: 'ftx-kb-pill' }, h('span', { className: 'ftx-kb-dot', style: { background: 'var(--ftx-ok)' } }), t.kbCurrentBadge) : h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => onBindKb(kb.id, kb.name) }, t.kbSetDefault),
                  )
                }),
              )
            : h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)' } }, t.kbEmptyHint),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', borderTop: '1px solid var(--ftx-line)', paddingTop: 12 } },
            h('input', { type: 'text', className: 'ftx-input', style: { flex: '1 1 180px', minWidth: 0 }, value: manualKbId, placeholder: t.kbManualPlaceholder, onChange: (e) => setManualKbId(e.target.value) }),
            h('button', { type: 'button', className: 'ftx-btn-sm', style: { height: 34, padding: '0 14px' }, disabled: !manualKbId.trim(), onClick: () => onBindKb(manualKbId.trim(), '') }, t.kbSaveManual),
            status.defaultKbId && status.defaultKbSource !== 'env' && h('button', { type: 'button', className: 'ftx-btn-sm danger', style: { height: 34, padding: '0 14px' }, onClick: () => onBindKb('', '') }, t.kbClearDefault),
          ),
        ),
        h(
          'section',
          { className: 'ftx-panel' },
          h('div', { className: 'ftx-inst-head' }, h('span', null, isZh ? '3. 插件版本与 DSH 生态探测' : '3. Version & DSH Ecosystem'), h('small', null, 'UPDATE API V1')),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 12.5, color: 'var(--ftx-mut)' } },
            h('span', { className: 'ftx-mono', style: { color: 'var(--ftx-ink)', fontWeight: 700 } }, `dsh-fintax v${verText}`),
            h('span', null, isZh ? `${channelsCount} 通道 + 银行回单 · ${enginesCount} 算税引擎 · 零外部依赖` : `${channelsCount} channels + bank receipts · ${enginesCount} tax engines · zero deps`),
            marketUpdate?.hasUpdate && h('span', { className: 'ftx-upd-pill' }, `${t.updateAvailable}: v${marketUpdate.latestVersion}`),
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } },
            h('button', { type: 'button', className: 'ftx-btn-sm', disabled: probingUpdate, onClick: onCheckMarketUpdate }, probingUpdate ? (isZh ? '探测中…' : 'Checking…') : (isZh ? '检查 dsh-market 更新' : 'Check dsh-market updates')),
            updateMsg && h('span', { style: { fontSize: 12, color: marketUpdate?.hasUpdate ? 'var(--ftx-orange)' : 'var(--ftx-mut)' } }, updateMsg),
          ),
        ),
      )
    }

    // ── module: src/client/main.js ──
    // Main workbench shell, dynamic locale subscription, IMA drawer host, and DSH 0.2.2/0.2.3 slot registration.


    function FinTaxWorkbench({ lang, ctx, surface = 'settings' }) {
      const [activeLang, setActiveLang] = useState(() => lang || getLang(ctx))
      useEffect(() => {
        if (lang) setActiveLang(lang)
      }, [lang])
      useEffect(() => {
        if (!ctx) return undefined
        return subscribeLang(ctx, (nextLang) => setActiveLang(nextLang))
      }, [ctx])

      const isZh = activeLang !== 'en'
      const t = COPY[isZh ? 'zh' : 'en']
      const [tab, setTab] = useState(surface === 'sidebar' ? 'radar' : 'settings')
      const [status, setStatus] = useState({ loading: true, configured: false, source: 'none', defaultKbId: '', defaultKbName: '', version: '' })
      const [marketUpdate, setMarketUpdate] = useState(null)
      const [copiedKey, setCopiedKey] = useState('')
      const [calcSeed, setCalcSeed] = useState(null)
      const [imaDrawer, setImaDrawer] = useState({ open: false, query: '', nonce: 0 })
      const [startStatus] = useLatestRequest()
      const [startCopy] = useLatestRequest()
      const [startUpdateProbe] = useLatestRequest()

      useEffect(retainStyles, [])

      const onJumpToCalc = useCallback((scenario, values, autoRun = true) => {
        setCalcSeed({ scenario, values, autoRun, nonce: Date.now() })
        setTab('calc')
      }, [])

      const onOpenIma = useCallback((queryText) => {
        setImaDrawer({ open: true, query: String(queryText || '').trim(), nonce: Date.now() })
      }, [])

      const refreshStatus = useCallback(async (direct) => {
        const request = startStatus()
        try {
          const data = direct || (await callApi('/status', { signal: request.signal }))
          if (request.isCurrent()) setStatus({ loading: false, ...data })
        } catch {
          if (request.isCurrent()) setStatus((prev) => ({ ...prev, loading: false }))
        }
      }, [startStatus])

      useEffect(() => { refreshStatus() }, [refreshStatus])

      // Passive read-only dsh-market Update API v1 probe (only runs when backend advertises capability; fails silently).
      useEffect(() => {
        if (!status?.capabilities?.dshMarketUpdateV1) return
        const req = startUpdateProbe()
        probeMarketUpdate(status.version || CLIENT_VERSION, req.signal).then((res) => {
          if (req.isCurrent() && res) setMarketUpdate(res)
        }).catch(() => { /* silent */ })
      }, [status?.capabilities?.dshMarketUpdateV1, status?.version, startUpdateProbe])

      const copyTimerRef = useRef(null)
      useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

      const onCopyText = async (key, text) => {
        if (!navigator.clipboard?.writeText) return
        const request = startCopy()
        try {
          await navigator.clipboard.writeText(text)
          if (!request.isCurrent()) return
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          setCopiedKey(key)
          copyTimerRef.current = setTimeout(() => { if (request.isCurrent()) setCopiedKey('') }, 1800)
        } catch { /* ignore */ }
      }

      const onSendToChat = useCallback((promptText) => {
        try {
          if (typeof ctx?.conversation?.insertInput === 'function') {
            ctx.conversation.insertInput(promptText)
            return
          }
          if (typeof ctx?.chat?.send === 'function') {
            ctx.chat.send(promptText)
            return
          }
        } catch { /* fallback to clipboard */ }
        onCopyText('drawer-chat', promptText)
      }, [ctx])

      const credLabel = status.configured
        ? status.defaultKbId
          ? `IMA 知识库 · ${t.defaultKbBound}${status.defaultKbName || status.defaultKbId}`
          : status.source === 'env' ? t.statusReadyEnv : status.source === 'mixed' ? t.statusReadyMixed : t.statusReadyFile
        : t.statusMissing

      return h(
        'div',
        { className: 'ftx-host-wrap' },
        h(
          'div',
          { className: 'ftx-root', style: { maxWidth: surface === 'sidebar' ? 'min(100%, 1220px)' : 'min(100%, 900px)', width: '100%', margin: surface === 'sidebar' ? '0 auto' : 0, padding: surface === 'sidebar' ? '16px 20px 22px' : '14px 16px 24px', display: 'flex', flexDirection: 'column', gap: 13, minHeight: surface === 'sidebar' ? '100%' : 'auto' } },
          h(
            'header',
            { className: 'ftx-top' },
            h('h1', { className: 'ftx-h1' }, t.title, h('span', null, `· ${t.subtitle}${status.version ? ` v${status.version}` : ''}`)),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', maxWidth: '100%' } },
              marketUpdate?.hasUpdate && h('span', { className: 'ftx-upd-pill', title: marketUpdate.notes || '' }, `${t.updateAvailable} v${marketUpdate.latestVersion}`),
              h('div', { className: 'ftx-kb-pill', title: credLabel }, h(Icon, { kind: 'book', size: 15 }), h('span', { className: 'ftx-kb-dot', style: { background: status.configured ? 'var(--ftx-ok)' : 'var(--ftx-orange)' } }), h('span', { className: 'ftx-kb-pill-txt' }, credLabel)),
            ),
          ),
          h(
            'div',
            { className: 'ftx-tabs' },
            h('button', { type: 'button', className: `ftx-tab${tab === 'radar' ? ' is-active' : ''}`, onClick: () => setTab('radar') }, t.tabRadar),
            h('button', { type: 'button', className: `ftx-tab${tab === 'calc' ? ' is-active' : ''}`, onClick: () => setTab('calc') }, t.tabCalc),
            h('button', { type: 'button', className: `ftx-tab${tab === 'annual' ? ' is-active' : ''}`, onClick: () => setTab('annual') }, t.tabAnnual),
            h('button', { type: 'button', className: `ftx-tab${tab === 'settings' ? ' is-active' : ''}`, onClick: () => setTab('settings') }, t.tabSettings),
            h('span', { className: 'ftx-local-tag' }, h('i', null), t.localPill),
          ),
          h('div', { style: { display: tab === 'radar' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(StatementRadarTab, { active: tab === 'radar', t, status, refreshStatus, onCopyText, copiedKey, onJumpToCalc, onOpenIma })),
          h('div', { style: { display: tab === 'calc' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(CalculatorTab, { t, isZh, onCopyText, copiedKey, calcSeed, onOpenIma })),
          h('div', { style: { display: tab === 'annual' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(AnnualArchiveTab, { active: tab === 'annual', t, isZh, onOpenIma })),
          h('div', { style: { display: tab === 'settings' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(SettingsTab, { t, isZh, status, refreshStatus, marketUpdate, onUpdateProbe: setMarketUpdate })),
          h(ImaQuickDrawer, {
            open: imaDrawer.open,
            initialQuery: imaDrawer.query,
            status,
            t,
            isZh,
            onClose: () => setImaDrawer((prev) => ({ ...prev, open: false })),
            onGoSettings: () => setTab('settings'),
            onCopyText,
            copiedKey,
            onSendToChat,
          }),
          h(
            'footer',
            { style: { marginTop: 'auto', paddingTop: 10, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--ftx-mut)' } },
            h('span', null, '本地离线初筛 · 结果供人工核查'),
            h('span', { className: 'ftx-mono', style: { letterSpacing: '0.8px' } }, `DSH / FINTAX${status.version ? ` ${status.version}` : ''}`),
          ),
        ),
      )
    }

    function ConversationDockAction({ ctx, owner = {} }) {
      const isZh = getLang(ctx) !== 'en'
      const t = COPY[isZh ? 'zh' : 'en']
      const quickPrompt = isZh
        ? '请帮我结合跨境财税规则与我的 IMA 知识库，核对本月账单三段资金链或测算欧盟/美线税负。'
        : 'Help me reconcile my cross-border statements or calculate EU/US tax exposure using my IMA knowledge base.'
      const onClick = () => {
        try {
          if (typeof owner?.insertText === 'function') { owner.insertText(quickPrompt); return }
          if (typeof owner?.setInput === 'function') { owner.setInput(quickPrompt); return }
          if (typeof ctx?.conversation?.insertInput === 'function') { ctx.conversation.insertInput(quickPrompt); return }
          if (typeof ctx?.navigation?.openPanel === 'function') { ctx.navigation.openPanel(PANEL_ID); return }
          navigator.clipboard?.writeText?.(quickPrompt)
        } catch { /* silent */ }
      }
      return h('button', { type: 'button', className: 'ftx-dock-btn', title: t.dockTitle, onClick }, h(FinTaxMark, { size: 14 }), h('span', null, t.dockLabel))
    }

    /**
     * Feature-detect and safely mount DSH 0.2.3+ `conversation.input.dock` slot.
     * On DSH 0.2.2 hosts that do not expose this slot, silently skips with zero errors.
     */
    function registerConversationDockSafely(ctx, t) {
      try {
        if (typeof ctx?.slots?.inject !== 'function' || typeof ctx?.slots?.register !== 'function') return
        const hasExplicitSlotCheck = typeof ctx.slots.has === 'function'
        if (hasExplicitSlotCheck && !ctx.slots.has('conversation.input.dock')) return
        const supported = Array.isArray(ctx.slots.available) ? ctx.slots.available.includes('conversation.input.dock') : true
        if (!supported) return
        ctx.slots.inject('conversation.input.dock', () => {
          try {
            const off = ctx.slots.register(
              { name: 'conversation.input.dock', id: 'fintax-quick-ask', order: 42, label: () => t('dockLabel'), locale: NS },
              (owner = {}) => h(ConversationDockAction, { ctx, owner }),
            )
            return typeof off === 'function' ? off : () => {}
          } catch {
            return () => {}
          }
        })
      } catch {
        // Host is likely DSH 0.2.2 without conversation.input.dock; ignore cleanly.
      }
    }

    function createPluginEntry() {
      const apply = (ctx) => {
        try {
          const t = ctx.locale.bind(NS)
          ctx.effect(() => ctx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), 'fintax: dictionaries')

          ctx.slots.inject('sidebar.panellist', () => {
            const offPanel = ctx.slots.register(
              { name: 'main', key: PANEL_ID, locale: NS },
              () => h('div', { style: { height: '100%', width: '100%', maxWidth: '100%', minWidth: 0, flex: '1 1 0%', overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box' } }, h(FinTaxWorkbench, { ctx, lang: getLang(ctx), surface: 'sidebar' })),
            )
            const offRow = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 22, label: () => t('nav'), locale: NS },
              (owner = {}) => h(FinTaxMark, { size: owner?.size ?? 16 }),
            )
            return () => {
              if (typeof offRow === 'function') offRow()
              if (typeof offPanel === 'function') offPanel()
            }
          })

          ctx.slots.inject('settings.section.icon', () => {
            const off = ctx.slots.register(
              { name: 'settings.section.icon', id: 'fintax' },
              (owner = {}) => h(FinTaxMark, { size: owner?.size ?? 16 }),
            )
            return typeof off === 'function' ? off : () => {}
          })

          registerConversationDockSafely(ctx, t)

          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'fintax', order: 38, label: () => t('nav'), locale: NS },
              (props) => h(FinTaxWorkbench, { ...props, ctx, lang: getLang(ctx), surface: 'settings' }),
            ),
          )
        } catch (err) {
          console.error('[dsh-fintax] client mount failed cleanly without crashing host:', err)
        }
      }
      return {
        name: 'fintax',
        inject,
        apply,
        activate(ctx) { return apply(ctx) },
      }
    }

    return createPluginEntry()
  },
})

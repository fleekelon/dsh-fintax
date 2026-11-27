// Bilingual dictionary (zh/en), safe HTML escaping, and dynamic host locale subscription.

export const COPY = {
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

export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function normalizeLang(raw) {
  return String(raw || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh'
}

export function getLang(ctx) {
  try {
    const snapshot = typeof ctx?.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx?.locale?.getSnapshot?.()
    const raw = snapshot?.active ?? ctx?.locale?.locale ?? document?.documentElement?.lang ?? navigator?.language ?? 'zh'
    return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

export function subscribeLang(ctx, onChange) {
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

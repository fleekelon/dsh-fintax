/**
 * dsh-fintax — 桌面端独立财税工作台 + 图形化设置页（免构建 ModuleLoader 模块）。
 * 设计语言：Dieter Rams / Braun 精密计算仪器风（哑光铝壳 + 橄榄绿 LCD 屏 + 动态双指针红线表盘 + 信号橙预警）。
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
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    const NS = 'settings.fintax'
    const PANEL_ID = 'dsh-fintax'
    const inject = ['slots', 'locale']

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
        tabCalc: '10 大确定性算税',
        tabSettings: 'IMA 知识库与设置',
        localPill: '本地离线初筛',
        statusReadyFile: 'IMA 知识库 · 已就绪',
        statusReadyEnv: 'IMA 知识库 · 环境变量',
        statusReadyMixed: 'IMA 知识库 · 混合凭证',
        statusMissing: '未配 IMA（排雷与 10 大算税离线可用）',
        defaultKbBound: '已绑定 ',
        defaultKbNone: '未绑定默认库',
        dropTitle: '拖入原始结算账单 / .ZIP',
        dropSub: '支持 8 大销售平台 + 3 大结汇通道（万里汇 / 派安盈 / 空中云汇）· 原始明细 100% 留在本机内存',
        pickFiles: '核对我的账单 / .ZIP',
        runDemo: '经典三平台沙盒',
        runDemoV7: 'v0.7 新三平台沙盒',
        runDemoV8: '用示例看一张核对单',
        parsing: '解析中…',
        recalcBtn: '按汇率重算总对账',
        saveFxDefault: '保存为默认汇率',
        resetFxDefault: '恢复内置参考汇率',
        exportHtml: '导出老板版 HTML 核对单',
        exportMd: '导出 Markdown (.md)',
        exportCsv: '导出财务待核 CSV',
        exportTrendHtml: '导出滚年趋势月报',
        declaredLabel: '已申报增值税/出口销售额（元）',
        platformAuto: '自动识别（11 通道）',
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
        tabCalc: '10 Tax Calculators',
        tabSettings: 'IMA & Settings',
        localPill: 'Local Offline Audit',
        statusReadyFile: 'IMA Ready',
        statusReadyEnv: 'IMA Ready (Env)',
        statusReadyMixed: 'IMA Ready (Mixed)',
        statusMissing: 'IMA unset (offline engines ready)',
        defaultKbBound: 'KB: ',
        defaultKbNone: 'No default KB',
        dropTitle: 'Drop statements / .ZIP',
        dropSub: 'Supports 8 sales platforms + 3 settlement wallets (WorldFirst, Payoneer, Airwallex) · 100% local in-memory parsing',
        pickFiles: 'Drop / Pick .ZIP',
        runDemo: 'Classic 3-platform demo',
        runDemoV7: 'v0.7 PayPal/AE/Shopee demo',
        runDemoV8: 'v0.8 3-stage fund chain demo',
        parsing: 'Parsing…',
        recalcBtn: 'Recalculate FX',
        saveFxDefault: 'Save default FX',
        resetFxDefault: 'Reset FX',
        exportHtml: 'Export HTML Report',
        exportMd: 'Export Markdown',
        exportCsv: 'Export Anomaly CSV',
        exportTrendHtml: 'Export 12M Trend HTML',
        declaredLabel: 'Declared VAT / Export Sales (CNY)',
        platformAuto: 'Auto (11 channels)',
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
        copied: 'Copied ✓',
        savedOk: 'Credentials saved to ~/.config/ima/',
        clearedOk: 'Local IMA credentials cleared',
        kbBoundOk: 'Default knowledge base updated',
      },
    }

    const DEFAULT_FX = {
      USD: 7.18, EUR: 7.82, GBP: 9.15, AUD: 4.72, CAD: 5.18, JPY: 0.047,
      SGD: 5.36, MYR: 1.62, THB: 0.21, VND: 0.00028, PHP: 0.125, IDR: 0.00046,
      BRL: 1.26, MXN: 0.36, TWD: 0.22, HKD: 0.92, RMB: 1, CNY: 1,
    }

    const ADAPTERS = ['PayPal', 'AliExpress', 'Shopee', 'Amazon', 'TikTok Shop', 'Temu', 'Shopify', 'Stripe']
    const WALLET_ADAPTERS = ['WorldFirst', 'Payoneer', 'Airwallex']

    const CALC_SCENARIOS = [
      {
        code: 'platform_tax_reconcile', group: 'audit', zh: '平台报送四层口径桥接', en: '4-Layer Platform Tax Bridge',
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
          { key: 'actualPayout', label: '实际银行放款（元，可选）', def: '' },
        ],
        advancedFields: [
          { key: 'subsidies', label: '平台出资补贴/赔付（元）', def: '0' },
          { key: 'subsidiesIncludedInGross', label: '上述毛额已含本次填写的补贴', type: 'bool', def: true },
          { key: 'withheldTaxIncludedInGross', label: '上述毛额已含本次填写的境外代扣税', type: 'bool', def: true },
          { key: 'selfRemitTaxNet', label: '非代扣待自申报税净额（元）', def: '0' },
          { key: 'reserveChange', label: '准备金净变动（+冻结/-释放）', def: '0' },
          { key: 'principalRole', label: '会计主体责任角色', type: 'select', def: 'principal', options: [{ value: 'principal', label: '主要责任人（总额法）' }, { value: 'agent', label: '代理人（净额法）' }] },
        ],
      },
      {
        code: 'vat_taxpayer_threshold', group: 'audit', isNew: true, zh: '500 万一般纳税人临界拐点', en: '5M General Taxpayer Cliff',
        desc: '核对年应征增值税销售额、一般纳税人登记与小规模月／季起征点，并试算进项抵扣的临界成本。',
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
        advancedFields: [{ key: 'citRate', label: '法定企业所得税率（默认 0.25）', def: '0.25' }],
      },
      {
        code: 'export_invoice_breakeven', group: 'export', zh: '供应商开票加点毛利临界', en: 'Invoice Markup Breakeven g*',
        desc: '对比加税点拿专票走免退税 vs 综试区合规无票免税，算出盈亏临界点 g* 与税后净利。',
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
        code: 'cbec_return_duty_exempt', group: 'export', isNew: true, zh: '2026 第16号退运免税测算', en: '2026 #16 Return Duty Exemption',
        desc: '核验 2026–2027 年申报的跨境电商出口批次，按原状非食品、滞销或退货、六个月期限和出口退税证明判断专项资格。',
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
        code: 'export_rebate_manufacturer', group: 'export', isNew: true, zh: '生产企业“免、抵、退”税', en: 'Manufacturer Exempt-Credit-Refund',
        desc: '工贸一体/工厂卖家出口自产货物五步法精算：应退税额、免抵税额（含城建附加税预警）与留抵结转。',
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
        code: 'export_rebate', group: 'export', zh: '外贸企业出口免退税', en: 'Trading Export VAT Rebate',
        desc: '按专票不含税额与征退税率孰低规则精算应退税额及征退税率差转成本。',
        fields: [
          { key: 'purchaseAmount', label: '进项专票不含税金额（元）', def: '500000' },
          { key: 'vatRate', label: '专票适用征税率（如 0.13）', def: '0.13' },
          { key: 'rebateRate', label: '商品出口退税率（如 0.09）', def: '0.09' },
        ],
      },
      {
        code: 'annual_bonus_iit', group: 'general', zh: '年终奖个税与一元陷阱', en: 'Annual Bonus IIT Cliff',
        desc: '除以 12 找档单独计税，检测多发 1 元到手反少几千元的临界倒挂区间。',
        fields: [{ key: 'bonus', label: '全年一次性奖金总额（元）', def: '36001' }],
      },
      {
        code: 'cross_border_import', group: 'general', zh: '跨境零售进口综合税', en: 'Cross-Border Retail Import Tax',
        desc: '限额内 0 关税 + 70% 折算与消费税组成计税价格反算，含单次 5000 / 年度 26000 预警。',
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
      return h('svg', p, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 8v4l2.5 2' }))
    }

    /** Dieter Rams 精密机械双指针 SVG 表盘（动态生成 101 条刻度、警戒红弧与平滑旋转橙色指针）。 */
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
      body.dark .ftx-root, .dark .ftx-root, [data-theme="dark"] .ftx-root {
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
      .ftx-root { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow-x: hidden; container-type: inline-size; container-name: ftx; }
      .ftx-mono { font-family: var(--ftx-mono); font-variant-numeric: tabular-nums; }
      .ftx-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px 12px; min-width: 0; max-width: 100%; }
      .ftx-h1 { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; font-size: 24px; font-weight: 700; letter-spacing: -0.8px; margin: 0; line-height: 1.25; min-width: 0; }
      .ftx-h1 span { font: 12.5px var(--ftx-mono); color: var(--ftx-mut); letter-spacing: 0; font-weight: 500; }
      .ftx-kb-pill { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-width: 0; border: 1px solid var(--ftx-chassis-bd); border-radius: 4px; padding: 6px 11px; font-size: 12px; color: var(--ftx-ink); background: var(--ftx-surface); }
      .ftx-kb-pill-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .ftx-kb-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
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
      .ftx-lcd {
        margin: 11px 0 13px; padding: 14px 16px 12px; border: 1px solid var(--ftx-lcd-bd); border-radius: 3px;
        background: var(--ftx-lcd); box-shadow: inset 0 2px 5px rgba(70,84,52,0.22); min-width: 0;
      }
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
      .ftx-risk-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) max-content; align-items: start; gap: 10px; padding: 9px 2px; border-bottom: 1px solid var(--ftx-line); font-size: 12.8px; }
      .ftx-sev { display: inline-grid; place-items: center; font: 600 10.5px var(--ftx-mono); height: 20px; border-radius: 2px; width: 28px; background: var(--ftx-th-bg); color: var(--ftx-mut); border: 1px solid var(--ftx-line); margin-top: 1px; }
      .ftx-sev.p0 { background: var(--ftx-orange); border-color: var(--ftx-orange); color: #fff8e9; }
      .ftx-sev.p1 { background: var(--ftx-gap-bg); border-color: var(--ftx-gap-bd); color: var(--ftx-gap-fg); }
      .ftx-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 175px), 1fr)); gap: 9px; border-top: 1px solid var(--ftx-chassis-bd); padding-top: 14px; width: 100%; max-width: 100%; }
      .ftx-act { height: 44px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--ftx-chassis-bd); border-radius: 4px; background: var(--ftx-btn-bg); color: var(--ftx-ink); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background 0.14s, border-color 0.14s, transform 0.12s; min-width: 0; max-width: 100%; }
      @container ftx (max-width: 620px) { .ftx-inst-left, .ftx-inst-right { padding: 13px 14px 12px; } .ftx-h1 { font-size: 20px; } }
      .ftx-act:hover:not(:disabled) { background: var(--ftx-btn-hover); transform: translateY(-0.5px); }
      .ftx-act:disabled { opacity: 0.5; cursor: not-allowed; }
      .ftx-act.pri { background: var(--ftx-btn-pri-bg); color: var(--ftx-btn-pri-fg); border-color: var(--ftx-btn-pri-bg); }
      .ftx-act.pri:hover:not(:disabled) { filter: brightness(1.08); }
      .ftx-act.drop { border-style: dashed; background: var(--ftx-paper); }
      .ftx-act.drop.is-drag { border-color: var(--ftx-orange); background: var(--ftx-gap-bg); }
      .ftx-btn-sm { padding: 5px 10px; border-radius: 3px; border: 1px solid var(--ftx-chassis-bd); background: var(--ftx-btn-bg); color: var(--ftx-ink); font-size: 11.8px; font-weight: 600; cursor: pointer; transition: all 0.14s; }
      .ftx-btn-sm:hover:not(:disabled) { background: var(--ftx-btn-hover); }
      .ftx-btn-sm.on { background: var(--ftx-btn-pri-bg); color: var(--ftx-btn-pri-fg); border-color: var(--ftx-btn-pri-bg); }
      .ftx-btn-sm.danger { color: var(--ftx-orange); border-color: var(--ftx-gap-bd); background: transparent; }
      .ftx-input { padding: 7px 10px; border-radius: 3px; border: 1px solid var(--ftx-chassis-bd); background: var(--ftx-input-bg); color: var(--ftx-ink); font-size: 13px; font-family: var(--ftx-mono); outline: none; max-width: 100%; min-width: 0; }
      .ftx-input:focus { border-color: var(--ftx-orange); box-shadow: 0 0 0 2px rgba(197,75,30,0.18); }
      .ftx-panel { background: var(--ftx-chassis); border: 1px solid var(--ftx-chassis-bd); border-radius: 6px; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
      .ftx-nav-btn { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 6px; text-align: left; padding: 8.5px 11px; border: none; border-radius: 3px; background: transparent; color: var(--ftx-ink); font-size: 12.8px; font-weight: 500; cursor: pointer; }
      .ftx-nav-btn:hover { background: var(--ftx-btn-hover); }
      .ftx-nav-btn.is-active { background: var(--ftx-btn-pri-bg); color: var(--ftx-btn-pri-fg); font-weight: 650; }
      .ftx-adapters { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; padding: 8px 10px; border-radius: 4px; background: var(--ftx-surface); border: 1px solid var(--ftx-line); font: 11px var(--ftx-mono); color: var(--ftx-mut); }
      .ftx-adp { display: inline-flex; align-items: center; gap: 5px; }
      .ftx-adp i { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--ftx-mut); display: inline-block; }
      .ftx-adp.used { color: var(--ftx-ink); font-weight: 700; }
      .ftx-adp.used i { background: var(--ftx-orange); border-color: var(--ftx-orange); }
      .ftx-adp.wallet.used i { background: var(--ftx-ok); border-color: var(--ftx-ok); }
      .ftx-chain { background: var(--ftx-chassis); border: 1px solid var(--ftx-chassis-bd); border-radius: 6px; padding: 14px 18px; display: flex; flex-direction: column; gap: 11px; }
      .ftx-chain-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 175px), 1fr)); gap: 10px; }
      .ftx-chain-cell { background: var(--ftx-surface); border: 1px solid var(--ftx-line); border-radius: 4px; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
      .ftx-chain-cell.ok { border-color: var(--ftx-ok); }
      .ftx-chain-cell.danger { border-color: var(--ftx-orange); background: var(--ftx-gap-bg); }
      .ftx-chain-bar { height: 9px; border-radius: 2px; overflow: hidden; display: flex; background: var(--ftx-line); gap: 1px; }
      .ftx-tag-w { display: inline-block; font: 600 10px var(--ftx-mono); padding: 1px 5px; border-radius: 2px; background: var(--ftx-th-bg); color: var(--ftx-ok); border: 1px solid var(--ftx-line); margin-left: 5px; vertical-align: middle; }
    `

    function ensureStyles() {
      if (typeof document === 'undefined') return
      const prev = document.getElementById('dsh-fintax-style-v7')
      if (prev) prev.remove()
      const el = document.createElement('style')
      el.id = 'dsh-fintax-style-v7'
      el.textContent = FTX_CSS
      document.head.appendChild(el)
    }

    const API_BASE = (() => {
      try { return new URL('api/fintax', document.baseURI).pathname } catch { return '/api/fintax' }
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
        try { json = txt ? JSON.parse(txt) : {} } catch { json = { error: txt.slice(0, 200) } }
        if (!res.ok) {
          const apiErr = new Error(json?.error || `HTTP ${res.status}`)
          apiErr.status = res.status
          apiErr.data = json
          throw apiErr
        }
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

    function StatementRadarTab({ t, status, refreshStatus, onCopyText, copiedKey, onJumpToCalc }) {
      const [dragging, setDragging] = useState(false)
      const [platform, setPlatform] = useState('auto')
      const [uploadedFiles, setUploadedFiles] = useState([])
      const [demoMode, setDemoMode] = useState('')
      const [fxMap, setFxMap] = useState({ USD: '7.18', EUR: '7.82', GBP: '9.15', AUD: '4.72', MYR: '1.62', SGD: '5.36' })
      const fxDirtyRef = useRef(false)
      const [fxSaveMsg, setFxSaveMsg] = useState('')
      const [declaredCny, setDeclaredCny] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [data, setData] = useState(null)
      const [sevFilter, setSevFilter] = useState('ALL')
      const [platFilter, setPlatFilter] = useState('ALL')
      const [showAllAnoms, setShowAllAnoms] = useState(false)
      const [showFxBar, setShowFxBar] = useState(false)
      const [showHistList, setShowHistList] = useState(false)
      const [histState, setHistState] = useState({ history: [], rolling12m: null })
      const [activeEntityFilter, setActiveEntityFilter] = useState('')
      const [snapEntity, setSnapEntity] = useState('')
      const [snapStore, setSnapStore] = useState('')
      const [snapVatType, setSnapVatType] = useState('unknown')
      const [snapCitMode, setSnapCitMode] = useState('unknown')
      const [snapZeroSales, setSnapZeroSales] = useState(false)
      const [snapConflict, setSnapConflict] = useState(null)
      const [snapLabel, setSnapLabel] = useState('')
      const [snapMonth, setSnapMonth] = useState('')
      const [snapMsg, setSnapMsg] = useState('')
      const [includeAppendix, setIncludeAppendix] = useState(false)

      // 载入本机持久化的自定义汇率预设（仅在用户尚未手动修改草稿时同步，防止晚到响应覆盖编辑）
      useEffect(() => {
        if (fxDirtyRef.current) return
        const saved = status?.customFxRates
        if (saved && typeof saved === 'object' && Object.keys(saved).length > 0) {
          setFxMap((prev) => {
            const next = { ...prev }
            for (const [k, v] of Object.entries(saved)) next[k] = String(v)
            return next
          })
        }
      }, [status?.customFxRates])

      const refreshHistory = useCallback(async (entityOverride) => {
        try {
          const ent = entityOverride !== undefined ? entityOverride : activeEntityFilter
          const qs = ent ? `?entity=${encodeURIComponent(ent)}` : ''
          const res = await callApi(`/history${qs}`)
          setHistState({ history: res.history || [], rolling12m: res.rolling12m || null })
        } catch { /* ignore */ }
      }, [activeEntityFilter])

      useEffect(() => { refreshHistory() }, [refreshHistory])

      const runParse = useCallback(async ({ files, demo, fxOverrides, declaredOverride, platOverride, appendixOverride }) => {
        setBusy(true)
        setErr('')
        setSnapMsg('')
        setSnapConflict(null)
        try {
          const useFx = fxOverrides || fxMap
          // 先注入内置参考汇率兜底，再用用户配置覆盖，避免首次解析新币种因缺汇率需点两次按钮
          const numericFx = { ...DEFAULT_FX }
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
            includeResourceAppendix: appendixOverride !== undefined ? appendixOverride : includeAppendix,
          }
          if (demo) payload.demo = demo
          else payload.files = files

          const res = await callApi('/parse', { method: 'POST', body: JSON.stringify(payload), timeout: 45000 })
          setData(res)
          setSevFilter('ALL')
          setPlatFilter('ALL')
          setShowAllAnoms(false)
          const firstPeriod = (res.summaries || []).find((s) => /^\d{4}-\d{2}/.test(s.period))?.period?.slice(0, 7) || new Date().toISOString().slice(0, 7)
          setSnapMonth(firstPeriod)
          const plats = [...new Set((res.summaries || []).map((s) => s.platform))]
          const salesPlats = [...new Set((res.summaries || []).filter((s) => s.role !== 'settlement_wallet').map((s) => s.platform))]
          setSnapStore((salesPlats.length ? salesPlats : plats).join('+'))
          setSnapLabel(`${firstPeriod} ${plats.join('+')} 月结核对`)
          setSnapZeroSales(false)
          const nextFx = { ...useFx }
          for (const s of res.summaries || []) {
            if (s.currency && s.currency !== 'RMB' && s.currency !== 'CNY' && s.currency !== 'UNKNOWN' && !nextFx[s.currency]) {
              nextFx[s.currency] = String(DEFAULT_FX[s.currency] || 7.0)
            }
          }
          setFxMap(nextFx)
        } catch (e) {
          setErr(e.message || '解析失败')
        } finally {
          setBusy(false)
        }
      }, [fxMap, declaredCny, platform, includeAppendix])

      const handleSaveFxRates = async () => {
        setFxSaveMsg('')
        try {
          const clean = {}
          for (const [k, v] of Object.entries(fxMap)) {
            const n = Number(v)
            if (Number.isFinite(n) && n > 0) clean[k] = n
          }
          const res = await callApi('/settings', { method: 'POST', body: JSON.stringify({ customFxRates: clean }) })
          fxDirtyRef.current = false
          if (typeof refreshStatus === 'function') refreshStatus(res)
          setFxSaveMsg('默认汇率已保存 ✓')
          if (data) await runParse({ files: uploadedFiles, demo: demoMode, fxOverrides: fxMap })
        } catch (e) {
          setFxSaveMsg(`保存失败：${e.message}`)
        }
      }

      const handleResetFxRates = async () => {
        setFxSaveMsg('')
        try {
          const res = await callApi('/settings', { method: 'POST', body: JSON.stringify({ customFxRates: null }) })
          const baseFx = { USD: '7.18', EUR: '7.82', GBP: '9.15', AUD: '4.72', MYR: '1.62', SGD: '5.36' }
          fxDirtyRef.current = false
          setFxMap(baseFx)
          if (typeof refreshStatus === 'function') refreshStatus(res)
          setFxSaveMsg('已恢复内置参考汇率')
          if (data) await runParse({ files: uploadedFiles, demo: demoMode, fxOverrides: baseFx })
        } catch (e) {
          setFxSaveMsg(`重置失败：${e.message}`)
        }
      }

      const handleExportTrendReport = async () => {
        try {
          const qs = activeEntityFilter ? `?entity=${encodeURIComponent(activeEntityFilter)}` : ''
          const res = await callApi(`/history/report${qs}`)
          if (res?.reportHtml) {
            downloadText(res.reportHtml, '跨境财税12个月滚动风控趋势月报.html', 'text/html;charset=utf-8')
          }
        } catch (e) {
          setErr(`导出趋势月报失败：${e.message}`)
        }
      }

      const handleFiles = async (fileList) => {
        const arr = Array.from(fileList || [])
        if (!arr.length) return
        setBusy(true)
        setErr('')
        try {
          const encoded = []
          for (const f of arr.slice(0, 24)) encoded.push({ name: f.name, dataBase64: await fileToBase64(f) })
          setUploadedFiles(encoded)
          setDemoMode('')
          await runParse({ files: encoded, demo: '' })
        } catch (e) {
          setErr(e.message)
          setBusy(false)
        }
      }

      const handleDemo = async (modeKey) => {
        setUploadedFiles([])
        setDemoMode(modeKey)
        const presetDeclared = modeKey === 'v7' ? '330000' : '580000'
        setDeclaredCny(presetDeclared)
        await runParse({ files: [], demo: modeKey, declaredOverride: presetDeclared })
      }

      const handleSaveSnapshot = async (conflictMode = 'check') => {
        if (!data?.consolidated?.ready) return
        setSnapMsg('')
        try {
          const tv = data.consolidated.totals
          const plats = [...new Set((data.summaries || []).map((s) => s.platform))]
          const res = await callApi('/history', {
            method: 'POST',
            body: JSON.stringify({
              month: snapMonth,
              entityName: snapEntity.trim() || '待认领',
              storeScope: snapStore.trim() || plats.join('+'),
              vatTaxpayerType: snapVatType,
              citAssessedMode: snapCitMode,
              zeroSalesConfirmed: snapZeroSales,
              conflictMode,
              filterEntity: activeEntityFilter,
              label: snapLabel,
              platforms: plats,
              sheetCount: data.summaries.length,
              rowCount: totalRows,
              grossCny: tv.grossCny,
              refundCny: tv.refundCny,
              netSalesCny: tv.netSalesCny,
              feesCny: tv.feesCny,
              payoutCny: tv.payoutCny,
              declaredVatSalesCny: declaredCny || null,
              p0Count: p0.length,
              p1Count: p1.length,
              p2Count: p2.length,
            }),
          })
          setSnapConflict(null)
          setHistState({ history: res.history || [], rolling12m: res.rolling12m || null })
          setSnapMsg(res.deduplicated ? '已覆盖更新原档 ✓' : conflictMode === 'append' ? '已作为补充另存 ✓' : '已归档 ✓')
        } catch (e) {
          if (e.status === 409 && e.data?.conflict) {
            setSnapConflict({ existing: e.data.existing, sourceKey: e.data.sourceKey, message: e.message })
            setSnapMsg('')
          } else {
            setSnapMsg(`失败：${e.message}`)
          }
        }
      }

      const handleDeleteSnapshot = async (id) => {
        try {
          const qs = activeEntityFilter ? `?entity=${encodeURIComponent(activeEntityFilter)}` : ''
          const res = await callApi(`/history/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' })
          setHistState({ history: res.history || [], rolling12m: res.rolling12m || null })
        } catch (e) { setErr(e.message) }
      }

      const allAnoms = (data?.summaries || []).flatMap((s) =>
        (s.anomalies || []).map((a) => ({ ...a, platform: s.platform, scope: `${s.platform}·${s.site}(${s.currency})` })),
      )
      const p0 = allAnoms.filter((a) => a.severity.startsWith('P0'))
      const p1 = allAnoms.filter((a) => a.severity.startsWith('P1'))
      const p2 = allAnoms.filter((a) => a.severity.startsWith('P2'))
      const orderedAnoms = [...p0, ...p1, ...p2]
      const filteredAnoms = orderedAnoms.filter((a) => {
        if (sevFilter !== 'ALL' && !a.severity.startsWith(sevFilter)) return false
        if (platFilter !== 'ALL' && a.platform !== platFilter) return false
        return true
      })
      const visibleAnoms = showAllAnoms ? filteredAnoms : filteredAnoms.slice(0, 12)
      const anomPlatforms = [...new Set(orderedAnoms.map((a) => a.platform).filter(Boolean))]
      const loadedPlats = new Set((data?.summaries || []).map((s) => s.platform))
      const totalRows = (data?.summaries || []).reduce((acc, s) => acc + (s.rawRowCount || 0), 0)
      const sheetCcys = [...new Set((data?.summaries || []).map((s) => s.currency).filter((c) => c && c !== 'RMB' && c !== 'CNY' && c !== 'UNKNOWN'))]
      const activeCcys = sheetCcys.length > 0 ? sheetCcys : Object.keys(fxMap)

      const r12 = histState?.rolling12m
      const hasHistory = Boolean(r12?.snapshotCount || (histState?.history || []).length)
      const consTotals = data?.consolidated?.ready ? data.consolidated.totals : null
      const fundChain = data?.consolidated?.fundChain || null
      const isWalletOnly = Boolean(fundChain && !fundChain.hasSalesEvidence)
      const gaugeNetCny = r12?.snapshotCount ? r12.totalNetSalesCny : (consTotals?.netSalesCny || 0)
      const pct75 = r12?.snapshotCount
        ? (r12.taxYearCliff75mPct !== undefined ? r12.taxYearCliff75mPct : r12.cliff75mPct)
        : (consTotals ? Math.round((consTotals.netSalesCny / 75_000_000) * 10000) / 100 : 0)
      const pct5 = r12?.snapshotCount ? r12.threshold5mPct : (consTotals ? Math.round((consTotals.netSalesCny / 5_000_000) * 10000) / 100 : 0)
      const gaugeAFoot = r12?.snapshotCount && r12.taxYear
        ? `${r12.taxYear} 年 ${r12.taxYearMonthCount || r12.monthCount} 月 · 4% 情景估算`
        : t.assessedGaugeHelp
      const gaugeBFoot = r12?.snapshotCount
        ? `覆盖 ${r12.monthCount}/12 月 · 缺档 ${r12.missingMonthsCount ?? Math.max(0, 12 - r12.monthCount)} 月${r12.zeroSalesMonthsCount > 0 ? ` · 零收入 ${r12.zeroSalesMonthsCount} 月` : ''}`
        : '连续 12 月/4 季 · 须按应税额复核'
      const declDiag = data?.consolidated?.ready && !isWalletOnly ? data.consolidated.reconcile?.declarationDiagnosis : null

      const jumpBridge = () => {
        if (isWalletOnly) {
          setErr('当前为纯结汇通道独立体检模式（不含销售报送额），请合并拖入电商平台结算单后再一键带入四层桥接精算。')
          return
        }
        if (!consTotals) return onJumpToCalc('platform_tax_reconcile', {})
        onJumpToCalc('platform_tax_reconcile', {
          reportedGrossRevenue: String(consTotals.grossCny),
          reportedGrossSource: 'statement_reference',
          refunds: String(consTotals.refundCny),
          marketplaceWithheldTax: '0', cutoffAndFxDiff: '0',
          platformFees: String(consTotals.feesCny),
          subsidies: String(consTotals.subsidyCny),
          subsidiesIncludedInGross: false,
          withheldTaxIncludedInGross: false,
          selfRemitTaxNet: String(consTotals.selfRemitTaxCny),
          reserveChange: String(consTotals.reserveCny),
          actualPayout: consTotals.payoutCny > 0 ? String(consTotals.payoutCny) : '',
          declaredVatSales: declaredCny || '',
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
        // ── 顶部 Dieter Rams 精密主仪器机身（左 LCD 合并对账 + 右双指针滚年监控表盘）──
        h(
          'section',
          { className: 'ftx-instrument' },
          h('span', { className: 'ftx-screw tl', 'aria-hidden': 'true' }),
          h('span', { className: 'ftx-screw tr', 'aria-hidden': 'true' }),
          h('span', { className: 'ftx-screw bl', 'aria-hidden': 'true' }),
          h('span', { className: 'ftx-screw br', 'aria-hidden': 'true' }),
          // 左半机身：橄榄绿 LCD 主屏 + 净销/费用双指标 + 扫描探针
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
                  ? Math.round((fundChain.stage2WalletInboundCny || 0) + (fundChain.stage2OtherInboundCny || 0)).toLocaleString()
                  : consTotals ? Math.round(consTotals.grossCny).toLocaleString() : '0',
              ),
              !data && h('div', { style: { fontSize: 11.5, color: 'var(--ftx-lcd-ink)', opacity: 0.7, marginTop: 4 } }, '拖入原始账单/.ZIP，或点击下方沙盒按钮 10ms 体验全链路排雷'),
              isWalletOnly && h('div', { style: { fontSize: 11, color: 'var(--ftx-lcd-ink)', opacity: 0.82, marginTop: 4 } }, '已严格排除出销售报送额 · 合并拖入电商账单可激活三段核对'),
            ),
            h(
              'div',
              { className: 'ftx-metrics' },
              isWalletOnly
                ? h('div', null, h('label', null, '转出企业户(待核回单)'), h('b', null, `¥${Math.round(fundChain.stage3CorporateRepatriatedCny || 0).toLocaleString()}`))
                : h('div', null, h('label', null, '合并净销售额'), h('b', null, `¥${consTotals ? Math.round(consTotals.netSalesCny).toLocaleString() : '0'}`)),
              isWalletOnly
                ? h('div', null, h('label', null, '结汇通道手续费'), h('b', null, `¥${Math.round(fundChain.walletFeesCny || 0).toLocaleString()}`))
                : h('div', null, h('label', null, '平台佣金及履约费'), h('b', null, `¥${consTotals ? Math.round(consTotals.feesCny).toLocaleString() : '0'}`)),
            ),
            h(
              'div',
              { className: 'ftx-scan' },
              h('i', { className: 'probe' }),
              h('span', null, data ? `已扫描 ${data.summaries.length} 份账单 / ${totalRows} 行` : '待载入原始结算账单'),
              h('span', { className: 'vsep' }),
              h('b', { className: 'ftx-mono' }, data ? `${data.elapsedMs} ms` : '0 ms'),
              h('span', { className: 'vsep' }),
              h('b', { className: 'ftx-mono' }, '0 Token'),
              h(
                'button',
                { type: 'button', className: 'ftx-btn-sm', style: { marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }, onClick: () => setShowFxBar(!showFxBar) },
                showFxBar ? '收起汇率/申报 ▲' : '汇率与申报额 ▼',
              ),
            ),
          ),
          // 12 个月滚动账单风险参考
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
                Array.isArray(r12?.entities) && r12.entities.length > 0 &&
                  h(
                    'select',
                    {
                      value: activeEntityFilter,
                      onChange: (e) => { const v = e.target.value; setActiveEntityFilter(v); refreshHistory(v) },
                      className: 'ftx-input',
                      style: { padding: '2px 6px', fontSize: 11 },
                      title: '按公司主体筛选滚动口径，防止多主体串账',
                    },
                    h('option', { value: '' }, `全部主体 (${histState.history.length})`),
                    ...r12.entities.map((ent) => h('option', { key: ent.name, value: ent.name }, `${ent.name}${ent.unclaimed ? ' [旧档]' : ''} (${ent.count})`)),
                  ),
              ),
              h('span', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', fontWeight: 400 } }, r12?.snapshotCount ? '滚动净额 ' : '当期净额 ', h('b', { className: 'ftx-mono', style: { fontSize: 16, color: 'var(--ftx-ink)' } }, `¥${Math.round(gaugeNetCny).toLocaleString()}`)),
            ),
            h(
              'div',
              { className: 'ftx-meters' },
              h(DialGauge, { code: 'A', title: t.assessedGauge, pct: pct75, warnPct: 73.3, footNote: gaugeAFoot }),
              h(DialGauge, { code: 'B', title: '滚动登记参考 · 500万', pct: pct5, warnPct: 80, footNote: gaugeBFoot }),
            ),
            // 防串账归档身份条（主体 + 店铺 + 账期决定唯一归档身份，显示备注可随意修改）
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 } },
              data && consTotals &&
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
                  h('input', { type: 'month', value: snapMonth, onChange: (e) => setSnapMonth(e.target.value), className: 'ftx-input', style: { padding: '3px 6px', fontSize: 11.5 } }),
                  h('input', { type: 'text', value: snapEntity, onChange: (e) => setSnapEntity(e.target.value), placeholder: '公司主体(防串账)', className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5, flex: '1 1 115px', minWidth: 96 } }),
                  h('input', { type: 'text', value: snapStore, onChange: (e) => setSnapStore(e.target.value), placeholder: '店铺/范围', className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5, flex: '1 1 92px', minWidth: 82 } }),
                  h('button', { type: 'button', className: 'ftx-btn-sm on', onClick: () => handleSaveSnapshot('check') }, '归档'),
                ),
              data && consTotals &&
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', fontSize: 11 } },
                  h('input', { type: 'text', value: snapLabel, onChange: (e) => setSnapLabel(e.target.value), placeholder: '显示备注(改名不改归档身份)', className: 'ftx-input', style: { padding: '2px 6px', fontSize: 11, flex: '1 1 110px', minWidth: 90 } }),
                  h(
                    'select',
                    { value: snapVatType, onChange: (e) => setSnapVatType(e.target.value), className: 'ftx-input', style: { padding: '2px 5px', fontSize: 11 }, title: '增值税纳税人身份' },
                    h('option', { value: 'unknown' }, '增值税:未设'),
                    h('option', { value: 'small_scale' }, '小规模'),
                    h('option', { value: 'general' }, '一般纳税人'),
                  ),
                  h(
                    'select',
                    { value: snapCitMode, onChange: (e) => setSnapCitMode(e.target.value), className: 'ftx-input', style: { padding: '2px 5px', fontSize: 11 }, title: '企业所得税核定状态' },
                    h('option', { value: 'unknown' }, '所得税:未设'),
                    h('option', { value: 'assessed_4pct' }, '4%核定'),
                    h('option', { value: 'audit_actual' }, '查账征收'),
                  ),
                  (consTotals.grossCny <= 0 && consTotals.netSalesCny <= 0) &&
                    h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--ftx-mut)', cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: snapZeroSales, onChange: (e) => setSnapZeroSales(e.target.checked) }), '确认零收入'),
                ),
              snapConflict &&
                h(
                  'div',
                  { className: 'ftx-gap', style: { padding: '7px 10px', fontSize: 11.5, gap: 6 } },
                  h('i', { className: 'att' }, '!'),
                  h('span', { style: { flex: '1 1 180px' } }, `已存在同主体同店铺同账期归档（${snapConflict.existing?.entityName} · ${snapConflict.existing?.storeScope} · ${snapConflict.existing?.month}，原净额 ¥${Number(snapConflict.existing?.netSalesCny || 0).toLocaleString()}），请确认：`),
                  h('button', { type: 'button', className: 'ftx-btn-sm on', onClick: () => handleSaveSnapshot('replace') }, '覆盖替换原档'),
                  h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => handleSaveSnapshot('append') }, '作为补充另存'),
                  h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => setSnapConflict(null) }, '取消'),
                ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                snapMsg && h('span', { style: { fontSize: 11.5, fontWeight: 700, color: snapMsg.includes('失败') ? 'var(--ftx-orange)' : 'var(--ftx-ok)' } }, snapMsg),
                hasHistory &&
                  h(
                    'button',
                    { type: 'button', className: 'ftx-btn-sm', style: { marginLeft: 'auto' }, onClick: () => setShowHistList(!showHistList) },
                    showHistList ? '收起归档明细 ▲' : `管理 ${histState.history.length} 份归档 ▼`,
                  ),
              ),
            ),
          ),
        ),
        // 可折叠：汇率与已申报额微调条 + 历史归档清单
        (showFxBar || (data && !consTotals)) &&
          h(
            'div',
            { className: 'ftx-panel', style: { padding: '12px 16px', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 } },
            ...activeCcys.map((ccy) =>
              h(
                'div',
                { key: ccy, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                h('label', { style: { fontSize: 11, color: 'var(--ftx-mut)', fontWeight: 600 } }, `${ccy} 折人民币汇率`),
                h('input', { type: 'number', step: '0.01', value: fxMap[ccy] ?? '', onChange: (e) => { fxDirtyRef.current = true; setFxMap({ ...fxMap, [ccy]: e.target.value }) }, className: 'ftx-input', style: { width: 96 } }),
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
              h('label', { style: { fontSize: 11, color: 'var(--ftx-mut)', fontWeight: 600 } }, t.declaredLabel),
              h('input', { type: 'number', placeholder: '如 330000', value: declaredCny, onChange: (e) => setDeclaredCny(e.target.value), className: 'ftx-input', style: { width: 165 } }),
            ),
            h('button', { type: 'button', className: 'ftx-btn-sm on', style: { height: 32, padding: '0 14px' }, disabled: busy || !data, onClick: () => runParse({ files: uploadedFiles, demo: demoMode }) }, t.recalcBtn),
            h('button', { type: 'button', className: 'ftx-btn-sm', style: { height: 32 }, onClick: handleSaveFxRates }, t.saveFxDefault),
            h('button', { type: 'button', className: 'ftx-btn-sm', style: { height: 32 }, onClick: handleResetFxRates }, t.resetFxDefault),
            fxSaveMsg && h('span', { style: { fontSize: 11.5, fontWeight: 700, color: fxSaveMsg.includes('失败') ? 'var(--ftx-orange)' : 'var(--ftx-ok)', alignSelf: 'center' } }, fxSaveMsg),
          ),
        showHistList && hasHistory &&
          h(
            'div',
            { className: 'ftx-panel', style: { padding: '12px 16px', gap: 8 } },
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
              h('strong', { style: { fontSize: 13 } }, `12 个月滚动红线追踪雷达（${r12.windowStart} ~ ${r12.windowEnd} · ${r12.snapshotCount} 份归档快照）`),
              h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('button', { type: 'button', className: 'ftx-btn-sm on', onClick: handleExportTrendReport }, t.exportTrendHtml),
                h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => onJumpToCalc('vat_taxpayer_threshold', { rolling12mTaxableSales: '', projectedAnnualGrossSales: '' }, false) }, '核对应税销售额与登记'),
                h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => onJumpToCalc('cbec_assessed_cit', {}, false) }, '按主体试算 4% 核定'),
              ),
            ),
            ...histState.history.slice(0, 12).map((it) => {
              const ent = it.entityName || '待认领'
              return h(
                'div',
                { key: it.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 8px', borderBottom: '1px solid var(--ftx-line)' } },
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' } },
                  h('span', { className: 'ftx-sev' }, it.month.slice(2)),
                  h('span', { className: `ftx-sev ${ent === '待认领' ? 'p1' : ''}`, style: { width: 'auto', padding: '0 6px' } }, ent),
                  h('strong', null, it.storeScope || it.label),
                  it.label && it.label !== it.storeScope && h('span', { style: { color: 'var(--ftx-mut)' } }, it.label),
                  it.zeroSalesConfirmed && h('span', { style: { fontSize: 10.5, color: 'var(--ftx-mut)' } }, '[零收入]'),
                  h('b', { className: 'ftx-mono' }, `¥${Number(it.netSalesCny || 0).toLocaleString()}`),
                ),
                h('button', { type: 'button', className: 'ftx-btn-sm danger', onClick: () => handleDeleteSnapshot(it.id) }, '删除'),
              )
            }),
          ),
        // ── v0.8.1 三段资金链路交叉核对仪表卡（仅当存在结汇通道流水时展示）──
        data?.consolidated?.fundChain && (() => {
          const fc = data.consolidated.fundChain
          const totalIn = (fc.stage2WalletInboundCny || 0) + (fc.stage2OtherInboundCny || 0)
          const hasDenom = totalIn > 0
          const pCorp = hasDenom ? Math.min(100, (fc.stage3CorporateRepatriatedCny / totalIn) * 100) : 0
          const pPers = hasDenom ? Math.min(100 - pCorp, (fc.stage3PersonalWithdrawCny / totalIn) * 100) : 0
          const spendAndUnv = (fc.directSpendCny || 0) + (fc.stage3UnverifiedWithdrawCny || 0)
          const pSpend = hasDenom ? Math.min(100 - pCorp - pPers, (spendAndUnv / totalIn) * 100) : 0
          const retAndFee = (fc.retainedOffshoreCny || 0) + (fc.walletFeesCny || 0) + (fc.frozenOutflowCny || 0)
          const pRet = hasDenom ? Math.min(100 - pCorp - pPers - pSpend, (retAndFee / totalIn) * 100) : 0
          const hasGapDanger = fc.hasSalesEvidence && (Math.abs(fc.stage1to2GapCny || 0) > 100 || (fc.byCurrency || []).some((c) => Math.abs((c.stage1to2Gap || 0) * c.fx) > 100))
          return h(
            'section',
            { className: 'ftx-chain' },
            h(
              'div',
              { className: 'ftx-bhead' },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } }, h('h2', null, '三段资金链路交叉核对'), h('span', { style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, '平台放款 → 结汇通道入账 → 钱包转出至企业户[待核银行回单]（结汇流水绝不重复计税）')),
              h('span', { className: 'ftx-secmeta' }, fc.hasSalesEvidence ? '3-STAGE / PENDING RECEIPT' : 'WALLET ONLY'),
            ),
            h(
              'div',
              { className: 'ftx-chain-grid' },
              h(
                'div',
                { className: 'ftx-chain-cell' },
                h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '① 销售平台实际放款'),
                h('b', { className: 'ftx-mono', style: { fontSize: fc.hasSalesEvidence ? 18 : 14, color: fc.hasSalesEvidence ? 'var(--ftx-ink)' : 'var(--ftx-mut)' } }, fc.hasSalesEvidence ? `¥${Math.round(fc.stage1PlatformPayoutCny).toLocaleString()}` : '待导入销售账单'),
                h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, fc.hasSalesEvidence ? `${fc.salesSheetCount} 份销售账单汇总` : '合并拖入电商账单激活比对'),
              ),
              h(
                'div',
                { className: `ftx-chain-cell${hasGapDanger ? ' danger' : ''}` },
                h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '② 结汇通道平台入账'),
                h('b', { className: 'ftx-mono', style: { fontSize: 18 } }, `¥${Math.round(fc.stage2WalletInboundCny).toLocaleString()}`),
                h(
                  'span',
                  { className: 'ftx-mono', style: { fontSize: 11, color: hasGapDanger ? 'var(--ftx-orange)' : 'var(--ftx-ok)', fontWeight: 700 } },
                  fc.hasSalesEvidence
                    ? `一/二段差 ${fc.stage1to2GapCny >= 0 ? '+' : ''}¥${Math.round(fc.stage1to2GapCny).toLocaleString()}${fc.stage2OtherInboundCny > 0 ? ` · 另其他 ¥${Math.round(fc.stage2OtherInboundCny).toLocaleString()}` : ''}`
                    : `${fc.walletCount} 份结汇流水${fc.stage2OtherInboundCny > 0 ? ` · 其他入账 ¥${Math.round(fc.stage2OtherInboundCny).toLocaleString()}` : ''}`,
                ),
              ),
              h(
                'div',
                { className: 'ftx-chain-cell ok', title: fc.stage3StatusNote || '钱包显示已向企业账户转出，需财务核对银行入账回单后标为已复核' },
                h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '③ 钱包转出至企业户（待核银行回单）'),
                h('b', { className: 'ftx-mono', style: { fontSize: 18, color: 'var(--ftx-ok)' } }, `¥${Math.round(fc.stage3CorporateRepatriatedCny).toLocaleString()}`),
                h('span', { className: 'ftx-mono', style: { fontSize: 11, color: 'var(--ftx-ok)', fontWeight: 700 } }, fc.corporateRepatriationRatePct !== null ? `企业户转出占比 ${fc.corporateRepatriationRatePct}% · 待核回单` : '企业户转出占比 待核'),
              ),
              h(
                'div',
                { className: `ftx-chain-cell${fc.stage3PersonalWithdrawCny > 0 || (fc.stage3UnverifiedWithdrawCny || 0) > 0 ? ' danger' : ''}` },
                h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, '私户 P0 / 待核 / 坐支 P1'),
                h('b', { className: 'ftx-mono', style: { fontSize: 15, color: fc.stage3PersonalWithdrawCny > 0 ? 'var(--ftx-orange)' : 'var(--ftx-ink)' } }, `¥${Math.round(fc.stage3PersonalWithdrawCny).toLocaleString()} / ¥${Math.round(fc.stage3UnverifiedWithdrawCny || 0).toLocaleString()} / ¥${Math.round(fc.directSpendCny).toLocaleString()}`),
                h('span', { className: 'ftx-mono', style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `滞留境外 ¥${Math.round(fc.retainedOffshoreCny).toLocaleString()} · 费 ¥${Math.round(fc.walletFeesCny).toLocaleString()}`),
              ),
            ),
            hasDenom &&
              h(
                'div',
                { className: 'ftx-chain-bar', title: `转出企业户(待核回单) ${pCorp.toFixed(1)}% / 私户 ${pPers.toFixed(1)}% / 待核与坐支 ${pSpend.toFixed(1)}% / 滞留与费 ${pRet.toFixed(1)}%` },
                pCorp > 0 && h('div', { style: { width: `${pCorp}%`, background: 'var(--ftx-ok)' } }),
                pPers > 0 && h('div', { style: { width: `${pPers}%`, background: 'var(--ftx-orange)' } }),
                pSpend > 0 && h('div', { style: { width: `${pSpend}%`, background: '#d97706' } }),
                pRet > 0 && h('div', { style: { width: `${pRet}%`, background: 'var(--ftx-mut)', opacity: 0.45 } }),
              ),
            fc.stage3StatusNote &&
              h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', lineHeight: 1.45 } }, `口径提示：${fc.stage3StatusNote}`),
            fc.byCurrency && fc.byCurrency.length > 0 &&
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11.5, color: 'var(--ftx-mut)' } },
                ...fc.byCurrency.map((c) =>
                  h(
                    'span',
                    { key: c.currency, className: 'ftx-mono', style: { padding: '2px 7px', border: '1px solid var(--ftx-line)', borderRadius: 3, background: 'var(--ftx-surface)' } },
                    fc.hasSalesEvidence
                      ? `${c.currency}: 放款 ${c.platformPayout.toLocaleString()} → 入账 ${c.walletInbound.toLocaleString()} (${c.stage1to2Gap >= 0 ? '+' : ''}${c.stage1to2Gap.toLocaleString()}) → 转出企业户(待核回单) ${c.corporateWithdraw.toLocaleString()}`
                      : `${c.currency}: 入账 ${c.walletInbound.toLocaleString()} → 转出企业户(待核回单) ${c.corporateWithdraw.toLocaleString()}`,
                  ),
                ),
              ),
          )
        })(),
        // ── 中段双栏审计区：左 原币对账 / 右 异常雷达 ──
        h(
          'div',
          { className: 'ftx-lower' },
          // 左栏：原币对账 + 8 平台适配器指示灯
          h(
            'section',
            { className: 'ftx-block' },
            h('div', { className: 'ftx-bhead' }, h('h2', null, '原币对账'), h('span', { className: 'ftx-secmeta' }, 'FX / RECONCILIATION')),
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--ftx-mut)' } },
              h('span', null, data ? `${data.summaries.length} 份账单 · 逐表 BigInt 定点核验` : '支持 8 销售平台 + 3 结汇通道及 .ZIP 直拖'),
              h(
                'select',
                { value: platform, onChange: (e) => setPlatform(e.target.value), className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5 } },
                h('option', { value: 'auto' }, t.platformAuto),
                h('option', { value: 'amazon' }, 'Amazon'), h('option', { value: 'tiktok' }, 'TikTok Shop'),
                h('option', { value: 'temu' }, 'Temu'), h('option', { value: 'aliexpress' }, '速卖通 AliExpress'),
                h('option', { value: 'shopee' }, 'Shopee 虾皮'), h('option', { value: 'shopify' }, 'Shopify'),
                h('option', { value: 'paypal' }, 'PayPal'), h('option', { value: 'stripe' }, 'Stripe'),
                h('option', { value: 'worldfirst' }, '万里汇 WorldFirst'),
                h('option', { value: 'payoneer' }, '派安盈 Payoneer'),
                h('option', { value: 'airwallex' }, '空中云汇 Airwallex'),
              ),
            ),
            data
              ? h(
                  'div',
                  { style: { overflowX: 'auto' } },
                  h(
                    'table',
                    { className: 'ftx-tbl' },
                    h('thead', null, h('tr', null, h('th', null, '通道 · 站点'), h('th', null, '参考毛额 / 通道入账'), h('th', null, '放款 / 转出企业户(待核回单)'), h('th', null, '资金核验'))),
                    h(
                      'tbody',
                      null,
                      ...data.summaries.map((s, idx) => {
                        const isW = s.role === 'settlement_wallet' && s.walletMetrics
                        return h(
                          'tr',
                          { key: idx },
                          h(
                            'td',
                            null,
                            h('strong', null, `${s.platform} · ${s.site}`),
                            isW && h('span', { className: 'ftx-tag-w' }, '结汇'),
                            h('div', { style: { fontSize: 10.5, color: 'var(--ftx-mut)', fontFamily: 'var(--ftx-mono)' } }, isW ? `${s.period} · 费 ${s.walletMetrics.walletFees}` : `${s.period} · 佣金 ${s.totalFees}`),
                          ),
                          h('td', null, isW ? `${s.currency} ${s.walletMetrics.platformInbound}` : `${s.currency} ${s.taxReportingGrossRef}`),
                          h(
                            'td',
                            null,
                            isW ? s.walletMetrics.fxWithdrawToCorporate : s.actualPayout,
                            isW
                              ? h(
                                  'div',
                                  { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 } },
                                  Number(s.walletMetrics.fxWithdrawToPersonal) > 0 && h('span', { style: { fontSize: 10.5, color: 'var(--ftx-orange)', fontWeight: 700 } }, `私户 P0: ${s.walletMetrics.fxWithdrawToPersonal}`),
                                  Number(s.walletMetrics.unverifiedWithdraw) > 0 && h('span', { style: { fontSize: 10.5, color: 'var(--ftx-orange)' } }, `待核: ${s.walletMetrics.unverifiedWithdraw}`),
                                  Number(s.walletMetrics.directSpend) > 0 && h('span', { style: { fontSize: 10.5, color: 'var(--ftx-mut)' } }, `坐支 ${s.walletMetrics.directSpend}`),
                                )
                              : Number(s.actualPayout) !== 0 && h('div', { title: t.payoutDiffHelp, style: { fontSize: 10.5, color: 'var(--ftx-mut)' } }, `${t.payoutDiff} ${s.statementPayoutDiff}`),
                          ),
                          h(
                            'td',
                            null,
                            isW && s.walletMetrics.netVerifiedRows === 0
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
                  { style: { padding: '22px 16px', border: '1px dashed var(--ftx-chassis-bd)', borderRadius: 4, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 11, alignItems: 'center' } },
                  h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--ftx-ink)' } }, '本机离线核对平台放款、结汇入账与待补凭证'),
                  h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, '无需配置 IMA，原始账单留在本机内存不上传，10ms 输出老板与财务核对单'),
                  h(
                    'div',
                    { style: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' } },
                    h('button', { type: 'button', className: 'ftx-act pri', style: { height: 38, padding: '0 16px' }, disabled: busy, onClick: () => handleDemo('v8') }, t.runDemoV8),
                    h(
                      'label',
                      { className: 'ftx-act drop', style: { height: 38, padding: '0 16px' } },
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
              h('span', { style: { fontWeight: 700, color: 'var(--ftx-ink)' } }, '销售 08'),
              ...ADAPTERS.map((adp) => {
                const used = [...loadedPlats].some((p) => p.toLowerCase().includes(adp.toLowerCase().split(' ')[0]))
                return h('span', { key: adp, className: `ftx-adp${used ? ' used' : ''}` }, h('i', null), adp)
              }),
              h('span', { style: { fontWeight: 700, color: 'var(--ftx-ok)', marginLeft: 4 } }, '结汇 03'),
              ...WALLET_ADAPTERS.map((adp) => {
                const used = [...loadedPlats].some((p) => p.toLowerCase().includes(adp.toLowerCase()))
                return h('span', { key: adp, className: `ftx-adp wallet${used ? ' used' : ''}` }, h('i', null), adp)
              }),
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--ftx-mut)' } }, h(Icon, { kind: 'chip', size: 14 }), '原始账单明细仅在本机内存解析 · 不外传'),
          ),
          // 右栏：异常雷达 + 待核查申报缺口警示条 + P0/P1/P2 机械筛选
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
            orderedAnoms.length > 0 &&
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
                h('button', { type: 'button', className: `ftx-btn-sm${sevFilter === 'ALL' ? ' on' : ''}`, onClick: () => setSevFilter('ALL') }, `全部 (${orderedAnoms.length})`),
                h('button', { type: 'button', className: `ftx-btn-sm${sevFilter === 'P0' ? ' on' : ''}`, onClick: () => setSevFilter('P0') }, `P0 (${p0.length})`),
                h('button', { type: 'button', className: `ftx-btn-sm${sevFilter === 'P1' ? ' on' : ''}`, onClick: () => setSevFilter('P1') }, `P1 (${p1.length})`),
                h('button', { type: 'button', className: `ftx-btn-sm${sevFilter === 'P2' ? ' on' : ''}`, onClick: () => setSevFilter('P2') }, `P2 (${p2.length})`),
                anomPlatforms.length > 1 &&
                  h(
                    'select',
                    { value: platFilter, onChange: (e) => setPlatFilter(e.target.value), className: 'ftx-input', style: { padding: '3px 7px', fontSize: 11.5, marginLeft: 'auto' } },
                    h('option', { value: 'ALL' }, '全部平台'),
                    ...anomPlatforms.map((pl) => h('option', { key: pl, value: pl }, pl)),
                  ),
              ),
            !data
              ? h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', padding: '18px 4px', lineHeight: 1.6 } }, '载入账单后自动扫描：全托管混表阻断（P0）、余额坐支海外广告、Shopee 运费倒挂/预提税 WHT、自收境外 VAT 及 PayPal 换汇剥离。')
              : filteredAnoms.length === 0
                ? h('div', { style: { fontSize: 12.5, color: 'var(--ftx-ok)', fontWeight: 700, padding: '10px 2px' } }, orderedAnoms.length === 0 ? '✔ 全部明细行扫描完毕，未检出异常交易。' : '当前筛选条件下无匹配异常。')
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', maxHeight: 205, overflowY: 'auto' } },
                    ...visibleAnoms.map((a, idx) => {
                      const sevCode = a.severity.slice(0, 2)
                      const sevCls = sevCode === 'P0' ? 'p0' : sevCode === 'P1' ? 'p1' : ''
                      const qaPrompt = `我在账单体检中检出 [${a.severity}] ${a.scope} ${a.category}（金额 ${a.amount}）：${a.detail}。请先检索我的 IMA 财税知识库，给出对应的现行政策文号与合规整改步骤。`
                      return h(
                        'div',
                        { key: `${a.refId}-${idx}`, className: 'ftx-risk-row', title: a.detail },
                        h('span', { className: `ftx-sev ${sevCls}` }, sevCode),
                        h(
                          'div',
                          { style: { minWidth: 0 } },
                          h('div', { style: { fontWeight: 600, lineHeight: 1.35 } }, `${a.category} `, h('span', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `· ${a.scope}`)),
                          h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', marginTop: 2, lineHeight: 1.4 } }, a.detail),
                        ),
                        h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 } },
                          h('b', { className: 'ftx-mono', style: { fontSize: 12 } }, a.amount),
                          h('button', { type: 'button', className: 'ftx-btn-sm', style: { padding: '2px 7px', fontSize: 10.5 }, onClick: () => onCopyText(`anom-${idx}`, qaPrompt) }, copiedKey === `anom-${idx}` ? t.copied : '查 IMA SOP'),
                        ),
                      )
                    }),
                    filteredAnoms.length > 12 &&
                      h('button', { type: 'button', className: 'ftx-btn-sm', style: { alignSelf: 'flex-start', marginTop: 8 }, onClick: () => setShowAllAnoms(!showAllAnoms) }, showAllAnoms ? '收起异常列表' : `展开全部 ${filteredAnoms.length} 条异常`),
                  ),
          ),
        ),
        // ── 底部四联精密实体操作键排（对齐 Dieter Rams 样片底栏）──
        h(
          'section',
          { className: 'ftx-actions' },
          h(
            'label',
            { className: `ftx-act drop${dragging ? ' is-drag' : ''}` },
            h(Icon, { kind: 'upload', size: 16 }),
            h('span', null, busy ? t.parsing : t.pickFiles),
            h('small', { style: { fontSize: 10.5, color: 'var(--ftx-mut)', fontWeight: 500 } }, '11 通道支持'),
            h('input', { type: 'file', multiple: true, accept: '.csv,.tsv,.txt,.xlsx,.xlsm,.zip', style: { display: 'none' }, onChange: (e) => { handleFiles(e.target.files); e.target.value = '' } }),
          ),
          h('button', { type: 'button', className: 'ftx-act pri', disabled: isWalletOnly, title: isWalletOnly ? '纯结汇通道未含销售报送额，请合并拖入电商账单' : '', onClick: jumpBridge }, h('span', null, isWalletOnly ? '需合并销售账单方能桥接' : '一键带入四层桥接精算 →')),
          h('button', { type: 'button', className: 'ftx-act', disabled: !data, onClick: () => data && downloadText(data.reportHtml, '跨境月结核对单.html', 'text/html;charset=utf-8') }, h(Icon, { kind: 'download', size: 16 }), t.exportHtml),
          h('button', { type: 'button', className: 'ftx-act', disabled: !data?.anomaliesCsv, onClick: () => data?.anomaliesCsv && downloadText(data.anomaliesCsv, '财务待核派活清单.csv', 'text/csv;charset=utf-8') }, h(Icon, { kind: 'download', size: 16 }), t.exportCsv),
        ),
        data &&
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 11.5, color: 'var(--ftx-mut)' } },
            h(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { type: 'button', className: 'ftx-btn-sm on', onClick: () => handleDemo('v8') }, t.runDemoV8),
              h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => handleDemo('v7') }, t.runDemoV7),
              h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => handleDemo('all') }, t.runDemo),
              h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => downloadText(data.reportMd, '跨境月结核对单.md', 'text/markdown;charset=utf-8') }, t.exportMd),
              hasHistory && h('button', { type: 'button', className: 'ftx-btn-sm', onClick: handleExportTrendReport }, t.exportTrendHtml),
              h(
                'label',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--ftx-mut)' }, title: '对外核对单默认纯洁无推广，勾选后在文末附带 IMA 与母表参考指引' },
                h('input', {
                  type: 'checkbox',
                  checked: includeAppendix,
                  onChange: (e) => {
                    const nextVal = e.target.checked
                    setIncludeAppendix(nextVal)
                    if (data) runParse({ files: uploadedFiles, demo: demoMode, appendixOverride: nextVal })
                  },
                }),
                '导出时附带参考指引附页',
              ),
            ),
            h('span', null, '边界声明：对外导出默认纯洁无推广；钱包转出至企业户须经财务核对银行入账回单确认'),
          ),
      )
    }

    function buildInitialValues(sc) {
      const obj = {}
      for (const f of [...(sc.fields || []), ...(sc.advancedFields || [])]) obj[f.key] = f.def
      return obj
    }

    function fieldApplies(field, values) {
      return (!field.customsCode || field.customsCode === values.customsCode) &&
        (!field.excludeCustomsCode || field.excludeCustomsCode !== values.customsCode)
    }

    function CalculatorTab({ t, isZh, onCopyText, copiedKey, calcSeed }) {
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

      const sc = CALC_SCENARIOS.find((x) => x.code === activeCode) || CALC_SCENARIOS[0]
      const vals = forms[sc.code] || {}

      const setField = (k, v) => {
        setForms((prev) => ({ ...prev, [sc.code]: { ...(prev[sc.code] || {}), [k]: v } }))
      }

      const runCalc = useCallback(async (targetSc, targetVals) => {
        setBusy(true)
        setErr('')
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
          const res = await callApi('/calc', { method: 'POST', body: JSON.stringify({ scenario: targetSc.code, params }) })
          setResult(res.result)
        } catch (e) {
          setErr(e.message || '试算失败')
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        if (!calcSeed?.scenario) return
        const targetSc = CALC_SCENARIOS.find((x) => x.code === calcSeed.scenario)
        if (!targetSc) return
        const merged = { ...buildInitialValues(targetSc), ...(calcSeed.values || {}) }
        setActiveCode(targetSc.code)
        setForms((prev) => ({ ...prev, [targetSc.code]: merged }))
        setResult(null)
        setErr('')
        const hasAdvOverride = (targetSc.advancedFields || []).some(
          (f) => calcSeed.values?.[f.key] !== undefined && String(calcSeed.values[f.key]) !== '' && String(calcSeed.values[f.key]) !== '0',
        )
        setShowAdv(hasAdvOverride)
        if (calcSeed.autoRun !== false) runCalc(targetSc, merged)
      }, [calcSeed, runCalc])

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

      const groups = [
        { key: 'audit', label: isZh ? '01 · 对账与红线监控' : '01 · Reconcile & Thresholds' },
        { key: 'export', label: isZh ? '02 · 出口退税与退运' : '02 · Export Rebate & Returns' },
        { key: 'general', label: isZh ? '03 · 个税与基础计税' : '03 · IIT & Core Tax' },
      ]

      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' } },
        // 左侧 3 分组精密场景选择盘
        h(
          'div',
          { className: 'ftx-panel', style: { flex: '1 1 230px', minWidth: 0, maxWidth: '100%', padding: '12px 10px', gap: 10 } },
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
                  { key: item.code, type: 'button', className: `ftx-nav-btn${on ? ' is-active' : ''}`, onClick: () => { setActiveCode(item.code); setResult(null); setErr(''); setShowAdv(false) } },
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, isZh ? item.zh : item.en),
                  item.isNew && h('span', { className: 'ftx-sev p0', style: { width: 'auto', padding: '0 5px', height: 17, fontSize: 9.5 } }, 'NEW'),
                )
              }),
            )
          }),
        ),
        // 右侧精密表单 + 橄榄绿 LCD 结论显示屏
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
              h('small', null, sc.isNew ? 'V0.7 / DETERMINISTIC' : '0 TOKEN / LOCAL'),
            ),
            h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', lineHeight: 1.5, marginTop: -6 } }, sc.desc || t.fourLayers),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 185px), 1fr))', gap: 12 } },
              ...sc.fields.filter((f) => fieldApplies(f, vals)).map((f) => h('div', { key: f.key, style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } }, h('label', { style: { fontSize: 11.8, fontWeight: 650, color: 'var(--ftx-mut)' } }, f.label), renderFieldControl(f))),
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
                    ...sc.advancedFields.filter((f) => fieldApplies(f, vals)).map((f) => h('div', { key: f.key, style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } }, h('label', { style: { fontSize: 11.8, fontWeight: 650, color: 'var(--ftx-mut)' } }, f.label), renderFieldControl(f))),
                  ),
              ),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } },
              h('button', { type: 'button', className: 'ftx-act pri', style: { height: 40, padding: '0 20px' }, disabled: busy, onClick: () => runCalc(sc, vals) }, busy ? '计算中…' : '立即代码精算（0 Token）'),
              result && h('button', { type: 'button', className: 'ftx-act', style: { height: 40 }, onClick: () => onCopyText('calc-ai', aiPrompt) }, copiedKey === 'calc-ai' ? t.copied : '复制结果去查 IMA 原文'),
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

    function SettingsTab({ t, status, refreshStatus }) {
      const [clientId, setClientId] = useState('')
      const [apiKey, setApiKey] = useState('')
      const [manualKbId, setManualKbId] = useState('')
      const [kbs, setKbs] = useState([])
      const [saving, setSaving] = useState(false)
      const [testing, setTesting] = useState(false)
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
      )
    }

    function FinTaxWorkbench({ lang, surface = 'settings' }) {
      const isZh = lang !== 'en'
      const t = COPY[isZh ? 'zh' : 'en']
      const [tab, setTab] = useState(surface === 'sidebar' ? 'radar' : 'settings')
      const [status, setStatus] = useState({ loading: true, configured: false, source: 'none', defaultKbId: '', defaultKbName: '', version: '' })
      const [copiedKey, setCopiedKey] = useState('')
      const [calcSeed, setCalcSeed] = useState(null)

      useEffect(() => { ensureStyles() }, [])

      const onJumpToCalc = useCallback((scenario, values, autoRun = true) => {
        setCalcSeed({ scenario, values, autoRun, nonce: Date.now() })
        setTab('calc')
      }, [])

      const refreshStatus = useCallback(async (direct) => {
        try {
          const data = direct || (await callApi('/status'))
          setStatus({ loading: false, ...data })
        } catch {
          setStatus((prev) => ({ ...prev, loading: false }))
        }
      }, [])

      useEffect(() => { refreshStatus() }, [refreshStatus])

      const copyTimerRef = useRef(null)
      useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

      const onCopyText = async (key, text) => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          setCopiedKey(key)
          copyTimerRef.current = setTimeout(() => setCopiedKey(''), 1800)
        } catch { /* ignore */ }
      }

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
            h('div', { className: 'ftx-kb-pill', title: credLabel }, h(Icon, { kind: 'book', size: 15 }), h('span', { className: 'ftx-kb-dot', style: { background: status.configured ? 'var(--ftx-ok)' : 'var(--ftx-orange)' } }), h('span', { className: 'ftx-kb-pill-txt' }, credLabel)),
          ),
          h(
            'div',
            { className: 'ftx-tabs' },
            h('button', { type: 'button', className: `ftx-tab${tab === 'radar' ? ' is-active' : ''}`, onClick: () => setTab('radar') }, t.tabRadar),
            h('button', { type: 'button', className: `ftx-tab${tab === 'calc' ? ' is-active' : ''}`, onClick: () => setTab('calc') }, t.tabCalc),
            h('button', { type: 'button', className: `ftx-tab${tab === 'settings' ? ' is-active' : ''}`, onClick: () => setTab('settings') }, t.tabSettings),
            h('span', { className: 'ftx-local-tag' }, h('i', null), t.localPill),
          ),
          h('div', { style: { display: tab === 'radar' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(StatementRadarTab, { t, status, refreshStatus, onCopyText, copiedKey, onJumpToCalc })),
          h('div', { style: { display: tab === 'calc' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(CalculatorTab, { t, isZh, onCopyText, copiedKey, calcSeed })),
          h('div', { style: { display: tab === 'settings' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(SettingsTab, { t, status, refreshStatus })),
          h(
            'footer',
            { style: { marginTop: 'auto', paddingTop: 10, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--ftx-mut)' } },
            h('span', null, '本地离线初筛 · 结果供人工核查'),
            h('span', { className: 'ftx-mono', style: { letterSpacing: '0.8px' } }, `DSH / FINTAX${status.version ? ` ${status.version}` : ''}`),
          ),
        ),
      )
    }

    return {
      name: 'fintax',
      inject,
      apply(ctx) {
        try {
          const t = ctx.locale.bind(NS)
          ctx.effect(() => ctx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), 'fintax: dictionaries')

          ctx.slots.inject('sidebar.panellist', () => {
            const offPanel = ctx.slots.register(
              { name: 'main', key: PANEL_ID, locale: NS },
              () => h('div', { style: { height: '100%', width: '100%', maxWidth: '100%', minWidth: 0, flex: '1 1 0%', overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box' } }, h(FinTaxWorkbench, { lang: getLang(ctx), surface: 'sidebar' })),
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

          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'fintax', order: 38, label: () => t('nav'), locale: NS },
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

---
name: fintax-calc
description: 税额试算、8 大跨境销售平台 + 3 大第三方结汇通道（万里汇 WorldFirst / 派安盈 Payoneer / 空中云汇 Airwallex）原始账单(.csv/.tsv/.xlsx/.zip)合并体检、三段资金交叉核对与差额桥接工作流。用户提供上述 11 通道原始账单或压缩包(或想用 demo:all / demo:v7 / demo:v8 / demo:wallets / demo:full 免文件体验)，或要算平台涉税报送差额对账、供应商开票加点毛利临界点、2026年第16号退运免税、生产企业免抵退、外贸出口免退税、500万一般纳税人临界拐点、综试区4%核定所得税、年终奖个税、跨境进口综合税、增值税价税分离时使用；必须调用工具做确定性计算，禁止心算报数。
---

# 税额试算、原始账单体检与差额桥接工作流

纪律：**所有账单汇总、税额、临界点与差额勾稽必须来自 `fintax_parse_statement` 或 `fintax_calc` 工具，严禁模型自行读取几千行 CSV 心算累加。**

## 步骤

0. **若用户提供了原始结算账单或结汇流水文件（Amazon / TikTok Shop / Temu / 速卖通 AliExpress / Shopee / Shopify / PayPal / Stripe + 万里汇 WorldFirst / 派安盈 Payoneer / 空中云汇 Airwallex 的 `.csv` / `.tsv` / `.txt` / `.xlsx` 或 `.zip` 压缩包，或要求免文件演示 `demo:all` / `demo:v7` / `demo:v8` / `demo:wallets` / `demo:full`）**：
   - **优先直接调用 `fintax_parse_statement`**：单文件或 `.zip` 传 `file_path`，多月/多站点及第三方结汇流水批量合并传 `file_paths`；单币种汇率传 `fx_rate_to_cny`，多币种合并对账传 `fx_rates`（如 `{"USD": 7.18, "EUR": 7.82, "MYR": 1.62}`）及 `declared_vat_sales_cny`；需要留存或发给团队审阅时传 `export_report_path: "auto"`（可打印 `.html`）、`"auto.md"` 或 `"auto.csv"`（全量异常排雷清单 CSV）；
   - 输出平台报送、财务会计、增值税与出口、企业所得税四层数据，单列资金桥接；若同时传入销售平台账单与第三方结汇流水（WorldFirst / Payoneer / Airwallex），工具自动分轨统计（绝不将结汇入账重复计入销售报送总额）并输出「平台放款 → 结汇通道入账 → 境内对公收汇」三段交叉核对、对公合规回流率、公私混收 P0 阻断与境外余额坐支 P1 预警。若检出 **P0 阻断级异常**（全托管供货混表或提现至个人私户），申报前**必须先提示剥离或整改**；对 PayPal/结汇余额坐支广告物流、Shopee 运费倒挂/预提税 WHT 等 P1 风险结合 `ima_search` 查阅整改规范。

1. **明确口径并选 `fintax_calc` 场景（10 大确定性引擎）**：
   - **平台涉税报送、入账与申报核对** → `platform_tax_reconcile`。平台报送（或账单参考销售额）减实际申报销售额，正数表示前者较高。资金桥接独立列示，实际放款减理论放款，正数表示实际多收。支持 `selfRemitTaxNet`、`subsidies`、`reserveChange`、`cutoffAndFxDiff` 调整及净额法误报预警。
   - **供应商开票加点「拿专票退税 vs 合规无票免税」比选** → `export_invoice_breakeven`（精算盈亏临界加点率 g* 与企业所得税联动净利对比）
   - **2026 年第 16 号公告跨境电商出口退运免税资格与省税测算** → `cbec_return_duty_exempt`。填原出口监管代码、货值、2026–2027 年原出口申报日期 `exportDate`、退运进境日期 `returnDate`、退运原因 `returnReason`、是否原状 `inOriginalCondition`、是否食品 `isFood`、原出口已退税额 `refundedExportTax`（未退填 0）和已补税/未退税证明 `hasTaxCertificate`。已退税的须确认 `exportRefundRepaid`。1210 另填出区离境日 `zoneExitDate` 和退至境内区外 `returnedOutsideZone`。实际出口日与申报日不同时，9610、9710、9810 可另填 `departureDate`。历史批次及普通复运按相应规则另核。
   - **生产企业出口“免、抵、退”税测算（工贸一体/工厂卖家）** → `export_rebate_manufacturer`（五步法精算不得免征抵扣转成本、应退税额、免抵税额与附加税计征预警）
   - **500 万一般纳税人登记临界与进项抵扣拐点测算** → `vat_taxpayer_threshold`。使用连续不超过 12 个月或 4 个季度的累计应征增值税销售额。按 2026–2027 年政策测算小规模当期起征点时，传 `taxPeriod`（`month` 或 `quarter`）及 `periodTaxableSales`（当期不含税销售额，差额征收填扣除后余额）。月销售额等于 10 万元或季销售额等于 30 万元时，以全额计税。未达起征点且对部分交易放弃免税时，填 `periodWaivedSales`。
   - **外贸企业出口免退税（购进货物出口，有进项专票）** → `export_rebate`
   - **综试区零售出口核定企业所得税** → `cbec_assessed_cit`。4% 为适用综试区零售出口的核定应税所得率，按主管税务机关鉴定确认 `assessedQualificationConfirmed`。小型微利企业实际税负 5% 优惠截至 2027-12-31。按企业年度应纳税所得额（`annualTaxableIncome`，≤300 万元）、从业人数（`annualAverageEmployees`，≤300 人）、资产总额（`annualAverageAssets`，≤5,000 万元，人数及资产按全年季度平均）及行业状态（`nonRestrictedIndustry`）核验。7,500 万元是仅按 4% 反推的参考收入；填报企业自身年度数据后另行判断资格。
   - **年终奖个税（单独计税）** → `annual_bonus_iit`（含多发一元临界陷阱检测）
   - **跨境电商零售进口（保税/直购）** → `cross_border_import`
   - **国内销售增值税/价税分离** → `vat`
   - 场景不在支持范围（如个人综合所得年度汇算）时，说明局限并列出公式。
2. **核对政策参数**：若用户已配置 IMA 知识库，调用 `ima_search` / `ima_browse`（已绑定默认库时可省略 `knowledge_base_id`）核对现行税率、商品代码退税率、核定条件。未配置 IMA 或检索无结果时，使用默认参数但**显著标注"参数未经知识库核对，按默认口径试算"**。
3. **调用工具**：调用 `fintax_calc`，比例与税率均传 `0~1` 小数（如加点 8% 传 `0.08`，13% 税率传 `0.13`）。
4. **呈现结果**：
   - 展示工具返回的完整分步计算与勾稽过程；
   - 原样保留风险预警（净额法佣金冲收入、小型微利资格、500 万登记条件、退运专项资格、免抵税额计提附加税、2026 年第 11 号公告第六/七条区分、年终奖临界）；
   - 引用 `policyRefs` 文号并附声明：试算结果用于对账、测算与风险排查，不构成正式纳税申报依据。

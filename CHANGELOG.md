# Changelog

All notable changes to `dsh-fintax` will be documented in this file.

## [0.9.0] - 2026-11-27

### Added (17 Channels, Stage 3 Bank Receipts, 14 Tax Engines, Annual Q1–Q4 & Modular Client)
- **6 New Channels & Amazon v9 Extensions (`lib/platforms_v9.js`, `lib/statement.js`)** — expanding offline coverage from 11 to **17 channels (11 sales platforms + 6 settlement wallets)** plus domestic bank receipts:
  - **3 Domestic Settlement Wallets** (`role: 'settlement_wallet'`, strictly excluded from Stage 1 sales revenue): **LianLian (连连国际)**, **PingPong**, and **SUNRATE (寻汇)** with automatic inclusive/exclusive fee inference, FX spread tracking, corporate suffix recognition, personal-account P0 blocking, offshore direct-spend P1 detection, return-wire offsetting, and sanitized Stage 3 `outboundEvidence`.
  - **3 Major Cross-Border Sales Platforms**: **SHEIN** (full-managed vs semi-managed/POP P0 mix blocking & signed fee reversals), **Walmart** (official long-table Reconciliation Report + wide WFS detail), and **Lazada** (Fee Name / VAT in Amount / Paid Status / WHT & signed commission reversals).
  - **Amazon v9 Extensions**: FR/IT/ES localized Date Range headers & row types, 9 emerging sites (`SE/PL/BE/TR/AE/SA/BR/IN/IE`), and 2027 FBA new fee recognition (Consolidated Aged Monthly Storage, 3.5% AWD/MCD Fuel Surcharge, 6-Tier Oversize Fulfillment).
- **Stage 3 Domestic Corporate Bank Receipt Reconciliation (`lib/bank_receipt.js`, `lib/report.js`, `index.js`)**:
  - Parses domestic bank electronic receipts (CMB / BOC / ICBC / CCB / ABC / BOCOM / Generic) with preamble metadata extraction and non-corporate/personal P0 blocking.
  - Strict fail-closed 5-key exact 1-to-1 matching (`entityKey + account/suffix + period + referenceKey + currency/amount within bank fee window`) isolating reference-only `stage3CandidateMatches` from legal matches; ships built-in 7-file **`demo:v9`** full-chain sandbox.
  - Boss HTML, Markdown, and dispatch CSV reports present Stage 3 matched bank receipts, bank fees, FX spread, in-transit gaps, and reference candidates (zero-promo by default).
- **3 New Cross-Border Tax Engines (`lib/calc_crossborder.js`, `lib/calc.js`, `GET /api/fintax/calc/specs`)** — expanding `fintax_calc` from 11 to **14 deterministic engines** (full 14-engine registry exposed on `GET /api/fintax/calc/specs`):
  - `eu_low_value_parcel`: EU `≤€150` parcel `€3 × HS lines` temporary duty + `€2 × HS lines` non-refundable handling fee (excluded from IOSS), PID VAT-inclusive commission ceil-to-cent reverse pricing with `€150` intrinsic-value regime check, and 3-way EU warehouse comparison.
  - `us_t86_vs_9810_ddp`: US Type 11 direct mail (`≤$2,500` informal entry gate) vs 9810 overseas warehouse DDP unit/monthly margins, `2027-01-15` FBA `+$0.19` toggle, fail-closed IEEPA/CAPE refund check (strictly rejects Section 301/232/122 & incomplete/out-of-window entries; `2026-02-24` cessation cutoff), `ACE ACH Hold` P0 alert, and `2027-01-05` CBP FIOR + `CTPAT-validated` redline.
  - `fba_mixed_procurement_split`: 3-way net profit comparison for mixed invoiced + non-invoiced FBA batches (separating ending input VAT credit carryover from pre-tax operating profit/loss).
- **Archive Schema v4, Natural-Year Q1–Q4 Summary, Reassign & Backup (`lib/history.js`, `lib/annual_report.js`, `index.js`)**:
  - Upgraded local archive schema to `dsh-fintax-history-v4` (backward compatible with v1–v3; non-UUID legacy records are normalized to deterministic UUID primary IDs while preserving `legacyId` for lookup/delete/reassign compatibility) recording Stage 2/3 KPIs, sites, currencies, EU/US signals, and per-platform breakdown.
  - Added `GET /api/fintax/history/annual` (`json`/`html`/`md`) featuring Q1–Q4 quarterly totals, bilateral matched-period gaps (with pending periods/amounts listed separately), strict `entityKey`-based cross-entity anti-mixing guard across all 3 jurisdictions, mixed original+FX estimation (`mixed_estimated`), UK+EUR non-DAC7 guard, `pending_data` incomplete-coverage gating, and refined **3-jurisdiction filing checklists** (China 810 quarterly platform reporting vs internal seller annual reconciliation, EU DAC7 platform `2027-01-31` vs authority exchange `2027-02-28`, US IRS 1099-K TPSO federal `>$20,000` & `>200` txns / PSE separate / recipient copy `2027-02-01` & IRS e-file `2027-03-31` + lower state thresholds).
  - Added `POST /api/fintax/history/reassign` (claim/reassign snapshots preserving stable `entityKey` on shop renames, with HTTP `409` `revision_conflict` vs `source_key_collision` routing) and `GET/POST /api/fintax/history/backup` (UUID-idempotent merge preserving legal appended siblings, prototype-pollution guard, and mandatory HTTP SHA-256 **integrity/corruption checksum** verification — distinct from cryptographic provenance signing).
- **In-Memory Parse Cache & IMA Quick Drawer (`lib/parse_cache.js`, `index.js`)**:
  - `POST /api/fintax/parse` caches parsed summaries strictly in memory (`cacheToken`, bound to host-authenticated exclusive session identity — returns `cacheToken: null` safe fallback when absent, zero disk writes, soft-budget memory estimation); `POST /api/fintax/parse/export` renders HTML/MD/CSV from cache without re-uploading 20 MiB Base64 (`404 CACHE_EXPIRED` graceful fallback saving refreshed `cacheToken`).
  - `POST /api/fintax/ima-quick` provides read-only workbench drawer lookup with strict 3-field plain-text contract (`{ title, folderPath, snippet }`, `≤160`-char snippet, URL/HTML/control-char stripped on all fields, zero internal IDs/full-text/download URLs).
  - `GET /api/fintax/status` declares `supportedChannels: 17`, `calcEngineCount: 14`, and v0.9.0 `capabilities` flags.
- **Modular Zero-Dependency Client Architecture (`src/client/*`, `scripts/build-client.mjs`, `client.js`, `locale/*`)**:
  - Split client bundle into modular source files built deterministically via `npm run build:client` / `npm run check:client` (zero npm dependencies), adding Stage 3 UI, 14-engine forms, Annual Q1–Q4 & Backup/Reassign view, IMA quick drawer, dynamic bilingual subscription, DSH `0.2.3` `conversation.input.dock` feature-probing, and passive `dsh-market` Update API v1 detection.

## [0.8.6] - 2026-11-26

### Fixed (Host Compatibility, Statement Parsing & API Diagnostics)
- **DSH Desktop Dark Theme Selector Alignment (`client.js`)**：在深色主题 CSS 选择器中补充 `body[data-ds-dark-theme] .ftx-root, [data-ds-dark-theme] .ftx-root`，修复在 DSH Desktop `0.2.2+`（`data-ds-dark-theme` 属性）下工作台未能随宿主自动切换暗黑铝壳配色的兼容问题。
- **XLSX Excel Serial Date Decoding (`lib/statement.js`)**：增强 `readXlsxSheets` 解析 `xl/styles.xml`（`<numFmts>` 与 `<cellXfs>`）及 `xl/workbook.xml`（`date1904` 标记），导出 `excelSerialToIsoDate`，将 TikTok Shop / 速卖通 / Shopee / 结汇 `.xlsx` 中纯序列号日期准确还原为 `YYYY-MM-DD`，修复归档账期退化为无日期的问题。
- **Stage 1→2 Dual-Track Candidate Matching (`lib/report.js`, `lib/platforms_v8.js`, `client.js`, `index.js`)**：严守既有 5 键法定核销口径不变（`stage1to2Status` / `stage1to2GapCny` 保持零回归），新增独立脱敏的 **`candidateMatches`（参考级候选配对）**，按同币种 + 账期 + 来源平台展示待补主体/账号/回单确认的金额对照，并在工作台、HTML/MD 诊断报告及工具输出中清晰标注「参考级候选配对（不替代法定 5 键核销）」。
- **`/api/fintax/calc` Validation Error Pass-Through (`lib/calc_shared.js`, `lib/calc.js`, `lib/calc_extra.js`, `index.js`)**：抽象统一 `CalcInputError`（`INVALID_CALC_INPUT`）校验异常；HTTP `/api/fintax/calc` 安全透传脱敏单行中文参数校验说明（HTTP 400、零堆栈泄露），不再笼统吞成「算税失败」。
- **Signed Reversals, Expanded Corporate Suffixes & Stale Lock Self-Heal (`lib/platforms_extra.js`, `lib/platforms_v7.js`, `lib/platforms_v8.js`, `lib/local_store.js`)**：
  - 修正 Temu / AliExpress / Shopee 费用与退款列保留真实符号，避免手续费冲回/退佣触发误报 P0 水平失衡；
  - 扩充第三方结汇对公收款方识别覆盖 `个体工商户 / 商行 / 经营部 / 工作室 / 合伙企业 / 贸易行 / 实业 / 集团 / Pte / GmbH / Sarl / BV / Plc`（严守个人私户与坐支优先拦截）；
  - 增强 `lib/local_store.js` `.lock` 过期僵死锁自愈（默认 `30s` 超时）与短时同步重试，同时保留活跃并发锁的 `LOCAL_DATA_BUSY` 保护。

### Added (11th Tax Engine, Dual-Track Calculators, `ima_read` Pagination & Policy Sync)
- **第 11 大确定性算税引擎 `export_rebate_cancel_impact` (`lib/calc_extra.js`, `lib/calc.js`, `client.js`, `index.js`)**：支持退税率取消/下调（2026年第2号/第29号/第11号第七条视同内销征税 vs 免税不退对照）与 2026#20 电池消费税双税毛利冲击及保毛利需涨价幅度精算，明确区分成品充电宝/成套储能不征电池消费税、2% 减征与新技术免征 CMA 报告硬门禁，以及 2026#2/#29 第三条出口消费税退免照旧（零私域字典硬编码）。
- **年终奖双轨比选升级 (`annual_bonus_iit`) 与 9810/300 万超崖对照 (`cbec_assessed_cit`) (`lib/calc.js`, `client.js`)**：
  - `annual_bonus_iit` 100% 向后兼容旧入参，并新增「单独计税 vs 并入综合所得」双轨对比（支持负值剩余扣除额与工资+扣除项自动推算）及 6 大实务盲区预警；
  - `cbec_assessed_cit` 新增 300 万小微超崖税负跳变对照（`cliffComparison`：多赚 1 元多缴 60 万元）与 9810 次年 4 月核算期未售冲减硬提示。
- **`ima_read` 分段续读 (`offset`) 与 IMA V2.4.2 检索锚点同步 (`index.js`, `lib/ima.js`, `skills/`)**：
  - `ima_read` 新增 `offset` 参数，单次返回 8,000 字并返回 `hasMore` / `nextOffset`，彻底解决长法条/长 SOP 截断；
  - `lib/ima.js` 末尾增补 V2.4.2 热点短词（`CMA`、`锂原电池`、`充电宝`、`年终奖`、`常州`、`225万`、`9610试点`、`1%预缴`、`FIOR`、`CTPAT`、`ViDA`、`DAC7`、`1099-K`、`2026#162` 等）并修复大小写去重；
  - 4 个内嵌技能全面同步 2026 年末关账 4 项硬检、2026#20 锂电与一般光伏电池分期日期、9610 征求意见稿防误读、美线 FIOR `2027-01-05` + `CTPAT-validated` 口径，以及 `--profile desktop` 安装指引。

## [0.8.5] - 2026-11-21

- **IMA V2.4.1 热点短词检索与内置技能口径同步 (`lib/ima.js`, `test/ima.test.js`, `skills/`)**：
  - 在保留全部存量核心检索短词序零回归前提下，增补 `电池`、`消费税`、`电子烟`、`光伏`、`增值税法`、`官方附件` 等 6 组经实库标题验证的新短词锚点，并扩展 `退运`（`16号`）、`欧盟低值包裹`（`临时关税` / `PID` / `C127` / `C128`）、`T86`（`IEEPA` / `CAPE` / `4811` / `301豁免` / `对等关税`）、`退税率调整`（`2号公告` / `362项` / `退税归零`）与 `美国关税` 识别正则；
  - 同步更新 `fintax-policy-qa` 与 `fintax-crossborder-check` 技能清单：覆盖 2026 年第 2 号/第 20 号/第 29 号退税率与电池消费税清单、美线 IEEPA/CAPE/Form 4811 证据链与欧盟低值包裹 PID 核验提示（严守商用护城河纪律，不引入任何私域公式或分录）。
- **开源协作与生态门面刷新 (`.github/ISSUE_TEMPLATE/`, `client.js`, `README.md`, `package.json`, `docs/`)**：
  - 修复工作台主按钮 `.ftx-act.pri:hover` 被通用 `.ftx-act:hover` 优先级覆盖导致悬停底色发白对比度下降的问题；
  - 新增 GitHub Issue 脱敏反馈表单（`new-channel-header.yml` 与 `bug-report.yml`），支持连连/PingPong/寻汇等新渠道仅提交脱敏表头与 2 行虚构示例排期适配；
  - 将 `homepage` 接入互动 3D 官网 <https://fleekelon.github.io/fintax-portal/>，更新 `docs/plugin-index.json` 并重拍 `v0.8.5` 实机 `1440×900` 展示大图。

## [0.8.4] - 2026-11-20

- **IMA V2.3 知识库检索回退对齐 (`lib/ima.js`, `index.js`, `test/ima.test.js`)**：
  - 在保留既有 25 题核心词序零回归前提下，增补 `T86`、欧盟低值包裹（`€2` 处理费）、`全托管`/`半托管`（Temu/SHEIN）、`独立站`（Shopify/支付网关）、`数字产品`/`SaaS`、`加计扣除`、`海关稽查`、`日本站`/`JCT`、`东南亚`、`拉美`/`RFC`、`中东`、`英国PVA`、`EPR`/`CBAM`、`ERP`、`年末关账` 等 V2.3 新增专题短词回退锚点；
  - `ima_read` 针对图片与官方网页条目补充引导至 IMA 客户端核对原图与原文链接的提示。
- **9810 核算期与税前扣凭口径对齐 (`lib/calc.js`)**：
  - `export_rebate` 的 9810 预退税预警明确区分「次年 4 月实际增值税纳税申报期」与「次年 4 月 30 日上界」、提示获准外贸企业例外及到期未售须冲减/缴回并于实际销售后重新申报；
  - `cbec_assessed_cit` 补注「须以核准回执或鉴定文书为准」，`export_invoice_breakeven` 补引 `国家税务总局公告2018年第28号`。
- **文档收口 (`README.md`, `CHANGELOG.md`)**：移除 README 标题中的本地候选字样并标注 `dsh-fintax-history-v3` 归档 schema。

## [0.8.3] - 2026-11-20

- 修复生产企业免抵退试算，覆盖期末留抵为零、低于、等于及高于免抵退上限的情况，并同步应退、免抵及附加税提示。
- 按工作表识别销售与钱包账单，报告漏页及候选冲突。钱包期间净流只采用一次有符号净变动，区分手续费冲回、原提现退汇、余额证据及待核银行回单。
- 独立站订单（Shopify）与支付网关（PayPal / Stripe）同批双导入时自动防重复计入：隔离网关侧金额单列核对、不再叠加销售参考总额，并输出逐笔核对预警。
- 保留正负放款和凭证计数，按主体、账户、平台、币种、账期和凭证核对。缺少币种、汇率或匹配凭证时标记待核，小数金额折算后再舍入。
- 异常和格式诊断默认脱敏。统一 Markdown 与 CSV 编码，限制上传与解压总量，账单解析和导出在独立工作线程执行。
- 客户端丢弃过期请求，导入失败后清除旧结果，确认汇率后才归档。大异常列表分页，改善窄屏排版并释放卸载后的样式和回调。
- 归档（`dsh-fintax-history-v3`）按白名单保存月度 KPI，保护损坏文件并校验账期和替换版本。完整保留多店档案，全主体视图只汇总描述性数据。
- 收紧 Host 准入及 IMA 出站地址和重定向，增加短词实体补查与在途去重。README 标明历史侧栏模拟截图，并同步待核回单口径。

## [0.8.2] - 2026-11-20

### Fixed
- **DSH Desktop Split-Pane Horizontal Clipping (`client.js`)**:
  - Replaced viewport-only `@media (max-width: 860px)` breakpoints with CSS Container Queries (`container-type: inline-size; container-name: ftx; @container ftx (max-width: 960px)`), so DSH Desktop's nested main pane (when left navigation and right panels are open inside a wide window) stacks cleanly without right-edge clipping.
  - Replaced fixed `minmax(300px, ...) minmax(340px, ...)` and fixed `224px` SVG dial widths with `minmax(0, ...)` tracks, proportional `aspect-ratio` SVG scaling, `clamp()` fluid typography, `min-width: 0` / `flex: 1 1 0%` flex containment, and single-line ellipsis truncation on long IMA knowledge-base badges (`.ftx-kb-pill`).

## [0.8.1] - 2026-11-20

### Fixed & Improved (Real-World Monthly Close Hardening)
- **Honest Stage-3 Verification Boundary (`lib/platforms_v8.js`, `lib/report.js`, `index.js`, `client.js`)**:
  - Replaced premature "境内对公合规回流" wording with **"钱包转出至企业户（待核银行回单）"** (`stage3VerificationStatus: 'pending_bank_receipt'`), explicitly noting that wallet beneficiary fields alone cannot prove domestic entity ownership or bank settlement until verified against bank receipts. Clarified P0/P1 as review priority levels.
- **Anti-Collision & Anti-Cross-Entity Archive Identity (`lib/history.js`, `index.js`, `client.js`)**:
  - Upgraded local archive schema to `dsh-fintax-history-v2` (atomic write, backward-compatible migration marking legacy records as `待认领` / `unclaimed`).
  - Decoupled editable display `label` from archive identity: snapshots are keyed strictly by **`entityName + storeScope + month`**, preventing accidental double-counting on rename or cross-store overwrites.
  - Added separate VAT taxpayer type (`small_scale | general | unknown`), CIT 4% assessment status (`assessed_4pct | audit_actual | unknown`), explicit `zeroSalesConfirmed` support (distinguishing missing months vs confirmed zero-sales months), entity-scoped filtering (`GET /history?entity=`, `GET /history/report?entity=`), and HTTP **`409` conflict confirmation flow** (`replace` / `append` / `cancel`).
- **Actionable Reconciliation Sheet & First-Screen Simplification (`lib/report.js`, `client.js`)**:
  - Simplified empty-state workbench first screen to two clear entry CTAs: **"用示例看一张核对单"** (`demo:v8`) and **"核对我的账单"** (drop/pick CSV/XLSX/ZIP, zero IMA setup required).
  - Upgraded HTML & Markdown exports to **"跨境月结核对单"** featuring Section 1 **"本期核对范围与老板一页结论"** (explicit file coverage even at 0 anomalies) and **"财务待核派活清单"** (mapped `下一步待补凭证` next-step proof guidance per anomaly, also exported in CSV).
  - External exported reports are **zero-promo by default** (`includeResourceAppendix = false`); users may optionally check `导出时附带参考指引附页`.
  - Refined dual gauges to **"本纳税年度情景估算（4% 核定假设）"** and **"滚动登记参考（连续 12 月 / 4 季 · 500 万）"** displaying covered, missing, and confirmed zero-sales months separately.
- **50,000-Row Engineering Benchmark & Unknown-Header Diagnostics (`lib/statement.js`, `test/v08.test.js`)**:
  - Unknown-format errors now return sanitized detected column headers (up to 15 header cells, zero transaction row data leaked).
  - Added 50,000-row Amazon statement end-to-end benchmark (parse → reconcile → HTML/CSV export, verified ~314 ms with exact BigInt totals and full CSV anomaly rows).

## [0.8.0] - 2026-11-20

### Added
- **3 Third-Party Settlement Wallet Parsers (`lib/platforms_v8.js`)** — expanding offline coverage from 8 to **11 channels (8 sales platforms + 3 settlement wallets)**:
  - **WorldFirst (万里汇)**, **Payoneer (派安盈)**, and **Airwallex (空中云汇)** (`.csv` / multi-sheet `.xlsx`, CN/EN headers, Chinese currency normalization including `人民币 → CNY`, `UNKNOWN` guard instead of silent USD fallback, and `Total/合计` summary-row filtering).
  - Strict role isolation (`role: 'settlement_wallet'`): settlement wallets are **never double-counted into sales tax reporting gross revenue**, and instead feed a **3-Stage Fund-Chain Cross-Check (`fundChain`)**: `① Platform Payout → ② Wallet Inbound (with per-currency single-sided mismatch alerts) → ③ Corporate Repatriation Rate (%)`, separating **Personal-Account Withdrawals (P0 blocking, zero corporate-keyword bypass)**, **Unverified Beneficiary Withdrawals (P1, excluded from confirmed corporate rate)**, **Offshore Direct Spend (P1 supplier/ads/card)**, **Signed Return/Freeze Flows**, and **Internal FX Conversions**.
  - Added zero-file sandboxes `demo:v8` / `demo:chain` (full 3-sales + 3-wallet 3-stage cross-check) and `demo:wallets` (wallet-only standalone audit mode).
- **Persisted Custom FX Rate Presets (`lib/ima.js`, `index.js`, `client.js`)**:
  - Save/reset custom FX rates locally in `~/.config/ima/fintax_config.json` (`0o600`, atomic write, strict type/range whitelist, preserves disk `defaultKbId` even under `IMA_DEFAULT_KB_ID` env override), with automatic recalculation and draft protection in the workbench.
- **Printable 12-Month Rolling Trend Report (`lib/report.js`, `GET /api/fintax/history/report`, `client.js`)**:
  - Standalone A4 printable Braun-styled HTML report with dual-series inline SVG chart (net sales + actual payout bars), 75M/5M dual threshold progress meters, rolling-window KPI ledger, and `@media print` pagination rules.

### Fixed & Hardened
- Fixed `computeRolling12m()` missing monthly `payoutCny` aggregation so the SVG payout series renders accurately.
- Added idempotent deduplication in `saveSnapshot()` for identical month + label + platform-set saves to prevent accidental double-counting on rolling thresholds, while supporting refund-only months.
- Fixed `demo:amazon` missing `"other"` column and `parseAmazonDateRange` Transfer/Reserve check order (eliminating false P0 horizontal imbalance on built-in demo).
- Hardened cross-platform header mutual exclusion (`Airwallex` / `WorldFirst` / `Payoneer` vs `Shopify` / `PayPal` / `Temu`), unidirectional Net conservation check, `wallet_only` LCD/bridge safeguards, dynamic report section numbering, and HTTP `400`/`413` body-error status codes.

## [0.7.1] - 2026-11-19

- **Braun Precision Instrument Workbench UI (`client.js`)**: Rebuilt the 3-Tab DSH sidebar workbench in a Dieter Rams / Braun industrial aesthetic — matte oat-gray aluminum light chassis & Braun Atelier dark chassis, recessed olive-green LCD readout, dynamic 101-tick SVG dual analog needle gauges (75M cliff & 5M VAT threshold), 8-adapter status indicator strip, and keep-alive tab switching.
- Reconciled platform reporting, financial accounting, VAT and exports, and corporate income tax as four distinct figures. The separate cash bridge uses actual payout minus expected payout. The filing comparison uses the reporting or adjusted reference amount minus filed sales.
- Clarified the tax authority determination required for the 4% assessed income rate and the annual entity-level conditions for small low-profit enterprise relief through 2027. Rolling statement figures are screening indicators.
- Applied Announcement No. 16 of 2026 to eligible return batches declared in 2026–2027, including the 1210 departure date and return destination, customs and refund checks, and referral to ordinary re-import rules when the special exemption is unavailable. Updated general taxpayer registration timing and full-base VAT treatment at the 100,000 and 300,000 yuan thresholds.
- Added deterministic IMA fallback for first-page queries with fewer than two results. Up to three short searches run in parallel. Results are deduplicated and ranked by the number of queries that found each item.

## [0.7.0] - 2026-11-19

### Added
- **3 New Settlement & Wallet Parsers (`lib/platforms_v7.js`)** — expanding total offline coverage from 5 to **8 platforms/wallets**:
  - **PayPal Activity** (`.csv` / `.xlsx`): BigInt horizontal conservation (`Gross + Fee = Net`), automatic currency conversion stripping (prevents double-counting FX transfers as sales), P1 alerts for off-book ad/logistics balance spending, disputes/chargebacks, rolling reserves, and self-remit sales tax.
  - **AliExpress (速卖通)** (`.csv` / `.xlsx`, CN/EN headers): P0 blocking for Choice full-managed vs POP self-operated mixed statements, IOSS/VAT withholding split, affiliate commission & Cainiao logistics reconciliation, and violation penalty alerts.
  - **Shopee (虾皮)** (`.xlsx` multi-sheet / `.csv`, multi-currency MYR/SGD/THB/VND/PHP/IDR/BRL/TWD): P1 shipping fee deficit (运费倒挂) detector, cross-border withholding tax (WHT) tracking, and compliance penalty alerts.
  - Added zero-file sandbox presets: `demo:paypal`, `demo:aliexpress`, `demo:shopee`, `demo:v7`, and `demo:full` (preserving `demo:all` compatibility).
- **3 New Deterministic Tax Calculators (`lib/calc_extra.js`)** — expanding `fintax_calc` from 7 to **10 scenarios**:
  - `cbec_return_duty_exempt`: 2026 Announcement No. 16 cross-border return duty exemption eligibility (9610/9710/9810/1210 vs 0110, 6-month window, non-food original condition, refunded export tax clawback net impact).
  - `export_rebate_manufacturer`: 5-step Exempt-Credit-Refund (免抵退税) calculator for manufacturing exporters, including city maintenance & education surcharge reminders on exempt-credit offsets.
  - `vat_taxpayer_threshold`: 5M CNY rolling 12-month general taxpayer threshold tracker + exact input-invoice breakeven cost ratio calculator (small-scale 1% vs general taxpayer 13%) with export rebate synergy guidance.
- **Rolling 12-Month Audit History & Dual Threshold Radar (`lib/history.js` + `/api/fintax/history`)**:
  - Privacy-preserving local snapshot archive (`~/.config/ima/fintax_history.json`, `0o600`, KPI summaries only — never persists raw order rows).
  - Automatic rolling 12-month aggregation tracking both the **75M CNY (4% assessed CIT 3M cliff)** and **5M CNY general taxpayer threshold**, with monthly bar trend chart in the workbench UI.
- **Workbench Productivity & Exports (`client.js`, `lib/report.js`)**:
  - One-click Tab 1 → Tab 2 handoff: inject consolidated CNY statement metrics directly into `platform_tax_reconcile` or `cbec_assessed_cit` and auto-calculate.
  - Collapsible **Advanced Parameters** drawer in Tab 2 exposing all backend parameters (`subsidies`, `selfRemitTaxNet`, `reserveChange`, `principalRole`, `citRate`, etc.).
  - Anomaly filter pills (`ALL / P0 / P1 / P2`), platform filter, full-list expand toggle, and **UTF-8 BOM Anomaly Audit CSV export** (`auto.csv`, with Excel formula injection protection).

### Improved
- Dark-theme contrast & responsive narrow-screen flex/grid layouts across all 3 workbench tabs (`client.js`).
- Hardened Temu vs AliExpress auto-detection mutual exclusion (`lib/platforms_extra.js`).

## [0.6.0] - 2026-11-19

- Standalone DSH sidebar 3-Tab FinTax Workbench (`sidebar.panellist` + `main` + `settings.section.icon` + `settings.section`) with 0-token offline dropzone & 7 interactive tax calculators.
- IMA OpenAPI exponential backoff retries (429/5xx) & 60s read-only directory cache.
- GitHub Actions CI workflow (Node 20/22) and live UI screenshots.

## [0.5.0] - 2026-11-18

- Temu & Shopify parsers, `.zip` drag-and-drop, UTF-16 support, multi-currency consolidation, 75M cliff radar, sandbox demo, and printable HTML/MD diagnostic reports.

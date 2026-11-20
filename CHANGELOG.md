# Changelog

All notable changes to `dsh-fintax` will be documented in this file.

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

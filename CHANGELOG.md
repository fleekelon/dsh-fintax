# Changelog

All notable changes to `dsh-fintax` will be documented in this file.

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

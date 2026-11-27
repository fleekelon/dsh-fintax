// Braun / Dieter Rams precision instrument stylesheet with light/dark skins & container queries.

export const FTX_CSS = `
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
    `

export function retainStyles() {
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

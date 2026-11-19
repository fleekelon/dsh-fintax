# dsh-fintax — 财税工作台 (v0.6.0)

[![npm version](https://img.shields.io/npm/v/dsh-fintax)](https://www.npmjs.com/package/dsh-fintax)
[![CI](https://github.com/fleekelon/dsh-fintax/actions/workflows/test.yml/badge.svg)](https://github.com/fleekelon/dsh-fintax/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4fc3f7)](https://github.com/topics/dsh-plugin)

<img src="https://raw.githubusercontent.com/fleekelon/dsh-fintax/main/assets/icon.svg" width="80" alt="dsh-fintax icon">

DeepSeek Harness 财税插件：在 DSH 左侧边栏原生嵌入**独立可视化财税工作台（0 Token 拖入五大平台原始账单与 `.zip` 离线排雷 + 7 大确定性交互算税表单 + 一键导出可打印 HTML 老板体检单）**，并结合 **腾讯 IMA 专业知识库** 完成只读法规引证。纯 ESM 零第三方运行时依赖（免装 Python / LibreOffice），开箱即用。

- **左侧边栏独立可视化工作台（`v0.6` 重磅新增，0 Token 毫秒级响应）**：
  - 安装后在 DSH 左侧导航栏直接点击 **「财税工作台」**（同时兼容 **「设置 → 财税工作台」**），无需手写提示词、不消耗大模型 Token；
  - **Tab 1 · 账单离线排雷台**：支持直接拖拽多份账单或 `.zip` 原包（亦支持一键载入三平台沙盒体验），实时展示 P0/P1/P2 异常雷达、**7,500 万小微生死崖进度条**、多币种汇率动态重算与一键导出可打印 `.html / .md` 老板汇报诊断书；
  - **Tab 2 · 7 大确定性交互算税台**：表单化直接精算平台报送四层桥接、开票加点临界 $g^*$、4% 核定 300 万崖、出口免退税、年终奖一元陷阱、跨境进口综合税与价税分离；
  - **Tab 3 · IMA 知识库设置**：免命令行安全保存只读凭证、一键刷新并绑定默认优先库（内置 5xx 指数退避重试与 60s 只读目录缓存，且前端具备宿主崩溃隔离保护）。
- **五大平台原始账单 / `.zip` 压缩包离线合并体检与汇报单导出（`fintax_parse_statement`）**：
  - 支持原样导出的 **Amazon**（Date Range CSV / Flat File V2 全站点）、**TikTok Shop**（Statements 多表 `.xlsx` / `.csv`）、**Temu**（半托管自营 / 全托管供货结算 `.csv` / `.xlsx`）、**Shopify 独立站**（Shopify Payments / Orders `.csv` / `.xlsx`）、**Stripe**（余额流水 `.csv` / `.xlsx`），支持 **`.zip` 账单压缩包免解压直拖**、**`UTF-16` Unicode 文本兼容**及 **`demo:all` 零文件 10ms 沙盒自测**；
  - 纯原生 `BigInt` 定点运算精确到 `0.01` 分：支持 `fx_rates` 多币种合并人民币总对账与 **7,500 万小微核定生死崖进度预警**；自动扫描 **TikTok / Temu 全托管与自营混同 P0 阻断、Shopify/Stripe 自收境外 VAT 剥离、虚拟卡直付广告防坐支、未捕获弃单、拒付争议与履约罚款**；原始订单明细 100% 留在本机内存。
- **桌面端图形化配置页**：打开 DSH **「设置 → 财税工作台」** 免命令行粘贴保存腾讯 IMA 凭证、一键测试连接并绑定**默认优先财税知识库**。
- **7 大代码级确定性算税与差额桥接引擎（`fintax_calc`，免配 IMA 亦可离线使用）**：
  1. **平台涉税报送四层口径差额桥接（`platform_tax_reconcile`）**：拆解平台报送总额 vs 结算实际放款 vs 增值税已申报额，自动排雷「拿回款净额报税、佣金违规冲减收入」；
  2. **供应商开票加点毛利临界测算（`export_invoice_breakeven`）**：精算「加税点拿专票退税」vs「综试区/1039合规无票免税」盈亏临界加点率 $g^*$ 及企业所得税联动净利对比；
  3. **综试区零售出口 4% 核定征收企业所得税（`cbec_assessed_cit`）**：含 **7,500 万营收（300 万所得额）5 倍税负悬崖**及 9810 核定口径收紧预警；
  4. **外贸企业出口免退税（`export_rebate`）**：孰低规则、征退税率差转成本、2026 年第 11 号公告第六/七条区分；
  5. **全年一次性奖金单独计税个税（`annual_bonus_iit`）**：含全档位「多发一元到手反少几千」临界陷阱检测；
  6. **跨境电商零售进口综合税（`cross_border_import`）**：限额内 0 关税 + 70% 折算、消费税组成计税价格与超限预警；
  7. **增值税价税分离（`vat`）**。
- **政策引证问答 & 监管代码决策树**：只读检索你 IMA 知识库里的政策原文与 SOP，回答附真实来源与文号。

## 实测效果与独立工作台实机截图（v0.6.0）

1. **DSH 侧边栏独立财税工作台 — 五大平台原始账单 / `.zip` 拖拽排雷与多币种总对账**：

![侧边栏财税工作台：原始账单排雷与7500万生死崖监控](https://raw.githubusercontent.com/fleekelon/dsh-fintax/main/docs/statement-radar.png)

2. **0 Token 交互式 7 大确定性算税与差额桥接计算器**：

![7大确定性交互算税引擎](https://raw.githubusercontent.com/fleekelon/dsh-fintax/main/docs/calc-engines.png)

3. **免命令行图形化 IMA 知识库凭证与默认优先库绑定**：

![图形化 IMA 设置面板](https://raw.githubusercontent.com/fleekelon/dsh-fintax/main/docs/settings-workbench.png)

## 安装（支持图形界面一键安装，无需命令行）

`dsh-fintax` 已收录至 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 与 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场目录：

### 方式一：DSH 桌面端图形界面一键安装（推荐，财务/老板零门槛）
- **原生插件管理**：打开官方 DSH Desktop 应用内的 **「设置 → 插件」**，直接搜索 **`dsh-fintax`** 点击安装即可，全程无需敲命令行；
- **可视化插件市场**：若已安装社区插件市场（`dshmarket`）或开启 **「插件 → 发现（Discover）」**，搜索 **「财税工作台」** 或 **`dsh-fintax`** 一键点装即可。

### 方式二：命令行安装（适用于 `dsh web` 或开发者自定义 Profile）

```sh
# 从 npm 安装最新版（预构建免授权）
dsh plugin --profile <你的profile> add dsh-fintax

# 从 GitHub 安装
dsh plugin --profile <你的profile> add github:fleekelon/dsh-fintax
```

兼容 DSH >= 0.2.1-rc.2。

## 配置 IMA 知识库（可选，支持图形界面一键配置）

原始账单离线体检（`fintax_parse_statement`）与 7 大算税对账场景（`fintax_calc`）**无需任何凭证即可离线运行**。如需启用腾讯 IMA 知识库政策引证问答：

1. 打开 <https://ima.qq.com/agent-interface> 获取 `Client ID` 与 `API Key`；
2. **推荐方式（图形界面）**：在 DSH 桌面端打开 **「设置 → 财税工作台」**，粘贴保存凭证，点击「测试连接并拉取知识库」即可点选绑定你的默认财税知识库；
3. **CLI / 环境变量方式**：写入 `~/.config/ima/client_id` 与 `~/.config/ima/api_key`（可选 `~/.config/ima/fintax_config.json`），或设置环境变量 `IMA_CLIENT_ID` / `IMA_API_KEY` / `IMA_DEFAULT_KB_ID`。

安全承诺：设置页接口逐请求执行宿主会话准入校验（`connection.admit`），密钥只写不回传明文，且仅作为请求头发送至官方 `https://ima.qq.com`（严格只读）；`fintax_parse_statement` 仅在本机离线读取用户指定的账单文件。

## 工具与技能

| 工具 | 用途 |
|---|---|
| `fintax_parse_statement` | 本地离线解析 Amazon / TikTok Shop / Temu / Shopify / Stripe 原始账单及 `.zip` 包（支持 `demo:all` 免文件体验），输出多币种合并对账、异常雷达与可打印 HTML/MD 体检诊断书 |
| `fintax_calc` | 7 场景确定性试算与对账：`platform_tax_reconcile` / `export_invoice_breakeven` / `cbec_assessed_cit` / `export_rebate` / `annual_bonus_iit` / `cross_border_import` / `vat` |
| `ima_list_kbs` | 列出你的 IMA 知识库并标识已绑定的默认优先库 |
| `ima_search` | 在默认或指定知识库内搜索政策原文与底稿 |
| `ima_browse` | 浏览默认或指定知识库目录及展开子文件夹 |
| `ima_read` | 按 `media_id` 读取 Markdown / 笔记原文 |

| 技能 | 触发场景 |
|---|---|
| `fintax-calc` | 原始账单离线体检、税额试算与四层口径差额桥接工作流 |
| `fintax-policy-qa` | 政策引证问答（新旧文件优先级 + 降级路径） |
| `fintax-crossborder-check` | 跨境电商全链路合规自查报告（对齐 2026 现行法规） |
| `fintax-mode-select` | 海关监管代码与出口模式决策树 |

## 免责声明

本插件输出为财税初筛体检、算术试算与研究辅助，不构成正式关账底稿、税务申报依据或鉴证意见。企业月末正式关账与历史差异更正请结合多店铺完整底稿咨询执业税务师/律师，并以主管税务机关口径为准。

## License

MIT

# dsh-fintax — 财税工作台 (v0.3.0)

[![npm version](https://img.shields.io/npm/v/dsh-fintax)](https://www.npmjs.com/package/dsh-fintax)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4fc3f7)](https://github.com/topics/dsh-plugin)

<img src="https://raw.githubusercontent.com/fleekelon/dsh-fintax/main/assets/icon.svg" width="80" alt="dsh-fintax icon">

DeepSeek Harness 插件：把专业财税对账、合规自查与代码级确定性算税装进桌面工作台。

- **桌面端图形化配置页（v0.3 新增）**：装完打开 DSH **「设置 → 财税工作台」** 即可免命令行粘贴腾讯 IMA 凭证、一键测试连接，并点选绑定你的**默认优先财税知识库**（告别多知识库盲翻）。
- **政策引证问答**：只读检索你 IMA 知识库里的政策原文与底稿，回答附来源标题与真实文号，新旧文件冲突时强制优先现行标准。
- **7 大代码级确定性算税与差额桥接引擎（免配 IMA 亦可离线使用）**：
  1. **平台涉税报送四层口径差额桥接（`platform_tax_reconcile`，v0.3 新增）**：拆解平台报送总额 vs 结算实际放款 vs 增值税已申报额，自动轧平资金链并精准排雷「拿回款净额报税、佣金违规冲减收入」；
  2. **供应商开票加点毛利临界测算（`export_invoice_breakeven`，v0.3 新增）**：精算「加税点拿专票退税」vs「综试区/1039合规无票免税」盈亏临界加点率 $g^*$、净采购成本及企业所得税后综合净利对比；
  3. **综试区零售出口 4% 核定征收企业所得税（`cbec_assessed_cit`）**：支持小微叠加与 **7,500 万营收（300 万所得额）5 倍税负悬崖**及 9810 核定口径收紧预警；
  4. **外贸企业出口免退税（`export_rebate`）**：孰低规则、征退税率差转成本、2026 年第 11 号公告第六/七条区分提示；
  5. **全年一次性奖金单独计税个税（`annual_bonus_iit`）**：含全档位「多发一元到手反少几千」临界陷阱检测；
  6. **跨境电商零售进口综合税（`cross_border_import`）**：限额内 0 关税 + 70% 折算、消费税组成计税价格与超限预警；
  7. **增值税价税分离（`vat`）**：含税价与不含税价双向确定性拆分。
- **跨境电商合规自查 & 监管代码选型**：覆盖 9610 / 9710 / 9810 / 1210 / 1039 / 0110 决策树、收结汇与四方数据一致性自查。

## 实测效果

真实模型端到端测试：Agent 自动检索知识库 → 核对政策原文 → 调用确定性引擎计算 → 输出带引证的完整回答：

![E2E 实测：综合税计算](https://raw.githubusercontent.com/fleekelon/dsh-fintax/main/docs/e2e-tax-calculation.png)

插件页安装状态：

![插件页](https://raw.githubusercontent.com/fleekelon/dsh-fintax/main/docs/plugin-page.png)

## 安装

```sh
# 从 npm（推荐，预构建免授权）
dsh plugin --profile <你的profile> add dsh-fintax

# 从 GitHub
dsh plugin --profile <你的profile> add github:fleekelon/dsh-fintax

# 本地目录
dsh plugin --profile <你的profile> add /path/to/dsh-fintax
```

兼容 DSH >= 0.2.1-rc.2。

## 配置 IMA 知识库（可选，支持图形界面一键配置）

7 大算税与差额桥接场景**无需任何凭证即可离线运行**。如需启用腾讯 IMA 知识库政策引证问答：

1. 打开 <https://ima.qq.com/agent-interface> 获取 `Client ID` 与 `API Key`；
2. **推荐方式（图形界面）**：在 DSH 桌面端打开 **「设置 → 财税工作台」**，粘贴保存凭证，点击「测试连接并拉取知识库」即可点选绑定你的默认财税知识库；
3. **CLI / 环境变量方式**：写入 `~/.config/ima/client_id` 与 `~/.config/ima/api_key`（可选 `~/.config/ima/fintax_config.json`），或设置环境变量 `IMA_CLIENT_ID` / `IMA_API_KEY` / `IMA_DEFAULT_KB_ID`。

安全承诺：设置页接口逐请求执行宿主会话准入校验（`connection.admit`），密钥只写不回传明文，且仅作为请求头发送至官方 `https://ima.qq.com`（严格只读）。

## 工具与技能

| 工具 | 用途 |
|---|---|
| `fintax_calc` | 7 场景确定性试算与对账：`platform_tax_reconcile` / `export_invoice_breakeven` / `cbec_assessed_cit` / `export_rebate` / `annual_bonus_iit` / `cross_border_import` / `vat` |
| `ima_list_kbs` | 列出你的 IMA 知识库并标识已绑定的默认优先库 |
| `ima_search` | 在默认或指定知识库内搜索政策原文与底稿 |
| `ima_browse` | 浏览默认或指定知识库目录及展开子文件夹 |
| `ima_read` | 按 `media_id` 读取 Markdown / 笔记原文 |

| 技能 | 触发场景 |
|---|---|
| `fintax-calc` | 税额试算与四层口径差额桥接工作流 |
| `fintax-policy-qa` | 政策引证问答（新旧文件优先级 + 降级路径） |
| `fintax-crossborder-check` | 跨境电商全链路合规自查报告（对齐 2026 现行法规） |
| `fintax-mode-select` | 海关监管代码与出口模式决策树 |

## 免责声明

本插件输出为财税对账、测算与研究辅助，不构成税务申报依据或鉴证意见。重大事项请结合原始单证咨询执业税务师/律师并以主管税务机关口径为准。

## License

MIT

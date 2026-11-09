# dsh-fintax — 财税工作台

DeepSeek Harness 插件：把财税专业工作流装进 Agent。

- **政策引证问答**：检索你 IMA 知识库里的政策原文与解读，回答附来源，查不到就明说，绝不编造文号。
- **跨境电商合规自查**：主体备案 / 正面清单 / 三单对碰 / 限值 / 出口退免税 / 收汇 / 申报，逐项输出结构化风险报告。
- **监管代码与模式选择**：按你的监管代码决策树定位 9610/9710/9810/1210/1039/0110，同步分析退税链路、收结汇、数据报送。
- **确定性税额试算**（5 场景，算术由代码完成，结果带政策文号引证）：
  - 跨境电商零售进口综合税（含超限预警）
  - 增值税价税分离
  - 年终奖单独计税个税（含"多发一元"临界点陷阱预警）
  - 外贸企业出口退税免退税（孰低规则、征退税率差转成本、9810 预退税提示）
  - 综试区零售出口核定征收企业所得税（4% 所得率、小微叠加、9810 口径收紧预警）

## 安装

```sh
# 本地目录
dsh plugin --profile <你的profile> add /path/to/dsh-fintax

# 或从 GitHub（发布后）
dsh plugin --profile <你的profile> add github:fleekelon/dsh-fintax

# 或从 npm（发布后）
dsh plugin --profile <你的profile> add dsh-fintax
```

桌面端用户也可在插件页通过本地包安装。兼容 DSH >= 0.2.1-rc.2（developer preview 阶段，破坏性变更时请提 issue）。

## 配置 IMA 凭证（可选）

知识库四个工具（`ima_list_kbs` / `ima_browse` / `ima_search` / `ima_read`）需要腾讯 IMA OpenAPI 凭证；不配置时它们会给出配置指引，税额试算不受影响。

1. 打开 <https://ima.qq.com/agent-interface> 获取 Client ID 与 API Key；
2. 二选一：
   - 写入 `~/.config/ima/client_id` 与 `~/.config/ima/api_key`；
   - 或设置环境变量 `IMA_CLIENT_ID` / `IMA_API_KEY`。

凭证只作为 HTTP 头发送到官方 `ima.qq.com`，不写日志、不落其他文件。插件对知识库**只读**（列表/搜索/原文信息），不做任何写入。

## 工具

| 工具 | 用途 |
|---|---|
| `ima_list_kbs` | 列出你的 IMA 知识库 |
| `ima_browse` | 浏览知识库内容目录（小库直接列全，替代盲搜） |
| `ima_search` | 在指定知识库内搜索（返回 media_id/标题/摘要） |
| `ima_read` | 按 media_id 获取原文访问信息 |
| `fintax_calc` | 确定性试算：`cross_border_import` / `vat` / `annual_bonus_iit` / `export_rebate` / `cbec_assessed_cit` |

## 技能

| 技能 | 触发场景 |
|---|---|
| `fintax-policy-qa` | 政策问答：引证纪律 + 降级路径 |
| `fintax-crossborder-check` | 跨境电商合规自查清单 |
| `fintax-mode-select` | 监管代码/出口模式选择（决策树工作流） |
| `fintax-calc` | 试算工作流：先核参数、必须走工具 |

## 设计说明

- 纯 ESM JavaScript，零运行时依赖、免构建：直接向 `ctx.tools` / `ctx.skills` 注册，git/npm/tarball 三种分发方式都不需要构建许可。
- 政策参数（税率、限值、征收比例）全部可由调用方覆盖；默认值只是试算起点，技能工作流强制要求先核对现行政策。
- 你的专业知识库是护城河：插件提供工作流与引证纪律，领域内容由你自己的 IMA 知识库供给（每个用户接自己的库）。

## 免责声明

本插件输出为研究辅助与算术试算，不构成税务申报依据或鉴证意见。重大决策请咨询执业税务师/律师并以主管税务机关口径为准。

## License

MIT
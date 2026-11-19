// dsh-fintax v0.7.0 扩展平台解析器（PayPal 资金池 + 速卖通 AliExpress + Shopee 虾皮）与脱敏沙盒样本。
// 纯 Node.js 零第三方依赖，共享 lib/statement.js 的 BigInt 定点算术内核。

import {
  CENT_STEP,
  absBig,
  cell,
  finalizeSummary,
  findHeaderRow,
  fmtAmount,
  inferPeriod,
  makeEmptySummary,
  parseAmount,
} from './statement.js'

const CCY_SITE_MAP = {
  USD: 'US', EUR: 'EU', GBP: 'UK', AUD: 'AU', CAD: 'CA', JPY: 'JP',
  SGD: 'SG', MYR: 'MY', THB: 'TH', VND: 'VN', PHP: 'PH', IDR: 'ID',
  BRL: 'BR', MXN: 'MX', TWD: 'TW', HKD: 'HK', RMB: 'CN', CNY: 'CN',
}

const AD_VENDOR_RE = /faceb(?:ook|k)|meta\s*(?:platforms?|ads?|ireland)|google\s*(?:ads?|ireland|llc)|tiktok|bytedance|pinterest|snapchat|bing\s*ads?|microsoft\s*ads?|klaviyo|taboola|outbrain/i
const LOGISTICS_VENDOR_RE = /\bups\b|\bdhl\b|\bfedex\b|\busps\b|yunexpress|4px|cainiao|yanwen|shipstation|pirate\s*ship|shipping/i

// ── 6. PayPal 独立站资金池账单解析器（Activity Download CSV & XLSX） ──
export const PAYPAL_ALIASES = {
  date: ['date', '日期', '交易日期', 'transaction date'],
  name: ['name', '名称', '对方名称', 'counterparty', 'merchant'],
  tx_type: ['type', '类型', '交易类型', 'description'],
  status: ['status', '状态', '交易状态'],
  currency: ['currency', '币种', '货币'],
  gross: ['gross', '总额', '总金额', '金额'],
  fee: ['fee', '费用', '手续费'],
  net: ['net', '净额', '净金额'],
  sales_tax: ['sales tax', 'tax', '销售税', '税费'],
  shipping: ['shipping and handling amount', 'shipping', '运费'],
  tx_id: ['transaction id', '交易号', '交易编号'],
  balance_impact: ['balance impact', '余额影响'],
  ref_id: ['reference txn id', '关联交易号', 'invoice number'],
}

export function isPayPalMatch(fileName, rows, hdrIdx, colMap) {
  const fn = fileName.toLowerCase()
  if (fn.includes('paypal')) return true
  if (!('gross' in colMap && 'fee' in colMap && 'net' in colMap)) return false
  if ('balance_impact' in colMap || ('sales_tax' in colMap && 'tx_id' in colMap)) return true
  if (!('status' in colMap && 'tx_type' in colMap)) return false
  for (let i = hdrIdx + 1; i < Math.min(rows.length, hdrIdx + 20); i++) {
    const t = cell(rows[i], colMap.tx_type).toLowerCase()
    if (
      t.includes('express checkout') ||
      t.includes('website payment') ||
      t.includes('general currency conversion') ||
      t.includes('preapproved payment') ||
      t.includes('general withdrawal') ||
      t.includes('paypal')
    ) {
      return true
    }
  }
  return false
}

export function parsePayPalSheets(fileName, sheets, formatInfo) {
  for (const [sName, rows] of sheets) {
    const m = findHeaderRow(rows, PAYPAL_ALIASES, 5)
    if (!m || !isPayPalMatch(`${fileName} ${sName}`, rows, m[0], m[1])) continue
    const [hdrIdx, colMap] = m
    const dataRows = rows.slice(hdrIdx + 1)

    const byCcy = new Map()
    const ensureBucket = (ccy) => {
      if (!byCcy.has(ccy)) {
        byCcy.set(ccy, {
          dates: [],
          voidCount: 0,
          fxConvCount: 0,
          fxConvVolume: 0n,
          reserveEvents: 0,
          summary: makeEmptySummary({
            period: '待确认期间',
            platform: 'PayPal',
            site: CCY_SITE_MAP[ccy] || 'GLOBAL',
            currency: ccy,
            formatLabel: `PayPal 资金池流水 (${formatInfo})`,
            fileName,
          }),
        })
      }
      return byCcy.get(ccy)
    }

    for (let idx = 0; idx < dataRows.length; idx++) {
      const r = dataRows[idx]
      const txId = cell(r, colMap.tx_id) || `PP-${hdrIdx + 2 + idx}`
      const name = cell(r, colMap.name)
      const tl = cell(r, colMap.tx_type).toLowerCase()
      const status = cell(r, colMap.status).toLowerCase()
      const impact = cell(r, colMap.balance_impact).toLowerCase()
      const ccy = (cell(r, colMap.currency).toUpperCase() || 'USD').slice(0, 3)

      const grossRaw = parseAmount(cell(r, colMap.gross))
      const feeRaw = parseAmount(cell(r, colMap.fee))
      const hasNetCol = 'net' in colMap && cell(r, colMap.net) !== ''
      const netRaw = hasNetCol ? parseAmount(cell(r, colMap.net)) : grossRaw + feeRaw
      const salesTaxRaw = absBig(parseAmount(cell(r, colMap.sales_tax)))

      if (grossRaw === 0n && feeRaw === 0n && netRaw === 0n) continue

      const bucket = ensureBucket(ccy)
      const s = bucket.summary
      const dt = cell(r, colMap.date)
      if (dt) bucket.dates.push(dt)
      s.rawRowCount++

      // 过滤未完成/作废/非余额变动备忘行
      if (
        ['pending', 'denied', 'voided', 'canceled', 'cancelled', 'expired', 'unclaimed', 'failed', '待处理', '已拒绝', '已撤销'].includes(status) ||
        impact === 'memo'
      ) {
        bucket.voidCount++
        s.uncapturedVoidExcluded += absBig(grossRaw || netRaw)
        continue
      }

      // 剥离跨币种换汇流水（严防误把换汇流水计作重复销售收入）
      if (tl.includes('currency conversion') || tl.includes('货币兑换') || tl.includes('币种转换')) {
        bucket.fxConvCount++
        bucket.fxConvVolume += absBig(grossRaw || netRaw)
        continue
      }

      // 行内 BigInt 水平守恒核验（PayPal 标准 Gross + Fee = Net）
      if (hasNetCol) {
        const expectedNet = grossRaw > 0n && feeRaw > 0n ? grossRaw - feeRaw : grossRaw + feeRaw
        const diff = netRaw - expectedNet
        s.horizontalDiffTotal += diff
        if (absBig(diff) >= CENT_STEP) {
          s.anomalies.push({
            severity: 'P0-阻断',
            category: 'PayPal 行内水平守恒校验失败',
            refId: txId,
            amount: fmtAmount(diff),
            detail: `净额 ${fmtAmount(netRaw)} 与 (总额 ${fmtAmount(grossRaw)} + 费用 ${fmtAmount(feeRaw)}) 差出 ${fmtAmount(diff)}，请核查导表完整性`,
          })
        }
      }

      // 提现至银行/结汇打款
      if (
        tl.includes('withdraw') ||
        tl.includes('bank deposit') ||
        tl.includes('transfer to bank') ||
        tl.includes('auto-sweep') ||
        tl.includes('提现') ||
        tl.includes('自动转账')
      ) {
        s.actualPayout += absBig(netRaw || grossRaw)
        continue
      }

      // 准备金 / 账户临时冻结与解冻
      if (tl.includes('reserve') || tl.includes('account hold') || tl.includes('temporary hold') || tl.includes('准备金') || tl.includes('冻结')) {
        bucket.reserveEvents++
        const delta = netRaw < 0n ? absBig(netRaw) : -absBig(netRaw)
        s.reserveNetChange += delta
        continue
      }

      // 拒付 / 争议扣款
      if (tl.includes('chargeback') || tl.includes('dispute') || tl.includes('reversal') || tl.includes('拒付') || tl.includes('争议')) {
        const refAmt = absBig(grossRaw)
        if (salesTaxRaw > 0n) s.selfRemitTaxNet -= salesTaxRaw
        if (tl.includes('fee')) {
          s.gatewayDisputeFee += absBig(netRaw || grossRaw)
        } else {
          s.customerRefund += refAmt - salesTaxRaw
          if (feeRaw < 0n) s.gatewayDisputeFee += absBig(feeRaw)
          else if (feeRaw > 0n) s.platformCommission -= feeRaw
        }
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'PayPal 拒付/争议扣款 (Dispute/Chargeback)',
          refId: txId,
          amount: fmtAmount(netRaw),
          detail: `对手方「${name || '未知'}」发生拒付/争议（类型：${cell(r, colMap.tx_type)}，净变动 ${fmtAmount(netRaw)} ${ccy}），须留存争议申诉证据并单独区分争议手续费`,
        })
        continue
      }

      // 客户退款
      if (tl.includes('refund') || tl.includes('退款')) {
        const refAmt = absBig(grossRaw)
        if (salesTaxRaw > 0n) s.selfRemitTaxNet -= salesTaxRaw
        s.customerRefund += refAmt - salesTaxRaw
        if (feeRaw > 0n) s.platformCommission -= feeRaw
        else if (feeRaw < 0n) s.platformCommission += absBig(feeRaw)
        continue
      }

      // 余额坐支海外广告 / 物流 / 供应商直付（负流出且非提现/退款/冻结/换汇）
      if (grossRaw < 0n || (impact === 'debit' && netRaw < 0n)) {
        const spend = absBig(netRaw || grossRaw)
        const target = `${name} ${cell(r, colMap.tx_type)}`
        let bucketHint = '境外直付费用'
        if (AD_VENDOR_RE.test(target)) {
          s.inPlatformAds += spend
          bucketHint = '海外广告费'
        } else if (LOGISTICS_VENDOR_RE.test(target)) {
          s.logisticsWarehousing += spend
          bucketHint = '境外物流费'
        } else {
          s.gatewayDisputeFee += spend
        }
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'PayPal 资金池余额坐支境外支出',
          refId: txId,
          amount: fmtAmount(-spend),
          detail: `检测到直接用 PayPal 余额向「${name || '境外收款方'}」支付${bucketHint} ${fmtAmount(spend)} ${ccy}。须全额还原销售收入并索取合规境外发票/代扣代缴凭证，严禁按余额净额报税！`,
        })
        continue
      }

      // 正常收款销售行
      s.grossSales += grossRaw - salesTaxRaw
      s.selfRemitTaxNet += salesTaxRaw
      s.platformCommission += absBig(feeRaw)
    }

    const out = []
    for (const [, b] of byCcy) {
      const s = b.summary
      if (s.rawRowCount === 0) continue
      s.period = inferPeriod(b.dates)
      if (b.fxConvCount > 0) {
        s.anomalies.push({
          severity: 'P2-关注',
          category: '已自动剥离 PayPal 跨币种换汇流水',
          refId: `PP-FX-${b.fxConvCount}`,
          amount: fmtAmount(b.fxConvVolume),
          detail: `共剥离 ${b.fxConvCount} 笔货币兑换流水（流水额 ${fmtAmount(b.fxConvVolume)} ${s.currency}），防止把账户内部换汇误计为重复销售收入`,
        })
      }
      if (b.reserveEvents > 0 && absBig(s.reserveNetChange) >= CENT_STEP) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'PayPal 滚动准备金/资金冻结净变动',
          refId: `PP-RESV-${b.reserveEvents}`,
          amount: fmtAmount(s.reserveNetChange),
          detail: `本期发生 ${b.reserveEvents} 笔冻结/解冻变动（净冻结 ${fmtAmount(s.reserveNetChange)} ${s.currency}），属于资金暂扣而非销售扣减，严禁少报当期收入`,
        })
      }
      if (b.voidCount > 0) {
        s.anomalies.push({
          severity: 'P2-关注',
          category: '已自动过滤 PayPal 未结清/作废流水',
          refId: `PP-VOID-${b.voidCount}`,
          amount: fmtAmount(s.uncapturedVoidExcluded),
          detail: `共剔除 ${b.voidCount} 笔 Pending/Denied/Memo 流水（合计 ${fmtAmount(s.uncapturedVoidExcluded)} ${s.currency}）`,
        })
      }
      if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'PayPal 结账代收待自申报流转税 (Sales Tax)',
          refId: 'PP-SELF-TAX',
          amount: fmtAmount(s.selfRemitTaxNet),
          detail: `PayPal 收款代收流转税净额 ${fmtAmount(s.selfRemitTaxNet)} ${s.currency} 已剥离，须计入其他应付款并按目的国税法申报`,
        })
      }
      out.push(finalizeSummary(s))
    }
    if (out.length) return out
  }
  return null
}

// ── 7. 速卖通 AliExpress 商家结算账单解析器（POP 自运营 / 全托管 Choice CSV & XLSX） ──
export const ALIEXPRESS_ALIASES = {
  date: ['入账时间', '结算时间', '放款时间', '交易时间', 'settlement time', 'released date', 'posted date', 'transaction date'],
  order_id: ['订单号', '主订单号', '子订单号', '交易单号', 'order id', 'trade order id', 'order number'],
  mode: ['业务模式', '托管模式', '店铺模式', '经营模式', 'business mode', 'fulfillment mode', 'store type', 'channel'],
  tx_type: ['交易类型', '账务类型', '费用类型', '资金类型', 'transaction type', 'fund type', 'bill type'],
  site: ['买家国家', '目的国', '站点', '收货国家', 'country', 'destination country', 'site'],
  currency: ['币种', '结算币种', '账户币种', 'currency', 'settlement currency'],
  order_gross: ['商品金额', '订单金额', '买家实付商品额', '商品销售额', 'order amount', 'product amount', 'item price', 'gross merchandise amount'],
  shipping_income: ['买家支付运费', '运费收入', '买家实付运费', 'shipping fee paid by buyer', 'buyer shipping'],
  seller_discount: ['商家优惠', '店铺优惠券', '商家满减', 'seller discount', 'store coupon', 'seller voucher'],
  platform_subsidy: ['平台补贴', '平台优惠券补贴', '平台直降补贴', 'platform subsidy', 'ae subsidy', 'aliexpress coupon'],
  refund_amount: ['退款金额', '纠纷退款', '售后退款', 'refund amount', 'dispute refund'],
  commission_fee: ['平台佣金', '交易服务费', '类目佣金', 'commission', 'platform commission', 'escrow fee'],
  affiliate_fee: ['联盟佣金', '站外推广佣金', 'affiliate commission', 'affiliate fee'],
  logistics_fee: ['菜鸟物流费', '线上发货运费', '海外仓操作费', '平台代扣运费', 'logistics fee', 'cainiao shipping fee', 'shipping deduction'],
  ads_fee: ['直通车扣费', '站内广告费', '推广费', 'ad fee', 'sponsored ads'],
  penalty_fee: ['违规扣款', '纠纷赔付', '延迟发货罚款', '违约金', 'penalty', 'violation fee', 'fine'],
  withheld_tax: ['平台代扣税费', '代扣vat', 'ioss代扣税', '代扣代缴增值税', 'marketplace withheld tax', 'ioss vat', 'vat withheld'],
  self_tax: ['待自申报税', '非代扣税费', 'seller collected tax', 'self remit tax'],
  payout_amount: ['提现金额', '放款打款', '银行入账', 'withdrawal', 'payout amount'],
  net_amount: ['放款净额', '入账金额', '实结金额', '结算净额', '动账净额', 'net settlement', 'released amount', 'escrow amount'],
}

export function isAliExpressMatch(fileName, rows, hdrIdx, colMap) {
  const fn = fileName.toLowerCase()
  if (fn.includes('aliexpress') || fn.includes('速卖通') || /(?:^|[\s_-])ae[\s_-]/.test(fn)) return true
  const hasAeCol = 'affiliate_fee' in colMap || ('withheld_tax' in colMap && 'order_gross' in colMap && 'net_amount' in colMap)
  if (!hasAeCol && !('order_gross' in colMap && 'commission_fee' in colMap && 'net_amount' in colMap)) return false
  for (let i = hdrIdx + 1; i < Math.min(rows.length, hdrIdx + 20); i++) {
    const joined = rows[i].join(' ').toLowerCase()
    if (
      joined.includes('aliexpress') ||
      joined.includes('速卖通') ||
      joined.includes('ae choice') ||
      joined.includes('cainiao') ||
      joined.includes('菜鸟') ||
      joined.includes('ioss')
    ) {
      return true
    }
  }
  return 'affiliate_fee' in colMap && 'withheld_tax' in colMap
}

export function parseAliExpressSheets(fileName, sheets, formatInfo) {
  for (const [sName, rows] of sheets) {
    const m = findHeaderRow(rows, ALIEXPRESS_ALIASES, 4)
    if (!m || !isAliExpressMatch(`${fileName} ${sName}`, rows, m[0], m[1])) continue
    const [hdrIdx, colMap] = m
    const dataRows = rows.slice(hdrIdx + 1)

    const byCcy = new Map()
    const ensureBucket = (ccy) => {
      if (!byCcy.has(ccy)) {
        byCcy.set(ccy, {
          dates: [],
          fullManagedCount: 0,
          fullManagedTotal: 0n,
          popCount: 0,
          penaltyCount: 0,
          penaltyTotal: 0n,
          summary: makeEmptySummary({
            period: '待确认期间',
            platform: 'AliExpress',
            site: CCY_SITE_MAP[ccy] || 'GLOBAL',
            currency: ccy,
            formatLabel: `速卖通 AliExpress 结算账单 (${formatInfo})`,
            fileName,
          }),
        })
      }
      return byCcy.get(ccy)
    }

    for (let idx = 0; idx < dataRows.length; idx++) {
      const r = dataRows[idx]
      const oid = cell(r, colMap.order_id) || `AE-${hdrIdx + 2 + idx}`
      const modeStr = cell(r, colMap.mode).toLowerCase()
      const txType = cell(r, colMap.tx_type).toLowerCase()
      if (oid.toLowerCase().includes('total') || oid.includes('合计') || txType.includes('合计')) continue

      const ccy = (cell(r, colMap.currency).toUpperCase() || 'USD').slice(0, 3)
      const gross = absBig(parseAmount(cell(r, colMap.order_gross)))
      const shipIn = absBig(parseAmount(cell(r, colMap.shipping_income)))
      const sDisc = absBig(parseAmount(cell(r, colMap.seller_discount)))
      const pSub = absBig(parseAmount(cell(r, colMap.platform_subsidy)))
      const refund = absBig(parseAmount(cell(r, colMap.refund_amount)))
      const comm = absBig(parseAmount(cell(r, colMap.commission_fee)))
      const aff = absBig(parseAmount(cell(r, colMap.affiliate_fee)))
      const logi = absBig(parseAmount(cell(r, colMap.logistics_fee)))
      const ads = absBig(parseAmount(cell(r, colMap.ads_fee)))
      const penalty = absBig(parseAmount(cell(r, colMap.penalty_fee)))
      const wTax = absBig(parseAmount(cell(r, colMap.withheld_tax)))
      const selfTax = parseAmount(cell(r, colMap.self_tax))
      const payoutRaw = absBig(parseAmount(cell(r, colMap.payout_amount)))
      const hasNetCol = 'net_amount' in colMap && cell(r, colMap.net_amount) !== ''
      const netRaw = hasNetCol ? parseAmount(cell(r, colMap.net_amount)) : 0n

      if (
        gross === 0n && shipIn === 0n && refund === 0n && comm === 0n && aff === 0n &&
        logi === 0n && ads === 0n && penalty === 0n && payoutRaw === 0n && netRaw === 0n
      ) {
        continue
      }

      const bucket = ensureBucket(ccy)
      const s = bucket.summary
      const dt = cell(r, colMap.date)
      if (dt) bucket.dates.push(dt)
      s.rawRowCount++

      if (payoutRaw > 0n || txType.includes('提现') || txType.includes('打款') || txType.includes('withdrawal') || txType.includes('payout')) {
        s.actualPayout += payoutRaw > 0n ? payoutRaw : absBig(netRaw)
        continue
      }

      const isChoiceFull =
        modeStr.includes('全托管') ||
        modeStr.includes('ae choice') ||
        modeStr.includes('choice全托管') ||
        modeStr.includes('fully managed') ||
        txType.includes('全托管供货')
      if (isChoiceFull) {
        bucket.fullManagedCount++
        bucket.fullManagedTotal += gross > 0n ? gross : absBig(netRaw)
      } else if (modeStr.includes('pop') || modeStr.includes('自运营') || modeStr.includes('半托管') || gross > 0n) {
        bucket.popCount++
      }

      const rowGross = gross + shipIn
      s.grossSales += rowGross
      s.sellerDiscount += sDisc
      s.platformSubsidy += pSub
      s.customerRefund += refund
      s.platformCommission += comm
      s.affiliateCommission += aff
      s.logisticsWarehousing += logi
      s.inPlatformAds += ads
      s.gatewayDisputeFee += penalty
      s.facilitatorTaxStripped += wTax
      s.selfRemitTaxNet += selfTax

      if (penalty > 0n) {
        bucket.penaltyCount++
        bucket.penaltyTotal += penalty
      }

      if (hasNetCol) {
        const expectedNet = rowGross - sDisc + pSub - refund - comm - aff - logi - ads - penalty + selfTax
        const diff = netRaw - expectedNet
        s.horizontalDiffTotal += diff
        if (absBig(diff) >= CENT_STEP) {
          s.anomalies.push({
            severity: 'P0-阻断',
            category: '速卖通行内水平守恒校验失败',
            refId: oid,
            amount: fmtAmount(diff),
            detail: `账单放款净额 ${fmtAmount(netRaw)} 与明细推算值 ${fmtAmount(expectedNet)} 差出 ${fmtAmount(diff)}，请检查是否漏列菜鸟运费/联盟佣金或导出截断`,
          })
        }
      }
    }

    const out = []
    for (const [, b] of byCcy) {
      const s = b.summary
      if (s.rawRowCount === 0) continue
      s.period = inferPeriod(b.dates)
      if (b.fullManagedCount > 0) {
        s.anomalies.push({
          severity: 'P0-阻断',
          category: b.popCount > 0 ? '速卖通全托管(Choice)与POP自运营混表' : '速卖通全托管供货结算口径警示',
          refId: `AE-CHOICE-${b.fullManagedCount}`,
          amount: fmtAmount(b.fullManagedTotal),
          detail: `检出 ${b.fullManagedCount} 笔全托管供货结算（合计 ${fmtAmount(b.fullManagedTotal)} ${s.currency}）。全托管属向平台指定主体供货，与 POP 境外终端零售（适用税总15号文报送）纳税口径不同，申报前必须先剥离！`,
        })
      }
      if (b.penaltyCount > 0) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: '速卖通违约罚款/纠纷赔付扣款',
          refId: `AE-PEN-${b.penaltyCount}`,
          amount: fmtAmount(b.penaltyTotal),
          detail: `检出 ${b.penaltyCount} 笔违约扣款/纠纷赔付（合计 ${fmtAmount(b.penaltyTotal)} ${s.currency}），须单独列支营业外支出或费用，严禁直接冲减销售收入`,
        })
      }
      if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: '速卖通非代扣待卖家自申报境外税',
          refId: 'AE-SELF-TAX',
          amount: fmtAmount(s.selfRemitTaxNet),
          detail: `检出非平台代扣流转税净额 ${fmtAmount(s.selfRemitTaxNet)} ${s.currency}，须剥离至其他应付款按目的国申报，勿混入主营业务收入`,
        })
      }
      out.push(finalizeSummary(s))
    }
    if (out.length) return out
  }
  return null
}

// ── 8. Shopee 虾皮收入报表解析器（Seller Center Income Report XLSX & CSV） ──
export const SHOPEE_ALIASES = {
  date: ['payout completed date', 'order completion date', 'order creation date', '拨款完成日期', '订单完成时间', '结算日期', '交易日期'],
  order_id: ['order id', 'order sn', '订单编号', '订单号'],
  tx_type: ['type', 'transaction type', 'income type', '交易类型', '账务类型'],
  site: ['site', 'region', 'country', '站点', '市场'],
  currency: ['currency', '币种', '结算币种'],
  product_price: ['original price', 'product price', 'merchandise subtotal', '商品原价', '商品金额', '商品小计'],
  buyer_shipping: ['buyer paid shipping fee', '买家支付运费', '买家实付运费'],
  seller_discount: ['seller discount', 'voucher sponsored by seller', 'seller absorbed coin cashback', '卖家折扣', '卖家优惠券', '商家优惠'],
  shopee_subsidy: ['shopee rebate', 'voucher sponsored by shopee', 'coin cashback sponsored by shopee', '平台补贴', 'shopee补贴'],
  shipping_rebate: ['shipping fee rebate from shopee', 'shipping subsidy', 'shopee运费补贴', '平台运费补贴'],
  refund_amount: ['refund amount', 'return refund amount', 'buyer refund', '退款金额', '退货退款'],
  commission_fee: ['commission fee', '平台佣金', '佣金'],
  service_fee: ['service fee', '活动服务费', '服务费'],
  transaction_fee: ['transaction fee', 'payment fee', '交易手续费', '手续费'],
  ams_fee: ['ams commission fee', 'affiliate commission', '联盟佣金', '站外推广佣金'],
  actual_shipping: ['actual shipping fee', 'shipping fee paid by shopee on your behalf', 'reverse shipping fee', '实际运费', '平台代扣运费', '物流运费'],
  penalty_fee: ['penalty', 'penalty fee', 'late shipment fee', '违规罚款', '违约扣款'],
  wht_tax: ['withholding tax', 'wht', '预提税', '代扣所得税'],
  withheld_vat: ['overseas vat', 'gst withheld', 'marketplace vat', '代扣vat', '平台代扣税费'],
  payout_amount: ['withdrawal amount', 'payout amount', '提现金额', '打款金额'],
  released_amount: ['total released amount', 'released amount', 'escrow amount', '拨款金额', '实结金额', '进账净额'],
}

const SHOPEE_SITE_CCY = {
  MY: 'MYR', SG: 'SGD', TH: 'THB', VN: 'VND', PH: 'PHP', ID: 'IDR',
  BR: 'BRL', MX: 'MXN', TW: 'TWD', CL: 'CLP', CO: 'COP', US: 'USD',
}

export function isShopeeMatch(fileName, rows, hdrIdx, colMap) {
  const fn = fileName.toLowerCase()
  if (fn.includes('shopee') || fn.includes('虾皮')) return true
  const hasShopeeSpecific =
    'released_amount' in colMap &&
    ('buyer_shipping' in colMap || 'actual_shipping' in colMap || 'service_fee' in colMap || 'shopee_subsidy' in colMap || 'shipping_rebate' in colMap)
  if (hasShopeeSpecific) return true
  if (!('product_price' in colMap && 'commission_fee' in colMap)) return false
  for (let i = hdrIdx + 1; i < Math.min(rows.length, hdrIdx + 15); i++) {
    const joined = rows[i].join(' ').toLowerCase()
    if (joined.includes('shopee') || joined.includes('虾皮')) return true
  }
  return false
}

export function parseShopeeSheets(fileName, sheets, formatInfo) {
  // 多工作表优先挑选含 Income / 明细 / 订单 的工作表，跳过 Summary 汇总页
  const orderedSheets = [...sheets].sort(([a], [b]) => {
    const score = (n) => (/income|order|detail|明细|订单/i.test(n) ? 0 : /summary|汇总/i.test(n) ? 2 : 1)
    return score(a) - score(b)
  })

  for (const [sName, rows] of orderedSheets) {
    const m = findHeaderRow(rows, SHOPEE_ALIASES, 4)
    if (!m || !isShopeeMatch(`${fileName} ${sName}`, rows, m[0], m[1])) continue
    const [hdrIdx, colMap] = m
    const dataRows = rows.slice(hdrIdx + 1)

    const fnUpper = fileName.toUpperCase()
    const fnSiteMatch = fnUpper.match(/SHOPEE[_-]([A-Z]{2})\b/)
    const fallbackSite = fnSiteMatch && SHOPEE_SITE_CCY[fnSiteMatch[1]] ? fnSiteMatch[1] : 'SG'

    const byCcy = new Map()
    const ensureBucket = (ccy, site) => {
      if (!byCcy.has(ccy)) {
        byCcy.set(ccy, {
          dates: [],
          buyerShipTotal: 0n,
          shipRebateTotal: 0n,
          actualShipTotal: 0n,
          whtTotal: 0n,
          penaltyCount: 0,
          penaltyTotal: 0n,
          summary: makeEmptySummary({
            period: '待确认期间',
            platform: 'Shopee',
            site: site || CCY_SITE_MAP[ccy] || fallbackSite,
            currency: ccy,
            formatLabel: `Shopee 收入报表 (${formatInfo})`,
            fileName,
          }),
        })
      }
      return byCcy.get(ccy)
    }

    for (let idx = 0; idx < dataRows.length; idx++) {
      const r = dataRows[idx]
      const oid = cell(r, colMap.order_id) || `SP-${hdrIdx + 2 + idx}`
      const txType = cell(r, colMap.tx_type).toLowerCase()
      if (oid.toLowerCase().includes('total') || oid.includes('合计') || txType.includes('合计')) continue

      const rowSite = cell(r, colMap.site).toUpperCase() || fallbackSite
      const rawCcy = cell(r, colMap.currency).toUpperCase()
      const ccy = (/^[A-Z]{3}$/.test(rawCcy) ? rawCcy : SHOPEE_SITE_CCY[rowSite] || 'SGD')

      const prodPrice = absBig(parseAmount(cell(r, colMap.product_price)))
      const buyerShip = absBig(parseAmount(cell(r, colMap.buyer_shipping)))
      const sDisc = absBig(parseAmount(cell(r, colMap.seller_discount)))
      const pSub = absBig(parseAmount(cell(r, colMap.shopee_subsidy)))
      const shipRebate = absBig(parseAmount(cell(r, colMap.shipping_rebate)))
      const refund = absBig(parseAmount(cell(r, colMap.refund_amount)))
      const comm = absBig(parseAmount(cell(r, colMap.commission_fee)))
      const svcFee = absBig(parseAmount(cell(r, colMap.service_fee)))
      const txFee = absBig(parseAmount(cell(r, colMap.transaction_fee)))
      const amsFee = absBig(parseAmount(cell(r, colMap.ams_fee)))
      const actualShip = absBig(parseAmount(cell(r, colMap.actual_shipping)))
      const penalty = absBig(parseAmount(cell(r, colMap.penalty_fee)))
      const wht = absBig(parseAmount(cell(r, colMap.wht_tax)))
      const wVat = absBig(parseAmount(cell(r, colMap.withheld_vat)))
      const payoutRaw = absBig(parseAmount(cell(r, colMap.payout_amount)))
      const hasReleased = 'released_amount' in colMap && cell(r, colMap.released_amount) !== ''
      const releasedRaw = hasReleased ? parseAmount(cell(r, colMap.released_amount)) : 0n

      if (
        prodPrice === 0n && buyerShip === 0n && refund === 0n && comm === 0n && svcFee === 0n &&
        txFee === 0n && actualShip === 0n && penalty === 0n && payoutRaw === 0n && releasedRaw === 0n
      ) {
        continue
      }

      const bucket = ensureBucket(ccy, rowSite)
      const s = bucket.summary
      const dt = cell(r, colMap.date)
      if (dt) bucket.dates.push(dt)
      s.rawRowCount++

      if (payoutRaw > 0n || txType.includes('withdrawal') || txType.includes('payout') || txType.includes('提现') || txType.includes('打款')) {
        s.actualPayout += payoutRaw > 0n ? payoutRaw : absBig(releasedRaw)
        continue
      }

      const rowGross = prodPrice + buyerShip
      const rowSub = pSub + shipRebate
      const rowComm = comm + svcFee + txFee
      const rowOtherFee = penalty + wht

      s.grossSales += rowGross
      s.sellerDiscount += sDisc
      s.platformSubsidy += rowSub
      s.customerRefund += refund
      s.platformCommission += rowComm
      s.affiliateCommission += amsFee
      s.logisticsWarehousing += actualShip
      s.gatewayDisputeFee += rowOtherFee
      s.facilitatorTaxStripped += wVat

      bucket.buyerShipTotal += buyerShip
      bucket.shipRebateTotal += shipRebate
      bucket.actualShipTotal += actualShip
      bucket.whtTotal += wht
      if (penalty > 0n) {
        bucket.penaltyCount++
        bucket.penaltyTotal += penalty
      }

      if (hasReleased) {
        const expectedReleased = rowGross - sDisc + rowSub - refund - rowComm - amsFee - actualShip - rowOtherFee
        const diff = releasedRaw - expectedReleased
        s.horizontalDiffTotal += diff
        if (absBig(diff) >= CENT_STEP) {
          s.anomalies.push({
            severity: 'P0-阻断',
            category: 'Shopee 行内水平守恒校验失败',
            refId: oid,
            amount: fmtAmount(diff),
            detail: `账单拨款净额 ${fmtAmount(releasedRaw)} 与明细推算值 ${fmtAmount(expectedReleased)} 差出 ${fmtAmount(diff)}，请检查是否遗漏活动服务费、联盟佣金或退货逆向运费`,
          })
        }
      }
    }

    const out = []
    for (const [, b] of byCcy) {
      const s = b.summary
      if (s.rawRowCount === 0) continue
      s.period = inferPeriod(b.dates)
      const shipDeficit = b.actualShipTotal - (b.buyerShipTotal + b.shipRebateTotal)
      if (shipDeficit >= CENT_STEP) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'Shopee 运费倒挂/超材物流扣款预警',
          refId: 'SP-SHIP-DEFICIT',
          amount: fmtAmount(shipDeficit),
          detail: `平台代扣实际运费 ${fmtAmount(b.actualShipTotal)} 高于买家实付运费(${fmtAmount(b.buyerShipTotal)})+运费补贴(${fmtAmount(b.shipRebateTotal)})，倒挂损耗 ${fmtAmount(shipDeficit)} ${s.currency}；请核对抛重超材并严禁按扣减运费后净额申报收入`,
        })
      }
      if (b.whtTotal >= CENT_STEP) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'Shopee 跨境站点代扣预提所得税 (WHT)',
          refId: 'SP-WHT-TAX',
          amount: fmtAmount(b.whtTotal),
          detail: `平台从拨款中扣缴预提税 ${fmtAmount(b.whtTotal)} ${s.currency}，须下载站点完税凭证评估企业所得税境外抵免，勿混淆为普通佣金冲减销售收入`,
        })
      }
      if (b.penaltyCount > 0) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'Shopee 履约违规罚款/延迟发货扣款',
          refId: `SP-PEN-${b.penaltyCount}`,
          amount: fmtAmount(b.penaltyTotal),
          detail: `检出 ${b.penaltyCount} 笔履约罚款（合计 ${fmtAmount(b.penaltyTotal)} ${s.currency}），须单独列支营业外支出/费用`,
        })
      }
      out.push(finalizeSummary(s))
    }
    if (out.length) return out
  }
  return null
}

// ── v0.7.0 新增三平台免文件脱敏沙盒样本 ────────────────────────
export const V7_DEMO_SAMPLES = {
  paypal: [
    'Demo_PayPal_DTC_202611.csv',
    [
      'Date,Name,Type,Status,Currency,Gross,Fee,Net,Sales Tax,Transaction ID,Balance Impact',
      '2026-11-03,US Customer A,Express Checkout Payment,Completed,USD,18000.00,-792.00,17208.00,1200.00,PP-TX-9001,Credit',
      '2026-11-07,Meta Platforms Ireland,PreApproved Payment,Completed,USD,-2600.00,0.00,-2600.00,0.00,PP-AD-9002,Debit',
      '2026-11-11,Currency Conversion,General Currency Conversion,Completed,USD,-5000.00,0.00,-5000.00,0.00,PP-FX-9003,Debit',
      '2026-11-14,Customer Dispute B,Chargeback,Completed,USD,-850.00,-20.00,-870.00,0.00,PP-CB-9004,Debit',
      '2026-11-22,Bank Transfer,General Withdrawal,Completed,USD,-13738.00,0.00,-13738.00,0.00,PP-WD-9005,Debit',
    ].join('\n'),
  ],
  aliexpress: [
    'Demo_AliExpress_EU_202611.csv',
    [
      '入账时间,订单号,业务模式,交易类型,站点,币种,商品金额,买家支付运费,商家优惠,平台补贴,退款金额,平台佣金,联盟佣金,菜鸟物流费,违规扣款,平台代扣税费,放款净额',
      '2026-11-04,AE-8801,POP自运营,订单放款,ES,EUR,22000.00,1200.00,800.00,600.00,0.00,1760.00,440.00,1800.00,0.00,4620.00,19000.00',
      '2026-11-09,AE-CHOICE-201,AE Choice全托管,全托管供货,ES,EUR,6400.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,6400.00',
      '2026-11-15,AE-8809,POP自运营,纠纷扣款,FR,EUR,0.00,0.00,0.00,0.00,900.00,0.00,0.00,0.00,150.00,0.00,-1050.00',
      '2026-11-25,AE-WD-11,POP自运营,提现打款,ES,EUR,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,24350.00',
    ].join('\n'),
  ],
  shopee: [
    'Demo_Shopee_MY_202611.csv',
    [
      'Payout Completed Date,Order ID,Type,Site,Currency,Original Price,Buyer Paid Shipping Fee,Seller Discount,Shopee Rebate,Shipping Fee Rebate From Shopee,Refund Amount,Commission Fee,Service Fee,Transaction Fee,Actual Shipping Fee,Withholding Tax,Penalty,Total Released Amount',
      '2026-11-05,261105MY001,Order,MY,MYR,45000.00,1800.00,2000.00,1500.00,600.00,0.00,3150.00,1800.00,900.00,3400.00,450.00,0.00,37200.00',
      '2026-11-13,261113MY002,Order,MY,MYR,0.00,0.00,0.00,0.00,0.00,1200.00,0.00,0.00,0.00,0.00,0.00,200.00,-1400.00',
      '2026-11-26,WD-MY-1126,Withdrawal,MY,MYR,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,35800.00',
    ].join('\n'),
  ],
}

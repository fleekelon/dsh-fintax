// dsh-fintax v0.5.0 扩展平台解析器（Temu 半托管/全托管 + Shopify 独立站）与内置免文件脱敏沙盒样本。
// 纯 Node.js 零第三方依赖，共享 lib/statement.js 的 BigInt 定点算术内核。

import {
  CENT_STEP,
  absBig,
  appendDateValidationAnomalies,
  cell,
  detectDeductionSign,
  finalizeSummary,
  findHeaderRow,
  fmtAmount,
  inferDateOrderFromSite,
  inferPeriod,
  makeEmptySummary,
  addPayoutEvidence,
  evidenceColumns,
  normalizeCurrencyCode,
  parseAmountCell,
  parseAmount,
} from './statement.js'
import { V7_DEMO_SAMPLES } from './platforms_v7.js'
import { V8_DEMO_SAMPLES } from './platforms_v8.js'

const SITE_CURRENCY_FALLBACK = {
  US: 'USD', CA: 'CAD', MX: 'MXN', UK: 'GBP', GB: 'GBP',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', IE: 'EUR', AT: 'EUR', PL: 'PLN', SE: 'SEK', EU: 'EUR',
  JP: 'JPY', AU: 'AUD', SG: 'SGD', CN: 'RMB',
}
const DMY_CURRENCIES = new Set(['EUR', 'GBP', 'PLN', 'SEK', 'CHF', 'DKK', 'NOK', 'CZK', 'HUF', 'RON', 'AUD', 'NZD', 'SGD', 'BRL', 'MXN'])
const CCY_SITE_FALLBACK = { EUR: 'EU', GBP: 'UK', PLN: 'PL', SEK: 'SE', JPY: 'JP', CAD: 'CA', AUD: 'AU', SGD: 'SG', MXN: 'MX' }

// ── 4. Temu 原始结算账单解析器（半托管 POP / 全托管供货 CSV & XLSX） ──
export const TEMU_ALIASES = {
  date: ['结算时间', '账务时间', '入账时间', '交易时间', 'settlement time', 'settlement date', 'posted date'],
  order_id: ['订单号', '子订单号', '父订单号', '备货单号', '结算单号', 'order id', 'sub order id', 'po number'],
  mode: ['经营模式', '托管模式', '店铺模式', '合作模式', '业务模式', 'fulfillment mode', 'business model', 'store mode'],
  tx_type: ['账务类型', '交易类型', '费用类型', '收支类型', 'transaction type', 'bill type'],
  site: ['站点', '销售站点', '国家/地区', 'site', 'region', 'marketplace'],
  currency: ['币种', '结算币种', '交易币种', 'currency', 'settlement currency'],
  retail_gross: ['商品零售价', '买家实付商品金额', '商品含税售价', '零售销售额', 'product retail price', 'gross merchandise value'],
  supply_settlement: ['供货结算价', '申报价格', '核价供货金额', '货款结算金额', 'supply price', 'declared price', 'wholesale settlement'],
  shipping_income: ['买家支付运费', '运费收入', '运费补贴收入', 'customer shipping fee', 'shipping revenue'],
  seller_discount: ['商家优惠券', '商家承担折扣', '卖家活动让利', 'seller coupon', 'seller discount', 'merchant discount'],
  platform_subsidy: ['平台补贴', '平台优惠券补贴', '平台活动补贴', 'platform subsidy', 'temu subsidy'],
  refund_amount: ['售后退款', '退款金额', '退货扣款', '货款冲回', 'refund amount', 'after sales refund'],
  commission_fee: ['技术服务费', '平台佣金', '交易服务费', 'commission', 'platform service fee'],
  logistics_fee: ['尾程物流费', '履约物流费', '仓储操作费', '面单费', 'shipping label fee', 'fulfillment fee', 'warehouse fee'],
  penalty_fee: ['履约罚款', '违规扣款', '延迟发货赔付', '质量赔付金', '缺货罚款', 'sla penalty', 'violation fine', 'compliance penalty'],
  ads_fee: ['广告费', '站内推广费', '商品推广扣费', 'ad spend', 'advertising fee'],
  withheld_tax: ['平台代扣税费', '代扣代缴流转税', '商城代扣税', 'marketplace withheld tax', 'withheld tax'],
  reserve_change: ['保证金变动', '预留金变动', '资金限制变动', 'reserve change', 'deposit hold'],
  payout_amount: ['提现金额', '打款金额', '实际结算放款', 'withdrawal amount', 'payout amount'],
  net_settlement: ['应结金额', '结算净额', '本期入账净额', '动账金额', 'net settlement', 'settlement amount'],
}

export function isTemuMatch(_fileName, rows, header, map) {
  if (!('net_settlement' in map && 'date' in map && ('mode' in map || 'tx_type' in map))) return false
  const distinctive = ('retail_gross' in map && ('supply_settlement' in map || 'mode' in map)) ||
    ('supply_settlement' in map && 'penalty_fee' in map)
  // 经营模式只能作为结构在场时的补充，备注和文件名不参与。
  return distinctive || ('mode' in map && 'retail_gross' in map && rows.slice(header + 1, header + 26).some(
    (row) => /^(?:半托管|全托管|fully managed|semi managed)$/i.test(cell(row, map.mode)),
  ))
}

export function parseTemuSheets(fileName, sheets, formatInfo, detectedHeader) {
  for (const [sName, rows] of sheets) {
    const m = detectedHeader || findHeaderRow(rows, TEMU_ALIASES, 4)
    if (!m || (!detectedHeader && !isTemuMatch(`${fileName} ${sName}`, rows, m[0], m[1]))) continue
    const [hdrIdx, colMap] = m
    const fundColumns = evidenceColumns(rows[hdrIdx])
    const dataRows = rows.slice(hdrIdx + 1)

    const dates = []
    let explicitSite = null
    const currencies = new Set()
    for (const r of dataRows) {
      const d = cell(r, colMap.date)
      if (d) dates.push(d)
      const st = cell(r, colMap.site).toUpperCase()
      if (st && (SITE_CURRENCY_FALLBACK[st] || inferDateOrderFromSite(st))) explicitSite = st
      const rawCcy = cell(r, colMap.currency)
      if (rawCcy) currencies.add(normalizeCurrencyCode(rawCcy))
    }
    const currency = currencies.size === 1 ? currencies.values().next().value : 'UNKNOWN'
    const detectedSite = explicitSite || CCY_SITE_FALLBACK[currency] || 'US'
    const dateOrder = inferDateOrderFromSite(explicitSite) || (DMY_CURRENCIES.has(currency) ? 'DMY' : null)
    const s = makeEmptySummary({
      period: inferPeriod(dates, '待确认期间', { dateOrder }),
      platform: 'Temu',
      site: detectedSite,
      currency,
      formatLabel: `Temu 结算账单 (${formatInfo})`,
      fileName,
    })
    appendDateValidationAnomalies(s, dates, dateOrder, 'TEMU')

    const dedSign = detectDeductionSign(
      dataRows,
      colMap,
      ['retail_gross', 'supply_settlement'],
      ['seller_discount', 'refund_amount', 'commission_fee', 'logistics_fee', 'penalty_fee', 'ads_fee'],
      'net_settlement',
    )

    let fullManagedCount = 0
    let fullManagedTotal = 0n
    let semiManagedCount = 0
    let penaltyTotal = 0n
    let penaltyCount = 0

    for (let idx = 0; idx < dataRows.length; idx++) {
      const r = dataRows[idx]
      const oid = cell(r, colMap.order_id) || `ROW-${hdrIdx + 2 + idx}`
      const modeStr = cell(r, colMap.mode).toLowerCase()
      const txType = cell(r, colMap.tx_type).toLowerCase()
      if (oid.toLowerCase().includes('total') || oid.includes('合计') || txType.includes('合计')) continue

      const retail = parseAmount(cell(r, colMap.retail_gross))
      const supply = parseAmount(cell(r, colMap.supply_settlement))
      const shipIn = parseAmount(cell(r, colMap.shipping_income))
      const sDisc = parseAmount(cell(r, colMap.seller_discount)) * dedSign
      const pSub = parseAmount(cell(r, colMap.platform_subsidy))
      const refund = parseAmount(cell(r, colMap.refund_amount)) * dedSign
      const comm = parseAmount(cell(r, colMap.commission_fee)) * dedSign
      const logi = parseAmount(cell(r, colMap.logistics_fee)) * dedSign
      const penalty = parseAmount(cell(r, colMap.penalty_fee)) * dedSign
      const ads = parseAmount(cell(r, colMap.ads_fee)) * dedSign
      const wTax = absBig(parseAmount(cell(r, colMap.withheld_tax)))
      const resvRaw = parseAmount(cell(r, colMap.reserve_change))
      const payoutRaw = absBig(parseAmount(cell(r, colMap.payout_amount)))
      const netRaw = parseAmount(cell(r, colMap.net_settlement))

      if (
        retail === 0n && supply === 0n && shipIn === 0n && sDisc === 0n && pSub === 0n && refund === 0n &&
        comm === 0n && logi === 0n && penalty === 0n && ads === 0n &&
        resvRaw === 0n && payoutRaw === 0n && netRaw === 0n
      ) {
        continue
      }
      s.rawRowCount++

      if (payoutRaw !== 0n || txType.includes('提现') || txType.includes('打款') || txType.includes('payout') || txType.includes('withdrawal')) {
        const payout = parseAmountCell(cell(r, colMap.payout_amount) || cell(r, colMap.net_settlement))
        if (payout.state === 'value') addPayoutEvidence(s, r, fundColumns, cell(r, colMap.date), payout.value, oid, dateOrder)
        continue
      }

      const isFullManaged =
        modeStr.includes('全托管') || modeStr.includes('fully') || modeStr.includes('jit') || modeStr.includes('vmi') ||
        (supply > 0n && retail === 0n && !modeStr.includes('半托管') && !modeStr.includes('semi'))
      if (isFullManaged) {
        fullManagedCount++
        fullManagedTotal += supply > 0n ? supply : absBig(netRaw)
      } else if (retail > 0n || modeStr.includes('半托管') || modeStr.includes('semi') || modeStr.includes('pop')) {
        semiManagedCount++
      }

      const rowGross = (retail > 0n ? retail : supply) + shipIn
      if (rowGross > 0n) s.orderCount++
      s.grossSales += rowGross
      s.sellerDiscount += sDisc
      s.platformSubsidy += pSub
      s.customerRefund += refund
      s.platformCommission += comm
      s.logisticsWarehousing += logi
      s.gatewayDisputeFee += penalty
      s.inPlatformAds += ads
      s.facilitatorTaxStripped += wTax
      // 保证金冻结：若原表填负数(-500 表示冻结扣留)，转为 +500 新增冻结；若填正数按约定符号校核
      const expBeforeResv = rowGross - sDisc + pSub - refund - comm - logi - penalty - ads
      let resvEffect = 0n
      if (resvRaw !== 0n) {
        resvEffect = absBig(expBeforeResv - absBig(resvRaw) - netRaw) < absBig(expBeforeResv + absBig(resvRaw) - netRaw)
          ? absBig(resvRaw)
          : -absBig(resvRaw)
        s.reserveNetChange += resvEffect
      }

      if (penalty > 0n) {
        penaltyCount++
        penaltyTotal += penalty
      }

      if ('net_settlement' in colMap && cell(r, colMap.net_settlement) !== '') {
        const expectedNet = expBeforeResv - resvEffect
        const diff = netRaw - expectedNet
        s.horizontalDiffTotal += diff
        if (absBig(diff) >= CENT_STEP) {
          s.anomalies.push({
            severity: 'P0-阻断',
            category: 'Temu 行内水平守恒校验失败',
            refId: oid,
            amount: fmtAmount(diff),
            detail: `账单应结净额 ${fmtAmount(netRaw)} 与明细推算值 ${fmtAmount(expectedNet)} 差出 ${fmtAmount(diff)}，请检查是否漏列扣款或导出截断`,
          })
        }
      }
    }

    if (fullManagedCount > 0) {
      s.anomalies.push({
        severity: 'P0-阻断',
        category: semiManagedCount > 0 ? 'Temu 全托管供货与半托管自营混同' : 'Temu 全托管供货结算单口径警示',
        refId: `TEMU-FM-${fullManagedCount}`,
        amount: fmtAmount(fullManagedTotal),
        detail: `检出 ${fullManagedCount} 笔全托管供货记录（合计 ${fmtAmount(fullManagedTotal)} ${currency}）。全托管属向平台指定主体供货结算，与半托管境外终端零售（适用税总15号文报送）纳税义务与退免税规则完全不同，严禁混同申报！`,
      })
    }
    if (penaltyCount > 0) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'Temu 履约违规罚款/延迟赔付扣款',
        refId: `TEMU-PENALTY-${penaltyCount}`,
        amount: fmtAmount(penaltyTotal),
        detail: `共检出 ${penaltyCount} 笔平台履约罚款/质量赔付（合计 ${fmtAmount(penaltyTotal)} ${currency}），已归入争议及赔付费用项，须凭结算单列支费用/营业外支出，严禁直接冲减销售收入`,
      })
    }

    if (s.rawRowCount > 0) return [finalizeSummary(s)]
  }
  return null
}
// ── 5. Shopify 独立站原始账单解析器（Shopify Payments / Orders CSV & XLSX） ──
export const SHOPIFY_ALIASES = {
  date: ['transaction date', 'processed at', 'created at', 'payout date', '交易日期', '创建时间'],
  order_name: ['order', 'order name', 'name', '订单号', '订单名称'],
  tx_type: ['type', 'kind', 'transaction type', '交易类型'],
  fin_status: ['financial status', 'payment status', '财务状态', '支付状态'],
  currency: ['currency', 'presentment currency', 'shop currency', '币种', '结算币种'],
  amount: ['amount', 'total', 'gross', 'charge amount', '收款总额', '订单总额'],
  subtotal: ['subtotal', 'lineitem price', '商品小计'],
  shipping: ['shipping', 'shipping amount', '运费'],
  discount: ['discount amount', 'discounts', 'total discounts', '折扣金额'],
  tax: ['tax', 'taxes', 'total tax', 'tax amount', '税额', '代收税费'],
  withheld_tax: ['marketplace facilitator tax', 'shop app tax withheld', 'channel withheld tax', '渠道代扣税'],
  fee: ['fee', 'transaction fee', 'shopify payments fee', '手续费', '通道费'],
  net: ['net', 'net amount', 'payout net', '结算净额', '入账净额'],
  payout_id: ['payout id', 'payout status', '结算批次号', '放款状态'],
  gateway: ['payment method', 'payment gateway', 'gateway', 'card source', '支付网关'],
}

export function isShopifyMatch(_fileName, rows, header, map) {
  if (!('date' in map && 'currency' in map && 'tx_type' in map && 'amount' in map && 'order_name' in map)) return false
  if ('fin_status' in map || 'payout_id' in map) return true
  return 'gateway' in map && rows.slice(header + 1, header + 26).some(
    (row) => /^(?:shopify(?: payments)?|shop_pay)$/i.test(cell(row, map.gateway)),
  )
}

export function parseShopifySheets(fileName, sheets, formatInfo, detectedHeader) {
  for (const [sName, rows] of sheets) {
    const m = detectedHeader || findHeaderRow(rows, SHOPIFY_ALIASES, 4)
    if (!m || (!detectedHeader && !isShopifyMatch(`${fileName} ${sName}`, rows, m[0], m[1]))) continue
    const [hdrIdx, colMap] = m
    const fundColumns = evidenceColumns(rows[hdrIdx])
    const dataRows = rows.slice(hdrIdx + 1)

    const byCcy = new Map()
    const ensureBucket = (ccy) => {
      if (!byCcy.has(ccy)) {
        byCcy.set(ccy, {
          dates: [],
          voidCount: 0,
          summary: makeEmptySummary({
            period: '待确认期间',
            platform: 'Shopify',
            site: SITE_CURRENCY_FALLBACK[ccy] ? ccy : 'DTC',
            currency: ccy,
            formatLabel: `Shopify 独立站流水 (${formatInfo})`,
            fileName,
          }),
        })
      }
      return byCcy.get(ccy)
    }

    for (let idx = 0; idx < dataRows.length; idx++) {
      const r = dataRows[idx]
      const ord = cell(r, colMap.order_name) || `SHP-${hdrIdx + 2 + idx}`
      const tl = cell(r, colMap.tx_type).toLowerCase()
      const fin = cell(r, colMap.fin_status).toLowerCase()
      const ccy = normalizeCurrencyCode(cell(r, colMap.currency))

      const amtRaw = parseAmount(cell(r, colMap.amount))
      const subRaw = absBig(parseAmount(cell(r, colMap.subtotal)))
      const shipRaw = absBig(parseAmount(cell(r, colMap.shipping)))
      const discRaw = absBig(parseAmount(cell(r, colMap.discount)))
      const taxRaw = parseAmount(cell(r, colMap.tax))
      const wTaxRaw = absBig(parseAmount(cell(r, colMap.withheld_tax)))
      const feeRaw = absBig(parseAmount(cell(r, colMap.fee)))
      const hasNetCol = 'net' in colMap && cell(r, colMap.net) !== ''
      const netRaw = hasNetCol ? parseAmount(cell(r, colMap.net)) : 0n

      if (amtRaw === 0n && subRaw === 0n && feeRaw === 0n && netRaw === 0n) continue

      const bucket = ensureBucket(ccy)
      const s = bucket.summary
      const dt = cell(r, colMap.date)
      if (dt) bucket.dates.push(dt)
      s.rawRowCount++

      if (['pending', 'voided', 'authorized', 'expired', 'abandoned', 'canceled', 'cancelled'].includes(fin || tl)) {
        bucket.voidCount++
        s.uncapturedVoidExcluded += absBig(amtRaw || subRaw)
        continue
      }

      if (['payout', 'transfer', '提现', '放款'].includes(tl)) {
        const payout = parseAmountCell(cell(r, colMap.net) || cell(r, colMap.amount))
        const rowOrder = DMY_CURRENCIES.has(ccy) ? 'DMY' : null
        if (payout.state === 'value') addPayoutEvidence(s, r, fundColumns, dt, payout.value, cell(r, colMap.payout_id) || ord, rowOrder)
        continue
      }

      const isDispute = tl.includes('dispute') || tl.includes('chargeback') || fin.includes('chargeback')
      const isRefund = isDispute || tl.includes('refund') || fin === 'refunded' || (amtRaw < 0n && !tl.includes('fee'))

      if (isRefund) {
        const refGross = absBig(amtRaw !== 0n ? amtRaw : subRaw)
        const refTax = absBig(taxRaw)
        if (refTax > 0n) s.selfRemitTaxNet -= refTax
        s.customerRefund += refGross - refTax - wTaxRaw
        if (isDispute) {
          s.gatewayDisputeFee += feeRaw
          s.anomalies.push({
            severity: 'P1-高危',
            category: 'Shopify 拒付争议 (Chargeback)',
            refId: ord,
            amount: fmtAmount(hasNetCol ? netRaw : -(refGross + feeRaw)),
            detail: `订单拒付本金 ${fmtAmount(refGross - refTax)}，不可退争议手续费 ${fmtAmount(feeRaw)}（应计财务费用，勿直接冲收入）`,
          })
        } else if (feeRaw > 0n) {
          s.platformCommission += feeRaw
        }
        continue
      }

      // 正常收款订单行
      const totalCharged = amtRaw > 0n ? amtRaw : subRaw - discRaw + shipRaw + absBig(taxRaw) + wTaxRaw
      if (totalCharged > 0n) s.orderCount++
      const selfTax = absBig(taxRaw)
      const exTaxNetSales = totalCharged - selfTax - wTaxRaw
      s.grossSales += exTaxNetSales + discRaw
      s.sellerDiscount += discRaw
      s.selfRemitTaxNet += selfTax
      s.facilitatorTaxStripped += wTaxRaw
      s.platformCommission += feeRaw

      if (hasNetCol) {
        const expectedNet = totalCharged - wTaxRaw - feeRaw
        const diff = netRaw - expectedNet
        s.horizontalDiffTotal += diff
        if (absBig(diff) >= CENT_STEP) {
          s.anomalies.push({
            severity: 'P0-阻断',
            category: 'Shopify 行内水平守恒校验失败',
            refId: ord,
            amount: fmtAmount(diff),
            detail: `结算净额 ${fmtAmount(netRaw)} 与 (实收 ${fmtAmount(totalCharged)} - 渠道代扣税 ${fmtAmount(wTaxRaw)} - 手续费 ${fmtAmount(feeRaw)}) 差出 ${fmtAmount(diff)}`,
          })
        }
      }
    }

    const explicitFileSite = /(?:^|[._\s-])(US|EU|DE|FR|IT|ES|UK|GB|NL|BE|IE|AU|SG)(?:$|[._\s-])/i.exec(fileName)?.[1]?.toUpperCase() || null
    const out = []
    for (const [, b] of byCcy) {
      const s = b.summary
      if (s.rawRowCount === 0) continue
      const dateOrder = inferDateOrderFromSite(explicitFileSite) || (DMY_CURRENCIES.has(s.currency) ? 'DMY' : null)
      s.period = inferPeriod(b.dates, '待确认期间', { dateOrder })
      appendDateValidationAnomalies(s, b.dates, dateOrder, 'SHP')
      if (b.voidCount > 0) {
        s.anomalies.push({
          severity: 'P2-关注',
          category: '已自动过滤 Shopify 未结清/预授权/作废订单',
          refId: `SHP-VOID-${b.voidCount}`,
          amount: fmtAmount(s.uncapturedVoidExcluded),
          detail: `共剔除 ${b.voidCount} 笔 Pending/Authorized/Voided 订单（合计 ${fmtAmount(s.uncapturedVoidExcluded)} ${s.currency}），防止独立站弃单虚增申报收入`,
        })
      }
      if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'Shopify 独立站自收待申报境外 VAT / Sales Tax',
          refId: 'SHP-SELF-TAX',
          amount: fmtAmount(s.selfRemitTaxNet),
          detail: `独立站结账向买家代收流转税净额 ${fmtAmount(s.selfRemitTaxNet)} ${s.currency} 已剥离，须计入其他应付款并按目的国税法申报，严禁混入主营业务收入`,
        })
      }
      out.push(finalizeSummary(s))
    }
    if (out.length) return out
  }
  return null
}

// ── 内置零文件脱敏沙盒样本生成器（供新用户免账单 10ms 体验全链路排雷） ──
export function getDemoStatementBuffers(demoKey = 'all') {
  const k = String(demoKey || 'all').replace(/^demo:?/i, '').toLowerCase() || 'all'
  const samples = {
    amazon: [
      'Demo_Amazon_US_202611.csv',
      [
        '"Includes Amazon Marketplace, Fulfillment by Amazon (FBA) transactions"',
        '"date/time","settlement id","type","order id","marketplace","product sales","product sales tax","shipping credits","promotional rebates","marketplace withheld tax","selling fees","fba fees","other","total"',
        '"2026-11-05","SET-901","Order","112-8801","amazon.com","50000.00","4000.00","2000.00","-2000.00","-4000.00","-7500.00","-6500.00","0.00","36000.00"',
        '"2026-11-12","SET-901","Refund","112-8802","amazon.com","-3000.00","-240.00","0.00","0.00","240.00","450.00","0.00","0.00","-2550.00"',
        '"2026-11-18","SET-901","Transfer","","amazon.com","0.00","0.00","0.00","0.00","0.00","0.00","0.00","-33450.00","-33450.00"',
      ].join('\n'),
    ],
    temu: [
      'Demo_Temu_US_202611.csv',
      [
        '结算时间,订单号,经营模式,账务类型,站点,币种,商品零售价,供货结算价,商家优惠券,平台补贴,售后退款,技术服务费,尾程物流费,履约罚款,应结金额',
        '2026-11-08,PO-US-201,半托管,销售结算,US,USD,30000.00,0.00,1000.00,800.00,0.00,1500.00,4200.00,300.00,23800.00',
        '2026-11-10,JIT-CN-99,全托管,供货货款,US,USD,0.00,8500.00,0.00,0.00,0.00,0.00,0.00,0.00,8500.00',
        '2026-11-20,WD-1120,,提现打款,US,USD,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,32300.00',
      ].join('\n'),
    ],
    shopify: [
      'Demo_Shopify_EU_202611.csv',
      [
        'Transaction Date,Type,Order,Financial Status,Currency,Amount,Discount Amount,Tax,Fee,Net,Payout ID',
        '2026-11-06,charge,#1081,paid,EUR,12000.00,500.00,2000.00,360.00,11640.00,PO-EU-1',
        '2026-11-09,charge,#1082,pending,EUR,3500.00,0.00,580.00,0.00,0.00,',
        '2026-11-15,payout,,paid,EUR,11640.00,0.00,0.00,0.00,11640.00,PO-EU-1',
      ].join('\n'),
    ],
  }
  const allSalesSamples = { ...samples, ...V7_DEMO_SAMPLES }
  const allSamples = { ...allSalesSamples, ...V8_DEMO_SAMPLES }
  if (k === 'all') return Object.values(samples).map(([fn, txt]) => [fn, Buffer.from(txt, 'utf8')])
  if (k === 'v7') return Object.values(V7_DEMO_SAMPLES).map(([fn, txt]) => [fn, Buffer.from(txt, 'utf8')])
  if (k === 'v8' || k === 'chain') {
    return [...Object.values(samples), ...Object.values(V8_DEMO_SAMPLES)].map(([fn, txt]) => [fn, Buffer.from(txt, 'utf8')])
  }
  if (k === 'wallets') return Object.values(V8_DEMO_SAMPLES).map(([fn, txt]) => [fn, Buffer.from(txt, 'utf8')])
  if (k === 'full') return Object.values(allSalesSamples).map(([fn, txt]) => [fn, Buffer.from(txt, 'utf8')])
  if (allSamples[k]) return [[allSamples[k][0], Buffer.from(allSamples[k][1], 'utf8')]]
  throw new Error(
    `未知沙盒演示标识 '${demoKey}'（可选 demo:all / demo:v7 / demo:v8 / demo:wallets / demo:full / demo:amazon / demo:temu / demo:shopify / demo:paypal / demo:aliexpress / demo:shopee / demo:worldfirst / demo:payoneer / demo:airwallex）`,
  )
}

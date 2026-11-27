// dsh-fintax v0.9.0 扩展通道解析器：
//   - 3 大国内高频结汇钱包（连连国际 LianLian / PingPong / 寻汇 SUNRATE，独立 settlement_wallet 轨，绝不计入销售收入）
//   - 3 大主流跨境销售平台（SHEIN / Walmart / Lazada，Stage 1 销售轨，严格保留费用冲回负值符号）
//   - Amazon v9 扩展配置（FR/IT/ES 本地化表头别名、SE/PL/BE/TR/AE/SA/BR/IN/IE 站点映射、2027 新增费用科目识别）
// 纯 Node.js ESM 零第三方依赖，共享 lib/statement.js 的 BigInt 1e-8 定点算术内核与 HMAC 凭证哈希。

import {
  AMOUNT_SCALE,
  CENT_STEP,
  COMMERCIAL_SPEND_RE,
  CORPORATE_ENTITY_RE,
  PERSONAL_ACCOUNT_RE,
  absBig,
  addPayoutEvidence,
  appendDateValidationAnomalies,
  cell,
  detectDeductionSign,
  evidenceColumns,
  evidenceKey,
  extractAccountPrefix,
  extractAccountSuffix,
  extractFullBankAccountDigits,
  finalizeSummary,
  findHeaderRow,
  findInvalidCalendarDates,
  fmtAmount,
  inferDateOrderFromSite,
  inferPeriod,
  makeEmptySummary,
  mulScaledBig,
  normalizeBankInstitutionCode,
  normalizeCurrencyCode,
  normalizeEntityName,
  normalizeReferenceToken,
  parseAmount,
  parseAmountCell,
  pickFundEvidence,
  q2,
  transactionMonth,
} from './statement_shared.js'

// ── 共享正则与实体/账号脱敏工具（自 statement_shared.js 重导出以保持向后兼容） ──
export {
  COMMERCIAL_SPEND_RE,
  CORPORATE_ENTITY_RE,
  PERSONAL_ACCOUNT_RE,
  extractAccountPrefix,
  extractAccountSuffix,
  extractFullBankAccountDigits,
  mulScaledBig,
  normalizeBankInstitutionCode,
  normalizeEntityName,
  normalizeReferenceToken,
}

const TOTAL_ROW_RE = /^(?:total|subtotal|summary|grand\s*total|合计|总计|小计|汇总|本期合计|发生额合计)$/i

const SITE_BY_CCY = {
  USD: 'US', EUR: 'EU', GBP: 'UK', AUD: 'AU', CAD: 'CA', JPY: 'JP',
  SGD: 'SG', MYR: 'MY', THB: 'TH', VND: 'VN', PHP: 'PH', IDR: 'ID',
  HKD: 'HK', CNY: 'CN', MXN: 'MX', BRL: 'BR', SEK: 'SE', PLN: 'PL',
  TRY: 'TR', AED: 'AE', SAR: 'SA', INR: 'IN', CLP: 'CL',
}

const PLATFORM_MENTION_RE =
  /\b(?:amazon|amz|tiktok|bytedance|temu|whaleco|aliexpress|shopee|shopify|paypal|stripe|walmart|ebay|etsy|wayfair|shein|zoetop|roadget|lazada|mercadolibre|ozon|rakuten)\b|速卖通|虾皮|希音|沃尔玛|来赞达/i

const PLATFORM_INFER_RULES = [
  ['Amazon', /\b(?:amazon|amz)\b/i],
  ['TikTok Shop', /\b(?:tiktok|bytedance)\b/i],
  ['Temu', /\b(?:temu|whaleco)\b/i],
  ['AliExpress', /\baliexpress\b|速卖通/i],
  ['Shopee', /\bshopee\b|虾皮/i],
  ['Shopify', /\bshopify\b/i],
  ['PayPal', /\bpaypal\b/i],
  ['Stripe', /\bstripe\b/i],
  ['SHEIN', /\bshein\b|希音|zoetop|roadget/i],
  ['Walmart', /\bwalmart\b|沃尔玛/i],
  ['Lazada', /\blazada\b|来赞达/i],
]

const SOURCE_PLATFORM_CODE_MAP = new Map([
  ['amazon', 'Amazon'], ['amz', 'Amazon'], ['亚马逊', 'Amazon'],
  ['tiktok', 'TikTok Shop'], ['tiktok shop', 'TikTok Shop'],
  ['temu', 'Temu'], ['aliexpress', 'AliExpress'], ['速卖通', 'AliExpress'],
  ['shopee', 'Shopee'], ['虾皮', 'Shopee'], ['shopify', 'Shopify'],
  ['paypal', 'PayPal'], ['stripe', 'Stripe'],
  ['shein', 'SHEIN'], ['希音', 'SHEIN'],
  ['walmart', 'Walmart'], ['沃尔玛', 'Walmart'],
  ['lazada', 'Lazada'], ['来赞达', 'Lazada'],
])

const BANK_HINTS = [
  ['招商银行', /招商银行|招行|\bcmb\b/i],
  ['中国银行', /中国银行|中行|\bboc\b/i],
  ['中国工商银行', /工商银行|工行|\bicbc\b/i],
  ['中国建设银行', /建设银行|建行|\bccb\b/i],
  ['中国农业银行', /农业银行|农行|\babc\b/i],
  ['交通银行', /交通银行|交行|\bbocom\b/i],
  ['平安银行', /平安银行/i],
  ['兴业银行', /兴业银行/i],
  ['浦发银行', /浦发银行|浦东发展银行/i],
]

function inferPlatformMention(text) {
  const s = String(text ?? '')
  for (const [label, re] of PLATFORM_INFER_RULES) {
    if (re.test(s)) return label
  }
  return null
}

function resolveSourcePlatform(raw, fallbackText = '') {
  const norm = String(raw ?? '').trim().toLowerCase()
  if (norm && SOURCE_PLATFORM_CODE_MAP.has(norm)) return SOURCE_PLATFORM_CODE_MAP.get(norm)
  return inferPlatformMention(`${raw || ''} ${fallbackText || ''}`)
}

function inferBankHint(text) {
  const s = String(text ?? '')
  for (const [label, re] of BANK_HINTS) {
    if (re.test(s)) return label
  }
  return null
}

const enumVal = (v) => String(v ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim()

function normHdrCell(text) {
  if (text == null) return ''
  return String(text)
    .trim()
    .replace(/^\ufeff/, '')
    .toLowerCase()
    .replace(/[\s_\-/\\（）()[\]【】:：.]+/g, ' ')
    .trim()
}

// ════════════════════════════════════════════════════════════════
// 1. Amazon v9 扩展映射（FR/IT/ES 表头别名、9 大新兴站点、2027 新增费用科目）
// ════════════════════════════════════════════════════════════════

export const AMAZON_V9_HEADER_ALIASES = {
  date_time: ['date/heure', 'date heure', 'data/ora', 'data/ora:', 'fecha/hora', 'fecha y hora'],
  settlement_id: [
    'numéro de versement', 'numero de versement', 'id de règlement',
    'numero pagamento', 'id pagamento',
    'identificador de pago', 'id de liquidación', 'id. de liquidación', 'numero de liquidacion',
  ],
  type: ['type', 'tipo'],
  order_id: [
    'numéro de la commande', 'numero de la commande', 'numero de commande',
    'numero ordine',
    'número de pedido', 'numero de pedido',
  ],
  description: ['description', 'descrizione', 'descripción', 'descripcion'],
  marketplace: ['marketplace', 'site de vente', 'web de amazon'],
  product_sales: ['ventes de produits', 'ventes produits', 'vendite', 'ventas de productos'],
  product_sales_tax: [
    'taxes sur la vente des produits', 'taxe sur les ventes de produits',
    'imposta sulle vendite dei prodotti',
    'impuesto de ventas de productos',
  ],
  shipping_credits: [
    "crédits d'expédition", 'credits d expedition', 'frais de port',
    'accrediti per le spedizioni',
    'abonos de envío', 'abonos de envio',
  ],
  shipping_credits_tax: [
    "taxes sur les crédits d'expédition", 'taxe sur les frais de port',
    'imposta sugli accrediti per le spedizioni',
    'impuestos por abonos de envío', 'impuestos por abonos de envio',
  ],
  gift_wrap_credits: [
    "crédits sur l'emballage cadeau", "frais d'emballage cadeau",
    'accrediti per confezioni regalo',
    'abonos de envoltorio para regalo',
  ],
  giftwrap_credits_tax: [
    "taxes sur les crédits d'emballage cadeau",
    'imposta sugli accrediti per confezioni regalo',
    'impuesto sobre abonos de envoltorio para regalo',
  ],
  regulatory_fee: ['frais réglementaires', 'frais reglementaires', 'commissioni regolamentari', 'tarifa reglamentaria'],
  tax_on_regulatory_fee: [
    'taxes sur les frais réglementaires',
    'imposte sulle commissioni regolamentari',
    'impuesto sobre la tarifa reglamentaria',
  ],
  promotional_rebates: [
    'rabais promotionnels', 'remises promotionnelles',
    'sconti promozionali',
    'devoluciones promocionales', 'descuentos promocionales',
  ],
  promotional_rebates_tax: [
    'taxes sur les rabais promotionnels',
    'imposta sugli sconti promozionali',
    'impuestos por devoluciones promocionales',
  ],
  marketplace_withheld_tax: [
    'taxe prélevée par le site de vente', 'impôt retenu sur le site de vente',
    'trattenuta fiscale del marketplace',
    'impuesto de retención en la plataforma', 'impuesto retenido por el sitio web',
  ],
  selling_fees: ['frais de vente', 'commissioni di vendita', 'tarifas de venta'],
  fba_fees: [
    'frais expédié par amazon', 'frais fba',
    'costi del servizio logistica di amazon', 'commissioni logistica di amazon',
    'tarifas de logística de amazon', 'tarifas de logistica de amazon',
  ],
  other_transaction_fees: [
    'autres frais de transaction',
    'altri costi relativi alle transazioni',
    'tarifas de otras transacciones',
  ],
  other: ['autre', 'autres', 'altro', 'otro', 'otros'],
  total: ['total', 'totale'],
}

export const AMAZON_V9_ROW_TYPE_ALIASES = {
  order: ['commande', 'ordine', 'pedido'],
  refund: ['remboursement', 'rimborso', 'reembolso'],
  transfer: ['transfert', 'trasferimento', 'transferir'],
  service_fee: ['frais de service', 'commissioni di servizio', 'tarifa de servicio', 'tarifas de servicio'],
  inventory_fee: [
    'frais de stock expédié par amazon', 'frais de stock fba',
    'tariffa di inventario logistica di amazon',
    'tarifa de inventario de logística de amazon', 'tarifa de inventario de logistica de amazon',
  ],
  adjustment: ['ajustement', 'rettifica', 'ajuste'],
  reserve: ['solde indisponible', 'saldo non disponibile', 'saldo no disponible', 'réserve', 'riserva', 'reserva'],
}

export const AMAZON_V9_SITE_MAP = {
  SE: { site: 'SE', currency: 'SEK', domains: ['amazon.se', 'se'], region: 'EU', dac7Scope: true },
  PL: { site: 'PL', currency: 'PLN', domains: ['amazon.pl', 'pl'], region: 'EU', dac7Scope: true },
  BE: { site: 'BE', currency: 'EUR', domains: ['amazon.com.be', 'amazon.be', 'com.be', 'be'], region: 'EU', dac7Scope: true },
  TR: { site: 'TR', currency: 'TRY', domains: ['amazon.com.tr', 'com.tr', 'tr'], region: 'EMEA', dac7Scope: false },
  AE: { site: 'AE', currency: 'AED', domains: ['amazon.ae', 'ae'], region: 'MENA', dac7Scope: false },
  SA: { site: 'SA', currency: 'SAR', domains: ['amazon.sa', 'sa'], region: 'MENA', dac7Scope: false },
  BR: { site: 'BR', currency: 'BRL', domains: ['amazon.com.br', 'com.br', 'br'], region: 'LATAM', dac7Scope: false },
  IN: { site: 'IN', currency: 'INR', domains: ['amazon.in', 'in'], region: 'APAC', dac7Scope: false },
  IE: { site: 'IE', currency: 'EUR', domains: ['amazon.ie', 'ie'], region: 'EU', dac7Scope: true },
}

export const AMAZON_V9_SITE_TO_CURRENCY = Object.freeze(
  Object.fromEntries(Object.entries(AMAZON_V9_SITE_MAP).map(([code, meta]) => [code, meta.currency])),
)

const AMAZON_V9_DOMAIN_INDEX = new Map()
for (const meta of Object.values(AMAZON_V9_SITE_MAP)) {
  AMAZON_V9_DOMAIN_INDEX.set(meta.site.toLowerCase(), meta)
  for (const dom of meta.domains) AMAZON_V9_DOMAIN_INDEX.set(dom.toLowerCase(), meta)
}

export function resolveAmazonV9Site(rawMarketplace) {
  const cleaned = String(rawMarketplace ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
  if (!cleaned) return null
  if (AMAZON_V9_DOMAIN_INDEX.has(cleaned)) return AMAZON_V9_DOMAIN_INDEX.get(cleaned)
  const m = cleaned.match(/^amazon(?:\s+marketplace)?\.([a-z.]+)$/)
  if (m && AMAZON_V9_DOMAIN_INDEX.has(m[1])) return AMAZON_V9_DOMAIN_INDEX.get(m[1])
  return null
}

export const AMAZON_2027_FEE_PATTERNS = [
  {
    id: 'aged_monthly_storage_2027',
    label: '合并后库龄月度仓储费 (2027 FBA Aged Monthly Storage)',
    bucket: 'logisticsWarehousing',
    severity: 'P2-关注',
    effectiveYear: 2027,
    pattern: /aged[\s_-]*inventory.*(?:monthly\s*)?storage|consolidated.*storage\s*fee|monthly.*aged.*storage|tiered.*aged.*storage|库龄.*月度?仓储费|合并.*库龄.*仓储|超龄.*月度仓储/i,
    note: '2027 起月度仓储费与超龄库龄附加费合并计收，已归入物流仓储费并建议单独复核高库龄滞销库存。',
  },
  {
    id: 'awd_mcd_fuel_surcharge_2027',
    label: 'AWD/MCD 3.5% 燃油及物流附加费',
    bucket: 'logisticsWarehousing',
    severity: 'P2-关注',
    effectiveYear: 2027,
    surchargeRate: 0.035,
    pattern: /(?:awd|amazon\s*warehousing\s*(?:and|&)\s*distribution|mcd|multi[\s-]*channel\s*distribution).*(?:fuel|surcharge|燃油|附加费)|(?:fuel\s*(?:and\s*inflation\s*)?surcharge|燃油附加费).*(?:awd|mcd|3\.5%)|3\.5%\s*(?:awd|mcd)?\s*(?:fuel|燃油)/i,
    note: '识别到 AWD/MCD 3.5% 燃油附加费，归入头程/物流仓储成本，切勿直接冲减销售收入。',
  },
  {
    id: 'oversize_6tier_fulfillment_2027',
    label: '6 级 Oversize 超大件配送费',
    bucket: 'logisticsWarehousing',
    severity: 'P2-关注',
    effectiveYear: 2027,
    tiers: 6,
    pattern: /(?:oversize|over[\s-]*size|extra[\s-]*large|bulky).*(?:tier\s*[1-6]|6[\s-]*tier|fulfillment|delivery|fee|配送费|尾程)|(?:small|medium|large|extra[\s-]*large|special|super)\s*oversize.*(?:fee|fulfillment|delivery)|(?:6级|六级|超大件|大件[1-6一二三四五六]级).*配送费/i,
    note: '识别到 2027 新 6 级 Oversize 超大件尾程配送费，已归入物流履约费，建议核对包装尺寸分段。',
  },
]

export function classifyAmazon2027Fee(type, description = '') {
  const combined = `${type || ''} ${description || ''}`.trim()
  if (!combined) return null
  for (const rule of AMAZON_2027_FEE_PATTERNS) {
    if (rule.pattern.test(combined)) {
      return {
        id: rule.id,
        label: rule.label,
        bucket: rule.bucket,
        severity: rule.severity,
        effectiveYear: rule.effectiveYear,
        surchargeRate: rule.surchargeRate ?? null,
        tiers: rule.tiers ?? null,
        note: rule.note,
      }
    }
  }
  return null
}

export function mergeAmazonV9HeaderAliases(baseAliases = {}) {
  const merged = {}
  const keys = new Set([...Object.keys(baseAliases || {}), ...Object.keys(AMAZON_V9_HEADER_ALIASES)])
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const baseList = Array.isArray(baseAliases[key]) ? baseAliases[key] : []
    const extList = Array.isArray(AMAZON_V9_HEADER_ALIASES[key]) ? AMAZON_V9_HEADER_ALIASES[key] : []
    merged[key] = [...new Set([...baseList, ...extList])]
  }
  return merged
}

// ════════════════════════════════════════════════════════════════
// 2. 3 大国内高频结汇钱包（连连国际 / PingPong / 寻汇 SUNRATE）
// ════════════════════════════════════════════════════════════════

const WALLET_EXTRAS = {
  account: ['settlement account id', 'wallet account id', 'wallet id', 'account id', '资金账户编号', '结汇账户编号', '收款账户编号'],
  original_reference: ['original transaction id', 'original payout id', 'related transaction id', '原流水号', '原交易编号', '关联流水号'],
  opening: ['opening balance', 'beginning balance', '期初余额', '期初可用余额'],
  closing: ['closing balance', 'ending balance', '期末余额', '期末可用余额'],
  credit: ['入账金额', '收款金额', '收入金额', '贷方金额', 'credit', 'credit amount', 'amount in', 'inflow', 'deposit amount'],
  debit: ['提现金额', '出账金额', '结汇金额', '汇出金额', '出金金额', '支出金额', 'withdrawal amount', 'payout amount', 'debit', 'debit amount', 'amount out', 'outflow', 'sell amount'],
}

export const LIANLIAN_ALIASES = {
  date: ['交易时间', '交易日期', '完成时间', '结汇时间', '提现时间', '入账时间', 'transaction date', 'transaction time', 'completed time', 'settlement time', 'date'],
  tx_id: ['连连流水号', '交易流水号', '业务单号', '提现单号', '结汇单号', '流水号', 'lianlian transaction id', 'transaction id', 'order no', 'reference no'],
  tx_type: ['交易类型', '业务类型', '资金类型', '收支类型', 'transaction type', 'business type', 'type'],
  source_platform: ['平台来源', '来源平台', '店铺名称', '电商平台', '收款店铺', 'source platform', 'platform', 'store name', 'marketplace'],
  counterparty: ['收款户名', '对方户名', '收款方', '银行户名', '交易对手', '收款人', 'beneficiary', 'beneficiary name', 'counterparty', 'payee', 'account holder'],
  bank_account: ['收款银行账号', '银行账号', '收款账号', '银行卡号', 'bank account', 'beneficiary account', 'account number', 'bank account no'],
  bank_name: ['收款银行', '开户行', '银行名称', 'bank name', 'beneficiary bank'],
  desc: ['备注', '摘要', '附言', '说明', 'remark', 'description', 'memo', 'note'],
  currency: ['币种', '原币种', '交易币种', '账户币种', 'currency', 'source currency', 'ccy'],
  amount: ['交易金额', '发生额', '金额', 'amount', 'transaction amount', 'gross amount'],
  fee: ['手续费', '提现手续费', '结汇手续费', '服务费', '费用', 'fee', 'service fee', 'withdrawal fee', 'handling fee'],
  net: ['净额', '净变动', '实扣金额', '到账原币金额', 'net amount', 'net'],
  fx_rate: ['汇率', '结汇汇率', '成交汇率', '牌价', 'exchange rate', 'fx rate', 'rate'],
  cny_received: ['实收人民币', '结汇人民币金额', '实收金额 人民币', '到账人民币', '折合人民币', '人民币金额', 'received cny', 'cny amount', 'settlement amount cny', 'target amount', 'rmb amount'],
  target_currency: ['目标币种', '到账币种', '结算币种', 'target currency', 'payout currency'],
  status: ['状态', '交易状态', '提现状态', '订单状态', 'status', 'transaction status'],
}

export const PINGPONG_ALIASES = {
  date: ['交易时间', '交易日期', '创建时间', '完成时间', '提现日期', '入账日期', 'transaction time', 'transaction date', 'created time', 'completed at', 'date'],
  tx_id: ['pingpong单号', 'pingpong流水号', '交易单号', '流水号', '业务单号', '提现单号', 'pingpong id', 'transaction id', 'order id', 'reference id'],
  tx_type: ['交易类型', '资金类型', '业务类型', '操作类型', 'transaction type', 'business type', 'type'],
  source_platform: ['店铺名称', '来源平台', '平台来源', '平台', '收款店铺', 'store name', 'store', 'platform', 'source platform', 'marketplace'],
  counterparty: ['收款人', '收款户名', '对方户名', '收款账户名称', '银行户名', '交易对手', 'beneficiary', 'recipient', 'counterparty', 'account name'],
  bank_account: ['收款账号', '银行账号', '收款银行账号', '卡号', 'bank account', 'account number', 'beneficiary account'],
  bank_name: ['收款银行', '开户银行', '银行名称', 'bank name'],
  desc: ['备注', '交易说明', '摘要', '附言', 'remark', 'description', 'memo', 'details'],
  currency: ['币种', '交易币种', '收款币种', '原币种', 'currency', 'original currency', 'ccy'],
  amount: ['交易金额', '金额', '发生额', 'amount', 'transaction amount', 'gross amount'],
  fee: ['pingpong手续费', '手续费', '提现费', '服务费', '费用', 'fee', 'service fee', 'withdrawal fee'],
  net: ['净额', '实付金额', '到账净额', '净变动', 'net amount', 'net'],
  fx_rate: ['提现汇率', '结汇汇率', '汇率', '参考汇率', 'fx rate', 'exchange rate', 'rate'],
  cny_received: ['实收人民币', '到账金额 人民币', '到账人民币', '结汇实收', '人民币到账金额', 'payout amount cny', 'cny received', 'cny amount', 'target amount', 'received amount'],
  target_currency: ['到账币种', '目标币种', 'target currency', 'payout currency'],
  status: ['状态', '交易状态', '提现状态', 'status', 'transaction status'],
}

export const SUNRATE_ALIASES = {
  date: ['交易日期', '交易时间', '记账日期', '交割日期', '完成时间', 'value date', 'transaction date', 'created at', 'settlement date', 'date'],
  tx_id: ['寻汇流水号', '交易编号', '参考号', '业务流水号', '交易流水号', 'sunrate reference', 'transaction id', 'reference number', 'reference id', 'order no'],
  tx_type: ['交易类型', '业务类型', '资金方向类型', 'transaction type', 'product type', 'type', 'category'],
  source_platform: ['来源平台', '收款平台', '平台来源', '店铺', 'source platform', 'platform', 'marketplace', 'store'],
  counterparty: ['收款方名称', '收款户名', '对方户名', '交易对手', '收款人', 'beneficiary', 'beneficiary name', 'counterparty', 'payer payee'],
  bank_account: ['收款银行账号', '银行账号', '收款账号', 'account number', 'beneficiary account', 'bank account'],
  bank_name: ['收款银行', '开户行', 'beneficiary bank', 'bank name'],
  desc: ['摘要', '附言', '备注', '用途', 'purpose', 'description', 'remark', 'reference', 'memo'],
  currency: ['原币种', '交易币种', '币种', 'sell currency', 'currency', 'source currency', 'ccy'],
  amount: ['交易金额', '金额', '发生额', 'amount', 'transaction amount'],
  fee: ['手续费', '汇款手续费', '服务费', '费用', 'fee', 'transfer fee', 'service fee', 'commission'],
  net: ['净额', '净变动', '实际扣款金额', 'net amount', 'net'],
  fx_rate: ['成交汇率', '交割汇率', '结汇汇率', '汇率', 'deal rate', 'fx rate', 'exchange rate', 'rate'],
  cny_received: ['实收人民币', '买入金额', '到账金额', '结汇人民币', 'buy amount', 'target amount', 'payout cny', 'cny amount', 'received cny'],
  target_currency: ['买入币种', '目标币种', '到账币种', 'buy currency', 'target currency', 'payout currency'],
  status: ['状态', '交易状态', '订单状态', 'status', 'transaction status'],
}

const VOID_STATUS_RE = /^(?:pending|cancelled|canceled|declined|failure|failed|rejected|voided|void|processing|unposted|unsettled|待处理|待入账|未入账|未结算|失败|取消|已取消|撤销|已撤销|处理中|已关闭|交易失败)$/
const RETURN_STATUS_RE = /^(?:returned|reversed|bounced|refunded|退汇|已退回|已退汇|退票)$/
const TERMINAL_WALLET_STATUS_RE = /^(?:completed|complete|settled|paid|succeeded|success|posted|done|finished|closed|已完成|成功|已入账|已打款|已结汇|已到账|已成功)$/
const RETURN_TYPE_RE = /^(?:return(?:ed)?|(?:returned?|reversed?|rejected?) (?:wire|payout|withdrawal|transfer|funds?)|(?:wire|payout|withdrawal|transfer) (?:return|returned|reversal|reversed)|bounce(?:d)?|退汇|退汇入账|退汇退回|银行退汇|银行退票|结汇退汇|结汇退回|退回钱包|提现退回|提款退回|打款退回|汇款退回|出金退回)$/
const FROZEN_TYPE_RE = /^(?:freeze|frozen|unfreeze|unfrozen|funds? hold|balance hold|account hold|reserve hold|reserve release|冻结|解冻|扣留|风控冻结|账户冻结|资金冻结|资金解冻)$/
const WITHDRAW_TYPE_RE = /^(?:withdraw(?:al)?(?: to (?:bank|bank account|private account|personal bank account|cny))?|payout|bank payout|bank transfer|bank withdrawal|fx payout|fx withdrawal|outbound payout|settlement payout|settlement to bank|transfer to bank|repatriation|提现|结汇提现|提现结汇|结汇|外汇结汇|结汇出金|人民币提现|外币提现|原币提现|全球汇款|跨境出金|出金|转出至银行|汇款至国内|提现至国内银行|提现到银行卡)$/
const FEE_REFUND_TYPE_RE = /^(?:fee refund|refund fee|fee reversal|退手续费|手续费返还|手续费冲回)$/
const FEE_TYPE_RE = /^(?:fee|fees|service fee|annual (?:account )?fee|withdrawal fee|fx fee|wire fee|handling fee|手续费|提现费|账户年费|电汇费|服务费)$/
const INTERNAL_TYPE_RE = /^(?:conversion|fx conversion|fx exchange|currency conversion|currency exchange|currency swap|wallet fx|manage currencies|internal transfer|self transfer|wallet transfer|内部换汇|换汇|外汇兑换|货币兑换|币种互转|账户互转|内部划转)$/
const SPEND_TYPE_RE = /^(?:card purchase|card payment|card spend|issuing|make a payment|pay a recipient|supplier payment|vat payment|direct payment|subscription|purchase|余额直付|刷卡|虚拟卡消费|供应商付款|付供应商|付物流|采购款|广告费|广告充值|物流费|缴税|vat缴税|代付)$/
const DEPOSIT_TYPE_RE = /^(?:incoming|deposit|collection|global account deposit|platform payout|platform settlement|marketplace payout|marketplace deposit|store deposit|payment received|平台回款|平台结算|电商平台收款|跨境收款|店铺入账|平台打款|全球收款入账|收款|入账)$/
const PLATFORM_REVERSAL_RE = /^(?:platform (?:payout|settlement) reversal|平台回款冲回|平台结算冲回)$/
const PLATFORM_DEPOSIT_RE = /^(?:global account deposit|platform payout|platform settlement|marketplace payout|marketplace deposit|store deposit|平台回款|平台结算|电商平台收款|跨境收款|店铺入账|平台打款|全球收款入账)$/

const WALLET_TX_TYPES = [
  WITHDRAW_TYPE_RE, RETURN_TYPE_RE, FROZEN_TYPE_RE, FEE_TYPE_RE,
  FEE_REFUND_TYPE_RE, INTERNAL_TYPE_RE, SPEND_TYPE_RE, DEPOSIT_TYPE_RE, PLATFORM_REVERSAL_RE,
]

const V9_WALLET_PROVIDERS = [
  {
    id: 'lianlian',
    label: 'LianLian',
    displayName: '连连国际',
    aliases: LIANLIAN_ALIASES,
    includedWithdrawalFee: true,
    fileRe: /lianlian|连连/i,
    refRe: /^(?:ll|llg|lianlian)[-_]/i,
    exclusiveHeaderRe: /^(?:连连流水号|lianlian transaction id)$/i,
  },
  {
    id: 'pingpong',
    label: 'PingPong',
    displayName: 'PingPong',
    aliases: PINGPONG_ALIASES,
    includedWithdrawalFee: true,
    fileRe: /pingpong|乒乓/i,
    refRe: /^(?:ppg|png|pingpong|pp-(?:wd|in|fx|tx|out))[-_]?/i,
    exclusiveHeaderRe: /^(?:pingpong单号|pingpong流水号|pingpong手续费|pingpong id)$/i,
  },
  {
    id: 'sunrate',
    label: 'SUNRATE',
    displayName: '寻汇 SUNRATE',
    aliases: SUNRATE_ALIASES,
    includedWithdrawalFee: true,
    fileRe: /sunrate|寻汇/i,
    refRe: /^(?:sr|sun|sunrate)[-_]/i,
    exclusiveHeaderRe: /^(?:寻汇流水号|sunrate reference|sunrate id|sunrate tx id)$/i,
  },
]

const SUNRATE_GENERIC_FX_HDR_RE = /^(?:sell currency|buy currency|出金金额)$/i
const FOREIGN_WALLET_GUARD_RE = /^(?:financial transaction type|financial transaction id|wallet currency|credit\s*\/\s*debit|balance impact|total released amount|worldfirst.*|payoneer.*|airwallex.*)$/i
const V8_FILENAME_GUARD_RE = /worldfirst|万里汇|payoneer|派安盈|airwallex|空中云汇/i
const V8_REF_GUARD_RE = /^(?:wf|py|pyo|awx)[-_]/i
const V8_ENUM_GUARD_RE = /^(?:GLOBAL_ACCOUNT_DEPOSIT|RETURNED_PAYOUT|CARD_PURCHASE|FX_CONVERSION)$/
const V8_BRAND_MENTION_RE = /\b(?:worldfirst|payoneer|airwallex)\b|万里汇|派安盈|空中云汇/i

function walletNote(summary, severity, reason, amount, detail) {
  summary.anomalies.push({ severity, category: summary.platform + ' ' + reason, amount: fmtAmount(amount), detail })
}

function makeV9WalletBucket(provider, currency, period, fileName, formatInfo, accountKey, entityKey) {
  const summary = makeEmptySummary({
    platform: provider.label,
    site: SITE_BY_CCY[currency] || 'GLOBAL',
    currency,
    period: period || '待确认期间',
    formatLabel: `${provider.displayName} 结汇流水 (${formatInfo})`,
    fileName,
  })
  summary.role = 'settlement_wallet'
  summary.accountKey = accountKey
  summary.entityKey = entityKey
  summary.inboundEvidence = []
  summary.outboundEvidence = []
  summary.walletMetrics = {
    platformInbound: 0n, otherInbound: 0n, returnedInbound: 0n,
    grossCorporateWithdraw: 0n, fxWithdrawToCorporate: 0n, fxWithdrawToPersonal: 0n,
    unverifiedWithdraw: 0n, directSpend: 0n, walletFees: 0n, internalFxStripped: 0n,
    internalFxNet: 0n, internalFxCount: 0, frozenOutflow: 0n, frozenOrReturned: 0n,
    voidExcludedCount: 0, netVerifiedRows: 0, signedNetFlow: 0n, netPendingCount: 0, netUnobservedCount: 0,
    invalidAmountCount: 0, netIncludedFeeRows: 0,
    pendingReturnCount: 0, unmatchedReturnCount: 0, unmatchedReturnAmount: 0n,
    matchedCorporateReturn: 0n, openingBalance: null, closingBalance: null, unrepatriatedNet: null,
    cnySettledCorporate: 0n, cnySettledPersonal: 0n, cnySettledUnverified: 0n,
    fxExpectedCny: 0n, fxSettlementDiffCny: 0n, fxSettlementCount: 0,
  }
  return { summary, withdrawals: new Map(), returns: [], unconfirmedReturnTargets: new Set(), opening: new Set(), closing: new Set() }
}

function computeV9WalletMovement(provider, bucket, { amount, fee, net, type, fxRateVal, cnyReceived }) {
  const { summary } = bucket
  const wm = summary.walletMetrics
  const isFeeRow = FEE_TYPE_RE.test(type) || FEE_REFUND_TYPE_RE.test(type)
  const feeCost = FEE_REFUND_TYPE_RE.test(type) ? -absBig(fee) : absBig(fee)
  if (amount === null) return { principal: net, feeCost, movement: net }
  const separate = amount - feeCost
  const included = provider.includedWithdrawalFee && amount < 0n && WITHDRAW_TYPE_RE.test(type) && amount + feeCost < 0n
  if (net === null) {
    if (included && feeCost !== 0n) {
      if (fxRateVal && fxRateVal > 0n && cnyReceived && cnyReceived > 0n) {
        const expSeparate = mulScaledBig(-amount, fxRateVal)
        const expIncluded = mulScaledBig(-(amount + feeCost), fxRateVal)
        if (absBig(expSeparate - cnyReceived) < CENT_STEP && absBig(expIncluded - cnyReceived) >= CENT_STEP) {
          wm.netVerifiedRows++
          return { principal: amount, feeCost, movement: separate }
        }
        if (absBig(expIncluded - cnyReceived) < CENT_STEP && absBig(expSeparate - cnyReceived) >= CENT_STEP) {
          wm.netVerifiedRows++
          wm.netIncludedFeeRows++
          return { principal: amount + feeCost, feeCost, movement: amount }
        }
      }
      wm.netPendingCount++
      wm.netUnobservedCount++
      walletNote(summary, 'P1-高危', '钱包提现缺少净额且手续费口径待核', absBig(amount), '请核对原金额是否已包含手续费。')
      return { principal: amount, feeCost, movement: 0n }
    }
    return { principal: amount, feeCost, movement: separate }
  }
  if (net === separate) {
    wm.netVerifiedRows++
    return { principal: amount, feeCost, movement: net }
  }
  if (isFeeRow && net === amount && absBig(amount) === absBig(fee) && -net === feeCost) {
    wm.netVerifiedRows++
    return { principal: amount, feeCost, movement: net }
  }
  if (included && net === amount) {
    wm.netVerifiedRows++
    wm.netIncludedFeeRows++
    return { principal: amount + feeCost, feeCost, movement: net }
  }
  let diff = absBig(net - separate)
  if (included && absBig(net - amount) < diff) diff = absBig(net - amount)
  wm.netPendingCount++
  if (diff >= CENT_STEP) {
    summary.horizontalDiffTotal += diff
    walletNote(summary, 'P0-阻断', '流水水平守恒异常', diff, '金额、手续费和净变动不一致。请核对原始导出。')
  } else {
    walletNote(summary, 'P1-高危', '钱包手续费口径待核', diff, '净变动与原金额的费用拆分存在未解释差额。')
  }
  return { principal: amount, feeCost, movement: net }
}

function applyV9WalletRow(provider, bucket, tx) {
  const { summary } = bucket
  const wm = summary.walletMetrics
  const {
    amount, net, type, dest, counterparty, bankAccount, bankName, status, hasStatusCol,
    txKey, originalKey, evidence, rawDate, period, currency,
    fxRateVal, fxRateRaw, cnyReceived, targetCurrency, explicitEntityRaw, explicitAccountRaw, rawTxId,
  } = tx
  const isReturn = RETURN_TYPE_RE.test(type)
  const returnedStatus = RETURN_STATUS_RE.test(status)
  const isBlankStatusWithCol = Boolean(hasStatusCol) && !status
  if (VOID_STATUS_RE.test(status) && !isReturn) {
    wm.voidExcludedCount++
    summary.uncapturedVoidExcluded += absBig(amount ?? net ?? 0n)
    return
  }
  // 退汇行若状态为 Failed/Pending/Cancelled/处理中 或存在状态列但空白，严禁入账冲减原已完成提款的本金与 Stage 3 分母！
  if (isReturn) {
    const returnConfirmed = !isBlankStatusWithCol && (!status || TERMINAL_WALLET_STATUS_RE.test(status) || returnedStatus)
    if (!returnConfirmed || VOID_STATUS_RE.test(status)) {
      wm.voidExcludedCount++
      wm.pendingReturnCount++
      summary.uncapturedVoidExcluded += absBig(amount ?? net ?? 0n)
      if (originalKey) bucket.unconfirmedReturnTargets.add(originalKey)
      walletNote(summary, 'P1-高危', '未完成或失败的退汇记录（未冲减原提现）', absBig(amount ?? net ?? 0n), '退汇状态非已完成/已入账（或状态空白），未冲减原提现本金并已冻结对应核销。')
      return
    }
  }

  const isFeeRow = FEE_TYPE_RE.test(type) || FEE_REFUND_TYPE_RE.test(type)
  const { principal, movement, feeCost } = computeV9WalletMovement(provider, bucket, tx)
  wm.signedNetFlow += movement
  // 独立 FEE / FEE_REFUND 行只按净变动确认一次费用，严禁同时叠加 feeCost 与 -principal 造成双计！
  if (isFeeRow) {
    wm.walletFees -= movement
    summary.platformCommission -= movement
    return
  }
  wm.walletFees += feeCost
  summary.platformCommission += feeCost

  if (INTERNAL_TYPE_RE.test(type)) {
    wm.internalFxCount++
    wm.internalFxStripped += absBig(principal)
    wm.internalFxNet += movement
    return
  }
  if (isReturn || (returnedStatus && principal >= 0n)) {
    wm.frozenOrReturned += absBig(principal)
    if (movement > 0n) {
      wm.returnedInbound += movement
      bucket.returns.push({ amount: movement, originalKey, cnyReturned: cnyReceived })
    } else {
      wm.frozenOutflow += absBig(movement)
      wm.pendingReturnCount++
      wm.unmatchedReturnAmount += absBig(movement)
    }
    walletNote(summary, 'P1-高危', '退汇流水待核', absBig(movement), '请核对原提现及对应退汇回单。')
    return
  }
  if (FROZEN_TYPE_RE.test(type)) {
    wm.frozenOrReturned += absBig(movement)
    if (movement < 0n) wm.frozenOutflow -= movement
    else wm.otherInbound += movement
    summary.reserveNetChange -= movement
    walletNote(summary, 'P1-高危', '风控冻结或解冻', absBig(movement), '请核对资金扣留或释放凭证。')
    return
  }

  if (principal < 0n && PLATFORM_REVERSAL_RE.test(type)) {
    wm.platformInbound += principal
    summary.inboundEvidence.push({ ...evidence, amount: principal, inferredPlatform: evidence.sourcePlatform || inferPlatformMention(dest) })
    return
  }
  if (principal > 0n) {
    if (evidence.sourcePlatform || PLATFORM_DEPOSIT_RE.test(type) || (DEPOSIT_TYPE_RE.test(type) && PLATFORM_MENTION_RE.test(dest))) {
      wm.platformInbound += principal
      summary.inboundEvidence.push({ ...evidence, amount: principal, inferredPlatform: evidence.sourcePlatform || inferPlatformMention(dest) })
    } else {
      wm.otherInbound += principal
      walletNote(summary, 'P2-关注', '非标准电商平台入账（来源待核）', principal, '请核对入账来源并确认是否为货款或往来款。')
    }
    return
  }
  if (principal === 0n) return

  const out = -principal
  if (!WITHDRAW_TYPE_RE.test(type) || COMMERCIAL_SPEND_RE.test(dest)) {
    wm.directSpend += out
    walletNote(summary, 'P1-高危', '结汇余额坐支或非提现出账', out, '请核对资金用途与相关费用凭证。')
    return
  }

  let field = 'unverifiedWithdraw'
  let destinationType = 'unverified'
  if (PERSONAL_ACCOUNT_RE.test(dest)) {
    field = 'fxWithdrawToPersonal'
    destinationType = 'personal'
    walletNote(summary, 'P0-阻断', '提现至个人私户（公私混收高危）', out, '提现流向具有私户特征。请核对开户主体和银行回单。')
  } else if (CORPORATE_ENTITY_RE.test(dest)) {
    field = 'fxWithdrawToCorporate'
    destinationType = 'corporate'
    wm.grossCorporateWithdraw += out
  } else {
    walletNote(summary, 'P1-高危', '提现收款户性质待核', out, '请核对收款户名、主体和银行回单。')
  }
  wm[field] += out
  summary.actualPayout += out

  const isIdentityFxWithoutCny = fxRateVal === AMOUNT_SCALE && cnyReceived === null && currency !== 'CNY'
  const effTargetCcy = targetCurrency && targetCurrency !== 'UNKNOWN'
    ? targetCurrency
    : isIdentityFxWithoutCny
      ? (currency !== 'UNKNOWN' ? currency : null)
      : (cnyReceived !== null || (fxRateVal !== null && fxRateVal > 0n && currency !== 'CNY'))
        ? 'CNY'
        : (currency === 'CNY' ? 'CNY' : null)
  const expectedCny = effTargetCcy === 'CNY' && fxRateVal && fxRateVal > 0n ? mulScaledBig(out, fxRateVal) : (currency === 'CNY' ? out : null)
  const settledCny = effTargetCcy === 'CNY' && cnyReceived !== null && cnyReceived > 0n ? cnyReceived : (currency === 'CNY' && cnyReceived === null ? out : null)
  const fxDiffCny = settledCny !== null && expectedCny !== null ? q2(settledCny - expectedCny) : 0n
  if (settledCny !== null) {
    wm.fxSettlementCount++
    if (destinationType === 'corporate') wm.cnySettledCorporate += settledCny
    else if (destinationType === 'personal') wm.cnySettledPersonal += settledCny
    else wm.cnySettledUnverified += settledCny
    if (expectedCny !== null) wm.fxExpectedCny += expectedCny
    if (absBig(fxDiffCny) >= CENT_STEP) {
      wm.fxSettlementDiffCny += fxDiffCny
      walletNote(summary, 'P2-关注', '结汇实收与牌价折算存在汇兑差额', fxDiffCny, '实收人民币与本金×结汇汇率存在差额，请核对银行或通道汇损与加点。')
    }
  }

  const normEnt = normalizeEntityName(counterparty)
  const explicitEntityKey = evidenceKey(explicitEntityRaw)
  const legalEntityKey = destinationType === 'corporate' && normEnt ? evidenceKey(normEnt) : null
  const outEntityKey = explicitEntityKey || legalEntityKey
  const acctSuffix = extractAccountSuffix(bankAccount)
  const acctPrefix = extractAccountPrefix(bankAccount)
  const fullAcctDigits = extractFullBankAccountDigits(bankAccount)
  const explicitAccountKey = evidenceKey(explicitAccountRaw)
  const fullBankAccountKey = fullAcctDigits ? evidenceKey(fullAcctDigits) : null
  const outAccountKey = explicitAccountKey || fullBankAccountKey || (acctSuffix ? evidenceKey('ACCT_SUFFIX:' + acctSuffix) : null)
  const normRef = normalizeReferenceToken(rawTxId)
  const outRefKey = normRef ? evidenceKey(normRef) : evidence.referenceKey
  const bankHint = inferBankHint(`${bankName} ${dest}`)
  const bankCode = normalizeBankInstitutionCode(bankName || bankHint || `${counterparty} ${bankAccount}`)
  const nonTerminalStatus = isBlankStatusWithCol || (Boolean(status) && !returnedStatus && !TERMINAL_WALLET_STATUS_RE.test(status))
  const evStatus = returnedStatus ? 'returned' : isBlankStatusWithCol ? 'blank_status_unconfirmed' : nonTerminalStatus ? status : 'completed'
  if (nonTerminalStatus) {
    walletNote(summary, 'P1-高危', '提现状态非明确终态（待核）', out, '提现状态未明确为已完成/已入账，已禁止自动核销。')
  }

  const outEvidence = {
    walletPlatform: provider.label,
    period,
    date: rawDate,
    currency,
    targetCurrency: effTargetCcy,
    principalAmount: out,
    originalPrincipalAmount: out,
    feeAmount: feeCost,
    fxRate: fxRateRaw || null,
    settledCnyAmount: settledCny,
    expectedCnyAmount: expectedCny,
    fxDiffCny,
    destinationType,
    entityKey: outEntityKey,
    explicitEntityKey,
    legalEntityKey,
    accountKey: outAccountKey,
    explicitAccountKey,
    fullBankAccountKey,
    accountPrefix: acctPrefix,
    accountSuffix: acctSuffix,
    referenceKey: outRefKey,
    sourcePlatform: evidence.sourcePlatform || inferPlatformMention(dest) || null,
    bankHint,
    bankCode,
    status: evStatus,
    returned: false,
    partialReturn: false,
    partialReturnFrozen: false,
    cnySettlementUnverified: false,
  }
  summary.outboundEvidence.push(outEvidence)

  if (returnedStatus) {
    wm.pendingReturnCount++
    wm.unmatchedReturnAmount += out
    walletNote(summary, 'P1-高危', '提现状态为已退回', out, '请核对是否有对应的钱包退汇入账。')
  }
  if (txKey) {
    bucket.withdrawals.set(txKey, bucket.withdrawals.has(txKey) ? null : {
      field,
      destinationType,
      remaining: out,
      initialPrincipal: out,
      fxRateVal,
      returnedStatus,
      outEvidence,
    })
  }
}

function finalizeV9WalletBucket(bucket) {
  const { summary } = bucket
  const wm = summary.walletMetrics
  const adjustSettledCny = (destType, delta) => {
    if (!delta) return
    if (destType === 'corporate') wm.cnySettledCorporate -= delta
    else if (destType === 'personal') wm.cnySettledPersonal -= delta
    else wm.cnySettledUnverified -= delta
  }
  for (const entry of bucket.returns) {
    const original = summary.period !== '待确认期间' && entry.originalKey && bucket.withdrawals.get(entry.originalKey)
    if (!original || entry.amount > original.remaining) {
      wm.unmatchedReturnCount++
      wm.unmatchedReturnAmount += entry.amount
      continue
    }
    const prevRem = original.remaining
    const newRem = prevRem - entry.amount
    original.remaining = newRem
    wm[original.field] -= entry.amount
    summary.actualPayout -= entry.amount
    if (original.outEvidence) {
      const ev = original.outEvidence
      ev.principalAmount = newRem
      if (newRem === 0n) {
        ev.returned = true
        ev.status = 'returned'
        ev.partialReturn = false
        ev.partialReturnFrozen = false
        ev.cnySettlementUnverified = false
        ev.returnedPrincipalAmount = original.initialPrincipal
        if (ev.settledCnyAmount != null) {
          adjustSettledCny(original.destinationType, ev.settledCnyAmount)
          ev.settledCnyAmount = 0n
        }
        if (ev.expectedCnyAmount != null) {
          wm.fxExpectedCny -= ev.expectedCnyAmount
          ev.expectedCnyAmount = 0n
        }
        if (ev.fxDiffCny) {
          wm.fxSettlementDiffCny -= ev.fxDiffCny
          ev.fxDiffCny = 0n
        }
      } else {
        // 部分退汇：同步扣减本外币剩余净额；校验退汇本币比例（超 ±5% 偏离或缺失本币均冻结自动核销）并同步汇兑差额！
        ev.partialReturn = true
        ev.returnedPrincipalAmount = original.initialPrincipal - newRem
        if (summary.currency === 'CNY') {
          if (ev.settledCnyAmount != null) {
            adjustSettledCny(original.destinationType, entry.amount)
            ev.settledCnyAmount = newRem
          }
          if (ev.expectedCnyAmount != null) {
            wm.fxExpectedCny -= entry.amount
            ev.expectedCnyAmount = newRem
          }
        } else {
          const prevExp = ev.expectedCnyAmount
          const newExp = original.fxRateVal && original.fxRateVal > 0n
            ? mulScaledBig(newRem, original.fxRateVal)
            : (prevExp != null ? q2((prevExp * newRem) / prevRem) : null)
          if (prevExp != null && newExp != null) {
            wm.fxExpectedCny -= (prevExp - newExp)
            ev.expectedCnyAmount = newExp
          }
          if (ev.settledCnyAmount != null) {
            const prevSettled = ev.settledCnyAmount
            const prevFxDiff = ev.fxDiffCny || 0n
            const retCny = entry.cnyReturned != null ? absBig(entry.cnyReturned) : null
            const proratedRetCny = q2((prevSettled * entry.amount) / prevRem)
            const maxRetTol = proratedRetCny / 20n + CENT_STEP
            const retRatePlausible =
              retCny !== null && retCny > 0n && retCny < prevSettled && absBig(retCny - proratedRetCny) <= maxRetTol
            // 即使填写了合理退汇本币，若原提现缺少目标结算币或结汇汇率凭证，同样禁止跨币种正式放行
            if (retRatePlausible && ev.targetCurrency === 'CNY' && original.fxRateVal && original.fxRateVal > 0n) {
              adjustSettledCny(original.destinationType, retCny)
              ev.settledCnyAmount = prevSettled - retCny
              ev.fxDiffCny = ev.expectedCnyAmount != null ? q2(ev.settledCnyAmount - ev.expectedCnyAmount) : 0n
              wm.fxSettlementDiffCny += (ev.fxDiffCny - prevFxDiff)
            } else {
              const proratedRem = q2((prevSettled * newRem) / prevRem)
              const deltaCny = prevSettled - proratedRem
              adjustSettledCny(original.destinationType, deltaCny)
              ev.settledCnyAmount = proratedRem
              ev.fxDiffCny = ev.expectedCnyAmount != null ? q2(ev.settledCnyAmount - ev.expectedCnyAmount) : 0n
              wm.fxSettlementDiffCny += (ev.fxDiffCny - prevFxDiff)
              ev.partialReturnFrozen = true
              ev.cnySettlementUnverified = true
              const reasonMsg = retCny !== null && retCny > 0n
                ? '部分退汇填写的人民币金额与外币退回比例偏离超过 ±5%（或缺原始结汇汇率凭证），已按原结汇比例暂估剩余本币并冻结 Stage 3 正式核销，请人工核对银行退汇水单。'
                : '部分退汇仅提供外币金额，无法准确确定退汇后本币实结余额，已按比例扣减并冻结 Stage 3 正式核销。'
              walletNote(summary, 'P1-高危', '部分退汇后本币余额待核（已冻结自动核销）', entry.amount, reasonMsg)
            }
          } else {
            // 外币部分退汇若缺失目标结算币、原始结汇汇率或本币实结金额凭证，严禁用外部报表汇率放行跨币种正式 matched！
            ev.partialReturnFrozen = true
            ev.cnySettlementUnverified = true
            walletNote(summary, 'P1-高危', '部分退汇缺少实结本币/汇率凭证（已冻结自动核销）', entry.amount, '外币部分退汇缺少目标结算币、原始结汇汇率或本币实结凭证，严禁用报表估值汇率替代实结核销，已冻结 Stage 3 正式核销。')
          }
        }
      }
    }
    if (original.field === 'fxWithdrawToCorporate') wm.matchedCorporateReturn += entry.amount
    if (original.returnedStatus) {
      wm.unmatchedReturnAmount -= entry.amount
      if (original.remaining === 0n) wm.pendingReturnCount--
    }
  }
  // 单条直接标为 Returned（且无独立退汇入账行）的提现不得计入净对公回流 fxWithdrawToCorporate 与 Stage 3 应核分母
  for (const w of bucket.withdrawals.values()) {
    if (!w || !w.returnedStatus || w.remaining <= 0n) continue
    const rem = w.remaining
    w.remaining = 0n
    wm[w.field] -= rem
    summary.actualPayout -= rem
    if (w.outEvidence) {
      const ev = w.outEvidence
      ev.principalAmount = 0n
      ev.returned = true
      ev.status = 'returned'
      ev.partialReturn = false
      ev.partialReturnFrozen = false
      ev.cnySettlementUnverified = false
      if (ev.settledCnyAmount != null) {
        adjustSettledCny(w.destinationType, ev.settledCnyAmount)
        ev.settledCnyAmount = 0n
      }
      if (ev.expectedCnyAmount != null) {
        wm.fxExpectedCny -= ev.expectedCnyAmount
        ev.expectedCnyAmount = 0n
      }
      if (ev.fxDiffCny) {
        wm.fxSettlementDiffCny -= ev.fxDiffCny
        ev.fxDiffCny = 0n
      }
    }
  }
  // 关联了未完成/失败退汇记录的原提现：保留全部本金与应核分母，但冻结自动核销以防在退汇未决状态下误放行
  for (const targetKey of bucket.unconfirmedReturnTargets) {
    const w = bucket.withdrawals.get(targetKey)
    if (w?.outEvidence && !w.outEvidence.returned) {
      w.outEvidence.partialReturnFrozen = true
      w.outEvidence.hasUnconfirmedReturn = true
    }
  }
  if (wm.unmatchedReturnCount) {
    walletNote(summary, 'P1-高危', '未关联原提现的退汇入账', wm.unmatchedReturnAmount, '现有凭证不足以确定退汇应冲减哪笔提现。')
  }
  if (bucket.opening.size === 1) wm.openingBalance = bucket.opening.values().next().value
  if (bucket.closing.size === 1) wm.closingBalance = bucket.closing.values().next().value
  if (wm.netUnobservedCount === 0 && wm.openingBalance !== null && wm.closingBalance !== null &&
      absBig(wm.openingBalance + wm.signedNetFlow - wm.closingBalance) >= CENT_STEP) {
    walletNote(summary, 'P1-高危', '钱包期末余额勾稽待核', absBig(wm.openingBalance + wm.signedNetFlow - wm.closingBalance), '期初余额、期间净流与期末余额不一致。请核对账期覆盖。')
  } else if (wm.closingBalance !== null && wm.netPendingCount === 0) {
    wm.unrepatriatedNet = wm.closingBalance > 0n ? wm.closingBalance : 0n
  }
  if (summary.currency === 'UNKNOWN') {
    walletNote(summary, 'P1-高危', '币种缺失或无法识别', 0n, '请核对结汇流水币种。此表金额暂不能折算。')
  }
  if (wm.internalFxCount) {
    walletNote(summary, 'P2-关注', '同户换汇或内部互转已剥离', wm.internalFxStripped, '已保留本币净变动，不将同户互转计为平台入账或转出。')
  }
  if (bucket.dates?.length) {
    appendDateValidationAnomalies(summary, bucket.dates, null, summary.platform.slice(0, 3).toUpperCase())
  }
  return finalizeSummary(summary)
}

function fingerprintV9Wallet(provider, rows, headerIndex, columns, manual, fileName = '') {
  const header = rows[headerIndex] || []
  const normHeaderCells = header.map(normHdrCell)
  if (normHeaderCells.some((h) => FOREIGN_WALLET_GUARD_RE.test(h))) return 0
  if (header.some((h) => /^credit\s*\/\s*debit$/i.test(String(h ?? '').trim()))) return 0
  const distinctSides = 'credit' in columns && 'debit' in columns && columns.credit !== columns.debit
  const hasAmount = 'amount' in columns || 'net' in columns || distinctSides
  if (!('date' in columns && 'tx_type' in columns && 'currency' in columns && hasAmount)) return 0

  const sample = rows.slice(headerIndex + 1, headerIndex + 26)
  const validTypeRows = sample.filter((row) => {
    const t = enumVal(cell(row, columns.tx_type))
    return WALLET_TX_TYPES.some((re) => re.test(t))
  })
  const headerOnly = sample.length === 0
  if (!headerOnly && !validTypeRows.length && !manual) return 0
  if (manual) return 4

  // 严防抢占 v0.8 万里汇 / 派安盈 / 空中云汇流水
  if ('tx_id' in columns && sample.some((row) => V8_REF_GUARD_RE.test(cell(row, columns.tx_id)))) return 0
  if (sample.some((row) => V8_ENUM_GUARD_RE.test(cell(row, columns.tx_type)))) return 0

  const hasExclusiveHdr = normHeaderCells.some((h) => provider.exclusiveHeaderRe.test(h))
  const hasOtherExclusiveHdr = V9_WALLET_PROVIDERS.some(
    (other) => other.id !== provider.id && normHeaderCells.some((h) => other.exclusiveHeaderRe.test(h)),
  )
  if (hasOtherExclusiveHdr) return 0

  const hasProviderRef = 'tx_id' in columns && sample.some((row) => provider.refRe.test(cell(row, columns.tx_id)))
  const hasOtherRef = 'tx_id' in columns && V9_WALLET_PROVIDERS.some(
    (other) => other.id !== provider.id && sample.some((row) => other.refRe.test(cell(row, columns.tx_id))),
  )
  if (hasOtherRef) return 0

  const fileMatch = provider.fileRe.test(String(fileName || ''))
  const v8FileMatch = V8_FILENAME_GUARD_RE.test(String(fileName || ''))
  const v8SampleMention = sample.some((row) => V8_BRAND_MENTION_RE.test(row.join(' ')))
  // 含 v0.8 通道文件名（WorldFirst/Payoneer/Airwallex）时，除非存在明确 v9 品牌专属列或品牌流水号，否则严禁抢占！
  if (v8FileMatch && !hasExclusiveHdr && !hasProviderRef) return 0

  const otherFileMatch = V9_WALLET_PROVIDERS.some(
    (other) => other.id !== provider.id && other.fileRe.test(String(fileName || '')),
  )
  if (otherFileMatch && !hasExclusiveHdr && !hasProviderRef) return 0

  if (hasExclusiveHdr) return 5
  if (hasProviderRef && fileMatch) return 5
  if (hasProviderRef) return 4
  if (fileMatch) return 3
  if (v8SampleMention) return 0
  // 匿名文件下，通用 Buy Currency / Sell Currency 降为低权 1，绝不压过高置信 v0.8 通道
  if (provider.id === 'sunrate' && !distinctSides && normHeaderCells.some((h) => SUNRATE_GENERIC_FX_HDR_RE.test(h)) && 'fx_rate' in columns && 'cny_received' in columns) {
    return 1
  }
  // 匿名文件下，仅当具备中国结汇三件套（实收人民币 + 汇率 + 来源平台/非标准双列 Credit+Debit）时归类连连国际（低分 2，且绝不抢占高置信 v0.8）
  if (provider.id === 'lianlian' && 'cny_received' in columns && 'fx_rate' in columns && ('source_platform' in columns || ('debit' in columns && !distinctSides))) {
    return 2
  }
  return 0
}

export function findV9WalletCandidates(rows, manualPlatform = null, fileName = '') {
  const manualNorm = manualPlatform ? String(manualPlatform).trim().toLowerCase() : null
  const candidates = []
  for (const provider of V9_WALLET_PROVIDERS) {
    if (manualNorm && manualNorm !== provider.id && manualNorm !== provider.label.toLowerCase() && manualNorm !== provider.displayName.toLowerCase()) {
      continue
    }
    const match = findHeaderRow(rows, { ...provider.aliases, ...WALLET_EXTRAS }, 4, 45, true)
      || findHeaderRow(rows, { ...provider.aliases, ...WALLET_EXTRAS }, 4, 45, false)
    if (!match) continue
    const [headerIndex, columns] = match
    const score = fingerprintV9Wallet(provider, rows, headerIndex, columns, Boolean(manualNorm), fileName)
    if (score) {
      candidates.push({
        id: provider.id,
        platform: provider.label,
        role: 'settlement_wallet',
        provider,
        headerIndex,
        columns,
        score,
      })
    }
  }
  return candidates
}

export function parseV9WalletSheet(fileName, rows, formatInfo, { provider, headerIndex, columns }) {
  const fundColumns = evidenceColumns(rows[headerIndex] || [])
  const buckets = new Map()
  for (const row of rows.slice(headerIndex + 1)) {
    const rawDate = cell(row, columns.date)
    const type = enumVal(cell(row, columns.tx_type))
    const counterparty = cell(row, columns.counterparty)
    const bankAccount = cell(row, columns.bank_account)
    const bankName = cell(row, columns.bank_name)
    const desc = cell(row, columns.desc)
    const srcPlatRaw = cell(row, columns.source_platform)
    const dest = `${counterparty} ${desc} ${srcPlatRaw}`.trim()
    const rawTxId = cell(row, columns.tx_id)
    if (!rawDate && !type && !dest) continue
    if (TOTAL_ROW_RE.test(rawDate) || TOTAL_ROW_RE.test(type) || TOTAL_ROW_RE.test(rawTxId)) continue

    const currency = normalizeCurrencyCode(cell(row, columns.currency))
    const explicitAccountRaw = cell(row, columns.account)
    const explicitEntityRaw = cell(row, fundColumns.entity)
    const accountKey = evidenceKey(explicitAccountRaw)
    const resolvedSrcPlat = resolveSourcePlatform(srcPlatRaw, dest)
    const evidence = pickFundEvidence(row, fundColumns, resolvedSrcPlat, rawDate, 0n)
    const period = transactionMonth(rawDate)
    const key = JSON.stringify([currency, period, accountKey, evidence.entityKey])
    if (!buckets.has(key)) {
      buckets.set(key, makeV9WalletBucket(provider, currency, period, fileName, formatInfo, accountKey, evidence.entityKey))
    }
    const bucket = buckets.get(key)
    const { summary } = bucket
    if (rawDate) {
      bucket.dates = bucket.dates || []
      bucket.dates.push(rawDate)
    }

    const money = Object.fromEntries(
      ['amount', 'fee', 'net', 'credit', 'debit', 'opening', 'closing', 'fx_rate', 'cny_received'].map(
        (field) => [field, parseAmountCell(cell(row, columns[field]))],
      ),
    )
    let amount = money.amount.value ?? null
    if (money.credit.state === 'value' || money.debit.state === 'value') {
      amount = (money.credit.value ?? 0n) - absBig(money.debit.value ?? 0n)
      if (money.credit.value && money.debit.value) {
        summary.walletMetrics.netPendingCount++
        walletNote(summary, 'P1-高危', '借贷双列同时有金额', absBig(amount), '请核对交易方向与净额。')
      }
    }
    const net = money.net.value ?? null
    summary.rawRowCount++
    if (money.opening.state === 'value') bucket.opening.add(money.opening.value)
    if (money.closing.state === 'value') bucket.closing.add(money.closing.value)

    if (Object.values(money).some((v) => v.state === 'invalid') || (amount === null && net === null)) {
      summary.walletMetrics.invalidAmountCount++
      summary.walletMetrics.netPendingCount++
      summary.walletMetrics.netUnobservedCount++
      walletNote(summary, 'P1-高危', '钱包金额缺失或格式无效', 0n, '请核对金额、手续费、汇率或人民币列。')
      continue
    }
    const isFeeRow = FEE_TYPE_RE.test(type) || FEE_REFUND_TYPE_RE.test(type)
    const expectedFeeCost = FEE_REFUND_TYPE_RE.test(type) ? -absBig(money.fee.value ?? 0n) : absBig(money.fee.value ?? 0n)
    if (money.fee.value && amount === null && !(isFeeRow && -net === expectedFeeCost)) {
      summary.walletMetrics.netPendingCount++
      walletNote(summary, 'P1-高危', '钱包仅提供净额，手续费口径待核', absBig(net), '已采用原表净变动。请核对提现本金与费用。')
    }
    const fxRateRaw = cell(row, columns.fx_rate)
    const targetCurrency = normalizeCurrencyCode(cell(row, columns.target_currency))
    const hasStatusCol = 'status' in columns
    applyV9WalletRow(provider, bucket, {
      type, dest, counterparty, bankAccount, bankName,
      status: enumVal(cell(row, columns.status)), hasStatusCol,
      amount, net, fee: money.fee.value ?? 0n, evidence,
      rawDate, period, currency, rawTxId,
      fxRateVal: money.fx_rate.value ?? null, fxRateRaw,
      cnyReceived: money.cny_received.value ?? null, targetCurrency,
      explicitEntityRaw, explicitAccountRaw,
      txKey: evidenceKey(rawTxId),
      originalKey: evidenceKey(cell(row, columns.original_reference)),
    })
  }
  return [...buckets.values()].map(finalizeV9WalletBucket)
}

function parseV9WalletSheetsById(providerId, fileName, sheets, formatInfo, forceMatch = false) {
  const results = []
  for (const [, rows] of sheets) {
    const candidate = findV9WalletCandidates(rows, forceMatch ? providerId : null, fileName).find((c) => c.id === providerId)
    if (candidate) results.push(...parseV9WalletSheet(fileName, rows, formatInfo, candidate))
  }
  return results.length ? results : null
}

export function parseLianLianSheets(fileName, sheets, formatInfo = 'csv', forceMatch = false) {
  return parseV9WalletSheetsById('lianlian', fileName, sheets, formatInfo, forceMatch)
}

export function parsePingPongSheets(fileName, sheets, formatInfo = 'csv', forceMatch = false) {
  return parseV9WalletSheetsById('pingpong', fileName, sheets, formatInfo, forceMatch)
}

export function parseSunrateSheets(fileName, sheets, formatInfo = 'csv', forceMatch = false) {
  return parseV9WalletSheetsById('sunrate', fileName, sheets, formatInfo, forceMatch)
}

// ════════════════════════════════════════════════════════════════
// 3. 3 大主流跨境销售平台（Stage 1 销售轨：SHEIN / Walmart / Lazada）
// ════════════════════════════════════════════════════════════════

// ── 3A. SHEIN 解析器（全托管供货 / 半托管 / 平台 POP，严格保留费用冲回符号） ──
export const SHEIN_ALIASES = {
  date: ['结算日期', '结算时间', '对账日期', '入账日期', '账单日期', '订单完成时间', 'settlement date', 'settlement time', 'bill date', 'statement date', 'transaction date'],
  order_id: ['结算单号', '订单号', '子订单号', '备货单号', '供货单号', '对账单号', 'order no', 'order id', 'settlement no', 'settlement id', 'po no', 'bill no'],
  mode: ['合作模式', '业务模式', '托管模式', '店铺模式', '经营模式', 'cooperation mode', 'business mode', 'fulfillment mode', 'model'],
  tx_type: ['账务类型', '单据类型', '交易类型', '费用类型', '类型', 'transaction type', 'bill type', 'document type', 'type'],
  site: ['站点', '销售站点', '国家', '国家 地区', '市场', 'site', 'country', 'region', 'marketplace'],
  currency: ['币种', '结算币种', '货币', 'currency', 'settlement currency'],
  retail_gross: ['销售额', '商品销售额', '订单金额', '商品零售价', '商品金额', '销售货款', 'gross sales', 'product sales', 'order amount', 'merchandise sales', 'retail price'],
  supply_amount: ['供货货款', '供货金额', '供货结算金额', '采购货款', '货款', '结算货款', 'supply amount', 'goods amount', 'supply settlement', 'wholesale amount', 'supplier payout'],
  shipping_income: ['买家支付运费', '运费收入', 'shipping income', 'buyer shipping fee'],
  seller_discount: ['商家优惠', '店铺优惠券', '商家折扣', '活动让利', 'seller discount', 'merchant discount', 'coupon discount'],
  platform_subsidy: ['平台补贴', '运费补贴', '活动补贴', 'shein补贴', 'platform subsidy', 'shein subsidy', 'shipping subsidy'],
  commission_fee: ['平台佣金', '技术服务费', '服务费', '类目佣金', '佣金', 'platform commission', 'commission fee', 'commission', 'service fee', 'referral fee'],
  fulfillment_fee: ['履约运费', '履约费', '尾程运费', '物流运费', '运费', '仓储费', '操作费', '头程分摊', 'fulfillment fee', 'shipping fee', 'logistics fee', 'warehouse fee', 'freight fee'],
  ads_fee: ['广告费', '推广费', '站内推广费', 'ad fee', 'advertising fee', 'marketing fee'],
  refund_amount: ['退款金额', '售后退款', '退货扣款', '客诉退款', '退款', 'refund amount', 'refund', 'return refund'],
  deduction_fee: ['质检扣款', '扣款', '违规扣款', '履约罚款', '缺货罚款', '延迟扣款', '其他扣款', 'deduction', 'deductions', 'penalty', 'quality deduction', 'violation fee', 'fine'],
  withheld_tax: ['平台代扣税费', '代扣税费', '代扣vat', 'marketplace withheld tax', 'withheld tax', 'vat withheld'],
  self_tax: ['待自申报税', '卖家自报税', 'seller collected tax', 'self remit tax'],
  payout_amount: ['提现金额', '打款金额', '实付打款', 'payout amount', 'withdrawal amount'],
  net_settlement: ['净结款', '应结金额', '实结金额', '结算净额', '本期结算金额', '净结算金额', 'net settlement', 'net payout', 'net amount', 'settlement amount', 'total settlement'],
}

export function isSheinMatch(fileName, rows, headerIndex, colMap) {
  if (!('net_settlement' in colMap && 'date' in colMap && ('retail_gross' in colMap || 'supply_amount' in colMap))) {
    return false
  }
  const header = rows[headerIndex] || []
  const normCells = header.map(normHdrCell)
  // 排除其他已注册平台专属表头
  if (normCells.some((h) => /^(?:菜鸟物流费|cainiao shipping fee|total released amount|temu subsidy|fee name|vat in amount|order #|wfs)$/i.test(h))) {
    return false
  }
  const sheinSpecificHeader = normCells.some((h) => /^(?:净结款|供货货款|质检扣款|履约运费|shein补贴|shein subsidy|quality deduction|goods amount)$/i.test(h))
  const fileHint = /shein|希音/i.test(String(fileName || ''))
  const sampleHit = rows.slice(headerIndex + 1, headerIndex + 26).some((r) => /shein|希音|shn[-_]/i.test(r.join(' ')))
  return sheinSpecificHeader || fileHint || sampleHit
}

export function parseSheinRows(rows, ctx = {}) {
  const fileName = String(ctx.fileName || 'shein.csv')
  const formatInfo = String(ctx.formatInfo || 'csv')
  let headerIndex = ctx.headerIndex
  let colMap = ctx.columns
  if (headerIndex == null || !colMap) {
    const found = findHeaderRow(rows, SHEIN_ALIASES, 4, 45, false)
    if (!found) return []
    ;[headerIndex, colMap] = found
  }
  const fundColumns = evidenceColumns(rows[headerIndex] || [])
  const dataRows = rows.slice(headerIndex + 1)
  if (!dataRows.length) return []

  const dedSign = detectDeductionSign(
    dataRows,
    colMap,
    ['retail_gross', 'supply_amount'],
    ['seller_discount', 'refund_amount', 'commission_fee', 'fulfillment_fee', 'ads_fee', 'deduction_fee'],
    'net_settlement',
  )
  const hasPositiveGrossRow = dataRows.some((r) => parseAmount(cell(r, colMap.retail_gross)) > 0n || parseAmount(cell(r, colMap.supply_amount)) > 0n)
  const REVERSAL_TX_RE = /冲回|返还|退回|退费|减免|调增|rebate|reversal|fee\s*refund|refund\s*fee|credit/i

  const byCcy = new Map()
  const ensureBucket = (ccy, siteHint) => {
    if (!byCcy.has(ccy)) {
      byCcy.set(ccy, {
        dates: [],
        hasExplicitSite: Boolean(siteHint),
        fullManagedCount: 0,
        fullManagedTotal: 0n,
        semiOrPopCount: 0,
        deductionCount: 0,
        deductionTotal: 0n,
        summary: makeEmptySummary({
          period: '待确认期间',
          platform: 'SHEIN',
          site: siteHint || SITE_BY_CCY[ccy] || 'GLOBAL',
          currency: ccy,
          formatLabel: `SHEIN 结算账单 (${formatInfo})`,
          fileName,
        }),
      })
    } else if (siteHint) {
      const existing = byCcy.get(ccy)
      existing.hasExplicitSite = true
      existing.summary.site = siteHint
    }
    return byCcy.get(ccy)
  }

  for (let idx = 0; idx < dataRows.length; idx++) {
    const r = dataRows[idx]
    const oid = cell(r, colMap.order_id) || `SHN-${headerIndex + 2 + idx}`
    const modeStr = cell(r, colMap.mode).toLowerCase()
    const txType = cell(r, colMap.tx_type).toLowerCase()
    const dt = cell(r, colMap.date)
    if (TOTAL_ROW_RE.test(oid) || TOTAL_ROW_RE.test(txType) || TOTAL_ROW_RE.test(dt)) continue

    const ccy = normalizeCurrencyCode(cell(r, colMap.currency) || ctx.currency || 'USD')
    const siteRaw = cell(r, colMap.site).toUpperCase()
    const siteHint = /^[A-Z]{2,3}$/.test(siteRaw) ? siteRaw : null

    const retail = parseAmount(cell(r, colMap.retail_gross))
    const supply = parseAmount(cell(r, colMap.supply_amount))
    const shipIn = parseAmount(cell(r, colMap.shipping_income))
    const pSub = parseAmount(cell(r, colMap.platform_subsidy))
    const rawSDisc = parseAmount(cell(r, colMap.seller_discount))
    const rawRefund = parseAmount(cell(r, colMap.refund_amount))
    const rawComm = parseAmount(cell(r, colMap.commission_fee))
    const rawFulfill = parseAmount(cell(r, colMap.fulfillment_fee))
    const rawAds = parseAmount(cell(r, colMap.ads_fee))
    const rawDeduction = parseAmount(cell(r, colMap.deduction_fee))
    const wTax = absBig(parseAmount(cell(r, colMap.withheld_tax)))
    const selfTax = parseAmount(cell(r, colMap.self_tax))
    const payoutRaw = parseAmount(cell(r, colMap.payout_amount))
    const hasNetCol = 'net_settlement' in colMap && cell(r, colMap.net_settlement) !== ''
    const netRaw = hasNetCol ? parseAmount(cell(r, colMap.net_settlement)) : 0n
    const rowGross = (retail !== 0n ? retail : supply) + shipIn

    // 冲回/退款类型行逐行校验净额守恒，避免仅含冲回行或混合表被全局 dedSign 误翻正
    let rowDedSign = dedSign
    if (rowGross === 0n) {
      const rawDedSum = rawSDisc + rawRefund + rawComm + rawFulfill + rawAds + rawDeduction
      if (hasNetCol && rawDedSum !== 0n) {
        const expDef = rowGross + pSub - rawDedSum * dedSign + selfTax
        const expFlip = rowGross + pSub + rawDedSum * dedSign + selfTax
        if (absBig(q2(netRaw - expDef)) >= CENT_STEP && absBig(q2(netRaw - expFlip)) < CENT_STEP && (REVERSAL_TX_RE.test(txType) || netRaw > 0n)) {
          rowDedSign = -dedSign
        }
      } else if (!hasNetCol && !hasPositiveGrossRow && REVERSAL_TX_RE.test(txType) && rawDedSum > 0n) {
        rowDedSign = -1n
      }
    }

    // 严格乘以 rowDedSign，严禁盲目 absBig，完整保留费用冲回负值符号！
    const sDisc = rawSDisc * rowDedSign
    const refund = rawRefund * rowDedSign
    const comm = rawComm * rowDedSign
    const fulfill = rawFulfill * rowDedSign
    const ads = rawAds * rowDedSign
    const deduction = rawDeduction * rowDedSign

    if (
      retail === 0n && supply === 0n && shipIn === 0n && sDisc === 0n && pSub === 0n &&
      refund === 0n && comm === 0n && fulfill === 0n && ads === 0n && deduction === 0n &&
      selfTax === 0n && payoutRaw === 0n && netRaw === 0n
    ) {
      continue
    }

    const bucket = ensureBucket(ccy, siteHint)
    const s = bucket.summary
    if (dt) bucket.dates.push(dt)
    s.rawRowCount++

    if (payoutRaw !== 0n || txType.includes('提现') || txType.includes('打款') || txType.includes('payout') || txType.includes('withdrawal')) {
      const pCell = parseAmountCell(cell(r, colMap.payout_amount) || cell(r, colMap.net_settlement))
      if (pCell.state === 'value') addPayoutEvidence(s, r, fundColumns, dt, absBig(pCell.value), oid, inferDateOrderFromSite(s.site))
      continue
    }

    const isFullManaged =
      modeStr.includes('全托管') || modeStr.includes('odm') || modeStr.includes('obm') ||
      modeStr.includes('jit') || modeStr.includes('fully') || txType.includes('全托管供货') ||
      (supply > 0n && retail === 0n && !modeStr.includes('半托管') && !modeStr.includes('semi') && !modeStr.includes('pop') && !modeStr.includes('平台'))
    if (isFullManaged) {
      bucket.fullManagedCount++
      bucket.fullManagedTotal += supply > 0n ? supply : absBig(netRaw)
    } else if (retail > 0n || modeStr.includes('半托管') || modeStr.includes('semi') || modeStr.includes('pop') || modeStr.includes('平台')) {
      bucket.semiOrPopCount++
    }

    if (rowGross > 0n) s.orderCount++
    s.grossSales += rowGross
    s.sellerDiscount += sDisc
    s.platformSubsidy += pSub
    s.customerRefund += refund
    s.platformCommission += comm
    s.logisticsWarehousing += fulfill
    s.inPlatformAds += ads
    s.gatewayDisputeFee += deduction
    s.facilitatorTaxStripped += wTax
    s.selfRemitTaxNet += selfTax

    if (deduction > 0n) {
      bucket.deductionCount++
      bucket.deductionTotal += deduction
    }

    if (hasNetCol) {
      const expectedNet = rowGross - sDisc + pSub - refund - comm - fulfill - ads - deduction + selfTax
      const diff = q2(netRaw - expectedNet)
      if (absBig(diff) >= CENT_STEP) {
        s.horizontalDiffTotal += diff
        s.anomalies.push({
          severity: 'P0-阻断',
          category: 'SHEIN 行内水平守恒校验失败',
          refId: oid,
          amount: fmtAmount(diff),
          detail: `净结款 ${fmtAmount(netRaw)} 与明细推算值 ${fmtAmount(expectedNet)} 差出 ${fmtAmount(diff)}，请核对是否遗漏履约运费或扣款列`,
        })
      }
    }
  }

  const out = []
  for (const [, b] of byCcy) {
    const s = b.summary
    if (s.rawRowCount === 0) continue
    const dateOrder = b.hasExplicitSite ? inferDateOrderFromSite(s.site) : (s.currency === 'USD' ? null : inferDateOrderFromSite(s.site))
    s.period = inferPeriod(b.dates, '待确认期间', { dateOrder })
    appendDateValidationAnomalies(s, b.dates, dateOrder, 'SHN')
    if (b.fullManagedCount > 0) {
      s.anomalies.push({
        severity: 'P0-阻断',
        category: b.semiOrPopCount > 0 ? 'SHEIN 全托管供货与半托管/平台混表' : 'SHEIN 全托管供货结算口径警示',
        refId: `SHN-FM-${b.fullManagedCount}`,
        amount: fmtAmount(b.fullManagedTotal),
        detail: `检出 ${b.fullManagedCount} 笔全托管供货结算（合计 ${fmtAmount(b.fullManagedTotal)} ${s.currency}）。全托管属向平台指定主体供货，与半托管/POP 境外终端零售申报口径不同，申报前须先剥离。`,
      })
    }
    if (b.deductionCount > 0) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'SHEIN 质检/履约违约扣款',
        refId: `SHN-DED-${b.deductionCount}`,
        amount: fmtAmount(b.deductionTotal),
        detail: `检出 ${b.deductionCount} 笔质检或履约违规扣款（合计 ${fmtAmount(b.deductionTotal)} ${s.currency}），须单独列支费用/营业外支出，勿直接冲减销售收入。`,
      })
    }
    if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'SHEIN 非代扣待自申报境外流转税',
        refId: 'SHN-SELF-TAX',
        amount: fmtAmount(s.selfRemitTaxNet),
        detail: `检出非平台代扣流转税净额 ${fmtAmount(s.selfRemitTaxNet)} ${s.currency}，已单独剥离，勿混入主营业务收入。`,
      })
    }
    out.push(finalizeSummary(s))
  }
  return out
}

export function parseSheinSheets(fileName, sheets, formatInfo = 'csv', detectedHeader = null) {
  for (const [sName, rows] of sheets) {
    const m = detectedHeader || findHeaderRow(rows, SHEIN_ALIASES, 4, 45, false)
    if (!m || (!detectedHeader && !isSheinMatch(`${fileName} ${sName}`, rows, m[0], m[1]))) continue
    const res = parseSheinRows(rows, { fileName, formatInfo, headerIndex: m[0], columns: m[1] })
    if (res.length) return res
  }
  return null
}

// ── 3B. Walmart Marketplace Reconciliation Report 解析器（兼容长表事件流 & 宽表明细） ──
export const WALMART_ALIASES = {
  period_start: ['period start date', 'settlement start date', 'start date', '账期开始日期', '结算开始日期'],
  period_end: ['period end date', 'settlement end date', 'end date', '账期结束日期', '结算结束日期'],
  date: ['transaction posted timestamp', 'posted date', 'transaction date', 'order date', 'date', '交易日期', '入账时间'],
  order_id: ['order #', 'purchase order #', 'customer order #', 'order id', 'order number', '订单号', '沃尔玛订单号'],
  tx_key: ['transaction key', 'settlement id', 'payout id', 'transaction id', '结算单号', '交易流水号'],
  tx_type: ['transaction type', 'transaction category', 'type', '交易类型'],
  amount_type: ['amount type', 'fee type', 'amount description', 'description', '金额类型', '费用类型'],
  amount: ['amount', 'net amount', 'settlement amount', '金额', '净额'],
  total_payable: ['total payable', 'net payable', 'payable amount', 'payout amount', '应付总额', '实付金额', '放款金额'],
  currency: ['currency', 'currency code', '币种'],
  product_price: ['product price', 'item price', 'gross sales', 'product sales', '商品价格', '商品金额'],
  shipping: ['shipping', 'shipping price', 'customer shipping', '运费'],
  discount: ['discount', 'promo', 'promotion', 'seller discount', '促销折扣', '商家折扣'],
  commission: ['commission', 'commission on product', 'referral fee', 'platform commission', '佣金', '平台佣金'],
  wfs_fee: ['wfs', 'wfs fee', 'wfs fulfillment fee', 'wfs storage fee', 'walmart fulfillment services', 'wfs履约费', 'wfs仓储费'],
  ads_fee: ['walmart connect', 'advertising', 'ad fee', 'sponsored search', '广告费'],
  refund: ['refund', 'refund amount', '退款', '退款金额'],
  tax_collected: ['tax', 'sales tax', 'tax on product', 'product tax', 'tax collected', '销售税'],
  tax_withheld: ['tax withheld', 'marketplace facilitator tax', 'walmart withheld tax', 'withheld tax', '平台代扣税'],
  reserve: ['reserve', 'reserve hold', 'reserve release', '储备金', '保证金'],
}

export function isWalmartMatch(fileName, rows, headerIndex, colMap) {
  const header = rows[headerIndex] || []
  const normCells = header.map(normHdrCell)
  const rawCells = header.map((h) => String(h ?? '').trim().toLowerCase())
  // 排除 Amazon Flat File V2（含 settlement-id + marketplace-name + amount-description）
  if (normCells.includes('marketplace name') && normCells.includes('amount description')) return false
  if (normCells.some((h) => /^(?:fee name|vat in amount|total released amount|菜鸟物流费)$/i.test(h))) return false

  const hasOrderSharp = rawCells.some((h) => /^order\s*#$|^purchase order\s*#$|^customer order\s*#$/.test(h))
  const hasWfsOrWal = normCells.some((h) => /^(?:wfs|wfs fee|wfs fulfillment fee|walmart connect|total payable|period start date|period end date)$/.test(h))
  const isLongWalmart = 'tx_type' in colMap && 'amount_type' in colMap && 'amount' in colMap && ('order_id' in colMap || 'period_end' in colMap || 'total_payable' in colMap)
  const isWideWalmart = 'order_id' in colMap && ('product_price' in colMap || 'commission' in colMap) && ('wfs_fee' in colMap || 'period_start' in colMap || 'period_end' in colMap || 'total_payable' in colMap)
  const fileHint = /walmart|wfs/i.test(String(fileName || ''))
  const sampleHit = rows.slice(headerIndex + 1, headerIndex + 26).some((r) => /\bwfs\b|walmart\s*connect|commission on product/i.test(r.join(' ')))

  if (hasOrderSharp && (isLongWalmart || isWideWalmart || 'amount' in colMap || 'product_price' in colMap)) return true
  if (hasWfsOrWal && (isLongWalmart || isWideWalmart)) return true
  if ((fileHint || sampleHit) && (isLongWalmart || isWideWalmart)) return true
  return false
}

export function parseWalmartRows(rows, ctx = {}) {
  const fileName = String(ctx.fileName || 'walmart.csv')
  const formatInfo = String(ctx.formatInfo || 'csv')
  let headerIndex = ctx.headerIndex
  let colMap = ctx.columns
  if (headerIndex == null || !colMap) {
    const found = findHeaderRow(rows, WALMART_ALIASES, 4, 45, false)
    if (!found) return []
    ;[headerIndex, colMap] = found
  }
  const fundColumns = evidenceColumns(rows[headerIndex] || [])
  const dataRows = rows.slice(headerIndex + 1)
  if (!dataRows.length) return []

  const hasWideCols = 'product_price' in colMap || 'commission' in colMap || 'wfs_fee' in colMap || 'refund' in colMap
  const wideNetKey = 'amount' in colMap ? 'amount' : ('total_payable' in colMap ? 'total_payable' : null)
  const wideDedSign = hasWideCols
    ? detectDeductionSign(dataRows, colMap, ['product_price', 'shipping'], ['discount', 'refund', 'commission', 'wfs_fee', 'ads_fee'], wideNetKey)
    : 1n
  const hasPositiveWideGross = hasWideCols && dataRows.some((r) => parseAmount(cell(r, colMap.product_price)) > 0n || parseAmount(cell(r, colMap.shipping)) > 0n)
  const WM_REVERSAL_RE = /adjustment|rebate|reversal|refund|credit|冲回|返还|退回/i

  const byCcy = new Map()
  const ensureBucket = (ccy) => {
    if (!byCcy.has(ccy)) {
      byCcy.set(ccy, {
        dates: [],
        collectedTax: 0n,
        withheldTax: 0n,
        summary: makeEmptySummary({
          period: '待确认期间',
          platform: 'Walmart',
          site: SITE_BY_CCY[ccy] || 'US',
          currency: ccy,
          formatLabel: `Walmart Marketplace 对账单 (${formatInfo})`,
          fileName,
        }),
      })
    }
    return byCcy.get(ccy)
  }

  for (let idx = 0; idx < dataRows.length; idx++) {
    const r = dataRows[idx]
    const oid = cell(r, colMap.order_id) || cell(r, colMap.tx_key) || `WM-${headerIndex + 2 + idx}`
    const txType = cell(r, colMap.tx_type)
    const amtType = cell(r, colMap.amount_type)
    const tl = txType.toLowerCase()
    const atl = amtType.toLowerCase()
    if (TOTAL_ROW_RE.test(oid) || TOTAL_ROW_RE.test(tl) || TOTAL_ROW_RE.test(atl)) continue

    const dt = cell(r, colMap.date) || cell(r, colMap.period_end) || cell(r, colMap.period_start)
    const ccy = normalizeCurrencyCode(cell(r, colMap.currency) || ctx.currency || 'USD')
    const amtCell = parseAmountCell(cell(r, colMap.amount))
    const totPayCell = parseAmountCell(cell(r, colMap.total_payable))
    const prod = parseAmount(cell(r, colMap.product_price))
    const ship = parseAmount(cell(r, colMap.shipping))
    const rawDisc = parseAmount(cell(r, colMap.discount))
    const rawComm = parseAmount(cell(r, colMap.commission))
    const rawWfs = parseAmount(cell(r, colMap.wfs_fee))
    const rawAds = parseAmount(cell(r, colMap.ads_fee))
    const rawRefWide = parseAmount(cell(r, colMap.refund))
    const taxCollCol = parseAmount(cell(r, colMap.tax_collected))
    const taxWithCol = parseAmount(cell(r, colMap.tax_withheld))
    const resvCol = parseAmount(cell(r, colMap.reserve))
    const rowGrossWide = prod + ship
    const rowTaxNetWide = taxCollCol !== 0n
      ? (taxWithCol < 0n ? taxCollCol + taxWithCol : taxCollCol - taxWithCol)
      : 0n

    const amt = amtCell.value ?? 0n
    const totPay = totPayCell.value ?? 0n
    let rowWideSign = wideDedSign
    if (hasWideCols && rowGrossWide === 0n) {
      const rawDedSum = rawDisc + rawComm + rawWfs + rawAds + rawRefWide
      const hasWideNet = Boolean(wideNetKey && cell(r, colMap[wideNetKey]) !== '')
      const netRaw = wideNetKey === 'amount' ? amt : totPay
      if (hasWideNet && rawDedSum !== 0n) {
        const expDef = rowGrossWide - rawDedSum * wideDedSign + rowTaxNetWide + resvCol
        const expFlip = rowGrossWide + rawDedSum * wideDedSign + rowTaxNetWide + resvCol
        if (absBig(q2(netRaw - expDef)) >= CENT_STEP && absBig(q2(netRaw - expFlip)) < CENT_STEP && (WM_REVERSAL_RE.test(tl) || netRaw > 0n)) {
          rowWideSign = -wideDedSign
        }
      } else if (!hasWideNet && !hasPositiveWideGross && WM_REVERSAL_RE.test(tl) && rawDedSum > 0n) {
        rowWideSign = -1n
      }
    }

    const disc = rawDisc * rowWideSign
    const comm = rawComm * rowWideSign
    const wfs = rawWfs * rowWideSign
    const ads = rawAds * rowWideSign
    const refWide = rawRefWide * rowWideSign

    const hasWideValues = prod !== 0n || ship !== 0n || disc !== 0n || comm !== 0n || wfs !== 0n || ads !== 0n || refWide !== 0n
    if (!txType && !amtType && !hasWideValues && amt === 0n && totPay === 0n && resvCol === 0n) continue

    const bucket = ensureBucket(ccy)
    const s = bucket.summary
    if (dt) bucket.dates.push(dt)
    s.rawRowCount++

    // 汇总放款行或显式 Payout 行
    const isPayoutType = ['payout', 'disbursement', 'settlement', 'transfer', 'bank transfer', '打款', '提现', '放款'].some(
      (k) => tl === k || atl === k,
    )
    if ((!txType && !amtType && !hasWideValues && totPayCell.state === 'value') || (isPayoutType && !hasWideValues)) {
      const pVal = totPayCell.state === 'value' ? totPayCell.value : amt
      addPayoutEvidence(s, r, fundColumns, dt, absBig(pVal), cell(r, colMap.tx_key) || oid)
      continue
    }

    // 宽表模式
    if (hasWideCols && (hasWideValues || !amtType)) {
      const rowGross = prod + ship
      if (rowGross > 0n && !tl.includes('refund')) s.orderCount++
      const wTax = absBig(taxWithCol)
      const rowTaxNet = taxCollCol !== 0n
        ? (taxWithCol < 0n ? taxCollCol + taxWithCol : taxCollCol - taxWithCol)
        : 0n
      s.grossSales += rowGross
      s.sellerDiscount += disc
      s.customerRefund += refWide
      s.platformCommission += comm
      s.logisticsWarehousing += wfs
      s.inPlatformAds += ads
      s.facilitatorTaxStripped += wTax
      if (absBig(rowTaxNet) >= CENT_STEP) s.selfRemitTaxNet += rowTaxNet
      if (resvCol !== 0n) s.reserveNetChange += -resvCol
      if (tl.includes('dispute') || tl.includes('chargeback')) {
        s.anomalies.push({
          severity: 'P1-高危',
          category: 'Walmart 拒付/争议扣款 (Dispute/Chargeback)',
          refId: oid,
          amount: fmtAmount(amt || totPay),
          detail: '检测到 Walmart 争议/拒付记录，请留存履约证据并单独核对争议费。',
        })
      }
      if (wideNetKey && cell(r, colMap[wideNetKey]) !== '') {
        const netRaw = wideNetKey === 'amount' ? amt : totPay
        const expectedNet = rowGross - disc - refWide - comm - wfs - ads + rowTaxNet + resvCol
        const diff = q2(netRaw - expectedNet)
        if (absBig(diff) >= CENT_STEP) {
          s.horizontalDiffTotal += diff
          s.anomalies.push({
            severity: 'P0-阻断',
            category: 'Walmart 行内水平守恒校验失败',
            refId: oid,
            amount: fmtAmount(diff),
            detail: `净额 ${fmtAmount(netRaw)} 与明细推算值 ${fmtAmount(expectedNet)} 差出 ${fmtAmount(diff)}，请核查导表完整性。`,
          })
        }
      }
      continue
    }

    // 长表事件模式（Official Walmart Reconciliation Report: Transaction Type + Amount Type + Amount）
    const isRefund = tl.includes('refund') || tl.includes('return') || atl.includes('refund')
    const isDispute = tl.includes('dispute') || tl.includes('chargeback') || atl.includes('dispute') || atl.includes('chargeback')

    if (atl.includes('reserve') || tl.includes('reserve')) {
      s.reserveNetChange += -amt
    } else if (atl.includes('withheld') || atl.includes('facilitator') || atl.includes('tax remitted')) {
      bucket.withheldTax += amt
      s.facilitatorTaxStripped += absBig(amt)
    } else if (atl === 'tax' || atl.includes('sales tax') || atl.includes('tax on product') || atl.includes('tax on shipping') || atl.includes('product tax') || atl.includes('shipping tax')) {
      bucket.collectedTax += amt
    } else if (/\bwfs\b|fulfillment|storage|inbound|return shipping|shipping label|freight|warehouse/i.test(atl) || /\bwfs\b/i.test(tl)) {
      s.logisticsWarehousing += -amt
    } else if (/walmart\s*connect|advertising|sponsored|\bads?\b/i.test(atl) || /advertising|walmart\s*connect/i.test(tl)) {
      s.inPlatformAds += -amt
    } else if (isDispute) {
      if (atl.includes('fee')) s.gatewayDisputeFee += -amt
      else s.customerRefund += -amt
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'Walmart 拒付/争议扣款 (Dispute/Chargeback)',
        refId: oid,
        amount: fmtAmount(amt),
        detail: '检测到 Walmart 拒付或争议扣款，须区分争议费与销售退款。',
      })
    } else if (/commission|referral|service\s*fee|subscription/i.test(atl) || tl.includes('service fee')) {
      // 严守符号：退款返还佣金 amt > 0n 时 -amt < 0n 自动冲减佣金
      s.platformCommission += -amt
    } else if (/promo|discount|rebate|coupon/i.test(atl)) {
      if (atl.includes('walmart') || atl.includes('platform') || atl.includes('subsidy')) s.platformSubsidy += amt
      else if (isRefund) s.customerRefund += -amt
      else s.sellerDiscount += -amt
    } else if (/reimbursement|lost\s*inventory|damaged\s*inventory/i.test(atl) || tl.includes('reimbursement')) {
      if (amt >= 0n) s.platformSubsidy += amt
      else s.logisticsWarehousing += -amt
      s.anomalies.push({
        severity: 'P2-关注',
        category: 'Walmart WFS 库存/履约赔付',
        refId: oid,
        amount: fmtAmount(amt),
        detail: '请区分非销售仓储理赔与平台补贴。',
      })
    } else if (/product\s*price|item\s*price|shipping|merchandise|sale/i.test(atl) || tl === 'sale' || tl === 'order' || isRefund) {
      if (isRefund) s.customerRefund += -amt
      else {
        if (amt > 0n && (/product\s*price|item\s*price|merchandise/i.test(atl) || (!atl && (tl === 'sale' || tl === 'order')))) {
          const rawOrderId = cell(r, colMap.order_id)
          bucket.countedOrderIds = bucket.countedOrderIds || new Set()
          if (!rawOrderId) s.orderCount++
          else if (!bucket.countedOrderIds.has(rawOrderId)) {
            bucket.countedOrderIds.add(rawOrderId)
            s.orderCount++
          }
        }
        s.grossSales += amt
      }
    } else {
      if (amt < 0n) s.platformCommission += -amt
      else s.platformSubsidy += amt
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'Walmart 未识别费用/交易类型',
        refId: oid,
        amount: fmtAmount(amt),
        detail: '发现非常规 Amount Type，请回到原对账单核对归属科目。',
      })
    }
  }

  const out = []
  for (const [, b] of byCcy) {
    const s = b.summary
    if (s.rawRowCount === 0) continue
    const dateOrder = inferDateOrderFromSite(s.site)
    s.period = inferPeriod(b.dates, '待确认期间', { dateOrder })
    appendDateValidationAnomalies(s, b.dates, dateOrder, 'WM')
    const taxNet = b.collectedTax + b.withheldTax
    if (absBig(taxNet) >= CENT_STEP) {
      s.selfRemitTaxNet += taxNet
    }
    if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'Walmart 非代扣待自申报销售税 (Sales Tax)',
        refId: 'WM-SELF-TAX',
        amount: fmtAmount(s.selfRemitTaxNet),
        detail: `检出未由 Walmart 全额代扣的销售税净额 ${fmtAmount(s.selfRemitTaxNet)} ${s.currency}，已单独剥离，严禁混入营业收入。`,
      })
    }
    out.push(finalizeSummary(s))
  }
  return out
}

export function parseWalmartSheets(fileName, sheets, formatInfo = 'csv', detectedHeader = null) {
  for (const [sName, rows] of sheets) {
    const m = detectedHeader || findHeaderRow(rows, WALMART_ALIASES, 4, 45, false)
    if (!m || (!detectedHeader && !isWalmartMatch(`${fileName} ${sName}`, rows, m[0], m[1]))) continue
    const res = parseWalmartRows(rows, { fileName, formatInfo, headerIndex: m[0], columns: m[1] })
    if (res.length) return res
  }
  return null
}

// ── 3C. Lazada Seller Center Statement 解析器 ──
export const LAZADA_ALIASES = {
  date: ['transaction date', 'order creation date', 'date', '交易日期', '入账日期'],
  tx_type: ['transaction type', 'type', '交易类型'],
  fee_name: ['fee name', 'fee type', '费用名称', '费用项'],
  tx_number: ['transaction number', 'transaction id', '交易流水号'],
  details: ['details', 'description', '明细', '说明'],
  order_id: ['order no', 'order no.', 'order number', 'order id', '订单号'],
  amount: ['amount', '金额'],
  vat_in_amount: ['vat in amount', 'gst in amount', 'vat', '费用税额', '含税额'],
  wht_amount: ['wht amount', 'wht included in amount', 'withholding tax', '预提税'],
  statement: ['statement', 'statement period', '账期', '结算周期'],
  paid_status: ['paid status', 'payout status', 'status', '付款状态', '结算状态'],
  currency: ['currency', '币种', '结算币种'],
  site: ['site', 'country', 'region', '站点', '国家'],
}

export function isLazadaMatch(fileName, rows, headerIndex, colMap) {
  if (!('fee_name' in colMap && 'amount' in colMap && ('order_id' in colMap || 'date' in colMap))) return false
  const hasLazadaMarker = 'vat_in_amount' in colMap || 'paid_status' in colMap || 'statement' in colMap
  const fileHint = /lazada|来赞达/i.test(String(fileName || ''))
  const sampleHit = rows.slice(headerIndex + 1, headerIndex + 26).some(
    (r) => /lazada|item price credit|shipping fee \(charged by lazada\)|sponsored discovery|fbl/i.test(r.join(' ')),
  )
  return hasLazadaMarker || fileHint || sampleHit
}

function extractDateFromLazadaStatement(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const parts = s.split(/\s+-\s+|\s+to\s+/i)
  return (parts[parts.length - 1] || parts[0] || '').trim()
}

export function parseLazadaRows(rows, ctx = {}) {
  const fileName = String(ctx.fileName || 'lazada.csv')
  const formatInfo = String(ctx.formatInfo || 'csv')
  let headerIndex = ctx.headerIndex
  let colMap = ctx.columns
  if (headerIndex == null || !colMap) {
    const found = findHeaderRow(rows, LAZADA_ALIASES, 4, 45, false)
    if (!found) return []
    ;[headerIndex, colMap] = found
  }
  const fundColumns = evidenceColumns(rows[headerIndex] || [])
  const dataRows = rows.slice(headerIndex + 1)
  if (!dataRows.length) return []

  const byCcy = new Map()
  const ensureBucket = (ccy, siteHint) => {
    if (!byCcy.has(ccy)) {
      byCcy.set(ccy, {
        dates: [],
        voidCount: 0,
        unpaidCount: 0,
        unpaidNet: 0n,
        whtTotal: 0n,
        penaltyCount: 0,
        penaltyTotal: 0n,
        summary: makeEmptySummary({
          period: '待确认期间',
          platform: 'Lazada',
          site: siteHint || SITE_BY_CCY[ccy] || 'SG',
          currency: ccy,
          formatLabel: `Lazada Seller Center 对账单 (${formatInfo})`,
          fileName,
        }),
      })
    }
    return byCcy.get(ccy)
  }

  for (let idx = 0; idx < dataRows.length; idx++) {
    const r = dataRows[idx]
    const oid = cell(r, colMap.order_id) || cell(r, colMap.tx_number) || `LZ-${headerIndex + 2 + idx}`
    const feeName = cell(r, colMap.fee_name)
    const txType = cell(r, colMap.tx_type)
    const details = cell(r, colMap.details)
    const fnl = feeName.toLowerCase()
    const ttl = txType.toLowerCase()
    const paidStatus = cell(r, colMap.paid_status).toLowerCase()
    if (TOTAL_ROW_RE.test(oid) || TOTAL_ROW_RE.test(fnl) || TOTAL_ROW_RE.test(ttl)) continue

    const amt = parseAmount(cell(r, colMap.amount))
    const vatInAmt = parseAmount(cell(r, colMap.vat_in_amount))
    const whtCol = parseAmount(cell(r, colMap.wht_amount))
    if (!feeName && amt === 0n && vatInAmt === 0n && whtCol === 0n) continue

    const ccy = normalizeCurrencyCode(cell(r, colMap.currency) || ctx.currency || 'MYR')
    const siteRaw = cell(r, colMap.site).toUpperCase()
    const siteHint = /^[A-Z]{2,3}$/.test(siteRaw) ? siteRaw : null
    const bucket = ensureBucket(ccy, siteHint)
    const s = bucket.summary
    const dt = cell(r, colMap.date) || extractDateFromLazadaStatement(cell(r, colMap.statement))
    if (dt) bucket.dates.push(dt)
    s.rawRowCount++

    if (['cancelled', 'canceled', 'void', 'voided', 'failed', 'rejected', '已取消', '作废', '失败'].includes(paidStatus)) {
      bucket.voidCount++
      s.uncapturedVoidExcluded += absBig(amt + vatInAmt)
      continue
    }
    const isUnpaidStatus = ['not paid', 'unpaid', 'pending', 'processing', 'unsettled', '未打款', '待打款', '未付款', '待付款', '处理中'].includes(paidStatus)
    if (isUnpaidStatus) {
      bucket.unpaidCount++
      bucket.unpaidNet += amt + vatInAmt + whtCol
    }

    if (/payout|withdrawal|bank transfer|disbursement|release to bank|提现|打款/i.test(fnl) || /^(?:payout|withdrawal)$/i.test(ttl)) {
      // Not Paid / 未付款、存在状态列但为空白、或非明确已付款状态绝不计入已放款 actualPayout 与 payoutEvidence！
      if (isUnpaidStatus) continue
      const hasPaidStatusCol = 'paid_status' in colMap
      if ((hasPaidStatusCol && !paidStatus) || (paidStatus && !['paid', 'completed', 'settled', 'released', '已打款', '已付款', '已结算', '已完成'].includes(paidStatus))) {
        bucket.unpaidCount++
        bucket.unpaidNet += amt + vatInAmt + whtCol
        continue
      }
      addPayoutEvidence(s, r, fundColumns, dt, absBig(amt), cell(r, colMap.tx_number) || cell(r, colMap.statement) || oid, inferDateOrderFromSite(s.site))
      continue
    }

    if (whtCol !== 0n) {
      const whtCost = -whtCol
      s.gatewayDisputeFee += whtCost
      bucket.whtTotal += whtCost
    }
    if (/withholding\s*tax|\bwht\b|预提税/i.test(fnl)) {
      const whtCost = -(amt + vatInAmt)
      s.gatewayDisputeFee += whtCost
      bucket.whtTotal += whtCost
      continue
    }
    if (/(?:\b(?:reserve|account\s*hold|funds?\s*hold|hold|release)\b|保证金|冻结)/i.test(fnl) && !/item price/i.test(fnl)) {
      s.reserveNetChange += -amt
      continue
    }
    if (/marketplace\s*vat|overseas\s*vat|vat\s*withheld|gst\s*withheld|平台代扣税|代扣vat/i.test(fnl)) {
      s.facilitatorTaxStripped += absBig(amt + vatInAmt)
      continue
    }
    const isExplicitFeeOrSub = /commission|payment\s*fee|service\s*fee|program\s*fee|transaction\s*fee|free\s*shipping\s*max|shipping\s*fee|fbl|fulfillment|logistics|warehouse|storage|reverse\s*shipping|sponsored|marketing|\bads?\b|affiliate|penalty|violation|claim|dispute|chargeback|voucher|discount|bonus|rebate|subsidy|佣金|手续费|服务费|运费|仓储|物流|推广|广告|罚款|违约|补贴|优惠/i.test(fnl)
    if (!isExplicitFeeOrSub && (/reversal\s*item\s*price|refund|customer\s*refund|return\s*refund|退款|货款冲回/i.test(fnl) || ttl.includes('refund'))) {
      s.customerRefund += -amt
      if (vatInAmt !== 0n) s.selfRemitTaxNet += vatInAmt
      continue
    }
    if (/item\s*price|product\s*price|shipping\s*fee\s*paid\s*by\s*buyer|buyer.*shipping|order\s*revenue|商品收入|买家支付运费/i.test(fnl)) {
      if (amt > 0n && !/shipping|运费/i.test(fnl)) {
        const rawOrderId = cell(r, colMap.order_id)
        bucket.countedOrderIds = bucket.countedOrderIds || new Set()
        if (!rawOrderId) s.orderCount++
        else if (!bucket.countedOrderIds.has(rawOrderId)) {
          bucket.countedOrderIds.add(rawOrderId)
          s.orderCount++
        }
      }
      s.grossSales += amt
      if (vatInAmt > 0n) s.selfRemitTaxNet += vatInAmt
      else if (vatInAmt < 0n) s.facilitatorTaxStripped += absBig(vatInAmt)
      continue
    }
    if (/seller\s*voucher|seller\s*discount|flexi\s*combo|promotional\s*charges\s*vouchers|商家优惠|卖家折扣/i.test(fnl)) {
      s.sellerDiscount += -amt
      continue
    }
    if (/lazada\s*bonus|platform\s*voucher|lazada\s*rebate|shipping\s*fee\s*subsidy|co-?funded\s*subsidy|平台补贴|运费补贴/i.test(fnl)) {
      s.platformSubsidy += amt
      continue
    }
    if (/sponsored|marketing|\bads?\b|推广|广告/i.test(fnl) || ttl.includes('marketing')) {
      s.inPlatformAds += -(amt + vatInAmt)
      continue
    }
    if (/affiliate|联盟佣金/i.test(fnl)) {
      s.affiliateCommission += -(amt + vatInAmt)
      continue
    }
    if (/shipping\s*fee|fbl|fulfillment|logistics|warehouse|storage|reverse\s*shipping|运费|仓储|物流/i.test(fnl) || ttl.includes('logistics')) {
      s.logisticsWarehousing += -(amt + vatInAmt)
      continue
    }
    if (/penalty|violation|claim|dispute|chargeback|罚款|违约|拒付/i.test(fnl)) {
      const penCost = -(amt + vatInAmt)
      s.gatewayDisputeFee += penCost
      if (penCost > 0n) {
        bucket.penaltyCount++
        bucket.penaltyTotal += penCost
      }
      continue
    }
    if (/commission|payment\s*fee|service\s*fee|program\s*fee|transaction\s*fee|free\s*shipping\s*max|佣金|手续费|服务费/i.test(fnl)) {
      // 严守符号：Reversal Commission (amt > 0n) 自动冲减 platformCommission
      s.platformCommission += -(amt + vatInAmt)
      continue
    }
    // 兜底：保留精确正负方向
    const netLine = amt + vatInAmt
    if (netLine < 0n) s.platformCommission += -netLine
    else s.platformSubsidy += netLine
    if (details || feeName) {
      s.anomalies.push({
        severity: 'P2-关注',
        category: 'Lazada 非常规费用项待核',
        refId: oid,
        amount: fmtAmount(netLine),
        detail: '发现未归类的 Lazada Fee Name，请核对是否属于平台补贴或佣金冲回。',
      })
    }
  }

  const out = []
  for (const [, b] of byCcy) {
    const s = b.summary
    if (s.rawRowCount === 0) continue
    const dateOrder = inferDateOrderFromSite(s.site)
    s.period = inferPeriod(b.dates, '待确认期间', { dateOrder })
    appendDateValidationAnomalies(s, b.dates, dateOrder, 'LZ')
    if (b.voidCount > 0) {
      s.anomalies.push({
        severity: 'P2-关注',
        category: '已自动过滤 Lazada 取消/作废明细',
        refId: `LZ-VOID-${b.voidCount}`,
        amount: fmtAmount(s.uncapturedVoidExcluded),
        detail: `共剔除 ${b.voidCount} 笔 Cancelled/Void 明细（合计 ${fmtAmount(s.uncapturedVoidExcluded)} ${s.currency}）。`,
      })
    }
    if (b.unpaidCount > 0) {
      s.anomalies.push({
        severity: 'P2-关注',
        category: 'Lazada 存在待打款 (Not Paid) 结算明细',
        refId: `LZ-UNPAID-${b.unpaidCount}`,
        amount: fmtAmount(b.unpaidNet),
        detail: `本期含 ${b.unpaidCount} 笔尚未打款（Not Paid）明细（净额 ${fmtAmount(b.unpaidNet)} ${s.currency}），属跨期在途款项，请跟踪下期放款。`,
      })
    }
    if (b.whtTotal >= CENT_STEP) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'Lazada 站点代扣预提所得税 (WHT)',
        refId: 'LZ-WHT',
        amount: fmtAmount(b.whtTotal),
        detail: `Lazada 扣缴预提税 ${fmtAmount(b.whtTotal)} ${s.currency}，须下载完税证明评估境外所得抵免，勿混同普通佣金。`,
      })
    }
    if (b.penaltyCount > 0) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'Lazada 履约违约罚款/争议扣款',
        refId: `LZ-PEN-${b.penaltyCount}`,
        amount: fmtAmount(b.penaltyTotal),
        detail: `检出 ${b.penaltyCount} 笔违约扣款（合计 ${fmtAmount(b.penaltyTotal)} ${s.currency}），须单独列支费用/营业外支出。`,
      })
    }
    if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'Lazada 卖家自申报流转税净额 (VAT)',
        refId: 'LZ-SELF-TAX',
        amount: fmtAmount(s.selfRemitTaxNet),
        detail: `检出卖家侧流转税净额 ${fmtAmount(s.selfRemitTaxNet)} ${s.currency}，已单独剥离，勿混入营业收入。`,
      })
    }
    out.push(finalizeSummary(s))
  }
  return out
}

export function parseLazadaSheets(fileName, sheets, formatInfo = 'csv', detectedHeader = null) {
  for (const [sName, rows] of sheets) {
    const m = detectedHeader || findHeaderRow(rows, LAZADA_ALIASES, 4, 45, false)
    if (!m || (!detectedHeader && !isLazadaMatch(`${fileName} ${sName}`, rows, m[0], m[1]))) continue
    const res = parseLazadaRows(rows, { fileName, formatInfo, headerIndex: m[0], columns: m[1] })
    if (res.length) return res
  }
  return null
}

// ════════════════════════════════════════════════════════════════
// 4. 统一探测与解析入口（供 Phase 2 接入 lib/statement.js 与独立调用）
// ════════════════════════════════════════════════════════════════

export const V9_SALES_ADAPTERS = [
  { id: 'shein', platform: 'SHEIN', aliases: SHEIN_ALIASES, minimum: 4, check: isSheinMatch, parseRows: parseSheinRows, parseSheets: parseSheinSheets },
  { id: 'walmart', platform: 'Walmart', aliases: WALMART_ALIASES, minimum: 4, check: isWalmartMatch, parseRows: parseWalmartRows, parseSheets: parseWalmartSheets },
  { id: 'lazada', platform: 'Lazada', aliases: LAZADA_ALIASES, minimum: 4, check: isLazadaMatch, parseRows: parseLazadaRows, parseSheets: parseLazadaSheets },
]

export const V9_PLATFORM_IDS = Object.freeze(['lianlian', 'pingpong', 'sunrate', 'shein', 'walmart', 'lazada'])

const V9_PLATFORM_CANONICAL = new Map([
  ['lianlian', 'lianlian'], ['连连', 'lianlian'], ['连连国际', 'lianlian'],
  ['pingpong', 'pingpong'], ['乒乓', 'pingpong'],
  ['sunrate', 'sunrate'], ['寻汇', 'sunrate'], ['寻汇 sunrate', 'sunrate'],
  ['shein', 'shein'], ['希音', 'shein'],
  ['walmart', 'walmart'], ['沃尔玛', 'walmart'],
  ['lazada', 'lazada'], ['来赞达', 'lazada'],
])

function buildTableForDetect(headers, rows) {
  const hasRows = Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])
  const hasHeaders = Array.isArray(headers) && headers.length > 0 && !Array.isArray(headers[0])
  if (hasRows && hasHeaders) {
    const alreadyPresent = rows.slice(0, 45).some(
      (r) => r === headers || (r.length === headers.length && r.every((c, i) => String(c ?? '') === String(headers[i] ?? ''))),
    )
    return alreadyPresent ? rows : [headers, ...rows]
  }
  if (hasRows) return rows
  if (Array.isArray(headers) && headers.length > 0) {
    return Array.isArray(headers[0]) ? headers : [headers]
  }
  return []
}

export function detectV9Platform(headers, filename = '', rows = null) {
  const table = buildTableForDetect(headers, rows)
  if (!table.length) return null

  const candidates = []
  for (const adapter of V9_SALES_ADAPTERS) {
    const found = findHeaderRow(table, adapter.aliases, adapter.minimum, 45, false)
    if (!found) continue
    const [headerIndex, columns] = found
    if (!adapter.check(filename, table, headerIndex, columns)) continue
    candidates.push({
      platform: adapter.id,
      label: adapter.platform,
      role: 'sales_platform',
      headerIndex,
      columns,
      score: 4,
      confidence: 'high',
    })
  }

  for (const wc of findV9WalletCandidates(table, null, filename)) {
    candidates.push({
      platform: wc.id,
      label: wc.platform,
      role: 'settlement_wallet',
      headerIndex: wc.headerIndex,
      columns: wc.columns,
      score: wc.score,
      confidence: wc.score >= 4 ? 'high' : wc.score >= 3 ? 'medium' : 'low',
    })
  }

  if (!candidates.length) return null
  const bestScore = Math.max(...candidates.map((c) => c.score))
  const top = candidates.filter((c) => c.score === bestScore)
  if (top.length !== 1) return null
  return top[0]
}

export function parseV9PlatformRows(platform, rows, ctx = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const fileName = String(ctx.fileName || `${platform || 'v9'}.csv`)
  const formatInfo = String(ctx.formatInfo || 'csv')

  let canon = V9_PLATFORM_CANONICAL.get(String(platform ?? '').trim().toLowerCase()) || null
  let det = ctx.detected || null
  if (!canon) {
    det = detectV9Platform(rows[0], fileName, rows)
    canon = det?.platform || null
  }
  if (!canon) return []

  const walletProvider = V9_WALLET_PROVIDERS.find((p) => p.id === canon)
  if (walletProvider) {
    let headerIndex = ctx.headerIndex ?? det?.headerIndex
    let columns = ctx.columns ?? det?.columns
    if (headerIndex == null || !columns) {
      const cand = findV9WalletCandidates(rows, canon, fileName)[0]
      if (!cand) return []
      headerIndex = cand.headerIndex
      columns = cand.columns
    }
    return parseV9WalletSheet(fileName, rows, formatInfo, { provider: walletProvider, headerIndex, columns })
  }

  const salesAdapter = V9_SALES_ADAPTERS.find((a) => a.id === canon)
  if (!salesAdapter) return []
  return salesAdapter.parseRows(rows, {
    ...ctx,
    fileName,
    formatInfo,
    headerIndex: ctx.headerIndex ?? det?.headerIndex,
    columns: ctx.columns ?? det?.columns,
  })
}

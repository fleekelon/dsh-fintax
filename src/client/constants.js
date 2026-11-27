// Shared constants, channel whitelists, and diagnostic maps for dsh-fintax client.

export const NS = 'settings.fintax'
export const PANEL_ID = 'dsh-fintax'
export const CLIENT_VERSION = '0.9.0'
export const inject = ['slots', 'locale']

export const DEMO_FX = {
  USD: 7.18, EUR: 7.82, GBP: 9.15, AUD: 4.72, CAD: 5.18, JPY: 0.047,
  SGD: 5.36, MYR: 1.62, THB: 0.21, VND: 0.00028, PHP: 0.125, IDR: 0.00046,
  BRL: 1.26, MXN: 0.36, TWD: 0.22, HKD: 0.92, RMB: 1, CNY: 1,
}

// 11 sales platforms + 6 settlement wallets = 17 channels, plus Stage 3 domestic corporate bank receipts.
export const ADAPTERS = [
  'PayPal', 'AliExpress', 'Shopee', 'Amazon', 'TikTok Shop', 'Temu',
  'Shopify', 'Stripe', 'SHEIN', 'Walmart', 'Lazada',
]

export const WALLET_ADAPTERS = [
  'WorldFirst', 'Payoneer', 'Airwallex', 'LianLian', 'PingPong', 'SUNRATE',
]

export const BANK_ADAPTERS = [
  'CMB', 'BOC', 'ICBC', 'CCB', 'ABC', 'BOCOM', 'GENERIC_BANK',
  '招商银行', '中国银行', '工商银行', '建设银行', '农业银行', '交通银行', '国内对公银行',
]

export const MAX_UPLOAD_FILES = 24
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const ANOMALY_PAGE_SIZE = 12
export const IMA_SNIPPET_MAX_LEN = 160

export const DIAGNOSTIC_LABELS = new Map([
  ['STATEMENT_UNKNOWN_FORMAT', '未识别表头'],
  ['STATEMENT_CANDIDATE_CONFLICT', '候选格式冲突'],
  ['STATEMENT_EMPTY', '无可解析明细'],
  ['STATEMENT_AMOUNT_INVALID', '金额格式待核'],
  ['STATEMENT_LIMIT', '超过解析上限'],
  ['STATEMENT_INVALID_ARCHIVE', '压缩包或工作簿无效'],
  ['STATEMENT_NESTED_ARCHIVE', '压缩包内含不支持的文件'],
  ['STATEMENT_INVALID_FILE', '账单文件无效'],
])

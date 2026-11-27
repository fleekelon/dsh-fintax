// Main workbench shell, dynamic locale subscription, IMA drawer host, and DSH 0.2.2/0.2.3 slot registration.

import { CLIENT_VERSION, NS, PANEL_ID, inject } from './constants.js'
import { COPY, getLang, subscribeLang } from './i18n.js'
import { retainStyles } from './styles.js'
import { callApi, probeMarketUpdate, useLatestRequest } from './api.js'
import { FinTaxMark, Icon } from './components.js'
import { ImaQuickDrawer } from './ima_drawer.js'
import { StatementRadarTab } from './tab_audit.js'
import { CalculatorTab } from './tab_calc.js'
import { AnnualArchiveTab } from './tab_annual.js'
import { SettingsTab } from './settings.js'

export function FinTaxWorkbench({ lang, ctx, surface = 'settings' }) {
  const [activeLang, setActiveLang] = useState(() => lang || getLang(ctx))
  useEffect(() => {
    if (lang) setActiveLang(lang)
  }, [lang])
  useEffect(() => {
    if (!ctx) return undefined
    return subscribeLang(ctx, (nextLang) => setActiveLang(nextLang))
  }, [ctx])

  const isZh = activeLang !== 'en'
  const t = COPY[isZh ? 'zh' : 'en']
  const [tab, setTab] = useState(surface === 'sidebar' ? 'radar' : 'settings')
  const [status, setStatus] = useState({ loading: true, configured: false, source: 'none', defaultKbId: '', defaultKbName: '', version: '' })
  const [marketUpdate, setMarketUpdate] = useState(null)
  const [copiedKey, setCopiedKey] = useState('')
  const [calcSeed, setCalcSeed] = useState(null)
  const [imaDrawer, setImaDrawer] = useState({ open: false, query: '', nonce: 0 })
  const [startStatus] = useLatestRequest()
  const [startCopy] = useLatestRequest()
  const [startUpdateProbe] = useLatestRequest()

  useEffect(retainStyles, [])

  const onJumpToCalc = useCallback((scenario, values, autoRun = true) => {
    setCalcSeed({ scenario, values, autoRun, nonce: Date.now() })
    setTab('calc')
  }, [])

  const onOpenIma = useCallback((queryText) => {
    setImaDrawer({ open: true, query: String(queryText || '').trim(), nonce: Date.now() })
  }, [])

  const refreshStatus = useCallback(async (direct) => {
    const request = startStatus()
    try {
      const data = direct || (await callApi('/status', { signal: request.signal }))
      if (request.isCurrent()) setStatus({ loading: false, ...data })
    } catch {
      if (request.isCurrent()) setStatus((prev) => ({ ...prev, loading: false }))
    }
  }, [startStatus])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  // Passive read-only dsh-market Update API v1 probe (only runs when backend advertises capability; fails silently).
  useEffect(() => {
    if (!status?.capabilities?.dshMarketUpdateV1) return
    const req = startUpdateProbe()
    probeMarketUpdate(status.version || CLIENT_VERSION, req.signal).then((res) => {
      if (req.isCurrent() && res) setMarketUpdate(res)
    }).catch(() => { /* silent */ })
  }, [status?.capabilities?.dshMarketUpdateV1, status?.version, startUpdateProbe])

  const copyTimerRef = useRef(null)
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

  const onCopyText = async (key, text) => {
    if (!navigator.clipboard?.writeText) return
    const request = startCopy()
    try {
      await navigator.clipboard.writeText(text)
      if (!request.isCurrent()) return
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      setCopiedKey(key)
      copyTimerRef.current = setTimeout(() => { if (request.isCurrent()) setCopiedKey('') }, 1800)
    } catch { /* ignore */ }
  }

  const onSendToChat = useCallback((promptText) => {
    try {
      if (typeof ctx?.conversation?.insertInput === 'function') {
        ctx.conversation.insertInput(promptText)
        return
      }
      if (typeof ctx?.chat?.send === 'function') {
        ctx.chat.send(promptText)
        return
      }
    } catch { /* fallback to clipboard */ }
    onCopyText('drawer-chat', promptText)
  }, [ctx])

  const credLabel = status.configured
    ? status.defaultKbId
      ? `IMA 知识库 · ${t.defaultKbBound}${status.defaultKbName || status.defaultKbId}`
      : status.source === 'env' ? t.statusReadyEnv : status.source === 'mixed' ? t.statusReadyMixed : t.statusReadyFile
    : t.statusMissing

  return h(
    'div',
    { className: 'ftx-host-wrap' },
    h(
      'div',
      { className: 'ftx-root', style: { maxWidth: surface === 'sidebar' ? 'min(100%, 1220px)' : 'min(100%, 900px)', width: '100%', margin: surface === 'sidebar' ? '0 auto' : 0, padding: surface === 'sidebar' ? '16px 20px 22px' : '14px 16px 24px', display: 'flex', flexDirection: 'column', gap: 13, minHeight: surface === 'sidebar' ? '100%' : 'auto' } },
      h(
        'header',
        { className: 'ftx-top' },
        h('h1', { className: 'ftx-h1' }, t.title, h('span', null, `· ${t.subtitle}${status.version ? ` v${status.version}` : ''}`)),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', maxWidth: '100%' } },
          marketUpdate?.hasUpdate && h('span', { className: 'ftx-upd-pill', title: marketUpdate.notes || '' }, `${t.updateAvailable} v${marketUpdate.latestVersion}`),
          h('div', { className: 'ftx-kb-pill', title: credLabel }, h(Icon, { kind: 'book', size: 15 }), h('span', { className: 'ftx-kb-dot', style: { background: status.configured ? 'var(--ftx-ok)' : 'var(--ftx-orange)' } }), h('span', { className: 'ftx-kb-pill-txt' }, credLabel)),
        ),
      ),
      h(
        'div',
        { className: 'ftx-tabs' },
        h('button', { type: 'button', className: `ftx-tab${tab === 'radar' ? ' is-active' : ''}`, onClick: () => setTab('radar') }, t.tabRadar),
        h('button', { type: 'button', className: `ftx-tab${tab === 'calc' ? ' is-active' : ''}`, onClick: () => setTab('calc') }, t.tabCalc),
        h('button', { type: 'button', className: `ftx-tab${tab === 'annual' ? ' is-active' : ''}`, onClick: () => setTab('annual') }, t.tabAnnual),
        h('button', { type: 'button', className: `ftx-tab${tab === 'settings' ? ' is-active' : ''}`, onClick: () => setTab('settings') }, t.tabSettings),
        h('span', { className: 'ftx-local-tag' }, h('i', null), t.localPill),
      ),
      h('div', { style: { display: tab === 'radar' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(StatementRadarTab, { active: tab === 'radar', t, status, refreshStatus, onCopyText, copiedKey, onJumpToCalc, onOpenIma })),
      h('div', { style: { display: tab === 'calc' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(CalculatorTab, { t, isZh, onCopyText, copiedKey, calcSeed, onOpenIma })),
      h('div', { style: { display: tab === 'annual' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(AnnualArchiveTab, { active: tab === 'annual', t, isZh, onOpenIma })),
      h('div', { style: { display: tab === 'settings' ? 'block' : 'none', minWidth: 0, maxWidth: '100%' } }, h(SettingsTab, { t, isZh, status, refreshStatus, marketUpdate, onUpdateProbe: setMarketUpdate })),
      h(ImaQuickDrawer, {
        open: imaDrawer.open,
        initialQuery: imaDrawer.query,
        status,
        t,
        isZh,
        onClose: () => setImaDrawer((prev) => ({ ...prev, open: false })),
        onGoSettings: () => setTab('settings'),
        onCopyText,
        copiedKey,
        onSendToChat,
      }),
      h(
        'footer',
        { style: { marginTop: 'auto', paddingTop: 10, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--ftx-mut)' } },
        h('span', null, '本地离线初筛 · 结果供人工核查'),
        h('span', { className: 'ftx-mono', style: { letterSpacing: '0.8px' } }, `DSH / FINTAX${status.version ? ` ${status.version}` : ''}`),
      ),
    ),
  )
}

function ConversationDockAction({ ctx, owner = {} }) {
  const isZh = getLang(ctx) !== 'en'
  const t = COPY[isZh ? 'zh' : 'en']
  const quickPrompt = isZh
    ? '请帮我结合跨境财税规则与我的 IMA 知识库，核对本月账单三段资金链或测算欧盟/美线税负。'
    : 'Help me reconcile my cross-border statements or calculate EU/US tax exposure using my IMA knowledge base.'
  const onClick = () => {
    try {
      if (typeof owner?.insertText === 'function') { owner.insertText(quickPrompt); return }
      if (typeof owner?.setInput === 'function') { owner.setInput(quickPrompt); return }
      if (typeof ctx?.conversation?.insertInput === 'function') { ctx.conversation.insertInput(quickPrompt); return }
      if (typeof ctx?.navigation?.openPanel === 'function') { ctx.navigation.openPanel(PANEL_ID); return }
      navigator.clipboard?.writeText?.(quickPrompt)
    } catch { /* silent */ }
  }
  return h('button', { type: 'button', className: 'ftx-dock-btn', title: t.dockTitle, onClick }, h(FinTaxMark, { size: 14 }), h('span', null, t.dockLabel))
}

/**
 * Feature-detect and safely mount DSH 0.2.3+ `conversation.input.dock` slot.
 * On DSH 0.2.2 hosts that do not expose this slot, silently skips with zero errors.
 */
function registerConversationDockSafely(ctx, t) {
  try {
    if (typeof ctx?.slots?.inject !== 'function' || typeof ctx?.slots?.register !== 'function') return
    const hasExplicitSlotCheck = typeof ctx.slots.has === 'function'
    if (hasExplicitSlotCheck && !ctx.slots.has('conversation.input.dock')) return
    const supported = Array.isArray(ctx.slots.available) ? ctx.slots.available.includes('conversation.input.dock') : true
    if (!supported) return
    ctx.slots.inject('conversation.input.dock', () => {
      try {
        const off = ctx.slots.register(
          { name: 'conversation.input.dock', id: 'fintax-quick-ask', order: 42, label: () => t('dockLabel'), locale: NS },
          (owner = {}) => h(ConversationDockAction, { ctx, owner }),
        )
        return typeof off === 'function' ? off : () => {}
      } catch {
        return () => {}
      }
    })
  } catch {
    // Host is likely DSH 0.2.2 without conversation.input.dock; ignore cleanly.
  }
}

export function createPluginEntry() {
  const apply = (ctx) => {
    try {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), 'fintax: dictionaries')

      ctx.slots.inject('sidebar.panellist', () => {
        const offPanel = ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS },
          () => h('div', { style: { height: '100%', width: '100%', maxWidth: '100%', minWidth: 0, flex: '1 1 0%', overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box' } }, h(FinTaxWorkbench, { ctx, lang: getLang(ctx), surface: 'sidebar' })),
        )
        const offRow = ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 22, label: () => t('nav'), locale: NS },
          (owner = {}) => h(FinTaxMark, { size: owner?.size ?? 16 }),
        )
        return () => {
          if (typeof offRow === 'function') offRow()
          if (typeof offPanel === 'function') offPanel()
        }
      })

      ctx.slots.inject('settings.section.icon', () => {
        const off = ctx.slots.register(
          { name: 'settings.section.icon', id: 'fintax' },
          (owner = {}) => h(FinTaxMark, { size: owner?.size ?? 16 }),
        )
        return typeof off === 'function' ? off : () => {}
      })

      registerConversationDockSafely(ctx, t)

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'fintax', order: 38, label: () => t('nav'), locale: NS },
          (props) => h(FinTaxWorkbench, { ...props, ctx, lang: getLang(ctx), surface: 'settings' }),
        ),
      )
    } catch (err) {
      console.error('[dsh-fintax] client mount failed cleanly without crashing host:', err)
    }
  }
  return {
    name: 'fintax',
    inject,
    apply,
    activate(ctx) { return apply(ctx) },
  }
}

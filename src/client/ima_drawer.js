// In-workbench IMA Quick Source Drawer (read-only snippet moat <=160 chars, tag-stripped plain text).

import { IMA_SNIPPET_MAX_LEN } from './constants.js'
import { callApi, useLatestRequest } from './api.js'
import { Icon } from './components.js'

export function toWellFormedText(raw) {
  const s = String(raw ?? '')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1]
        i++
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      out += s[i]
    }
  }
  return out
}

export function sliceUtf16CodePointSafe(raw, maxLen) {
  const clean = toWellFormedText(raw)
  if (maxLen <= 0) return ''
  if (clean.length <= maxLen) return clean
  let end = maxLen
  const lastCode = clean.charCodeAt(end - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end--
  return clean.slice(0, end)
}

export function clampImaSnippet(raw, maxLen = IMA_SNIPPET_MAX_LEN) {
  const plain = toWellFormedText(raw).replace(/\s+/g, ' ').trim()
  if (plain.length <= maxLen) return plain
  return `${sliceUtf16CodePointSafe(plain, Math.max(0, maxLen - 1))}…`
}

export function sanitizeImaDisplayText(raw) {
  return toWellFormedText(raw)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9:-]*(?:(?:\s+[^<>]*?)?\/?|\/)>/gi, '')
    .replace(/(?:https?:\/\/|ftp:\/\/|mailto:|www\.)\S+/gi, '')
    .replace(/(?<!:)\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[/:?#][^\s"'<>)]*)?/gi, '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function ImaQuickDrawer({ open, initialQuery, status, t, isZh, onClose, onGoSettings, onCopyText, copiedKey, onSendToChat }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [payload, setPayload] = useState(null)
  const [startSearch, invalidateSearch] = useLatestRequest()

  const runSearch = useCallback(async (rawQuery) => {
    const q = String(rawQuery ?? '').trim()
    if (!q) return
    const req = startSearch()
    setBusy(true)
    setErr('')
    try {
      const res = await callApi('/ima-quick', {
        method: 'POST',
        signal: req.signal,
        body: JSON.stringify({ query: q, kbId: status?.defaultKbId || undefined, limit: 6 }),
      })
      if (req.isCurrent()) setPayload(res)
    } catch (e) {
      if (req.isCurrent()) setErr(e.message || (isZh ? 'IMA 轻检索失败' : 'IMA quick search failed'))
    } finally {
      if (req.isCurrent()) setBusy(false)
    }
  }, [startSearch, status?.defaultKbId, isZh])

  useEffect(() => {
    if (!open) {
      invalidateSearch()
      return
    }
    const q = String(initialQuery || '').trim()
    setQuery(q)
    setErr('')
    if (q) runSearch(q)
    else setPayload(null)
  }, [open, initialQuery, runSearch, invalidateSearch])

  if (!open) return null

  const hits = Array.isArray(payload?.hits) ? payload.hits.slice(0, 8) : []
  const unconfigured = payload?.configured === false || (!payload && status && !status.configured && !status.loading)
  const quickChips = isZh
    ? ['欧盟2欧', 'FIOR', '810号令', '拆单', 'DAC7', '1099-K']
    : ['EU EUR 2', 'FIOR', 'DAC7', '1099-K', '9810', 'IOSS']

  const buildFollowUpPrompt = (hit) => {
    const safeTitle = sliceUtf16CodePointSafe(hit?.title || query || '', 80)
    const safeFolder = sliceUtf16CodePointSafe(hit?.folderPath || '', 80)
    const safeQuery = sliceUtf16CodePointSafe(query || '', 120)
    return isZh
      ? `请结合我的 IMA 财税知识库出处《${safeTitle}》${safeFolder ? `（目录：${safeFolder}）` : ''}，针对「${safeQuery}」给出适用边界、现行文号与操作核对清单。`
      : `Using IMA tax citation "${safeTitle}"${safeFolder ? ` (${safeFolder})` : ''}, explain applicable rules, thresholds, and compliance steps for "${safeQuery}".`
  }

  return h(
    'div',
    { className: 'ftx-drawer-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.imaDrawerTitle, onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
    h(
      'aside',
      { className: 'ftx-drawer' },
      h(
        'div',
        { className: 'ftx-inst-head', style: { borderBottom: '1px solid var(--ftx-line)', paddingBottom: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } }, h(Icon, { kind: 'book', size: 16 }), h('span', null, t.imaDrawerTitle)),
        h('button', { type: 'button', className: 'ftx-btn-sm', onClick: onClose, 'aria-label': t.imaDrawerClose }, h(Icon, { kind: 'close', size: 13 })),
      ),
      h('div', { style: { fontSize: 11.5, color: 'var(--ftx-mut)', lineHeight: 1.45 } }, t.imaDrawerSub),
      h(
        'div',
        { style: { display: 'flex', gap: 6 } },
        h('input', {
          type: 'text',
          className: 'ftx-input',
          style: { flex: 1 },
          value: query,
          placeholder: t.imaDrawerPlaceholder,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') runSearch(query) },
        }),
        h('button', { type: 'button', className: 'ftx-btn-sm on', disabled: busy || !query.trim(), onClick: () => runSearch(query) }, busy ? t.imaDrawerSearching : t.imaDrawerSearch),
      ),
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
        ...quickChips.map((chip) =>
          h('button', { key: chip, type: 'button', className: 'ftx-btn-sm', style: { fontSize: 11, padding: '2px 7px' }, onClick: () => { setQuery(chip); runSearch(chip) } }, chip),
        ),
      ),
      err && h('div', { className: 'ftx-gap' }, h('i', { className: 'att' }, '!'), h('span', null, err)),
      unconfigured
        ? h(
            'div',
            { className: 'ftx-panel', style: { padding: '14px 16px', gap: 10 } },
            h('div', { style: { fontSize: 12.5, lineHeight: 1.55, color: 'var(--ftx-ink)' } }, payload?.message || t.imaDrawerUnconfigured),
            h('button', { type: 'button', className: 'ftx-act pri', style: { height: 36 }, onClick: () => { onClose(); onGoSettings() } }, t.imaDrawerGoSettings),
          )
        : busy
          ? h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', padding: '12px 2px' } }, t.imaDrawerSearching)
          : payload && hits.length === 0
            ? h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', padding: '10px 2px', lineHeight: 1.5 } }, sanitizeImaDisplayText(payload.message) || t.imaDrawerEmpty)
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
                payload?.usedFallback && Array.isArray(payload.fallbackTerms) && payload.fallbackTerms.length > 0 &&
                  h('div', { style: { fontSize: 11, color: 'var(--ftx-mut)' } }, `短词回退检索：${payload.fallbackTerms.join(' / ')}`),
                ...hits.map((hit, idx) => {
                  const titleText = sanitizeImaDisplayText(hit.title) || (isZh ? '未命名文档' : 'Untitled')
                  const folderText = sanitizeImaDisplayText(hit.folderPath || '')
                  const snippetText = clampImaSnippet(sanitizeImaDisplayText(hit.snippet), IMA_SNIPPET_MAX_LEN)
                  const copyKey = `ima-drawer-${idx}`
                  const prompt = buildFollowUpPrompt({ title: titleText, folderPath: folderText })
                  return h(
                    'article',
                    { key: `ima-hit-${idx}`, className: 'ftx-drawer-hit' },
                    h('div', { style: { fontWeight: 700, fontSize: 13, lineHeight: 1.4 } }, titleText),
                    folderText && h('div', { className: 'ftx-mono', style: { fontSize: 11, color: 'var(--ftx-mut)' } }, folderText),
                    h('div', { className: 'ftx-drawer-snippet', style: { fontSize: 12, lineHeight: 1.5, color: 'var(--ftx-ink)' } }, snippetText),
                    h(
                      'div',
                      { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2, alignItems: 'center' } },
                      h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => onCopyText(copyKey, prompt) }, copiedKey === copyKey ? t.copied : t.imaDrawerCopyAsk),
                      typeof onSendToChat === 'function' &&
                        h('button', { type: 'button', className: 'ftx-btn-sm on', onClick: () => { onSendToChat(prompt); onClose() } }, t.imaDrawerAskInChat),
                    ),
                  )
                }),
              ),
      payload?.disclaimer &&
        h('div', { style: { marginTop: 'auto', paddingTop: 10, borderTop: '1px solid var(--ftx-line)', fontSize: 11, color: 'var(--ftx-mut)', lineHeight: 1.45 } }, sanitizeImaDisplayText(payload.disclaimer)),
    ),
  )
}

// Settings tab: Tencent IMA OpenAPI credentials, default KB binding, and passive dsh-market Update API v1 check.

import { CLIENT_VERSION } from './constants.js'
import { callApi, probeMarketUpdate } from './api.js'

export function SettingsTab({ t, isZh, status, refreshStatus, marketUpdate, onUpdateProbe }) {
  const [clientId, setClientId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [manualKbId, setManualKbId] = useState('')
  const [kbs, setKbs] = useState([])
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [probingUpdate, setProbingUpdate] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')
  const [msg, setMsg] = useState(null)

  const onSaveCreds = async () => {
    setSaving(true); setMsg(null)
    try {
      const data = await callApi('/credentials', { method: 'POST', body: JSON.stringify({ clientId, apiKey }) })
      setClientId(''); setApiKey('')
      setMsg({ ok: true, text: t.savedOk })
      await refreshStatus(data)
    } catch (err) { setMsg({ ok: false, text: err.message }) } finally { setSaving(false) }
  }

  const onClearCreds = async () => {
    setSaving(true); setMsg(null)
    try {
      const data = await callApi('/credentials', { method: 'DELETE' })
      setKbs([]); setMsg({ ok: true, text: t.clearedOk })
      await refreshStatus(data)
    } catch (err) { setMsg({ ok: false, text: err.message }) } finally { setSaving(false) }
  }

  const onTestAndLoadKbs = async () => {
    setTesting(true); setMsg(null)
    try {
      if (clientId.trim() || apiKey.trim()) {
        await callApi('/credentials', { method: 'POST', body: JSON.stringify({ clientId, apiKey }) })
        setClientId(''); setApiKey(''); await refreshStatus()
      }
      const data = await callApi('/kbs?refresh=1')
      setKbs(Array.isArray(data.kbs) ? data.kbs : [])
      setMsg({ ok: true, text: `连接成功，共拉取 ${data.kbs?.length || 0} 个 IMA 知识库` })
    } catch (err) { setMsg({ ok: false, text: err.message }) } finally { setTesting(false) }
  }

  const onBindKb = async (kbId, kbName) => {
    setMsg(null)
    try {
      const data = await callApi('/settings', { method: 'POST', body: JSON.stringify({ defaultKbId: kbId, defaultKbName: kbName }) })
      setManualKbId('')
      setMsg({ ok: true, text: kbId ? `${t.kbBoundOk}：${kbName || kbId}` : '已取消默认知识库绑定' })
      await refreshStatus(data)
    } catch (err) { setMsg({ ok: false, text: err.message }) }
  }

  const onCheckMarketUpdate = async () => {
    setProbingUpdate(true)
    setUpdateMsg('')
    try {
      const ver = status?.version || CLIENT_VERSION
      const res = await probeMarketUpdate(ver)
      if (typeof onUpdateProbe === 'function') onUpdateProbe(res)
      if (!res) setUpdateMsg(isZh ? '当前宿主未启用 dsh-market Update API v1（不影响离线功能）' : 'dsh-market Update API v1 not available on this host')
      else if (res.hasUpdate) setUpdateMsg(isZh ? `检测到新版本 v${res.latestVersion}（当前 v${ver}），可在 DSH 插件市场一键更新` : `New version v${res.latestVersion} available (current v${ver})`)
      else if (!res.latestVersion) setUpdateMsg(isZh ? '已连接 dsh-market Update API v1，但暂未返回 dsh-fintax 版本目录' : 'Connected to dsh-market Update API v1, but no dsh-fintax version entry was returned')
      else setUpdateMsg(isZh ? `当前已是最新版本 v${ver}` : `Already on latest version v${ver}`)
    } finally {
      setProbingUpdate(false)
    }
  }

  const verText = status?.version || CLIENT_VERSION
  const channelsCount = status?.supportedChannels || 17
  const enginesCount = status?.calcEngineCount || 14

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
    h(
      'section',
      { className: 'ftx-panel' },
      h('div', { className: 'ftx-inst-head' }, h('span', null, t.credTitle), h('small', null, 'READ-ONLY / 0O600')),
      h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', lineHeight: 1.5 } }, t.credDesc),
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } }, h('label', { style: { fontSize: 12, fontWeight: 650, color: 'var(--ftx-mut)' } }, t.cidLabel), h('input', { type: 'password', autoComplete: 'off', className: 'ftx-input', value: clientId, placeholder: status.clientIdSet ? t.savedPlaceholder : t.emptyCidPlaceholder, onChange: (e) => setClientId(e.target.value) })),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } }, h('label', { style: { fontSize: 12, fontWeight: 650, color: 'var(--ftx-mut)' } }, t.keyLabel), h('input', { type: 'password', autoComplete: 'off', className: 'ftx-input', value: apiKey, placeholder: status.apiKeySet ? t.savedPlaceholder : t.emptyKeyPlaceholder, onChange: (e) => setApiKey(e.target.value) })),
      ),
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
        h('button', { type: 'button', className: 'ftx-act pri', style: { height: 38 }, disabled: saving || (!clientId.trim() && !apiKey.trim()), onClick: onSaveCreds }, saving ? t.savingBtn : t.saveBtn),
        h('button', { type: 'button', className: 'ftx-act', style: { height: 38 }, disabled: testing, onClick: onTestAndLoadKbs }, testing ? t.testingBtn : t.testBtn),
        status.configured && !status.envOverride && h('button', { type: 'button', className: 'ftx-btn-sm danger', style: { height: 38, padding: '0 14px' }, disabled: saving, onClick: onClearCreds }, t.clearBtn),
      ),
      msg && h('div', { style: { fontSize: 12.8, fontWeight: 700, color: msg.ok ? 'var(--ftx-ok)' : 'var(--ftx-orange)' } }, msg.text),
    ),
    h(
      'section',
      { className: 'ftx-panel' },
      h('div', { className: 'ftx-inst-head' }, h('span', null, t.kbTitle), h('small', null, 'DEFAULT KB')),
      h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)', lineHeight: 1.5 } }, t.kbDesc),
      kbs.length > 0
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            ...kbs.map((kb) => {
              const isDef = status.defaultKbId && status.defaultKbId === kb.id
              return h(
                'div',
                { key: kb.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 4, border: `1px solid ${isDef ? 'var(--ftx-ink)' : 'var(--ftx-line)'}`, background: 'var(--ftx-paper)' } },
                h('div', null, h('div', { style: { fontSize: 13.5, fontWeight: 700 } }, kb.name), h('div', { className: 'ftx-mono', style: { fontSize: 11.5, color: 'var(--ftx-mut)' } }, `ID: ${kb.id}${kb.count ? ` · ${kb.count} 篇` : ''}`)),
                isDef ? h('span', { className: 'ftx-kb-pill' }, h('span', { className: 'ftx-kb-dot', style: { background: 'var(--ftx-ok)' } }), t.kbCurrentBadge) : h('button', { type: 'button', className: 'ftx-btn-sm', onClick: () => onBindKb(kb.id, kb.name) }, t.kbSetDefault),
              )
            }),
          )
        : h('div', { style: { fontSize: 12.5, color: 'var(--ftx-mut)' } }, t.kbEmptyHint),
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', borderTop: '1px solid var(--ftx-line)', paddingTop: 12 } },
        h('input', { type: 'text', className: 'ftx-input', style: { flex: '1 1 180px', minWidth: 0 }, value: manualKbId, placeholder: t.kbManualPlaceholder, onChange: (e) => setManualKbId(e.target.value) }),
        h('button', { type: 'button', className: 'ftx-btn-sm', style: { height: 34, padding: '0 14px' }, disabled: !manualKbId.trim(), onClick: () => onBindKb(manualKbId.trim(), '') }, t.kbSaveManual),
        status.defaultKbId && status.defaultKbSource !== 'env' && h('button', { type: 'button', className: 'ftx-btn-sm danger', style: { height: 34, padding: '0 14px' }, onClick: () => onBindKb('', '') }, t.kbClearDefault),
      ),
    ),
    h(
      'section',
      { className: 'ftx-panel' },
      h('div', { className: 'ftx-inst-head' }, h('span', null, isZh ? '3. 插件版本与 DSH 生态探测' : '3. Version & DSH Ecosystem'), h('small', null, 'UPDATE API V1')),
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 12.5, color: 'var(--ftx-mut)' } },
        h('span', { className: 'ftx-mono', style: { color: 'var(--ftx-ink)', fontWeight: 700 } }, `dsh-fintax v${verText}`),
        h('span', null, isZh ? `${channelsCount} 通道 + 银行回单 · ${enginesCount} 算税引擎 · 零外部依赖` : `${channelsCount} channels + bank receipts · ${enginesCount} tax engines · zero deps`),
        marketUpdate?.hasUpdate && h('span', { className: 'ftx-upd-pill' }, `${t.updateAvailable}: v${marketUpdate.latestVersion}`),
      ),
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } },
        h('button', { type: 'button', className: 'ftx-btn-sm', disabled: probingUpdate, onClick: onCheckMarketUpdate }, probingUpdate ? (isZh ? '探测中…' : 'Checking…') : (isZh ? '检查 dsh-market 更新' : 'Check dsh-market updates')),
        updateMsg && h('span', { style: { fontSize: 12, color: marketUpdate?.hasUpdate ? 'var(--ftx-orange)' : 'var(--ftx-mut)' } }, updateMsg),
      ),
    ),
  )
}

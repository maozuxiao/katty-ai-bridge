/**
 * Katty AI Bridge — 选项页逻辑
 *
 * 以 ES module 加载，可直接 import shared/providers.js，避免预设清单在两处各存一份。
 */

import { PROVIDER_PRESETS, findPreset, originPatternFor, matchOrigin } from './shared/providers.js'

const $ = (id) => document.getElementById(id)
const CUSTOM_ID = '__custom__'

let currentId = null

// ---------------------------------------------------------------- 工具

function showStatus(kind, text) {
  const el = $('status')
  el.className = 'status show ' + kind
  el.textContent = text
  clearTimeout(showStatus._t)
  showStatus._t = setTimeout(() => { el.className = 'status' }, 8000)
}

function badge(kind, text) {
  return `<span class="badge ${kind}"><span class="dot"></span>${text}</span>`
}

async function getStore() {
  const got = await chrome.storage.local.get([
    'providers', 'prefs', 'allowlist', 'pendingOrigins', 'stats'
  ])
  return {
    providers: got.providers || {},
    prefs: got.prefs || {},
    allowlist: got.allowlist || [],
    pendingOrigins: got.pendingOrigins || [],
    stats: got.stats || { requests: 0, inputTokens: 0, outputTokens: 0 }
  }
}

// ---------------------------------------------------------------- 供应商表单

function fillProviderForm(id, store) {
  currentId = id
  const isCustom = id === CUSTOM_ID
  const preset = findPreset(id)
  const saved = store.providers[id]

  $('customNameField').hidden = !isCustom
  $('baseUrl').readOnly = !isCustom

  if (isCustom) {
    $('customName').value = saved?.name || ''
    $('baseUrl').value = saved?.baseUrl || 'https://'
    $('apiKey').value = saved?.apiKey || ''
    $('model').value = saved?.defaultModel || ''
    fillModelPresets(saved?.models || [])
    $('providerHint').textContent = '自定义 OpenAI 兼容端点，需自行确认地址与模型名。'
  } else if (preset) {
    $('baseUrl').value = preset.baseUrl
    $('apiKey').value = saved?.apiKey || ''
    $('model').value = saved?.defaultModel || preset.defaultModel
    fillModelPresets(saved?.models || preset.suggestedModels || [])
    const corsText = preset.cors === true
      ? '开放 CORS，未装扩展可直连'
      : preset.cors === false
        ? (preset.unsupported ? '协议不兼容，本扩展暂不支持' : '未开放 CORS，必须经由扩展')
        : 'CORS 支持未知'
    $('providerHint').innerHTML = `${preset.corsNote ? preset.corsNote + ' ' : ''}${badge(
      preset.unsupported ? 'err' : preset.cors === true ? 'ok' : preset.cors === false ? 'warn' : 'warn',
      corsText
    )}`
  }

  $('apiKey').disabled = !!preset && preset.requiresKey === false
  if ($('apiKey').disabled) $('apiKey').value = ''

  refreshPermTag()
}

function fillModelPresets(models) {
  const sel = $('modelPreset')
  sel.innerHTML = ''
  const ph = document.createElement('option')
  ph.textContent = models.length ? '选择预设模型…' : '暂无预设模型'
  ph.value = ''
  sel.appendChild(ph)
  for (const m of models) {
    const o = document.createElement('option')
    o.value = m
    o.textContent = m
    sel.appendChild(o)
  }
}

async function refreshPermTag() {
  const pattern = originPatternFor($('baseUrl').value)
  if (!pattern) {
    $('permTag').innerHTML = badge('err', '地址无效')
    return false
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] })
  $('permTag').innerHTML = granted
    ? badge('ok', '跨域已授权')
    : badge('warn', '未授权跨域')
  return granted
}

// ---------------------------------------------------------------- 保存 / 授权 / 测试

async function saveProvider() {
  const store = await getStore()
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '')
  if (!baseUrl) return showStatus('err', '请填写 API 地址。')

  let id = currentId
  if (id === CUSTOM_ID) {
    id = 'custom:' + baseUrl
  }

  const preset = findPreset(id)
  const existing = store.providers[id] || {}

  store.providers[id] = Object.assign({}, existing, {
    id,
    name: id.startsWith('custom:') ? ($('customName').value.trim() || baseUrl) : (preset?.name || id),
    baseUrl,
    apiKey: $('apiKey').value.trim(),
    defaultModel: $('model').value.trim(),
    models: Array.from($('modelPreset').options).map(o => o.value).filter(Boolean),
    requiresKey: preset ? preset.requiresKey !== false : true,
    unsupported: preset?.unsupported || false,
    custom: id.startsWith('custom:')
  })

  store.prefs.lastProviderId = id
  if ($('model').value.trim()) store.prefs.lastModelId = $('model').value.trim()

  await chrome.storage.local.set({ providers: store.providers, prefs: store.prefs })

  // 自定义项保存后要在下拉里保留，避免再次选中时又变回空白
  await rebuildProviderSelect(id)
  showStatus('ok', '已保存。回到页面刷新后生效。')
}

async function grantPermission() {
  const pattern = originPatternFor($('baseUrl').value)
  if (!pattern) return showStatus('err', 'API 地址无效，无法授权。')
  const ok = await chrome.permissions.request({ origins: [pattern] })
  await refreshPermTag()
  showStatus(ok ? 'ok' : 'err', ok ? `已授权 ${pattern}` : `已拒绝授权 ${pattern}`)
}

async function testConnection() {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '')
  const apiKey = $('apiKey').value.trim()
  const model = $('model').value.trim()
  if (!baseUrl) return showStatus('err', '请先填写 API 地址。')

  const pattern = originPatternFor(baseUrl)
  if (pattern) {
    const granted = await chrome.permissions.contains({ origins: [pattern] })
    if (!granted) return showStatus('err', `请先点击「授权跨域」授予 ${pattern} 权限。`)
  }
  if (!apiKey && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(baseUrl)) {
    return showStatus('err', '请先填写 API Key。')
  }

  showStatus('info', '正在测试…')
  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
      ),
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        stream: false,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    if (res.ok) {
      showStatus('ok', `连接成功（HTTP ${res.status}）。模型「${model}」可用。`)
    } else {
      const text = await res.text().catch(() => '')
      let msg = `HTTP ${res.status}`
      try { msg = JSON.parse(text).error.message || msg } catch (e) { /* 保留状态码 */ }
      showStatus('err', `连接失败：${msg}`)
    }
  } catch (e) {
    showStatus('err', `连接失败：${e && e.message ? e.message : e}`)
  }
}

async function fetchModels() {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '')
  if (!baseUrl) return showStatus('err', '请先填写 API 地址。')
  const pattern = originPatternFor(baseUrl)
  if (pattern) {
    const granted = await chrome.permissions.contains({ origins: [pattern] })
    if (!granted) return showStatus('err', `请先点击「授权跨域」授予 ${pattern} 权限。`)
  }

  showStatus('info', '正在获取模型列表…')
  try {
    const res = await fetch(baseUrl + '/models', {
      headers: $('apiKey').value.trim()
        ? { Authorization: `Bearer ${$('apiKey').value.trim()}` }
        : {}
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const ids = (json.data || []).map(m => m.id).filter(Boolean).sort()
    if (!ids.length) throw new Error('返回的模型列表为空')
    fillModelPresets(ids)
    showStatus('ok', `获取到 ${ids.length} 个模型，请从中选择后保存。`)
  } catch (e) {
    showStatus('err', `获取失败：${e && e.message ? e.message : e}`)
  }
}

// ---------------------------------------------------------------- 白名单

function renderOrigins(container, list, opts) {
  container.innerHTML = ''
  if (!list.length) {
    const d = document.createElement('div')
    d.className = 'empty'
    d.textContent = opts.emptyText
    container.appendChild(d)
    return
  }
  list.forEach((origin, index) => {
    const row = document.createElement('div')
    row.className = 'list-item' + (opts.pending ? ' pending' : '')

    const span = document.createElement('span')
    span.className = 'origin'
    span.textContent = origin
    span.title = origin
    row.appendChild(span)

    if (opts.pending) {
      const add = document.createElement('button')
      add.className = 'btn'
      add.type = 'button'
      add.textContent = '信任'
      add.addEventListener('click', () => approvePending(origin))
      row.appendChild(add)

      const deny = document.createElement('button')
      deny.className = 'btn ghost'
      deny.type = 'button'
      deny.textContent = '忽略'
      deny.addEventListener('click', () => dismissPending(origin))
      row.appendChild(deny)
    } else {
      const del = document.createElement('button')
      del.className = 'btn ghost danger'
      del.type = 'button'
      del.textContent = '移除'
      del.addEventListener('click', () => removeOrigin(index))
      row.appendChild(del)
    }

    container.appendChild(row)
  })
}

async function removeOrigin(index) {
  const store = await getStore()
  store.allowlist.splice(index, 1)
  await chrome.storage.local.set({ allowlist: store.allowlist })
  renderAllowlist(store)
}

async function approvePending(origin) {
  const store = await getStore()
  if (store.allowlist.indexOf(origin) === -1) store.allowlist.push(origin)
  const pending = store.pendingOrigins.filter(o => o !== origin)
  await chrome.storage.local.set({ allowlist: store.allowlist, pendingOrigins: pending })
  renderAllowlist(Object.assign({}, store, { pendingOrigins: pending }))
  showStatus('ok', `已信任 ${origin}`)
}

async function dismissPending(origin) {
  const store = await getStore()
  const pending = store.pendingOrigins.filter(o => o !== origin)
  await chrome.storage.local.set({ pendingOrigins: pending })
  renderAllowlist(Object.assign({}, store, { pendingOrigins: pending }))
}

function renderAllowlist(store) {
  renderOrigins($('allowList'), store.allowlist, { emptyText: '白名单为空，任何页面都无法调用。' })
  $('pendingBody').hidden = !store.pendingOrigins.length
  renderOrigins($('pendingList'), store.pendingOrigins, { pending: true, emptyText: '' })
}

// ---------------------------------------------------------------- 初始化

async function rebuildProviderSelect(selectId) {
  const store = await getStore()
  const sel = $('providerSelect')
  sel.innerHTML = ''

  const group = document.createElement('optgroup')
  group.label = '内置预设'
  for (const p of PROVIDER_PRESETS) {
    const o = document.createElement('option')
    o.value = p.id
    o.textContent = p.name + (p.unsupported ? '（暂不支持）' : '')
    group.appendChild(o)
  }
  sel.appendChild(group)

  const customs = Object.values(store.providers).filter(p => p.custom)
  if (customs.length) {
    const cg = document.createElement('optgroup')
    cg.label = '自定义'
    for (const p of customs) {
      const o = document.createElement('option')
      o.value = p.id
      o.textContent = p.name
      cg.appendChild(o)
    }
    sel.appendChild(cg)
  }

  const og = document.createElement('optgroup')
  og.label = '其他'
  const co = document.createElement('option')
  co.value = CUSTOM_ID
  co.textContent = '＋ 自定义端点…'
  og.appendChild(co)
  sel.appendChild(og)

  const target = selectId || store.prefs.lastProviderId || PROVIDER_PRESETS[0].id
  sel.value = [...sel.options].some(o => o.value === target) ? target : PROVIDER_PRESETS[0].id
  fillProviderForm(sel.value, store)
}

function renderStats(store) {
  $('stReq').textContent = store.stats.requests.toLocaleString()
  $('stIn').textContent = store.stats.inputTokens.toLocaleString()
  $('stOut').textContent = store.stats.outputTokens.toLocaleString()
}

async function init() {
  $('version').textContent = chrome.runtime.getManifest().version
  const store = await getStore()
  await rebuildProviderSelect()
  renderAllowlist(store)
  renderStats(store)

  $('providerSelect').addEventListener('change', async () => {
    fillProviderForm($('providerSelect').value, await getStore())
  })
  $('modelPreset').addEventListener('change', () => {
    if ($('modelPreset').value) $('model').value = $('modelPreset').value
  })
  $('baseUrl').addEventListener('change', refreshPermTag)
  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey')
    const toText = el.type === 'password'
    el.type = toText ? 'text' : 'password'
    $('toggleKey').textContent = toText ? '隐藏' : '显示'
  })

  $('save').addEventListener('click', saveProvider)
  $('grant').addEventListener('click', grantPermission)
  $('test').addEventListener('click', testConnection)
  $('fetchModels').addEventListener('click', fetchModels)

  $('addOrigin').addEventListener('click', async () => {
    const v = $('newOrigin').value.trim()
    if (!v) return
    const store = await getStore()
    if (store.allowlist.indexOf(v) === -1) store.allowlist.push(v)
    await chrome.storage.local.set({ allowlist: store.allowlist })
    $('newOrigin').value = ''
    renderAllowlist(store)
  })

  $('resetStats').addEventListener('click', async () => {
    await chrome.storage.local.set({ stats: { requests: 0, inputTokens: 0, outputTokens: 0 } })
    renderStats(await getStore())
  })

  // 扩展内其他标签页改了配置时同步刷新
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return
    if (changes.pendingOrigins || changes.allowlist) renderAllowlist(await getStore())
    if (changes.stats) renderStats(await getStore())
  })
}

init()

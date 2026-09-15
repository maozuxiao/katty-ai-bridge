/**
 * Katty AI Bridge — 选项页逻辑
 *
 * 以 ES module 加载，可直接 import shared/providers.js，避免预设清单在两处各存一份。
 */

import {
  PROVIDER_PRESETS,
  findPreset,
  originPatternFor,
  inferRequiresKey,
  effectiveRequiresKey,
  migrateProviderRequiresKey,
  opencodeSessionHeader,
  getOpencodeSessionId,
  providerErrorMessage,
  matchOrigin
} from './shared/providers.js'

const $ = (id) => document.getElementById(id)
const CUSTOM_ID = '__custom__'

let currentId = null
/** 用户手动拨过「需要 API Key」开关后，改地址时不再用推断值覆盖它 */
let keyRequiredTouched = false

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

/**
 * 自定义供应商有两种形态：
 *   '__custom__'        下拉框里「＋ 自定义端点…」，尚未保存
 *   'custom:<baseUrl>'  已保存的自定义条目（saveProvider 生成的 ID）
 * 两者都要走自定义分支，否则切换到一个已保存的自定义条目时
 * 两个回填分支都不命中，表单会残留上一个供应商的 API Key（甚至被保存覆盖）。
 */
function isCustomId(id) {
  return id === CUSTOM_ID || String(id).indexOf('custom:') === 0
}

/** 免 Key 端点禁用并清空 Key 输入框（与内置预设 ollama 的原有表现一致） */
function syncKeyField() {
  const required = $('keyRequired').checked
  $('apiKey').disabled = !required
  if (!required) $('apiKey').value = ''
}

function fillProviderForm(id, store) {
  currentId = id
  const isCustom = isCustomId(id)
  const preset = findPreset(id)
  const saved = store.providers[id]

  $('customNameField').hidden = !isCustom
  $('baseUrl').readOnly = !isCustom

  if (isCustom) {
    // 保存时 name 为空会回落到 baseUrl，这里还原成空，避免用户以为真填了这个名字
    $('customName').value = saved?.name && saved.name !== saved.baseUrl ? saved.name : ''
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

  // 取值优先级：用户显式拨过的开关 > 预设值 > 按地址自动推断（本地/内网网关免 Key）。
  // 注意不能直接信 saved.requiresKey——1.0.1 及以前给自定义端点写死的 true 并非用户选择。
  keyRequiredTouched = false
  $('keyRequired').checked = effectiveRequiresKey(saved || { baseUrl: $('baseUrl').value, custom: isCustom }, preset)
  // 内置预设的鉴权方式是已知事实，不给改；只有自定义端点允许覆盖
  $('keyRequired').disabled = !isCustom
  syncKeyField()

  // 只有已保存的自定义条目可删除；内置预设与未保存的新建项不给删除入口
  $('deleteProvider').hidden = !(String(id).indexOf('custom:') === 0 && !!saved)

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
  if (isCustomId(id)) {
    // 自定义条目的 ID 由 baseUrl 决定，改了地址就是另一个条目：
    // 这里删掉旧条目，避免留下孤儿存档继续占用下拉框
    if (id !== CUSTOM_ID && id !== 'custom:' + baseUrl) delete store.providers[id]
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
    requiresKey: $('keyRequired').checked,
    // 只有用户亲手拨过开关才落这个标记；否则下次打开仍按地址重新推断，
    // 这样以后调整推断规则时，未被显式覆盖的条目能自动跟着更新
    requiresKeyExplicit: keyRequiredTouched || !!existing.requiresKeyExplicit,
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

async function deleteProvider() {
  const id = currentId
  if (String(id).indexOf('custom:') !== 0) return showStatus('err', '内置预设供应商不可删除。')

  const store = await getStore()
  if (!store.providers[id]) return showStatus('err', '该供应商尚未保存，无需删除。')
  const name = store.providers[id].name || id

  if (!confirm(`确定删除自定义供应商「${name}」？\n其保存的 API Key 与模型配置将一并移除，此操作不可撤销。`)) {
    return
  }

  delete store.providers[id]

  // 删掉的正好是当前选中项时，回落到首个内置预设，避免 prefs 指向不存在的条目
  if (store.prefs.lastProviderId === id) {
    store.prefs.lastProviderId = PROVIDER_PRESETS[0].id
    store.prefs.lastModelId = ''
  }

  await chrome.storage.local.set({ providers: store.providers, prefs: store.prefs })
  await rebuildProviderSelect(store.prefs.lastProviderId)
  showStatus('ok', `已删除自定义供应商「${name}」。`)
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
  // 是否需要 Key 以开关为准（默认值由地址自动推断），不再按地址正则硬拦：
  // 本地 / 内网网关（如 codebuddy http://127.0.0.1:8787/v1）本就无需鉴权
  if ($('keyRequired').checked && !apiKey) {
    return showStatus('err', '请先填写 API Key。')
  }

  showStatus('info', '正在测试…')
  try {
    // OpenCode（Go / Zen）网关要求带 x-opencode-session，否则返回 MissingSessionID
    const sessionId = await getOpencodeSessionId()
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        opencodeSessionHeader(baseUrl, sessionId) || {},
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
      showStatus('err', `连接失败：${providerErrorMessage(text, `HTTP ${res.status}`)}`)
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
    const sessionId = await getOpencodeSessionId()
    const auth = $('apiKey').value.trim()
    const res = await fetch(baseUrl + '/models', {
      headers: Object.assign(
        opencodeSessionHeader(baseUrl, sessionId) || {},
        auth ? { Authorization: `Bearer ${auth}` } : {}
      )
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
  // 先修正旧版本给自定义端点写死的 requiresKey：content script 与 popup 只读存储，
  // 不跑判定逻辑，数据不改它们的状态就一直是错的
  await migrateProviderRequiresKey()
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
  // 改地址时按新地址重新推断；用户手动拨过开关则以用户为准
  $('baseUrl').addEventListener('input', () => {
    if (keyRequiredTouched) return
    $('keyRequired').checked = inferRequiresKey($('baseUrl').value)
    syncKeyField()
  })
  $('keyRequired').addEventListener('change', () => {
    keyRequiredTouched = true
    syncKeyField()
  })
  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey')
    const toText = el.type === 'password'
    el.type = toText ? 'text' : 'password'
    $('toggleKey').textContent = toText ? '隐藏' : '显示'
  })

  $('save').addEventListener('click', saveProvider)
  $('deleteProvider').addEventListener('click', deleteProvider)
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

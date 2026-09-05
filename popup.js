/**
 * Katty AI Bridge — 弹出面板逻辑
 */

const $ = (id) => document.getElementById(id)

function flash(kind, text) {
  const el = $('pStatus')
  el.className = 'status show ' + kind
  el.textContent = text
  clearTimeout(flash._t)
  flash._t = setTimeout(() => { el.className = 'status' }, 3000)
}

function badgeHtml(kind, text) {
  return `<span class="badge ${kind}"><span class="dot"></span>${text}</span>`
}

async function init() {
  $('version').textContent = chrome.runtime.getManifest().version

  const got = await chrome.storage.local.get(['providers', 'prefs', 'stats'])
  const providers = got.providers || {}
  const prefs = got.prefs || {}
  const stats = got.stats || { requests: 0 }

  const p = prefs.lastProviderId ? providers[prefs.lastProviderId] : null

  $('pProvider').textContent = p ? (p.name || prefs.lastProviderId) : '未配置'
  $('pModel').textContent = prefs.lastModelId || (p ? p.defaultModel : '') || '—'

  if (!p) {
    $('pKey').innerHTML = badgeHtml('err', '未配置供应商')
  } else if (p.requiresKey === false) {
    $('pKey').innerHTML = badgeHtml('ok', '无需 Key')
  } else {
    $('pKey').innerHTML = p.apiKey ? badgeHtml('ok', '已填写') : badgeHtml('err', '未填写')
  }

  $('pReq').textContent = stats.requests.toLocaleString()

  $('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage()
  })

  $('copySdk').addEventListener('click', async () => {
    try {
      const url = chrome.runtime.getURL('sdk/ai-bridge.js')
      const text = await (await fetch(url)).text()
      await navigator.clipboard.writeText(text)
      flash('ok', 'SDK 源码已复制，粘贴为 ai-bridge.js 即可。')
    } catch (e) {
      flash('err', `复制失败：${e && e.message ? e.message : e}`)
    }
  })
}

init()

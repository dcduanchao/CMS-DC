import dns from 'node:dns/promises'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import ipaddr from 'ipaddr.js'
import { ResponseCache } from './cache.js'

// Reject special-use networks, including IPv4-mapped IPv6 and transition ranges.
export function publicAddress(ip) {
  if (!net.isIP(ip)) return false
  const parsed = ipaddr.parse(ip)
  if (parsed.kind() === 'ipv6') {
    if (parsed.isIPv4MappedAddress()) return false
    if (!parsed.match(ipaddr.parseCIDR('2000::/3'))) return false
    return !['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some(cidr => parsed.match(ipaddr.parseCIDR(cidr)))
  }
  const [a,b,c] = ip.split('.').map(Number)
  return parsed.range() === 'unicast' && !(a === 192 && (b === 0 || (b === 88 && c === 99)))
}
let active = 0
const waiters = []
async function acquire() { if (active < 8) { active++; return } if (waiters.length >= 64) throw new Error('上游请求繁忙'); await new Promise((resolve, reject) => { const timer = setTimeout(() => { const i = waiters.indexOf(next); if (i >= 0) waiters.splice(i, 1); reject(new Error('上游请求繁忙')) }, 5000); const next = () => { clearTimeout(timer); resolve() }; waiters.push(next) }) }
function release() { const next = waiters.shift(); if (next) next(); else active-- }
export function pinnedLookup(addresses) {
  return (_hostname, options, callback) => options.all
    ? callback(null, addresses.map(({address,family}) => ({address,family})))
    : callback(null, addresses[0].address, addresses[0].family)
}
async function proxyTunnel(proxyUrl, address, port) {
  const proxy = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const headers = {}
    if (proxy.username || proxy.password) headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
    const authority = net.isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`
    const req = http.request({ hostname: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: authority, headers })
    const timer = setTimeout(() => req.destroy(new Error('代理连接超时')), 8000)
    req.on('connect', (res, socket, head) => {
      clearTimeout(timer)
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`代理返回 HTTP ${res.statusCode}`)) }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    req.on('error', error => { clearTimeout(timer); reject(error) })
    req.end()
  })
}
async function fetchSafe(url, redirects = 0, proxyUrl = '', textMode = false) {
  const u = new URL(url)
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('仅支持不含用户信息的 HTTP(S) 地址')
  const hostname = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname
  const addresses = await Promise.race([dns.lookup(hostname, { all: true, verbatim: true }), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('DNS 解析超时')), 5000); t.unref() })])
  if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw new Error('源地址解析到禁止访问的网络')
  let agent
  if (proxyUrl) {
    const socket = await proxyTunnel(proxyUrl, addresses[0].address, Number(u.port || (u.protocol === 'https:' ? 443 : 80)))
    agent = new (u.protocol === 'https:' ? https.Agent : http.Agent)({ keepAlive: false })
    agent.createConnection = () => u.protocol === 'https:' ? tls.connect({ socket, servername: net.isIP(hostname) ? undefined : hostname }) : socket
  }
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).get(u, { agent, lookup: pinnedLookup(addresses), autoSelectFamily: true, headers: { accept: textMode ? '*/*' : 'application/json', 'user-agent': 'LightCinema/1.0' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) { res.resume(); if (!res.headers.location || redirects >= 3) return reject(new Error('上游重定向无效或过多')); let target; try { target = new URL(res.headers.location, u).href } catch { return reject(new Error('上游重定向地址无效')) } return resolve(fetchSafe(target, redirects + 1, proxyUrl, textMode)) }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`上游返回 HTTP ${res.statusCode}`)) }
      let size = 0; const chunks = []
      res.on('data', chunk => { size += chunk.length; if (size > (textMode ? 1024 * 1024 : 2 * 1024 * 1024)) req.destroy(new Error('上游响应过大')); else chunks.push(chunk) })
      res.on('end', () => { if (textMode) return resolve(Buffer.concat(chunks).toString('utf8')); try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || typeof data !== 'object' || (!Array.isArray(data.list) && !Array.isArray(data.class))) throw new Error(); resolve(data) } catch { reject(new Error('上游未返回有效的苹果 CMS JSON')) } })
      res.on('error', reject)
    })
    const deadline = setTimeout(() => req.destroy(new Error('上游请求超时')), 8000)
    req.on('close', () => clearTimeout(deadline))
    req.setTimeout(8000, () => req.destroy(new Error('上游请求超时')))
    req.on('error', reject)
  })
}
export async function fetchPlaylist(url, proxyUrl = '') {
  await acquire()
  try { return await fetchSafe(url, 0, proxyUrl, true) } finally { release() }
}
const cache = new ResponseCache()
export async function upstream(base, params, useCache = true, logger, proxyUrl = '') {
  const url = new URL(base)
  // The source URL may include authentication parameters, but request-specific
  // filters must never survive from that URL into another operation.
  for (const key of ['ac', 'pg', 't', 'wd', 'ids']) url.searchParams.delete(key)
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
  const key = url.href
  const request = { url: url.href, params, proxy: !!proxyUrl }
  logger?.info({ upstream: request }, '影视源请求')
  const started = Date.now()
  try {
    const cacheKey = `${proxyUrl}\n${key}`
    const hit = useCache ? cache.get(cacheKey) : undefined
    if (hit !== undefined) {
      logger?.info({ upstream: request, cached: true, durationMs: Date.now() - started, result: hit }, '影视源响应')
      return hit
    }
    await acquire()
    try {
      const data = await fetchSafe(key, 0, proxyUrl)
      if (useCache) cache.set(cacheKey, data)
      logger?.info({ upstream: request, cached: false, durationMs: Date.now() - started, result: data }, '影视源响应')
      return data
    } finally { release() }
  } catch (error) {
    logger?.error({ upstream: request, durationMs: Date.now() - started, error: error.message }, '影视源请求失败')
    throw error
  }
}
export function categories(data) { return (Array.isArray(data.class) ? data.class : []).filter(x => x && x.type_id != null && String(x.type_name ?? '').trim()).map(x => ({ id: String(x.type_id), name: String(x.type_name) })) }
export function video(v) { return { id: String(v.vod_id ?? ''), name: String(v.vod_name ?? ''), poster: String(v.vod_pic ?? ''), typeId: String(v.type_id ?? ''), year: String(v.vod_year ?? ''), updated: String(v.vod_time ?? ''), remarks: String(v.vod_remarks ?? '') } }
export function listing(data, sourceId, requestedPage) { const positive = x => Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : 0; const page = positive(data.page) || requestedPage; return { sourceId, page, pageCount: positive(data.pagecount) || page, total: positive(data.total), list: (Array.isArray(data.list) ? data.list : []).filter(Boolean).map(video) } }
export function detail(v) { const names = String(v.vod_play_from ?? '').split('$$$'); const groups = String(v.vod_play_url ?? '').split('$$$'); return { ...video(v), description: String(v.vod_content ?? '').replace(/<[^>]*>/g, ''), lines: groups.map((group,i) => ({ name: names[i] || `线路 ${i+1}`, episodes: group.split('#').filter(Boolean).map((entry,j) => { const pos = entry.indexOf('$'); return { name: pos < 0 ? `第 ${j+1} 集` : entry.slice(0,pos), url: pos < 0 ? entry : entry.slice(pos+1) } }) })).filter(x => x.episodes.length) } }

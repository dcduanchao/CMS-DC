import Fastify from 'fastify'
import { registerLive } from './live.js'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { upstream as fetchUpstream, fetchPlaylist, categories, listing, detail } from './upstream.js'

// Node preserves variables already provided by the process environment.
try { process.loadEnvFile(path.resolve('.env')) } catch (error) { if (error.code !== 'ENOENT') throw error }

const app = Fastify({ logger: true, bodyLimit: 16384, trustProxy: false })
const upstream = (base, params, useCache) => fetchUpstream(base, params, useCache, app.log, config.proxy?.enabled ? config.proxy.url : '')
await app.register(cookie)
const dataDir = path.resolve(process.env.DATA_DIR || './data'); await mkdir(dataDir, { recursive: true })
const configFile = path.join(dataDir, 'config.json')
let config
try { config = JSON.parse(await readFile(configFile, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e; config = { sources: [] } }
if (!Array.isArray(config.sources) || (config.liveChannels !== undefined && !Array.isArray(config.liveChannels)) || (config.liveSources !== undefined && !Array.isArray(config.liveSources))) throw new Error('配置文件无效')
let writing = Promise.resolve()
async function writeConfig(next) {
  const tmp = `${configFile}.${randomUUID()}.tmp`
  try { await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(tmp, configFile) }
  finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') app.log.warn('无法清理临时配置文件') }) }
}
function updateConfig(mutate) {
  const operation = writing.then(async () => {
    const next = structuredClone(config)
    const result = mutate(next)
    await writeConfig(next)
    config = next
    return result
  })
  writing = operation.catch(() => {})
  return operation
}
const configuredPassword = process.env.ADMIN_PASSWORD
if (!config.password && !configuredPassword) throw new Error('首次启动必须设置至少 6 个字符的 ADMIN_PASSWORD')
if (configuredPassword !== undefined) {
  if (configuredPassword.length < 6) throw new Error('ADMIN_PASSWORD 必须至少 6 个字符')
  const stored = config.password ? Buffer.from(config.password.hash, 'hex') : null
  const candidate = config.password ? scryptSync(configuredPassword, config.password.salt, 64) : null
  if (!stored || stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) {
    const salt = randomBytes(16).toString('hex')
    config.password = { salt, hash: scryptSync(configuredPassword, salt, 64).toString('hex') }
    await writeConfig(config)
  }
}
const sitePassword = process.env.SITE_PASSWORD
if (!config.sitePassword && !sitePassword) throw new Error('首次启动必须设置至少 6 个字符的 SITE_PASSWORD')
if (sitePassword !== undefined) {
  if (sitePassword.length < 6) throw new Error('SITE_PASSWORD 必须至少 6 个字符')
  const stored = config.sitePassword ? Buffer.from(config.sitePassword.hash, 'hex') : null
  const candidate = config.sitePassword ? scryptSync(sitePassword, config.sitePassword.salt, 64) : null
  if (!stored || stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) {
    const salt = randomBytes(16).toString('hex')
    config.sitePassword = { salt, hash: scryptSync(sitePassword, salt, 64).toString('hex') }
    await writeConfig(config)
  }
}
const sessions = new Map(); const attempts = new Map(); const siteSessions = new Map(); const siteAttempts = new Map()
function auth(req, reply) { const session = sessions.get(req.cookies.session); if (!session || session.expires < Date.now()) { if (req.cookies.session) sessions.delete(req.cookies.session); reply.code(401).send({ error: '请先登录' }); return false } return true }
function siteAuth(req, reply) { const session = siteSessions.get(req.cookies.site_session); if (!session || session.expires < Date.now()) { if (req.cookies.site_session) siteSessions.delete(req.cookies.site_session); reply.code(401).send({ error: '请先输入访问密码' }); return false } return true }
function csrf(req, reply) { const origin = req.headers.origin; const host = req.headers.host; if (!origin || !host) { reply.code(403).send({ error: '缺少请求来源' }); return false } try { const u = new URL(origin); if (u.host !== host || !['http:', 'https:'].includes(u.protocol)) throw 0; return true } catch { reply.code(403).send({ error: '请求来源不匹配' }); return false } }
app.addHook('onRequest', async (req, reply) => {
  const pathname = req.url.split('?')[0]
  if (['POST','PATCH','DELETE'].includes(req.method) && pathname.startsWith('/api/') && !csrf(req, reply)) return reply
  if (['/api/sources','/api/categories','/api/videos','/api/search','/api/detail','/api/session','/api/live/channels','/api/live/sources'].includes(pathname) && !siteAuth(req, reply)) return reply
})
app.setErrorHandler((err, req, reply) => { req.log.error(err); if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({error:err.message}); if ((req.url.startsWith('/api/admin/sources') || req.url.startsWith('/api/admin/live')) && req.method !== 'GET') return reply.code(500).send({error:'配置保存失败，请检查存储后重试'}); return reply.code(502).send({error:'上游请求失败，请检查源配置或稍后重试'}) })
const fail = (reply, code, error) => reply.code(code).send({ error })
const source = (id) => config.sources.find(s => s.id === id && s.enabled)
const pageOf = value => Math.min(10000, Math.max(1, parseInt(value, 10) || 1))
const cleanUrl = value => { const u = new URL(String(value)); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error(); return u.href }
app.get('/api/sources', async () => config.sources.filter(s => s.enabled).map(({id,name}) => ({id,name})))
app.get('/api/session', async () => ({ ok: true }))
app.post('/api/login', async (req, reply) => {
  const ip = req.ip; const now = Date.now(); const recent = (siteAttempts.get(ip) || []).filter(t => now-t < 15*60*1000)
  if (recent.length >= 5) return fail(reply, 429, '登录尝试过多，请稍后再试')
  recent.push(now); siteAttempts.set(ip, recent)
  const supplied = scryptSync(String(req.body?.password || ''), config.sitePassword.salt, 64); const stored = Buffer.from(config.sitePassword.hash, 'hex')
  if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) return fail(reply, 401, '密码错误')
  siteAttempts.delete(ip)
  const token = randomBytes(32).toString('hex'); siteSessions.set(token, { expires: now + 12*60*60*1000 })
  reply.setCookie('site_session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', path: '/', maxAge: 43200 })
  return { ok: true }
})
async function getCategories(url, useCache = true) { let data; try { data = await upstream(url, { ac: 'list' }, useCache) } catch { data = null } if (!Array.isArray(data?.class) || !data.class.length) { try { const fallback = await upstream(url, { ac: 'videolist', pg: 1 }, useCache); if (Array.isArray(fallback.class) || !data) data = fallback } catch (error) { if (!Array.isArray(data?.class)) throw error } } return categories(data) }
async function videoData(url, params) { const data = await upstream(url, params); if (!Array.isArray(data.list)) throw new Error('上游响应缺少影片列表'); return data }
app.get('/api/categories', async (req, reply) => { const s = source(req.query.sourceId); if (!s) return fail(reply, 404, '源不可用'); return { sourceId: s.id, categories: await getCategories(s.url) } })
app.get('/api/videos', async (req, reply) => { const s = source(req.query.sourceId); if (!s) return fail(reply, 404, '源不可用'); const page = pageOf(req.query.page); return listing(await videoData(s.url, { ac: 'videolist', pg: page, t: req.query.typeId }), s.id, page) })
app.get('/api/search', async (req, reply) => {
  const wd = String(req.query.wd || '').trim().slice(0, 100); const page = pageOf(req.query.page); const current = source(req.query.sourceId)
  if (!current) return fail(reply, 404, '源不可用')
  const selected = req.query.all === '1' ? config.sources.filter(s => s.enabled) : [current]
  const results = new Array(selected.length); let next = 0
  async function worker() {
    while (next < selected.length) {
      const i = next++; const s = selected[i]
      try { results[i] = { ...listing(await videoData(s.url, { ac: 'videolist', pg: page, wd }), s.id, page), sourceName: s.name } }
      catch { results[i] = { sourceId: s.id, sourceName: s.name, error: '搜索失败', list: [], page, pageCount: page } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, selected.length) }, worker))
  return { results }
})
app.get('/api/detail', async (req, reply) => { const s = source(req.query.sourceId); if (!s) return fail(reply, 404, '源不可用'); const id = String(req.query.vodId || '').slice(0, 200); if (!id) return fail(reply, 400, '缺少影片 ID'); const data = await videoData(s.url, { ac: 'videolist', ids: id }); const v = data.list.find(x => x && String(x.vod_id) === id); if (!v) return fail(reply, 404, '未找到影片'); return { sourceId: s.id, ...detail(v) } })
app.post('/api/admin/login', async (req, reply) => { const ip = req.ip; const now = Date.now(); const a = attempts.get(ip) || []; const recent = a.filter(t => now-t < 15*60*1000); if (recent.length >= 5) return fail(reply, 429, '登录尝试过多，请稍后再试'); recent.push(now); attempts.set(ip, recent); const supplied = scryptSync(String(req.body?.password || ''), config.password.salt, 64); const stored = Buffer.from(config.password.hash, 'hex'); if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) return fail(reply, 401, '密码错误'); attempts.delete(ip); const token = randomBytes(32).toString('hex'); sessions.set(token, { expires: now + 12*60*60*1000 }); reply.setCookie('session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', path: '/', maxAge: 43200 }); return { ok: true } })
app.post('/api/admin/live/fetch-playlist', async (req, reply) => {
  if (!auth(req, reply)) return
  let url
  try { if (typeof req.body?.url !== 'string' || req.body.url.length > 4096) throw 0; url = cleanUrl(req.body.url) } catch { return fail(reply, 400, '请输入有效的 HTTP(S) 播放列表地址') }
  try { const text = await fetchPlaylist(url, config.proxy?.enabled ? config.proxy.url : ''); reply.header('Cache-Control', 'no-store'); return { text } }
  catch { return fail(reply, 502, '读取列表失败，请检查地址、网络或服务器代理设置') }
})
app.post('/api/admin/logout', async (req, reply) => { sessions.delete(req.cookies.session); reply.clearCookie('session', { path: '/' }); return { ok: true } })
app.get('/api/admin/sources', async (req, reply) => { if (!auth(req, reply)) return; return config.sources.map(({id,name,enabled,createdAt}) => ({id,name,enabled,createdAt})) })
app.get('/api/admin/sources/export', async (req, reply) => {
  if (!auth(req, reply)) return
  reply.header('Cache-Control', 'no-store')
  return config.sources.map(({name, url}) => ({name, url}))
})
app.post('/api/admin/sources/import', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
  if (!auth(req, reply)) return
  if (!Array.isArray(req.body) || req.body.length > 1000) return fail(reply, 400, '请提供不超过 1000 条影视源的 JSON 数组')
  const items = []
  for (const [i, item] of req.body.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 80 || typeof item.url !== 'string') return fail(reply, 400, `第 ${i + 1} 条源的名称或地址无效`)
    let url
    try { url = cleanUrl(item.url.trim()) } catch { return fail(reply, 400, `第 ${i + 1} 条源的地址无效，请填写 HTTP(S) 地址`) }
    items.push({ name: item.name.trim(), url })
  }
  let added = 0
  await updateConfig(next => {
    const urls = new Set(next.sources.map(s => s.url))
    for (const item of items) {
      if (urls.has(item.url)) continue
      urls.add(item.url)
      next.sources.push({ id: randomUUID(), ...item, enabled: true, createdAt: new Date().toISOString() })
      added++
    }
  })
  return { added, skipped: items.length - added }
})
app.get('/api/admin/proxy', async (req, reply) => { if (!auth(req, reply)) return; return { enabled: !!config.proxy?.enabled, configured: !!config.proxy?.url } })
app.post('/api/admin/proxy', async (req, reply) => {
  if (!auth(req, reply)) return
  if (typeof req.body?.enabled !== 'boolean' || (req.body.url != null && typeof req.body.url !== 'string')) return fail(reply, 400, '代理配置无效')
  let url = req.body.url?.trim() || config.proxy?.url || ''
  if (url) {
    try { const parsed = new URL(url); if (parsed.protocol !== 'http:' || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(); url = parsed.href }
    catch { return fail(reply, 400, '请输入有效的 HTTP 代理地址，例如 http://127.0.0.1:7890') }
  }
  if (req.body.enabled && !url) return fail(reply, 400, '请先填写代理地址')
  await updateConfig(next => { next.proxy = { enabled: req.body.enabled, url } })
  return { ok: true }
})
app.post('/api/admin/test', async (req, reply) => { if (!auth(req, reply)) return; if (req.body?.url !== undefined) return fail(reply, 400, '测试连接只接受已保存的源 ID'); const s = source(req.body?.sourceId); if (!s) return fail(reply, 404, '源不可用'); return { ok: true, categoryCount: (await getCategories(s.url, false)).length } })
app.post('/api/admin/sources', async (req, reply) => { if (!auth(req, reply)) return; let url; try { url = cleanUrl(req.body?.url) } catch { return fail(reply, 400, '请输入有效的 HTTP(S) 地址') } const name = String(req.body?.name || '').trim().slice(0, 80); if (!name) return fail(reply, 400, '请输入源名称'); if (req.body?.enabled != null && typeof req.body.enabled !== 'boolean') return fail(reply, 400, '启用状态必须是布尔值'); const s = { id: randomUUID(), name, url, enabled: req.body?.enabled !== false, createdAt: new Date().toISOString() }; await updateConfig(next => next.sources.push(s)); return { id: s.id } })
app.patch('/api/admin/sources/:id', async (req, reply) => { if (!auth(req, reply)) return; if (req.body?.enabled != null && typeof req.body.enabled !== 'boolean') return fail(reply, 400, '启用状态必须是布尔值'); await updateConfig(next => { const s = next.sources.find(x => x.id === req.params.id); if (!s) throw Object.assign(new Error('源不存在'), {statusCode:404}); let url; try { url = cleanUrl(req.body?.url ?? s.url) } catch { throw Object.assign(new Error('请输入有效的 HTTP(S) 地址'), {statusCode:400}) } const name = String(req.body?.name ?? s.name).trim().slice(0, 80); if (!name) throw Object.assign(new Error('请输入源名称'), {statusCode:400}); Object.assign(s, { name, url, enabled: req.body?.enabled ?? s.enabled }) }); return { ok: true } })
app.delete('/api/admin/sources/:id', async (req, reply) => { if (!auth(req, reply)) return; await updateConfig(next => { const i = next.sources.findIndex(x => x.id === req.params.id); if (i < 0) throw Object.assign(new Error('源不存在'), {statusCode:404}); next.sources.splice(i, 1) }); return { ok: true } })
registerLive(app, { auth, updateConfig, getConfig: () => config })
app.get('/api/health', async () => ({ ok: true }))
if (existsSync(path.resolve('dist/index.html'))) await app.register(fastifyStatic, { root: path.resolve('dist'), prefix: '/' })
await app.listen({ port: Number(process.env.PORT || 8080), host: process.env.HOST || '0.0.0.0' })

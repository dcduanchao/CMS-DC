import { randomUUID } from 'node:crypto'
import { mergeLiveChannels } from './liveGrouping.js'
const bad = message => Object.assign(new Error(message), {statusCode:400})
const missing = () => Object.assign(new Error('频道不存在'), {statusCode:404})
function channel(input, old) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('频道格式无效')
  const text = (v, label, required=true) => { if (typeof v !== 'string' || (required && !v.trim()) || v.trim().length > 80) throw bad(`${label}无效`); return v.trim() }
  const name=text(input.name,'频道名称'), group=text(input.group ?? '','分组',false)
  if (input.enabled != null && typeof input.enabled !== 'boolean') throw bad('启用状态无效')
  if (!Array.isArray(input.streams) || !input.streams.length) throw bad('每个频道至少需要 1 条线路')
  const used = new Set()
  const streams=input.streams.map(s=>{
    const name=text(s?.name,'线路名称')
    if (typeof s.url !== 'string' || s.url.trim().length > 2048) throw bad('线路地址无效')
    let u; try { u=new URL(s.url.trim()); if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.href.length > 2048) throw 0 } catch { throw bad('线路地址必须是有效的 HTTP(S) 地址') }
    if (!['hls','mp4'].includes(s.type)) throw bad('线路类型无效')
    const existing=old?.streams.find(x=>x.id===s.id)
    if (existing && used.has(existing.id)) throw bad('线路 ID 重复')
    const id=existing?.id || randomUUID(); used.add(id)
    return {id,name,url:u.href,type:s.type}
  })
  const now=new Date().toISOString()
  return {id:old?.id || randomUUID(),name,group,enabled:input.enabled ?? old?.enabled ?? true,streams,createdAt:old?.createdAt || now,updatedAt:now}
}
export function registerLive(app, {auth, updateConfig, getConfig}) {
  const list=()=>getConfig().liveChannels || []
  const sources=()=>getConfig().liveSources || []
  const sourceOf=c=>c.sourceId || 'legacy'
  const scoped=(items,id)=>id ? items.filter(c=>sourceOf(c)===id) : items
  const noStore=reply=>reply.header('Cache-Control','no-store')
  const allSources=()=>[{id:'legacy',name:'原有频道'},...sources()]
  app.get('/api/live/sources', async (req,reply)=>{noStore(reply);return allSources().filter(s=>list().some(c=>sourceOf(c)===s.id && c.enabled)).map(({id,name})=>({id,name}))})
  app.get('/api/admin/live/sources', async (req,reply)=>{if(!auth(req,reply))return;noStore(reply);return allSources()})
  app.delete('/api/admin/live/sources/:id', async(req,reply)=>{if(!auth(req,reply))return;if(req.params.id==='legacy')throw bad('原有频道分组不能删除');await updateConfig(next=>{const i=(next.liveSources||[]).findIndex(s=>s.id===req.params.id);if(i<0)throw Object.assign(new Error('直播源不存在'),{statusCode:404});next.liveSources.splice(i,1);next.liveChannels=(next.liveChannels||[]).filter(c=>sourceOf(c)!==req.params.id)});return {ok:true}})
  app.get('/api/live/channels', async (req,reply)=>{noStore(reply);return scoped(list(),req.query.sourceId).filter(c=>c.enabled).map(({id,name,group,streams})=>({id,name,group,streams}))})
  app.get('/api/admin/live/channels', async (req,reply)=>{if(!auth(req,reply))return;noStore(reply);return scoped(list(),req.query.sourceId)})
  app.get('/api/admin/live/export', async (req,reply)=>{if(!auth(req,reply))return;noStore(reply);return {version:1,channels:scoped(list(),req.query.sourceId).map(({name,group,enabled,streams})=>({name,group,enabled,streams:streams.map(({name,url,type})=>({name,url,type}))}))}})
  app.post('/api/admin/live/channels', {bodyLimit:16*1024*1024}, async (req,reply)=>{if(!auth(req,reply))return;const c=channel(req.body),sourceId=req.body?.sourceId || 'legacy';await updateConfig(next=>{next.liveChannels ||= [];if(sourceId!=='legacy' && !(next.liveSources||[]).some(s=>s.id===sourceId))throw bad('直播源不存在');if(sourceId!=='legacy')c.sourceId=sourceId;next.liveChannels.push(c)});return {id:c.id}})
  app.patch('/api/admin/live/channels/:id', {bodyLimit:16*1024*1024}, async (req,reply)=>{if(!auth(req,reply))return;await updateConfig(next=>{const i=(next.liveChannels || []).findIndex(c=>c.id===req.params.id);if(i<0)throw missing();const old=next.liveChannels[i],updated=channel({...old,...req.body},old);if(old.sourceId)updated.sourceId=old.sourceId;next.liveChannels[i]=updated});return {ok:true}})
  app.delete('/api/admin/live/channels/:id', async (req,reply)=>{if(!auth(req,reply))return;await updateConfig(next=>{const i=(next.liveChannels || []).findIndex(c=>c.id===req.params.id);if(i<0)throw missing();next.liveChannels.splice(i,1)});return {ok:true}})
  app.post('/api/admin/live/order', {bodyLimit:8*1024*1024}, async (req,reply)=>{if(!auth(req,reply))return;await updateConfig(next=>{const all=next.liveChannels || [], sourceId=req.body?.sourceId, channels=scoped(all,sourceId), ids=req.body?.ids, byId=new Map(channels.map(c=>[c.id,c]));if(!Array.isArray(ids) || ids.length!==channels.length || new Set(ids).size!==ids.length || ids.some(id=>!byId.has(id)))throw bad('频道顺序无效');const ordered=ids.map(id=>byId.get(id));let i=0;next.liveChannels=all.map(c=>!sourceId || sourceOf(c)===sourceId?ordered[i++]:c)});return {ok:true}})
  app.post('/api/admin/live/import',{bodyLimit:16*1024*1024},async(req,reply)=>{if(!auth(req,reply))return;if(req.body?.version!==1 || !Array.isArray(req.body.channels))throw bad('导入格式无效');const incoming=mergeLiveChannels(req.body.channels.map(c=>channel(c)));let added=0,skipped=0,sourceId=req.body.sourceId||'legacy',newSource
    if(req.body.newSource){const {name,url=''}=req.body.newSource;if(typeof name!=='string'||!name.trim()||name.trim().length>80||typeof url!=='string'||url.length>2048)throw bad('直播源名称或地址无效');if(url){try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw 0}catch{throw bad('直播源地址无效')}}sourceId=randomUUID();newSource={id:sourceId,name:name.trim(),url}}
    await updateConfig(next=>{next.liveChannels ||= [];next.liveSources ||= [];if(newSource){if(next.liveSources.length>=100)throw bad('直播源数量不能超过 100')}else if(sourceId!=='legacy'&&!next.liveSources.some(s=>s.id===sourceId))throw bad('直播源不存在');const current=scoped(next.liveChannels,sourceId),urls=new Set(current.flatMap(c=>c.streams.map(s=>s.url))),additions=[];for(const c of incoming){c.streams=c.streams.filter(s=>{if(urls.has(s.url)){skipped++;return false}urls.add(s.url);return true});if(c.streams.length){if(sourceId!=='legacy')c.sourceId=sourceId;additions.push(c);added++}}if(newSource&&added)next.liveSources.push(newSource);next.liveChannels=next.liveChannels.concat(additions)});return newSource?{added,skipped,sourceId}:{added,skipped}})
}




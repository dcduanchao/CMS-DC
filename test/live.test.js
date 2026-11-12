import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, rename, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

test('直播频道鉴权、校验、导入、排序和持久化', async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'live-test-'))
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
 const base=`http://127.0.0.1:${port}`
 const start=()=>spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,ADMIN_PASSWORD:'admin-password',SITE_PASSWORD:'site-password',PORT:String(port),HOST:'127.0.0.1'},stdio:'ignore'})
 let child=start()
 const ready=async()=>{for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return}catch{}await new Promise(r=>setTimeout(r,50))}throw Error('server failed')}
 const request=(url,method='GET',body,cookie)=>fetch(base+url,{method,headers:{origin:base,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})
 const stop=async()=>{child.kill();await new Promise(r=>child.once('exit',r))}
 try{await ready();assert.equal((await request('/api/live/channels')).status,401);assert.equal((await request('/api/admin/live/channels')).status,401)
 assert.equal((await request('/api/admin/live/fetch-playlist','POST',{url:'http://127.0.0.1/'})).status,401)
 const admin=(await request('/api/admin/login','POST',{password:'admin-password'})).headers.get('set-cookie').split(';')[0]
 assert.equal((await request('/api/admin/live/fetch-playlist','POST',{url:'http://127.0.0.1/'},admin)).status,502)
 const site=(await request('/api/login','POST',{password:'site-password'})).headers.get('set-cookie').split(';')[0]
 assert.equal((await request('/api/admin/live/channels','GET',null,site)).status,401)
 const entry={name:'频道 A',group:'新闻',enabled:true,streams:[{name:'主线',url:'https://example.com/live?token=1',type:'hls'}]}
 for(const origin of [undefined,'https://untrusted.example']) {
   const headers={'content-type':'application/json',cookie:admin};if(origin)headers.origin=origin
   assert.equal((await fetch(base+'/api/admin/live/channels',{method:'POST',headers,body:JSON.stringify(entry)})).status,403)
 }
 assert.equal((await request('/api/admin/live/channels','POST',entry,site)).status,401)
 assert.equal((await (await request('/api/admin/live/channels','GET',null,admin)).json()).length,0)
 const longEntry={...entry,streams:Array.from({length:10},(_,i)=>({name:`线路 ${i}`,url:`https://example.com/${i}?token=${'x'.repeat(1900)}`,type:'hls'}))}
 const longId=(await (await request('/api/admin/live/channels','POST',longEntry,admin)).json()).id
 assert.ok(longId);assert.equal((await request('/api/admin/live/channels/'+longId,'PATCH',longEntry,admin)).status,200)
 assert.equal((await request('/api/admin/live/channels/'+longId,'DELETE',null,admin)).status,200)
 assert.equal((await request('/api/admin/live/channels','POST',{...entry,streams:[{...entry.streams[0],url:'ftp://example.com'}]},admin)).status,400)
 assert.equal((await request('/api/admin/live/channels','POST',{...entry,streams:[]},admin)).status,400)
 const id=(await (await request('/api/admin/live/channels','POST',entry,admin)).json()).id
 assert.equal((await request('/api/live/channels','GET',null,site)).headers.get('cache-control'),'no-store')
 let live=await (await request('/api/live/channels','GET',null,site)).json();assert.equal(live[0].streams[0].url,entry.streams[0].url)
 const imported=await (await request('/api/admin/live/import','POST',{version:1,channels:[entry,{...entry,name:'频道 B',streams:[{...entry.streams[0],url:'https://example.com/other.m3u8'}]}]},admin)).json();assert.deepEqual(imported,{added:1,skipped:1})
 let all=await (await request('/api/admin/live/channels','GET',null,admin)).json();assert.equal(all.length,2)
 assert.equal((await request('/api/admin/live/order','POST',{ids:[id,id]},admin)).status,400)
 assert.equal((await request('/api/admin/live/order','POST',{ids:all.map(x=>x.id).reverse()},admin)).status,200)
 assert.equal((await request('/api/admin/live/channels/'+id,'PATCH',{enabled:false},admin)).status,200)
 live=await (await request('/api/live/channels','GET',null,site)).json();assert.equal(live.length,1);assert.equal(live[0].name,'频道 B')
 const exported=await (await request('/api/admin/live/export','GET',null,admin)).json();assert.equal(exported.version,1);assert.equal(exported.channels.length,2);assert.equal(exported.channels[1].streams[0].url,entry.streams[0].url)
 await stop();child=start();await ready();const admin2=(await request('/api/admin/login','POST',{password:'admin-password'})).headers.get('set-cookie').split(';')[0]
 all=await (await request('/api/admin/live/channels','GET',null,admin2)).json();assert.equal(all[1].id,id);assert.equal(all[1].enabled,false);assert.ok(JSON.parse(await readFile(path.join(dir,'config.json'),'utf8')).sitePassword)
 assert.equal((await request('/api/admin/live/channels/'+id,'DELETE',null,admin2)).status,200)
 const configFile=path.join(dir,'config.json'), backup=path.join(dir,'backup.json')
 await rename(configFile,backup);await mkdir(configFile)
 const failed=await request('/api/admin/live/channels','POST',entry,admin2)
 assert.equal(failed.status,500);assert.equal((await failed.json()).error,'配置保存失败，请检查存储后重试')
 assert.equal((await (await request('/api/admin/live/channels','GET',null,admin2)).json()).length,1)
 await rm(configFile,{recursive:true});await rename(backup,configFile)
 const many=Array.from({length:1100},(_,i)=>({...entry,name:`频道 ${i}`,streams:[{...entry.streams[0],url:`https://example.com/${i}`}]}))
 assert.deepEqual(await (await request('/api/admin/live/import','POST',{version:1,channels:many},admin2)).json(),{added:1100,skipped:0})
 assert.equal((await request('/api/admin/live/channels','POST',entry,admin2)).status,200)
 assert.deepEqual(await (await request('/api/admin/live/import','POST',{version:1,channels:[entry]},admin2)).json(),{added:0,skipped:1})
 assert.equal((await (await request('/api/admin/live/channels','GET',null,admin2)).json()).length,1102)
 const full=await (await request('/api/admin/live/channels','GET',null,admin2)).json()
 assert.equal((await request('/api/admin/live/order','POST',{ids:full.map(c=>c.id).reverse()},admin2)).status,200)
 const importSource=async name=>(await (await request('/api/admin/live/import','POST',{version:1,newSource:{name,url:`https://example.com/${name}.m3u`},channels:[entry]},admin2)).json())
 const lines=Array.from({length:12},(_,i)=>({name:i%2?'CCTV-8':'CCTV8',group:i%2?'地方':'央视',streams:[{name:'线路 1',url:`https://example.com/cctv8/${i}.m3u8`,type:'hls'}]}))
 const merged=await (await request('/api/admin/live/import','POST',{version:1,newSource:{name:'多线路源',url:''},channels:lines},admin2)).json();assert.equal(merged.added,1)
 const mergedChannels=await (await request('/api/admin/live/channels?sourceId='+merged.sourceId,'GET',null,admin2)).json();assert.equal(mergedChannels.length,1);assert.equal(mergedChannels[0].streams.length,12);assert.equal(mergedChannels[0].streams[11].name,'线路 12')
 const a=await importSource('源甲'),b=await importSource('源乙');assert.equal(a.added,1);assert.equal(b.added,1);assert.notEqual(a.sourceId,b.sourceId)
 assert.equal((await (await request('/api/admin/live/channels?sourceId='+a.sourceId,'GET',null,admin2)).json()).length,1)
 assert.equal((await (await request('/api/admin/live/channels?sourceId='+b.sourceId,'GET',null,admin2)).json()).length,1)
 const site2=(await request('/api/login','POST',{password:'site-password'})).headers.get('set-cookie').split(';')[0]
 const publicSources=await (await request('/api/live/sources','GET',null,site2)).json();assert.ok(publicSources.some(s=>s.id===a.sourceId));assert.ok(publicSources.every(s=>!('url' in s)))
 assert.equal((await (await request('/api/live/channels?sourceId='+a.sourceId,'GET',null,site2)).json()).length,1)
 assert.equal((await request('/api/admin/live/sources/'+a.sourceId,'DELETE',null,site2)).status,401)
 assert.equal((await request('/api/admin/live/sources/'+a.sourceId,'DELETE',null,admin2)).status,200)
 assert.equal((await (await request('/api/admin/live/channels?sourceId='+a.sourceId,'GET',null,admin2)).json()).length,0)
 assert.equal((await (await request('/api/admin/live/channels?sourceId='+b.sourceId,'GET',null,admin2)).json()).length,1)
 }finally{await stop();await rm(dir,{recursive:true,force:true})}
})

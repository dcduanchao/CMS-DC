import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, rename, mkdir, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

test('管理接口鉴权、来源校验、源 CRUD 和内网防护', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'cinema-test-'))
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))}) })
  const base = `http://127.0.0.1:${port}`
  const start = (password,secure=false) => spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,ADMIN_PASSWORD:password,PORT:String(port),HOST:'127.0.0.1',COOKIE_SECURE:String(secure)},stdio:'ignore'})
  let child = start('test-password-long')
  try {
    for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
    const post=(url,body,cookie,origin=base)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json',origin,...(cookie?{cookie}:{})},body:JSON.stringify(body)})
    assert.equal((await fetch(base+'/api/sources').then(r=>r.json())).length,0)
    assert.equal((await post('/api/admin/sources',{name:'x',url:'http://127.0.0.1'})).status,401)
    assert.equal((await post('/api/admin/login',{password:'test-password-long'},null,'http://evil.test')).status,403)
    const login=await post('/api/admin/login',{password:'test-password-long'});assert.equal(login.status,200);const initialCookie=login.headers.get('set-cookie');assert.match(initialCookie,/HttpOnly/i);assert.match(initialCookie,/SameSite=Strict/i);assert.doesNotMatch(initialCookie,/; Secure/i);const cookie=initialCookie.split(';')[0]
    assert.equal((await fetch(base+'/api/admin/sources/export')).status,401)
    assert.equal((await post('/api/admin/sources/import',[{name:'one',url:'https://example.com/one'}])).status,401)
    assert.equal((await post('/api/admin/sources/import',[{name:'one',url:'https://example.com/one'},{name:'bad',url:'xxxx'}],cookie)).status,400)
    assert.deepEqual(await fetch(base+'/api/admin/sources/export',{headers:{cookie}}).then(r=>r.json()),[])
    const imported=await post('/api/admin/sources/import',[{name:'one',url:'https://example.com/one',id:'ignored',enabled:false},{name:'duplicate',url:'https://example.com/one'},{name:'two',url:'https://example.com/two?key=secret'}],cookie)
    assert.deepEqual(await imported.json(),{added:2,skipped:1})
    assert.deepEqual(await fetch(base+'/api/admin/sources/export',{headers:{cookie}}).then(r=>r.json()),[{name:'one',url:'https://example.com/one'},{name:'two',url:'https://example.com/two?key=secret'}])
    const importedSources=await fetch(base+'/api/admin/sources',{headers:{cookie}}).then(r=>r.json());assert.equal(importedSources.length,2);assert.ok(importedSources.every(s=>s.enabled && s.id!=='ignored' && s.createdAt))
    for(const s of importedSources) assert.equal((await fetch(base+'/api/admin/sources/'+s.id,{method:'DELETE',headers:{origin:base,cookie}})).status,200)
    const many=Array.from({length:35},(_,i)=>({name:`source ${i}`,url:`http://127.0.0.1/${i}`}))
    assert.equal((await post('/api/admin/sources/import',many,cookie)).status,200)
    const manySources=await fetch(base+'/api/admin/sources',{headers:{cookie}}).then(r=>r.json())
    const search=await fetch(base+'/api/search?all=1&wd=test&sourceId='+manySources[0].id)
    assert.equal(search.status,200);const searchData=await search.json();assert.equal(searchData.results.length,35);assert.deepEqual(searchData.results.map(r=>r.sourceName),many.map(s=>s.name))
    for(const s of manySources) assert.equal((await fetch(base+'/api/admin/sources/'+s.id,{method:'DELETE',headers:{origin:base,cookie}})).status,200)
    assert.equal((await post('/api/admin/test',{url:'http://127.0.0.1'},cookie)).status,400)
    const privateSource=await post('/api/admin/sources',{name:'内网测试',url:'http://127.0.0.1',enabled:false},cookie);const privateId=(await privateSource.json()).id;assert.equal((await post('/api/admin/test',{sourceId:privateId},cookie)).status,404)
    assert.equal((await fetch(base+'/api/admin/sources/'+privateId,{method:'PATCH',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify({enabled:true})})).status,200);assert.equal((await post('/api/admin/test',{sourceId:privateId},cookie)).status,502);assert.equal((await fetch(base+'/api/admin/sources/'+privateId,{method:'DELETE',headers:{origin:base,cookie}})).status,200)
    const created=await post('/api/admin/sources',{name:'源 A',url:'https://example.com/api?key=secret'},cookie);assert.equal(created.status,200)
    const publicSources=await fetch(base+'/api/sources').then(r=>r.json());assert.equal(publicSources[0].name,'源 A');assert.equal(publicSources[0].url,undefined)
    const id=publicSources[0].id
    assert.equal((await fetch(base+'/api/admin/sources/'+id,{method:'PATCH',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify({enabled:false})})).status,200)
    assert.deepEqual(await fetch(base+'/api/sources').then(r=>r.json()),[])
    assert.equal((await fetch(base+'/api/videos?sourceId='+id)).status,404)
    child.kill(); await new Promise(r=>child.once('exit',r)); child=start('test-password-long',true)
    for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
    const again=await post('/api/admin/login',{password:'test-password-long'}); assert.equal(again.status,200)
    assert.match(again.headers.get('set-cookie'),/; Secure/i);const newCookie=again.headers.get('set-cookie').split(';')[0]
    const persisted=await fetch(base+'/api/admin/sources',{headers:{cookie:newCookie}}).then(r=>r.json()); assert.equal(persisted.length,1); assert.equal(persisted[0].id,id); assert.equal(persisted[0].enabled,false)
    assert.equal(persisted[0].url,undefined);assert.equal(JSON.stringify(persisted).includes('secret'),false)
    const renamed=await fetch(base+'/api/admin/sources/'+id,{method:'PATCH',headers:{origin:base,cookie:newCookie,'content-type':'application/json'},body:JSON.stringify({name:'更名后的源'})});assert.equal(renamed.status,200);assert.equal(JSON.parse(await readFile(path.join(dir,'config.json'),'utf8')).sources[0].url,'https://example.com/api?key=secret')
    const config=path.join(dir,'config.json'), backup=path.join(dir,'config.backup'); await rename(config,backup); await mkdir(config)
    const failed=await post('/api/admin/sources',{name:'写入失败的源',url:'https://example.com/'},newCookie); assert.equal(failed.status,500); assert.equal((await failed.json()).error,'配置保存失败，请检查存储后重试')
    assert.equal((await fetch(base+'/api/admin/sources',{headers:{cookie:newCookie}}).then(r=>r.json())).length,1)
    await rm(config,{recursive:true}); await rename(backup,config)
    assert.equal((await post('/api/admin/sources',{name:'恢复后的源',url:'https://example.com/'},newCookie)).status,200)
    assert.equal((await fetch(base+'/api/admin/sources',{headers:{cookie:newCookie}}).then(r=>r.json())).length,2)
    assert.equal((await readdir(dir)).filter(name=>name.endsWith('.tmp')).length,0)
    const concurrent=await Promise.all(Array.from({length:5},(_,i)=>post('/api/admin/sources',{name:`并发源 ${i}`,url:'https://example.com/'},newCookie))); assert.ok(concurrent.every(r=>r.status===200)); assert.equal((await fetch(base+'/api/admin/sources',{headers:{cookie:newCookie}}).then(r=>r.json())).length,7)
    const invalid=await fetch(base+'/api/admin/sources/'+id,{method:'PATCH',headers:{origin:base,cookie:newCookie,'content-type':'application/json'},body:JSON.stringify({enabled:'false'})}); assert.equal(invalid.status,400)
    for(let i=0;i<5;i++)assert.equal((await post('/api/admin/login',{password:'wrong'})).status,401)
    assert.equal((await post('/api/admin/login',{password:'test-password-long'})).status,429)
    assert.equal((await post('/api/admin/logout',{},newCookie)).status,200);assert.equal((await fetch(base+'/api/admin/sources',{headers:{cookie:newCookie}})).status,401)
  } finally { child.kill(); await new Promise(r=>child.once('exit',r)); await rm(dir,{recursive:true,force:true}) }
})

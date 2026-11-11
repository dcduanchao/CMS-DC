import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('苹果 CMS 模拟源贯通管理、分类、列表、搜索和详情', async () => {
  const calls = []; let slowActive=0, slowPeak=0
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock'); const source = req.headers['x-mock-host'][0]; calls.push({ source, query: Object.fromEntries(url.searchParams) })
    if (source === 't') { res.writeHead(200,{'content-type':'application/json'}); const drip=setInterval(()=>res.write(' '),250); res.on('close',()=>clearInterval(drip)); return }
    if (source === 's') { slowPeak=Math.max(slowPeak,++slowActive); return setTimeout(()=>{slowActive--;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({list:[],page:1,pagecount:1}))},200) }
    if (source === 'l') { res.writeHead(200, {'content-type':'application/json'}); return res.end('x'.repeat(2*1024*1024+1)) }
    if (source === 'r') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); return res.end() }
    if (source === 'z') { res.writeHead(302, { location: 'http://[' }); return res.end() }
    if (source === 'x') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('not json') }
    if (source === 'c') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(url.searchParams.get('ac') === 'list' ? 'invalid' : JSON.stringify({ class: [{type_id:'55',type_name:'特别分类'}], list: [] })) }
    if (source === 'f') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(url.searchParams.get('ac') === 'list' ? JSON.stringify({class:[],list:[]}) : JSON.stringify({class:[{type_id:'66',type_name:'回退分类'}],list:[]})) }
    if (source === 'y') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({class:[{type_id:1,type_name:'分类'}]})) }
    if (source === 'e') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({list:[]})) }
    const classes = source === 'a' ? [{ type_id: 1, type_name: '电影' }, { type_id: 3, type_name: '动漫' }] : [{ type_id: 20, type_name: '短剧' }, { type_id: 30, type_name: '纪录片' }]
    const vod = { vod_id: source === 'a' ? 101 : 202, vod_name: `影片 ${source.toUpperCase()}`, type_id: source === 'a' ? 1 : 20, vod_content: '<img src=x onerror=alert(1)><p>简介</p>', vod_play_from: '线路一$$$线路二', vod_play_url: '第一集$https://media.example/1.mp4#第二集$https://media.example/2.mp4$$$正片$https://media.example/1.m3u8' }
    const body = url.searchParams.get('ac') === 'list' ? { class: classes, list: [] } : { page: Number(url.searchParams.get('pg') || 1), pagecount: 2, total: 2, list: [vod] }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
  })
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cinema-integration-'))
  const port = await new Promise(resolve => { const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))}) })
  const base=`http://127.0.0.1:${port}`
  const child=spawn(process.execPath,['--import','./test/mock-network.js','server/index.js'],{env:{...process.env,DATA_DIR:dir,ADMIN_PASSWORD:'test-password-long',PORT:String(port),HOST:'127.0.0.1',MOCK_CMS_PORT:String(mock.address().port)},stdio:'ignore'})
  try {
    for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
    const send = (url, body, cookie) => fetch(base+url,{method:'POST',headers:{origin:base,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)})
    const login=await send('/api/admin/login',{password:'test-password-long'}); assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0]
    const ids=[]
    for(const source of ['a','b']) {
      const payload={name:`源 ${source}`,url:`http://${source}.mock.invalid/api.php/provide/vod/?key=secret&t=999&wd=stale&ids=999&pg=99`}
      const created=await send('/api/admin/sources',payload,cookie); assert.equal(created.status,200); ids.push((await created.json()).id)
      const connection=await send('/api/admin/test',{sourceId:ids.at(-1)},cookie); assert.equal(connection.status,200); assert.equal((await connection.json()).categoryCount,2)
    }
    const [a,b]=ids; const get=async path=>{const r=await fetch(base+path);assert.equal(r.status,200);return r.json()}
    const storedTest=await send('/api/admin/test',{sourceId:a},cookie);assert.equal(storedTest.status,200);assert.equal((await storedTest.json()).categoryCount,2)
    assert.deepEqual((await get(`/api/categories?sourceId=${a}`)).categories.map(x=>x.id),['1','3'])
    assert.deepEqual((await get(`/api/categories?sourceId=${b}`)).categories.map(x=>x.id),['20','30'])
    await get(`/api/videos?sourceId=${b}&page=1`); assert.equal(calls.at(-1).query.t,undefined); assert.equal(calls.at(-1).query.wd,undefined); assert.equal(calls.at(-1).query.ids,undefined); assert.equal(calls.at(-1).query.key,'secret')
    const list=await get(`/api/videos?sourceId=${b}&typeId=20&page=2`); assert.equal(list.list[0].name,'影片 B'); assert.equal(list.page,2)
    assert.ok(calls.some(c=>c.source==='b'&&c.query.t==='20'&&c.query.pg==='2'))
    const before=calls.length; const results=await get(`/api/search?sourceId=${a}&wd=关键字&page=1`); assert.equal(results.results[0].list[0].name,'影片 A'); assert.deepEqual(calls.slice(before).map(c=>c.source),['a']); assert.equal(calls.at(-1).query.wd,'关键字')
    const detail=await get(`/api/detail?sourceId=${b}&vodId=202`); assert.equal(detail.description,'简介'); assert.equal(detail.lines.length,2); assert.equal(detail.lines[0].episodes.length,2); assert.equal(calls.at(-1).query.ids,'202')
    const all=await get(`/api/search?sourceId=${a}&wd=全站&all=1`); assert.equal(all.results.length,2)
    const disabled=await fetch(base+'/api/admin/sources/'+a,{method:'PATCH',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify({enabled:false})});assert.equal(disabled.status,200);assert.equal((await fetch(base+`/api/search?sourceId=${a}&wd=全站&all=1`)).status,404);assert.equal((await get(`/api/search?sourceId=${b}&wd=全站&all=1`)).results.length,1)
    const testUrl=async hostname=>{const saved=await send('/api/admin/sources',{name:hostname,url:`http://${hostname}.mock.invalid/`},cookie);return send('/api/admin/test',{sourceId:(await saved.json()).id},cookie)}
    const fallback=await testUrl('c'); assert.equal(fallback.status,200); assert.equal((await fallback.json()).categoryCount,1)
    const emptyFallback=await testUrl('f'); assert.equal(emptyFallback.status,200); assert.equal((await emptyFallback.json()).categoryCount,1)
    const empty=await testUrl('e'); assert.equal(empty.status,200); assert.equal((await empty.json()).categoryCount,0)
    assert.equal((await testUrl('x')).status,502)
    assert.equal((await testUrl('r')).status,502)
    assert.equal((await testUrl('z')).status,502);assert.equal((await fetch(base+'/api/health')).status,200)
    assert.equal((await testUrl('mixed')).status,502); assert.ok(!calls.some(c=>c.source==='m'))
    assert.equal((await testUrl('large')).status,502)
    const malformed=await send('/api/admin/sources',{name:'缺少列表',url:'http://y.mock.invalid/'},cookie); const malformedId=(await malformed.json()).id; assert.equal((await fetch(base+`/api/videos?sourceId=${malformedId}`)).status,502)
    const slow=await send('/api/admin/sources',{name:'慢源',url:'http://slow.mock.invalid/'},cookie);const slowId=(await slow.json()).id
    const concurrent=await Promise.all(Array.from({length:80},(_,i)=>fetch(base+`/api/videos?sourceId=${slowId}&page=${i+1}`)));assert.ok(slowPeak<=8);assert.ok(concurrent.some(r=>r.status===502));assert.ok(concurrent.some(r=>r.status===200))
    const trickle=await send('/api/admin/sources',{name:'缓慢响应源',url:'http://trickle.mock.invalid/'},cookie);const trickleId=(await trickle.json()).id;const start=Date.now();const timed=await fetch(base+`/api/videos?sourceId=${trickleId}`);assert.equal(timed.status,502);assert.ok(Date.now()-start<12000);assert.equal((await fetch(base+'/api/health')).status,200)
  } finally { child.kill(); await new Promise(r=>child.once('exit',r)); await new Promise(r=>mock.close(r)); await rm(dir,{recursive:true,force:true}) }
})

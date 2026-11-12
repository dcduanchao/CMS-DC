import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { existsSync } from 'node:fs'

const browserPath = process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
test('浏览器切源、竞态、真实分类和分页', { skip: !existsSync(browserPath) }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'cinema-browser-'))
  const port = await new Promise(resolve => { const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))}) })
  const base=`http://127.0.0.1:${port}`
  const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,NODE_ENV:'production',DATA_DIR:dir,ADMIN_PASSWORD:'test-password-long',SITE_PASSWORD:'site-password-long',PORT:String(port),HOST:'127.0.0.1'},stdio:'ignore'})
  let browser
  try {
    for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
    browser=await chromium.launch({executablePath:browserPath,headless:true})
    const page=await browser.newPage(); const calls=[]; let detailAttempts=0; let currentSources=[{id:'a',name:'源 A',enabled:true},{id:'b',name:'源 B',enabled:true}];let releaseChunk,notifyChunk;const chunkRequested=new Promise(r=>notifyChunk=r),chunkGate=new Promise(r=>releaseChunk=r);let chunkCount=0
    await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?'':original.call(this,type)}})
    await page.route('**/assets/hls-*.js',async route=>{chunkCount++;notifyChunk();await chunkGate;await route.continue()})
    await page.route('**/media/*',async route=>{const name=new URL(route.request().url()).pathname.split('/').pop(); const body=await readFile(path.join('test','fixtures',name)); const type=name.endsWith('.mp4')?'video/mp4':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'; await route.fulfill({body,contentType:type})})
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url()); if(url.pathname==='/api/session')return route.fulfill({json:{ok:true}}); const id=url.searchParams.get('sourceId'); calls.push(url.pathname+'?'+url.searchParams)
      if(url.pathname==='/api/sources')return route.fulfill({json:currentSources.filter(s=>s.enabled).map(({id,name})=>({id,name}))})
      if(url.pathname==='/api/admin/sources')return route.fulfill({json:currentSources})
      if(url.pathname==='/api/admin/proxy')return route.fulfill({json:{enabled:false,configured:false}})
      if(url.pathname==='/api/admin/sources/b' && route.request().method()==='PATCH'){currentSources=currentSources.map(s=>s.id==='b'?{...s,enabled:false}:s);return route.fulfill({json:{ok:true}})}
      if(url.pathname==='/api/categories'){if(id==='a')await new Promise(r=>setTimeout(r,500));return route.fulfill({json:{sourceId:id,categories:id==='a'?[{id:'1',name:'电影'},{id:'3',name:'动漫'}]:[{id:'20',name:'短剧'},{id:'30',name:'纪录片'}]}})}
      if(url.pathname==='/api/videos'){if(!currentSources.some(s=>s.id===id&&s.enabled))return route.fulfill({status:404,json:{error:'源不可用'}});if(id==='a')await new Promise(r=>setTimeout(r,500));return route.fulfill({json:{sourceId:id,page:Number(url.searchParams.get('page')),pageCount:2,total:2,list:[{id:'v',name:id==='a'?'影片 A':'影片 B',poster:''}]}})}
      if(url.pathname==='/api/search'){if(!currentSources.some(s=>s.id===id&&s.enabled))return route.fulfill({status:404,json:{error:'源不可用'}});return route.fulfill({json:{results:[{sourceId:id,sourceName:id==='a'?'源 A':'源 B',page:Number(url.searchParams.get('page')),pageCount:2,list:[{id:'v',name:id==='a'?'影片 A':'影片 B'}]}]}})}
      if(url.pathname==='/api/detail'){if(++detailAttempts===1)return route.fulfill({status:502,json:{error:'详情暂不可用'}});return route.fulfill({json:{sourceId:id,name:'影片 B',description:'测试简介',lines:[{name:'MP4',episodes:[{name:'第一集',url:base+'/media/sample.mp4'},{name:'第二集',url:base+'/media/sample.mp4'}]},{name:'HLS',episodes:[{name:'正片',url:base+'/media/sample.m3u8'}]},{name:'不支持',episodes:[{name:'其他',url:'ftp://example.test/a'}]}]}})}
      return route.continue()
    })
    await page.goto(base,{waitUntil:'domcontentloaded'}); await page.locator('#source').selectOption('b'); await page.locator('#source').selectOption('a'); await page.locator('#source').selectOption('b'); await page.getByRole('button',{name:'短剧'}).waitFor(); await page.getByText('影片 B').waitFor(); await page.waitForTimeout(700)
    assert.equal(await page.getByRole('button',{name:'电影',exact:true}).count(),0); assert.equal(await page.getByText('影片 A').count(),0)
    await page.getByRole('button',{name:'短剧'}).click(); await page.waitForFunction(()=>document.querySelector('.card-title')?.textContent==='影片 B'); assert.ok(calls.some(x=>x.includes('sourceId=b')&&x.includes('typeId=20')))
    await page.getByRole('button',{name:'下一页 →'}).click(); await page.waitForFunction(()=>document.querySelector('.pagination')?.textContent.includes('2')); assert.ok(calls.some(x=>x.includes('sourceId=b')&&x.includes('typeId=20')&&x.includes('page=2')))
    await page.getByText('影片 B').click(); await page.getByText('详情暂不可用').waitFor(); await page.locator('.detail').getByRole('button',{name:'重试'}).click(); await page.locator('video').waitFor(); await page.locator('video').evaluate(v=>{v.play().catch(()=>{})}); await page.waitForFunction(()=>document.querySelector('video').currentTime > 0)
    await page.getByRole('button',{name:'下一集',exact:true}).click(); assert.match(await page.getByRole('button',{name:'第二集'}).getAttribute('class'),/active/)
    assert.equal(chunkCount,0);await page.getByRole('button',{name:'HLS',exact:true}).click();await Promise.race([chunkRequested,new Promise((_,reject)=>setTimeout(()=>reject(new Error('HLS 代码未按需请求')),5000))]);await page.getByRole('button',{name:'不支持',exact:true}).click();await page.getByText('不支持此播放地址',{exact:true}).waitFor();const chunkResponse=page.waitForResponse(r=>/\/assets\/hls-.*\.js/.test(r.url())&&r.ok());releaseChunk();await chunkResponse;assert.equal(await page.locator('video').evaluate(v=>v.paused && !v.hasAttribute('src')),true)
    const segment=page.waitForResponse(r=>r.url().endsWith('/media/segment0.ts') && r.ok()); await page.getByRole('button',{name:'HLS',exact:true}).click(); await segment; await page.locator('video').evaluate(v=>{v.play().catch(()=>{})}); await page.waitForFunction(()=>document.querySelector('video').currentTime > 0)
    await page.getByRole('button',{name:'不支持',exact:true}).click(); await page.getByText('不支持此播放地址',{exact:true}).waitFor(); assert.equal(await page.locator('video').evaluate(v=>v.paused && !v.hasAttribute('src')),true)
    await page.locator('.detail .close').click(); await page.getByLabel('搜索片名').fill('关键词'); await page.getByRole('button',{name:'搜索 ↗'}).click(); await page.getByText('当前源搜索 · 关键词').waitFor(); await page.getByLabel('全站').check(); await page.getByRole('button',{name:'下一页 →'}).click(); await page.waitForFunction(()=>document.querySelector('.pagination')?.textContent.includes('2')); assert.ok(calls.some(x=>x.startsWith('/api/search?')&&x.includes('page=2')&&!x.includes('all=1'))); assert.equal(await page.getByText('当前源搜索 · 关键词').count(),1)
    await page.getByRole('button',{name:'源管理 ↗'}).click(); const sourceB=page.locator('.source-row').filter({hasText:'源 B'}); await sourceB.getByRole('button',{name:'禁用'}).click(); await page.waitForFunction(()=>document.querySelector('#source')?.value==='a'); await page.locator('.modal .close').click(); await page.getByText('影片 A').waitFor(); assert.equal(await page.getByText('影片 B').count(),0); assert.equal(await page.getByLabel('搜索片名').inputValue(),'')
    await page.getByLabel('搜索片名').fill('关键词');await page.getByLabel('全站').check();await page.getByRole('button',{name:'搜索 ↗'}).click();await page.getByText('全站搜索 · 关键词').waitFor();await page.getByText('影片 A').waitFor();currentSources=currentSources.map(s=>({...s,enabled:false})); await page.getByRole('button',{name:'下一页 →'}).click(); await page.getByText('还没有影视源').waitFor(); assert.equal(await page.getByText('影片 A').count(),0)
    const isolated=await browser.newPage(); let categoryAttempts=0; let listCalls=0
    await isolated.route('**/api/**',async route=>{const url=new URL(route.request().url()); if(url.pathname==='/api/session')return route.fulfill({json:{ok:true}}); if(url.pathname==='/api/sources')return route.fulfill({json:[{id:'only',name:'单源'}]}); if(url.pathname==='/api/categories'){if(++categoryAttempts===1)return route.fulfill({status:502,json:{error:'分类暂不可用'}});return route.fulfill({json:{categories:[{id:'20',name:'短剧'}]}})} if(url.pathname==='/api/videos'){listCalls++;return route.fulfill({json:{page:Number(url.searchParams.get('page')),pageCount:2,list:[{id:'1',name:'当前影片'}]}})}return route.continue()})
    await isolated.goto(base,{waitUntil:'domcontentloaded'}); await isolated.getByText('分类加载失败：分类暂不可用').waitFor(); await isolated.getByText('当前影片').waitFor(); await isolated.getByRole('button',{name:'下一页 →'}).click(); await isolated.waitForFunction(()=>document.querySelector('.pagination')?.textContent.includes('2')); const beforeRetry=listCalls; await isolated.locator('.categories').getByRole('button',{name:'重试'}).click(); await isolated.getByRole('button',{name:'短剧'}).waitFor(); assert.equal(listCalls,beforeRetry); assert.equal(await isolated.getByText('当前影片').count(),1); assert.match(await isolated.locator('.pagination').textContent(),/2/); await isolated.close()
    const detailPage=await browser.newPage(); let available=true, detailRequests=0
    await detailPage.route('**/api/**',async route=>{const url=new URL(route.request().url()); if(url.pathname==='/api/session')return route.fulfill({json:{ok:true}});if(url.pathname==='/api/sources')return route.fulfill({json:available?[{id:'only',name:'单源'}]:[]});if(url.pathname==='/api/categories')return route.fulfill({json:{categories:[]}});if(url.pathname==='/api/videos')return route.fulfill({json:{page:1,pageCount:1,list:[{id:'1',name:'待查看影片'}]}});if(url.pathname==='/api/detail'){if(++detailRequests===2)available=false;return route.fulfill({status:404,json:{error:'未找到影片'}})}return route.continue()})
    await detailPage.goto(base,{waitUntil:'domcontentloaded'});await detailPage.getByText('待查看影片').click();await detailPage.getByText('未找到影片').waitFor();assert.equal(await detailPage.locator('#source').inputValue(),'only');await detailPage.locator('.detail').getByRole('button',{name:'重试'}).click();await detailPage.getByText('还没有影视源').waitFor();assert.equal(await detailPage.locator('.detail').count(),0);await detailPage.close()
    const emptyPage=await browser.newPage();await emptyPage.route('**/api/**',async route=>{const url=new URL(route.request().url()); if(url.pathname==='/api/session')return route.fulfill({json:{ok:true}});if(url.pathname==='/api/sources')return route.fulfill({json:[{id:'empty',name:'空源'}]});if(url.pathname==='/api/categories')return route.fulfill({json:{categories:[]}});if(url.pathname==='/api/videos')return route.fulfill({json:{page:1,pageCount:1,list:[]}});return route.continue()});await emptyPage.goto(base,{waitUntil:'domcontentloaded'});await emptyPage.getByText('暂无影片').waitFor();assert.equal(await emptyPage.locator('.categories button').count(),1);assert.equal(await emptyPage.getByRole('button',{name:'下一页 →'}).isDisabled(),true);await emptyPage.close()
  } finally { await browser?.close(); child.kill(); await new Promise(r=>child.once('exit',r)); await rm(dir,{recursive:true,force:true}) }
})

test('浏览器经真实后端添加并切换两个模拟苹果 CMS 源', { skip: !existsSync(browserPath) }, async () => {
  const calls=[]
  const mock=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://mock'); const source=req.headers['x-mock-host'][0]; calls.push({source,query:Object.fromEntries(url.searchParams)})
    const vod={vod_id:source==='a'?11:22,vod_name:`实链影片 ${source.toUpperCase()}`,vod_content:'模拟简介',vod_play_from:'测试线路',vod_play_url:'正片$https://media.example/video.mp4'}
    const data=url.searchParams.get('ac')==='list'?{class:source==='a'?[{type_id:1,type_name:'电影'}]:[{type_id:20,type_name:'短剧'}],list:[]}:{page:Number(url.searchParams.get('pg')||1),pagecount:2,total:2,list:[vod]}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data))
  })
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve))
  const dir=await mkdtemp(path.join(os.tmpdir(),'cinema-full-browser-'))
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
  const base=`http://127.0.0.1:${port}`
  const child=spawn(process.execPath,['--import','./test/mock-network.js','server/index.js'],{env:{...process.env,NODE_ENV:'production',DATA_DIR:dir,ADMIN_PASSWORD:'test-password-long',SITE_PASSWORD:'site-password-long',PORT:String(port),HOST:'127.0.0.1',MOCK_CMS_PORT:String(mock.address().port)},stdio:'ignore'})
  let browser
  try {
    for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
    browser=await chromium.launch({executablePath:browserPath,headless:true});const page=await browser.newPage()
    await page.goto(base,{waitUntil:'domcontentloaded'});await page.locator('#access-password').fill('wrong');await page.getByRole('button',{name:'\u8fdb\u5165',exact:true}).click();await page.getByText('\u5bc6\u7801\u9519\u8bef').waitFor();await page.locator('#access-password').fill('site-password-long');await page.getByRole('button',{name:'\u8fdb\u5165',exact:true}).click();await page.getByText('\u8fd8\u6ca1\u6709\u5f71\u89c6\u6e90').waitFor();await page.reload();await page.getByText('\u8fd8\u6ca1\u6709\u5f71\u89c6\u6e90').waitFor();await page.getByRole('button',{name:'\u6e90\u7ba1\u7406 \u2197',exact:true}).click();await page.locator('.modal input[type=password]').fill('test-password-long');await page.getByRole('button',{name:'\u767b\u5f55',exact:true}).click();await page.getByRole('heading',{name:'\u6dfb\u52a0\u5f71\u89c6\u6e90'}).waitFor()
    for(const source of ['a','b']){const form=page.locator('.modal form');await form.locator('input').nth(0).fill(`实链源 ${source.toUpperCase()}`);await form.locator('input[type=url]').fill(`http://${source}.mock.invalid/api`);assert.equal(await form.getByRole('button',{name:'测试连接'}).isDisabled(),true);await form.getByRole('button',{name:'保存',exact:true}).click();await page.locator('.source-row').filter({hasText:`实链源 ${source.toUpperCase()}`}).waitFor()}
    await page.locator('.source-row').filter({hasText:'实链源 A'}).getByRole('button',{name:'编辑'}).click();const editForm=page.locator('.modal form');assert.equal(await editForm.locator('input[type=url]').inputValue(),'');await editForm.getByRole('button',{name:'测试连接'}).click();await page.getByText('连接成功，发现 1 个分类').waitFor();await editForm.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('保存成功').waitFor()
    await page.locator('.modal .close').click();await page.getByText('实链影片 A').waitFor();await page.getByRole('button',{name:'电影',exact:true}).waitFor()
    const b=await page.locator('#source option').filter({hasText:'实链源 B'}).getAttribute('value');await page.locator('#source').selectOption(b);await page.getByText('实链影片 B').waitFor();assert.equal(await page.getByText('实链影片 A').count(),0)
    await page.getByRole('button',{name:'短剧',exact:true}).click();await page.getByText('实链影片 B').waitFor();assert.ok(calls.some(c=>c.source==='b'&&c.query.t==='20'))
    await page.getByLabel('搜索片名').fill('实链');await page.getByRole('button',{name:'搜索 ↗'}).click();await page.getByText('当前源搜索 · 实链').waitFor();assert.ok(calls.some(c=>c.source==='b'&&c.query.wd==='实链'))
    await page.getByText('实链影片 B').click();await page.getByText('模拟简介').waitFor();assert.ok(calls.some(c=>c.source==='b'&&c.query.ids==='22'))
    await page.locator('.detail .close').click();await page.getByRole('button',{name:'源管理 ↗',exact:true}).click();await page.locator('.source-row').filter({hasText:'实链源 B'}).getByRole('button',{name:'编辑'}).click();await page.locator('.modal input[type=url]').fill('http://a.mock.invalid/api');await page.locator('.modal form').getByRole('button',{name:'保存',exact:true}).click();await page.getByText('保存成功').waitFor();await page.locator('.modal .close').click();await page.getByText('实链影片 A').waitFor();await page.getByRole('button',{name:'电影',exact:true}).waitFor();assert.equal(await page.locator('#source').inputValue(),b);assert.equal(await page.getByText('实链影片 B').count(),0);assert.equal(await page.getByLabel('搜索片名').inputValue(),'')
    await page.getByRole('button',{name:'源管理 ↗',exact:true}).click();page.once('dialog',dialog=>dialog.accept());await page.locator('.source-row').filter({hasText:'实链源 B'}).getByRole('button',{name:'删除'}).click();await page.waitForFunction(id=>document.querySelector('#source')?.value!==id,b);assert.equal(await page.locator('#source option').count(),1)
  } finally {await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true})}
})

test('直播管理、导入预览和 HLS 播放切换', { skip: !existsSync(browserPath) }, async () => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'live-browser-'))
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
 const base=`http://127.0.0.1:${port}`
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,ADMIN_PASSWORD:'admin-password',SITE_PASSWORD:'site-password',PORT:String(port),HOST:'127.0.0.1'},stdio:'ignore'})
 let browser
 try {
  for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
  browser=await chromium.launch({executablePath:browserPath,headless:true});const page=await browser.newPage()
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?'':original.call(this,type)}})
  await page.route('**/media/*',async route=>{const name=new URL(route.request().url()).pathname.split('/').pop();const body=await readFile(path.join('test','fixtures',name));await route.fulfill({body,contentType:name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':name.endsWith('.mp4')?'video/mp4':'video/mp2t'})})
  await page.goto(base);await page.locator('#access-password').fill('site-password');await page.getByRole('button',{name:'进入'}).click();await page.getByRole('button',{name:'源管理 ↗',exact:true}).click();await page.locator('.modal input[type=password]').fill('admin-password');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'直播源',exact:true}).click()
  await page.route('**/api/admin/live/fetch-playlist',route=>{const url=route.request().postDataJSON().url;return route.fulfill({json:{text:url.includes('large-list')?'#EXTM3U\n'+Array.from({length:518},(_,i)=>`#EXTINF:-1,频道 ${i}\nhttps://example.com/${i}.m3u8\n`).join(''):url.endsWith('live.txt')?'河南地方,#genre#\n河南卫视,https://example.com/henan.m3u8?token=1\n':'#EXTM3U\n#EXTINF:-1,网址频道\nhttps://example.com/live.m3u8\n'}})})
  await page.locator('#playlist-url').fill(base+'/live.txt');await page.getByRole('button',{name:'读取并预览'}).click();await page.getByText('河南卫视 · 河南地方', {exact:false}).waitFor();await page.getByRole('button',{name:'确认导入'}).click();await page.locator('.source-row').filter({hasText:'河南卫视'}).waitFor();await page.getByRole('button',{name:'删除直播源'}).click({trial:true});page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除直播源'}).click();await page.getByText('直播源已删除').waitFor()
  await page.locator('#playlist-url').fill(base+'/large-list.m3u');await page.getByRole('button',{name:'读取并预览'}).click();await page.getByText('导入预览：518 个频道，已选 518 个').waitFor();await page.getByRole('button',{name:'确认导入'}).click();await page.getByText('导入完成：新增 518 个频道，跳过 0 条重复线路').waitFor();assert.equal(await page.locator('.source-row').count(),518);page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除直播源'}).click();await page.getByText('直播源已删除').waitFor()
  await page.route('**/playlist.m3u',route=>route.fulfill({contentType:'audio/x-mpegurl',body:'#EXTM3U\n#EXTINF:-1,网址频道\nhttps://example.com/live.m3u8\n'}))
  await page.locator('#playlist-url').fill(base+'/playlist.m3u');await page.getByRole('button',{name:'读取并预览'}).click();await page.getByText('网址频道', {exact:false}).waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('.source-row').count(),0)
  const input=page.locator('input[type=file][accept=".m3u,.m3u8,.txt,.json"]')
  await input.setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{invalid')});await page.getByText('JSON 格式无效').waitFor()
  await input.setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"version":1,"channels":[null]}')});await page.getByText('第 1 项：频道格式无效').waitFor();assert.equal(await page.getByRole('button',{name:'确认导入'}).isDisabled(),true);await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('.source-row').count(),0)
  await page.locator('input[type=file][accept=".m3u,.m3u8,.txt,.json"]').setInputFiles({name:'channels.m3u',mimeType:'application/vnd.apple.mpegurl',buffer:Buffer.from(`#EXTM3U\n#EXTINF:-1 group-title="新闻",频道一\n${base}/media/sample.m3u8\n#EXTINF:-1,重复频道\n${base}/media/sample.m3u8\n#EXTINF:-1,错误频道\nrelative.m3u8\n`)})
  await page.getByText('导入预览：2 个频道，已选 2 个，1 条重复线路').waitFor();await page.getByText('第 7 行：地址或频道信息无效').waitFor();await page.getByRole('button',{name:'确认导入'}).click();await page.getByText('导入完成：新增 1 个频道，跳过 1 条重复线路').waitFor()
  await input.setInputFiles({name:'other.m3u',mimeType:'application/vnd.apple.mpegurl',buffer:Buffer.from(`#EXTM3U\n#EXTINF:-1,频道二\n${base}/media/sample.m3u8\n#EXTINF:-1,频道二\n${base}/media/sample.mp4\n`)});await page.getByRole('button',{name:'确认导入'}).click();await page.locator('.source-row').filter({hasText:'频道二'}).waitFor();assert.equal(await page.locator('.source-row').filter({hasText:'频道一'}).count(),0)
  await page.locator('#admin-live-source').selectOption({label:'channels.m3u'});await page.locator('.source-row').filter({hasText:'频道一'}).getByRole('button',{name:'编辑'}).click();await page.getByRole('heading',{name:'编辑频道'}).waitFor();await page.getByRole('button',{name:'添加线路'}).click();await page.locator('.live-stream').nth(1).locator('input[type=url]').fill(base+'/media/sample.mp4');await page.locator('.live-stream').nth(1).locator('select').selectOption('mp4');await page.getByRole('button',{name:'保存频道'}).click();await page.getByText('频道已保存').waitFor();await page.locator('.modal .close').click()
  await page.getByRole('button',{name:'直播',exact:true}).click();await page.getByRole('heading',{name:'直播频道'}).waitFor();await page.locator('#live-source').selectOption({label:'channels.m3u'});const segment=page.waitForResponse(r=>r.url().endsWith('/media/segment0.ts')&&r.ok());await page.getByRole('button',{name:'频道一',exact:true}).click();await segment;await page.locator('video').evaluate(v=>v.play().catch(()=>{}));await page.waitForFunction(()=>document.querySelector('video').currentTime>0);await page.getByRole('button',{name:'线路 2',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video').src.endsWith('/media/sample.mp4'));await page.getByRole('button',{name:'线路 1',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('video').src.endsWith('/media/sample.mp4'))
  await page.getByLabel('搜索频道').fill('无匹配');await page.getByText('没有匹配的频道，请清除筛选。').waitFor();await page.getByRole('button',{name:'清除筛选'}).click();await page.locator('#live-source').selectOption({label:'other.m3u'});await page.getByRole('button',{name:'频道二',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'频道二',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'频道一',exact:true}).count(),0);assert.equal(await page.locator('video').count(),0);await page.getByRole('button',{name:'频道二',exact:true}).click();await page.getByRole('button',{name:'线路 2',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video')?.src.endsWith('/media/sample.mp4'));await page.getByRole('button',{name:'影视',exact:true}).click();assert.equal(await page.locator('video').count(),0)
 }finally{await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true})}
})




test('直播原生 HLS 分支与自动播放受限提示', { skip: !existsSync(browserPath) }, async () => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'live-native-'))
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
 const base=`http://127.0.0.1:${port}`
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,ADMIN_PASSWORD:'admin-password',SITE_PASSWORD:'site-password',PORT:String(port),HOST:'127.0.0.1'},stdio:'ignore'})
 let browser
 try {
  for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
  browser=await chromium.launch({executablePath:browserPath,headless:true});const page=await browser.newPage();let chunkCount=0
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?'probably':original.call(this,type)};HTMLMediaElement.prototype.play=function(){return Promise.reject(new DOMException('blocked','NotAllowedError'))}})
  await page.route('**/assets/hls-*.js',async route=>{chunkCount++;await route.continue()})
  await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;if(p==='/api/session')return route.fulfill({json:{ok:true}});if(p==='/api/sources')return route.fulfill({json:[]});if(p==='/api/live/sources')return route.fulfill({json:[{id:'test',name:'测试源'}]});if(p==='/api/live/channels')return route.fulfill({json:[{id:'c',name:'原生频道',group:'',streams:[{id:'s',name:'主线',type:'hls',url:base+'/media/live.m3u8'}]}]});return route.continue()})
  await page.goto(base);await page.getByRole('button',{name:'直播',exact:true}).click();await page.locator('#live-source').selectOption('test');await page.getByRole('button',{name:'原生频道'}).click();await page.getByText('请点击播放器的播放按钮开始观看').waitFor();assert.equal(await page.locator('video').getAttribute('src'),base+'/media/live.m3u8');assert.equal(chunkCount,0)
  await page.evaluate(()=>{HTMLMediaElement.prototype.play=function(){return Promise.reject(new DOMException('unsupported','NotSupportedError'))}});await page.getByRole('button',{name:'重试'}).click();await page.getByText('播放失败，请检查资源和浏览器支持，或切换线路').waitFor();assert.equal(await page.getByText('请点击播放器的播放按钮开始观看').count(),0)
 }finally{await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true})}
})

test('直播快速切换时延迟加载的 HLS 不覆盖当前频道', { skip: !existsSync(browserPath) }, async () => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'live-race-'))
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
 const base=`http://127.0.0.1:${port}`
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,ADMIN_PASSWORD:'admin-password',SITE_PASSWORD:'site-password',PORT:String(port),HOST:'127.0.0.1'},stdio:'ignore'})
 let browser,release
 try {
  for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
  browser=await chromium.launch({executablePath:browserPath,headless:true});const page=await browser.newPage()
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?'':original.call(this,type)}})
  let notify;const requested=new Promise(r=>notify=r),gate=new Promise(r=>release=r)
  await page.route('**/assets/hls-*.js',async route=>{notify();await gate;await route.continue()})
  await page.route('**/media/*',async route=>{const name=new URL(route.request().url()).pathname.split('/').pop();const body=await readFile(path.join('test','fixtures',name));await route.fulfill({body,contentType:name.endsWith('.mp4')?'video/mp4':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'})})
  await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;if(p==='/api/session')return route.fulfill({json:{ok:true}});if(p==='/api/sources')return route.fulfill({json:[]});if(p==='/api/live/sources')return route.fulfill({json:[{id:'test',name:'测试源'}]});if(p==='/api/live/channels')return route.fulfill({json:[{id:'h',name:'HLS 频道',group:'',streams:[{id:'hs',name:'主线',type:'hls',url:base+'/media/sample.m3u8'}]},{id:'m',name:'MP4 频道',group:'',streams:[{id:'ms',name:'主线',type:'mp4',url:base+'/media/sample.mp4'}]}]});return route.continue()})
  await page.goto(base);await page.getByRole('button',{name:'直播',exact:true}).click();await page.locator('#live-source').selectOption('test');await page.getByRole('button',{name:'HLS 频道'}).click();await Promise.race([requested,new Promise((_,reject)=>setTimeout(()=>reject(Error('未请求 HLS 模块')),5000))]);await page.getByRole('button',{name:'MP4 频道'}).click();await page.waitForFunction(()=>document.querySelector('video')?.src.endsWith('/media/sample.mp4'))
  const response=page.waitForResponse(r=>/\/assets\/hls-.*\.js/.test(r.url())&&r.ok());release();await response;await page.locator('video').evaluate(v=>v.play().catch(()=>{}));await page.waitForFunction(()=>document.querySelector('video').currentTime>0);assert.match(await page.locator('video').getAttribute('src'),/sample\.mp4$/);assert.equal(await page.getByRole('heading',{name:'MP4 频道'}).count(),1)
 }finally{release?.();await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true})}
})

test('直播 HLS 持续刷新播放列表并请求更新的分片', { skip: !existsSync(browserPath) }, async () => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'live-refresh-'))
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
 const base=`http://127.0.0.1:${port}`
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,ADMIN_PASSWORD:'admin-password',SITE_PASSWORD:'site-password',PORT:String(port),HOST:'127.0.0.1'},stdio:'ignore'})
 let browser
 try {
  for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
  browser=await chromium.launch({executablePath:browserPath,headless:true});const page=await browser.newPage();let manifests=0,segments=0
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?'':original.call(this,type)}})
  await page.route('**/live-media/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.endsWith('.m3u8')){const n=manifests++;return route.fulfill({body:`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${n}\n#EXTINF:2.0,\nsegment${n}.ts\n`,contentType:'application/vnd.apple.mpegurl'})}segments++;return route.fulfill({body:await readFile(path.join('test','fixtures','segment0.ts')),contentType:'video/mp2t'})})
  await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;if(p==='/api/session')return route.fulfill({json:{ok:true}});if(p==='/api/sources')return route.fulfill({json:[]});if(p==='/api/live/sources')return route.fulfill({json:[{id:'test',name:'测试源'}]});if(p==='/api/live/channels')return route.fulfill({json:[{id:'l',name:'测试直播',group:'',streams:[{id:'s',name:'主线',type:'hls',url:base+'/live-media/channel.m3u8'}]}]});return route.continue()})
  await page.goto(base);await page.getByRole('button',{name:'直播',exact:true}).click();await page.locator('#live-source').selectOption('test');await page.getByRole('button',{name:'测试直播'}).click();await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0,{timeout:10000});await page.waitForResponse(r=>r.url().endsWith('segment1.ts')&&r.ok(),{timeout:15000});assert.ok(manifests>=2);assert.ok(segments>=2)
 }finally{await browser?.close();child.kill();await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true})}
})





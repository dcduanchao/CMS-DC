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
  const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,NODE_ENV:'production',DATA_DIR:dir,ADMIN_PASSWORD:'test-password-long',PORT:String(port),HOST:'127.0.0.1'},stdio:'ignore'})
  let browser
  try {
    for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
    browser=await chromium.launch({executablePath:browserPath,headless:true})
    const page=await browser.newPage(); const calls=[]; let detailAttempts=0; let currentSources=[{id:'a',name:'源 A',enabled:true},{id:'b',name:'源 B',enabled:true}];let releaseChunk,notifyChunk;const chunkRequested=new Promise(r=>notifyChunk=r),chunkGate=new Promise(r=>releaseChunk=r);let chunkCount=0
    await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?'':original.call(this,type)}})
    await page.route('**/assets/hls-*.js',async route=>{chunkCount++;notifyChunk();await chunkGate;await route.continue()})
    await page.route('**/media/*',async route=>{const name=new URL(route.request().url()).pathname.split('/').pop(); const body=await readFile(path.join('test','fixtures',name)); const type=name.endsWith('.mp4')?'video/mp4':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'; await route.fulfill({body,contentType:type})})
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url()); const id=url.searchParams.get('sourceId'); calls.push(url.pathname+'?'+url.searchParams)
      if(url.pathname==='/api/sources')return route.fulfill({json:currentSources.filter(s=>s.enabled).map(({id,name})=>({id,name}))})
      if(url.pathname==='/api/admin/sources')return route.fulfill({json:currentSources})
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
    await isolated.route('**/api/**',async route=>{const url=new URL(route.request().url()); if(url.pathname==='/api/sources')return route.fulfill({json:[{id:'only',name:'单源'}]}); if(url.pathname==='/api/categories'){if(++categoryAttempts===1)return route.fulfill({status:502,json:{error:'分类暂不可用'}});return route.fulfill({json:{categories:[{id:'20',name:'短剧'}]}})} if(url.pathname==='/api/videos'){listCalls++;return route.fulfill({json:{page:Number(url.searchParams.get('page')),pageCount:2,list:[{id:'1',name:'当前影片'}]}})}return route.continue()})
    await isolated.goto(base,{waitUntil:'domcontentloaded'}); await isolated.getByText('分类加载失败：分类暂不可用').waitFor(); await isolated.getByText('当前影片').waitFor(); await isolated.getByRole('button',{name:'下一页 →'}).click(); await isolated.waitForFunction(()=>document.querySelector('.pagination')?.textContent.includes('2')); const beforeRetry=listCalls; await isolated.locator('.categories').getByRole('button',{name:'重试'}).click(); await isolated.getByRole('button',{name:'短剧'}).waitFor(); assert.equal(listCalls,beforeRetry); assert.equal(await isolated.getByText('当前影片').count(),1); assert.match(await isolated.locator('.pagination').textContent(),/2/); await isolated.close()
    const detailPage=await browser.newPage(); let available=true, detailRequests=0
    await detailPage.route('**/api/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/api/sources')return route.fulfill({json:available?[{id:'only',name:'单源'}]:[]});if(url.pathname==='/api/categories')return route.fulfill({json:{categories:[]}});if(url.pathname==='/api/videos')return route.fulfill({json:{page:1,pageCount:1,list:[{id:'1',name:'待查看影片'}]}});if(url.pathname==='/api/detail'){if(++detailRequests===2)available=false;return route.fulfill({status:404,json:{error:'未找到影片'}})}return route.continue()})
    await detailPage.goto(base,{waitUntil:'domcontentloaded'});await detailPage.getByText('待查看影片').click();await detailPage.getByText('未找到影片').waitFor();assert.equal(await detailPage.locator('#source').inputValue(),'only');await detailPage.locator('.detail').getByRole('button',{name:'重试'}).click();await detailPage.getByText('还没有影视源').waitFor();assert.equal(await detailPage.locator('.detail').count(),0);await detailPage.close()
    const emptyPage=await browser.newPage();await emptyPage.route('**/api/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/api/sources')return route.fulfill({json:[{id:'empty',name:'空源'}]});if(url.pathname==='/api/categories')return route.fulfill({json:{categories:[]}});if(url.pathname==='/api/videos')return route.fulfill({json:{page:1,pageCount:1,list:[]}});return route.continue()});await emptyPage.goto(base,{waitUntil:'domcontentloaded'});await emptyPage.getByText('暂无影片').waitFor();assert.equal(await emptyPage.locator('.categories button').count(),1);assert.equal(await emptyPage.getByRole('button',{name:'下一页 →'}).isDisabled(),true);await emptyPage.close()
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
  const child=spawn(process.execPath,['--import','./test/mock-network.js','server/index.js'],{env:{...process.env,NODE_ENV:'production',DATA_DIR:dir,ADMIN_PASSWORD:'test-password-long',PORT:String(port),HOST:'127.0.0.1',MOCK_CMS_PORT:String(mock.address().port)},stdio:'ignore'})
  let browser
  try {
    for(let i=0;i<100;i++){try{await fetch(base+'/api/health');break}catch{await new Promise(r=>setTimeout(r,50))}}
    browser=await chromium.launch({executablePath:browserPath,headless:true});const page=await browser.newPage()
    await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByText('还没有影视源').waitFor();await page.getByRole('button',{name:'源管理 ↗',exact:true}).click()
    await page.locator('.modal input[type=password]').fill('test-password-long');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('heading',{name:'添加影视源'}).waitFor()
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

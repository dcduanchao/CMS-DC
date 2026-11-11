import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { categories, detail, listing, pinnedLookup, publicAddress, upstream } from '../server/upstream.js'

test('分类和影片保留上游真实 ID，缺失分页保守处理', () => {
  assert.deepEqual(categories({ class: [{type_id: 20,type_name:'短剧'},{type_id:'30',type_name:'纪录片'}] }), [{id:'20',name:'短剧'},{id:'30',name:'纪录片'}])
  const result = listing({list:[{vod_id:123,vod_name:'测试'}]}, 'b', 2)
  assert.equal(result.list[0].id, '123'); assert.equal(result.pageCount, 2)
})
test('多线路和含美元符的播放地址不被拆坏', () => {
  const result = detail({vod_play_from:'甲$$$乙',vod_play_url:'第一集$https://a.test/1.m3u8?x=$y#第二集$https://a.test/2.mp4$$$正片$https://b.test/x.mp4'})
  assert.equal(result.lines.length, 2); assert.equal(result.lines[0].episodes.length, 2); assert.equal(result.lines[0].episodes[0].url, 'https://a.test/1.m3u8?x=$y'); assert.equal(result.lines[1].name, '乙')
})
test('禁止访问私有、回环、链路本地及 IPv6 地址', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1']) assert.equal(publicAddress(ip), false, ip)
  assert.equal(publicAddress('8.8.8.8'), true)
  await assert.rejects(upstream('http://127.0.0.1/', {ac:'list'}, false), /禁止访问/)
  await assert.rejects(upstream('http://[::1]/', {ac:'list'}, false), /禁止访问/)
})
test('通过 HTTP 代理隧道请求源，并继续拒绝内网目标', async () => {
  const proxy = http.createServer()
  let target
  proxy.on('connect', (req, socket) => {
    target = req.url
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"list":[]}'))
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  try {
    assert.deepEqual(await upstream('http://8.8.8.8/api', { ac: 'list' }, false, undefined, proxyUrl), { list: [] })
    assert.equal(target, '8.8.8.8:80')
    await assert.rejects(upstream('http://127.0.0.1/', {}, false, undefined, proxyUrl), /禁止访问/)
  } finally { await new Promise(resolve => proxy.close(resolve)) }
})
test('DNS 固定地址兼容 Node 22 自动地址族选择并建立真实连接', async () => {
  const server = http.createServer((_req,res)=>res.end('ok'))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const body=await new Promise((resolve,reject)=>{http.get(`http://fixture.invalid:${server.address().port}/`,{lookup:pinnedLookup([{address:'::1',family:6},{address:'127.0.0.1',family:4}]),autoSelectFamily:true},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve(data))}).on('error',reject)})
    assert.equal(body,'ok')
    const lookup=pinnedLookup([{address:'8.8.8.8',family:4}]); lookup('fixture.invalid',{all:false},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4)})
  } finally { await new Promise(resolve=>server.close(resolve)) }
})

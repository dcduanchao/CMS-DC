import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseM3u, parsePlaylist, previewChannels } from '../src/liveImport.js'
import { mergeLiveChannels } from '../server/liveGrouping.js'

test('M3U 预览处理带逗号的分组、无效地址、缺失地址及重复线路', () => {
  const {result,issues}=parseM3u('#EXTM3U\n#EXTINF:-1 group-title="新闻,综合",频道 A\nhttps://EXAMPLE.com:443/live?token=1\n#EXTINF:-1,丢失\n#EXTINF:-1,相对\n../bad.m3u8\n#EXTINF:-1,重复\nhttps://example.com/live?token=1\n#EXTINF:-1,末尾')
  assert.equal(result.length,2);assert.equal(result[0].group,'新闻,综合');assert.equal(result[0].name,'频道 A')
  assert.ok(issues.some(x=>x.includes('第 4 行')));assert.ok(issues.some(x=>x.includes('第 6 行')));assert.ok(issues.some(x=>x.includes('第 9 行')))
  const preview=previewChannels(result,[],issues);assert.equal(preview.added,1);assert.equal(preview.duplicates,1);assert.equal(preview.invalid,false);assert.match(preview.rows[1].state,/跳过/)
})

test('JSON 预览拒绝无效数据并允许超过 500 个频道', () => {
  const entry={name:'频道',group:'',streams:[{name:'主线',url:'https://example.com/a',type:'hls'}]}
  for(const invalid of [null,{...entry,streams:[null]},{...entry,streams:[{...entry.streams[0],url:'http://user:pass@example.com'}]}]) {
    const preview=previewChannels([invalid],[]);assert.equal(preview.invalid,true);assert.ok(preview.issues.length)
  }
  const existing=Array.from({length:500},(_,i)=>({...entry,streams:[{...entry.streams[0],url:`https://example.com/${i}`}]}))
  assert.equal(previewChannels([entry],existing).invalid,false)
})

test('识别 TVBox TXT 分组及频道，保留地址参数并报告不支持的协议', () => {
  const {result,issues}=parsePlaylist('\uFEFF河南地方,#genre#\r\n河南卫视,https://example.com/live.m3u8?key=a,b\r\n河南卫视,https://example.com/other.m3u8\r\n其他,#genre#\r\n示例,https://example.com/video.mp4\r\n广播,rtmp://example.com/live\r\n不完整')
  assert.equal(result.length,3);assert.equal(result[0].group,'河南地方');assert.equal(result[0].streams[0].url,'https://example.com/live.m3u8?key=a,b');assert.equal(result[1].name,'河南卫视');assert.equal(result[2].group,'其他');assert.equal(result[2].streams[0].type,'mp4')
  assert.ok(issues.some(x=>x.includes('第 6 行')));assert.ok(issues.some(x=>x.includes('第 7 行')))
  assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:-1,频道\nhttps://example.com/test.m3u8').result[0].name,'频道')
})

test('同名频道及 CCTV 编号写法合并为线路，不合并不同频道', () => {
  const input=[{id:'a',name:'CCTV-8',group:'央视',streams:[{id:'x',name:'线路 1',url:'https://a.test'}]},{id:'b',name:'CCTV8',group:'其他',streams:[{id:'y',name:'线路 1',url:'https://b.test'}]},{id:'c',name:'CCTV8+',group:'央视',streams:[{id:'z',name:'线路 1',url:'https://c.test'}]}]
  const result=mergeLiveChannels(input);assert.equal(result.length,2);assert.equal(result[0].group,'央视');assert.deepEqual(result[0].streams.map(s=>s.name),['线路 1','线路 2']);assert.equal(result[0].streams[1].id,'y');assert.equal(input[0].streams.length,1)
})



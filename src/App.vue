<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import LivePlayer from './LivePlayer.vue'
import LiveAdmin from './LiveAdmin.vue'
const section=ref('movies'), liveVersion=ref(0)
const sources=ref([]), selected=ref(''), cats=ref([]), type=ref(''), videos=ref([]), page=ref(1), pageCount=ref(1), total=ref(0), query=ref(''), searched=ref(''), all=ref(false), searchAll=ref(false), results=ref([])
const sourceError=ref(''), catError=ref(''), listError=ref(''), catLoading=ref(false), loading=ref(false), showAdmin=ref(false), logged=ref(false), password=ref(''), adminSources=ref([]), form=ref({name:'',url:'',enabled:true}), editing=ref(''), adminMessage=ref('')
watch(showAdmin, value=>{if(!value)liveVersion.value++})
const adminTab=ref('sources'), proxyForm=ref({enabled:false,url:''}), proxyConfigured=ref(false)
const authenticated=ref(false), checkingSession=ref(true), accessPassword=ref(''), accessError=ref(''), accessBusy=ref(false)
const movie=ref(null), detailError=ref(''), detailLoading=ref(false), detailTarget=ref(null), line=ref(0), episode=ref(0), playerError=ref(''), videoEl=ref(null)
let categoryEpoch=0, listEpoch=0, detailEpoch=0, playEpoch=0, controller, listController, hls, seekTimer, seekGeneration=0, restoringSeek=false
const sourceName=computed(()=>sources.value.find(s=>s.id===selected.value)?.name || '')
async function api(url, opts={}) { const r=await fetch(url,{...opts,headers:{...(opts.body?{'Content-Type':'application/json'}:{}),...opts.headers}}); const data=await r.json(); if(!r.ok) { if(r.status===401 && url.startsWith('/api/admin/') && url!=='/api/admin/login')logged.value=false; else if(r.status===401 && url!=='/api/login' && !url.startsWith('/api/admin/'))authenticated.value=false; throw Object.assign(new Error(data.error || '请求失败'),{status:r.status}) } return data }
async function accessLogin(){accessError.value='';accessBusy.value=true;try{await api('/api/login',{method:'POST',body:JSON.stringify({password:accessPassword.value})});accessPassword.value='';authenticated.value=true;await refreshSources()}catch(e){accessError.value=e.message}finally{accessBusy.value=false}}
const q = obj => new URLSearchParams(Object.entries(obj).filter(([,v])=>v!=='' && v!==undefined)).toString()
async function refreshSources() { try { sources.value=await api('/api/sources'); sourceError.value=''; const saved=localStorage.getItem('sourceId'); const next=sources.value.some(s=>s.id===selected.value)?selected.value:sources.value.some(s=>s.id===saved)?saved:sources.value[0]?.id || ''; if(next!==selected.value) changeSource(next) } catch { sourceError.value='无法读取影视源，请检查网络后重试' } }
async function changeSource(id) { ++categoryEpoch; ++listEpoch; ++detailEpoch; controller?.abort(); listController?.abort(); selected.value=id; localStorage.setItem('sourceId',id); cats.value=[]; videos.value=[]; results.value=[]; type.value=''; page.value=1; pageCount.value=1; total.value=0; query.value=''; searched.value=''; all.value=false; searchAll.value=false; catError.value=''; listError.value=''; closeDetail(); if(!id){catLoading.value=false;loading.value=false;return} loadCategories(); loadList() }
async function loadCategories() { const epoch=++categoryEpoch; const id=selected.value; controller?.abort(); controller=new AbortController(); if(!id)return; catLoading.value=true;catError.value='';try{const d=await api('/api/categories?'+q({sourceId:id}),{signal:controller.signal});if(epoch===categoryEpoch)cats.value=d.categories}catch(e){if(epoch===categoryEpoch&&e.name!=='AbortError'){catError.value=e.message;if(e.status===404)await refreshSources()}}finally{if(epoch===categoryEpoch)catLoading.value=false} }
async function loadList() { const epoch=++listEpoch; const sourceId=selected.value; listController?.abort(); listController=new AbortController(); videos.value=[]; results.value=[]; listError.value=''; if(!sourceId)return; loading.value=true; try { if(searched.value) { const d=await api('/api/search?'+q({sourceId,wd:searched.value,page:page.value,all:searchAll.value?'1':''}),{signal:listController.signal}); if(epoch!==listEpoch)return; results.value=d.results; videos.value=d.results.flatMap(r=>r.list.map(v=>({...v,sourceId:r.sourceId,sourceName:r.sourceName}))); pageCount.value=Math.max(page.value,...d.results.map(r=>r.pageCount)); if(d.results.every(r=>r.error))listError.value='搜索失败，请检查影视源' } else { const d=await api('/api/videos?'+q({sourceId,page:page.value,typeId:type.value}),{signal:listController.signal}); if(epoch!==listEpoch)return; videos.value=d.list.map(v=>({...v,sourceId})); page.value=d.page; pageCount.value=d.pageCount; total.value=d.total } } catch(e){if(epoch===listEpoch&&e.name!=='AbortError'){listError.value=e.message;if(e.status===404)await refreshSources()}} finally {if(epoch===listEpoch)loading.value=false} }
function selectType(id){type.value=id;page.value=1;searched.value='';query.value='';all.value=false;searchAll.value=false;loadList()}
function search(){searched.value=query.value.trim();page.value=1; if(!searched.value)all.value=false; searchAll.value=all.value; loadList()}
function turnPage(n){page.value=n;loadList();window.scrollTo({top:0,behavior:'smooth'})}
function cancelSeekCheck(){clearTimeout(seekTimer);++seekGeneration}
function checkSeekFrame(){
  if(restoringSeek){restoringSeek=false;return}
  cancelSeekCheck()
  const el=videoEl.value, generation=seekGeneration, epoch=playEpoch
  if(!el || typeof el.getVideoPlaybackQuality!=='function')return
  const quality=el.getVideoPlaybackQuality(), frames=quality.totalVideoFrames-quality.droppedVideoFrames, time=el.currentTime
  seekTimer=setTimeout(()=>{
    if(generation!==seekGeneration || epoch!==playEpoch || videoEl.value!==el || el.paused || el.ended || el.seeking || el.currentTime-time<1)return
    const now=el.getVideoPlaybackQuality()
    if(now.totalVideoFrames-now.droppedVideoFrames>frames)return
    if(hls){hls.recoverMediaError();return}
    const position=el.currentTime
    el.addEventListener('loadedmetadata',()=>{
      if(generation!==seekGeneration || epoch!==playEpoch || videoEl.value!==el)return
      try{restoringSeek=true;el.currentTime=position;el.play().catch(()=>{})}catch{playerError.value='画面恢复失败，请切换线路重试'}
    },{once:true})
    el.load()
  },5000)
}
async function openDetail(v){ cancelSeekCheck(); const epoch=++detailEpoch; ++playEpoch;detailTarget.value=v;hls?.destroy();hls=null;movie.value=null; detailError.value=''; detailLoading.value=true; try {const d=await api('/api/detail?'+q({sourceId:v.sourceId,vodId:v.id}));if(epoch!==detailEpoch)return;movie.value=d;line.value=0;episode.value=0;detailLoading.value=false;await nextTick();if(epoch===detailEpoch)play()}catch(e){if(epoch===detailEpoch){detailError.value=e.message;if(e.status===404)await refreshSources()}}finally{if(epoch===detailEpoch)detailLoading.value=false} }
function closeDetail(){restoringSeek=false;cancelSeekCheck();++detailEpoch;++playEpoch;movie.value=null;detailTarget.value=null;detailError.value='';detailLoading.value=false;hls?.destroy();hls=null}
async function play(){restoringSeek=false;cancelSeekCheck();const epoch=++playEpoch;hls?.destroy();hls=null;playerError.value='';const url=movie.value?.lines[line.value]?.episodes[episode.value]?.url;const el=videoEl.value;if(!el)return;el.pause();el.removeAttribute('src');el.load();if(!url){playerError.value='暂无可播放的剧集';return}let u;try{u=new URL(url);if(!['http:','https:'].includes(u.protocol))throw 0}catch{playerError.value='不支持此播放地址';return}if(/\.m3u8(?:$|[?#])/i.test(url)){if(el.canPlayType('application/vnd.apple.mpegurl'))el.src=url;else{try{const {default:Hls}=await import('hls.js');if(epoch!==playEpoch||videoEl.value!==el)return;if(!Hls.isSupported()){playerError.value='当前浏览器不支持 HLS';return}hls=new Hls();hls.on(Hls.Events.ERROR,(_,d)=>{if(d.fatal&&epoch===playEpoch)playerError.value='播放失败，资源可能不可用或不允许跨域访问'});hls.loadSource(url);hls.attachMedia(el)}catch{if(epoch===playEpoch)playerError.value='播放器加载失败，请检查网络后重试'}}}else if(/\.mp4(?:$|[?#])/i.test(url))el.src=url;else playerError.value='不支持此播放地址格式，仅支持 MP4 和 HLS'}
function pickLine(i){line.value=i;episode.value=0;play()} function pickEpisode(i){episode.value=i;play()}
async function adminLoad(){try{adminSources.value=await api('/api/admin/sources');const proxy=await api('/api/admin/proxy');proxyForm.value={enabled:proxy.enabled,url:''};proxyConfigured.value=proxy.configured;logged.value=true}catch{logged.value=false}}
async function saveProxy(){adminMessage.value='';try{await api('/api/admin/proxy',{method:'POST',body:JSON.stringify(proxyForm.value)});await adminLoad();adminMessage.value='代理设置已保存';if(selected.value){loadCategories();loadList()}}catch(e){adminMessage.value=e.message}}
function parseImport(text) {
  let result='', inString=false, escaped=false
  for (let i=0;i<text.length;i++) {
    const ch=text[i]
    if (inString) { result+=ch; if (escaped) escaped=false; else if (ch==='\\') escaped=true; else if (ch==='"') inString=false; continue }
    if (ch==='"') { inString=true; result+=ch; continue }
    if (ch===',' && /^[\s]*[}\]]/.test(text.slice(i+1))) continue
    result+=ch
  }
  return JSON.parse(result.replace(/^\uFEFF/, ''))
}
async function importSources(event) {
  const file=event.target.files?.[0]; event.target.value=''; if(!file)return
  adminMessage.value=''
  try {
    if(file.size>1024*1024) throw new Error('文件不能超过 1 MiB')
    let data; try { data=parseImport(await file.text()) } catch { throw new Error('JSON 格式无效，请检查文件内容') }
    const result=await api('/api/admin/sources/import',{method:'POST',body:JSON.stringify(data)})
    await adminLoad(); await refreshSources()
    adminMessage.value=`导入成功：新增 ${result.added} 条，跳过重复地址 ${result.skipped} 条`
  } catch(e) { adminMessage.value=e.message }
}
async function exportSources() {
  adminMessage.value=''
  try {
    const data=await api('/api/admin/sources/export')
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}))
    const link=document.createElement('a'); link.href=url; link.download='sources.json'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000)
    adminMessage.value=`已导出 ${data.length} 条影视源`
  } catch(e) { adminMessage.value=e.message }
}
async function login(){adminMessage.value='';try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({password:password.value})});password.value='';await adminLoad()}catch(e){adminMessage.value=e.message}}
async function saveSource(){adminMessage.value='';try{const savedId=editing.value;const payload={...form.value};if(savedId&&!payload.url)delete payload.url;await api('/api/admin/sources'+(savedId?'/'+savedId:''),{method:savedId?'PATCH':'POST',body:JSON.stringify(payload)});form.value={name:'',url:'',enabled:true};editing.value='';await adminLoad();await refreshSources();if(savedId&&payload.url&&selected.value===savedId)changeSource(savedId);adminMessage.value='保存成功'}catch(e){adminMessage.value=e.message}}
async function testSource(){adminMessage.value='测试中…';try{const d=await api('/api/admin/test',{method:'POST',body:JSON.stringify({sourceId:editing.value})});adminMessage.value=`连接成功，发现 ${d.categoryCount} 个分类`}catch(e){adminMessage.value=e.message}}
function edit(s){editing.value=s.id;form.value={name:s.name,url:'',enabled:s.enabled};adminMessage.value=''}
async function remove(s){if(!confirm(`确定删除“${s.name}”吗？`))return;try{await api('/api/admin/sources/'+s.id,{method:'DELETE'});await adminLoad();await refreshSources()}catch(e){adminMessage.value=e.message}}
async function toggle(s){try{await api('/api/admin/sources/'+s.id,{method:'PATCH',body:JSON.stringify({enabled:!s.enabled})});await adminLoad();await refreshSources()}catch(e){adminMessage.value=e.message}}
onMounted(async()=>{try{await api('/api/session');authenticated.value=true;await refreshSources()}catch(e){if(e.status!==401)accessError.value='无法连接服务器，请刷新页面重试'}finally{checkingSession.value=false}})
</script>
<template>
<div v-if="checkingSession" class="access-screen"><p class="subtle">正在验证登录状态…</p></div>
<div v-else-if="!authenticated" class="access-screen"><form class="access-card" @submit.prevent="accessLogin"><div class="eyebrow">LIGHT CINEMA</div><h1>欢迎来到轻映</h1><p class="subtle">请输入访问密码</p><label for="access-password">访问密码</label><input id="access-password" v-model="accessPassword" type="password" autocomplete="current-password" required><p v-if="accessError" class="error" role="alert">{{accessError}}</p><button :disabled="accessBusy">{{accessBusy ? '验证中…' : '进入'}}</button></form></div>
<template v-else>
<header><div class="top"><a class="brand" href="/">轻<span>映</span><small>LIGHT CINEMA</small></a><div class="top-actions"><button class="ghost" @click="section=section==='movies'?'live':'movies';closeDetail()">{{section==='movies'?'直播':'影视'}}</button><button class="ghost" @click="showAdmin=true;adminLoad()">源管理 ↗</button></div></div></header>
<main><LivePlayer v-if="section==='live'" :api="api" :key="liveVersion"/><template v-else><section class="hero"><div><div class="eyebrow"><i></i> YOUR CINEMA, YOUR SOURCES</div><h1>好故事，<br><em>从这里开始。</em></h1><p>在你信任的影视源中，发现值得一看的内容。</p></div><div class="hero-mark">映<span>✳</span></div></section>
<section class="toolbar"><div><label for="source">当前影视源</label><select id="source" :value="selected" @change="changeSource($event.target.value)"><option v-if="!sources.length" value="">暂无可用影视源</option><option v-for="s in sources" :key="s.id" :value="s.id">{{s.name}}</option></select></div><form class="search" @submit.prevent="search"><input v-model="query" placeholder="搜索片名..." aria-label="搜索片名"><label class="check"><input type="checkbox" v-model="all"> 全站</label><button>搜索 ↗</button></form></section>
<section v-if="sourceError && !sources.length" class="empty"><p>{{sourceError}}</p><button @click="refreshSources">重试</button></section><section v-else-if="!sources.length" class="empty"><div class="empty-icon">✳</div><h2>还没有影视源</h2><p>请先在源管理中添加已授权的苹果 CMS 影视源。</p><button @click="showAdmin=true;adminLoad()">前往源管理 ↗</button></section>
<template v-else><nav class="categories"><span class="section-label">浏览分类</span><button :class="{active:!type&&!searched}" @click="selectType('')">全部</button><button v-for="c in cats" :key="c.id" :class="{active:type===c.id&&!searched}" @click="selectType(c.id)">{{c.name}}</button><span v-if="catLoading" class="subtle">分类加载中…</span><span v-if="catError" class="error">分类加载失败：{{catError}} <button @click="loadCategories">重试</button></span></nav>
<div class="list-heading"><div><div class="eyebrow">{{searched ? 'SEARCH RESULTS' : 'EXPLORE'}}</div><h2>{{searched ? '搜索结果' : '发现好片'}}<span> / {{sourceName}}</span></h2></div><div class="subtle">{{searched ? (searchAll ? '全站搜索' : '当前源搜索') + ' · ' + searched : total ? `共 ${total} 部` : '精选内容'}}</div></div>
<div v-if="loading" class="empty compact">正在加载影片…</div><div v-else-if="listError" class="empty compact"><p>{{listError}}</p><button @click="loadList">重试</button></div><div v-else-if="!videos.length" class="empty compact">暂无影片</div><div v-else class="grid"><button v-for="v in videos" :key="v.sourceId+':'+v.id" class="card" @click="openDetail(v)"><div class="poster"><img v-if="v.poster" :src="v.poster" :alt="v.name" referrerpolicy="no-referrer" @error="$event.target.style.display='none'"><span class="placeholder">映</span><span v-if="v.remarks" class="badge">{{v.remarks}}</span></div><div class="card-title">{{v.name || '未命名影片'}}</div><div class="meta">{{v.sourceName && searchAll ? v.sourceName + ' · ' : ''}}{{v.year || v.updated || '影视作品'}}</div></button></div><p v-for="r in results.filter(r=>r.error)" :key="r.sourceId" class="error">{{r.sourceName}}：{{r.error}}</p><div v-if="!loading&&!listError" class="pagination"><button :disabled="page<=1" @click="turnPage(page-1)">← 上一页</button><span>{{page}} <span class="subtle">/ {{pageCount}}</span></span><button :disabled="page>=pageCount" @click="turnPage(page+1)">下一页 →</button></div></template>
</template></main><footer><span>轻映 <b>✳</b></span><span>内容来自你添加的影视源 · 请使用已授权资源</span></footer>
<div v-if="movie||detailLoading||detailError" class="overlay" @click.self="closeDetail"><div class="modal detail"><button class="close" @click="closeDetail">✕</button><p v-if="detailLoading">正在加载详情…</p><div v-else-if="detailError"><p class="error">{{detailError}}</p><button @click="openDetail(detailTarget)">重试</button></div><template v-else><div class="eyebrow">NOW PLAYING</div><h2>{{movie.name}}</h2><img v-if="movie.poster" class="detail-poster" :src="movie.poster" :alt="movie.name + '海报'" referrerpolicy="no-referrer" @error="$event.target.style.display='none'"><video ref="videoEl" controls playsinline @seeking="cancelSeekCheck" @seeked="checkSeekFrame" @error="playerError='播放失败，资源可能不可用'"></video><p v-if="playerError" class="error">{{playerError}}</p><div class="choices"><button v-for="(l,i) in movie.lines" :key="i" :class="{active:line===i}" @click="pickLine(i)">{{l.name}}</button></div><div class="choices"><button v-for="(e,i) in movie.lines[line]?.episodes" :key="i" :class="{active:episode===i}" @click="pickEpisode(i)">{{e.name}}</button></div><div class="choices"><button :disabled="episode===0" @click="pickEpisode(episode-1)">上一集</button><button :disabled="episode >= (movie.lines[line]?.episodes.length || 1)-1" @click="pickEpisode(episode+1)">下一集</button></div><p class="description">{{movie.description || '暂无简介'}}</p></template></div></div>
<div v-if="showAdmin" class="overlay" @click.self="showAdmin=false"><div class="modal"><button class="close" @click="showAdmin=false">✕</button><div class="eyebrow">SOURCE MANAGEMENT</div><h2>影视源管理</h2><p class="subtle">添加你有权使用的苹果 CMS JSON 接口。</p><form v-if="!logged" @submit.prevent="login"><label>管理员密码</label><input v-model="password" type="password" autocomplete="current-password" required><button>登录</button></form><template v-else><div class="choices"><button :class="{active:adminTab==='sources'}" @click="adminTab='sources';adminMessage=''">影视源</button><button :class="{active:adminTab==='live'}" @click="adminTab='live';adminMessage=''">&#30452;&#25773;&#28304;</button><button :class="{active:adminTab==='proxy'}" @click="adminTab='proxy';adminMessage=''">代理设置</button></div><LiveAdmin v-if="adminTab==='live'" :api="api"/><form v-else-if="adminTab==='proxy'" @submit.prevent="saveProxy"><h3>代理设置</h3><label>HTTP 代理地址</label><input v-model="proxyForm.url" type="url" :placeholder="proxyConfigured ? '已配置，留空保持原地址' : 'http://127.0.0.1:7890'"><label class="check"><input type="checkbox" v-model="proxyForm.enabled"> 启用代理</label><p class="subtle">代理用于后端请求影视源 API，支持 HTTP CONNECT；本机代理地址应从服务运行环境访问。</p><button>保存代理设置</button></form><template v-else><div class="choices"><label class="import-button">导入 JSON<input type="file" accept=".json,application/json" hidden @change="importSources"></label><button type="button" class="ghost" @click="exportSources">导出 JSON</button></div><p class="subtle">导入会追加新源，并跳过地址重复的源。导出包含完整地址，请妥善保管。</p><div v-for="s in adminSources" :key="s.id" class="source-row"><div><strong>{{s.name}}</strong><small>{{s.enabled?'已启用':'已禁用'}}</small></div><div><button class="ghost" @click="edit(s)">编辑</button><button class="ghost" @click="toggle(s)">{{s.enabled?'禁用':'启用'}}</button><button class="ghost" @click="remove(s)">删除</button></div></div><form @submit.prevent="saveSource"><h3>{{editing?'编辑影视源':'添加影视源'}}</h3><label>名称</label><input v-model="form.name" required maxlength="80"><label>API 地址</label><input v-model="form.url" type="url" :required="!editing" :placeholder="editing ? '留空保持原地址，输入新地址可替换' : 'https://.../api.php/provide/vod/'"><label class="check"><input type="checkbox" v-model="form.enabled"> 启用此源</label><p class="subtle">测试连接前，请先保存并启用源；更改地址后需先保存。</p><div class="choices"><button type="button" class="ghost" :disabled="!editing || !!form.url || !form.enabled" @click="testSource">测试连接</button><button>保存</button><button v-if="editing" type="button" class="ghost" @click="editing='';form={name:'',url:'',enabled:true}">取消</button></div></form></template></template><p v-if="adminMessage" class="message">{{adminMessage}}</p></div></div>
</template>
</template>




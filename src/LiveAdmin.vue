<script setup>
import { ref, computed } from 'vue'
import { parsePlaylist, previewChannels } from './liveImport.js'
import { mergeLiveChannels } from '../server/liveGrouping.js'
const props=defineProps({api:{type:Function,required:true}})
const channels=ref([]), sources=ref([]), sourceId=ref('legacy'), message=ref(''), editing=ref(''), preview=ref(null), playlistUrl=ref(''), fetching=ref(false)
const blank=()=>({name:'',group:'',enabled:true,streams:[{name:'线路 1',url:'',type:'hls'}]})
const form=ref(blank())
let loadEpoch=0
const selectedPreview=computed(()=>{if(!preview.value)return null;const selected=new Set(preview.value.selected);return previewChannels(preview.value.data.filter((_,i)=>selected.has(i)),[])})
function preparePreview(data,issues,newSource){
  data=mergeLiveChannels(data)
  const result=previewChannels(data,[],issues)
  result.parseIssues=issues
  result.newSource=newSource
  result.selected=data.map((_,i)=>i)
  preview.value=result
}
async function load(){const epoch=++loadEpoch,id=sourceId.value;try{const [nextSources,nextChannels]=await Promise.all([props.api('/api/admin/live/sources'),props.api('/api/admin/live/channels?sourceId='+encodeURIComponent(id))]);if(epoch===loadEpoch){sources.value=nextSources;channels.value=nextChannels}}catch(e){if(epoch===loadEpoch)message.value=e.message}}
async function changeSource(){preview.value=null;reset();await load()}
async function removeSource(){const source=sources.value.find(s=>s.id===sourceId.value);if(!source||source.id==='legacy'||!confirm(`确定删除直播源“${source.name}”及其全部频道吗？`))return;try{await props.api('/api/admin/live/sources/'+source.id,{method:'DELETE'});sourceId.value='legacy';reset();preview.value=null;await load();message.value='直播源已删除'}catch(e){message.value=e.message}}
function edit(c){editing.value=c.id;form.value=JSON.parse(JSON.stringify(c));message.value=''}
function reset(){editing.value='';form.value=blank()}
async function save(){try{await props.api('/api/admin/live/channels'+(editing.value?'/'+editing.value:''),{method:editing.value?'PATCH':'POST',body:JSON.stringify({...form.value,sourceId:sourceId.value})});reset();await load();message.value='频道已保存'}catch(e){message.value=e.message}}
async function toggle(c){try{await props.api('/api/admin/live/channels/'+c.id,{method:'PATCH',body:JSON.stringify({enabled:!c.enabled})});await load()}catch(e){message.value=e.message}}
async function remove(c){if(!confirm(`确定删除“${c.name}”吗？`))return;try{await props.api('/api/admin/live/channels/'+c.id,{method:'DELETE'});if(editing.value===c.id)reset();await load()}catch(e){message.value=e.message}}
async function move(i,delta){const ids=channels.value.map(c=>c.id), j=i+delta;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];try{await props.api('/api/admin/live/order',{method:'POST',body:JSON.stringify({ids,sourceId:sourceId.value})});await load()}catch(e){message.value=e.message}}
async function fileChange(e){
  const file=e.target.files?.[0]; e.target.value=''; if(!file)return
  preview.value=null; message.value=''
  try {
    if(file.size>1024*1024)throw new Error('文件不能超过 1 MiB')
    const text=await file.text(); let data,issues=[]
    if(/\.json$/i.test(file.name)){
      let json; try{json=JSON.parse(text.replace(/^\uFEFF/,''))}catch{throw new Error('JSON 格式无效')}
      if(json?.version!==1||!Array.isArray(json.channels))throw new Error('不支持的直播配置格式')
      data=json.channels
    }else{const parsed=parsePlaylist(text);data=parsed.result;issues=parsed.issues}
    preparePreview(data,issues,{name:file.name.slice(0,80),url:''})
  }catch(err){message.value=err.message}
}
async function importUrl(){
  preview.value=null;message.value=''
  let url
  try { url=new URL(playlistUrl.value.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw 0 }
  catch {message.value='请输入有效的 HTTP(S) 播放列表地址';return}
  fetching.value=true
  try{
    const {text}=await props.api('/api/admin/live/fetch-playlist',{method:'POST',body:JSON.stringify({url:url.href})})
    let data,issues=[]
    if (/^\s*[{\[]/.test(text.replace(/^\uFEFF/,''))) {
      let json;try{json=JSON.parse(text.replace(/^\uFEFF/,''))}catch{throw new Error('JSON 格式无效')}
      if(json?.version!==1||!Array.isArray(json.channels))throw new Error('不支持的 JSON 格式，请使用直播配置 JSON、M3U 或 TXT 列表')
      data=json.channels
    }else{const parsed=parsePlaylist(text);data=parsed.result;issues=parsed.issues}
    preparePreview(data,issues,{name:(url.hostname+url.pathname).slice(0,80),url:url.href})
    if(!data.length)message.value='未找到可导入的频道，请确认地址指向 M3U 或 TXT 频道列表'
  }catch(e){message.value=e.message}
  finally{fetching.value=false}
}
async function commit(){try{const d=await props.api('/api/admin/live/import',{method:'POST',body:JSON.stringify({version:1,channels:selectedPreview.value.data,newSource:preview.value.newSource})});sourceId.value=d.sourceId;preview.value=null;reset();await load();message.value=`导入完成：新增 ${d.added} 个频道，跳过 ${d.skipped} 条重复线路`}catch(e){message.value=e.message}}
async function exportFile(){try{const data=await props.api('/api/admin/live/export?sourceId='+encodeURIComponent(sourceId.value));const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='live-channels.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message.value='已导出直播配置'}catch(e){message.value=e.message}}
load()
</script>
<template><div><div class="choices"><label class="import-button">导入 M3U / TXT / JSON<input type="file" accept=".m3u,.m3u8,.txt,.json" hidden @change="fileChange"></label><button @click="exportFile">导出 JSON</button></div><form class="playlist-url" @submit.prevent="importUrl"><label for="playlist-url">从网址导入 M3U / TXT 频道列表</label><input id="playlist-url" v-model="playlistUrl" type="url" placeholder="https://.../channels.m3u 或 live.txt" required><button :disabled="fetching">{{fetching ? '读取中…' : '读取并预览'}}</button></form><p class="subtle">服务器读取列表；导入是一次性的。播放地址需由浏览器访问，列表源与频道流可能有不同的跨域或地区限制。</p><p class="subtle">每次导入创建独立直播源，频道只在该源内去重。导出当前源的频道，文件包含完整播放地址，请妥善保管。</p><div class="live-source-select"><label for="admin-live-source">管理直播源</label><select id="admin-live-source" v-model="sourceId" @change="changeSource"><option v-for="s in sources" :key="s.id" :value="s.id">{{s.name}}</option></select><button v-if="sourceId!=='legacy'" type="button" @click="removeSource">删除直播源</button></div><div v-if="preview" class="live-preview"><strong>导入预览：{{preview.count}} 个频道，已选 {{preview.selected.length}} 个，{{selectedPreview.duplicates}} 条重复线路</strong><label for="import-source-name">直播源名称</label><input id="import-source-name" v-model="preview.newSource.name" maxlength="80" placeholder="直播源名称"><p class="subtle">默认选择全部频道，可取消或勾选后确认导入。</p><div class="choices"><button type="button" @click="preview.selected=preview.data.map((_,i)=>i)">全选</button><button type="button" @click="preview.selected=[]">清空选择</button></div><ul><li v-for="(item,i) in preview.rows" :key="i"><label><input v-model="preview.selected" type="checkbox" :value="i"> {{item.location}}：{{item.name}} · {{item.group || '未分组'}} · {{item.streamCount}} 条线路</label></li></ul><p v-for="(issue,i) in [...preview.parseIssues,...selectedPreview.issues]" :key="i" class="error">{{issue}}</p><div class="choices"><button :disabled="selectedPreview.invalid || !selectedPreview.added || !preview.newSource.name.trim()" @click="commit">确认导入</button><button @click="preview=null">取消</button></div></div><div v-for="(c,i) in channels" :key="c.id" class="source-row"><div><strong>{{c.name}}</strong><small>{{c.group || '未分组'}} · {{c.streams.length}} 条线路 · {{c.enabled?'已启用':'已禁用'}}</small></div><div><button class="ghost" :disabled="i===0" @click="move(i,-1)">上移</button><button class="ghost" :disabled="i===channels.length-1" @click="move(i,1)">下移</button><button class="ghost" @click="edit(c)">编辑</button><button class="ghost" @click="toggle(c)">{{c.enabled?'禁用':'启用'}}</button><button class="ghost" @click="remove(c)">删除</button></div></div><form @submit.prevent="save"><h3>{{editing?'编辑频道':'添加频道'}}</h3><label>频道名称</label><input v-model="form.name" maxlength="80" required><label>分组</label><input v-model="form.group" maxlength="80"><label class="check"><input type="checkbox" v-model="form.enabled"> 启用频道</label><div v-for="(s,i) in form.streams" :key="s.id || i" class="live-stream"><label>线路名称</label><input v-model="s.name" maxlength="80" required><label>播放地址</label><input v-model="s.url" type="url" maxlength="2048" required placeholder="https://..."><label>类型</label><select v-model="s.type"><option value="hls">HLS</option><option value="mp4">MP4</option></select><div class="choices"><button type="button" :disabled="i===0" @click="[form.streams[i-1],form.streams[i]]=[form.streams[i],form.streams[i-1]]">上移</button><button type="button" :disabled="i===form.streams.length-1" @click="[form.streams[i+1],form.streams[i]]=[form.streams[i],form.streams[i+1]]">下移</button><button type="button" :disabled="form.streams.length===1" @click="form.streams.splice(i,1)">删除线路</button></div></div><div class="choices"><button type="button" @click="form.streams.push({name:`线路 ${form.streams.length+1}`,url:'',type:'hls'})">添加线路</button><button>保存频道</button><button v-if="editing" type="button" @click="reset">取消编辑</button></div></form><p v-if="message" class="message" role="status">{{message}}</p></div></template>













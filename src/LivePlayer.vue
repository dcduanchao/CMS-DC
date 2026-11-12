<script setup>
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { mergeLiveChannels } from '../server/liveGrouping.js'
const props=defineProps({api:{type:Function,required:true}})
const sources=ref([]), sourceId=ref(''), channels=ref([]), group=ref(''), query=ref(''), selected=ref(null), stream=ref(0), video=ref(null), error=ref(''), status=ref(''), loading=ref(true), channelsLoading=ref(false)
const groups=computed(()=>[...new Set(channels.value.map(c=>c.group || '未分组'))])
const filtered=computed(()=>channels.value.filter(c=>(!group.value || (c.group || '未分组')===group.value) && c.name.toLowerCase().includes(query.value.trim().toLowerCase())))
let hls, epoch=0, sourceEpoch=0
function stop(){++epoch;hls?.destroy();hls=null;const el=video.value;if(el){el.pause();el.removeAttribute('src');el.load()}}
async function load(){loading.value=true;error.value='';try{sources.value=await props.api('/api/live/sources')}catch(e){error.value=e.message}finally{loading.value=false}}
async function changeSource(){const current=++sourceEpoch;stop();selected.value=null;channels.value=[];group.value='';query.value='';error.value='';status.value='';if(!sourceId.value){channelsLoading.value=false;return}channelsLoading.value=true;try{const result=await props.api('/api/live/channels?sourceId='+encodeURIComponent(sourceId.value));if(current===sourceEpoch)channels.value=mergeLiveChannels(result)}catch(e){if(current===sourceEpoch)error.value=e.message}finally{if(current===sourceEpoch)channelsLoading.value=false}}
async function play(c,i=0){stop();selected.value=c;stream.value=i;error.value='';status.value='正在加载…';await nextTick();const el=video.value, current=++epoch, item=c.streams[i];if(!el||!item)return
  try{if(item.type==='hls' && !el.canPlayType('application/vnd.apple.mpegurl')){const {default:Hls}=await import('hls.js');if(current!==epoch)return;if(!Hls.isSupported())throw new Error('当前浏览器不支持 HLS');hls=new Hls();hls.on(Hls.Events.ERROR,(_,d)=>{if(d.fatal && current===epoch){status.value='';error.value='播放失败，请检查资源、浏览器支持和跨域设置，或切换线路'}});hls.loadSource(item.url);hls.attachMedia(el)}else el.src=item.url
    try{await el.play()}catch(e){if(current===epoch){status.value='';if(e.name==='NotAllowedError')status.value='请点击播放器的播放按钮开始观看';else if(e.name!=='AbortError')error.value='播放失败，请检查资源和浏览器支持，或切换线路'}}
  }catch(e){if(current===epoch){status.value='';error.value=e.message || '播放器加载失败'}}
}
onBeforeUnmount(()=>{sourceEpoch++;stop()});load()
</script>
<template>
<section class="live-page">
  <div class="list-heading"><div><div class="eyebrow">LIVE TV</div><h2>直播频道</h2></div></div>
  <div v-if="loading" class="empty compact">正在加载直播源…</div>
  <div v-else-if="error && !sources.length" class="empty compact"><p class="error">{{error}}</p><button @click="load">重试</button></div>
  <div v-else-if="!sources.length" class="empty compact">暂无直播源，请联系管理员配置。</div>
  <template v-else>
    <div class="toolbar"><div><label for="live-source">选择直播源</label><select id="live-source" v-model="sourceId" @change="changeSource"><option value="">请先选择直播源</option><option v-for="s in sources" :key="s.id" :value="s.id">{{s.name}}</option></select></div></div>
    <div v-if="!sourceId" class="empty compact">请选择直播源查看频道。</div>
    <div v-else-if="channelsLoading" class="empty compact">正在加载频道…</div>
    <div v-else-if="error && !channels.length" class="empty compact"><p class="error">{{error}}</p><button @click="changeSource">重试</button></div>
    <div v-else-if="!channels.length" class="empty compact">此直播源暂无可用频道。</div>
    <template v-else>
      <div class="toolbar"><div><label for="live-group">频道分组</label><select id="live-group" v-model="group"><option value="">全部分组</option><option v-for="g in groups" :key="g">{{g}}</option></select></div><div class="search"><input v-model="query" placeholder="搜索频道" aria-label="搜索频道"><button class="ghost" @click="query='';group=''">清除筛选</button></div></div>
      <div class="live-layout"><div><div v-if="!filtered.length" class="empty compact">没有匹配的频道，请清除筛选。</div><div class="choices"><button v-for="c in filtered" :key="c.id" :class="{active:selected?.id===c.id}" @click="play(c)">{{c.name}}</button></div></div>
      <div><template v-if="selected"><h3>{{selected.name}}</h3><video ref="video" controls playsinline @playing="status=''" @waiting="status='正在缓冲…'" @error="status='';error='播放失败，请检查资源和浏览器支持，或切换线路'"></video><p v-if="status" class="subtle">{{status}}</p><p v-if="error" class="error" role="alert">{{error}}</p><div class="choices"><button v-for="(s,i) in selected.streams" :key="s.id" :class="{active:stream===i}" @click="play(selected,i)">{{s.name}}</button><button @click="play(selected,stream)">重试</button></div></template><p v-else class="subtle">选择频道开始观看</p></div></div>
    </template>
  </template>
</section>
</template>


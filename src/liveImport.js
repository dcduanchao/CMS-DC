const MAX_SIZE = 2048
function normalizeUrl(value) {
  if (typeof value !== 'string' || value.trim().length > MAX_SIZE) return null
  try {
    const u = new URL(value.trim())
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.href.length <= MAX_SIZE ? u.href : null
  } catch { return null }
}
function validText(value, required = true) { return typeof value === 'string' && (!required || !!value.trim()) && value.trim().length <= 80 }
function infoComma(value) {
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"') quoted = !quoted
    else if (value[i] === ',' && !quoted) return i
  }
  return -1
}
export function parseM3u(text) {
  const result = [], issues = []
  let meta = null
  for (const [i, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim(), number = i + 1
    if (!line) continue
    if (line.startsWith('#EXTINF:')) {
      if (meta) issues.push(`第 ${meta.line} 行：缺少播放地址`)
      const comma = infoComma(line)
      meta = { name: comma >= 0 ? line.slice(comma + 1).trim() : '', group: line.match(/group-title="([^"]*)"/i)?.[1] || '', line: number }
      continue
    }
    if (line.startsWith('#')) {
      if (!line.startsWith('#EXTM3U')) issues.push(`第 ${number} 行：忽略扩展指令`)
      continue
    }
    const url = normalizeUrl(line)
    if (!url || !meta || !validText(meta.name) || !validText(meta.group, false)) {
      issues.push(`第 ${number} 行：地址或频道信息无效`); meta = null; continue
    }
    result.push({ name: meta.name, group: meta.group, enabled: true, streams: [{name:'线路 1',url,type:/\.mp4(?:$|[?#])/i.test(url) ? 'mp4' : 'hls'}], _line: number })
    meta = null
  }
  if (meta) issues.push(`第 ${meta.line} 行：缺少播放地址`)
  return {result, issues}
}
export function parseTvBox(text) {
  const result=[], issues=[]
  let group=''
  for(const [i,raw] of text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
    const line=raw.trim(), number=i+1
    if(!line || line.startsWith('#'))continue
    const comma=line.indexOf(',')
    if(comma<0){issues.push(`第 ${number} 行：缺少频道名称或地址`);continue}
    const name=line.slice(0,comma).trim(), value=line.slice(comma+1).trim()
    if(value.toLowerCase()==='#genre#'){
      if(!validText(name)){issues.push(`第 ${number} 行：分组名称无效`);group=''}else group=name
      continue
    }
    const url=normalizeUrl(value)
    if(!validText(name)||!url){issues.push(`第 ${number} 行：频道名称或 HTTP(S) 地址无效`);continue}
    result.push({name,group,enabled:true,streams:[{name:'线路 1',url,type:/\.mp4(?:$|[?#])/i.test(url)?'mp4':'hls'}],_line:number})
  }
  return {result,issues}
}
export function parsePlaylist(text) {
  return /^\uFEFF?\s*#EXTM3U(?:\s|$)/i.test(text) || /^\s*#EXTINF:/im.test(text) ? parseM3u(text) : parseTvBox(text)
}
export function previewChannels(data, existing, initialIssues = []) {
  const issues = [...initialIssues], urls = new Set(existing.flatMap(c => c.streams.map(s => normalizeUrl(s.url))))
  let duplicates = 0, invalid = false, added = 0
  const rows = data.map((c, i) => {
    const location = c?._line ? `第 ${c._line} 行` : `第 ${i + 1} 项`
    if (!c || !validText(c.name) || !validText(c.group ?? '', false) || !Array.isArray(c.streams) || !c.streams.length || (c.enabled != null && typeof c.enabled !== 'boolean')) {
      issues.push(`${location}：频道格式无效`); invalid = true
      return {location, name: c?.name || '无效频道', group: '', streamCount: 0, state: '格式无效'}
    }
    let fresh = 0
    for (const s of c.streams) {
      const url = normalizeUrl(s?.url)
      if (!url || !validText(s?.name) || !['hls','mp4'].includes(s?.type)) { issues.push(`${location}：线路格式无效`); invalid = true; continue }
      if (urls.has(url)) { duplicates++; issues.push(`${location}：地址重复，将跳过`) }
      else { urls.add(url); fresh++ }
    }
    if (fresh) added++
    return {location, name:c.name, group:c.group || '', streamCount:c.streams.length, state:fresh ? `预计新增 ${fresh} 条线路` : '重复，将跳过'}
  })
  return {data, rows, issues, duplicates, added, invalid, count:data.length}
}

function channelKey(name) {
  const normalized=name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ')
  const cctv=normalized.match(/^cctv[\s-]*(\d+)(?:\s*(\+|plus))?$/)
  return cctv ? `cctv${cctv[1]}${cctv[2]?'+':''}` : normalized
}
export function mergeLiveChannels(channels) {
  const result=[], byName=new Map()
  for(const item of channels){
    if(!item || typeof item.name!=='string' || !item.name.trim() || !Array.isArray(item.streams)){result.push(item);continue}
    const key=channelKey(item.name), previous=byName.get(key)
    if(!previous){const copy={...item,streams:item.streams.map(s=>s && typeof s==='object'?{...s}:s)};result.push(copy);byName.set(key,copy);continue}
    for(const stream of item.streams){
      if(!stream || typeof stream!=='object'){previous.streams.push(stream);continue}
      const name=typeof stream.name==='string' && !/^线路\s*\d+$/i.test(stream.name) ? stream.name : `线路 ${previous.streams.length+1}`
      previous.streams.push({...stream,name})
    }
  }
  return result
}

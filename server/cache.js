// Bound serialized payload size as well as entry count. Expired entries are
// pruned on writes; reads promote entries so frequently used data is retained.
export class ResponseCache {
  constructor({ maxBytes = 16 * 1024 * 1024, maxEntries = 200, ttl = 30000 } = {}) {
    this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.ttl = ttl
    this.bytes = 0; this.entries = new Map()
  }
  delete(key) { const item = this.entries.get(key); if (item) { this.bytes -= item.bytes; this.entries.delete(key) } }
  get(key, now = Date.now()) {
    const item = this.entries.get(key)
    if (!item) return undefined
    if (item.until <= now) { this.delete(key); return undefined }
    this.entries.delete(key); this.entries.set(key, item)
    return item.data
  }
  set(key, data, now = Date.now()) {
    for (const [oldKey, item] of this.entries) if (item.until <= now) this.delete(oldKey)
    this.delete(key)
    const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
    if (bytes > this.maxBytes || this.maxEntries < 1) return
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.delete(this.entries.keys().next().value)
    this.entries.set(key, { data, bytes, until: now + this.ttl }); this.bytes += bytes
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ResponseCache } from '../server/cache.js'

test('缓存限制字节数和条数，淘汰最近最少使用项并清理过期项', () => {
  const cache=new ResponseCache({maxBytes:30,maxEntries:2,ttl:100})
  cache.set('a',{v:'a'},0);cache.set('b',{v:'b'},0)
  assert.deepEqual(cache.get('a',1),{v:'a'})
  cache.set('c',{v:'c'},2)
  assert.equal(cache.get('b',2),undefined);assert.deepEqual(cache.get('a',2),{v:'a'})
  cache.set('large',{v:'x'.repeat(40)},2);assert.equal(cache.get('large',2),undefined)
  cache.set('d',{v:'d'},101);assert.equal(cache.get('a',101),undefined);assert.deepEqual(cache.get('d',101),{v:'d'});assert.ok(cache.bytes<=30)
  const small=new ResponseCache({maxBytes:18,maxEntries:10});small.set('a',{v:'aaaa'},0);small.set('b',{v:'bbbb'},0);assert.equal(small.get('a',1),undefined);assert.deepEqual(small.get('b',1),{v:'bbbb'});assert.ok(small.bytes<=18)
})

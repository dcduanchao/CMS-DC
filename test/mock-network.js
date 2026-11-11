// Loaded only by the integration-test subprocess, never by the application.
// Keep all source traffic on the local mock server while exercising real HTTP.
import dns from 'node:dns/promises'
import http from 'node:http'

const originalLookup = dns.lookup
dns.lookup = async (hostname, options) => hostname.endsWith('.mock.invalid')
  ? hostname === 'mixed.mock.invalid' ? [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}] : [{ address: '8.8.8.8', family: 4 }]
  : originalLookup(hostname, options)
const originalGet = http.get
http.get = function (url, options, callback) {
  if (url.hostname.endsWith('.mock.invalid')) {
    const target = new URL(url)
    target.hostname = '127.0.0.1'
    target.port = process.env.MOCK_CMS_PORT
    return originalGet.call(this, target, { ...options, lookup: undefined, headers: { ...options.headers, 'x-mock-host': url.hostname } }, callback)
  }
  return originalGet.call(this, url, options, callback)
}

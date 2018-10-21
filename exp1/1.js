const http = require('http')
const url = require('url')
const net = require('net')
const fs = require('fs')
const Duplex = require('stream').Duplex
// no external dependency

const hostname = '127.0.0.1'
const port = '8888'
// block url, block info
const blockList = new Map([
    // ['www.4399.com', 'blocked'],
    ['1.bilabila.cn', 'bilabila blocked']
])
// redirect url
const redirectList = new Map([
    ['1.4399.com', 'https://baidu.com'],
    // ['www.gamersky.com', 'http://bilabila.cn'],
])
// user agent allowed
const uaAllow = ua => ua && ua.toLowerCase().includes('chrome')
// cache response
const cachePool = (size = 20) => {
    const cache = new Map()
    // key=url+method+headers
    const key = req => JSON.stringify({ ...url.parse(req.url), method: req.method, headers: req.headers })
    return {
        set(req, res) {
            // value=[buffer,hit,response]
            const v = [undefined, 1, res]
            const k = key(req)
            cache.set(k, v)
            // stream to buffer
            const data = []
            res.on('data', d => { data.push(d) })
            res.on('end', () => { v[0] = Buffer.concat(data) })
            console.log('cache add: ', cache.size, (new Date).toISOString())
                // remove the least hit
                ; (async () => {
                    if (cache.size > size) {
                        let min = size + 5, index
                        for (let e of cache) {
                            if (e[1][1] < min) {
                                min = e[1][1]
                                index = e[0]
                            }
                        }
                        cache.delete(index)
                    }
                })()
        },
        get(req) {
            const k = key(req)
            const v = cache.get(k)
            // if buffer defined
            if (v && v[0]) {
                console.log('cache hit', (new Date).toISOString())
                // hit +1
                v[1]++
                // buffer to stream
                const stream = new Duplex()
                stream.push(v[0])
                stream.push(null)
                // stream, cache response
                return [stream, v[2]]
            }
            return []
        }
    }
}
// cache 500 response
const cache = cachePool(500)
//request mode for http
const request = (req, res) => {
    const ua = req.headers['user-agent']
        , u = url.parse(req.url)
        , block = blockList.get(u.hostname)
        , redirect = redirectList.get(u.hostname)
        , allow = uaAllow(ua)
        , [cacheStream, cacheRes] = cache.get(req)
        , opt = {
            hostname: u.hostname,
            port: u.port,
            path: u.path,
            method: req.method,
            headers: req.headers
        }
    if (block) {
        res.end(block)
    } else if (redirect) {
        res.writeHead(302, { 'Location': redirect })
        res.end()
    } else if (!allow) {
        res.end('user-agent blocked')
    } else if (cacheRes) { // cache hit
        // request with if-modified-since
        const lastModified = req.headers['if-modified-since'] || cacheRes.headers['last-modified'] || ''
        opt.headers['if-modified-since'] = lastModified
        http.request(opt, res => {
            console.log('if-modified-since:', lastModified, res.statusCode)
            if (res.statusCode !== 304) {
                cache.set(req, res)
                console.log('cache update', (new Date).toISOString())
            }
        }).end()
        if (!cacheRes.headers['last-modified'])
            cacheRes.headers['last-modified'] = (new Date).toUTCString()
        res.writeHead(cacheRes.statusCode, cacheRes.headers)
        cacheStream.pipe(res, { end: true })
    } else { // cache not hit
        http.request(opt, pRes => {
            if (!pRes.headers['last-modified'])
                pRes.headers['last-modified'] = (new Date).toUTCString()
            res.writeHead(pRes.statusCode, pRes.headers);
            cache.set(req, pRes)
            pRes.pipe(res, { end: true })
        }).end()
    }
}

http.createServer()
    .on('request', request)
    .listen(port, hostname, () => {
        console.log(`proxy run: ${hostname}:${port}`)
    })
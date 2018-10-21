const EventEmitter = require('events')
const dgram = require('dgram')
const readline = require('readline')

let address = 'localhost'
let port = 60000
let messages = Buffer.from('abcdefghijklmnopqrstuvwxyz1')
let messages2 = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
const dual = true
let dropRate = 0.2
let time = 500
let segmentSize = 3
const windowSize = 8
let expectedSeq = 0
class Window extends EventEmitter {
    constructor(num = 8) {
        super()
        this.num = num
        // interface index
        this.base = this.nextseq = 0
        // circular array index
        this.left = this.right = 0
        this.cache = [...Array(num)]
        this.cacheSize = 0
    }
    addIndex(x, y = 1) {
        return (x + y) % this.num
    }
    addBase(ack) {
        const before = this.base
        this.base = (ack === undefined ? this.base : ack)
        if (before < this.base) {
            this.left = this.addIndex(this.base, 0)
            if (this.right >= this.left) this.cacheSize = this.right - this.left
            else this.cacheSize = this.num - (this.left - this.right)
            this.emit('move')
            // console.log('window move', 'base:', this.base)
            return true
        }
        // wrong ack
    }
    addSeq(chunk) {
        // add to cache
        this.cache[this.right] = chunk
        this.right = this.addIndex(this.right)
        this.cacheSize++
        this.nextseq++
    }
    isFull() {
        return this.cacheSize === this.num
    }
    getCache() {
        if (this.isFull() || this.right < this.left) {
            return [...this.cache.slice(this.left), ...this.cache.slice(0, this.right)]
        } else {
            // this.right > this.left or empty 
            return this.cache.slice(this.left, this.right)
        }
    }
}
class Timeout {
    constructor(fn, timeout) {
        this.fn = fn
        this.time = timeout
    }
    start() {
        if (!this.exist) {
            this.exist = true
            this.timeout = setTimeout(() => {
                this.exist = false
                this.fn()
            }, this.time)
        }
    }
    clear() {
        clearTimeout(this.timeout)
        this.exist = false
    }
    restart() {
        this.clear()
        this.start()
    }
}
const window = new Window()
const timeout = new Timeout(reSend, time)
const server = dgram.createSocket('udp4').on('listening', () => {
    const info = server.address()
    console.log('server start', info.address, ':', info.port)
}).on('message', message)
const log = (pre, message, next = [], limit = 10) => {
    if (message.byteLength <= limit)
        console.log(...pre, message.toString(), ...next)
    else
        console.log(...pre, 'byteLength', message.byteLength, ...next)
}
const sendSegment = (seq, data, callback) => {
    // data length > 1
    if (!Buffer.isBuffer(data) || data.byteLength === 0) return
    // one byte 0-255
    seq = Buffer.alloc(1, seq)
    data = Buffer.concat([seq, data])
    server.send(data, port, address, callback)
}
function message(message, rinfo) {
    // random drop ack and data
    if (Math.random() < (typeof dropRate === 'undefined' ? 0 : dropRate)) return
    // receive data
    if (message.byteLength > 1) {
        const seq = message[0]
        log(['<= receive segment', seq], message.slice(1), ['expected', expectedSeq])
        // expected ack
        if (seq === expectedSeq) expectedSeq++
        // send ack(not expected seq send ack too)
        port = rinfo.port
        server.send(Buffer.alloc(1, expectedSeq), port)
        console.log('<= send ack', expectedSeq)
        return
    }
    // receive ack, the first byte is ack
    const ack = message[0]
    console.log('=> receive ack', ack)
    const isRightAck = window.addBase(ack)
    // drop unrelated ack
    if (!isRightAck) return
    if (window.base !== window.nextseq) {
        timeout.restart()
    } else {
        timeout.clear()
        console.log('===finish===')
        server.emit('mfinish')
    }
}
function reSend() {
    console.log('===resend===')
    timeout.restart()
    window.getCache().forEach((chunk, index) => {
        sendSegment(window.base + index, chunk)
        log(['=> resend segment', window.base + index], chunk)
    })
}
function sendMessage(messages) {
    const message = messages.slice(0, segmentSize)
    messages = messages.slice(segmentSize)
    if (message.byteLength === 0) return
    sendSegment(window.nextseq, message)
    log(['=> send segment', window.nextseq], message)
    if (window.base === window.nextseq) {
        timeout.start()
    }
    window.addSeq(message)
    if (window.isFull()) {
        // if window full, wait window move
        // console.log('window full')
        window.once('move', () => {
            // console.log('window space available')
            sendMessage(messages)
        })
    } else {
        sendMessage(messages)
    }
}   
const portAvailable = port => new Promise((resolve, reject) => {
    const tester = dgram.createSocket('udp4')
        .once('error', err => (err.code == 'EADDRINUSE' ? resolve(false) : reject(err)))
        .once('listening', () => tester.once('close', () => resolve(true)).close())
        .bind(port)
})
const bindPort = async () => {
    const result = await portAvailable(port)
    if (result) {
        server.bind(port)
        server.once('message', (_, rinfo) => {
            // get remote info
            port = rinfo.port
            address = rinfo.address
            // start send to remote
            if (typeof dual !== 'undefined' && dual) sendMessage(messages)
        })
    } else {
        // bind to another port
        server.bind(() => {
            sendMessage(messages2)
        })
    }
}
bindPort()
const rl = readline.createInterface({
    input: process.stdin,
})
server.once('mfinish', () => {
    rl.on('line', input => {
        // 3 byte for chinese charactor
        segmentSize = 3
        sendMessage(Buffer.from(input))
    })
})
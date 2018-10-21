const EventEmitter = require('events')
const dgram = require('dgram')
const readline = require('readline')
let address = 'localhost'
let port = 60000
let messages = Buffer.from('abcdefghijklmnopqrstuvwxyz1')
let messages2 = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
// const dual = true
let dropRate = 0.2
let time = 500
let segmentSize = 1
let windowSize = 8
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
        return this
    }
    clear() {
        clearTimeout(this.timeout)
        this.exist = false
        return this
    }
    restart() {
        this.clear()
        this.start()
        return this

    }
}
class SWindow extends EventEmitter {
    constructor(num = 8) {
        super()
        this.num = num
        // interface index
        this.base = this.nextseq = 1
        // circular array index
        this.left = this.right = 1
        this.cache = [...Array(num)]
        this.timeout = [...Array(num)]
        this.cacheSize = 0
    }
    addIndex(x, y = 1) {
        return (x + y) % this.num
    }
    addBase(ack) {
        if (this.base <= ack && ack <= this.base + this.num) {
            // clear this timeout
            this.timeout[this.addIndex(ack, 0)].clear()
            this.cache[this.addIndex(ack, 0)] = undefined
            // this.timeout[this.addIndex(ack, 0)] = undefined
            // move 
            while (this.cache[this.left] === undefined && this.cacheSize > 0) {
                this.base++
                this.left = this.addIndex(this.left)
                this.cacheSize = (this.right >= this.left) ? this.cacheSize = this.right - this.left
                    : this.num - (this.left - this.right)
                this.emit('move')
                console.log('move')
            }
            return true
        }

        // wrong ack
    }
    addSeq(chunk, ...args) {
        // add to cache
        this.cache[this.right] = chunk
        this.timeout[this.right] = (new Timeout(...args)).start()
        this.right = this.addIndex(this.right)
        this.cacheSize++
        this.nextseq++
    }
    isFull() {
        return this.cacheSize === this.num
    }
    // restart timeout
    restart(seq) {
        this.timeout[seq % this.num].restart()
    }
}
class RWindow extends EventEmitter {
    constructor(num = 8) {
        super()
        this.num = num
        // interface index
        this.base = 1
        // circular array index
        this.left = 1
        this.cache = [...Array(num)]
    }
    addIndex(x, y = 1) {
        return (x + y) % this.num
    }
    addBase(ack, chunk) {
        // not in [base-N,base+N-1]
        if (this.base - this.num > ack || ack >= this.base + this.num) return false
        if (this.base <= ack && this.cache[this.addIndex(ack, 0)] === undefined) {
            // not duplicate
            this.cache[this.addIndex(ack, 0)] = chunk
            // deliver
            while (this.cache[this.left] !== undefined) {
                this.emit('deliver', this.base, this.cache[this.left])
                this.cache[this.left] = undefined
                this.base++
                this.left = this.addIndex(this.left)
            }
        }
        return true
    }
}

const log = (pre, message, next = [], limit = 10) => {
    if (message.byteLength <= limit)
        console.log(...pre, message.toString(), ...next)
    else
        console.log(...pre, 'byteLength', message.byteLength, ...next)
}
const sWindow = new SWindow(windowSize)
const rWindow = new RWindow(windowSize)
rWindow.on('deliver', (seq, chunk) => {
    log(['<= deliver', seq], chunk)
})
// const timeout = new Timeout(reSend, time)
const server = dgram.createSocket('udp4').on('listening', () => {
    const info = server.address()
    console.log('server start', info.address, ':', info.port)
}).on('message', message)
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
        log(['<= receive segment', seq], message.slice(1), ['expected', rWindow.base])
        // expected ack
        const isRightAck = rWindow.addBase(seq, message.slice(1))
        if (!isRightAck) return
        // send ack if ack in range
        port = rinfo.port
        address = rinfo.address
        server.send(Buffer.alloc(1, seq), port, address)
        console.log('<= send ack', seq)
        return
    }
    // receive ack, the first byte is ack
    const ack = message[0]
    console.log('=> receive ack', ack)
    const isRightAck = sWindow.addBase(ack)
    // drop unrelated ack
    if (!isRightAck) return
    if (sWindow.base === sWindow.nextseq) {
        console.log('===finish===')
        // if (typeof dual === 'undefined' || !dual) server.close()
        server.emit('mfinish')
    }
}
function reSend(seq, chunk) {
    sWindow.restart(seq)
    sendSegment(seq, chunk)
    log(['=> resend segment', seq], chunk)
}
function sendMessage(messages) {
    const message = messages.slice(0, segmentSize)
    messages = messages.slice(segmentSize)
    if (message.byteLength === 0) return
    sendSegment(sWindow.nextseq, message)
    log(['=> send segment', sWindow.nextseq], message)
    // sWindow.start(sWindow.nextseq, fn, time)
    sWindow.addSeq(message, ((seq, message) => () => reSend(seq, message))(sWindow.nextseq, message), time)
    if (sWindow.isFull()) {
        // if sWindow full, wait sWindow move
        sWindow.once('move', () => {
            console.log('sWindow space available')
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
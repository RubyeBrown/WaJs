import WebSocket from "ws";
import {
    WhatsAppCmdType, WhatsAppCmdAction, WhatsAppClientConfig,
    WANode, BinNode, AsyncTagHandler
} from "./interfaces";
import { Color, L, E } from "../utils";
import { hmacDecrypt, hmacEncrypt } from "./secure";
import { readNode } from "./binary/reader";
import WhatsApp from ".";
import BinaryOutputStream from "./binary/output-stream";
import { writeNode } from "./binary/writer";
import BinaryInputStream from "./binary/input-stream";

/** Dynamic handler form promise */
export const commandTagHandlers = new Map<String, AsyncTagHandler>()

export class WASocket {
    private messageConter: number = 0
    public sock: WebSocket
    private shortTagBase: string = `${Math.floor(Date.now() / 1000) % 1000}`
    /** For detection iddle time after initial setup */
    public lastReceived: number
    private watchdogTimer: NodeJS.Timer

    constructor(private wa: WhatsApp, private config: WhatsAppClientConfig
    ) {
        wa.on('chats-loaded', () => this.watchdogTimer = setInterval(this.watchdog, 5000))
        this.sock = new WebSocket("wss://web.whatsapp.com/ws", {
            origin: "https://web.whatsapp.com",
        })
        this.sock.on('error', (...args) => wa.emit('error', ...args))
        this.sock.on('open', (...args) => wa.emit('open', ...args))
        this.sock.on('close', (...args) => {
            this.stopWatchdog()
            wa.emit('close', ...args)
        })
        this.sock.on('message', (data: string | Buffer) => {
            let firstCommaPos = data.indexOf(',');
            let id: string;
            let message: string | Buffer;
            this.lastReceived = Date.now()
            const logs: any[] = [Color.g("<<")]
            if (firstCommaPos < 0) {
                if (typeof data == 'string') {
                    id = data
                    message = ''
                } else {
                    id = ''
                    message = data
                    logs.push(Color.r('no id'))
                }
            } else {
                id = data.slice(0, firstCommaPos).toString('ascii')
                message = data.slice(firstCommaPos + 1)
            }

            logs.push(Color.g(id))
            let parsed: WANode | object = null;
            if (message instanceof Buffer) {
                logs.push(Color.b('BIN'))
                try {
                    message = hmacDecrypt(this.config.aesKey, this.config.macKey, message)
                    parsed = readNode(new BinaryInputStream(message))
                } catch (error) {
                    logs.push(Color.r(error))
                    L(...logs)
                    return;
                }
            } else if (message) {
                if (message.length && (message[0] == '[' || message[0] == '{')) {
                    logs.push(Color.b('JSON'))
                    parsed = JSON.parse(message)
                } else {
                    logs.push(Color.r('(!) Cannot parse'))
                }
            } else {
                logs.push(Color.b('NULL'))
                logs.push(Color.y("Ignored"));
                L(...logs);
                return;
            }

            if (commandTagHandlers.has(id)) {
                logs.push(Color.g('[handled]'))
                let handle = commandTagHandlers.get(id)
                commandTagHandlers.delete(id)
                L(...logs)
                try {
                    handle.tag = id
                    handle.callback.call(handle, parsed)
                } catch (error) {
                    E('callback error', error)
                }
                // Stop here, is expected message
                return
            }

            let emitEvents: any[];
            const logsPos = logs.length

            switch (id[0]) {
                case '!':
                    let ts = parseInt(id.slice(1))
                    emitEvents = ['timeskew', ts, parsed]
                    break;

                case 's':
                    if (Array.isArray(parsed)) {
                        const cmd = parsed.shift()
                        logs.push(cmd)
                        emitEvents = ['server-message', cmd, parsed]
                    } else {
                        logs.push(Color.r('(!) Not array'), parsed)
                    }
                    break;
                case 'p':
                    if (id.indexOf('preempt') === 0) {
                        logs.push(parsed[1] && parsed[1].type || '???')
                        emitEvents = ['preempt', parsed]
                    } else {
                        // I dont know to handle it
                        logs.push(Color.r('Prefixed with p but not preempt!'))
                    }
                    break
            }

            if (emitEvents) {
                // insert event name on logs
                logs.splice(logsPos, 0, Color.m(`[E:${emitEvents[0]}]`))
                L(...logs)
                this.wa.emit.apply(this.wa, emitEvents)
                // Just emit the event
                return
            }
            if (id.match(/^\d+-\d+$/) || id.match(/^[0-9a-f]+\.--[0-9a-f]+$/)) {
                if (Array.isArray(parsed)) {
                    if (!parsed[0]) {
                        logs.push(Color.r('node with empty cmd!'), parsed)
                    } else {
                        L(...logs)
                        this.wa.binaryHandle(parsed as BinNode)
                        // Handled
                        return;
                    }
                } else {
                    logs.push(Color.r('BinData not array!'), parsed.constructor && parsed.constructor.name || parsed)
                }
            } else {
                logs.push(Color.r('NO ACTION'), parsed)
            }

            L(...logs)
        })

    }

    private watchdog = () => {
        if (Date.now() - this.lastReceived < 20000) {
            return;// not now
        }
        // Send keep alive
        this.sock.send('?,,', (e) => {
            if (e) {
                E('Watchdog fail')
                this.stopWatchdog()
            } else {
                L(Color.y('>> watchdog ?,,'))
            }
        })
    }
    stopWatchdog = () => {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer)
            this.watchdogTimer = null
        }
    }

    sendRaw(data, cb: (err?: Error) => void) {
        return this.sock.send(data, cb)
    }
    shortTag() {
        return `${this.shortTagBase}.--${this.messageConter++}`
    }
    tag() {
        return `${Math.floor(Date.now() / 1000)}.--${this.messageConter++}`
    }

    send<T = any>(message: Buffer | string, hint?: string, tag?: string, binaryOptions?: Uint8Array) {
        if (!tag)
            tag = this.tag()

        return new Promise<T>(
            (resolve, reject) => {
                let taggedMessage: string | Buffer;
                const options: { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean } = {
                    compress: false,
                    mask: true,
                    fin: true
                }
                if (typeof message == 'string') {
                    taggedMessage = `${tag},${message}`
                    options.binary = false
                } else {
                    // encrypt
                    message = hmacEncrypt(this.config.aesKey, this.config.macKey, message)
                    const bufs: Uint8Array[] = [Buffer.from(`${tag},`, 'ascii')]

                    if (binaryOptions) {
                        bufs.push(binaryOptions)
                    }
                    bufs.push(message)
                    taggedMessage = Buffer.concat(bufs)
                    options.binary = true
                }
                commandTagHandlers.set(tag, { sentMessage: message, callback: resolve, hint })
                L(Color.y('>> ' + tag), Color.b(options.binary ? 'BIN' : 'STR'), hint, taggedMessage.length)
                this.sock.send(taggedMessage, options, err => err ? reject(err) : null)
            }
        )
    }

    sendCmd<T = any>(scope: WhatsAppCmdType, cmd: WhatsAppCmdAction, ...args: Array<string | boolean | any[]>) {
        return this.send<T>(
            JSON.stringify([scope, cmd, ...args]),
            `${scope},${cmd}`
        )
    }

    sendBin<T = any>(cmd: string, attr: any, data?: any, hint?: string) {
        const msg = [cmd, attr, data]
        return this.send<T>(
            Buffer.from(JSON.stringify(msg), 'ascii'),
            hint,
            this.shortTag()
        )
    }

    sendNode(node: BinNode, tag?: string, binaryOptions?: Uint8Array) {
        const bos = new BinaryOutputStream()
        writeNode(bos, node)
        const buf = bos.toBuffer()
        return this.send(
            buf,
            'node:' + node[0],
            tag || this.shortTag(),
            binaryOptions
        )
    }

    close() {
        if (this.sock && this.sock.readyState == this.sock.OPEN) {
            this.sock.close()
        }
    }
}

export default WASocket
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import pino from 'pino'
import { PaintBoardManager } from './paintboard'
import { type TokenRequest, PaintResultCode, type WebSocketData, type banUidData } from './types'
import Bun from 'bun'
import workerpool from 'workerpool'

// 添加 logger 到全局作用域
declare global {
	var logger: pino.Logger
	var pool: workerpool.Pool
}
const logger = pino({
	transport: {
		target: 'pino-pretty',
		options: {
			ignore: 'pid,hostname'
		}
	}
})
globalThis.logger = logger

const pool = workerpool.pool({
	workerType: 'web'
})
globalThis.pool = pool

const configSchema = z.strictObject({
	logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
	port: z.number(),
	paintDelay: z.number().min(0),
	useDB: z.boolean().default(false),
	width: z.number().min(1).default(1000),
	height: z.number().min(1).default(600),
	clearBoard: z.boolean().default(false),
	validationPaste: z.string().default('IkaPaintBoard'),
	key: z.string().optional(),
	cert: z.string().optional(),
	maxWebSocketPerIP: z.number().min(0).default(0),
	banDuration: z.number().min(0).default(60000),
	ticksPerSecond: z.number().min(1).default(128),
	maxPacketPerSecond: z.number().min(1).default(128),
	enableTokenCounting: z.boolean().default(false),
	maxAllowedUID: z.number().optional(),
	banToken: z.string().optional(),
})

let config: z.infer<typeof configSchema>
try {
	const configFile = await Bun.file('./config.yml').text()
	const parsedConfig = parseYaml(configFile)
	config = configSchema.parse(parsedConfig)
	logger.info({ config }, 'Config loaded')
} catch (error) {
	logger.error({ error }, 'Unable to load config')
	process.exit(1)
}

logger.level = config.logLevel

const colorHash = (id: number) => {
	// ANSI escape codes for some colors
	const colors = [
		'\x1b[31m', // red
		'\x1b[32m', // green
		'\x1b[33m', // yellow
		'\x1b[34m', // blue
		'\x1b[35m', // magenta
		'\x1b[36m', // cyan
		'\x1b[37m' // white
	]
	const hash = id % colors.length
	const color = colors[hash]
	return `${color}#${id}\x1b[0m`
}

let webSocketConnectionCount = 0

// IP 连接统计
const ipConnections = new Map<string, Bun.ServerWebSocket<WebSocketData>[]>()

// IP 封禁记录
const bannedIPs = new Map<string, number>()

// UID 封禁记录
const bannedUIDs = new Set<number>()

// 检查 IP 是否被封禁
function isBanned(ip: string): boolean {
	const banUntil = bannedIPs.get(ip)
	if (!banUntil) return false

	if (Date.now() >= banUntil) {
		bannedIPs.delete(ip)
		return false
	}
	return true
}

// 封禁指定 IP
function banIP(ip: string) {
	bannedIPs.set(ip, Date.now() + config.banDuration)
	logger.warn(`IP ${ip} banned for ${config.banDuration}ms`)
}

// 添加全局计数器
let globalPacketsReceived = 0
let globalPacketsSent = 0

// 添加服务器刻追踪
let lastTick = 0

let nextConnId = 1

const server = Bun.serve<WebSocketData>({
	static: {
		'/api': new Response('IkaPaintBoard Made by Ikaleio :)', {
			headers: {
				'Access-Control-Allow-Origin': '*'
			}
		}),
		'/dev/frontend': new Response(
			await Bun.file('./static/index.html').bytes(),
			{
				headers: {
					'Content-Type': 'text/html',
					'Access-Control-Allow-Origin': '*'
				}
			}
		)
	},
	fetch: async (req: Request, server) => {
		const ip = server.requestIP(req)

		// 检查是否被封禁
		if (ip && isBanned(ip.address)) {
			return new Response('Too Many Requests', {
				status: 429,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Retry-After': Math.ceil(
						(bannedIPs.get(ip.address)! - Date.now()) / 1000
					).toString()
				}
			})
		}

		// 处理 CORS 预检请求
		if (req.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type'
				}
			})
		}

		const url = new URL(req.url)

		// WebSocket 升级请求处理
		if (url.pathname === '/api/paintboard/ws') {
			if (
				server.upgrade(req, {
					data: {
						connectedAt: Date.now()
					}
				})
			) {
				return
			}
			return new Response('Upgrade failed', {
				status: 500,
				headers: {
					'Access-Control-Allow-Origin': '*'
				}
			})
		}

		// HTTP API 处理
		if (url.pathname === '/api/paintboard/getboard') {
			const startTime = Date.now()
			const [compressed, bufferSize] = await pool.exec<
				// 这脑残 WorkerPool 没有原生类型支持
				(
					arg0: SharedArrayBuffer,
					arg1: number,
					arg2: number
				) => [Uint8Array, number]
			>(
				(pixels: SharedArrayBuffer, width: number, height: number) => {
					const gzipped = Bun.gzipSync(new Uint8Array(pixels))
					return [gzipped, width * height * 3]
				},
				[paintboard.getSharedArrayBuffer(), config.width, config.height]
			)
			logger.debug(
				`getboard: ${Date.now() - startTime}ms (gzip) ${bufferSize} -> ${
					compressed.length
				} (${(compressed.length / bufferSize).toFixed(2)}x)`
			)
			return new Response(compressed, {
				headers: {
					'Content-Type': 'application/octet-stream',
					'Access-Control-Allow-Origin': '*',
					'Content-Encoding': 'gzip'
				}
			})
		}

		if (url.pathname === '/api/paintboard/getimage') {
			const startTime = Date.now()
			const [compressed, bufferSize] = await pool.exec<
				(
					arg0: SharedArrayBuffer,
					arg1: number,
					arg2: number
				) => Promise<[Buffer, number]>
			>(
				async (pixels: SharedArrayBuffer, width: number, height: number) => {
					const sharp = await import('sharp')
					const image = sharp.default(new Uint8Array(pixels), {
						raw: {
							width,
							height,
							channels: 3
						}
					})
					const webpBuffer = await image.webp({ lossless: true }).toBuffer()
					return [webpBuffer, width * height * 3]
				},
				[paintboard.getSharedArrayBuffer(), config.width, config.height]
			)
			logger.debug(
				`getimage: ${
					Date.now() - startTime
				}ms (webp-lossless) ${bufferSize} -> ${compressed.length} (${(
					compressed.length / bufferSize
				).toFixed(2)}x)`
			)
			return new Response(compressed, {
				headers: {
					'Content-Type': 'image/webp',
					'Access-Control-Allow-Origin': '*'
				}
			})
		}

		if (url.pathname === '/api/auth/gettoken' && req.method === 'POST') {
			return await handleTokenRequest(req)
		}
		
		if (url.pathname === '/api/root/banuid' && req.method === 'POST') {
			const body = (await req.json()) as banUidData
			if (body.token !== config.botToken) {
				return new Response('Unauthorized', {
					status: 401,
					headers: {
						'Access-Control-Allow-Origin': '*'
					}
				})
			}
			bannedUIDs.add(body.uid)
			return new Response('OK', {
				status: 200,
				headers: {
					'Access-Control-Allow-Origin': '*'
				}
			})
		}
		if (url.pathname === '/api/root/unbanuid' && req.method === 'POST') {
			const body = (await req.json()) as banUidData
			if (body.token !== config.botToken) {
				return new Response('Unauthorized', {
					status: 401,
					headers: {
						'Access-Control-Allow-Origin': '*'
					}
				})
			}
			bannedUIDs.delete(body.uid)
			return new Response('OK', {
				status: 200,
				headers: {
					'Access-Control-Allow-Origin': '*'
				}
			})
		}

		return new Response('Not Found', {
			status: 404,
			headers: {
				'Access-Control-Allow-Origin': '*'
			}
		})
	},
	idleTimeout: 120,
	websocket: {
		idleTimeout: 60, // 60s
		sendPings: false, // 已经有自定义 ping 机制了
		publishToSelf: true, // 很明显要发给自己
		open(ws) {
			const ip = ws.remoteAddress
			ws.data.ip = ip
			ws.data.connId = nextConnId++ // 分配连接ID
			ws.data.sendBuffer = new Bun.ArrayBufferSink()
			ws.data.sendBuffer.start({
				asUint8Array: true,
				stream: true
			})

			// 检查是否被封禁
			if (isBanned(ip)) {
				ws.close(1008, 'IP is banned')
				return
			}

			// 获取或创建该 IP 的连接数组
			let connections = ipConnections.get(ip)
			if (!connections) {
				connections = []
				ipConnections.set(ip, connections)
			}

			// 检查是否超过限制
			if (
				config.maxWebSocketPerIP > 0 &&
				connections.length >= config.maxWebSocketPerIP
			) {
				// 触发封禁
				banIP(ip)
				// 断开该 IP 的所有连接
				for (const conn of connections) {
					conn.close(1008, 'IP connection limit exceeded')
				}
				ipConnections.delete(ip)
				logger.warn(`IP ${ip} exceeded WebSocket limit and got banned`)
				ws.close(1008, 'IP connection limit exceeded')
				return
			}

			connections.push(ws)
			webSocketConnectionCount++
			logger.debug(
				`${colorHash(
					ws.data.connId
				)} ${ip} WebSocket connected: ${webSocketConnectionCount} clients online`
			)
			ws.subscribe('paint')

			// 初始化最后响应时间和 ping 标记
			ws.data.lastPing = Date.now()
			ws.data.waitingPong = false
			ws.data.packetsReceived = 0
			ws.data.lastPacketCountReset = Date.now()

			// 初始化第一次ping的发送
			ws.data.nextPingDelay = Math.floor(Math.random() * 29000) + 1000 // 1-30秒
			ws.data.pingTimer = setTimeout(() => sendPing(ws), ws.data.nextPingDelay)
			if (config.enableTokenCounting) {
				ws.data.tokenUsageCount = new Set() // 只在启用时初始化
			}
		},
		close(ws) {
			// 清理所有定时器
			if (ws.data.pingTimer) {
				clearTimeout(ws.data.pingTimer)
			}
			if (ws.data.pongTimer) {
				clearTimeout(ws.data.pongTimer)
			}

			ws.data.sendBuffer.flush()
			const ip = ws.data.ip
			const connections = ipConnections.get(ip)
			if (connections) {
				const index = connections.indexOf(ws)
				if (index > -1) {
					connections.splice(index, 1)
				}
				if (connections.length === 0) {
					ipConnections.delete(ip)
				}
			}
			webSocketConnectionCount--
			logger.debug(
				`${colorHash(
					ws.data.connId
				)} WebSocket closed: ${webSocketConnectionCount} clients remaining`
			)
		},
		message(ws, msg: Buffer) {
			if (ws.readyState !== 1) return

			const now = Date.now()

			// 检查是否需要重置计数
			if (now - ws.data.lastPacketCountReset >= 1000) {
				ws.data.packetsReceived = 0
				ws.data.lastPacketCountReset = now
			}

			// 更新接收计数并检查限制
			ws.data.packetsReceived++
			if (ws.data.packetsReceived > config.maxPacketPerSecond) {
				const ip = ws.data.ip
				logger.warn(
					`Client ${ip} exceeded packet rate limit (${ws.data.packetsReceived} > ${config.maxPacketPerSecond}), banning for 15s`
				)
				// 设置15秒封禁
				bannedIPs.set(ip, Date.now() + 15000)
				// 断开该 IP 的所有连接
				const connections = ipConnections.get(ip)
				if (connections) {
					for (const conn of connections) {
						conn.close(1013, 'Packet rate limit exceeded')
					}
					ipConnections.delete(ip)
				}
				return
			}

			// 原有的消息处理逻辑
			globalPacketsReceived++

			try {
				// 使用 DataView 解析二进制数据
				const dataView = new DataView(msg.buffer)
				let offset = 0

				// 循环处理所有包
				while (offset < msg.length) {
					const type = dataView.getUint8(offset)
					offset += 1

					switch (type) {
						case 0xfb: // C2S pong
							if (!ws.data.waitingPong) {
								// 如果服务端未发送ping就收到pong，直接关闭连接
								logger.warn(
									`${colorHash(ws.data.connId)} Received unexpected pong from ${
										ws.data.ip
									}`
								)
								ws.close(1002, 'Protocol violation: unexpected pong')
								return
							}

							// 清除pong等待定时
							if (ws.data.pongTimer) {
								clearTimeout(ws.data.pongTimer)
								ws.data.pongTimer = undefined
							}

							// 更新状态
							ws.data.waitingPong = false
							ws.data.lastPing = Date.now()

							// 设置下一次ping
							ws.data.nextPingDelay = Math.floor(Math.random() * 29000) + 1000 // 1-30秒
							ws.data.pingTimer = setTimeout(
								() => sendPing(ws),
								ws.data.nextPingDelay
							)
							break

						case 0xfe: {
							// C2S paint (31字节)
							const x = dataView.getUint16(offset, true) // 添加 true 表示小端序
							const y = dataView.getUint16(offset + 2, true)
							const color = {
								r: dataView.getUint8(offset + 4),
								g: dataView.getUint8(offset + 5),
								b: dataView.getUint8(offset + 6)
							}
							const uid =
								dataView.getUint8(offset + 7) +
								dataView.getUint8(offset + 8) * 256 +
								dataView.getUint8(offset + 9) * 65536

							// 处理 token (16字节)
							const tokenBytes = new Uint8Array(msg.buffer, offset + 10, 16)
							const token = [
								Buffer.from(tokenBytes.slice(0, 4)).toString('hex'),
								Buffer.from(tokenBytes.slice(4, 6)).toString('hex'),
								Buffer.from(tokenBytes.slice(6, 8)).toString('hex'),
								Buffer.from(tokenBytes.slice(8, 10)).toString('hex'),
								Buffer.from(tokenBytes.slice(10, 16)).toString('hex')
							].join('-')

							const id = dataView.getUint32(offset + 26, true)
							offset += 30

							if (config.enableTokenCounting) {
								ws.data.tokenUsageCount.add(token)
							}
							let result = 0x00
							if (bannedUIDs.has(uid))
							{
								result = PaintResultCode.NO_PERMISSION
							}
							else
							{
								result = paintboard.validateToken(token, uid)
								if (result === PaintResultCode.SUCCESS) {
									const success = paintboard.setPixel(x, y, color)
									if (!success) {
										result = PaintResultCode.BAD_FORMAT
									}
								}
							}

							const response = new Uint8Array([
								0xff,
								id & 255,
								(id >> 8) & 255,
								(id >> 16) & 255,
								(id >> 24) & 255,
								result
							])
							ws.data.sendBuffer.write(response) // S2C paint_result
							break
						}

						default:
							logger.warn(
								`${colorHash(ws.data.connId)} Unknown packet type: ${type}`
							)
							ws.close(1002, 'Protocol violation: unknown packet type')
							return
					}
				}
			} catch (e) {
				logger.error(e, 'Error processing message, terminating connection')
				ws.close(1011, 'Server error processing message')
			}
		}
	},

	port: config.port,
	...(config.key && config.cert
		? {
				tls: {
					key: Bun.file(config.key),
					cert: Bun.file(config.cert)
				}
		  }
		: {})
})

const paintboard = new PaintBoardManager(
	config.width,
	config.height,
	config.paintDelay,
	config.validationPaste,
	config.useDB,
	config.clearBoard
)

// 颜色更新事件处理
paintboard.onColorUpdate(batchUpdate => {
	const sent = server.publish('paint', batchUpdate, true)
	if (sent > 0) globalPacketsSent += ipConnections.size
})

// 服务器刻处理：定期发送更新
setInterval(() => {
	const now = Date.now()
	const elapsed = now - lastTick
	if (lastTick && elapsed > 1000 / config.ticksPerSecond + 50)
		logger.warn(
			`Can't keep up! Is the server overloaded? Last tick took ${elapsed}ms!`
		)
	lastTick = now
	for (const [ip, connections] of ipConnections) {
		for (const ws of connections) {
			const buffer = ws.data.sendBuffer.flush() as Uint8Array
			if (buffer.length > 0) ws.send(buffer)
		}
	}
	paintboard.flushUpdates()
}, 1000 / config.ticksPerSecond)

// 吞吐量监控
setInterval(() => {
	let statsMessage = `WebSocket Traffic - Received: ${globalPacketsReceived} packets (${(
		globalPacketsReceived / 5
	).toFixed(2)} /s), Sent: ${globalPacketsSent} packets (${(
		globalPacketsSent / 5
	).toFixed(2)} /s)`

	if (config.enableTokenCounting) {
		// 获取所有连接的 token 统计
		const connectionStats = Array.from(ipConnections.entries())
			.flatMap(([ip, connections]) =>
				connections.map(ws => ({
					ip: ws.data.ip,
					uniqueTokens: ws.data.tokenUsageCount.size
				}))
			)
			.sort((a, b) => b.uniqueTokens - a.uniqueTokens)

		// 获取前5名
		const top5 = connectionStats.slice(0, 5)
		statsMessage += `\nTop 5 Token Users:\n${top5
			.map(stat => `  ${stat.ip}: ${stat.uniqueTokens} tokens`)
			.join('\n')}`
	}

	logger.info(statsMessage)

	// 重置计数器
	globalPacketsReceived = 0
	globalPacketsSent = 0
}, 5000)

// 优雅退出处理
function handleShutdown() {
	logger.info('Server shutting down...')
	paintboard.shutdown()
	process.exit(0)
}

process.on('SIGINT', handleShutdown)
process.on('SIGTERM', handleShutdown)

async function handleTokenRequest(req: Request): Promise<Response> {
	try {
		const body = (await req.json()) as TokenRequest

		// 添加 UID 范围检查
		if (config.maxAllowedUID && body.uid > config.maxAllowedUID) {
			return new Response(
				JSON.stringify({
					statusCode: 403,
					data: {
						errorType: 'UID_NOT_ALLOWED',
						message: `UID must be less than or equal to ${config.maxAllowedUID}`
					}
				}),
				{
					status: 403,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				}
			)
		}

		const result = await paintboard.generateToken(body.uid, body.paste)

		if (!result.token) {
			if (
				result.error === 'PASTE_NOT_FOUND' ||
				result.error === 'UID_MISMATCH' ||
				result.error === 'CONTENT_MISMATCH'
			) {
				return new Response(
					JSON.stringify({
						statusCode: 403,
						data: {
							errorType: result.error
						}
					}),
					{
						status: 403,
						headers: {
							'Content-Type': 'application/json',
							'Access-Control-Allow-Origin': '*'
						}
					}
				)
			}

			return new Response(
				JSON.stringify({
					statusCode: 500,
					data: {
						errorType: 'SERVER_ERROR'
					}
				}),
				{
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				}
			)
		}

		return new Response(
			JSON.stringify({
				statusCode: 200,
				data: {
					token: result.token
				}
			}),
			{
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				}
			}
		)
	} catch (e) {
		logger.error(e, 'Failed to parse token request')
		return new Response(
			JSON.stringify({
				statusCode: 400,
				data: {
					errorType: 'BAD_REQUEST',
					message: 'Invalid request format'
				}
			}),
			{
				status: 400,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				}
			}
		)
	}
}

logger.info(`Server started on port ${config.port}`)

// 添加发送ping的辅助函数
function sendPing(ws: Bun.ServerWebSocket<WebSocketData>) {
	if (ws.data.waitingPong) {
		// 不应该发生，以防万一
		ws.close(1002, 'Protocol violation: duplicate ping state')
		return
	}

	ws.data.waitingPong = true
	ws.data.sendBuffer.write(new Uint8Array([0xfc])) // S2C ping

	// 设置3秒后检查pong响应
	ws.data.pongTimer = setTimeout(() => {
		if (ws.data.waitingPong) {
			logger.debug(
				`${colorHash(ws.data.connId)} WebSocket ping timeout for ${ws.data.ip}`
			)
			ws.close(1001, 'Ping timeout')
		}
	}, 3000)
}

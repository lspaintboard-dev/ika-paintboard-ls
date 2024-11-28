import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import pino from 'pino'
import { PaintBoardManager } from './paintboard'
import { type TokenRequest, PaintResultCode, type WebSocketData } from './types'
import Bun from 'bun'
import sharp from 'sharp'

// 添加 logger 到全局作用域
declare global {
	var logger: pino.Logger
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
	maxPacketPerSecond: z.number().min(1).default(128)
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

async function bufferToWebP(
	pixelData: Buffer,
	width: number,
	height: number
): Promise<Buffer> {
	const image = sharp(pixelData, {
		raw: {
			width,
			height,
			channels: 3
		}
	})
	const webpBuffer = await image.webp({ lossless: true }).toBuffer()
	return webpBuffer
}

let webSocketConnectionCount = 0

// IP 连接统计
const ipConnections = new Map<string, Bun.ServerWebSocket<WebSocketData>[]>()

// IP 封禁记录
const bannedIPs = new Map<string, number>()

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
			const buffer = paintboard.getBoardBuffer()

			const compressed = Bun.gzipSync(new Uint8Array(buffer))
			logger.debug(
				`getboard: ${Date.now() - startTime}ms (gzip) ${buffer.length} -> ${
					compressed.length
				} (${(compressed.length / buffer.length).toFixed(2)}x)`
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
			const buffer = await paintboard.getBoardBuffer()
			const compressed = await bufferToWebP(buffer, config.width, config.height)
			logger.debug(
				`getboard: ${Date.now() - startTime}ms (webp-lossless) ${
					buffer.length
				} -> ${compressed.length} (${(
					compressed.length / buffer.length
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
			return handleTokenRequest(req)
		}

		return new Response('Not Found', {
			status: 404,
			headers: {
				'Access-Control-Allow-Origin': '*'
			}
		})
	},
	idleTimeout: 120, // 你猜猜获取版面要多久
	websocket: {
		idleTimeout: 60, // 60s
		sendPings: false, // 已经有自定义 ping 机制了
		publishToSelf: true, // 很明显要发给自己
		open(ws) {
			const ip = ws.remoteAddress
			ws.data.ip = ip
			ws.data.sendBuffer = new Bun.ArrayBufferSink()
			ws.data.sendBuffer.start({
				asUint8Array: true,
				stream: true
			})

			// 检查是否被封禁
			if (isBanned(ip)) {
				ws.close()
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
					conn.close()
				}
				ipConnections.delete(ip)
				logger.warn(`IP ${ip} exceeded WebSocket limit and got banned`)
				ws.close()
				return
			}

			connections.push(ws)
			webSocketConnectionCount++
			logger.debug(
				`WebSocket connected (${ip}): ${webSocketConnectionCount} clients`
			)
			ws.subscribe('paint')

			// 初始化最后响应时间和 ping 标记
			ws.data.lastPing = Date.now()
			ws.data.waitingPong = false
			ws.data.packetsReceived = 0
			ws.data.lastPacketCountReset = Date.now()

			// 为每个连接创建独立的 ping 定时器
			ws.data.pingInterval = setInterval(() => {
				if (ws.data.waitingPong) {
					// 如果上一个 ping 还没收到 pong 响应，说明连接已超时
					logger.debug(`WebSocket ping timeout for ${ip}`)
					ws.close()
					return
				}
				ws.data.waitingPong = true
				ws.data.sendBuffer.write(new Uint8Array([0xfc])) // S2C ping
			}, 20000)
			ws.data.tokenUsageCount = new Set() // 初始化为空 Set
		},
		close(ws) {
			// 清理 ping 定时器
			if (ws.data.pingInterval) {
				clearInterval(ws.data.pingInterval)
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
			logger.debug(`WebSocket closed: ${webSocketConnectionCount} clients`)
		},
		message(ws, msg: Buffer) {
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
						conn.close()
					}
					ipConnections.delete(ip)
				}
				return
			}

			// 原有的消息处理逻辑
			globalPacketsReceived++

			// 使用 DataView 解析二进制数据
			const dataView = new DataView(msg.buffer)
			let offset = 0

			// 循环处理所有包
			while (offset < msg.length) {
				const type = dataView.getUint8(offset)
				offset += 1

				switch (type) {
					case 0xfb: // C2S pong
						// 更新 pong 响应状态
						ws.data.waitingPong = false
						ws.data.lastPing = Date.now()
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

						// 直接加入 Set
						ws.data.tokenUsageCount.add(token)

						let result = paintboard.validateToken(token, uid)
						if (result === PaintResultCode.SUCCESS) {
							const success = paintboard.setPixel(x, y, color)
							if (!success) {
								result = PaintResultCode.BAD_FORMAT
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
						logger.warn(`Unknown packet type: ${type}`)
						ws.close()
						return
				}
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

// 添加吞吐量监控
setInterval(() => {
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

	logger.info(
		`WebSocket Traffic - Received: ${globalPacketsReceived} packets (${(
			globalPacketsReceived / 5
		).toFixed(2)} /s), Sent: ${globalPacketsSent} packets (${(
			globalPacketsSent / 5
		).toFixed(2)} /s)\nTop 5 Token Users:\n${top5
			.map(stat => `  ${stat.ip}: ${stat.uniqueTokens} tokens`)
			.join('\n')}`
	)

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

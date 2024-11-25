import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import pino from 'pino'
import { PaintBoardManager } from './paintboard'
import { type TokenRequest, PaintResultCode, type WebSocketData } from './types'
import { compress } from 'zstd.ts'
import Bun from 'bun'

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
	debounceDelay: z.number().min(0).default(0),
	useDB: z.boolean().default(false),
	width: z.number().min(1).default(1600),
	height: z.number().min(1).default(900),
	clearBoard: z.boolean().default(false),
	validationPaste: z.string().default('IkaPaintBoard'),
	key: z.string().optional(),
	cert: z.string().optional()
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

let webSocketConnectionCount = 0

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

			const acceptEncoding = req.headers.get('accept-encoding') || ''
			const buffer = paintboard.getBoardBuffer()

			if (acceptEncoding.includes('zstd')) {
				const compressed = await compress({ input: buffer })
				logger.debug(
					`getboard: ${Date.now() - startTime}ms (zstd) ${buffer.length} -> ${
						compressed.length
					}`
				)
				return new Response(compressed, {
					headers: {
						'Content-Type': 'application/octet-stream',
						'Access-Control-Allow-Origin': '*',
						'Content-Encoding': 'zstd'
					}
				})
			} else {
				const compressed = Bun.gzipSync(new Uint8Array(buffer))
				logger.debug(
					`getboard: ${Date.now() - startTime}ms (gzip) ${buffer.length} -> ${
						compressed.length
					}`
				)
				return new Response(compressed, {
					headers: {
						'Content-Type': 'application/octet-stream',
						'Access-Control-Allow-Origin': '*',
						'Content-Encoding': 'gzip'
					}
				})
			}
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
			webSocketConnectionCount++
			logger.debug(
				{ wsId: ws.data.connectedAt },
				`WebSocket connected: ${webSocketConnectionCount} clients`
			)
			ws.subscribe('paint')
		},
		close(ws) {
			webSocketConnectionCount--
			logger.debug(
				{ wsId: ws.data.connectedAt },
				`WebSocket closed: ${webSocketConnectionCount} clients`
			)
		},
		message(ws, msg: Buffer) {
			if (msg[0] === 0xfb) return // C2S pong

			if (msg[0] === 0xfe) {
				// C2S paint
				const x = msg[1] + msg[2] * 256
				const y = msg[3] + msg[4] * 256
				const color = {
					r: msg[5],
					g: msg[6],
					b: msg[7]
				}
				const uid = msg[8] * 65536 + msg[9] * 256 + msg[10]
				const token = [
					msg.subarray(11, 15).toString('hex'),
					msg.subarray(15, 17).toString('hex'),
					msg.subarray(17, 19).toString('hex'),
					msg.subarray(19, 21).toString('hex'),
					msg.subarray(21, 27).toString('hex')
				].join('-')
				const id = msg[27] + msg[28] * 256

				let result = paintboard.validateToken(token, uid)
				if (result === PaintResultCode.SUCCESS) {
					const success = paintboard.setPixel(x, y, color)

					// 移除直接发送逻辑,现在由 PaintBoardManager 处理
					if (!success) {
						result = PaintResultCode.BAD_FORMAT
					}
				}

				const response = new Uint8Array([0xff, id & 255, id >> 8, result])
				ws.send(response) // S2C paint_result
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
	config.clearBoard,
	config.debounceDelay
)

// 注册颜色更新事件处理
paintboard.onColorUpdate((x, y, color) => {
	const setColorMsg = new Uint8Array([
		0xfa,
		x & 255,
		x >> 8,
		y & 255,
		y >> 8,
		color.r,
		color.g,
		color.b
	])
	server.publish('paint', setColorMsg)
})

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

// 定期发送 ping 包
setInterval(() => {
	server.publish('paint', new Uint8Array([0xfc])) // S2C ping
}, 30000)

logger.info(`Server started on port ${config.port}`)

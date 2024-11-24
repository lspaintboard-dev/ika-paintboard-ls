import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import pino from 'pino'
import { PaintBoardManager } from './paintboard'
import { type TokenRequest, PaintResultCode, type WebSocketData } from './types'

// 添加 logger 到全局作用域
declare global {
	var logger: pino.Logger
}
const logger = pino({
	transport: {
		target: 'pino-pretty'
	}
})
globalThis.logger = logger

const configSchema = z.object({
	logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
	validationPaste: z.string().default('IkaPaintBoard'),
	port: z.number(),
	paintDelay: z.number().min(0),
	width: z.number().min(1).default(1600),
	height: z.number().min(1).default(900),
	useDB: z.boolean().default(false) // NEED IMPL
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

const paintboard = new PaintBoardManager(
	config.width,
	config.height,
	config.paintDelay,
	config.validationPaste,
	config.useDB
)

// 优雅退出处理
function handleShutdown() {
	logger.info('Server shutting down...')
	paintboard.shutdown()
	process.exit(0)
}

process.on('SIGINT', handleShutdown)
process.on('SIGTERM', handleShutdown)

const server = Bun.serve<WebSocketData>({
	static: {
		'/api': new Response('IkaPaintBoard Made by Ikaleio :)'),
		'/dev/frontend': new Response(
			await Bun.file('./static/index.html').bytes(),
			{
				headers: {
					'Content-Type': 'text/html'
				}
			}
		)
	},
	fetch(req: Request, server) {
		const url = new URL(req.url)

		// WebSocket 升级请求处理
		if (url.pathname === '/api/paintboard/ws') {
			if (
				server.upgrade(req, {
					data: {
						connectedAt: Date.now()
					}
				})
			)
				return
			return new Response('Upgrade failed', { status: 500 })
		}

		// HTTP API 处理
		if (url.pathname === '/api/paintboard/getboard') {
			return new Response(paintboard.getBoardBuffer(), {
				headers: { 'Content-Type': 'application/octet-stream' }
			})
		}

		if (url.pathname === '/api/auth/gettoken' && req.method === 'POST') {
			return handleTokenRequest(req)
		}

		return new Response('Not Found', { status: 404 })
	},

	websocket: {
		idleTimeout: 60, // 60s
		sendPings: false, // 已经有自定义 ping 机制了
		publishToSelf: true, // 很明显要发给自己
		open(ws) {
			logger.debug({ wsId: ws.data.connectedAt }, 'WebSocket connected')
			ws.subscribe('paint')
		},
		close(ws) {
			logger.debug({ wsId: ws.data.connectedAt }, 'WebSocket closed')
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

				const result = paintboard.validateToken(token, uid)
				if (result === PaintResultCode.SUCCESS) {
					paintboard.setPixel(x, y, color)

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

					ws.publish('paint', setColorMsg) // S2C set_color
				}

				const response = new Uint8Array([0xff, id & 255, id >> 8, result])
				ws.send(response) // S2C paint_result
			}
		}
	},

	port: config.port
})

async function handleTokenRequest(req: Request): Promise<Response> {
	try {
		const body = (await req.json()) as TokenRequest
		const token = await paintboard.generateToken(body.uid, body.paste)
		if (!token) {
			return new Response(
				JSON.stringify({
					statusCode: 403,
					data: {
						errorType: 'PASTE_VALIDATION_FAILED'
					}
				}),
				{
					status: 403,
					headers: { 'Content-Type': 'application/json' }
				}
			)
		}
		return new Response(
			JSON.stringify({
				statusCode: 200,
				data: {
					token
				}
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' }
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
				headers: { 'Content-Type': 'application/json' }
			}
		)
	}
}

// 定期发送 ping 包
setInterval(() => {
	server.publish('paint', new Uint8Array([0xfc])) // S2C ping
}, 30000)

logger.info(`Server started on port ${config.port}`)

import {
	type PaintBoard,
	type Color,
	type Token,
	PaintResultCode,
	type ColorUpdateListener
} from './types'
import { randomUUID } from 'crypto'
import { DBManager } from './database'

export class PaintBoardManager {
	private board: PaintBoard = {
		width: 0,
		height: 0,
		pixels: []
	}
	private tokens: Map<string, Token> = new Map()
	private paintDelay: number
	private validationPaste: string
	private db?: DBManager
	private autoSaveInterval?: Timer
	private lastPaintTime: Map<string, number> = new Map()
	private colorUpdateListener?: ColorUpdateListener
	private dirtyPixels: Set<number> = new Set()

	constructor(
		width: number,
		height: number,
		paintDelay: number,
		validationPaste: string,
		useDB: boolean,
		clearBoard: boolean
	) {
		if (useDB) {
			this.db = new DBManager()

			// 总是加载 Token
			this.tokens = this.db.loadTokens()
			logger.info('Loaded tokens from database')

			// 只在不清空绘版时加载绘版数据
			if (!clearBoard) {
				const saved = this.db.loadBoard()
				if (saved) {
					this.board = saved
					logger.info('Loaded board state from database')
				} else {
					this.initializeBoard(width, height)
					logger.info('Initialized new board (no data in database)')
				}
			} else {
				this.initializeBoard(width, height)
				logger.info('Cleared board as requested')
			}

			this.autoSaveInterval = setInterval(() => this.saveToDb(), 5 * 60 * 1000)
		} else {
			this.initializeBoard(width, height)
		}

		this.paintDelay = paintDelay
		this.validationPaste = validationPaste
	}

	private initializeBoard(width: number, height: number) {
		this.board = {
			width,
			height,
			pixels: Array(height)
				.fill(0)
				.map(() =>
					Array(width)
						.fill(0)
						.map(() => ({ r: 170, g: 170, b: 170 }))
				)
		}
	}

	public getBoardBuffer(): Buffer {
		const buffer = new Uint8Array(this.board.width * this.board.height * 3)
		for (let y = 0; y < this.board.height; y++) {
			for (let x = 0; x < this.board.width; x++) {
				const pixel = this.board.pixels[y][x]
				const idx = (y * this.board.width + x) * 3
				buffer[idx] = pixel.r
				buffer[idx + 1] = pixel.g
				buffer[idx + 2] = pixel.b
			}
		}
		return Buffer.from(buffer)
	}

	public onColorUpdate(listener: ColorUpdateListener) {
		this.colorUpdateListener = listener
	}

	public setPixel(x: number, y: number, color: Color): boolean {
		if (x < 0 || x >= this.board.width || y < 0 || y >= this.board.height) {
			return false
		}

		this.board.pixels[y][x] = color

		// 将坐标转换为唯一标识并加入脏像素集合
		const pixelId = y * this.board.width + x
		this.dirtyPixels.add(pixelId)

		return true
	}

	public flushUpdates() {
		if (this.dirtyPixels.size > 0 && this.colorUpdateListener) {
			const sink = new Bun.ArrayBufferSink()
			sink.start({
				asUint8Array: true
			})

			for (const pixelId of this.dirtyPixels) {
				const y = Math.floor(pixelId / this.board.width)
				const x = pixelId % this.board.width
				const color = this.board.pixels[y][x]

				// 按照协议格式构造单个像素更新包
				sink.write(
					new Uint8Array([
						0xfa,
						x & 255,
						x >> 8,
						y & 255,
						y >> 8,
						color.r,
						color.g,
						color.b
					])
				)
			}

			// 发送合并后的更新
			this.colorUpdateListener(sink.end() as Uint8Array)
		}

		this.dirtyPixels.clear()
	}

	public async generateToken(
		uid: number,
		paste: string
	): Promise<{ token: string | null; error?: string }> {
		const validation = await this.validatePaste(uid, paste)
		if (validation.success) {
			// 删除该 UID 的所有旧 Token
			for (const [existingToken, info] of this.tokens.entries()) {
				if (info.uid === uid) {
					this.tokens.delete(existingToken)
				}
			}

			const token = randomUUID()
			const tokenInfo = {
				uid,
				token
			}
			this.tokens.set(token, tokenInfo)
			this.db?.deleteTokensByUid(uid) // 在数据库中也删除旧 Token
			this.db?.saveToken(tokenInfo)
			return { token }
		}
		return { token: null, error: validation.error }
	}

	private saveToDb() {
		if (this.db) {
			this.db.saveBoard(this.board.pixels, this.board.width, this.board.height)
			logger.info('Board state saved to database')
		}
	}

	public shutdown() {
		if (this.autoSaveInterval) {
			clearInterval(this.autoSaveInterval)
		}
		if (this.db) {
			this.saveToDb()
			this.db.close()
		}
	}

	public validateToken(token: string, uid: number): PaintResultCode {
		const now = Date.now()
		const tokenInfo = this.tokens.get(token)

		if (!tokenInfo) return PaintResultCode.INVALID_TOKEN

		const lastPrint = this.lastPaintTime.get(token)

		if (lastPrint && now - lastPrint < this.paintDelay)
			return PaintResultCode.COOLING

		const result = PaintResultCode.SUCCESS
		this.lastPaintTime.set(token, now)
		return result
	}

	private async validatePaste(
		uid: number,
		paste: string
	): Promise<{ success: boolean; error?: string }> {
		uid = parseInt(uid.toString())
		try {
			const resp = await fetch(
				`https://www.luogu.com/paste/${paste}?_contentOnly=1`
			)
			if (resp.status === 404) {
				return { success: false, error: 'PASTE_NOT_FOUND' }
			}
			if (resp.status !== 200) {
				return { success: false }
			}
			const data = await resp.json()
			if (data.code !== 200) {
				return { success: false }
			}
			if (parseInt(data.currentData?.paste?.user?.uid) !== uid) {
				return { success: false, error: 'UID_MISMATCH' }
			}
			if (data.currentData?.paste?.data !== this.validationPaste) {
				return { success: false, error: 'CONTENT_MISMATCH' }
			}
			return { success: true }
		} catch (e) {
			logger.error(e, 'Failed to parse paste response')
			return { success: false }
		}
	}
}

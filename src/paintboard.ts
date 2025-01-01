import {
	type PaintBoard,
	type Color,
	type Token,
	PaintResultCode,
	type ColorUpdateListener,
	type PixelData
} from './types'
import { randomUUID } from 'crypto'
import { DBManager } from './database'

export class PaintBoardManager {
	private board: PaintBoard
	private pixelView: Uint8Array // 用于访问 SharedArrayBuffer 的视图
	private tokens: Map<string, Token> = new Map()
	private paintDelay: number
	private validationPaste: string
	private db?: DBManager
	private autoSaveInterval?: Timer
	private lastPaintTime: Map<number, number> = new Map()
	private colorUpdateListener?: ColorUpdateListener
	private dirtyFlags: boolean[] = []
	private dirtyList: number[] = []
	// vis[][] 为 PixelData[][] 初始值为空
	private vis: PixelData[] = []
	private allowQuery: boolean = false

	constructor(
		width: number,
		height: number,
		paintDelay: number,
		validationPaste: string,
		useDB: boolean,
		clearBoard: boolean,
		allowQuery: boolean,
	) {
		// 初始化 SharedArrayBuffer
		const bufferSize = width * height * 3 // 每个像素 3 字节(RGB)
		const buffer = new SharedArrayBuffer(bufferSize)
		this.board = {
			width,
			height,
			pixels: buffer
		}
		this.pixelView = new Uint8Array(this.board.pixels)

		if (useDB) {
			this.db = new DBManager()

			// 总是加载 Token
			this.tokens = this.db.loadTokens()
			logger.info('Loaded tokens from database')

			// 只在不清空绘版时加载绘版数据
			if (!clearBoard) {
				const saved = this.db.loadBoard()
				if (saved) {
					// 将加载的数据复制到 SharedArrayBuffer
					this.board.width = saved.width
					this.board.height = saved.height
					new Uint8Array(this.board.pixels).set(saved.pixels)
					logger.info('Loaded board state from database')
				} else {
					this.initializeBoard()
					logger.info('Initialized new board (no data in database)')
				}
			} else {
				this.initializeBoard()
				logger.info('Cleared board as requested')
			}

			this.autoSaveInterval = setInterval(() => this.saveToDb(), 5 * 60 * 1000)
		} else {
			this.initializeBoard()
		}
		this.allowQuery = allowQuery
		if (allowQuery) {
			this.vis = new Array(width * height).fill({ uid: 0, timestamp: 0 })
		}
		this.paintDelay = paintDelay
		this.validationPaste = validationPaste
		this.dirtyFlags = new Array(width * height).fill(false)
		this.dirtyList = []
	}

	private initializeBoard() {
		// 用灰色填充 SharedArrayBuffer
		const grayValue = 170
		for (let i = 0; i < this.pixelView.length; i++) {
			this.pixelView[i] = grayValue
		}
	}

	public getBoardBuffer(): Buffer {
		// 直接返回 SharedArrayBuffer 的视图
		return Buffer.from(this.pixelView)
	}

	public getSharedArrayBuffer(): SharedArrayBuffer {
		return this.board.pixels
	}

	public onColorUpdate(listener: ColorUpdateListener) {
		this.colorUpdateListener = listener
	}

	public setPixel(x: number, y: number, color: Color, uid: number): boolean {
		if (x < 0 || x >= this.board.width || y < 0 || y >= this.board.height) {
			return false
		}

		const idx = (y * this.board.width + x) * 3
		this.pixelView[idx] = color.r
		this.pixelView[idx + 1] = color.g
		this.pixelView[idx + 2] = color.b
		if (this.allowQuery) {
			const idx_vis = (y * this.board.width + x)
			this.vis[idx_vis] = { uid, timestamp: Date.now() }
		}


		// 将坐标转换为唯一标识
		const pixelId = y * this.board.width + x

		// 如果该像素未被标记为脏，则加入脏像素列表并设置标记
		if (!this.dirtyFlags[pixelId]) {
			this.dirtyFlags[pixelId] = true
			this.dirtyList.push(pixelId)
		}

		return true
	}

	public flushUpdates() {
		if (this.dirtyList.length > 0 && this.colorUpdateListener) {
			const sink = new Bun.ArrayBufferSink()
			sink.start({
				asUint8Array: true
			})

			for (const pixelId of this.dirtyList) {
				const y = Math.floor(pixelId / this.board.width)
				const x = pixelId % this.board.width
				const color = {
					r: this.pixelView[(y * this.board.width + x) * 3],
					g: this.pixelView[(y * this.board.width + x) * 3 + 1],
					b: this.pixelView[(y * this.board.width + x) * 3 + 2]
				}

				// 清除标记
				this.dirtyFlags[pixelId] = false

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

			// 清空脏像素列表
			this.dirtyList.length = 0
		}
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
			this.db.saveBoard(this.pixelView, this.board.width, this.board.height)
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

		if (tokenInfo.uid !== uid) return PaintResultCode.INVALID_TOKEN

		const lastPrint = this.lastPaintTime.get(tokenInfo.uid)

		if (lastPrint && now - lastPrint < this.paintDelay)
			return PaintResultCode.COOLING

		const result = PaintResultCode.SUCCESS
		this.lastPaintTime.set(tokenInfo.uid, now)
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

	public getVis(x: number, y: number): PixelData {
		if (this.allowQuery) {
			const idx = (y * this.board.width + x)
			return this.vis[idx]
		}
		return { uid: 0x39c5bb, timestamp: 0x39c5bb }
	}
}

import {
	type PaintBoard,
	type Color,
	type Token,
	PaintResultCode
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

	constructor(
		width: number,
		height: number,
		paintDelay: number,
		validationPaste: string,
		useDB: boolean = false
	) {
		if (useDB) {
			this.db = new DBManager()
			const saved = this.db.loadBoard()
			if (saved) {
				this.board = saved
				this.tokens = this.db.loadTokens()
			} else {
				this.initializeBoard(width, height)
			}
			// 设置自动保存间隔(5分钟)
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
						.map(() => ({ r: 221, g: 221, b: 221 }))
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

	public setPixel(x: number, y: number, color: Color): boolean {
		if (x < 0 || x >= this.board.width || y < 0 || y >= this.board.height) {
			return false
		}
		this.board.pixels[y][x] = color
		return true
	}

	public async generateToken(
		uid: number,
		paste: string
	): Promise<string | null> {
		if (await this.validatePaste(uid, paste)) {
			const token = randomUUID()
			const tokenInfo = {
				uid,
				token,
				lastPaint: 0
			}
			this.tokens.set(token, tokenInfo)
			this.db?.saveToken(tokenInfo)
			return token
		}
		return null
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

		if (Date.now() - tokenInfo.lastPaint < this.paintDelay)
			return PaintResultCode.COOLING

		const result = PaintResultCode.SUCCESS
		this.lastPaintTime.set(token, now)
		return result
	}

	private async validatePaste(uid: number, paste: string): Promise<boolean> {
		uid = parseInt(uid.toString()) // 我他妈真是大开眼界了
		const resp = await fetch(
			`https://www.luogu.com/paste/${paste}?_contentOnly=1`
		)
		if (resp.status !== 200) return false
		try {
			const data = await resp.json()
			if (data.code !== 200) return false
			if (parseInt(data.currentData?.paste?.user?.uid) !== uid) return false
			if (data.currentData?.paste?.data !== this.validationPaste) return false
		} catch (e) {
			logger.error(e, 'Failed to parse paste response')
			return false
		}
		return true
	}
}

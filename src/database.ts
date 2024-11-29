import { Database } from 'bun:sqlite'
import { type Color, type Token } from './types'

export class DBManager {
	private db: Database
	private saveBoardStmt: ReturnType<Database['prepare']>
	private loadBoardStmt: ReturnType<Database['prepare']>
	private saveTokenStmt: ReturnType<Database['prepare']>
	private loadTokensStmt: ReturnType<Database['prepare']>
	private deleteTokensByUidStmt: ReturnType<Database['prepare']>
	private deleteOldTokensStmt: ReturnType<Database['prepare']>

	constructor() {
		this.db = new Database('data.db')
		this.db.exec(`
            CREATE TABLE IF NOT EXISTS board_data (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                pixels BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY,
                uid INTEGER NOT NULL
            );
        `)

		this.saveBoardStmt = this.db.prepare(
			'INSERT OR REPLACE INTO board_data (id, width, height, pixels) VALUES (1, ?, ?, ?)'
		)
		this.loadBoardStmt = this.db.prepare(
			'SELECT width, height, pixels FROM board_data WHERE id = 1'
		)
		this.saveTokenStmt = this.db.prepare(
			'INSERT OR REPLACE INTO tokens (token, uid) VALUES (?, ?)'
		)
		this.loadTokensStmt = this.db.prepare('SELECT token, uid FROM tokens')
		this.deleteTokensByUidStmt = this.db.prepare(
			'DELETE FROM tokens WHERE uid = ?'
		)
		this.deleteOldTokensStmt = this.db.prepare(
			'DELETE FROM tokens WHERE uid = ? AND token != ?'
		)

		// 改为异步初始化
		this.init()
	}

	private async init() {
		await this.migrateOldTokens()
		// 初始化时执行一次清理
		this.cleanupDuplicateTokens()
	}

	private async migrateOldTokens() {
		try {
			const oldDbPath = './liucang.db'
			if (!(await Bun.file(oldDbPath).exists())) {
				return
			}

			const oldDb = new Database(oldDbPath, { readonly: true })
			const tokens = oldDb.query('SELECT uid, token FROM tokens').all() as {
				uid: number
				token: string
			}[]

			this.db.transaction(() => {
				for (const { uid, token } of tokens) {
					this.saveTokenStmt.run(token, uid)
				}
			})()

			oldDb.close()
			console.info(
				`Successfully migrated ${tokens.length} tokens from old database`
			)
		} catch (error) {
			console.error(error, 'Error migrating tokens from old database')
		}
	}

	public saveBoard(pixels: Uint8Array, width: number, height: number) {
		this.saveBoardStmt.run(width, height, pixels)
	}

	public loadBoard(): {
		width: number
		height: number
		pixels: Uint8Array
	} | null {
		const row = this.loadBoardStmt.get() as
			| { width: number; height: number; pixels: Buffer }
			| undefined
		if (!row) return null

		return {
			width: row.width,
			height: row.height,
			pixels: new Uint8Array(row.pixels)
		}
	}

	public saveToken(token: Token) {
		// 在保存新token之前，删除该UID的所有其他token
		this.db.transaction(() => {
			this.deleteOldTokensStmt.run(token.uid, token.token)
			this.saveTokenStmt.run(token.token, token.uid)
		})()
	}

	public loadTokens(): Map<string, Token> {
		const tokens = new Map<string, Token>()
		const rows = this.loadTokensStmt.all() as {
			token: string
			uid: number
		}[]

		// 创建一个临时Map来存储每个UID最后一个Token
		const uidLastToken = new Map<number, Token>()

		for (const row of rows) {
			uidLastToken.set(row.uid, {
				token: row.token,
				uid: row.uid
			})
		}

		// 只保留每个UID的最后一个Token
		for (const token of uidLastToken.values()) {
			tokens.set(token.token, token)
		}

		return tokens
	}

	public deleteTokensByUid(uid: number) {
		this.deleteTokensByUidStmt.run(uid)
	}

	public cleanupDuplicateTokens() {
		// 清理数据库中的重复UID token
		this.db.exec(`
            WITH latest_tokens AS (
                SELECT uid, MAX(token) as token
                FROM tokens
                GROUP BY uid
            )
            DELETE FROM tokens 
            WHERE (uid, token) NOT IN (
                SELECT uid, token FROM latest_tokens
            )
        `)
	}

	public close() {
		this.db.close()
	}
}

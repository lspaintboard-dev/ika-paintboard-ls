import Bun from 'bun'

export type Color = {
	r: number
	g: number
	b: number
}

export type PaintBoard = {
	width: number
	height: number
	pixels: Color[][]
}

export type Token = {
	uid: number
	token: string
}

export enum PaintResultCode {
	SUCCESS = 0xef,
	INVALID_TOKEN = 0xed,
	COOLING = 0xee,
	BAD_FORMAT = 0xec,
	NO_PERMISSION = 0xeb,
	SERVER_ERROR = 0xea
}

export type TokenRequest = {
	uid: number
	paste: string
}

export type WebSocketData = {
	connectedAt: number
	lastPing: number
	uid?: number
	token?: string
	ip: string
	packetsReceived: number
	sendBuffer: Bun.ArrayBufferSink
	pingInterval?: Timer // setInterval 返回值的类型
	waitingPong: boolean // 是否正在等待 pong 响应
	lastPacketCountReset: number // 添加上次重置计数的时间
	tokenUsageCount: Set<string> // 存储使用过的 token
}

export type ColorUpdateListener = (batchUpdate: Uint8Array) => void

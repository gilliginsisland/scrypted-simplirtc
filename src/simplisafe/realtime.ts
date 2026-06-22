import { EventEmitter } from 'events';
import WebSocket, { RawData } from 'ws';
import { z } from 'zod';

export const simplisafeRealtimeWebsocketUrl = 'wss://socketlink.prd.aser.simplisafe.com';
const websocketSource = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15';
const defaultRealtimePingIntervalMs = 55_000;
const defaultRealtimeReconnectDelayMs = 5_000;
const defaultRealtimeWatchdogTimeoutMs = 5 * 60_000;
const eventTypeByCid = new Map<number, string>([
    [1170, 'camera_motion_detected'],
]);

export interface SimpliSafeRealtimeIdentify {
    accessToken: string;
    userId: number;
}

interface SimpliSafeRealtimeIdentifyMessage {
    datacontenttype: 'application/json';
    type: 'com.simplisafe.connection.identify';
    time: string;
    id: string;
    specversion: '1.0';
    source: string;
    data: {
        auth: {
            schema: 'bearer';
            token: string;
        };
        join: string[];
    };
}

export interface SimpliSafeRealtimeEvent {
    eventType?: string;
    eventCid?: number;
    info?: string;
    systemId?: number;
    timestamp?: Date;
    sensorName?: string;
    sensorSerial?: string;
    sensorType?: string | number;
    raw: unknown;
}

export interface SimpliSafeRealtimeEventMap {
    realtimeEvent: [SimpliSafeRealtimeEvent];
    camera_motion_detected: [SimpliSafeRealtimeEvent];
}

const realtimeStandardEventSchema = z.looseObject({
    type: z.literal('com.simplisafe.event.standard'),
    data: z.looseObject({
        eventCid: z.number().finite().optional(),
        eventTimestamp: z.number().finite().optional(),
        info: z.string().min(1).optional(),
        sid: z.number().finite().optional(),
        sensorName: z.string().min(1).optional(),
        sensorSerial: z.string().min(1).optional(),
        sensorType: z.union([
            z.string().min(1),
            z.number().finite(),
        ]).optional(),
    }),
});

export class SimpliSafeRealtimeEvents extends EventEmitter<SimpliSafeRealtimeEventMap> {
    hasListeners(): boolean {
        return this.eventNames().some(eventName => this.listenerCount(eventName) > 0);
    }

    onMessage(data: RawData): void {
        this.handleMessage(data);
    }

    private handleMessage(data: RawData): void {
        let payload: unknown;
        try {
            payload = JSON.parse(rawDataToString(data));
        }
        catch {
            return;
        }

        const event = parseRealtimeEvent(payload);
        if (!event)
            return;

        this.emit('realtimeEvent', event);
        if (event.eventType === 'camera_motion_detected')
            this.emit('camera_motion_detected', event);
    }
}

export interface SimpliSafeRealtimeWatchdogOptions {
    pingIntervalMs?: number;
    reconnectDelayMs?: number;
    watchdogTimeoutMs?: number;
    websocketUrl?: string;
}

export class SimpliSafeRealtimeWatchdog {
    private ws?: WebSocket;
    private removeWebSocketListeners?: () => void;
    private pingTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;
    private watchdogTimer?: NodeJS.Timeout;
    private readonly pingIntervalMs: number;
    private readonly reconnectDelayMs: number;
    private readonly watchdogTimeoutMs: number;
    private readonly websocketUrl: string;
    private connecting = false;
    private started = false;

    constructor(
        private realtimeEvents: SimpliSafeRealtimeEvents,
        private getIdentify: () => Promise<SimpliSafeRealtimeIdentify>,
        options: SimpliSafeRealtimeWatchdogOptions = {},
    ) {
        this.pingIntervalMs = options.pingIntervalMs ?? defaultRealtimePingIntervalMs;
        this.reconnectDelayMs = options.reconnectDelayMs ?? defaultRealtimeReconnectDelayMs;
        this.watchdogTimeoutMs = options.watchdogTimeoutMs ?? defaultRealtimeWatchdogTimeoutMs;
        this.websocketUrl = options.websocketUrl ?? simplisafeRealtimeWebsocketUrl;
    }

    async start(): Promise<void> {
        this.started = true;
        await this.connect();
    }

    stop(): void {
        this.started = false;
        this.clearReconnect();
        this.closeWebSocket();
    }

    private async connect(): Promise<void> {
        if (!this.started || this.connecting)
            return;
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING)
            return;

        this.connecting = true;
        try {
            const identify = await this.getIdentify();
            if (!this.started)
                return;
            this.replaceWebSocket(new WebSocket(this.websocketUrl), identify);
        }
        catch {
            this.scheduleReconnect();
        }
        finally {
            this.connecting = false;
        }
    }

    private replaceWebSocket(ws: WebSocket, identify: SimpliSafeRealtimeIdentify): void {
        this.closeWebSocket();
        this.ws = ws;

        const onOpen = () => {
            if (this.ws !== ws)
                return;
            this.startPing(ws);
            try {
                this.sendIdentify(ws, identify);
                this.triggerWatchdog(ws);
            }
            catch {
                ws.close();
                this.scheduleReconnect();
            }
        };
        const onMessage = (data: RawData) => {
            if (this.ws !== ws)
                return;
            this.triggerWatchdog(ws);
            this.realtimeEvents.onMessage(data);
        };
        const onClose = () => {
            if (this.ws !== ws)
                return;

            this.cleanupWebSocket();
            this.scheduleReconnect();
        };
        const onError = () => {
            if (this.ws !== ws)
                return;
            ws.close();
            this.scheduleReconnect();
        };

        ws.on('open', onOpen);
        ws.on('message', onMessage);
        ws.on('close', onClose);
        ws.on('error', onError);
        this.removeWebSocketListeners = () => {
            ws.off('open', onOpen);
            ws.off('message', onMessage);
            ws.off('close', onClose);
            ws.off('error', onError);
        };
    }

    private sendIdentify(ws: WebSocket, identify: SimpliSafeRealtimeIdentify): void {
        if (ws.readyState !== WebSocket.OPEN)
            throw new Error('SimpliSafe realtime websocket is not open.');

        const now = new Date();
        const message: SimpliSafeRealtimeIdentifyMessage = {
            datacontenttype: 'application/json',
            type: 'com.simplisafe.connection.identify',
            time: now.toISOString(),
            id: `ts:${now.getTime()}`,
            specversion: '1.0',
            source: websocketSource,
            data: {
                auth: {
                    schema: 'bearer',
                    token: identify.accessToken,
                },
                join: [`uid:${identify.userId}`],
            },
        };
        ws.send(JSON.stringify(message));
    }

    private closeWebSocket(): void {
        const ws = this.ws;
        this.cleanupWebSocket();
        ws?.close();
    }

    private cleanupWebSocket(): void {
        this.removeWebSocketListeners?.();
        this.removeWebSocketListeners = undefined;
        this.clearPing();
        this.clearWatchdog();
        this.ws = undefined;
    }

    private startPing(ws: WebSocket): void {
        this.clearPing();
        this.pingTimer = setInterval(() => {
            if (this.ws === ws && ws.readyState === WebSocket.OPEN)
                ws.ping();
        }, this.pingIntervalMs);
    }

    private clearPing(): void {
        if (!this.pingTimer)
            return;
        clearInterval(this.pingTimer);
        this.pingTimer = undefined;
    }

    private triggerWatchdog(ws: WebSocket): void {
        this.clearWatchdog();
        this.watchdogTimer = setTimeout(() => {
            this.watchdogTimer = undefined;
            if (this.ws !== ws)
                return;
            ws.close();
            this.scheduleReconnect();
        }, this.watchdogTimeoutMs);
    }

    private clearWatchdog(): void {
        if (!this.watchdogTimer)
            return;
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = undefined;
    }

    private scheduleReconnect(): void {
        if (!this.started || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect().catch(() => {
                this.scheduleReconnect();
            });
        }, this.reconnectDelayMs);
    }

    private clearReconnect(): void {
        if (!this.reconnectTimer)
            return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
    }
}

function rawDataToString(data: RawData): string {
    if (typeof data === 'string')
        return data;
    if (Buffer.isBuffer(data))
        return data.toString('utf8');
    if (Array.isArray(data))
        return Buffer.concat(data).toString('utf8');
    return Buffer.from(data).toString('utf8');
}

function parseRealtimeEvent(payload: unknown): SimpliSafeRealtimeEvent | undefined {
    const parsed = realtimeStandardEventSchema.safeParse(payload);
    if (!parsed.success)
        return;
    const data = parsed.data.data;
    const eventCid = data.eventCid;
    const timestamp = dateFromEpoch(data.eventTimestamp);
    const sensorType = data.sensorType;
    return {
        eventType: eventCid === undefined ? undefined : eventTypeByCid.get(eventCid),
        eventCid,
        info: data.info,
        systemId: data.sid,
        timestamp,
        sensorName: data.sensorName,
        sensorSerial: data.sensorSerial,
        sensorType,
        raw: payload,
    };
}

function dateFromEpoch(value: number | undefined): Date | undefined {
    if (value === undefined)
        return;
    return new Date(value > 1_000_000_000_000 ? value : value * 1000);
}

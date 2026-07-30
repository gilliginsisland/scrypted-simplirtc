import WebSocket, { createWebSocketStream, RawData } from 'ws';
import { z } from 'zod';
import type { SimpliSafeApi } from './api';
import type { SimpliSafeCamera } from './camera';
import { simpliSafeMediaSchema } from './media';

export const simplisafeRealtimeWebsocketUrl = 'wss://socketlink.prd.aser.simplisafe.com';
const websocketSource = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15';
export const SimpliSafeEventType = {
    CameraMotionDetected: 1170,
    VideoRecording: Symbol('VideoRecording'),
} as const;
export type SimpliSafeEventType = (typeof SimpliSafeEventType)[keyof typeof SimpliSafeEventType];

export interface SimpliSafeRealtimeIdentify {
    accessToken: string;
    userId: number;
}

const eventVideoSchema = z.looseObject({
    _links: z.looseObject({
        'snapshot/jpg': simpliSafeMediaSchema.optional(),
    }).optional(),
});
export const simpliSafeEventSchema = z.looseObject({
    eventCid: z.number(),
    eventTimestamp: z.number(),
    info: z.string().min(1),
    sid: z.number(),
    sensorName: z.string(),
    sensorSerial: z.string(),
    sensorType: z.union([
        z.string().min(1),
        z.number(),
    ]).optional(),
    video: z.record(z.string(), eventVideoSchema).nullable().optional(),
});
export type SimpliSafeEvent = z.output<typeof simpliSafeEventSchema>;

const realtimeMessageSchema = z.union([
    z.discriminatedUnion('type', [
        z.looseObject({
            type: z.literal('com.simplisafe.event.standard'),
            data: simpliSafeEventSchema,
        }),
        z.looseObject({
            type: z.literal('socketlink'),
        }),
        z.looseObject({
            type: z.literal('com.simplisafe.event.camera'),
        }),
    ]),
    z.unknown().transform(raw => ({ type: 'raw' as const, raw })),
]);

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

type SimpliSafeRealtimeEventListener = (event: SimpliSafeEvent) => void;

enum SimpliSafeRealtimeState {
    Disconnected,
    Connecting,
    Connected,
}

export interface SimpliSafeRealtimeOptions {
    pingIntervalMs?: number;
    reconnectDelayMs?: number;
    reconnectTimeoutMs?: number;
    websocketUrl?: string;
}

export class SimpliSafeRealtimeEvents {
    private listeners = new Map<
        SimpliSafeEventType,
        Map<string, SimpliSafeRealtimeEventListener>
    >();
    private ws?: WebSocket;
    private readonly pingIntervalMs: number;
    private readonly reconnectDelayMs: number;
    private readonly reconnectTimeoutMs: number;
    private readonly websocketUrl: string;
    private state = SimpliSafeRealtimeState.Disconnected;

    constructor(
        private api: SimpliSafeApi,
        {
            pingIntervalMs = 55_000,
            reconnectDelayMs = 5_000,
            reconnectTimeoutMs = 5 * 60_000,
            websocketUrl = simplisafeRealtimeWebsocketUrl,
        }: SimpliSafeRealtimeOptions = {},
    ) {
        this.pingIntervalMs = pingIntervalMs;
        this.reconnectDelayMs = reconnectDelayMs;
        this.reconnectTimeoutMs = reconnectTimeoutMs;
        this.websocketUrl = websocketUrl;
    }

    addEventListener(eventType: SimpliSafeEventType, camera: SimpliSafeCamera, listener: SimpliSafeRealtimeEventListener): void {
        let listeners = this.listeners.get(eventType);
        if (!listeners) {
            listeners = new Map();
            this.listeners.set(eventType, listeners);
        }
        let deviceId: string;
        switch (eventType) {
            case SimpliSafeEventType.VideoRecording:
                deviceId = camera.uuid;
                break;
            default:
                deviceId = camera.serial;
                break;
        }
        listeners.set(deviceId, listener);
        void this.sync();
    }

    removeEventListener(eventType: SimpliSafeEventType, camera: SimpliSafeCamera): void {
        const listeners = this.listeners.get(eventType);
        if (!listeners)
            return;
        let deviceId: string;
        switch (eventType) {
            case SimpliSafeEventType.VideoRecording:
                deviceId = camera.uuid;
                break;
            default:
                deviceId = camera.serial;
                break;
        }
        listeners.delete(deviceId);
        if (!listeners.size)
            this.listeners.delete(eventType);
        void this.sync();
    }

    private sync(): void {
        if (!this.listeners.size)
            this.ws?.close();
        else
            this.loop();
    }

    private async loop(): Promise<void> {
        while (this.listeners.size && this.state === SimpliSafeRealtimeState.Disconnected) {
            this.state = SimpliSafeRealtimeState.Connecting;
            try {
                const ws = this.ws = new WebSocket(this.websocketUrl);
                const stream = createWebSocketStream(ws, { decodeStrings: false });
                const identify = JSON.stringify(await this.getIdentifyMessage());
                await new Promise<void>((resolve, reject) => {
                    stream.write(identify, error => error && reject(error) || resolve());
                });
                void this.heartbeat(ws);
                this.state = SimpliSafeRealtimeState.Connected;
                for await (const data of stream) {
                    try {
                        this.onMessage(data as RawData);
                    } catch (error) {
                        this.api.console.error('Failed to parse SimpliSafe realtime message.', error);
                    }
                }
            } catch (error) {
                this.api.console.error('SimpliSafe realtime connection failed.', error);
            } finally {
                this.ws = undefined;
                this.state = SimpliSafeRealtimeState.Disconnected;
            }
            await sleep(this.reconnectDelayMs);
        }
    }

    private onMessage(data: RawData): void {
        if (Array.isArray(data))
            data = Buffer.concat(data);
        else if (!Buffer.isBuffer(data))
            data = Buffer.from(data);
        const payload = JSON.parse(data.toString('utf8')) as unknown;
        const message = realtimeMessageSchema.parse(payload);
        switch (message.type) {
            case 'com.simplisafe.event.standard': {
                const event = message.data;
                this.listeners
                    .get(event.eventCid as SimpliSafeEventType)
                    ?.get(event.sensorSerial)
                    ?.(event);
                for (const cameraUuid of Object.keys(event.video ?? {}))
                    this.listeners
                        .get(SimpliSafeEventType.VideoRecording)
                        ?.get(cameraUuid)
                        ?.(event);
                break;
            }
            case 'socketlink':
            case 'com.simplisafe.event.camera':
                break;
            case 'raw':
                this.api.console.debug('Received unhandled SimpliSafe realtime message.', message.raw);
                break;
        }
    }

    private async getIdentifyMessage(): Promise<SimpliSafeRealtimeIdentifyMessage> {
        const now = new Date();
        return {
            datacontenttype: 'application/json',
            type: 'com.simplisafe.connection.identify',
            time: now.toISOString(),
            id: `ts:${now.getTime()}`,
            specversion: '1.0',
            source: websocketSource,
            data: {
                auth: {
                    schema: 'bearer',
                    token: await this.api.auth.ensureAccessToken(),
                },
                join: [`uid:${await this.api.getUserId()}`],
            },
        };
    }

    private async heartbeat(ws: WebSocket): Promise<void> {
        let missedPing = false;
        let nextMessageTimeout = 0;

        const onMessage = () => { nextMessageTimeout = Date.now() + this.reconnectTimeoutMs }
        onMessage();

        ws.on('message', onMessage);
        ws.on('pong', () => { missedPing = false });

        for (; ;) {
            await sleep(Math.min(
                this.pingIntervalMs,
                Math.max(0, nextMessageTimeout - Date.now()),
            ));
            switch (ws.readyState) {
                case WebSocket.CONNECTING:
                    continue;
                case WebSocket.OPEN:
                    break;
                default:
                    return;
            }
            if (missedPing || Date.now() >= nextMessageTimeout) {
                ws.close();
                return;
            }
            missedPing = true;
            ws.ping();
        }
    }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

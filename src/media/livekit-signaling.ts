import {
    JoinResponse,
    Ping,
    SessionDescription,
    SignalRequest,
    SignalResponse,
    SignalTarget,
    TrickleRequest,
} from '@livekit/protocol';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { RawData } from 'ws';

const liveKitProtocolVersion = '16';
const liveKitSdk = 'python';
const liveKitSdkVersion = '1.0.17';

export interface LiveKitSignalingDetails {
    liveKitURL: string;
    userToken: string;
}

export interface LiveKitSignalingLogger {
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export interface LiveKitSignalingCloseEvent {
    code: number;
    reason: string;
    requested: boolean;
    message: string;
}

export interface LiveKitSignalingOptions {
    cameraName: string;
    logger: LiveKitSignalingLogger;
}

export class LiveKitSignaling extends EventEmitter {
    private cameraName: string;
    private logger: LiveKitSignalingLogger;
    private ws: WebSocket;
    private pingTimer?: NodeJS.Timeout;
    private closed = false;
    private started = false;
    private messageChain: Promise<void> = Promise.resolve();
    private deferredClose?: LiveKitSignalingCloseEvent;
    private deferredWebSocketError?: Error;

    private constructor(options: LiveKitSignalingOptions, ws: WebSocket) {
        super();
        this.cameraName = options.cameraName;
        this.logger = options.logger;
        this.ws = ws;

        ws.on('close', (code, reason) => {
            this.clearPing();
            const requested = this.closed;
            this.closed = true;
            const reasonText = reason.toString();
            const event: LiveKitSignalingCloseEvent = {
                code,
                reason: reasonText,
                requested,
                message: `LiveKit signaling closed for ${this.cameraName}: code=${code} reason=${reasonText}`,
            };
            if (this.started)
                this.emitEventLater('close', event);
            else
                this.deferredClose = event;
        });
        ws.on('error', e => {
            if (this.started)
                this.emitEventLater('websocketError', e);
            else
                this.deferredWebSocketError = e;
        });
    }

    static async connect(options: LiveKitSignalingOptions, details: LiveKitSignalingDetails): Promise<LiveKitSignaling> {
        const endpoint = createLiveKitEndpoint(details.liveKitURL, details.userToken);
        const ws = new WebSocket(endpoint);
        const signaling = new LiveKitSignaling(options, ws);

        try {
            await waitForWebSocketOpen(ws);
        }
        catch (e) {
            await signaling.close();
            throw e;
        }
        return signaling;
    }

    start(): void {
        if (this.started)
            throw new Error(`LiveKit signaling already started for ${this.cameraName}.`);

        this.started = true;
        const ws = this.ws;
        ws.on('message', data => {
            this.messageChain = this.messageChain
                .then(() => this.handleMessage(data))
                .catch(e => this.notifyError(e));
        });

        if (this.deferredWebSocketError) {
            const error = this.deferredWebSocketError;
            this.deferredWebSocketError = undefined;
            this.emitEventLater('websocketError', error);
        }
        if (this.deferredClose) {
            const event = this.deferredClose;
            this.deferredClose = undefined;
            this.emitEventLater('close', event);
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        this.clearPing();
        if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING)
            this.ws.close();
    }

    sendAnswer(offerId: number, answer: RTCSessionDescriptionInit): void {
        this.sendRequest(new SignalRequest({
            message: {
                case: 'answer',
                value: new SessionDescription({
                    id: offerId,
                    type: answer.type,
                    sdp: answer.sdp || '',
                }),
            },
        }));
    }

    sendIceCandidate(candidate: RTCIceCandidateInit): void {
        if (!candidate?.candidate)
            return;

        this.sendRequest(new SignalRequest({
            message: {
                case: 'trickle',
                value: new TrickleRequest({
                    candidateInit: JSON.stringify(candidate),
                    target: SignalTarget.SUBSCRIBER,
                }),
            },
        }));
    }

    private async handleMessage(data: RawData): Promise<void> {
        const response = SignalResponse.fromBinary(rawDataToBytes(data));
        const message = response.message;

        switch (message.case) {
            case 'join':
                this.startPing(message.value);
                await this.emitEvent('join', message.value);
                break;
            case 'offer':
                await this.emitEvent('offer', message.value);
                break;
            case 'trickle':
                await this.emitEvent('trickle', message.value);
                break;
            case 'leave':
                await this.emitEvent('leave');
                break;
            case 'pong':
            case 'pongResp':
            case 'update':
            case 'roomUpdate':
            case 'speakersChanged':
            case 'connectionQuality':
            case 'streamStateUpdate':
            case 'subscribedQualityUpdate':
            case 'subscriptionPermissionUpdate':
            case 'subscriptionResponse':
            case 'mediaSectionsRequirement':
            case 'subscribedAudioCodecUpdate':
                this.logger.debug(`Ignoring LiveKit signaling message kind=${message.case} for ${this.cameraName}.`);
                break;
            default:
                this.logger.debug(`Ignoring unsupported LiveKit signaling message kind=${message.case ?? 'missing'} for ${this.cameraName}.`);
                break;
        }
    }

    private startPing(join: JoinResponse): void {
        if (join.pingInterval <= 0)
            return;

        this.clearPing();
        this.pingTimer = setInterval(() => {
            this.sendRequest(new SignalRequest({
                message: {
                    case: 'pingReq',
                    value: new Ping({
                        timestamp: BigInt(Date.now()),
                    }),
                },
            }));
        }, join.pingInterval * 1000);
    }

    private sendRequest(request: SignalRequest): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.logger.debug(`Dropping LiveKit signaling request after websocket close for ${this.cameraName}.`);
            return;
        }
        this.ws.send(Buffer.from(request.toBinary()));
    }

    private clearPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = undefined;
        }
    }

    private notifyError(error: unknown): void {
        this.emitEventLater('error', error);
    }

    private emitEventLater(eventName: string, ...args: unknown[]): void {
        this.emitEvent(eventName, ...args)
            .catch(e => this.logger.error(`LiveKit signaling event handler failed for ${this.cameraName}.`, e));
    }

    private async emitEvent(eventName: string, ...args: unknown[]): Promise<void> {
        const listeners = this.listeners(eventName);
        if (!listeners.length) {
            if (eventName === 'error')
                this.logger.error(`Unhandled LiveKit signaling error for ${this.cameraName}.`, args[0]);
            return;
        }

        for (const listener of listeners)
            await (listener as (...args: unknown[]) => void | Promise<void>)(...args);
    }
}

function createLiveKitEndpoint(liveKitURL: string, userToken: string): string {
    const endpoint = new URL('rtc', ensureTrailingSlash(liveKitURL));
    endpoint.searchParams.set('access_token', userToken);
    endpoint.searchParams.set('sdk', liveKitSdk);
    endpoint.searchParams.set('version', liveKitSdkVersion);
    endpoint.searchParams.set('protocol', liveKitProtocolVersion);
    endpoint.searchParams.set('auto_subscribe', '1');
    return endpoint.toString();
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}

function rawDataToBytes(data: RawData): Uint8Array {
    if (Buffer.isBuffer(data))
        return data;
    if (data instanceof ArrayBuffer)
        return new Uint8Array(data);
    if (Array.isArray(data))
        return Buffer.concat(data);
    return new Uint8Array(data);
}

function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN)
        return Promise.resolve();

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            ws.off('open', onOpen);
            ws.off('error', onError);
            ws.off('close', onClose);
        };
        const onOpen = () => {
            cleanup();
            resolve();
        };
        const onError = (e: Error) => {
            cleanup();
            reject(e);
        };
        const onClose = (code: number, reason: Buffer) => {
            cleanup();
            reject(new Error(`LiveKit websocket closed before open: code=${code} reason=${reason.toString()}`));
        };
        ws.once('open', onOpen);
        ws.once('error', onError);
        ws.once('close', onClose);
    });
}

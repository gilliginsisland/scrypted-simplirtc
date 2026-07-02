import {
    JoinResponse,
    Ping,
    SessionDescription,
    SignalRequest,
    SignalResponse,
    SignalTarget,
    TrickleRequest,
    UpdateSubscription,
} from '@livekit/protocol';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import WebSocket from 'ws';
import type { RawData } from 'ws';

const liveKitProtocolVersion = '16';
const liveKitSdk = 'python';
const liveKitSdkVersion = '1.0.17';

export interface LiveKitSignalingCloseEvent extends Pick<ErrorEvent, 'message' | 'error'> {
    code: number;
    reason: string;
    requested: boolean;
}

export interface LiveKitSignalingOptions {
    token: string;
    protocol?: string | number;
    sdk?: string;
    sdkVersion?: string;
    autoSubscribe?: boolean;
    joinRequest?: string;
}

export class LiveKitSignaling extends EventEmitter {
    private ws: WebSocket;
    private pingTimer?: NodeJS.Timeout;
    private closed = false;
    private messageChain: Promise<void> = Promise.resolve();

    constructor(liveKitURL: string, options: LiveKitSignalingOptions) {
        super();
        this.ws = new WebSocket(createLiveKitEndpoint(liveKitURL, options), createWebSocketOptions(options));

        this.ws.on('close', (code, reason) => {
            this.clearPing();
            const requested = this.closed;
            this.closed = true;
            const reasonText = reason.toString();
            const message = `LiveKit signaling closed: code=${code} reason=${reasonText}`;
            const event: LiveKitSignalingCloseEvent = {
                code,
                reason: reasonText,
                requested,
                message,
                error: new Error(message),
            };
            this.emitEventLater('close', event);
        });
        this.ws.on('error', e => this.emitEventLater('error', e));
        this.ws.on('message', data => this.enqueueMessage(data));
        this.ws.on('unexpected-response', (_request, response) => this.onUnexpectedResponse(response));
    }

    async close(): Promise<void> {
        this.closed = true;
        this.clearPing();
        if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING)
            this.ws.close();
    }

    sendSubscription(subscription: UpdateSubscription): void {
        this.sendRequest(new SignalRequest({
            message: {
                case: 'subscription',
                value: subscription,
            },
        }));
    }

    sendOffer(offerId: number, offer: RTCSessionDescriptionInit): void {
        this.sendRequest(new SignalRequest({
            message: {
                case: 'offer',
                value: new SessionDescription({
                    id: offerId,
                    type: offer.type,
                    sdp: offer.sdp || '',
                }),
            },
        }));
    }

    sendIceCandidate(candidate: RTCIceCandidateInit, target = SignalTarget.SUBSCRIBER): void {
        if (!candidate?.candidate)
            return;

        this.sendRequest(new SignalRequest({
            message: {
                case: 'trickle',
                value: new TrickleRequest({
                    candidateInit: JSON.stringify(candidate),
                    target,
                }),
            },
        }));
    }

    private async onMessage(data: RawData): Promise<void> {
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
            case 'answer':
                await this.emitEvent('answer', message.value);
                break;
            case 'trickle':
                await this.emitEvent('trickle', message.value);
                break;
            case 'update':
                await this.emitEvent('update', message.value);
                break;
            case 'trackSubscribed':
                await this.emitEvent('trackSubscribed', message.value);
                break;
            case 'streamStateUpdate':
                await this.emitEvent('streamStateUpdate', message.value);
                break;
            case 'subscriptionResponse':
                await this.emitEvent('subscriptionResponse', message.value);
                break;
            case 'trackPublished':
                await this.emitEvent('trackPublished', message.value);
                break;
            case 'mediaSectionsRequirement':
                await this.emitEvent('mediaSectionsRequirement', message.value);
                break;
            case 'leave':
                await this.emitEvent('leave');
                break;
            case 'pong':
            case 'pongResp':
            case 'roomUpdate':
            case 'speakersChanged':
            case 'connectionQuality':
            case 'subscribedQualityUpdate':
            case 'subscriptionPermissionUpdate':
            case 'subscribedAudioCodecUpdate':
                break;
            default:
                break;
        }
    }

    private enqueueMessage(data: RawData): void {
        this.messageChain = this.messageChain
            .then(() => this.onMessage(data))
            .catch(e => this.notifyError(e));
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
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
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

    private onUnexpectedResponse(response: IncomingMessage): void {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
            const status = `${response.statusCode ?? 'unknown'} ${response.statusMessage ?? ''}`.trim();
            const body = Buffer.concat(chunks).toString('utf8').trim();
            const suffix = body ? ` body=${body.slice(0, 1000)}` : '';
            this.notifyError(new Error(`LiveKit signaling unexpected response: status=${status}${suffix}`));
            this.close().catch(e => this.notifyError(e));
        });
        response.on('error', e => this.notifyError(e));
    }

    private emitEventLater(eventName: string, ...args: unknown[]): void {
        this.emitEvent(eventName, ...args)
            .catch(e => {
                if (eventName !== 'error')
                    this.emitEventLater('error', e);
            });
    }

    private async emitEvent(eventName: string, ...args: unknown[]): Promise<void> {
        const listeners = this.rawListeners(eventName);
        if (!listeners.length)
            return;

        for (const listener of listeners)
            await (listener as (...args: unknown[]) => void | Promise<void>)(...args);
    }
}

function createLiveKitEndpoint(liveKitURL: string, options: LiveKitSignalingOptions): string {
    const {
        token,
        protocol = liveKitProtocolVersion,
        sdk = liveKitSdk,
        sdkVersion = liveKitSdkVersion,
        autoSubscribe = true,
        joinRequest,
    } = options;
    const endpoint = new URL('rtc', liveKitURL.endsWith('/') ? liveKitURL : `${liveKitURL}/`);
    if (joinRequest) {
        endpoint.searchParams.set('access_token', token);
        endpoint.searchParams.set('join_request', joinRequest);
    }
    else {
        endpoint.searchParams.set('access_token', token);
        endpoint.searchParams.set('sdk', sdk);
        endpoint.searchParams.set('version', sdkVersion);
        endpoint.searchParams.set('protocol', protocol.toString());
        endpoint.searchParams.set('auto_subscribe', autoSubscribe ? '1' : '0');
    }
    return endpoint.toString();
}

function createWebSocketOptions(options: LiveKitSignalingOptions): WebSocket.ClientOptions | undefined {
    if (!options.joinRequest)
        return;

    return {
        headers: {
            Authorization: `Bearer ${options.token}`,
        },
    };
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

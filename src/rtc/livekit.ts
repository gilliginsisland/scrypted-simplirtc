import {
    ClientInfo,
    ClientInfo_SDK,
    ConnectionSettings,
    JoinRequest,
    JoinResponse,
    MediaSectionsRequirement,
    Ping,
    SessionDescription,
    SignalRequest,
    SignalResponse,
    SignalTarget,
    TrickleRequest,
    WrappedJoinRequest,
    WrappedJoinRequest_Compression,
} from '@livekit/protocol';
import { RTCAVSignalingSetup, RTCSessionControl, RTCSignalingSession } from '@scrypted/sdk';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import WebSocket, { type RawData } from 'ws';
import { gzipSync } from 'zlib';
import { createCandidateQueue, Deferred, getRTCSignalingOptions } from './common';

const liveKitProtocolVersion = 16;
const liveKitSdkVersion = '1.0.17';

export interface LiveKitSignalingCloseEvent extends Pick<ErrorEvent, 'message' | 'error'> {
    code: number;
    reason: string;
}

export interface LiveKitSignalingOptions {
    token: string;
    joinRequest: string;
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
            this.closed = true;
            const reasonText = reason.toString();
            const message = `LiveKit signaling closed: code=${code} reason=${reasonText}`;
            const event: LiveKitSignalingCloseEvent = {
                code,
                reason: reasonText,
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

    sendIceCandidate(candidate: RTCIceCandidateInit): void {
        if (!candidate?.candidate)
            return;

        this.sendRequest(new SignalRequest({
            message: {
                case: 'trickle',
                value: new TrickleRequest({
                    candidateInit: JSON.stringify(candidate),
                    target: SignalTarget.PUBLISHER,
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
            case 'answer':
                await this.emitEvent('answer', message.value);
                break;
            case 'trickle':
                await this.emitEvent('trickle', message.value);
                break;
            case 'mediaSectionsRequirement':
                await this.emitEvent('mediaSectionsRequirement', message.value);
                break;
            case 'leave':
                await this.emitEvent('leave');
                break;
            case 'pongResp':
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
    const endpoint = new URL('rtc', liveKitURL.endsWith('/') ? liveKitURL : `${liveKitURL}/`);
    endpoint.searchParams.set('join_request', options.joinRequest);
    return endpoint.toString();
}

function createWebSocketOptions(options: LiveKitSignalingOptions): WebSocket.ClientOptions {
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

export class LiveKitRTCSessionControl implements RTCSessionControl {
    private readonly ready = new Deferred<void>();
    private readonly remoteCandidates;
    private setup?: RTCAVSignalingSetup;
    private nextOfferId = 1;
    private renegotiation: Promise<void> = Promise.resolve();
    private closed = false;

    private constructor(
        private readonly signaling: LiveKitSignaling,
        private readonly session: RTCSignalingSession,
        private readonly trickleCandidates: boolean,
    ) {
        this.remoteCandidates = createCandidateQueue(candidate => this.session.addIceCandidate(candidate));

        this.signaling.on('join', join => this.onJoin(join));
        this.signaling.on('answer', answer => this.onAnswer(answer));
        this.signaling.on('trickle', trickle => this.onTrickle(trickle));
        this.signaling.on('mediaSectionsRequirement', requirement => this.onMediaSectionsRequirement(requirement));
        this.signaling.on('leave', () => this.endSession());
        this.signaling.on('close', event => this.onClose(event));
        this.signaling.on('error', error => this.onError(error));
    }

    static async start(liveKitURL: string, token: string, session: RTCSignalingSession): Promise<LiveKitRTCSessionControl> {
        const options = await getRTCSignalingOptions(session);
        const signaling = new LiveKitSignaling(liveKitURL, {
            token,
            joinRequest: createWrappedJoinRequest(),
        });
        const control = new LiveKitRTCSessionControl(signaling, session, !options.disableTrickle);

        try {
            await control.ready.promise;
            return control;
        }
        catch (e) {
            await control.endSession();
            throw e;
        }
    }

    async getRefreshAt(): Promise<number | void> {
    }

    async extendSession(): Promise<void> {
    }

    async setPlayback(_options: { audio: boolean; video: boolean }): Promise<void> {
    }

    async endSession(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        await this.signaling.close();
    }

    private async onJoin(join: JoinResponse): Promise<void> {
        if (this.setup)
            return;

        this.setup = createSetup(join);
        await this.sendOffer();
        this.ready.resolve();
    }

    private async onAnswer(answer: SessionDescription): Promise<void> {
        if (!this.setup)
            return;

        await this.session.setRemoteDescription(toRTCSessionDescription(answer), this.setup);
        await this.remoteCandidates.flush();
    }

    private async onTrickle(trickle: TrickleRequest): Promise<void> {
        if (trickle.target !== SignalTarget.PUBLISHER || !trickle.candidateInit)
            return;

        let candidate: RTCIceCandidateInit;
        try {
            candidate = JSON.parse(trickle.candidateInit) as RTCIceCandidateInit;
        }
        catch {
            return;
        }
        if (!candidate.candidate)
            return;
        await this.remoteCandidates.sendIceCandidate(candidate);
    }

    private onMediaSectionsRequirement(requirement: MediaSectionsRequirement): Promise<void> {
        if (!requirement.numAudios && !requirement.numVideos)
            return Promise.resolve();

        this.renegotiation = this.renegotiation.then(() => this.sendOffer());
        return this.renegotiation;
    }

    private onClose(event: LiveKitSignalingCloseEvent): void {
        this.ready.reject(event.error);
        this.closed = true;
    }

    private onError(error: unknown): void {
        this.ready.reject(error);
        void this.endSession();
    }

    private async sendOffer(): Promise<void> {
        if (this.closed)
            return;
        if (!this.setup)
            throw new Error('LiveKit joined without an RTC setup.');

        const candidates = createCandidateQueue(candidate => {
            this.signaling.sendIceCandidate(candidate);
            return Promise.resolve();
        });
        const offer = await this.session.createLocalDescription(
            'offer',
            this.setup,
            this.trickleCandidates ? candidates.sendIceCandidate : undefined,
        );
        this.signaling.sendOffer(this.nextOfferId++, offer);
        await candidates.flush();
    }
}

function createSetup(join: JoinResponse): RTCAVSignalingSetup {
    return {
        type: 'offer',
        configuration: {
            iceServers: join.iceServers.map(iceServer => ({
                urls: iceServer.urls,
                username: iceServer.username || undefined,
                credential: iceServer.credential || undefined,
            })),
        },
        audio: {
            direction: 'recvonly',
        },
        video: {
            direction: 'recvonly',
        },
        getUserMediaSafariHack: true,
    };
}

function createWrappedJoinRequest(): string {
    const joinRequest = new JoinRequest({
        clientInfo: new ClientInfo({
            sdk: ClientInfo_SDK.JS,
            version: liveKitSdkVersion,
            protocol: liveKitProtocolVersion,
            clientProtocol: liveKitProtocolVersion,
        }),
        connectionSettings: new ConnectionSettings({
            autoSubscribe: true,
        }),
    });
    const wrapped = new WrappedJoinRequest({
        compression: WrappedJoinRequest_Compression.GZIP,
        joinRequest: gzipSync(Buffer.from(joinRequest.toBinary())),
    });
    return Buffer.from(wrapped.toBinary())
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function toRTCSessionDescription(description: SessionDescription): RTCSessionDescriptionInit {
    return {
        type: description.type as RTCSdpType,
        sdp: description.sdp,
    };
}

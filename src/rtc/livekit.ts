import {
    ClientInfo,
    ClientInfo_SDK,
    ConnectionSettings,
    JoinRequest,
    JoinResponse,
    Ping,
    ParticipantInfo,
    ParticipantUpdate,
    SessionDescription,
    SignalRequest,
    SignalResponse,
    SignalTarget,
    StreamState,
    StreamStateUpdate,
    SubscriptionResponse,
    TrackInfo,
    TrackSubscribed,
    TrackType,
    TrickleRequest,
    UpdateSubscription,
    WrappedJoinRequest,
    WrappedJoinRequest_Compression,
} from '@livekit/protocol';
import { RTCAVSignalingSetup, RTCSessionControl, RTCSignalingOptions, RTCSignalingSession } from '@scrypted/sdk';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import { gzipSync } from 'zlib';
import WebSocket, { type RawData } from 'ws';

const liveKitProtocolVersion = 16;
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

export class LiveKitRTCSessionControl implements RTCSessionControl {
    private readonly joined = new Future<JoinResponse>();
    private readonly pendingAnswers = new Map<number, Future<SessionDescription>>();
    private readonly mediaReady = new Future<void>();
    private readonly remoteCandidates: RTCIceCandidateInit[] = [];
    private readonly subscribedTrackSids = new Set<string>();
    private readonly trackKindsBySid = new Map<string, TrackType>();
    private readonly activeTrackSids = new Set<string>();
    private readonly subscribedReadyTrackSids = new Set<string>();
    private renegotiation: Promise<void> = Promise.resolve();
    private nextOfferId = 2;
    private ownParticipantSid?: string;
    private remoteDescriptionSet = false;
    private closed = false;

    private constructor(
        private readonly signaling: LiveKitSignaling,
        private readonly session: RTCSignalingSession,
        private readonly setup: RTCAVSignalingSetup,
        private readonly localCandidates: IceCandidateQueue,
        private readonly trickleCandidates: boolean,
    ) {
        this.localCandidates.setSender(candidate => this.signaling.sendIceCandidate(candidate, SignalTarget.PUBLISHER));

        this.signaling.on('join', join => this.onJoin(join));
        this.signaling.on('answer', answer => this.onAnswer(answer));
        this.signaling.on('trickle', trickle => this.onTrickle(trickle));
        this.signaling.on('update', update => this.onUpdate(update));
        this.signaling.on('trackSubscribed', track => this.onTrackSubscribed(track));
        this.signaling.on('streamStateUpdate', update => this.onStreamStateUpdate(update));
        this.signaling.on('subscriptionResponse', response => this.onSubscriptionResponse(response));
        this.signaling.on('mediaSectionsRequirement', () => this.onMediaSectionsRequirement());
        this.signaling.on('leave', () => this.endSession());
        this.signaling.on('close', event => this.onClose(event));
        this.signaling.on('error', error => this.onError(error));
    }

    static async start(liveKitURL: string, token: string, session: RTCSignalingSession): Promise<LiveKitRTCSessionControl> {
        const options = await getSessionOptions(session);
        const disableTrickle = !!options.disableTrickle;
        const setup = createSetup();
        const localCandidates = new IceCandidateQueue();
        const offerId = 1;
        const offer = await session.createLocalDescription(
            'offer',
            setup,
            disableTrickle ? undefined : async candidate => localCandidates.add(candidate),
        );
        const signaling = new LiveKitSignaling(liveKitURL, {
            token,
            joinRequest: createWrappedJoinRequest(offerId, offer),
        });
        const control = new LiveKitRTCSessionControl(signaling, session, setup, localCandidates, !disableTrickle);
        control.pendingAnswers.set(offerId, new Future<SessionDescription>());

        try {
            await Promise.all([
                control.joined.promise,
                control.waitForAnswer(offerId),
            ]);
            await control.mediaReady.promise;
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

    private onJoin(join: JoinResponse): void {
        this.ownParticipantSid = join.participant?.sid;
        this.joined.resolve(join);
        this.subscribeToParticipants(join.otherParticipants);
        this.localCandidates.flush();
    }

    private async onAnswer(answer: SessionDescription): Promise<void> {
        const future = this.findAnswerFuture(answer.id);
        if (!future)
            return;

        try {
            await this.session.setRemoteDescription(toRTCSessionDescription(answer), this.setup);
            this.remoteDescriptionSet = true;
            await this.flushRemoteCandidates();
            future.resolve(answer);
        }
        catch (e) {
            future.reject(e);
            throw e;
        }
    }

    private async onTrickle(trickle: TrickleRequest): Promise<void> {
        if (!trickle.candidateInit)
            return;

        const candidate = JSON.parse(trickle.candidateInit) as RTCIceCandidateInit;
        if (!this.remoteDescriptionSet) {
            this.remoteCandidates.push(candidate);
            return;
        }
        await this.session.addIceCandidate(candidate);
    }

    private onUpdate(update: ParticipantUpdate): void {
        this.subscribeToParticipants(update.participants);
    }

    private onTrackSubscribed(track: TrackSubscribed): void {
        if (!track.trackSid)
            return;
        this.subscribedReadyTrackSids.add(track.trackSid);
        this.checkMediaReady();
    }

    private onStreamStateUpdate(update: StreamStateUpdate): void {
        for (const streamState of update.streamStates) {
            if (!streamState.trackSid)
                continue;
            if (streamState.state === StreamState.ACTIVE)
                this.activeTrackSids.add(streamState.trackSid);
            else
                this.activeTrackSids.delete(streamState.trackSid);
        }
        this.checkMediaReady();
    }

    private onSubscriptionResponse(_response: SubscriptionResponse): void {
        this.checkMediaReady();
    }

    private onMediaSectionsRequirement(): void {
        this.renegotiation = this.renegotiation
            .then(() => this.sendRenegotiationOffer())
            .catch(e => this.onError(e));
    }

    private onClose(event: LiveKitSignalingCloseEvent): void {
        if (!event.requested)
            this.rejectPending(event.error);
        this.closed = true;
    }

    private onError(error: unknown): void {
        this.rejectPending(error);
    }

    private waitForAnswer(offerId: number): Promise<SessionDescription> {
        const future = this.pendingAnswers.get(offerId);
        if (!future)
            throw new Error(`Missing LiveKit answer future for offer ${offerId}.`);
        return future.promise;
    }

    private findAnswerFuture(offerId: number): Future<SessionDescription> | undefined {
        const future = this.pendingAnswers.get(offerId);
        if (future) {
            this.pendingAnswers.delete(offerId);
            return future;
        }

        if (offerId || this.pendingAnswers.size !== 1)
            return;

        const entry = this.pendingAnswers.entries().next().value;
        if (!entry)
            return;
        const [pendingOfferId, pendingFuture] = entry;
        this.pendingAnswers.delete(pendingOfferId);
        return pendingFuture;
    }

    private subscribeToParticipants(participants: ParticipantInfo[]): void {
        const trackSids: string[] = [];
        for (const participant of participants) {
            if (participant.sid === this.ownParticipantSid)
                continue;

            for (const track of participant.tracks) {
                if (!isMediaTrack(track) || !track.sid || this.subscribedTrackSids.has(track.sid))
                    continue;
                this.trackKindsBySid.set(track.sid, track.type);
                this.subscribedTrackSids.add(track.sid);
                trackSids.push(track.sid);
            }
        }

        if (!trackSids.length)
            return;

        this.signaling.sendSubscription(new UpdateSubscription({
            trackSids,
            subscribe: true,
        }));
    }

    private rejectPending(error: unknown): void {
        this.joined.reject(error);
        this.mediaReady.reject(error);
        for (const future of this.pendingAnswers.values())
            future.reject(error);
        this.pendingAnswers.clear();
    }

    private async sendRenegotiationOffer(): Promise<void> {
        if (this.closed)
            return;

        const offerId = this.nextOfferId++;
        const offer = await this.session.createLocalDescription(
            'offer',
            this.setup,
            this.trickleCandidates ? async candidate => this.localCandidates.add(candidate) : undefined,
        );
        this.pendingAnswers.set(offerId, new Future<SessionDescription>());
        this.signaling.sendOffer(offerId, offer);
        await this.waitForAnswer(offerId);
    }

    private async flushRemoteCandidates(): Promise<void> {
        const candidates = this.remoteCandidates.splice(0);
        for (const candidate of candidates)
            await this.session.addIceCandidate(candidate);
    }

    private checkMediaReady(): void {
        for (const [trackSid, kind] of this.trackKindsBySid.entries()) {
            if (kind !== TrackType.VIDEO)
                continue;
            if (this.activeTrackSids.has(trackSid) || this.subscribedReadyTrackSids.has(trackSid))
                this.mediaReady.resolve();
        }
    }
}

class Future<T> {
    readonly promise: Promise<T>;
    resolve!: (value: T | PromiseLike<T>) => void;
    reject!: (reason?: unknown) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

class IceCandidateQueue {
    private candidates: RTCIceCandidateInit[] = [];
    private flushing = false;

    constructor(private send?: (candidate: RTCIceCandidateInit) => void) {
    }

    setSender(send: (candidate: RTCIceCandidateInit) => void): void {
        this.send = send;
    }

    add(candidate: RTCIceCandidateInit): void {
        if (!candidate?.candidate)
            return;
        if (!this.flushing) {
            this.candidates.push(candidate);
            return;
        }
        this.send?.(candidate);
    }

    flush(): void {
        this.flushing = true;
        const candidates = this.candidates;
        this.candidates = [];
        for (const candidate of candidates)
            this.send?.(candidate);
    }
}

async function getSessionOptions(session: RTCSignalingSession): Promise<RTCSignalingOptions> {
    return session.options || await session.getOptions();
}

function createSetup(): RTCAVSignalingSetup {
    return {
        type: 'offer',
        configuration: {
            iceServers: [
                {
                    urls: 'turn:us-east-1.turn2.services.simplisafe.com:3478?transport=udp',
                    username: 'XVgCJdEwj538ZBn4Dp7ytP',
                    credential: 'zenuRYJjU93AFN5hT7L24G',
                },
            ],
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

function createWrappedJoinRequest(offerId: number, offer: RTCSessionDescriptionInit): string {
    const joinRequest = new JoinRequest({
        clientInfo: new ClientInfo({
            sdk: ClientInfo_SDK.JS,
            version: liveKitSdkVersion,
            protocol: liveKitProtocolVersion,
            clientProtocol: liveKitProtocolVersion,
        }),
        connectionSettings: new ConnectionSettings({
            autoSubscribe: false,
            autoSubscribeDataTrack: false,
        }),
        publisherOffer: new SessionDescription({
            id: offerId,
            type: offer.type,
            sdp: offer.sdp || '',
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

function isMediaTrack(track: TrackInfo): boolean {
    return track.type === TrackType.AUDIO || track.type === TrackType.VIDEO;
}

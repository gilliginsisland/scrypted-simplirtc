import { JoinResponse, SessionDescription, SignalTarget, TrickleRequest } from '@livekit/protocol';
import type { RTCAVSignalingSetup, RTCSessionControl, RTCSignalingSession } from '@scrypted/sdk';
import { LiveKitSignaling, LiveKitSignalingCloseEvent, LiveKitSignalingDetails, LiveKitSignalingLogger } from './livekit-signaling';

const initialAudioVideoOfferTimeoutMs = 45_000;

export interface LiveKitSessionOptions {
    cameraName: string;
    logger: LiveKitSessionLogger;
}

interface LiveKitSessionLogger extends LiveKitSignalingLogger {
    warn(...args: unknown[]): void;
}

export class LiveKitSession implements RTCSessionControl {
    private cameraName: string;
    private logger: LiveKitSessionLogger;
    private signaling: LiveKitSignaling;
    private iceServers: RTCIceServer[] = [];
    private remoteDescriptionReady = false;
    private closed = false;
    private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
    private initialAudioVideoOffer = new Future();

    private constructor(options: LiveKitSessionOptions, signaling: LiveKitSignaling) {
        this.cameraName = options.cameraName;
        this.logger = options.logger;
        this.signaling = signaling;
    }

    static async connect(options: LiveKitSessionOptions, details: LiveKitSignalingDetails): Promise<LiveKitSession> {
        const signaling = await LiveKitSignaling.connect({
            cameraName: options.cameraName,
            logger: options.logger,
        }, details);
        return new LiveKitSession(options, signaling);
    }

    async start(session: RTCSignalingSession): Promise<RTCSessionControl> {
        this.signaling.on('join', (join: JoinResponse) => this.handleJoin(join));
        this.signaling.on('offer', async (offer: SessionDescription) => {
            if (await this.handleOffer(offer, session))
                this.initialAudioVideoOffer.resolve();
        });
        this.signaling.on('trickle', (trickle: TrickleRequest) => this.handleTrickle(trickle, session));
        this.signaling.on('leave', () => this.handleLeave());
        this.signaling.on('close', (event: LiveKitSignalingCloseEvent) => this.handleClose(event));
        this.signaling.on('error', e => this.handleSignalingError(e));
        this.signaling.on('websocketError', (e: Error) => this.handleWebSocketError(e));
        this.signaling.start();

        try {
            await this.initialAudioVideoOffer.wait(
                initialAudioVideoOfferTimeoutMs,
                `Timed out waiting for LiveKit to offer audio and video for ${this.cameraName}.`,
            );
        }
        catch (e) {
            await this.endSession();
            throw e;
        }

        return this;
    }

    async getRefreshAt(): Promise<number | void> {
    }

    async extendSession(): Promise<void> {
    }

    async setPlayback(_options: { audio: boolean; video: boolean }): Promise<void> {
    }

    async endSession(): Promise<void> {
        this.closed = true;
        await this.signaling.close();
    }

    private handleJoin(join: JoinResponse): void {
        this.iceServers = join.iceServers.map(server => ({
            urls: server.urls,
            username: server.username || undefined,
            credential: server.credential || undefined,
        }));

        const room = join.room?.name || join.room?.sid || 'unknown';
        const participant = join.participant?.identity || join.participant?.sid || 'unknown';
        this.logger.debug(
            `LiveKit join accepted for ${this.cameraName}: room=${room} participant=${participant} iceServers=${this.iceServers.length}`,
        );
    }

    private async handleOffer(offer: SessionDescription, session: RTCSignalingSession): Promise<boolean> {
        if (offer.type !== 'offer')
            throw new Error(`LiveKit sent unsupported session description type=${offer.type}`);

        const mediaKinds = sdpMediaKinds(offer.sdp);
        const hasAudioVideo = mediaKinds.includes('audio') && mediaKinds.includes('video');
        const setup = this.createAnswerSetup(mediaKinds);

        this.logger.debug(
            `Received LiveKit offer for ${this.cameraName}: id=${offer.id} media=${mediaKinds.join(',') || 'none'} audioVideo=${hasAudioVideo}`,
        );

        await session.setRemoteDescription({
            type: 'offer',
            sdp: offer.sdp,
        }, setup);
        this.remoteDescriptionReady = true;
        await this.flushPendingRemoteCandidates(session);

        const answer = await session.createLocalDescription('answer', setup, async candidate => {
            this.signaling.sendIceCandidate(candidate);
        });
        this.signaling.sendAnswer(offer.id, answer);

        return hasAudioVideo;
    }

    private async handleTrickle(trickle: TrickleRequest, session: RTCSignalingSession): Promise<void> {
        if (trickle.target !== SignalTarget.SUBSCRIBER) {
            this.logger.debug(`Dropping LiveKit ICE candidate for target=${trickle.target}.`);
            return;
        }
        if (trickle.final && !trickle.candidateInit) {
            this.logger.debug(`LiveKit sent end-of-candidates for ${this.cameraName}.`);
            return;
        }
        if (!trickle.candidateInit)
            throw new Error('LiveKit sent an ICE candidate without candidateInit.');

        const candidate = parseIceCandidate(trickle.candidateInit);
        if (!this.remoteDescriptionReady) {
            this.pendingRemoteCandidates.push(candidate);
            return;
        }
        await session.addIceCandidate(candidate);
    }

    private async handleLeave(): Promise<void> {
        this.logger.warn(`LiveKit requested leave for ${this.cameraName}.`);
        await this.endSession();
    }

    private handleClose(event: LiveKitSignalingCloseEvent): void {
        if (!this.initialAudioVideoOffer.done)
            this.initialAudioVideoOffer.reject(new Error(event.message));
        else if (!this.closed && !event.requested)
            this.logger.warn(event.message);
    }

    private handleSignalingError(error: unknown): void {
        this.logger.error(`LiveKit signaling failed for ${this.cameraName}.`, error);
        this.initialAudioVideoOffer.reject(error);
        this.endSession().catch(() => undefined);
    }

    private handleWebSocketError(error: Error): void {
        if (!this.initialAudioVideoOffer.done)
            this.initialAudioVideoOffer.reject(error);
        else
            this.logger.warn(`LiveKit signaling websocket error for ${this.cameraName}.`, error);
    }

    private async flushPendingRemoteCandidates(session: RTCSignalingSession): Promise<void> {
        const candidates = this.pendingRemoteCandidates;
        this.pendingRemoteCandidates = [];
        for (const candidate of candidates)
            await session.addIceCandidate(candidate);
    }

    private createAnswerSetup(mediaKinds: string[]): RTCAVSignalingSetup {
        return {
            type: 'answer',
            audio: mediaKinds.includes('audio') ? {
                direction: 'recvonly',
            } : undefined,
            video: mediaKinds.includes('video') ? {
                direction: 'recvonly',
            } : undefined,
            configuration: {
                iceServers: this.iceServers,
            },
        };
    }
}

function parseIceCandidate(candidateInit: string): RTCIceCandidateInit {
    const candidate = JSON.parse(candidateInit) as RTCIceCandidateInit;
    if (!candidate.candidate)
        throw new Error(`LiveKit ICE candidate was missing candidate: ${candidateInit}`);
    if (!candidate.sdpMid && candidate.sdpMLineIndex === undefined)
        throw new Error(`LiveKit ICE candidate was missing sdpMid and sdpMLineIndex: ${candidateInit}`);
    return candidate;
}

function sdpMediaKinds(sdp: string): string[] {
    return sdp
        .split(/\r?\n/)
        .map(line => /^m=([^ ]+) /.exec(line))
        .filter((match): match is RegExpExecArray => !!match)
        .filter(match => !match.input.startsWith(`m=${match[1]} 0 `))
        .map(match => match[1]);
}

class Future {
    readonly promise: Promise<void>;
    done = false;
    private resolvePromise!: () => void;
    private rejectPromise!: (error: unknown) => void;

    constructor() {
        this.promise = new Promise<void>((resolve, reject) => {
            this.resolvePromise = resolve;
            this.rejectPromise = reject;
        });
    }

    resolve(): void {
        if (this.done)
            return;
        this.done = true;
        this.resolvePromise();
    }

    reject(error: unknown): void {
        if (this.done)
            return;
        this.done = true;
        this.rejectPromise(error);
    }

    async wait(timeoutMs: number, message: string): Promise<void> {
        let timeout: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                this.promise,
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
                }),
            ]);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
        }
    }
}

import { JoinResponse, SessionDescription, SignalTarget, TrickleRequest } from '@livekit/protocol';
import type {
    RTCAVSignalingSetup,
    RTCSessionControl,
    RTCSignalingOptions,
    RTCSignalingSendIceCandidate,
    RTCSignalingSession,
} from '@scrypted/sdk';
import { LiveKitSignaling, LiveKitSignalingCloseEvent } from './livekit-signaling';

export class LiveKitRTCSessionControl implements RTCSessionControl {
    private iceConfiguration = new Future<RTCConfiguration>();
    private offers = new AsyncQueue<PendingOffer>();
    private remoteCandidates = new IceCandidateQueue();
    private audioVideoReady = new Future<void>();
    private disableTrickle = false;
    private started = false;
    private ended = false;

    constructor(private signaling: LiveKitSignaling) {
        this.signaling.once('join', (join: JoinResponse) => {
            this.iceConfiguration.resolve({
                iceServers: join.iceServers.map(server => ({
                    urls: server.urls,
                    username: server.username || undefined,
                    credential: server.credential || undefined,
                })),
            });
        });
        this.signaling.on('offer', (offer: SessionDescription) => this.onOffer(offer));
        this.signaling.on('trickle', (trickle: TrickleRequest) => this.onTrickle(trickle));
        this.signaling.on('leave', () => this.onLeave());
        this.signaling.on('close', (event: LiveKitSignalingCloseEvent) => this.onClose(event));
        this.signaling.on('error', error => this.onError(error));
    }

    async start(session: RTCSignalingSession): Promise<void> {
        if (this.started)
            throw new Error('LiveKit RTC session was already started.');
        this.started = true;

        const options = typeof session.options === 'object' ? session.options : await session.getOptions();
        if (options.offer)
            throw new Error('LiveKit and Scrypted both provided RTC offers.');

        const configuration = await this.iceConfiguration;
        this.disableTrickle = !!options.disableTrickle;
        this.answerLiveKitOffers(session, options, configuration)
            .catch(error => this.onError(error));
        await this.audioVideoReady;
    }

    async getRefreshAt(): Promise<number | void> {
    }

    async extendSession(): Promise<void> {
    }

    async setPlayback(_options: { audio: boolean; video: boolean }): Promise<void> {
    }

    async endSession(): Promise<void> {
        if (this.ended)
            return;
        this.ended = true;
        this.rejectPending(new Error('LiveKit RTC session ended.'));
        await this.signaling.close();
    }

    private onOffer(offer: SessionDescription): void {
        const pendingOffer = {
            offer,
            remoteCandidates: new IceCandidateQueue(),
        };
        this.remoteCandidates = pendingOffer.remoteCandidates;
        this.offers.add(pendingOffer);
    }

    private async answerLiveKitOffers(session: RTCSignalingSession, options: RTCSignalingOptions, configuration: RTCConfiguration): Promise<void> {
        for await (const pendingOffer of this.offers) {
            if (await this.answerOffer(session, options, configuration, pendingOffer))
                this.audioVideoReady.resolve();
        }
    }

    private async answerOffer(
        session: RTCSignalingSession,
        options: RTCSignalingOptions,
        configuration: RTCConfiguration,
        pendingOffer: PendingOffer,
    ): Promise<boolean> {
        const { offer, remoteCandidates } = pendingOffer;
        if (offer.type !== 'offer')
            throw new Error(`LiveKit sent unsupported session description type=${offer.type}.`);

        const availableMediaKinds = offer.sdp
            .split(/\r?\n/)
            .map(line => /^m=([^ ]+) /.exec(line))
            .filter((match): match is RegExpExecArray => !!match)
            .filter(match => !match.input.startsWith(`m=${match[1]} 0 `))
            .map(match => match[1]);
        const selectedMediaKinds: string[] = [];
        const capabilities = options.capabilities;
        if (availableMediaKinds.includes('audio') && (!capabilities || !!capabilities.audio))
            selectedMediaKinds.push('audio');
        if (availableMediaKinds.includes('video') && (!capabilities || !!capabilities.video))
            selectedMediaKinds.push('video');
        if (availableMediaKinds.includes('application'))
            selectedMediaKinds.push('application');
        const setup: RTCAVSignalingSetup = {
            type: 'answer',
            audio: selectedMediaKinds.includes('audio') ? {
                direction: 'sendrecv',
            } : undefined,
            video: selectedMediaKinds.includes('video') ? {
                direction: 'recvonly',
            } : undefined,
            datachannel: selectedMediaKinds.includes('application') ? {
                label: 'livekit',
            } : undefined,
            configuration,
        };
        const localCandidates = new IceCandidateQueue();

        await session.setRemoteDescription({
            type: 'offer',
            sdp: offer.sdp,
        }, setup);

        const answer = await session.createLocalDescription(
            'answer',
            setup,
            this.disableTrickle ? undefined : candidate => localCandidates.add(candidate),
        );
        this.signaling.sendAnswer(offer.id, answer);

        if (!this.disableTrickle) {
            await localCandidates.flush(async candidate => this.signaling.sendIceCandidate(candidate));
            await remoteCandidates.flush(candidate => session.addIceCandidate(candidate));
        }

        return availableMediaKinds.includes('audio') && availableMediaKinds.includes('video');
    }

    private async onTrickle(trickle: TrickleRequest): Promise<void> {
        if (this.disableTrickle)
            return;
        if (trickle.target !== SignalTarget.SUBSCRIBER)
            return;
        if (trickle.final && !trickle.candidateInit)
            return;
        if (!trickle.candidateInit)
            throw new Error('LiveKit sent an ICE candidate without candidateInit.');

        const candidate = JSON.parse(trickle.candidateInit) as RTCIceCandidateInit;
        if (!candidate.candidate)
            throw new Error(`LiveKit ICE candidate was missing candidate: ${trickle.candidateInit}`);
        if (!candidate.sdpMid && candidate.sdpMLineIndex === undefined)
            throw new Error(`LiveKit ICE candidate was missing sdpMid and sdpMLineIndex: ${trickle.candidateInit}`);

        await this.remoteCandidates.add(candidate);
    }

    private async onLeave(): Promise<void> {
        await this.endSession();
    }

    private onClose(event: LiveKitSignalingCloseEvent): void {
        this.ended = true;
        this.rejectPending(event.error);
    }

    private onError(error: unknown): void {
        if (this.ended)
            return;
        this.rejectPending(error);
        this.endSession().catch(() => undefined);
    }

    private rejectPending(error: unknown): void {
        this.iceConfiguration.reject(error);
        this.offers.reject(error);
        this.audioVideoReady.reject(error);
    }
}

interface PendingOffer {
    offer: SessionDescription;
    remoteCandidates: IceCandidateQueue;
}

class Future<T> implements PromiseLike<T> {
    promise: Promise<T>;
    resolve!: (value: T | PromiseLike<T>) => void;
    reject!: (reason?: unknown) => void;
    then: Promise<T>['then'] = function (this: Future<T>) {
        return this.promise.then.apply(this.promise, arguments as any);
    } as Promise<T>['then'];

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        this.promise.catch(() => undefined);
    }
}

class IceCandidateQueue {
    private sendCandidate?: RTCSignalingSendIceCandidate;
    private candidates: RTCIceCandidateInit[] = [];
    private ready = false;

    async flush(sendCandidate: RTCSignalingSendIceCandidate): Promise<void> {
        const candidates = this.candidates;
        this.sendCandidate = sendCandidate;
        this.candidates = [];
        this.ready = true;
        for (const candidate of candidates)
            await sendCandidate(candidate);
    }

    async add(candidate: RTCIceCandidateInit): Promise<void> {
        if (!this.ready || !this.sendCandidate) {
            this.candidates.push(candidate);
            return;
        }

        await this.sendCandidate(candidate);
    }
}

class AsyncQueue<T> implements AsyncIterable<T> {
    private values: T[] = [];
    private pendingNext?: Future<T>;
    private rejected = false;
    private rejection?: unknown;

    add(value: T): void {
        if (this.rejected)
            return;

        if (this.pendingNext) {
            this.pendingNext.resolve(value);
            this.pendingNext = undefined;
            return;
        }

        this.values.push(value);
    }

    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        while (true)
            yield await this.next();
    }

    private async next(): Promise<T> {
        if (this.rejected)
            throw this.rejection;
        if (this.values.length)
            return this.values.shift() as T;

        this.pendingNext = new Future<T>();
        return this.pendingNext;
    }

    reject(error: unknown): void {
        if (this.rejected)
            return;

        this.rejected = true;
        this.rejection = error;
        this.values = [];
        this.pendingNext?.reject(error);
        this.pendingNext = undefined;
    }
}

import {
    ClientInfo,
    ClientInfo_SDK,
    ConnectionSettings,
    JoinRequest,
    JoinResponse,
    MediaSectionsRequirement,
    ParticipantUpdate,
    Ping,
    SessionDescription,
    SignalRequest,
    SignalResponse,
    SignalTarget,
    SubscriptionPermissionUpdate,
    TrackSource,
    TrackType,
    TrickleRequest,
    WrappedJoinRequest,
    WrappedJoinRequest_Compression,
} from '@livekit/protocol';
import { RTCAVSignalingSetup, RTCSessionControl, RTCSignalingSession } from '@scrypted/sdk';
import type { Duplex } from 'stream';
import { RTCIceCandidate, RTCPeerConnection } from 'werift';
import WebSocket, { createWebSocketStream } from 'ws';
import { gzipSync } from 'zlib';
import { createCandidateQueue, Deferred } from './common';

const liveKitProtocolVersion = 16;
const liveKitSdkVersion = '1.0.17';

export interface LiveKitSignalingOptions {
    token?: string;
    joinRequest?: JoinRequest;
}

export type LiveKitSignalMessage = SignalResponse['message'];
type LiveKitSignalRequestMessage = Exclude<SignalRequest['message'], { case: undefined }>;

export class LiveKitSignaling implements AsyncIterable<LiveKitSignalMessage> {
    private readonly answers = new Map<number, Deferred<SessionDescription>>();
    private readonly messageStream: Duplex;
    private nextOfferId = 1;
    private pingTimer: NodeJS.Timeout | null = null;

    static createMessageStream(server: string, options: LiveKitSignalingOptions = {}): LiveKitSignaling {
        const joinRequest = options.joinRequest ?? new JoinRequest({
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
        const endpoint = new URL('/rtc', server);
        const wrapped = new WrappedJoinRequest({
            compression: WrappedJoinRequest_Compression.GZIP,
            joinRequest: gzipSync(Buffer.from(joinRequest.toBinary())),
        });
        endpoint.searchParams.set(
            'join_request',
            Buffer.from(wrapped.toBinary())
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_'),
        );
        const ws = new WebSocket(endpoint, {
            headers: options.token ? {
                Authorization: `Bearer ${options.token}`,
            } : {},
        });
        return new LiveKitSignaling(ws);
    }

    constructor(ws: WebSocket) {
        this.messageStream = createWebSocketStream(ws, { readableObjectMode: true });
        this.messageStream.on('end', () => void this.close());
        this.messageStream.on('error', () => void this.close());
    }

    close(): void {
        this.stopPing();
        for (const answer of this.answers.values()) {
            void answer.promise.catch(() => {});
            answer.reject(new Error('LiveKit signaling closed before answering the offer.'));
        }
        this.answers.clear();
        if (!this.messageStream.destroyed && !this.messageStream.writableEnded)
            this.messageStream.end();
    }

    [Symbol.asyncIterator](): AsyncIterator<LiveKitSignalMessage> {
        return this.messages({ destroyOnReturn: false });
    }

    async *messages(...options: Parameters<Duplex['iterator']>): AsyncGenerator<LiveKitSignalMessage> {
        for await (const data of this.messageStream.iterator(...options)) {
            const message = SignalResponse.fromBinary(data).message;
            if (message.case === 'join')
                this.startPing(message.value);
            if (message.case === 'answer') {
                const answer = this.answers.get(message.value.id);
                if (answer) {
                    this.answers.delete(message.value.id);
                    answer.resolve(message.value);
                }
            }
            yield message;
        }
    }

    sendOffer(offer: RTCSessionDescriptionInit): Promise<SessionDescription> {
        const id = this.nextOfferId++;
        const answer = new Deferred<SessionDescription>();
        this.answers.set(id, answer);
        this.sendRequest('offer', new SessionDescription({
            id,
            type: offer.type,
            sdp: offer.sdp || '',
        }));
        return answer.promise;
    }

    sendIceCandidate(candidate: RTCIceCandidateInit): void {
        this.sendRequest('trickle', new TrickleRequest({
            candidateInit: JSON.stringify(candidate),
            target: SignalTarget.PUBLISHER,
        }));
    }

    private sendRequest<Case extends LiveKitSignalRequestMessage['case']>(
        messageCase: Case,
        value: Extract<LiveKitSignalRequestMessage, { case: Case }>['value'],
    ): void {
        const message = { case: messageCase, value } as LiveKitSignalRequestMessage;
        this.messageStream.write(Buffer.from(new SignalRequest({ message }).toBinary()));
    }

    private startPing(join: JoinResponse): void {
        if (join.pingInterval <= 0)
            return;

        this.stopPing();
        this.pingTimer = setInterval(() => {
            this.sendRequest('pingReq', new Ping({
                timestamp: BigInt(Date.now()),
            }));
        }, join.pingInterval * 1000);
    }

    private stopPing(): void {
        if (this.pingTimer === null) {
            return
        }
        clearInterval(this.pingTimer);
        this.pingTimer = null;
    }
}

type CameraTrack = `${TrackType}:${TrackSource}`;

class LiveKitWarmup {
    private readonly peerConnection: RTCPeerConnection;
    private readonly remoteCandidates;
    private readonly requiredTracks = new Map<CameraTrack, string | null>();
    private readonly trackPermissions = new Map<string, boolean>();

    constructor(
        private readonly signaling: LiveKitSignaling,
        iceServers: JoinResponse['iceServers'],
    ) {
        this.peerConnection = new RTCPeerConnection({
            iceServers: iceServers.flatMap(
                iceServer => iceServer.urls.map(
                    url => ({
                        urls: url,
                        username: iceServer.username || undefined,
                        credential: iceServer.credential || undefined,
                    })
                )
            ),
        });
        this.peerConnection.onIceCandidate.subscribe(candidate => {
            if (candidate)
                this.signaling.sendIceCandidate(candidate.toJSON());
        });
        this.remoteCandidates = createCandidateQueue(
            candidate => this.peerConnection.addIceCandidate(
                new RTCIceCandidate({
                    candidate: candidate.candidate,
                    sdpMid: candidate.sdpMid ?? undefined,
                    sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
                })
            )
        );
    }

    async waitForTrackPermissions(requiredTracks: ReadonlyMap<CameraTrack, 'audio' | 'video'>): Promise<void> {
        try {
            for (const [track, kind] of requiredTracks) {
                this.requiredTracks.set(track, null);
                this.peerConnection.addTransceiver(kind, { direction: 'recvonly' });
            }
            await this.sendOffer();
            for await (const message of this.signaling) {
                switch (message.case) {
                    case 'answer':
                        await this.onAnswer(message.value);
                        break;
                    case 'trickle':
                        await this.onTrickle(message.value);
                        break;
                    case 'update':
                        this.onParticipantUpdate(message.value);
                        break;
                    case 'subscriptionPermissionUpdate':
                        this.onSubscriptionPermissionUpdate(message.value);
                        break;
                    case 'mediaSectionsRequirement':
                        await this.sendOffer();
                        break;
                    case 'leave':
                        throw new Error('LiveKit left during media warmup.');
                }
                if (!this.requiredTracks.size)
                    return;
            }
            throw new Error('LiveKit signaling closed during media warmup.');
        }
        finally {
            await this.peerConnection.close();
        }
    }

    private async onAnswer(answer: SessionDescription): Promise<void> {
        await this.peerConnection.setRemoteDescription({
            type: answer.type as 'offer' | 'answer',
            sdp: answer.sdp,
        });
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

    private onParticipantUpdate(update: ParticipantUpdate): void {
        for (const participant of update.participants) {
            if (!participant.isPublisher)
                continue;
            for (const track of participant.tracks) {
                const cameraTrack = `${track.type}:${track.source}` as CameraTrack;
                if (!track.sid || !this.requiredTracks.has(cameraTrack))
                    continue;

                if (this.trackPermissions.get(track.sid))
                    this.requiredTracks.delete(cameraTrack);
                else
                    this.requiredTracks.set(cameraTrack, track.sid);
            }
        }
    }

    private onSubscriptionPermissionUpdate(update: SubscriptionPermissionUpdate): void {
        this.trackPermissions.set(update.trackSid, update.allowed);
        if (!update.allowed)
            return;

        for (const [cameraTrack, trackSid] of this.requiredTracks) {
            if (trackSid === update.trackSid) {
                this.requiredTracks.delete(cameraTrack);
                return;
            }
        }
    }

    private async sendOffer(): Promise<void> {
        const offer = await this.peerConnection.createOffer();
        const localDescription = (await this.peerConnection.setLocalDescription(offer)).toJSON();
        this.signaling.sendOffer(localDescription);
    }
}

export class LiveKitSession {
    private constructor(
        readonly signaling: LiveKitSignaling,
        readonly iceServers: JoinResponse['iceServers'],
    ) {
    }

    static async start(liveKitURL: string, token: string): Promise<LiveKitSession> {
        const requiredCameraTracks: ReadonlyMap<CameraTrack, 'audio' | 'video'> = new Map([
            [`${TrackType.AUDIO}:${TrackSource.MICROPHONE}`, 'audio'],
            [`${TrackType.VIDEO}:${TrackSource.CAMERA}`, 'video'],
        ]);
        for (let attempt = 0; attempt < 2; attempt++) {
            const signaling = LiveKitSignaling.createMessageStream(liveKitURL, { token });
            try {
                const joinResponse = await this.waitForJoin(signaling);
                const cameraTracks = new Set<CameraTrack>();
                for (const participant of joinResponse.otherParticipants) {
                    if (!participant.isPublisher)
                        continue;
                    for (const track of participant.tracks) {
                        const cameraTrack = `${track.type}:${track.source}` as CameraTrack;
                        if (requiredCameraTracks.has(cameraTrack))
                            cameraTracks.add(cameraTrack);
                    }
                }
                if (cameraTracks.size === requiredCameraTracks.size)
                    return new LiveKitSession(signaling, joinResponse.iceServers);
                if (attempt) {
                    throw new Error(
                        `LiveKit joined with ${cameraTracks.size} of ${requiredCameraTracks.size} required camera tracks after media warmup.`,
                    );
                }
                try {
                    await new LiveKitWarmup(signaling, joinResponse.iceServers).waitForTrackPermissions(requiredCameraTracks);
                } catch (error) {
                    console.warn('LiveKit media warmup failed; continuing with browser signaling.', error);
                }
                signaling.close();
            } catch (error) {
                signaling.close();
                throw error;
            }
        }
        throw new Error('LiveKit did not create a browser signaling session.');
    }

    close(): void {
        this.signaling.close();
    }

    async connectSignalingClient(session: RTCSignalingSession): Promise<LiveKitRTCSessionControl> {
        const control = new LiveKitRTCSessionControl(this);
        await control.connect(session);
        return control;
    }

    private static async waitForJoin(signaling: LiveKitSignaling): Promise<JoinResponse> {
        for await (const message of signaling) {
            if (message.case === 'join')
                return message.value;
            if (message.case === 'leave')
                throw new Error('LiveKit left before joining.');
        }
        throw new Error('LiveKit signaling closed before joining.');
    }
}

export class LiveKitRTCSessionControl implements RTCSessionControl {
    private remoteCandidates!: ReturnType<typeof createCandidateQueue>;
    private readonly setup: RTCAVSignalingSetup;
    private session!: RTCSignalingSession;

    constructor(private readonly liveKitSession: LiveKitSession) {
        this.setup = {
            type: 'offer',
            configuration: {
                iceServers: this.liveKitSession.iceServers.map(iceServer => ({
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
        };
    }

    async connect(session: RTCSignalingSession): Promise<void> {
        if (this.session)
            throw new Error('LiveKit signaling client is already connected.');

        this.session = session;
        this.remoteCandidates = createCandidateQueue(candidate => session.addIceCandidate(candidate));
        const messageLoop = this.receiveMessages();
        void messageLoop
            .catch(error => console.error('LiveKit signaling session failed.', error))
            .finally(() => this.endSession());
        const answer = await Promise.race([
            this.sendOffer(),
            messageLoop.then(() => {
                throw new Error('LiveKit signaling closed before answering the browser offer.');
            }),
        ]);
        await this.session.setRemoteDescription({
            type: answer.type as RTCSdpType,
            sdp: answer.sdp,
        }, this.setup);
        await this.remoteCandidates.flush();
    }

    private async receiveMessages(): Promise<void> {
        for await (const message of this.liveKitSession.signaling) {
            switch (message.case) {
                case 'trickle':
                    await this.onTrickle(message.value);
                    break;
                case 'mediaSectionsRequirement':
                    await this.onMediaSectionsRequirement(message.value);
                    break;
                case 'leave':
                    return;
            }
        }
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

    private async onMediaSectionsRequirement(requirement: MediaSectionsRequirement): Promise<void> {
        if (requirement.numAudios || requirement.numVideos) {
            throw new Error(
                `LiveKit requested additional media sections: audio=${requirement.numAudios} video=${requirement.numVideos}.`,
            );
        }

        void this.sendOffer();
    }

    private async sendOffer(): Promise<SessionDescription> {
        const candidates = createCandidateQueue(candidate => {
            this.liveKitSession.signaling.sendIceCandidate(candidate);
            return Promise.resolve();
        });
        const offer = await this.session.createLocalDescription(
            'offer',
            this.setup,
            this.session.options.disableTrickle ? undefined : candidates.sendIceCandidate,
        );
        const answer = this.liveKitSession.signaling.sendOffer(offer);
        await candidates.flush();
        return answer;
    }

    async getRefreshAt(): Promise<number | void> {
    }

    async extendSession(): Promise<void> {
    }

    async setPlayback(_options: { audio: boolean; video: boolean }): Promise<void> {
    }

    async endSession(): Promise<void> {
        this.liveKitSession.close();
    }
}

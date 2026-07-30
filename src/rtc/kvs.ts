import {
    RTCAVSignalingSetup,
    RTCSessionControl,
    RTCSignalingOptions,
    RTCSignalingSendIceCandidate,
    RTCSignalingSession,
} from '@scrypted/sdk';
import { randomUUID } from 'crypto';
import { on } from 'events';
import { parse, parseParams, write } from 'sdp-transform';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { createCandidateQueue, Deferred } from './common';

const maxKVSMessagePayloadSize = 10 * 1024;

const kvsEncodedMessagePayloadSchema = z.string().transform(value =>
    JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
);
const kvsMessageEnvelopeSchema = z.union([
    z.discriminatedUnion('messageType', [
        z.looseObject({
            messageType: z.literal('STATUS_RESPONSE'),
            messagePayload: z.string().optional(),
            statusResponse: z.looseObject({
                correlationId: z.string(),
                errorType: z.string().optional(),
                statusCode: z.string().optional(),
                description: z.string().optional(),
            }),
        }),
        z.looseObject({
            messageType: z.literal('SDP_OFFER'),
            messagePayload: kvsEncodedMessagePayloadSchema.pipe(z.looseObject({
                type: z.literal('offer'),
                sdp: z.string().min(1),
            })),
        }),
        z.looseObject({
            messageType: z.literal('SDP_ANSWER'),
            messagePayload: kvsEncodedMessagePayloadSchema.pipe(z.looseObject({
                type: z.string().optional(),
                sdp: z.string().min(1),
            })),
        }),
        z.looseObject({
            messageType: z.literal('ICE_CANDIDATE'),
            messagePayload: kvsEncodedMessagePayloadSchema.pipe(z.looseObject({
                candidate: z.string().optional().default(''),
                sdpMid: z.string().nullable().optional(),
                sdpMLineIndex: z.number().int().nullable().optional(),
                usernameFragment: z.string().nullable().optional(),
            })),
        }),
    ]),
    z.unknown().transform(raw => ({ messageType: 'raw' as const, raw })),
]);
const kvsResponseSchema = z.string()
    .transform(data => JSON.parse(data))
    .pipe(kvsMessageEnvelopeSchema);

type KVSMessage = Exclude<
    KVSResponse,
    { messageType: 'STATUS_RESPONSE' }
>;
type KVSRequestMessage = Exclude<KVSMessage, { messageType: 'raw' }>;
export type KVSMessageType = KVSRequestMessage['messageType'];
type KVSMessagePayload<Type extends KVSMessageType> = Extract<
    KVSRequestMessage,
    { messageType: Type }
>['messagePayload'];

export interface KVSRequest<Type extends KVSMessageType = KVSMessageType> {
    action: Type;
    recipientClientId: string;
    correlationId: string;
    messagePayload: KVSMessagePayload<Type>;
}

export type KVSResponse = z.output<typeof kvsResponseSchema>;

function serializeKVSMessagePayload(messagePayload: unknown): string {
    return Buffer.from(JSON.stringify(messagePayload)).toString('base64');
}

export function serializeKVSRequest<Type extends KVSMessageType>(request: KVSRequest<Type>): string {
    const messagePayload = serializeKVSMessagePayload(request.messagePayload);
    if (Buffer.byteLength(messagePayload) > maxKVSMessagePayloadSize)
        throw new Error(`KVS ${request.action} message payload exceeds the 10 KiB limit.`);

    return JSON.stringify({
        ...request,
        messagePayload,
    });
}

export function unserializeKVSResponse(data: string): KVSResponse {
    return kvsResponseSchema.parse(data);
}

const kvsCodecRemovalOrder = ['AV1', 'telephone-event', 'CN', 'G722', 'PCMU', 'PCMA'] as const;

function reduceKVSOffer(sdp: string): string {
    let reducedSdp = sdp;
    let description: ReturnType<typeof parse> | undefined;
    for (const codec of kvsCodecRemovalOrder) {
        if (Buffer.byteLength(serializeKVSMessagePayload({ type: 'offer', sdp: reducedSdp })) <= maxKVSMessagePayloadSize)
            break;

        description ??= parse(sdp);
        for (const media of description.media) {
            const removedPayloads = new Set(media.rtp.flatMap(
                candidate => candidate.codec === codec ? [candidate.payload] : []
            ));
            for (const { payload, config } of media.fmtp) {
                const { apt } = parseParams(config);
                if (typeof apt === 'number' && removedPayloads.has(apt))
                    removedPayloads.add(payload);
            }
            if (!removedPayloads.size)
                continue;

            media.payloads = media.payloads?.split(' ')
                .filter(payload => !removedPayloads.has(Number(payload)))
                .join(' ');
            media.rtp = media.rtp.filter(
                candidate => !removedPayloads.has(candidate.payload)
            );
            media.fmtp = media.fmtp.filter(
                candidate => !removedPayloads.has(candidate.payload)
            );
            media.rtcpFb = media.rtcpFb?.filter(
                candidate => !removedPayloads.has(candidate.payload as number)
            );
            media.rtcpFbTrrInt = media.rtcpFbTrrInt?.filter(
                candidate => !removedPayloads.has(candidate.payload as number)
            );
        }
        reducedSdp = write(description);
    }

    return reducedSdp;
}

export interface KVSSignalingSessionDetails {
    signedChannelEndpoint: string;
    clientId: string;
}

export class KVSRTCSignalingSession implements RTCSignalingSession, RTCSessionControl {
    readonly options: RTCSignalingOptions = {
        requiresOffer: true,
    };
    readonly __proxy_props = {
        options: this.options,
    };

    private readonly opened = new Deferred<void>();
    private readonly sessionId = randomUUID();
    private readonly ws: WebSocket;
    private readonly recipientClientId: string;
    private nextMessageId = 1;
    private answer?: Deferred<RTCSessionDescriptionInit>;
    private candidates?: ReturnType<typeof createCandidateQueue>;
    private sendIceCandidate?: RTCSignalingSendIceCandidate;

    constructor(details: KVSSignalingSessionDetails) {
        this.ws = new WebSocket(details.signedChannelEndpoint);
        this.recipientClientId = details.clientId;
        this.ws.once('open', () => this.opened.resolve());
        this.ws.once('error', error => this.opened.reject(error));
        void this.receiveMessages().catch(error => {
            this.opened.reject(error);
            this.answer?.reject(error);
            this.ws.close()
        });
    }

    async getOptions(): Promise<RTCSignalingOptions> {
        return this.options;
    }

    async createLocalDescription(
        type: 'offer' | 'answer',
        _setup: RTCAVSignalingSetup,
        sendIceCandidate: RTCSignalingSendIceCandidate | undefined,
    ): Promise<RTCSessionDescriptionInit> {
        if (type !== 'answer')
            throw new Error('KVS only returns SDP answers.');

        if (!this.answer)
            throw new Error('KVS SDP offer has not been sent.');

        this.sendIceCandidate = sendIceCandidate;
        await this.candidates?.flush();
        return this.answer.promise;
    }

    async setRemoteDescription(offer: RTCSessionDescriptionInit, _setup: RTCAVSignalingSetup): Promise<void> {
        if (offer.type !== 'offer')
            throw new Error('KVS only accepts SDP offers.');
        this.answer = new Deferred<RTCSessionDescriptionInit>();
        this.candidates = createCandidateQueue(async candidate => {
            await this.sendIceCandidate?.(candidate);
        });
        const messagePayload = {
            type: 'offer',
            sdp: reduceKVSOffer(offer.sdp || ''),
        } as const;
        await this.sendMessage('SDP_OFFER', messagePayload);
    }

    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        if (!candidate?.candidate)
            return;

        await this.sendMessage('ICE_CANDIDATE', {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid ?? null,
            sdpMLineIndex: candidate.sdpMLineIndex ?? null,
            usernameFragment: candidate.usernameFragment ?? null,
        });
    }

    async getRefreshAt(): Promise<number | void> {
    }

    async extendSession(): Promise<void> {
    }

    async setPlayback(_options: { audio: boolean; video: boolean }): Promise<void> {
    }

    async endSession(): Promise<void> {
        this.ws.close();
    }

    private async sendMessage<Type extends KVSMessageType>(action: Type, messagePayload: KVSRequest<Type>['messagePayload']): Promise<void> {
        await this.opened.promise;
        this.ws.send(serializeKVSRequest({
            action,
            messagePayload,
            recipientClientId: this.recipientClientId,
            correlationId: this.nextCorrelationId(),
        }));
    }

    private nextCorrelationId(): string {
        return `${this.sessionId}.${this.nextMessageId++}`;
    }

    private async receiveMessages(): Promise<void> {
        for await (const [data] of on(this.ws, 'message', { close: ['close'] })) {
            const messageData = (data as Buffer).toString('utf8');
            if (!messageData)
                continue;

            let message: ReturnType<typeof unserializeKVSResponse>;
            try {
                message = unserializeKVSResponse(messageData);
            }
            catch (error) {
                console.error('Failed to parse KVS signaling message.', error);
                continue;
            }
            switch (message.messageType) {
                case 'raw':
                    console.debug('Received unhandled KVS signaling message.', message.raw);
                    break;
                case 'SDP_ANSWER': {
                    this.answer?.resolve({
                        type: 'answer',
                        sdp: message.messagePayload.sdp,
                    });
                    break;
                }
                case 'ICE_CANDIDATE': {
                    if (message.messagePayload.candidate)
                        await this.candidates?.sendIceCandidate(message.messagePayload);
                    break;
                }
                case 'STATUS_RESPONSE': {
                    const { statusCode, errorType, description } = message.statusResponse;
                    const details = [statusCode, errorType, description].filter(Boolean).join(' ');
                    this.answer?.reject(new Error(`KVS signaling request failed${details ? `: ${details}` : '.'}`));
                    break;
                }
            }
        }
    }
}

import {
    RTCAVSignalingSetup,
    RTCSessionControl,
    RTCSignalingOptions,
    RTCSignalingSendIceCandidate,
    RTCSignalingSession,
} from '@scrypted/sdk';
import { randomUUID } from 'crypto';
import { on } from 'events';
import WebSocket from 'ws';
import { z } from 'zod';
import { createCandidateQueue, Deferred } from './common';

const kvsResponseSchema = z.looseObject({
    messageType: z.string(),
    messagePayload: z.string(),
});

const kvsMessagePayloadSchemas = {
    SDP_OFFER: z.looseObject({
        type: z.literal('offer'),
        sdp: z.string().min(1),
    }),
    SDP_ANSWER: z.looseObject({
        type: z.string().optional(),
        sdp: z.string().min(1),
    }),
    ICE_CANDIDATE: z.looseObject({
        candidate: z.string().optional().default(''),
        sdpMid: z.string().nullable().optional(),
        sdpMLineIndex: z.number().int().nullable().optional(),
        usernameFragment: z.string().nullable().optional(),
    }),
} as const satisfies Readonly<Record<string, z.ZodType>>;

export type KVSMessageType = keyof typeof kvsMessagePayloadSchemas;
type KVSMessagePayload<Type extends string> = Type extends KVSMessageType
    ? z.output<(typeof kvsMessagePayloadSchemas)[Type]>
    : any;

export type KVSMessage<Type extends string = KVSMessageType> = Type extends string
    ? {
        messageType: Type;
        messagePayload: KVSMessagePayload<Type>;
    }
    : never;

export interface KVSRequest<Type extends string = KVSMessageType> {
    action: Type;
    recipientClientId: string;
    correlationId: string;
    messagePayload: KVSMessagePayload<Type>;
}

export type KVSResponse =
    | { known: true } & KVSMessage<KVSMessageType>
    | { known: false } & KVSMessage<string>;

export function serializeKVSRequest<Type extends string>(request: KVSRequest<Type>): string {
    return JSON.stringify({
        ...request,
        messagePayload: Buffer.from(JSON.stringify(request.messagePayload)).toString('base64'),
    });
}

export function unserializeKVSResponse(data: string): KVSResponse {
    const parsed = kvsResponseSchema.parse(JSON.parse(data));
    const payload = JSON.parse(Buffer.from(parsed.messagePayload, 'base64').toString('utf8'));
    const schema = Object.prototype.hasOwnProperty.call(kvsMessagePayloadSchemas, parsed.messageType)
        ? kvsMessagePayloadSchemas[parsed.messageType as KVSMessageType]
        : undefined;
    return {
        ...parsed,
        known: !!schema,
        messagePayload: schema
            ? schema.parse(payload)
            : payload
    } as KVSResponse;
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
        await this.sendMessage('SDP_OFFER', {
            type: 'offer',
            sdp: offer.sdp || '',
        });
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
            const raw = (data as Buffer).toString('utf8');
            if (!raw)
                continue;

            let message: ReturnType<typeof unserializeKVSResponse>;
            try {
                message = unserializeKVSResponse(raw);
            }
            catch (error) {
                console.error('Failed to parse KVS signaling message.', error);
                continue;
            }
            if (!message.known)
                continue;

            switch (message.messageType) {
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
            }
        }
    }
}

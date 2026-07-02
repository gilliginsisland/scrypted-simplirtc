import { z } from 'zod';

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

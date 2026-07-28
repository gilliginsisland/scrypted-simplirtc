import { z } from 'zod';
import type { SimpliSafeApi, SimpliSafeMedia } from './api';

const baseUrl = 'https://app-hub.prd.aser.simplisafe.com/v2';

const cameraAdminSchema = z.looseObject({
    webRTCProvider: z.string().min(1),
    firmwareVersion: z.string().min(1),
});
const cameraSettingsSchema = z.looseObject({
    cameraName: z.string().min(1),
    admin: cameraAdminSchema,
});
export function simpliSafeEventSchema(mediaSchema: z.ZodType<SimpliSafeMedia>) {
    const eventVideoSchema = z.looseObject({
        _links: z.looseObject({
            'snapshot/jpg': mediaSchema.optional(),
        }).optional(),
    });
    return z.looseObject({
        eventCid: z.number().optional(),
        eventTimestamp: z.number().optional(),
        info: z.string().min(1).optional(),
        sid: z.number().optional(),
        sensorName: z.string().optional(),
        sensorSerial: z.string().optional(),
        sensorType: z.union([
            z.string().min(1),
            z.number(),
        ]).optional(),
        video: z.record(z.string(), eventVideoSchema).nullable().optional(),
        videoStartedBy: z.string().nullable().optional(),
    });
}
export type SimpliSafeEvent = z.output<ReturnType<typeof simpliSafeEventSchema>>;
export const cameraSchema = z.looseObject({
    uuid: z.string().min(1),
    serial: z.string().min(1),
    sid: z.number(),
    model: z.string().min(1),
    cameraSettings: cameraSettingsSchema,
});
export type SimpliSafeCameraDetails = z.output<typeof cameraSchema>;

export class SimpliSafeCamera {
    #details!: SimpliSafeCameraDetails;

    constructor(private api: SimpliSafeApi) {
    }

    update(details: SimpliSafeCameraDetails): void {
        this.#details = details;
    }

    get name(): string {
        return this.#details.cameraSettings.cameraName;
    }

    get serial(): string {
        return this.#details.serial;
    }

    get uuid(): string {
        return this.#details.uuid;
    }

    get systemId(): number {
        return this.#details.sid;
    }

    get backend(): SimpliSafeCameraBackend {
        return this.#details.cameraSettings.admin.webRTCProvider;
    }

    get model(): string {
        return this.#details.model;
    }

    get firmware(): string {
        return this.#details.cameraSettings.admin.firmwareVersion;
    }

    get raw(): SimpliSafeCameraDetails {
        return this.#details;
    }

    async getLiveView<Backend extends SimpliSafeCameraBackend>(backend: Backend): Promise<SimpliSafeLiveView<Backend>> {
        const parser = Object.prototype.hasOwnProperty.call(liveViewParsers, backend)
            ? backend as SimpliSafeKnownCameraBackend
            : 'raw';
        const schema = parser === 'raw' ? raw : liveViewParsers[parser];
        const liveView = await this.api.requestJson(
            `cameras/${encodeURIComponent(this.uuid)}/${encodeURIComponent(this.systemId.toString())}/live-view`,
            { baseUrl, schema },
        );
        return liveView as SimpliSafeLiveView<Backend>;
    }

    private async getEvents(options?: { before?: number; pageSize?: number }): Promise<SimpliSafeEvent[]> {
        const { before, pageSize } = options ?? {};
        const searchParams = new URLSearchParams();
        if (before !== undefined)
            searchParams.set('fromTimestamp', before.toString());
        if (pageSize !== undefined)
            searchParams.set('numEvents', pageSize.toString());
        const response = await this.api.requestJson(
            `subscriptions/${encodeURIComponent(this.systemId.toString())}/events`,
            {
                schema: z.looseObject({
                    events: z.array(simpliSafeEventSchema(this.api.mediaSchema())),
                }),
                searchParams,
            },
        );
        return response.events;
    }

    async *events(options?: { before?: number; pageSize?: number }): AsyncIterable<SimpliSafeEvent[]> {
        let opts = options;
        for (; ;) {
            const events = await this.getEvents(opts);
            yield events;
            if (events.length < (opts?.pageSize ?? 1))
                return;
            opts = {
                before: events[events.length - 1].eventTimestamp!,
                pageSize: events.length,
            }
        }
    }
}

const iceServerSchema = z.looseObject({
    urls: z.union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1),
    ]),
    username: z.string().min(1).optional(),
    credential: z.string().min(1).optional(),
});
export const raw = z.looseObject({});

const liveViewParsers = {
    kvs: z.looseObject({
        signedChannelEndpoint: z.string().min(1),
        clientId: z.string().min(1),
        iceServers: z.array(iceServerSchema).min(1),
    }),
    mist: z.looseObject({
        liveKitDetails: z.looseObject({
            liveKitURL: z.string().min(1),
            userToken: z.string().min(1),
        }),
    }),
} as const satisfies Readonly<Record<string, z.ZodType>>;

export type SimpliSafeKnownCameraBackend = keyof typeof liveViewParsers;
export type SimpliSafeCameraBackend = keyof typeof liveViewParsers | (string & {});

type SimpliSafeLiveViewParser<Backend extends string> = Backend extends SimpliSafeKnownCameraBackend
    ? (typeof liveViewParsers)[Backend]
    : typeof raw;
export type SimpliSafeLiveView<Backend extends string = SimpliSafeCameraBackend> = Backend extends string
    ? z.output<SimpliSafeLiveViewParser<Backend>>
    : never;

import { z } from 'zod';
import type { SimpliSafeApi } from './api';

const liveViewBaseUrl = 'https://app-hub.prd.aser.simplisafe.com/v2';

const cameraAdminSchema = z.looseObject({
    webRTCProvider: z.string().min(1),
    firmwareVersion: z.string().min(1),
});
const cameraSettingsSchema = z.looseObject({
    cameraName: z.string().min(1),
    admin: cameraAdminSchema,
});
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
        return this.#details.uuid;
    }

    get eventSerials(): readonly string[] {
        return [this.#details.uuid, this.#details.serial];
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
        const liveView = await this.api.request(`cameras/${encodeURIComponent(this.serial)}/${encodeURIComponent(this.systemId.toString())}/live-view`, {
            baseUrl: liveViewBaseUrl,
        });
        const liveViewSchema = Object.prototype.hasOwnProperty.call(liveViewParsers, backend)
            ? backend as SimpliSafeKnownCameraBackend
            : 'raw';
        const liveViewParser = liveViewSchema === 'raw' ? raw : liveViewParsers[liveViewSchema];
        return {
            ...liveViewParser.parse(liveView),
            [schema]: liveViewSchema,
        } as SimpliSafeLiveView<Backend>;
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
export const schema = Symbol('schema');

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
type SimpliSafeLiveViewSchema<Backend extends string> = Backend extends SimpliSafeKnownCameraBackend ? Backend : 'raw';

export type SimpliSafeLiveView<Backend extends string = SimpliSafeCameraBackend> = Backend extends string
    ? z.output<SimpliSafeLiveViewParser<Backend>> & { [schema]: SimpliSafeLiveViewSchema<Backend> }
    : never;

import { z } from 'zod';
import type { SimpliSafeMedia } from './media';
import type { SimpliSafeSubscription } from './subscription';

const baseUrl = 'https://app-hub.prd.aser.simplisafe.com/v2';

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
export interface SimpliSafeSnapshot {
    media: SimpliSafeMedia;
    timestamp?: number;
}

export class SimpliSafeCamera {
    #details!: SimpliSafeCameraDetails;
    latestSnapshot?: SimpliSafeSnapshot;

    constructor(public readonly subscription: SimpliSafeSubscription) {
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
        const liveView = await this.subscription.api.requestJson(
            `cameras/${encodeURIComponent(this.uuid)}/${encodeURIComponent(this.systemId.toString())}/live-view`,
            { baseUrl, schema },
        );
        return liveView as SimpliSafeLiveView<Backend>;
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

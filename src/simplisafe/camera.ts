import { z } from 'zod';

export type SimpliSafeCameraBackend = 'kvs' | 'mist';

export interface SimpliSafeIceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface SimpliSafeCameraDetails<Backend extends string = string> {
    name: string;
    serial: string;
    eventSerials: string[];
    systemId: number;
    systemName?: string;
    backend: Backend;
    model?: string;
    firmware?: string;
    raw: unknown;
}

export interface SimpliSafeCameraApi {
    getLiveView(camera: Pick<SimpliSafeCameraDetails, 'serial' | 'systemId'>): Promise<unknown>;
}

export type SimpliSafeLiveViewDetails = KVSLiveViewDetails | LiveKitLiveViewDetails;

export interface KVSLiveViewDetails {
    backend: 'kvs';
    signedChannelEndpoint: string;
    clientId: string;
    iceServers: SimpliSafeIceServer[];
    raw: Record<string, unknown>;
}

export interface LiveKitLiveViewDetails {
    backend: 'mist';
    liveKitURL: string;
    userToken: string;
    raw: Record<string, unknown>;
}

export class SimpliSafeCamera {
    name!: string;
    serial!: string;
    eventSerials!: string[];
    systemId!: number;
    systemName?: string;
    backend!: SimpliSafeCameraBackend;
    model?: string;
    firmware?: string;
    raw!: unknown;

    constructor(private api: SimpliSafeCameraApi, camera: SimpliSafeCameraDetails<SimpliSafeCameraBackend>) {
        this.update(camera);
    }

    update(camera: SimpliSafeCameraDetails<SimpliSafeCameraBackend>): void {
        this.name = camera.name;
        this.serial = camera.serial;
        this.eventSerials = camera.eventSerials;
        this.systemId = camera.systemId;
        this.systemName = camera.systemName;
        this.backend = camera.backend;
        this.model = camera.model;
        this.firmware = camera.firmware;
        this.raw = camera.raw;
    }

    async getLiveView(): Promise<SimpliSafeLiveViewDetails> {
        const liveView = await this.api.getLiveView(this);
        switch (this.backend) {
            case 'kvs':
                return parseKVSLiveView(liveView);
            case 'mist':
                return parseLiveKitLiveView(liveView);
            default:
                return assertNever(this.backend, 'Unsupported SimpliSafe camera backend.');
        }
    }

}

const iceServerSchema = z.looseObject({
    urls: z.union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1),
    ]).transform(urls => Array.isArray(urls) && urls.length === 1 ? urls[0] : urls),
    username: z.string().min(1).optional(),
    credential: z.string().min(1).optional(),
});
const kvsLiveViewSchema = z.looseObject({
    signedChannelEndpoint: z.string().min(1),
    clientId: z.string().min(1),
    iceServers: z.array(iceServerSchema).min(1),
});
const liveKitLiveViewSchema = z.looseObject({
    liveKitDetails: z.looseObject({
        liveKitURL: z.string().min(1),
        userToken: z.string().min(1),
    }),
});

function parseKVSLiveView(liveView: unknown): KVSLiveViewDetails {
    const liveViewDetails = kvsLiveViewSchema.parse(liveView);

    return {
        backend: 'kvs',
        signedChannelEndpoint: liveViewDetails.signedChannelEndpoint,
        clientId: liveViewDetails.clientId,
        iceServers: liveViewDetails.iceServers,
        raw: liveViewDetails,
    };
}

function parseLiveKitLiveView(liveView: unknown): LiveKitLiveViewDetails {
    const liveViewDetails = liveKitLiveViewSchema.parse(liveView);

    return {
        backend: 'mist',
        liveKitURL: liveViewDetails.liveKitDetails.liveKitURL,
        userToken: liveViewDetails.liveKitDetails.userToken,
        raw: liveViewDetails,
    };
}

function assertNever(value: never, message: string): never {
    void value;
    throw new Error(message);
}

import { MotionSensor, RTCSessionControl, RTCSignalingChannel, RTCSignalingSession, ScryptedDeviceBase } from '@scrypted/sdk';
import { KinesisSignaling } from './media/kinesis-signaling';
import { LiveKitSession } from './media/livekit-session';
import { DiscoveredSimpliSafeCamera, KinesisLiveView, LiveKitLiveView, SimpliSafeIceServer, SimpliSafeRealtimeEvent } from './simplisafe/types';
import type SimpliSafePlugin from './main';

const motionHoldMs = 30_000;

export abstract class SimpliSafeCameraDevice extends ScryptedDeviceBase implements RTCSignalingChannel, MotionSensor {
    private motionResetTimer?: NodeJS.Timeout;

    constructor(public plugin: SimpliSafePlugin, nativeId: string, public camera: DiscoveredSimpliSafeCamera) {
        super(nativeId);
        this.motionDetected = false;
    }

    abstract startRTCSignalingSession(session: RTCSignalingSession): Promise<RTCSessionControl>;

    handleMotionEvent(event: SimpliSafeRealtimeEvent): void {
        const eventTime = event.timestamp ? ` at ${event.timestamp.toISOString()}` : '';
        this.console.log(`Motion detected by SimpliSafe camera '${this.camera.name}'${eventTime}.`);

        this.clearMotion();
        this.motionDetected = true;
        this.motionResetTimer = setTimeout(() => this.clearMotion(), motionHoldMs);
    }

    clearMotion(): void {
        if (this.motionResetTimer) {
            clearTimeout(this.motionResetTimer);
            this.motionResetTimer = undefined;
        }
        this.motionDetected = false;
    }
}

export class KinesisSimpliSafeCameraDevice extends SimpliSafeCameraDevice {
    async startRTCSignalingSession(session: RTCSignalingSession): Promise<RTCSessionControl> {
        const liveView = this.requireLiveView(await this.plugin.api.getLiveView(this.camera));
        return new KinesisSignaling(this.camera, liveView).start(session);
    }

    private requireLiveView(liveView: unknown): KinesisLiveView {
        const object = assertRecord(liveView, `SimpliSafe Kinesis live-view response for ${this.camera.name}`);
        const signedChannelEndpoint = assertString(object.signedChannelEndpoint, `SimpliSafe Kinesis live-view response for ${this.camera.name} signedChannelEndpoint`);
        const clientId = assertString(object.clientId, `SimpliSafe Kinesis live-view response for ${this.camera.name} clientId`);
        const iceServers = assertArray(
            object.iceServers,
            `SimpliSafe Kinesis live-view response for ${this.camera.name} iceServers`,
        ).map(iceServerValue);
        if (!iceServers.length)
            throw new Error(`SimpliSafe Kinesis live-view response for ${this.camera.name} did not contain iceServers.`);

        return {
            ...object,
            signedChannelEndpoint,
            clientId,
            iceServers,
        };
    }
}

export class LiveKitSimpliSafeCameraDevice extends SimpliSafeCameraDevice {
    async startRTCSignalingSession(session: RTCSignalingSession): Promise<RTCSessionControl> {
        const { liveKitDetails } = this.requireLiveView(await this.plugin.api.getLiveView(this.camera));
        const liveKitSession = await LiveKitSession.connect({
            cameraName: this.camera.name,
            logger: this.console,
        }, liveKitDetails);
        return liveKitSession.start(session);
    }

    private requireLiveView(liveView: unknown): LiveKitLiveView {
        const object = assertRecord(liveView, `SimpliSafe LiveKit live-view response for ${this.camera.name}`);
        const liveKitDetails = assertRecord(
            object.liveKitDetails,
            `SimpliSafe LiveKit live-view response for ${this.camera.name} liveKitDetails`,
        );
        const liveKitURL = assertString(
            liveKitDetails.liveKitURL,
            `SimpliSafe LiveKit live-view response for ${this.camera.name} liveKitDetails.liveKitURL`,
        );
        const userToken = assertString(
            liveKitDetails.userToken,
            `SimpliSafe LiveKit live-view response for ${this.camera.name} liveKitDetails.userToken`,
        );

        return {
            ...object,
            liveKitDetails: {
                ...liveKitDetails,
                liveKitURL,
                userToken,
            },
        };
    }
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>;
    throw new Error(`${label} must be an object.`);
}

function assertArray(value: unknown, label: string): unknown[] {
    if (Array.isArray(value))
        return value;
    throw new Error(`${label} must be an array.`);
}

function assertString(value: unknown, label: string): string {
    if (typeof value === 'string' && value)
        return value;
    throw new Error(`${label} must be a non-empty string.`);
}

function assertOptionalString(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null)
        return undefined;
    return assertString(value, label);
}

function iceServerValue(value: unknown): SimpliSafeIceServer {
    const server = assertRecord(value, 'SimpliSafe Kinesis live-view ICE server');
    const rawUrls = Array.isArray(server.urls)
        ? server.urls.map((url, index) => assertString(url, `SimpliSafe Kinesis live-view ICE server urls[${index}]`))
        : assertString(server.urls, 'SimpliSafe Kinesis live-view ICE server urls');
    const urls = Array.isArray(rawUrls) && rawUrls.length === 1 ? rawUrls[0] : rawUrls;

    if (!urls || Array.isArray(urls) && !urls.length)
        throw new Error('SimpliSafe Kinesis live-view response contained an ICE server without urls.');

    return {
        ...server,
        urls,
        username: assertOptionalString(server.username, 'SimpliSafe Kinesis live-view ICE server username'),
        credential: assertOptionalString(server.credential, 'SimpliSafe Kinesis live-view ICE server credential'),
    };
}

import {
    Camera,
    MediaObject,
    MotionSensor,
    RequestPictureOptions,
    ResponsePictureOptions,
    RTCSessionControl,
    RTCSignalingChannel,
    RTCSignalingSession,
} from '@scrypted/sdk';
import { SimpliSafeDevice } from './device';
import { connectRTCSignalingClients } from './rtc/common';
import { KVSRTCSignalingSession } from './rtc/kvs';
import { LiveKitSession } from './rtc/livekit';
import {
    CAMERA_MOTION_DETECTED_EVENT_CID,
    type SimpliSafeApi,
    type SimpliSafeCamera,
    type SimpliSafeMedia,
    type SimpliSafeRealtimeEvent,
    type SimpliSafeRealtimeEvents,
} from './simplisafe';

const motionHoldMs = 30_000;

export class SimpliSafeCameraDevice extends SimpliSafeDevice implements Camera, RTCSignalingChannel, MotionSensor {
    private motionResetTimer?: NodeJS.Timeout;
    private snapshot?: SimpliSafeMedia;
    private snapshotEventTime = 0;

    protected get eventSerials(): readonly string[] {
        return [this.camera.uuid, this.camera.serial];
    }

    constructor(api: SimpliSafeApi, realtimeEvents: SimpliSafeRealtimeEvents, nativeId: string, public camera: SimpliSafeCamera) {
        super(api, realtimeEvents, nativeId);
        this.motionDetected = false;
        this.addRealtimeListener('camera_motion_detected', event => this.onMotion(event));
    }

    private onMotion(event: SimpliSafeRealtimeEvent): void {
        const eventTime = event.timestamp ? ` at ${event.timestamp.toISOString()}` : '';
        this.console.log(`Motion detected by SimpliSafe camera '${this.camera.name}'${eventTime}.`);

        this.clearMotion();
        this.motionDetected = true;
        this.motionResetTimer = setTimeout(() => this.clearMotion(), motionHoldMs);
        this.cacheSnapshot(event.snapshot, event.timestamp);
    }

    async primeSnapshot(): Promise<void> {
        try {
            for (const event of (await this.camera.events()).sort((left, right) =>
                (right.eventTimestamp ?? 0) - (left.eventTimestamp ?? 0))) {
                if (event.eventCid !== CAMERA_MOTION_DETECTED_EVENT_CID
                    || !event.sensorSerial
                    || !this.eventSerials.includes(event.sensorSerial))
                    continue;

                const snapshot = event.video && event.videoStartedBy
                    ? event.video[event.videoStartedBy]?._links?.['snapshot/jpg']
                    : undefined;
                if (!snapshot)
                    continue;

                const timestamp = event.eventTimestamp;
                this.cacheSnapshot(snapshot, timestamp === undefined
                    ? undefined
                    : new Date(timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000));
                break;
            }
        }
        catch (error) {
            this.console.warn(`Failed to prime motion snapshot for SimpliSafe camera '${this.camera.name}'.`, error);
        }
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        if (!this.snapshot)
            throw new Error(`No motion snapshot is cached for SimpliSafe camera '${this.camera.name}'.`);
        return this.createMediaObject(await this.snapshot.fetch(options?.picture), 'image/jpeg');
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [{
            name: 'Last motion event',
            canResize: this.snapshot?.url.keys().includes('width'),
            staleDuration: this.snapshotEventTime ? Math.max(0, Date.now() - this.snapshotEventTime) : undefined,
        }];
    }

    private cacheSnapshot(snapshot: SimpliSafeMedia | undefined, timestamp?: Date): void {
        if (!snapshot)
            return;

        const eventTime = timestamp?.getTime() ?? Date.now();
        if (eventTime < this.snapshotEventTime)
            return;
        this.snapshot = snapshot;
        this.snapshotEventTime = eventTime;
    }

    clearMotion(): void {
        if (this.motionResetTimer) {
            clearTimeout(this.motionResetTimer);
            this.motionResetTimer = undefined;
        }
        this.motionDetected = false;
    }

    async startRTCSignalingSession(session: RTCSignalingSession): Promise<RTCSessionControl> {
        switch (this.camera.backend) {
            case 'kvs': {
                const liveView = await this.camera.getLiveView('kvs');
                const kvsSession = new KVSRTCSignalingSession(liveView);
                try {
                    await connectRTCSignalingClients(session, {
                        configuration: {
                            iceServers: liveView.iceServers,
                        },
                        audio: {
                            direction: 'sendrecv',
                        },
                        video: {
                            direction: 'recvonly',
                        },
                        getUserMediaSafariHack: true,
                    }, kvsSession, {});
                } catch (err) {
                    kvsSession.endSession();
                    throw err;
                }
                return kvsSession;
            }
            case 'mist': {
                const liveView = await this.camera.getLiveView('mist');
                const liveKitSession = await LiveKitSession.start(
                    liveView.liveKitDetails.liveKitURL,
                    liveView.liveKitDetails.userToken,
                );
                try {
                    return await liveKitSession.connectSignalingClient(session);
                } catch (err) {
                    liveKitSession.close()
                    throw err;
                }
            }
            default:
                throw new Error('Unsupported SimpliSafe live-view backend.');
        }
    }

    override release(): void {
        super.release();
        this.clearMotion();
    }
}

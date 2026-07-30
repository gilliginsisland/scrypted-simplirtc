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
    SimpliSafeEventType,
    TemplateUrl,
    type SimpliSafeCamera,
    type SimpliSafeEvent,
} from './simplisafe';

const motionHoldMs = 30_000;

export class SimpliSafeCameraDevice extends SimpliSafeDevice implements Camera, RTCSignalingChannel, MotionSensor {
    private motionResetTimer?: NodeJS.Timeout;

    protected static override readonly eventHandlers = new Map<SimpliSafeEventType, (event: SimpliSafeEvent) => void>([
        [SimpliSafeEventType.CameraMotionDetected, SimpliSafeCameraDevice.prototype.onMotion],
        [SimpliSafeEventType.VideoRecording, SimpliSafeCameraDevice.prototype.onVideo],
    ]);

    constructor(nativeId: string, public camera: SimpliSafeCamera) {
        super(camera, nativeId);
        this.motionDetected = false;
    }

    private onMotion(): void {
        this.clearMotion();
        this.motionDetected = true;
        this.motionResetTimer = setTimeout(() => this.clearMotion(), motionHoldMs);
    }

    private onVideo(event: SimpliSafeEvent): void {
        const snapshot = event.video?.[this.camera.uuid]?._links?.['snapshot/jpg'];
        if (snapshot)
            this.camera.latestSnapshot = {
                media: snapshot,
                timestamp: event.eventTimestamp,
            };
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        if (!this.camera.latestSnapshot)
            throw new Error(`No motion snapshot is cached for SimpliSafe camera '${this.camera.name}'.`);
        const url = new TemplateUrl(this.camera.latestSnapshot.media.href);
        return this.createMediaObject(await this.camera.subscription.api.requestBinary(url.render({
            width: options?.picture?.width,
            height: options?.picture?.height,
        }), {
            headers: {
                Accept: 'image/jpeg',
            },
        }), 'image/jpeg');
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [{
            name: 'Last motion event',
            canResize: this.camera.latestSnapshot && new TemplateUrl(this.camera.latestSnapshot.media.href).keys().includes('width'),
            staleDuration: this.camera.latestSnapshot?.timestamp === undefined
                ? undefined
                : Math.max(0, Date.now() - this.camera.latestSnapshot.timestamp * 1000),
        }];
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
        this.clearMotion();
        super.release();
    }
}

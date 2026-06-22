import {
    MotionSensor,
    RTCSessionControl,
    RTCSignalingChannel,
    RTCSignalingSession,
} from '@scrypted/sdk';
import { SimpliSafeDevice } from './device';
import { LiveKitRTCSessionControl } from './media/livekit-rtc-session-control';
import { LiveKitSignaling } from './media/livekit-signaling';
import type { SimpliSafeApi } from './simplisafe/api';
import type { KinesisLiveViewDetails, LiveKitLiveViewDetails, SimpliSafeCamera } from './simplisafe/camera';
import type { SimpliSafeRealtimeEvent, SimpliSafeRealtimeEvents } from './simplisafe/realtime';

const motionHoldMs = 30_000;

export class SimpliSafeCameraDevice extends SimpliSafeDevice implements RTCSignalingChannel, MotionSensor {
    private motionResetTimer?: NodeJS.Timeout;

    protected get eventSerials(): readonly string[] {
        return this.camera.eventSerials;
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
    }

    clearMotion(): void {
        if (this.motionResetTimer) {
            clearTimeout(this.motionResetTimer);
            this.motionResetTimer = undefined;
        }
        this.motionDetected = false;
    }

    async startRTCSignalingSession(session: RTCSignalingSession): Promise<RTCSessionControl> {
        const liveView = await this.camera.getLiveView();
        switch (liveView.backend) {
            case 'kvs':
                return startKinesisRTCSignalingSession(this, session, liveView);
            case 'mist':
                return startLiveKitRTCSignalingSession(session, liveView);
            default:
                throw new Error('Unsupported SimpliSafe live-view backend.');
        }
    }

    override release(): void {
        super.release();
        this.clearMotion();
    }
}

async function startKinesisRTCSignalingSession(device: SimpliSafeCameraDevice, _session: RTCSignalingSession, _liveView: KinesisLiveViewDetails): Promise<RTCSessionControl> {
    throw new Error(`SimpliSafe Kinesis WebRTC streaming is not implemented for '${device.camera.name}'.`);
}

async function startLiveKitRTCSignalingSession(session: RTCSignalingSession, liveView: LiveKitLiveViewDetails): Promise<RTCSessionControl> {
    const signaling = new LiveKitSignaling(liveView.liveKitURL, { token: liveView.userToken });
    const control = new LiveKitRTCSessionControl(signaling);
    try {
        await control.start(session);
    }
    catch (e) {
        await control.endSession();
        throw e;
    }
    return control;
}

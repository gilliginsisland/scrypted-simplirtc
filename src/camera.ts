import {
    MotionSensor,
    RTCSessionControl,
    RTCSignalingChannel,
    RTCSignalingSession,
} from '@scrypted/sdk';
import { SimpliSafeDevice } from './device';
import { connectRTCSignalingClients } from './rtc/common';
import { KVSRTCSignalingSession } from './rtc/kvs';
import { LiveKitRTCSessionControl } from './rtc/livekit';
import type { SimpliSafeApi } from './simplisafe/api';
import type { KVSLiveViewDetails, LiveKitLiveViewDetails, SimpliSafeCamera } from './simplisafe/camera';
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
            case 'kvs': {
                const kvsSession = new KVSRTCSignalingSession(liveView);
                void connectRTCSignalingClients(session, {
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
                }, kvsSession, {}).catch(() => kvsSession.endSession());
                return kvsSession;
            }
            case 'mist':
                return LiveKitRTCSessionControl.start(liveView.liveKitURL, liveView.userToken, session);
            default:
                throw new Error('Unsupported SimpliSafe live-view backend.');
        }
    }

    override release(): void {
        super.release();
        this.clearMotion();
    }
}

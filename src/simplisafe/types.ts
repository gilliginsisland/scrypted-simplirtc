export type SimpliSafeCameraBackend = 'kvs' | 'mist';

export const EVENT_CAMERA_MOTION_DETECTED = 'camera_motion_detected';

export interface SimpliSafeIceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface KinesisLiveView {
    signedChannelEndpoint: string;
    clientId: string;
    iceServers: SimpliSafeIceServer[];
}

export interface LiveKitLiveView {
    liveKitDetails: {
        liveKitURL: string;
        userToken: string;
    };
}

export interface DiscoveredSimpliSafeCamera {
    nativeId: string;
    name: string;
    serial: string;
    eventSerials: string[];
    systemId: string;
    systemName?: string;
    backend: string;
    model?: string;
    firmware?: string;
    raw: unknown;
}

export interface SimpliSafeRealtimeEvent {
    eventType?: string;
    eventCid?: number;
    info?: string;
    systemId?: string;
    timestamp?: Date;
    sensorName?: string;
    sensorSerial?: string;
    sensorType?: string | number;
    raw: unknown;
}

export interface SimpliSafeLogger {
    debug(...args: unknown[]): void;
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export const nullLogger: SimpliSafeLogger = {
    debug() { },
    log() { },
    warn() { },
    error() { },
};

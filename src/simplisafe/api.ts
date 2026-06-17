import WebSocket, { RawData } from 'ws';
import { EVENT_CAMERA_MOTION_DETECTED, nullLogger } from './types';
import type { DiscoveredSimpliSafeCamera, SimpliSafeCameraBackend, SimpliSafeLogger, SimpliSafeRealtimeEvent } from './types';
import { SimpliSafeAuth } from './oauth';

const apiBaseUrl = 'https://api.simplisafe.com/v1';
const liveViewBaseUrl = 'https://app-hub.prd.aser.simplisafe.com/v2';
const realtimeWebsocketUrl = 'wss://socketlink.prd.aser.simplisafe.com';
const realtimePingIntervalMs = 55_000;
const realtimeReconnectDelayMs = 5_000;
const websocketSource = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15';
const activeSubscriptionStatuses = new Set([7, 10, 20]);
const eventTypeByCid = new Map<number, string>([
    [1170, EVENT_CAMERA_MOTION_DETECTED],
]);

export interface SimpliSafeApiOptions {
    accountNumber?: string;
    logger?: SimpliSafeLogger;
}

export class SimpliSafeApi {
    private auth: SimpliSafeAuth;
    private options: SimpliSafeApiOptions;
    private logger: SimpliSafeLogger;
    private realtimeWs?: WebSocket;
    private realtimePingTimer?: NodeJS.Timeout;
    private realtimeReconnectTimer?: NodeJS.Timeout;
    private realtimeStarted = false;
    private realtimeConnecting = false;
    private cameraMotionListeners = new Set<(event: SimpliSafeRealtimeEvent) => void>();

    constructor(auth: SimpliSafeAuth, options: SimpliSafeApiOptions = {}) {
        this.auth = auth;
        this.options = options;
        this.logger = options.logger ?? nullLogger;
    }

    setOptions(options: SimpliSafeApiOptions): void {
        this.options = options;
        this.logger = options.logger ?? nullLogger;
    }

    async request<T>(method: string, path: string, body?: unknown, baseUrl = apiBaseUrl): Promise<T> {
        const accessToken = await this.auth.ensureAccessToken();
        const tokenType = this.auth.state.tokenType || 'Bearer';
        const response = await fetch(new URL(path, ensureTrailingSlash(baseUrl)), {
            method,
            headers: {
                Accept: 'application/json',
                Authorization: `${tokenType} ${accessToken}`,
                ...(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        const text = await response.text();
        if (!response.ok)
            throw new Error(`SimpliSafe API request failed: ${method} ${path}: ${response.status} ${response.statusText}: ${text}`);
        if (!text)
            return undefined as T;
        return JSON.parse(text) as T;
    }

    async getUserId(): Promise<string> {
        const response = assertRecord(await this.request<unknown>('GET', 'api/authCheck'), 'SimpliSafe authCheck response');
        return assertString(response.userId, 'SimpliSafe authCheck response userId');
    }

    async getSubscriptions(): Promise<unknown[]> {
        const userId = await this.getUserId();
        const response = assertRecord(
            await this.request<unknown>('GET', `users/${encodeURIComponent(userId)}/subscriptions?activeOnly=false`),
            'SimpliSafe subscriptions response',
        );
        return assertArray(response.subscriptions, 'SimpliSafe subscriptions response subscriptions');
    }

    async getSubscription(subscriptionId: string): Promise<unknown> {
        return this.request<unknown>('GET', `subscriptions/${encodeURIComponent(subscriptionId)}/`);
    }

    async discoverCameras(): Promise<DiscoveredSimpliSafeCamera[]> {
        const subscriptions = await this.getSubscriptions();
        const discovered: DiscoveredSimpliSafeCamera[] = [];

        for (const subscriptionSummary of subscriptions) {
            const summary = assertRecord(subscriptionSummary, 'SimpliSafe subscription summary');
            const status = assertOptionalNumber(summary.sStatus, 'SimpliSafe subscription summary sStatus');
            if (status !== undefined && !activeSubscriptionStatuses.has(status))
                continue;

            const summaryLocation = assertOptionalRecord(summary.location, 'SimpliSafe subscription summary location');
            const accountNumber = assertOptionalString(summaryLocation?.account, 'SimpliSafe subscription summary location account');
            if (this.options.accountNumber && accountNumber !== this.options.accountNumber)
                continue;

            const subscriptionId = assertOptionalString(summary.sid, 'SimpliSafe subscription summary sid');
            if (!subscriptionId) {
                this.logger.warn('Skipping SimpliSafe subscription without sid.');
                continue;
            }

            let subscriptionEnvelope: unknown;
            try {
                subscriptionEnvelope = await this.getSubscription(subscriptionId);
            }
            catch (e) {
                this.logger.warn(`Failed to fetch SimpliSafe subscription ${subscriptionId}; using summary data.`, e);
                subscriptionEnvelope = subscriptionSummary;
            }

            const subscription = normalizeSubscription(subscriptionEnvelope, subscriptionSummary);
            const location = assertOptionalRecord(subscription.location, 'SimpliSafe subscription location') ?? {};
            const system = assertOptionalRecord(firstDefined(
                location.system,
                subscription.system,
            ), 'SimpliSafe subscription system') ?? {};
            const systemId = assertOptionalString(firstDefined(
                system.system_id,
                system.systemId,
                system.sid,
                system.id,
                subscription.sid,
                subscriptionId,
            ), 'SimpliSafe system id');
            if (!systemId) {
                this.logger.warn(`Skipping SimpliSafe subscription ${subscriptionId}; system id was not found.`);
                continue;
            }

            const version = assertOptionalNumber(firstDefined(system.version, system.systemVersion), 'SimpliSafe system version');
            if (version !== undefined && version !== 3) {
                this.logger.warn(`Skipping non-V3 SimpliSafe system ${systemId}; version=${version}.`);
                continue;
            }
            if (version === undefined)
                this.logger.warn(`SimpliSafe system ${systemId} did not report a version; treating it as a V3 candidate.`);

            for (const camera of cameraValues(system)) {
                const normalized = this.normalizeCamera(systemId, subscription, system, camera);
                if (normalized)
                    discovered.push(normalized);
            }
        }

        return discovered;
    }

    async getLiveView(camera: Pick<DiscoveredSimpliSafeCamera, 'serial' | 'systemId'>): Promise<unknown> {
        return this.request<unknown>(
            'GET',
            `cameras/${encodeURIComponent(camera.serial)}/${encodeURIComponent(camera.systemId)}/live-view`,
            undefined,
            liveViewBaseUrl,
        );
    }

    addCameraMotionListener(listener: (event: SimpliSafeRealtimeEvent) => void): () => void {
        this.cameraMotionListeners.add(listener);
        return () => this.cameraMotionListeners.delete(listener);
    }

    async startRealtimeEvents(): Promise<void> {
        this.realtimeStarted = true;
        try {
            await this.connectRealtimeEvents();
        }
        catch (e) {
            this.logger.warn('Failed to start SimpliSafe realtime websocket; camera motion events will retry in the background.', e);
            this.scheduleRealtimeReconnect();
        }
    }

    stopRealtimeEvents(): void {
        this.realtimeStarted = false;
        this.clearRealtimeReconnect();
        this.closeRealtimeWebsocket();
    }

    private async connectRealtimeEvents(): Promise<void> {
        if (!this.realtimeStarted || this.realtimeConnecting)
            return;
        if (this.realtimeWs && this.realtimeWs.readyState !== WebSocket.CLOSED && this.realtimeWs.readyState !== WebSocket.CLOSING)
            return;

        this.realtimeConnecting = true;
        try {
            const accessToken = await this.auth.ensureAccessToken();
            const userId = await this.getUserId();
            if (!this.realtimeStarted)
                return;

            const ws = new WebSocket(realtimeWebsocketUrl);
            this.realtimeWs = ws;

            ws.on('open', () => {
                this.sendRealtimeIdentify(ws, accessToken, userId);
                this.startRealtimePing(ws);
                this.logger.log('Connected to SimpliSafe realtime websocket for camera motion events.');
            });

            ws.on('message', data => this.handleRealtimeMessage(data));

            ws.on('close', (code, reason) => {
                if (this.realtimeWs === ws) {
                    this.realtimeWs = undefined;
                    this.clearRealtimePing();
                }
                if (!this.realtimeStarted)
                    return;

                const reasonText = rawDataToString(reason);
                this.logger.warn(`SimpliSafe realtime websocket disconnected; reconnecting. code=${code}${reasonText ? ` reason=${reasonText}` : ''}`);
                this.scheduleRealtimeReconnect();
            });

            ws.on('error', e => {
                if (this.realtimeWs === ws)
                    this.logger.warn('SimpliSafe realtime websocket error.', e);
            });
        }
        finally {
            this.realtimeConnecting = false;
        }
    }

    private sendRealtimeIdentify(ws: WebSocket, accessToken: string, userId: string): void {
        const now = new Date();
        ws.send(JSON.stringify({
            datacontenttype: 'application/json',
            type: 'com.simplisafe.connection.identify',
            time: now.toISOString(),
            id: `ts:${now.getTime()}`,
            specversion: '1.0',
            source: websocketSource,
            data: {
                auth: {
                    schema: 'bearer',
                    token: accessToken,
                },
                join: [`uid:${userId}`],
            },
        }));
    }

    private startRealtimePing(ws: WebSocket): void {
        this.clearRealtimePing();
        this.realtimePingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN)
                ws.ping();
        }, realtimePingIntervalMs);
    }

    private clearRealtimePing(): void {
        if (this.realtimePingTimer) {
            clearInterval(this.realtimePingTimer);
            this.realtimePingTimer = undefined;
        }
    }

    private scheduleRealtimeReconnect(): void {
        if (!this.realtimeStarted || this.realtimeReconnectTimer)
            return;
        this.realtimeReconnectTimer = setTimeout(() => {
            this.realtimeReconnectTimer = undefined;
            this.connectRealtimeEvents().catch(e => {
                this.logger.warn('Failed to reconnect SimpliSafe realtime websocket.', e);
                this.scheduleRealtimeReconnect();
            });
        }, realtimeReconnectDelayMs);
    }

    private clearRealtimeReconnect(): void {
        if (this.realtimeReconnectTimer) {
            clearTimeout(this.realtimeReconnectTimer);
            this.realtimeReconnectTimer = undefined;
        }
    }

    private closeRealtimeWebsocket(): void {
        const ws = this.realtimeWs;
        this.realtimeWs = undefined;
        this.clearRealtimePing();
        if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING)
            ws.close();
    }

    private handleRealtimeMessage(data: RawData): void {
        let payload: unknown;
        try {
            payload = JSON.parse(rawDataToString(data));
        }
        catch (e) {
            this.logger.warn('Ignoring invalid JSON from SimpliSafe realtime websocket.', e);
            return;
        }

        let event: SimpliSafeRealtimeEvent | undefined;
        try {
            event = parseRealtimeEvent(payload);
        }
        catch (e) {
            this.logger.warn('Ignoring invalid SimpliSafe realtime event payload.', e);
            return;
        }
        if (event?.eventType !== EVENT_CAMERA_MOTION_DETECTED)
            return;

        for (const listener of this.cameraMotionListeners)
            listener(event);
    }

    private normalizeCamera(systemId: string, subscription: Record<string, unknown>, system: Record<string, unknown>, rawCamera: unknown): DiscoveredSimpliSafeCamera | undefined {
        const camera = assertRecord(rawCamera, 'SimpliSafe camera');
        const cameraSettings = assertOptionalRecord(firstDefined(camera.camera_settings, camera.cameraSettings), 'SimpliSafe camera settings') ?? {};
        const serial = assertOptionalString(firstDefined(
            camera.uuid,
            camera.serial,
            camera.camera_serial,
            camera.cameraSerial,
            camera.serialNumber,
            camera.id,
        ), 'SimpliSafe camera serial');
        const name = assertOptionalString(firstDefined(
            camera.name,
            cameraSettings.cameraName,
            camera.displayName,
            camera.label,
            serial,
        ), 'SimpliSafe camera name');
        if (!serial || !name) {
            this.logger.warn('Skipping SimpliSafe camera with missing name or serial.');
            return;
        }

        const backend = getWebRtcProvider(camera);
        if (!isSupportedBackend(backend)) {
            this.logger.warn(`Camera '${name}' has unsupported SimpliSafe WebRTC provider '${backend ?? 'missing'}'.`);
            return;
        }

        return {
            nativeId: `${systemId}:${serial}`,
            name,
            serial,
            eventSerials: cameraEventSerials(system, camera, serial),
            systemId,
            systemName: assertOptionalString(
                assertOptionalRecord(subscription.location, 'SimpliSafe subscription location')?.name,
                'SimpliSafe subscription location name',
            ),
            backend,
            model: assertOptionalString(firstDefined(camera.model, camera.type, camera.kind), 'SimpliSafe camera model'),
            firmware: assertOptionalString(firstDefined(camera.firmware, camera.firmware_version, camera.firmwareVersion), 'SimpliSafe camera firmware'),
            raw: rawCamera,
        };
    }
}

function normalizeSubscription(envelope: unknown, fallback: unknown): Record<string, unknown> {
    const object = assertOptionalRecord(envelope, 'SimpliSafe subscription envelope');
    return assertRecord(firstDefined(object?.subscription, envelope, fallback), 'SimpliSafe subscription');
}

function cameraValues(system: Record<string, unknown>): unknown[] {
    const cameras = firstDefined(
        system.cameras,
        system.camera,
    );
    return cameras === undefined ? [] : assertArray(cameras, 'SimpliSafe system cameras');
}

function cameraEventSerials(system: Record<string, unknown>, camera: Record<string, unknown>, serial: string): string[] {
    const serials = new Set<string>([serial]);
    addCameraIdentifiers(serials, camera);

    const cameraData = assertOptionalRecord(firstDefined(system.camera_data, system.cameraData), 'SimpliSafe camera_data') ?? {};
    const knownSerials = [...serials];
    for (const candidate of knownSerials) {
        const data = assertOptionalRecord(cameraData[candidate], `SimpliSafe camera_data ${candidate}`);
        if (data)
            addCameraIdentifiers(serials, data);
    }

    for (const value of Object.values(cameraData)) {
        const data = assertOptionalRecord(value, 'SimpliSafe camera_data entry');
        if (!data)
            continue;
        const dataSerials = new Set<string>();
        addCameraIdentifiers(dataSerials, data);
        if ([...dataSerials].some(candidate => serials.has(candidate)))
            addCameraIdentifiers(serials, data);
    }

    return [...serials];
}

function addCameraIdentifiers(serials: Set<string>, camera: Record<string, unknown>): void {
    for (const key of ['uuid', 'serial']) {
        const identifier = assertOptionalString(camera[key], `SimpliSafe camera ${key}`);
        if (identifier)
            serials.add(identifier);
    }
}

function getWebRtcProvider(camera: Record<string, unknown>): string | undefined {
    const cameraSettings = assertOptionalRecord(firstDefined(camera.camera_settings, camera.cameraSettings), 'SimpliSafe camera settings');
    const admin = assertOptionalRecord(cameraSettings?.admin, 'SimpliSafe camera admin settings');
    return assertOptionalString(admin?.webRTCProvider, 'SimpliSafe camera admin webRTCProvider');
}

function isSupportedBackend(value: string | undefined): value is SimpliSafeCameraBackend {
    return value === 'kvs' || value === 'mist';
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}

function firstDefined<T>(...values: T[]): T | undefined {
    return values.find(value => value !== undefined && value !== null);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>;
    throw new Error(`${label} must be an object.`);
}

function assertOptionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
    if (value === undefined || value === null)
        return undefined;
    return assertRecord(value, label);
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

function assertNumber(value: unknown, label: string): number {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    throw new Error(`${label} must be a finite number.`);
}

function assertOptionalNumber(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null)
        return undefined;
    return assertNumber(value, label);
}

function assertOptionalStringOrNumber(value: unknown, label: string): string | number | undefined {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string' && value)
        return value;
    return assertNumber(value, label);
}

function rawDataToString(data: RawData): string {
    if (typeof data === 'string')
        return data;
    if (Buffer.isBuffer(data))
        return data.toString('utf8');
    if (Array.isArray(data))
        return Buffer.concat(data).toString('utf8');
    return Buffer.from(data).toString('utf8');
}

function parseRealtimeEvent(payload: unknown): SimpliSafeRealtimeEvent | undefined {
    const object = assertRecord(payload, 'SimpliSafe realtime event');
    if (object.type !== 'com.simplisafe.event.standard')
        return;

    const data = assertRecord(object.data, 'SimpliSafe realtime event data');
    const eventCid = assertOptionalNumber(data.eventCid, 'SimpliSafe realtime event eventCid');
    const timestamp = dateFromEpoch(assertOptionalNumber(data.eventTimestamp, 'SimpliSafe realtime event eventTimestamp'));
    const sensorType = assertOptionalStringOrNumber(data.sensorType, 'SimpliSafe realtime event sensorType');
    return {
        eventType: eventCid === undefined ? undefined : eventTypeByCid.get(eventCid),
        eventCid,
        info: assertOptionalString(data.info, 'SimpliSafe realtime event info'),
        systemId: assertOptionalString(data.sid, 'SimpliSafe realtime event sid'),
        timestamp,
        sensorName: assertOptionalString(data.sensorName, 'SimpliSafe realtime event sensorName'),
        sensorSerial: assertOptionalString(data.sensorSerial, 'SimpliSafe realtime event sensorSerial'),
        sensorType,
        raw: payload,
    };
}

function dateFromEpoch(value: number | undefined): Date | undefined {
    if (value === undefined)
        return;
    return new Date(value > 1_000_000_000_000 ? value : value * 1000);
}

import sdk, {
    Device,
    DeviceProvider,
    Refresh,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    Setting,
    Settings,
    SettingValue,
} from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { SimpliSafeCameraDevice } from './camera';
import {
    SimpliSafeApi,
    SimpliSafeAuth,
    SimpliSafeRealtimeEvents,
    SimpliSafeRealtimeWatchdog,
    type SimpliSafeCamera,
    type SimpliSafeTokenState,
    type SimpliSafeTokenStore,
} from './simplisafe';

const { deviceManager } = sdk;

class StorageTokenStore implements SimpliSafeTokenStore {
    constructor(private settingsStorage: StorageSettings<string>) {
    }

    read(): SimpliSafeTokenState {
        const values = this.settingsStorage.values;
        return {
            accessToken: asString(values.accessToken),
            refreshToken: asString(values.refreshToken),
            tokenType: asString(values.tokenType),
            expiresAt: asNumber(values.expiresAt),
            codeVerifier: asString(values.codeVerifier),
            deviceId: asString(values.deviceId),
        };
    }

    write(state: SimpliSafeTokenState): void {
        const values = this.settingsStorage.values;
        values.accessToken = state.accessToken;
        values.refreshToken = state.refreshToken;
        values.tokenType = state.tokenType;
        values.expiresAt = state.expiresAt?.toString();
        values.codeVerifier = state.codeVerifier;
        values.deviceId = state.deviceId;
    }
}

export default class SimpliSafePlugin extends ScryptedDeviceBase implements DeviceProvider, Settings, Refresh {
    private cameras = new Map<string, SimpliSafeCamera>();
    private devices = new Map<string, SimpliSafeCameraDevice>();
    private refreshPromise?: Promise<void>;
    settingsStorage = new StorageSettings(this, {
        redirectUrl: {
            title: 'Redirect URL',
            description: 'Paste the final SimpliSafe mobile redirect URL here after opening the Login URL.',
            type: 'string',
            noStore: true,
            onPut: async (_oldValue: unknown, newValue: unknown) => {
                const redirectUrl = newValue?.toString().trim();
                if (!redirectUrl)
                    return;
                await this.auth.exchangeRedirectUrl(redirectUrl);
                this.log.a('SimpliSafe login completed.');
                await this.refresh(ScryptedInterface.DeviceProvider, false);
            },
        },
        accessToken: {
            title: 'Access Token',
            hide: true,
        },
        refreshToken: {
            title: 'Refresh Token',
            hide: true,
        },
        tokenType: {
            title: 'Token Type',
            hide: true,
            persistedDefaultValue: 'Bearer',
        },
        expiresAt: {
            title: 'Token Expiration',
            hide: true,
        },
        codeVerifier: {
            title: 'OAuth Code Verifier',
            hide: true,
        },
        deviceId: {
            title: 'OAuth Device ID',
            hide: true,
        },
    });

    auth = new SimpliSafeAuth(new StorageTokenStore(this.settingsStorage));
    api = new SimpliSafeApi(this.auth);
    private realtimeEvents = new SimpliSafeRealtimeEvents(this.api);
    private realtimeWatchdog = new SimpliSafeRealtimeWatchdog(this.realtimeEvents, async () => {
        const userId = await this.api.getUserId();
        const accessToken = await this.auth.ensureAccessToken();
        return { accessToken, userId };
    });

    constructor(nativeId?: string) {
        super(nativeId);
        this.refresh(ScryptedInterface.DeviceProvider, false).catch(
            e => this.console.error('SimpliSafe refresh failed.', e)
        );
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.settingsStorage.getSettings();
        return [
            {
                key: 'loginUrl',
                title: 'Login URL',
                description: 'Open this URL, approve login, then paste the final mobile redirect URL into Redirect URL.',
                readonly: true,
                value: await this.auth.getAuthorizationUrl(),
            },
            ...settings,
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.settingsStorage.putSetting(key, value);
    }

    async refresh(refreshInterface: string, userInitiated: boolean): Promise<void> {
        if (this.refreshPromise)
            return this.refreshPromise;

        this.refreshPromise = (async () => {
            if (!this.auth.state.refreshToken) {
                this.log.a('Open the SimpliSafe Login URL setting, approve access, then paste the final redirect URL.');
                return;
            }

            this.console.log(`Refreshing SimpliSafe devices: interface=${refreshInterface} userInitiated=${userInitiated}`);
            await this.api.update();

            const cameras = new Map<string, SimpliSafeCamera>();
            for (const subscription of this.api.subscriptions()) {
                for (const camera of subscription.cameras()) {
                    const nativeId = `${camera.systemId}:${camera.uuid}`;
                    cameras.set(nativeId, camera);
                }
            }
            this.cameras = cameras;

            const devices: Device[] = Array.from(this.cameras.entries()).map(
                ([nativeId, camera]) => {
                    return {
                        nativeId,
                        name: camera.name,
                        type: ScryptedDeviceType.Camera,
                        interfaces: [
                            ScryptedInterface.Camera,
                            ScryptedInterface.MotionSensor,
                            ScryptedInterface.RTCSignalingChannel,
                        ],
                        info: {
                            manufacturer: 'SimpliSafe',
                            model: camera.model,
                            firmware: camera.firmware,
                            serialNumber: camera.serial,
                        },
                    };
                }
            );

            await deviceManager.onDevicesChanged({ devices });
            this.console.log(`Discovered ${devices.length} supported SimpliSafe camera(s).`);
        })().finally(
            () => this.refreshPromise = undefined
        );

        return this.refreshPromise;
    }

    async getRefreshFrequency(): Promise<number> {
        return 300;
    }

    async getDevice(nativeId: string): Promise<SimpliSafeCameraDevice> {
        if (!this.devices.has(nativeId)) {
            if (!this.cameras.has(nativeId) && this.refreshPromise)
                await this.refreshPromise;
            const camera = this.cameras.get(nativeId);
            if (!camera)
                throw new Error(`Unknown SimpliSafe camera nativeId=${nativeId}.`);
            const device = new SimpliSafeCameraDevice(this.api, this.realtimeEvents, nativeId, camera);
            this.devices.set(nativeId, device);
            void device.primeSnapshot().catch(error => {
                this.console.warn(`Failed to prime motion snapshot for SimpliSafe camera '${camera.name}'.`, error);
            });
            await this.syncRealtimeWatchdog();
        }
        return this.devices.get(nativeId)!;
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        const device = this.devices.get(nativeId);
        if (!device)
            return

        device.release();
        this.devices.delete(nativeId);
        await this.syncRealtimeWatchdog();
    }

    private async syncRealtimeWatchdog(): Promise<void> {
        if (this.realtimeEvents.hasListeners())
            await this.realtimeWatchdog.start();
        else
            this.realtimeWatchdog.stop();
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number')
        return value;
    if (typeof value === 'string' && value) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}

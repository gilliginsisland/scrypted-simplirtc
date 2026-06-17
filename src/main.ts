import sdk, { Device, DeviceProvider, Refresh, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { KinesisSimpliSafeCameraDevice, LiveKitSimpliSafeCameraDevice, SimpliSafeCameraDevice } from './camera';
import { SimpliSafeApi } from './simplisafe/api';
import { SimpliSafeAuth, SimpliSafeTokenState, SimpliSafeTokenStore } from './simplisafe/oauth';
import { DiscoveredSimpliSafeCamera, SimpliSafeRealtimeEvent } from './simplisafe/types';

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
    private cameras = new Map<string, DiscoveredSimpliSafeCamera>();
    private devices = new Map<string, SimpliSafeCameraDevice>();

    settingsStorage = new StorageSettings(this, {
        accountNumber: {
            title: 'Account Number',
            description: 'Optional: restrict discovery to one SimpliSafe account number.',
        },
        redirectUrl: {
            title: 'Redirect URL',
            description: 'Paste the final SimpliSafe mobile redirect URL here after opening the Login URL.',
            type: 'textarea',
            noStore: true,
            onPut: async (_oldValue: unknown, newValue: unknown) => {
                const redirectUrl = newValue?.toString().trim();
                if (!redirectUrl)
                    return;
                await this.auth.exchangeRedirectUrl(redirectUrl);
                this.log.a('SimpliSafe login completed.');
                await this.discoverDevices();
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
        debug: {
            title: 'Debug Logging',
            type: 'boolean',
            defaultValue: false,
        },
    });

    auth = new SimpliSafeAuth(new StorageTokenStore(this.settingsStorage));
    api = new SimpliSafeApi(this.auth, {
        accountNumber: asString(this.settingsStorage.values.accountNumber),
        logger: this.console,
    });

    constructor(nativeId?: string) {
        super(nativeId);
        this.api.addCameraMotionListener(event => {
            this.handleCameraMotionEvent(event).catch(e => this.console.error('Failed to route SimpliSafe camera motion event.', e));
        });
        this.startup().catch(e => this.console.error('SimpliSafe discovery failed.', e));
    }

    private async startup(): Promise<void> {
        if (!this.auth.state.refreshToken) {
            this.log.a('Open the SimpliSafe Login URL setting, approve access, then paste the final redirect URL.');
            return;
        }
        await this.discoverDevices();
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
        if (key === 'accountNumber')
            await this.discoverDevices();
    }

    async refresh(refreshInterface: string, userInitiated: boolean): Promise<void> {
        this.console.log(`Refreshing SimpliSafe devices: interface=${refreshInterface} userInitiated=${userInitiated}`);
        await this.discoverDevices();
    }

    async getRefreshFrequency(): Promise<number> {
        return 300;
    }

    async discoverDevices(): Promise<void> {
        this.api.setOptions({
            accountNumber: asString(this.settingsStorage.values.accountNumber),
            logger: this.console,
        });

        const cameras = await this.api.discoverCameras();
        this.cameras.clear();

        const devices: Device[] = cameras.map(camera => {
            this.cameras.set(camera.nativeId, camera);
            return {
                nativeId: camera.nativeId,
                name: camera.name,
                type: ScryptedDeviceType.Camera,
                interfaces: [
                    ScryptedInterface.MotionSensor,
                    ScryptedInterface.RTCSignalingChannel,
                ],
                info: {
                    manufacturer: 'SimpliSafe',
                    model: camera.model ?? camera.backend,
                    firmware: camera.firmware,
                    serialNumber: camera.serial,
                },
            };
        });

        await deviceManager.onDevicesChanged({ devices });
        this.console.log(`Discovered ${devices.length} supported SimpliSafe camera(s).`);
        if (devices.length)
            await this.api.startRealtimeEvents();
        else
            this.api.stopRealtimeEvents();
    }

    async getDevice(nativeId: string): Promise<SimpliSafeCameraDevice> {
        let camera = this.cameras.get(nativeId);
        if (!camera) {
            await this.discoverDevices();
            camera = this.cameras.get(nativeId);
        }
        if (!camera)
            throw new Error(`Unknown SimpliSafe camera nativeId=${nativeId}`);

        let device = this.devices.get(nativeId);
        if (!device || device.camera !== camera) {
            switch (camera.backend) {
                case 'kvs':
                    device = new KinesisSimpliSafeCameraDevice(this, nativeId, camera);
                    break;
                case 'mist':
                    device = new LiveKitSimpliSafeCameraDevice(this, nativeId, camera);
                    break;
                default:
                    throw new Error(`Camera '${camera.name}' has unsupported SimpliSafe WebRTC provider '${camera.backend}'.`);
            }
            this.devices.set(nativeId, device);
        }
        return device;
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        this.devices.get(nativeId)?.clearMotion();
        this.devices.delete(nativeId);
    }

    private async handleCameraMotionEvent(event: SimpliSafeRealtimeEvent): Promise<void> {
        let matched = false;
        for (const camera of this.cameras.values()) {
            if (!cameraMatchesMotionEvent(camera, event))
                continue;

            matched = true;
            const device = await this.getDevice(camera.nativeId);
            device.handleMotionEvent(event);
        }

        if (!matched)
            this.console.debug(`Ignoring SimpliSafe camera motion event for unmatched sensor serial '${event.sensorSerial ?? 'missing'}'.`);
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

function cameraMatchesMotionEvent(camera: DiscoveredSimpliSafeCamera, event: SimpliSafeRealtimeEvent): boolean {
    if (event.systemId && event.systemId !== camera.systemId)
        return false;
    return !!event.sensorSerial && camera.eventSerials.includes(event.sensorSerial);
}

import fs from 'fs';
import path from 'path';
import { SimpliSafeApi } from '../src/simplisafe/api';
import { SimpliSafeAuth } from '../src/simplisafe/oauth';
import type { SimpliSafeTokenState, SimpliSafeTokenStore } from '../src/simplisafe/oauth';
import type { DiscoveredSimpliSafeCamera } from '../src/simplisafe/types';

const defaultAccessTokenTtlMs = 30 * 60 * 1000;

class JsonFileTokenStore implements SimpliSafeTokenStore {
    private filename: string;

    constructor(filename: string) {
        this.filename = filename;
    }

    read(): SimpliSafeTokenState {
        try {
            return JSON.parse(fs.readFileSync(this.filename, 'utf8')) as SimpliSafeTokenState;
        }
        catch {
            return {};
        }
    }

    write(state: SimpliSafeTokenState): void {
        fs.writeFileSync(this.filename, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    }
}

async function main(): Promise<void> {
    const args = new Set(process.argv.slice(2));
    const tokenFile = path.resolve(process.env.SIMPLISAFE_TOKEN_FILE || '.simplisafe-auth.json');
    const store = new JsonFileTokenStore(tokenFile);
    const auth = new SimpliSafeAuth(store);

    seedTokensFromEnvironment(store, tokenFile);

    if (args.has('--auth-url')) {
        console.log(await auth.getAuthorizationUrl());
        return;
    }

    const redirectUrl = process.env.SIMPLISAFE_REDIRECT_URL;
    if (redirectUrl) {
        await auth.exchangeRedirectUrl(redirectUrl);
        console.log(`Stored SimpliSafe tokens in ${tokenFile}`);
    }

    const api = new SimpliSafeApi(auth, {
        accountNumber: process.env.SIMPLISAFE_ACCOUNT_NUMBER,
        logger: console,
    });

    const cameras = await api.discoverCameras();
    console.log(JSON.stringify(cameras.map(camera => ({
        nativeId: camera.nativeId,
        name: camera.name,
        serial: camera.serial,
        eventSerials: camera.eventSerials,
        systemId: camera.systemId,
        systemName: camera.systemName,
        backend: camera.backend,
        model: camera.model,
        firmware: camera.firmware,
        options: summarizeCameraOptions(camera.raw),
    })), null, 2));

    if (!args.has('--live-view'))
        return;

    for (const camera of cameras) {
        const liveView = await api.getLiveView(camera);
        console.log(JSON.stringify({
            camera: camera.name,
            serial: camera.serial,
            ...summarizeLiveView(camera, liveView),
        }, null, 2));
    }
}

function seedTokensFromEnvironment(store: JsonFileTokenStore, tokenFile: string): void {
    const refreshToken = process.env.SIMPLISAFE_REFRESH_TOKEN;
    const accessToken = process.env.SIMPLISAFE_ACCESS_TOKEN;
    if (!refreshToken && !accessToken)
        return;

    const state = store.read();
    const ttlMs = accessTokenTtlMs();
    store.write({
        ...state,
        tokenType: process.env.SIMPLISAFE_TOKEN_TYPE || state.tokenType || 'Bearer',
        refreshToken: refreshToken || state.refreshToken,
        accessToken: accessToken || state.accessToken,
        expiresAt: accessToken ? Date.now() + ttlMs : state.expiresAt,
    });

    console.log(`Seeded SimpliSafe token state in ${tokenFile}`);
}

function summarizeCameraOptions(rawCamera: unknown): Record<string, unknown> {
    const camera = assertRecord(rawCamera, 'SimpliSafe camera');
    const cameraSettings = assertOptionalRecord(firstDefined(camera.camera_settings, camera.cameraSettings), 'SimpliSafe camera settings') ?? {};
    const admin = assertOptionalRecord(cameraSettings.admin, 'SimpliSafe camera admin settings') ?? {};
    const supportedFeatures = assertOptionalRecord(camera.supportedFeatures, 'SimpliSafe supportedFeatures') ?? {};
    const providers = assertOptionalRecord(supportedFeatures.providers, 'SimpliSafe supportedFeatures providers') ?? {};
    return {
        rawKeys: Object.keys(camera).sort(),
        cameraSettingsKeys: Object.keys(cameraSettings).sort(),
        supportedFeaturesKeys: Object.keys(supportedFeatures).sort(),
        admin: {
            webRTCProvider: admin.webRTCProvider,
            firmwareVersion: firstDefined(admin.firmwareVersion, admin.firmware_version),
            fps: admin.fps,
            bitRate: admin.bitRate,
        },
        supportedFeatures: {
            providers,
            privacyShutter: supportedFeatures.privacyShutter,
        },
        mediaProvider: providers.recording,
        cloudMediaLikelySupported: providers.recording === undefined || providers.recording === 'simplisafe',
    };
}

function summarizeLiveView(camera: DiscoveredSimpliSafeCamera, liveView: unknown): Record<string, unknown> {
    const object = recordValue(liveView) ?? {};
    switch (camera.backend) {
        case 'kvs':
            return {
                provider: 'kvs',
                hasSignedChannelEndpoint: typeof object.signedChannelEndpoint === 'string' && !!object.signedChannelEndpoint,
                clientId: stringValue(object.clientId),
                iceServerCount: Array.isArray(object.iceServers) ? object.iceServers.length : 0,
            };
        case 'mist': {
            const details = recordValue(object.liveKitDetails) ?? {};
            const token = stringValue(details.userToken);
            return {
                provider: 'mist',
                liveKitURL: stringValue(details.liveKitURL),
                hasUserToken: !!token,
                userTokenExpiresAt: decodeJwtExpiry(token),
            };
        }
        default:
            return {
                provider: camera.backend,
                rawKeys: Object.keys(object).sort(),
            };
    }
}

function accessTokenTtlMs(): number {
    const value = process.env.SIMPLISAFE_ACCESS_TOKEN_TTL_MS;
    if (!value)
        return defaultAccessTokenTtlMs;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        throw new Error('SIMPLISAFE_ACCESS_TOKEN_TTL_MS must be a finite number.');
    return parsed;
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function firstDefined<T>(...values: T[]): T | undefined {
    return values.find(value => value !== undefined && value !== null);
}

function decodeJwtExpiry(token: string | undefined): string | undefined {
    if (!token)
        return;
    const [, payload] = token.split('.');
    if (!payload)
        return;
    try {
        const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
        if (!json.exp)
            return;
        return new Date(json.exp * 1000).toISOString();
    }
    catch {
        return;
    }
}

main().catch(e => {
    console.error(e);
    process.exitCode = 1;
});

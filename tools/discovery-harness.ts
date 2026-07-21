import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { SimpliSafeApi } from '../src/simplisafe/api';
import { schema } from '../src/simplisafe/camera';
import type { SimpliSafeCamera } from '../src/simplisafe/camera';
import { SimpliSafeAuth } from '../src/simplisafe/oauth';
import type { SimpliSafeTokenState, SimpliSafeTokenStore } from '../src/simplisafe/oauth';

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

    const api = new SimpliSafeApi(auth);
    if (args.has('--schema-shapes')) {
        await inspectSubscriptionSchemas(api);
        return;
    }
    await api.update();

    const cameras: SimpliSafeCamera[] = [];
    for (const subscription of api.subscriptions()) {
        for (const camera of subscription.cameras())
            cameras.push(camera);
    }
    console.log(JSON.stringify(cameras.map(camera => ({
        name: camera.name,
        uuid: camera.uuid,
        serial: camera.serial,
        systemId: camera.systemId,
        backend: camera.backend,
        model: camera.model,
        firmware: camera.firmware,
        options: summarizeCameraOptions(camera.raw),
    })), null, 2));

    if (!args.has('--live-view'))
        return;

    for (const camera of cameras) {
        switch (camera.backend) {
            case 'kvs': {
                const liveView = await camera.getLiveView('kvs');
                console.log(JSON.stringify({
                    camera: camera.name,
                    serial: camera.serial,
                    provider: 'kvs',
                    hasSignedChannelEndpoint: !!liveView.signedChannelEndpoint,
                    clientId: liveView.clientId,
                    iceServerCount: liveView.iceServers.length,
                }, null, 2));
                break;
            }
            case 'mist': {
                const liveView = await camera.getLiveView('mist');
                console.log(JSON.stringify({
                    camera: camera.name,
                    serial: camera.serial,
                    provider: 'mist',
                    liveKitURL: liveView.liveKitDetails.liveKitURL,
                    hasUserToken: !!liveView.liveKitDetails.userToken,
                    userTokenExpiresAt: decodeJwtExpiry(liveView.liveKitDetails.userToken),
                }, null, 2));
                break;
            }
            default: {
                const liveView = await camera.getLiveView(camera.backend);
                console.log(JSON.stringify({
                    camera: camera.name,
                    serial: camera.serial,
                    provider: camera.backend,
                    raw: liveView[schema] === 'raw',
                }, null, 2));
                break;
            }
        }
    }
}

async function inspectSubscriptionSchemas(api: SimpliSafeApi): Promise<void> {
    const userId = await api.getUserId();
    const summaries = await api.requestJson(`users/${encodeURIComponent(userId.toString())}/subscriptions?activeOnly=false`, {
        schema: z.unknown(),
    });
    const summaryEnvelope = assertRecord(summaries, 'SimpliSafe subscription summaries');
    if (!Array.isArray(summaryEnvelope.subscriptions))
        throw new Error('SimpliSafe subscription summaries must contain a subscriptions array.');

    const details = [];
    for (const summary of summaryEnvelope.subscriptions) {
        const subscription = assertRecord(summary, 'SimpliSafe subscription summary');
        if (typeof subscription.sid !== 'number')
            throw new Error('SimpliSafe subscription summary must contain a numeric sid.');
        details.push(await api.requestJson(`subscriptions/${encodeURIComponent(subscription.sid.toString())}/`, {
            schema: z.unknown(),
        }));
    }

    console.log(JSON.stringify({
        summaries: describeShape(summaries),
        details: details.map(describeShape),
    }, null, 2));
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
        video: {
            supportedResolutions: cameraSettings.supportedResolutions,
            featureResolutions: supportedFeatures.resolutions,
        },
        supportedFeatures: {
            providers,
            privacyShutter: supportedFeatures.privacyShutter,
        },
        mediaProvider: providers.recording,
        cloudMediaLikelySupported: providers.recording === undefined || providers.recording === 'simplisafe',
    };
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

function describeShape(value: unknown, depth = 0): unknown {
    if (value === null)
        return 'null';
    if (Array.isArray(value)) {
        return {
            type: 'array',
            length: value.length,
            item: value.length ? describeShape(value[0], depth + 1) : undefined,
        };
    }
    if (typeof value !== 'object')
        return typeof value;

    const object = value as Record<string, unknown>;
    if (depth === 5)
        return 'object';
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, describeShape(object[key], depth + 1)]));
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

import crypto from 'crypto';

const oauthBaseUrl = 'https://auth.simplisafe.com/oauth';
const authorizeUrl = 'https://auth.simplisafe.com/authorize';

const clientId = '42aBZ5lYrVW12jfOuu3CQROitwxg9sN5';
const auth0Client = 'eyJ2ZXJzaW9uIjoiMi4zLjIiLCJuYW1lIjoiQXV0aDAuc3dpZnQiLCJlbnYiOnsic3dpZnQiOiI1LngiLCJpT1MiOiIxNi4zIn19';
const redirectUri = 'com.simplisafe.mobile://auth.simplisafe.com/ios/com.simplisafe.mobile/callback';
const scope = 'offline_access email openid https://api.simplisafe.com/scopes/user:platform';
const audience = 'https://api.simplisafe.com/';
const device = 'iPhone';

export interface SimpliSafeTokenState {
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresAt?: number;
    codeVerifier?: string;
    deviceId?: string;
}

export interface SimpliSafeTokenStore {
    read(): SimpliSafeTokenState;
    write(state: SimpliSafeTokenState): Promise<void> | void;
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number | string;
}

export class SimpliSafeAuth {
    private store: SimpliSafeTokenStore;

    constructor(store: SimpliSafeTokenStore) {
        this.store = store;
    }

    get state(): SimpliSafeTokenState {
        return this.store.read();
    }

    async getAuthorizationUrl(): Promise<string> {
        const codeVerifier = await this.getOrCreateCodeVerifier();
        const deviceId = await this.getOrCreateDeviceId();
        const codeChallenge = base64Url(sha256(codeVerifier));
        const url = new URL(authorizeUrl);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('scope', scope);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('code_challenge', codeChallenge);
        url.searchParams.set('audience', audience);
        url.searchParams.set('auth0Client', auth0Client);
        url.searchParams.set('device', device);
        url.searchParams.set('device_id', deviceId);
        return url.toString();
    }

    async exchangeRedirectUrl(redirectUrl: string): Promise<void> {
        const code = parseAuthorizationCode(redirectUrl);
        const codeVerifier = this.state.codeVerifier;
        if (!codeVerifier)
            throw new Error('Missing OAuth code verifier. Generate a login URL before exchanging the redirect URL.');

        const token = await requestToken({
            grant_type: 'authorization_code',
            client_id: clientId,
            code_verifier: codeVerifier,
            code,
            redirect_uri: redirectUri,
        });
        await this.storeToken(token);
    }

    async ensureAccessToken(): Promise<string> {
        const state = this.state;
        if (state.accessToken && state.expiresAt && state.expiresAt - 60000 > Date.now())
            return state.accessToken;

        if (!state.refreshToken)
            throw new Error('SimpliSafe is not authenticated. Generate a login URL and paste the redirect URL.');

        await this.refresh();
        const refreshed = this.state.accessToken;
        if (!refreshed)
            throw new Error('SimpliSafe credential refresh did not return an access token.');
        return refreshed;
    }

    async refresh(): Promise<void> {
        const { refreshToken } = this.state;
        if (!refreshToken)
            throw new Error('Missing SimpliSafe refresh token.');

        const token = await requestToken({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
        });
        await this.storeToken(token);
    }

    private async getOrCreateCodeVerifier(): Promise<string> {
        const state = this.state;
        if (state.codeVerifier)
            return state.codeVerifier;

        const codeVerifier = base64Url(crypto.randomBytes(32));
        await this.store.write({
            ...state,
            codeVerifier,
        });
        return codeVerifier;
    }

    private async getOrCreateDeviceId(): Promise<string> {
        const state = this.state;
        if (state.deviceId)
            return state.deviceId;

        const deviceId = crypto.randomUUID();
        await this.store.write({
            ...state,
            deviceId,
        });
        return deviceId;
    }

    private async storeToken(token: TokenResponse): Promise<void> {
        const previous = this.state;
        const expiresIn = Number(token.expires_in);
        if (!Number.isFinite(expiresIn) || expiresIn <= 0)
            throw new Error(`Invalid token expiry from SimpliSafe: ${token.expires_in}`);

        await this.store.write({
            ...previous,
            accessToken: token.access_token,
            refreshToken: token.refresh_token ?? previous.refreshToken,
            tokenType: token.token_type || 'Bearer',
            expiresAt: Date.now() + expiresIn * 1000,
        });
    }
}

function parseAuthorizationCode(redirectUrl: string): string {
    let parsed: URL;
    try {
        parsed = new URL(redirectUrl);
    }
    catch {
        throw new Error('Invalid SimpliSafe redirect URL.');
    }

    const code = parsed.searchParams.get('code');
    if (!code)
        throw new Error('SimpliSafe redirect URL did not contain an authorization code.');
    return code;
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
    const response = await fetch(`${oauthBaseUrl}/token`, {
        method: 'POST',
        headers: {
            'Auth0-Client': auth0Client,
            'Content-Type': 'application/json',
            Host: 'auth.simplisafe.com',
        },
        body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok)
        throw new Error(`SimpliSafe token request failed: ${response.status} ${response.statusText}: ${text}`);

    return JSON.parse(text) as TokenResponse;
}

function sha256(value: string): Buffer {
    return crypto.createHash('sha256').update(value).digest();
}

function base64Url(value: Buffer): string {
    return value.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

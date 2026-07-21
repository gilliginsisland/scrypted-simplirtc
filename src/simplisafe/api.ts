import { z } from 'zod';
import { SimpliSafeAuth } from './oauth';
import { SimpliSafeSubscription, subscriptionSummarySchema } from './subscription';

const apiBaseUrl = 'https://api.simplisafe.com/v1';

export class TemplateUrl {
    readonly #url: URL;
    readonly #keys: readonly string[];

    constructor(private readonly template: string) {
        const match = /\{[?&]([^}]*)\}$/.exec(template);
        this.#url = new URL(match ? template.slice(0, match.index) : template);
        this.#keys = match?.[1].split(',') ?? [];
    }

    keys(): string[] {
        return [...this.#keys];
    }

    render(values: Readonly<Record<string, string | number | boolean | undefined>> = {}): URL {
        const url = new URL(this.#url);
        for (const [key, value] of Object.entries(values)) {
            if (value !== undefined)
                url.searchParams.set(key, value.toString());
        }
        return url;
    }

    toString(): string {
        return this.template;
    }
}

const templateUrlSchema = z.string().url().transform(value => new TemplateUrl(value));

export interface SimpliSafeMediaSize {
    width?: number;
    height?: number;
}

export class SimpliSafeMedia {
    constructor(private api: SimpliSafeApi, readonly url: TemplateUrl) {
    }

    async fetch(size: SimpliSafeMediaSize = {}): Promise<Buffer> {
        return this.api.requestBinary(this.url.render({
            width: size.width,
            height: size.height,
        }), {
            headers: {
                Accept: 'image/jpeg',
            },
        });
    }
}

export function simpliSafeMediaSchema(api: SimpliSafeApi) {
    return z.looseObject({
        href: templateUrlSchema,
    }).transform(media => new SimpliSafeMedia(api, media.href));
}

const authCheckSchema = z.looseObject({
    userId: z.number(),
});
const subscriptionsResponseSchema = z.looseObject({
    subscriptions: z.array(subscriptionSummarySchema),
});

export interface SimpliSafeBinaryRequestOptions extends RequestInit {
    baseUrl?: string;
}

export interface SimpliSafeRequestOptions<Schema extends z.ZodType> extends SimpliSafeBinaryRequestOptions {
    schema: Schema;
}

export class SimpliSafeApi {
    private auth: SimpliSafeAuth;
    #subscriptions = new Map<number, SimpliSafeSubscription>();

    constructor(auth: SimpliSafeAuth) {
        this.auth = auth;
    }

    async requestJson<Schema extends z.ZodType>(path: string | URL, options: SimpliSafeRequestOptions<Schema>): Promise<z.output<Schema>> {
        const { schema, ...binaryOptions } = options;
        const headers = new Headers(binaryOptions.headers);
        if (!headers.has('Accept'))
            headers.set('Accept', 'application/json');
        return schema.parseAsync(JSON.parse((await this.requestBinary(path, { ...binaryOptions, headers })).toString('utf8')) as unknown);
    }

    async requestBinary(path: string | URL, options: SimpliSafeBinaryRequestOptions = {}): Promise<Buffer> {
        const { baseUrl = apiBaseUrl, ...init } = options;
        const accessToken = await this.auth.ensureAccessToken();
        const tokenType = this.auth.state.tokenType || 'Bearer';
        const headers = new Headers(init.headers);
        headers.set('Authorization', `${tokenType} ${accessToken}`);
        const method = init.method ?? 'GET';
        const response = await fetch(
            new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`),
            { ...init, headers },
        );
        if (!response.ok) {
            const text = await response.text();
            const requestPath = typeof path === 'string' ? path : path.pathname;
            throw new Error(`SimpliSafe API request failed: ${method} ${requestPath}: ${response.status} ${response.statusText}: ${text}`);
        }
        return Buffer.from(await response.arrayBuffer());
    }

    mediaSchema() {
        return simpliSafeMediaSchema(this);
    }

    async update(): Promise<void> {
        const userId = await this.getUserId();
        const response = await this.requestJson(`users/${encodeURIComponent(userId.toString())}/subscriptions?activeOnly=false`, {
            schema: subscriptionsResponseSchema,
        });
        const subscriptionIds = new Set<number>();

        for (const subscription of response.subscriptions) {
            subscriptionIds.add(subscription.sid);
            if (!this.#subscriptions.has(subscription.sid))
                this.#subscriptions.set(subscription.sid, new SimpliSafeSubscription(this, subscription.sid));
        }

        for (const subscriptionId of this.#subscriptions.keys()) {
            if (!subscriptionIds.has(subscriptionId))
                this.#subscriptions.delete(subscriptionId);
        }

        for (const subscription of this.#subscriptions.values())
            await subscription.update();
    }

    subscriptions(): Iterable<SimpliSafeSubscription> {
        return this.#subscriptions.values();
    }

    async getUserId(): Promise<number> {
        const response = await this.requestJson('api/authCheck', {
            schema: authCheckSchema,
        });
        return response.userId;
    }
}

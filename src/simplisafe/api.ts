import { z } from 'zod';
import { SimpliSafeAuth } from './oauth';
import { SimpliSafeRealtimeEvents } from './realtime';
import { SimpliSafeSubscription, subscriptionSummarySchema } from './subscription';

const apiBaseUrl = 'https://api.simplisafe.com/v1';

const authCheckSchema = z.looseObject({
    userId: z.number(),
});
const subscriptionsResponseSchema = z.looseObject({
    subscriptions: z.array(subscriptionSummarySchema),
});

export interface SimpliSafeBinaryRequestOptions extends RequestInit {
    baseUrl?: string;
    searchParams?: URLSearchParams;
}

export interface SimpliSafeRequestOptions<Schema extends z.ZodType> extends SimpliSafeBinaryRequestOptions {
    schema: Schema;
}

export class SimpliSafeApi {
    #subscriptions = new Map<number, SimpliSafeSubscription>();
    readonly events: SimpliSafeRealtimeEvents;

    constructor(public readonly auth: SimpliSafeAuth, readonly console: Console) {
        this.events = new SimpliSafeRealtimeEvents(this);
    }

    async requestJson<Schema extends z.ZodType>(path: string | URL, options: SimpliSafeRequestOptions<Schema>): Promise<z.output<Schema>> {
        const { schema, ...binaryOptions } = options;
        const headers = new Headers(binaryOptions.headers);
        if (!headers.has('Accept'))
            headers.set('Accept', 'application/json');
        return schema.parseAsync(JSON.parse((await this.requestBinary(path, { ...binaryOptions, headers })).toString('utf8')) as unknown);
    }

    async requestBinary(path: string | URL, options: SimpliSafeBinaryRequestOptions = {}): Promise<Buffer> {
        const { baseUrl = apiBaseUrl, searchParams, ...init } = options;
        const accessToken = await this.auth.ensureAccessToken();
        const tokenType = this.auth.state.tokenType || 'Bearer';
        const headers = new Headers(init.headers);
        headers.set('Authorization', `${tokenType} ${accessToken}`);
        const method = init.method ?? 'GET';
        const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
        if (searchParams)
            url.search = searchParams.toString();
        const response = await fetch(
            url,
            { ...init, headers },
        );
        if (!response.ok) {
            const text = await response.text();
            const requestPath = typeof path === 'string' ? path : path.pathname;
            throw new Error(
                `SimpliSafe API request failed: ${method} ${requestPath}: ${response.status} ${response.statusText}: ${text}`
            );
        }
        return Buffer.from(await response.arrayBuffer());
    }

    async update(): Promise<void> {
        const userId = await this.getUserId();
        const response = await this.requestJson(
            `users/${encodeURIComponent(userId.toString())}/subscriptions?activeOnly=false`,
            { schema: subscriptionsResponseSchema },
        );
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

        await Promise.all(Array.from(
            this.#subscriptions.values(),
            subscription => subscription.update(),
        ));
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

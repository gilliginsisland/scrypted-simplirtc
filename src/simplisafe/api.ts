import { z } from 'zod';
import { SimpliSafeAuth } from './oauth';
import { SimpliSafeSubscription, subscriptionEnvelopeSchema, subscriptionSummarySchema } from './subscription';

const apiBaseUrl = 'https://api.simplisafe.com/v1';

const authCheckSchema = z.looseObject({
    userId: z.number(),
});
const subscriptionsResponseSchema = z.looseObject({
    subscriptions: z.array(subscriptionSummarySchema),
});

export interface SimpliSafeRequestOptions<Schema extends z.ZodType> extends RequestInit {
    schema?: Schema;
    baseUrl?: string;
}

export class SimpliSafeApi {
    private auth: SimpliSafeAuth;
    #subscriptions = new Map<number, SimpliSafeSubscription>();

    constructor(auth: SimpliSafeAuth) {
        this.auth = auth;
    }

    async request<Schema extends z.ZodType>(path: string, options: SimpliSafeRequestOptions<Schema> & { schema: Schema }): Promise<z.output<Schema>>;
    async request(path: string, options?: SimpliSafeRequestOptions<z.ZodType>): Promise<unknown>;
    async request(path: string, options: SimpliSafeRequestOptions<z.ZodType> = {}): Promise<unknown> {
        const { schema = z.unknown(), baseUrl = apiBaseUrl, ...init } = options;
        return schema.parse(await this.requestJson(path, init, baseUrl));
    }

    async update(): Promise<void> {
        const userId = await this.getUserId();
        const response = await this.request(`users/${encodeURIComponent(userId.toString())}/subscriptions?activeOnly=false`, {
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

    private async requestJson(path: string, init: RequestInit, baseUrl: string): Promise<unknown> {
        const accessToken = await this.auth.ensureAccessToken();
        const tokenType = this.auth.state.tokenType || 'Bearer';
        const headers = new Headers(init.headers);
        if (!headers.has('Accept'))
            headers.set('Accept', 'application/json');
        headers.set('Authorization', `${tokenType} ${accessToken}`);
        const method = init.method ?? 'GET';
        const response = await fetch(
            new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`),
            { ...init, headers },
        );

        const text = await response.text();
        if (!response.ok)
            throw new Error(`SimpliSafe API request failed: ${method} ${path}: ${response.status} ${response.statusText}: ${text}`);
        if (!text)
            return undefined;
        return JSON.parse(text) as unknown;
    }

    async getUserId(): Promise<number> {
        const response = await this.request('api/authCheck', {
            schema: authCheckSchema,
        });
        return response.userId;
    }
}

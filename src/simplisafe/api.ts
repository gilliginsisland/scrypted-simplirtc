import type { SimpliSafeCameraDetails } from './camera';
import { SimpliSafeAuth } from './oauth';
import { SimpliSafeSubscription, subscriptionEnvelopeSchema } from './subscription';
import { z } from 'zod';

const apiBaseUrl = 'https://api.simplisafe.com/v1';
const liveViewBaseUrl = 'https://app-hub.prd.aser.simplisafe.com/v2';

const authCheckSchema = z.looseObject({
    userId: z.number().finite(),
});
const subscriptionsResponseSchema = z.looseObject({
    subscriptions: z.array(z.unknown()),
});
const unknownSchema = z.unknown();

export interface SimpliSafeRequestOptions<Schema extends z.ZodType> extends RequestInit {
    schema: Schema;
    baseUrl?: string;
}

export class SimpliSafeApi {
    private auth: SimpliSafeAuth;
    private subscriptions = new Map<number, SimpliSafeSubscription>();

    constructor(auth: SimpliSafeAuth) {
        this.auth = auth;
    }

    async request<Schema extends z.ZodType>(path: string, options: SimpliSafeRequestOptions<Schema>): Promise<z.output<Schema>> {
        const { schema, baseUrl = apiBaseUrl, ...init } = options;
        return schema.parse(await this.requestJson(path, init, baseUrl));
    }

    async update(): Promise<void> {
        const userId = await this.getUserId();
        const response = await this.getSubscriptionSummaries(userId);
        const subscriptionIds = new Set<number>();

        for (const subscriptionDetails of response.subscriptions) {
            const discovered = new SimpliSafeSubscription(this, subscriptionDetails);
            if (!discovered.id)
                continue;

            subscriptionIds.add(discovered.id);
            const existing = this.subscriptions.get(discovered.id);
            if (existing)
                existing.updateSummary(subscriptionDetails);
            else
                this.subscriptions.set(discovered.id, discovered);
        }

        for (const subscriptionId of this.subscriptions.keys()) {
            if (!subscriptionIds.has(subscriptionId))
                this.subscriptions.delete(subscriptionId);
        }

        for (const subscription of this.subscriptions.values())
            await subscription.update();
    }

    getSubscriptions(): Iterable<SimpliSafeSubscription> {
        return this.subscriptions.values();
    }

    private async requestJson(path: string, init: RequestInit, baseUrl: string): Promise<unknown> {
        const accessToken = await this.auth.ensureAccessToken();
        const tokenType = this.auth.state.tokenType || 'Bearer';
        const headers = new Headers(init.headers);
        if (!headers.has('Accept'))
            headers.set('Accept', 'application/json');
        headers.set('Authorization', `${tokenType} ${accessToken}`);
        const method = init.method ?? 'GET';
        const response = await fetch(new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
            ...init,
            headers,
        });

        const text = await response.text();
        if (!response.ok)
            throw new Error(`SimpliSafe API request failed: ${method} ${path}: ${response.status} ${response.statusText}: ${text}`);
        if (!text)
            return undefined;
        return JSON.parse(text) as unknown;
    }

    async getUserId(): Promise<number> {
        const response = await this.getAuthCheck();
        return response.userId;
    }

    private async getAuthCheck(): Promise<z.output<typeof authCheckSchema>> {
        return this.request('api/authCheck', {
            schema: authCheckSchema,
        });
    }

    private async getSubscriptionSummaries(userId: number): Promise<z.output<typeof subscriptionsResponseSchema>> {
        return this.request(`users/${encodeURIComponent(userId.toString())}/subscriptions?activeOnly=false`, {
            schema: subscriptionsResponseSchema,
        });
    }

    async getSubscription(subscriptionId: number): Promise<z.output<typeof subscriptionEnvelopeSchema>> {
        return this.request(`subscriptions/${encodeURIComponent(subscriptionId.toString())}/`, {
            schema: subscriptionEnvelopeSchema,
        });
    }

    async getLiveView(camera: Pick<SimpliSafeCameraDetails, 'serial' | 'systemId'>): Promise<unknown> {
        return this.request(`cameras/${encodeURIComponent(camera.serial)}/${encodeURIComponent(camera.systemId.toString())}/live-view`, {
            schema: unknownSchema,
            baseUrl: liveViewBaseUrl,
        });
    }
}

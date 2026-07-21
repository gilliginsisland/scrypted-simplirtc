import { cameraSchema, SimpliSafeCamera } from './camera';
import type { SimpliSafeApi } from './api';
import { z } from 'zod';

export class SimpliSafeSubscription {
    #cameras = new Map<string, SimpliSafeCamera>();

    constructor(private api: SimpliSafeApi, private id: number) {
    }

    cameras(): Iterable<SimpliSafeCamera> {
        return this.#cameras.values();
    }

    async update(): Promise<void> {
        const { subscription } = await this.api.requestJson(`subscriptions/${encodeURIComponent(this.id.toString())}/`, {
            schema: subscriptionEnvelopeSchema,
        });

        const cameraIds = new Set<string>();
        for (const cameraDetails of subscription.location.system.cameras) {
            cameraIds.add(cameraDetails.uuid);
            const camera = this.#cameras.get(cameraDetails.uuid);
            if (camera)
                camera.update(cameraDetails);
            else {
                const camera = new SimpliSafeCamera(this.api);
                camera.update(cameraDetails);
                this.#cameras.set(cameraDetails.uuid, camera);
            }
        }

        for (const cameraId of this.#cameras.keys()) {
            if (!cameraIds.has(cameraId))
                this.#cameras.delete(cameraId);
        }
    }

}

export const subscriptionSummarySchema = z.looseObject({
    sid: z.number(),
});
const systemSchema = z.looseObject({
    cameras: z.array(cameraSchema),
    version: z.literal(3),
});
const locationSchema = z.looseObject({
    system: systemSchema,
});
const subscriptionDetailsSchema = z.looseObject({
    location: locationSchema,
});
export const subscriptionEnvelopeSchema = z.looseObject({
    subscription: subscriptionDetailsSchema,
});

import { z } from 'zod';
import type { SimpliSafeApi } from './api';
import { cameraSchema, SimpliSafeCamera } from './camera';
import {
    SimpliSafeEventType,
    simpliSafeEventSchema,
    type SimpliSafeEvent,
} from './realtime';

export class SimpliSafeSubscription {
    #cameras = new Map<string, SimpliSafeCamera>();

    constructor(public readonly api: SimpliSafeApi, private id: number) {
    }

    cameras(): Iterable<SimpliSafeCamera> {
        return this.#cameras.values();
    }

    private async primeSnapshots(): Promise<void> {
        const cameras = new Set(this.#cameras.values());
        if (!cameras.size)
            return;

        let pages = 0;
        for await (const events of this.events()) {
            for (const eventData of events) {
                for (const [cameraUuid, video] of Object.entries(eventData.video ?? {})) {
                    const snapshot = video._links?.['snapshot/jpg'];
                    if (!snapshot)
                        continue;
                    const camera = this.#cameras.get(cameraUuid);
                    if (!camera || !cameras.has(camera))
                        continue;
                    if (eventData.eventTimestamp > (camera.latestSnapshot?.timestamp ?? 0))
                        camera.latestSnapshot = {
                            media: snapshot,
                            timestamp: eventData.eventTimestamp,
                        };
                    cameras.delete(camera);
                }
            }
            if (!cameras.size || ++pages === 20)
                break;
        }
    }

    async update(): Promise<void> {
        const { subscription } = await this.api.requestJson(
            `subscriptions/${encodeURIComponent(this.id.toString())}/`,
            { schema: subscriptionEnvelopeSchema },
        );

        const cameras = new Map<string, SimpliSafeCamera>();
        for (const cameraDetails of subscription.location.system.cameras) {
            const camera = this.#cameras.get(cameraDetails.uuid) ?? new SimpliSafeCamera(this);
            this.#cameras.delete(cameraDetails.uuid);
            camera.update(cameraDetails);
            cameras.set(cameraDetails.uuid, camera);
        }
        this.#cameras = cameras;

        await this.primeSnapshots();
    }

    private async getEvents(options?: { before?: number; pageSize?: number }): Promise<SimpliSafeEvent[]> {
        const { before, pageSize } = options ?? {};
        const searchParams = new URLSearchParams();
        if (before !== undefined)
            searchParams.set('fromTimestamp', before.toString());
        if (pageSize !== undefined)
            searchParams.set('numEvents', pageSize.toString());
        const response = await this.api.requestJson(
            `subscriptions/${encodeURIComponent(this.id.toString())}/events`,
            {
                schema: z.looseObject({
                    events: z.array(simpliSafeEventSchema),
                }),
                searchParams,
            },
        );
        return response.events;
    }

    private async *events(
        eventCid?: SimpliSafeEventType,
        options?: { before?: number; pageSize?: number },
    ): AsyncIterable<SimpliSafeEvent[]> {
        let opts = options;
        for (; ;) {
            const events = await this.getEvents(opts);
            yield eventCid === undefined
                ? events
                : events.filter(event => event.eventCid === eventCid);
            if (events.length < (opts?.pageSize ?? 1))
                return;
            opts = {
                before: events[events.length - 1].eventTimestamp,
                pageSize: events.length,
            };
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

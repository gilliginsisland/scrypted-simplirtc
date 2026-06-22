import { ScryptedDeviceBase } from '@scrypted/sdk';
import type { SimpliSafeApi } from './simplisafe/api';
import type { SimpliSafeRealtimeEvent, SimpliSafeRealtimeEventMap, SimpliSafeRealtimeEvents } from './simplisafe/realtime';

export abstract class SimpliSafeDevice extends ScryptedDeviceBase {
    private realtimeListenerRemovers: (() => void)[] = [];
    protected abstract eventSerials: readonly string[];

    constructor(public api: SimpliSafeApi, public realtimeEvents: SimpliSafeRealtimeEvents, nativeId?: string) {
        super(nativeId);
    }

    protected addRealtimeListener<EventName extends keyof SimpliSafeRealtimeEventMap & string>(
        eventName: EventName,
        listener: (...args: SimpliSafeRealtimeEventMap[EventName]) => void,
    ): void {
        const filteredListener = (...args: SimpliSafeRealtimeEventMap[EventName]) => {
            const event = args[0] as SimpliSafeRealtimeEvent | undefined;
            if (!event?.sensorSerial || !this.eventSerials.includes(event.sensorSerial))
                return;
            listener(...args);
        };
        this.realtimeEvents.on(eventName, filteredListener as never);
        this.realtimeListenerRemovers.push(() => {
            this.realtimeEvents.off(eventName, filteredListener as never)
        });
    }

    release(): void {
        for (const removeListener of this.realtimeListenerRemovers.splice(0))
            removeListener();
    }
}

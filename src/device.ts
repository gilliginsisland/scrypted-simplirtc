import { ScryptedDeviceBase } from '@scrypted/sdk';
import type {
    SimpliSafeCamera,
    SimpliSafeEvent,
    SimpliSafeEventType,
} from './simplisafe';

type SimpliSafeEventHandler = (this: SimpliSafeDevice, event: SimpliSafeEvent) => void;
type SimpliSafeEventHandlers = ReadonlyMap<SimpliSafeEventType, SimpliSafeEventHandler>;
export abstract class SimpliSafeDevice extends ScryptedDeviceBase {
    protected static readonly eventHandlers: SimpliSafeEventHandlers = new Map();

    constructor(private readonly device: SimpliSafeCamera, nativeId?: string) {
        super(nativeId);
        const handlers = (this.constructor as typeof SimpliSafeDevice).eventHandlers;
        for (const [eventType, handler] of handlers) {
            const listener = (event: SimpliSafeEvent) => handler.call(this, event);
            this.device.subscription.api.events.addEventListener(eventType, this.device, listener);
        }
    }

    release(): void {
        for (const eventType of (this.constructor as typeof SimpliSafeDevice).eventHandlers.keys()) {
            this.device.subscription.api.events.removeEventListener(eventType, this.device);
        }
    }
}

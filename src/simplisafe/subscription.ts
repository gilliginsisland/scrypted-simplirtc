import { SimpliSafeCamera } from './camera';
import type { SimpliSafeCameraApi, SimpliSafeCameraBackend, SimpliSafeCameraDetails } from './camera';
import { z } from 'zod';

const activeSubscriptionStatuses = new Set([7, 10, 20]);

export interface SimpliSafeSubscriptionApi extends SimpliSafeCameraApi {
    getSubscription(subscriptionId: number): Promise<SubscriptionEnvelope>;
}

export class SimpliSafeSubscription {
    private summary!: SubscriptionSummary;
    private cameras = new Map<string, SimpliSafeCamera>();
    id?: number;
    status?: number;

    constructor(private api: SimpliSafeSubscriptionApi, subscriptionDetails: unknown) {
        this.updateSummary(subscriptionDetails);
    }

    updateSummary(subscriptionDetails: unknown): void {
        this.summary = subscriptionSummarySchema.parse(subscriptionDetails);
        this.id = this.summary.sid;
        this.status = this.summary.sStatus;
    }

    getCameras(): Iterable<SimpliSafeCamera> {
        return this.cameras.values();
    }

    async update(): Promise<void> {
        if (!this.id) {
            this.cameras.clear();
            return;
        }
        if (this.status !== undefined && !activeSubscriptionStatuses.has(this.status)) {
            this.cameras.clear();
            return;
        }

        const subscription = await this.getDetails(this.id);
        const location = z.record(z.string(), z.unknown()).nullish().parse(subscription.location) ?? {};
        const system = systemSchema.nullish().parse(firstDefined(
            location.system,
            subscription.system,
        )) ?? {};
        const systemId = firstDefined(
            system.system_id,
            system.systemId,
            system.sid,
            system.id,
            subscription.sid,
            this.id,
        );
        if (!systemId) {
            this.cameras.clear();
            return;
        }

        const version = firstDefined(system.version, system.systemVersion);
        if (version !== undefined && version !== 3) {
            this.cameras.clear();
            return;
        }

        const cameraIds = new Set<string>();
        for (const cameraDetails of firstDefined(system.cameras, system.camera) ?? []) {
            const details = createCameraDetails(systemId, subscription, system, cameraDetails);
            if (!details)
                continue;

            cameraIds.add(details.serial);
            const camera = this.cameras.get(details.serial);
            if (camera)
                camera.update(details);
            else
                this.cameras.set(details.serial, new SimpliSafeCamera(this.api, details));
        }

        for (const cameraId of this.cameras.keys()) {
            if (!cameraIds.has(cameraId))
                this.cameras.delete(cameraId);
        }
    }

    private async getDetails(subscriptionId: number): Promise<SubscriptionDetails> {
        let subscriptionEnvelope: unknown;
        try {
            subscriptionEnvelope = await this.api.getSubscription(subscriptionId);
        }
        catch {
            subscriptionEnvelope = this.summary;
        }

        const object = subscriptionEnvelopeSchema.nullish().parse(subscriptionEnvelope);
        return subscriptionDetailsSchema.parse(firstDefined(object?.subscription, subscriptionEnvelope, this.summary));
    }
}

export const subscriptionSummarySchema = z.looseObject({
    sid: z.number().finite().optional(),
    sStatus: z.number().finite().optional(),
});
export const subscriptionEnvelopeSchema = z.looseObject({
    subscription: z.unknown().optional(),
});
const subscriptionDetailsSchema = z.looseObject({
    location: z.unknown().optional(),
    system: z.unknown().optional(),
    sid: z.number().finite().optional(),
});
const systemSchema = z.looseObject({
    cameras: z.array(z.unknown()).optional(),
    camera: z.array(z.unknown()).optional(),
    camera_data: z.unknown().optional(),
    cameraData: z.unknown().optional(),
    version: z.number().finite().optional(),
    systemVersion: z.number().finite().optional(),
    system_id: z.number().finite().optional(),
    systemId: z.number().finite().optional(),
    sid: z.number().finite().optional(),
    id: z.number().finite().optional(),
});
const cameraSettingsSchema = z.looseObject({
    cameraName: z.string().min(1).optional(),
    admin: z.unknown().optional(),
});
const cameraAdminSchema = z.looseObject({
    webRTCProvider: z.string().min(1).optional(),
});
const cameraSchema = z.looseObject({
    uuid: z.string().min(1).optional(),
    serial: z.string().min(1).optional(),
    camera_serial: z.string().min(1).optional(),
    cameraSerial: z.string().min(1).optional(),
    serialNumber: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    camera_settings: z.unknown().optional(),
    cameraSettings: z.unknown().optional(),
    model: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    firmware: z.string().min(1).optional(),
    firmware_version: z.string().min(1).optional(),
    firmwareVersion: z.string().min(1).optional(),
});
type SubscriptionSummary = z.output<typeof subscriptionSummarySchema>;
export type SubscriptionEnvelope = z.output<typeof subscriptionEnvelopeSchema>;
type SubscriptionDetails = z.output<typeof subscriptionDetailsSchema>;

function createCameraDetails(systemId: number, subscription: SubscriptionDetails, system: z.output<typeof systemSchema>, cameraDetails: unknown): SimpliSafeCameraDetails<SimpliSafeCameraBackend> | undefined {
    const camera = cameraSchema.parse(cameraDetails);
    const cameraSettings = cameraSettingsSchema.nullish().parse(firstDefined(camera.camera_settings, camera.cameraSettings)) ?? {};
    const serial = firstDefined(
        camera.uuid,
        camera.serial,
        camera.camera_serial,
        camera.cameraSerial,
        camera.serialNumber,
        camera.id,
    );
    const name = firstDefined(
        camera.name,
        cameraSettings.cameraName,
        camera.displayName,
        camera.label,
        serial,
    );
    if (!serial || !name)
        return;

    const admin = cameraAdminSchema.nullish().parse(cameraSettings.admin);
    const backend = admin?.webRTCProvider;
    if (backend !== 'kvs' && backend !== 'mist')
        return;

    return {
        name,
        serial,
        eventSerials: cameraEventSerials(system, camera, serial),
        systemId,
        systemName: z.string().min(1).nullish().parse(z.record(z.string(), z.unknown()).nullish().parse(subscription.location)?.name) ?? undefined,
        backend,
        model: z.string().min(1).nullish().parse(firstDefined(camera.model, camera.type, camera.kind)) ?? undefined,
        firmware: z.string().min(1).nullish().parse(firstDefined(camera.firmware, camera.firmware_version, camera.firmwareVersion)) ?? undefined,
        raw: cameraDetails,
    };
}

function cameraEventSerials(system: Record<string, unknown>, camera: Record<string, unknown>, serial: string): string[] {
    const serials = new Set<string>([serial]);
    addCameraIdentifiers(serials, camera);

    const parsedSystem = systemSchema.parse(system);
    const cameraData = z.record(z.string(), z.unknown()).nullish().parse(firstDefined(parsedSystem.camera_data, parsedSystem.cameraData)) ?? {};
    const knownSerials = [...serials];
    for (const candidate of knownSerials) {
        const data = cameraSchema.nullish().parse(cameraData[candidate]);
        if (data)
            addCameraIdentifiers(serials, data);
    }

    for (const value of Object.values(cameraData)) {
        const data = cameraSchema.nullish().parse(value);
        if (!data)
            continue;
        const dataSerials = new Set<string>();
        addCameraIdentifiers(dataSerials, data);
        if ([...dataSerials].some(candidate => serials.has(candidate)))
            addCameraIdentifiers(serials, data);
    }

    return [...serials];
}

function addCameraIdentifiers(serials: Set<string>, camera: Record<string, unknown>): void {
    for (const key of ['uuid', 'serial']) {
        const identifier = z.string().min(1).nullish().parse(camera[key]);
        if (identifier)
            serials.add(identifier);
    }
}

function firstDefined<T>(...values: T[]): T | undefined {
    return values.find(value => value !== undefined && value !== null);
}

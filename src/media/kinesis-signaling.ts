import { RTCSessionControl, RTCSignalingSession } from '@scrypted/sdk';
import { DiscoveredSimpliSafeCamera, KinesisLiveView } from '../simplisafe/types';

export class KinesisSignaling {
    constructor(private camera: DiscoveredSimpliSafeCamera, private liveView: KinesisLiveView) {
    }

    async start(_session: RTCSignalingSession): Promise<RTCSessionControl> {
        throw new Error(`Kinesis WebRTC streaming is not implemented yet for ${this.camera.name}. Discovery and live-view metadata are available for client ${this.liveView.clientId}.`);
    }
}

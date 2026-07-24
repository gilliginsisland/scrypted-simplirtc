import {
    RTCAVSignalingSetup,
    RTCSignalingSendIceCandidate,
    RTCSignalingSession,
} from '@scrypted/sdk';

export class Deferred<T> {
    readonly promise: Promise<T>;
    resolve!: (value: T | PromiseLike<T>) => void;
    reject!: (reason?: unknown) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

export function createCandidateQueue(send: RTCSignalingSendIceCandidate): {
    flush: () => Promise<void>;
    sendIceCandidate: RTCSignalingSendIceCandidate;
} {
    let ready = false;
    let candidates: RTCIceCandidateInit[] = [];

    const sendIceCandidate: RTCSignalingSendIceCandidate = async candidate => {
        if (!ready) {
            candidates.push(candidate);
            return;
        }
        await send(candidate);
    };

    return {
        async flush(): Promise<void> {
            ready = true;
            for (const candidate of candidates)
                await send(candidate);
            candidates = [];
        },
        sendIceCandidate,
    };
}

export async function connectRTCSignalingClients(
    offerSession: RTCSignalingSession,
    offerSetup: Partial<RTCAVSignalingSetup>,
    answerSession: RTCSignalingSession,
    answerSetup: Partial<RTCAVSignalingSetup>,
): Promise<void> {
    const { options: offerOptions } = offerSession;
    const { options: answerOptions } = answerSession;
    if (offerOptions.offer && answerOptions.offer)
        throw new Error('Both RTC clients have offers and can not negotiate.');
    if (offerOptions.requiresOffer && answerOptions.requiresOffer)
        throw new Error('Both RTC clients require offers and can not negotiate.');

    const disableTrickle = !!(offerOptions.disableTrickle || answerOptions.disableTrickle);
    const answerCandidates = createCandidateQueue(candidate => answerSession.addIceCandidate(candidate));
    const offerCandidates = createCandidateQueue(candidate => offerSession.addIceCandidate(candidate));

    offerSetup.type = 'offer';
    answerSetup.type = 'answer';

    const offer = await offerSession.createLocalDescription(
        'offer',
        offerSetup as RTCAVSignalingSetup,
        disableTrickle ? undefined : answerCandidates.sendIceCandidate,
    );
    await answerSession.setRemoteDescription(offer, answerSetup as RTCAVSignalingSetup);
    const answer = await answerSession.createLocalDescription(
        'answer',
        answerSetup as RTCAVSignalingSetup,
        disableTrickle ? undefined : offerCandidates.sendIceCandidate,
    );
    await offerSession.setRemoteDescription(answer, offerSetup as RTCAVSignalingSetup);
    await Promise.all([
        offerCandidates.flush(),
        answerCandidates.flush(),
    ]);
}

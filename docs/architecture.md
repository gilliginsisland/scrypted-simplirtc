# Architecture Notes

## Scrypted Shape

The plugin should keep the SimpliSafe cloud leg as WebRTC, not an RTSP proxy.
Scrypted's WebRTC plugin can pass native `RTCSignalingChannel` sessions directly
to browser clients and provide the downstream `VideoCamera` mixin surface.

This plugin should register each SimpliSafe camera as:

- `RTCSignalingChannel` for native WebRTC session ownership.
- `MotionSensor` for SimpliSafe camera motion events.

It should not implement `VideoCamera` directly. Scrypted's WebRTC plugin mixin
adds that surface for camera devices that expose `RTCSignalingChannel`, matching
the Ring plugin pattern.

## Video Dimensions

SimpliSafe camera frames are not guaranteed to use a standard 16:9 resolution.
Do not hardcode width or height constants in this plugin. The direct WebRTC path
should preserve the producer SDP and let the browser/Scrypted WebRTC layer learn
the actual video dimensions from the media track.

The SimpliSafe LiveKit path should preserve the producer SDP and encoded H264
packets without SDP munging that strips SPS/PPS or otherwise forces an assumed
resolution.

## Backend Plan

Kinesis (`kvs`) is the simpler path: Scrypted can create an SDP offer, send it to
the Kinesis websocket as `SDP_OFFER`, then apply `SDP_ANSWER` and
`ICE_CANDIDATE` messages back to the Scrypted signaling session.

LiveKit (`mist`) should first be attempted as a direct Scrypted answerer:
LiveKit sends offers, including an `m=application` datachannel section, and the
plugin answers them through the Scrypted `RTCSignalingSession`. If that collides
with the consumer-offer flow or renegotiation semantics, the fallback should be a
small internal RTP bridge/SFU like the Home Assistant reference:

- producer peer connection talks to LiveKit,
- consumer peer connections talk to Scrypted/browser/HomeKit,
- encoded RTP is forwarded with payload type, SSRC, MID/header extension, RTX,
  and RTCP feedback rewriting as needed.

The bridge should preserve H264 packets and RTP/RTCP timing. Decoding and
re-encoding should be avoided unless Scrypted/HomeKit compatibility requires it.

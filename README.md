# Scrypted SimpliSafe Cameras

Native Scrypted plugin for SimpliSafe V3 cameras.

This is an initial scaffold with OAuth authentication, system/camera discovery,
backend detection, and Scrypted camera device registration. Media signaling is
intentionally split into small backend-specific classes so Kinesis and LiveKit
can be implemented without introducing an RTSP proxy first.

## Current Status

- SimpliSafe OAuth PKCE login and refresh token storage.
- V3 camera discovery from SimpliSafe account subscriptions.
- Supported WebRTC backend detection:
  - `kvs`: AWS Kinesis Video Streams WebRTC signaling.
  - `mist`: LiveKit WebRTC signaling.
- Unknown backend values are skipped with a warning.
- Camera devices expose `RTCSignalingChannel` for the native WebRTC media path.
- Scrypted's WebRTC plugin mixin provides the `VideoCamera` surface.
- Camera devices expose `MotionSensor` using SimpliSafe websocket
  `camera_motion_detected` events. SimpliSafe does not provide a matching clear
  event, so motion is held active for 30 seconds after each event.

# SimpliSafe Cameras for Scrypted

The SimpliSafe Cameras plugin imports supported SimpliSafe V3 cameras into
Scrypted. It uses the camera's native WebRTC provider and can expose camera
motion events to Scrypted.

## Notes

Do not enable Prebuffer for SimpliSafe cameras. Keeping a cloud camera stream
open continuously can interfere with motion events and use unnecessary
bandwidth.

## Setup

1. Use Chrome on a desktop computer. Open Chrome DevTools before beginning
   (`Cmd+Option+J` on macOS or `Ctrl+Shift+J` on Windows/Linux).
2. Open the **SimpliSafe Cameras** plugin in Scrypted, then open **Login URL**
   in Chrome.
3. Sign in to SimpliSafe and complete any email or two-factor verification.
4. After approval, SimpliSafe tries to open a `com.simplisafe.mobile://...`
   URL. Chrome blocks this redirect; copy the complete URL from the error in
   the DevTools **Console**. If it is not there, look for the redirect in the
   DevTools **Network** panel.
5. Paste the complete redirect URL into **Redirect URL** in the plugin
   settings.

If the SimpliSafe page was already signed in before opening DevTools, open a
new tab, open DevTools there, and paste the Login URL into that tab to capture
the redirect.

The plugin stores the resulting credentials in its Scrypted settings and
refreshes the camera list automatically. Use **Refresh** from the plugin page
to discover cameras again later.

## Supported Cameras and Video

- SimpliSafe V3 cameras from the signed-in account's subscriptions.
- SimpliSafe cameras that use Amazon Kinesis Video Streams or LiveKit for
  video. Both are supported.

Other camera video backends are not supported and are skipped with a message in
the Scrypted log.

## Motion Events

Each imported camera exposes a motion sensor. SimpliSafe does not provide a
motion-ended event, so the plugin keeps motion active for 30 seconds after the
most recent motion.

## Troubleshooting

### No cameras appear

- Complete the Login URL and Redirect URL steps, including the full custom
  redirect URL.
- Use **Refresh** on the plugin page after authentication.
- Check the Scrypted plugin log for unsupported camera backends or SimpliSafe
  API errors.

### Video is unavailable

Check the Scrypted plugin log for an unsupported camera backend or a video
connection error.

### Motion remains active

This is expected for up to 30 seconds after the last SimpliSafe motion event.

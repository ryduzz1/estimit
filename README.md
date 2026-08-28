# Estimit

Estimit is a TypeScript app built with Expo and React Native.

## Backend connection

Build profiles send scans to `https://server.tailc264d2.ts.net:8443`. Development uses private Tailscale Serve; production-beta uses Tailscale Funnel on the same port so the app works from any internet connection. The app registers a revocable per-install credential and stores it in iOS Keychain with Expo SecureStore. Provider keys never ship in the app.

Override the endpoint for another environment before starting Expo:

```sh
EXPO_PUBLIC_ESTIMIT_API_URL=https://api.example.com npm start
```

The app handles four server outcomes: an evidence-backed valuation, identified-item research links without an invented price, a targeted request for another photo, or a recoverable connection/service error. A follow-up photo includes the previous identification candidate as a hint.

Release profiles are defined in `eas.json`. Before a broad App Store release, replace the production endpoint with a custom API domain and add Apple App Attest to the installation-registration flow.

Preview builds include a compact calibration control under marketplace estimates. Testers can mark an estimate low, fair, or high and optionally compare it with a trusted known value. Production builds keep the simple qualitative feedback but hide known-value entry.

## iOS development with Xcode

This is an Expo + React Native app. Xcode runs the native iOS app, while Expo provides the JavaScript development server and configuration.

This Expo SDK requires Xcode 26.4 or newer. The currently installed Xcode 26.0 can open the workspace but cannot compile its native Expo dependencies.

For day-to-day work:

```sh
npm install
npm start
```

Then open [ios/Estimit.xcworkspace](ios/Estimit.xcworkspace) in Xcode, select the `Estimit` scheme and an iPhone simulator (or your connected iPhone), and press Run (`⌘R`).

`npm run ios` is the terminal alternative: it builds and launches the same iOS app without opening Xcode first.

## Expo configuration

[app.json](app.json) is the source of truth for app identity and native settings. It retains the iOS bundle identifier `com.ryduzz.estimit.estimit` and sets iOS 18.0 as the minimum deployment target.

The `ios/` folder is generated from that configuration and intentionally ignored by Git. If we add a native Expo package or change native configuration later, refresh it with:

```sh
npx expo prebuild --platform ios
```

Then reopen the workspace in Xcode. Avoid routine edits to Xcode build settings; place those settings in `app.json` so they survive regeneration.

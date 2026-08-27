# Estimit

Estimit is a TypeScript app built with Expo and React Native.

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

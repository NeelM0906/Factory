/**
 * electron-builder configuration for AutoStack desktop app (spec section 18.1).
 *
 * Produces a macOS .app bundle and DMG installer. ASAR packaging is enabled by default.
 *
 * Signing and notarization:
 *   Wired but gated on Apple Developer credentials. The build succeeds without them
 *   (unsigned .app + DMG), which is the expected path for local development and CI
 *   without secrets. To enable:
 *
 *   - Code signing:
 *       CSC_LINK          = path or base64 of a .p12 Developer ID certificate
 *       CSC_KEY_PASSWORD   = password for the .p12 (may be empty string)
 *     Or set CSC_NAME to use a certificate already in the keychain.
 *     To skip signing explicitly: CSC_IDENTITY_AUTO_DISCOVERY=false
 *
 *   - Notarization (requires signing):
 *       APPLE_ID           = Apple ID email
 *       APPLE_APP_SPECIFIC_PASSWORD = app-specific password (appleid.apple.com)
 *       APPLE_TEAM_ID      = 10-character Apple Developer Team ID
 *
 *   When these variables are absent, electron-builder skips signing and notarization
 *   automatically. The build still produces a functional .app and DMG for testing.
 */

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "ai.autostack.desktop",
  productName: "AutoStack",
  copyright: "Copyright (c) 2026 AutoStack contributors",

  // ---------------------------------------------------------------------------
  // Input: where electron-builder finds the pre-built output
  // ---------------------------------------------------------------------------
  directories: {
    // electron-vite writes main, preload, renderer, guardian, and utility builds here.
    // electron-builder reads the main entry from package.json "main" (dist/main/index.js).
    output: "release"
  },

  // ---------------------------------------------------------------------------
  // ASAR packaging
  // ---------------------------------------------------------------------------
  asar: true,
  asarUnpack: [
    // node-pty ships a native .node addon that Electron loads via dlopen at runtime.
    // ASAR archives are transparent to require() but not to dlopen, so the native binary
    // must be unpacked to disk.
    "dist/runtime/native/**",
    // The guardian and utility processes are forked with execPath, not required, so they
    // must be real files on disk.
    "dist/guardian/**",
    "dist/utility/**"
  ],

  // Include the runtime manifest produced by build-runtime-manifest.mjs
  files: [
    "dist/**",
    "!dist/playwright-report/**",
    "!dist/e2e-results/**",
    // package.json is included automatically
    "!**/*.map"
  ],

  // Prevent electron-builder from trying to rebuild native deps itself;
  // rebuild-native.mjs handles this with the correct Electron ABI.
  npmRebuild: false,

  // ---------------------------------------------------------------------------
  // macOS
  // ---------------------------------------------------------------------------
  mac: {
    target: [
      {
        target: "dmg",
        arch: ["arm64"]
      },
      {
        target: "dir",
        arch: ["arm64"]
      }
    ],
    category: "public.app-category.developer-tools",
    // Hardened runtime is required for notarization. It's safe to enable even for
    // unsigned builds -- it just means the app requests fewer entitlements.
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "entitlements.mac.plist",
    entitlementsInherit: "entitlements.mac.plist",
    // electron-builder auto-discovers signing identity from CSC_LINK / CSC_NAME.
    // When neither is set, it skips signing.
    identity: null
  },

  dmg: {
    // Simple DMG layout: app icon + Applications alias
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" }
    ],
    window: {
      width: 540,
      height: 380
    }
  },

  // ---------------------------------------------------------------------------
  // Notarization (only when APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD are set)
  // ---------------------------------------------------------------------------
  afterSign: "./scripts/notarize.mjs",

  // ---------------------------------------------------------------------------
  // Publish: disabled for now (local-first, no auto-update server)
  // ---------------------------------------------------------------------------
  publish: null
};

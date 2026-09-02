/**
 * electron-builder afterSign hook for macOS notarization (spec section 18.1).
 *
 * This script runs after code signing. It submits the signed .app to Apple's notarization
 * service and staples the ticket. Gated on environment variables: when APPLE_ID,
 * APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are all set, notarization proceeds.
 * Otherwise the script exits silently, allowing unsigned/unnotarized development builds.
 */
import { notarize } from "@electron/notarize";

/**
 * @param {import("electron-builder").AfterPackContext} context
 */
export default async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== "darwin") {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      "Skipping notarization: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID not set."
    );
    console.log(
      "To enable notarization, set all three environment variables. See electron-builder.config.cjs for details."
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);

  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId
  });

  console.log("Notarization complete.");
}

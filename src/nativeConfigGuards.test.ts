/**
 * The native-security settings that only `app.json` can hold.
 *
 * `/ios` and `/android` are **gitignored prebuild output** — verified: zero
 * tracked files in each — so every native file is regenerated from `app.json`
 * on the next `expo prebuild`, which CI and EAS run because the directories are
 * not in the repo. That makes editing `AndroidManifest.xml` or `Info.plist`
 * directly a trap of the worst kind: the change is correct, survives local
 * testing, and is silently discarded by the next build.
 *
 * (CLAUDE.md states these directories are checked in. They are not.)
 *
 * So the settings live in `app.json` and are asserted here. A test rather than
 * a comment because the failure mode is invisible: nothing at runtime says
 * "your data is being backed up", and the default is the insecure one.
 */

import appConfig from "../app.json";

describe("app.json native security config", () => {
  const android = appConfig.expo.android as { allowBackup?: boolean };

  it("disables Android's automatic backup", () => {
    // `allowBackup` defaults to TRUE, and the prebuilt manifest carried it
    // explicitly. It hands the app's entire private data directory — the whole
    // MMKV store, so vault ciphertext, the withdrawal journal, addresses and
    // every cached account fact — to Google's backup transport and to `adb
    // backup`, off the device and out of the app sandbox.
    //
    // The master key itself lives in the Keystore and is not covered by this,
    // but everything needed to profile the account is.
    expect(android.allowBackup).toBe(false);
  });

  it("keeps the bundle identifiers that the Keychain and Keystore are scoped to", () => {
    // A changed identifier is a new keychain namespace: the vault, the agent
    // key and the presence gate all become unreachable, and the app looks to
    // the user like it forgot their wallet.
    expect(appConfig.expo.ios.bundleIdentifier).toBe("com.craftlabs.hl");
    expect((appConfig.expo.android as { package?: string }).package).toBe("com.craftlabs.hl");
  });
});

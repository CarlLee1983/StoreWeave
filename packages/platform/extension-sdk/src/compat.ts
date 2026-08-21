import semver from 'semver';
import { PlatformError } from '@storeweave/contracts';
import type { ExtensionManifest } from './manifest';

export interface CompatibilityResult {
  compatible: boolean;
  reason?: string;
}

/** Platform Version Compatibility：Extension 宣告 semver range，Core 提供實際版本。 */
export function checkPlatformCompatibility(
  manifest: ExtensionManifest<any>,
  platformVersion: string,
): CompatibilityResult {
  if (!semver.validRange(manifest.platformVersion)) {
    return { compatible: false, reason: `"${manifest.platformVersion}" is not a valid semver range` };
  }
  if (!semver.satisfies(platformVersion, manifest.platformVersion, { includePrerelease: true })) {
    return {
      compatible: false,
      reason: `extension requires platform ${manifest.platformVersion}, running ${platformVersion}`,
    };
  }
  return { compatible: true };
}

export function assertPlatformCompatibility(manifest: ExtensionManifest<any>, platformVersion: string): void {
  const result = checkPlatformCompatibility(manifest, platformVersion);
  if (!result.compatible) {
    throw PlatformError.validation(`Extension "${manifest.id}" is incompatible: ${result.reason}`);
  }
}

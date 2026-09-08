import { installReleaseDirectory, validateReleaseDirectory } from '../tools/cli/src/release-validation';

try {
  const [directory, expectedReleaseId, releasesDirectory] = process.argv.slice(2);
  if (!directory || (releasesDirectory && !expectedReleaseId) || process.argv.length > 5) throw new Error('Usage: validate-release <directory> [release-id] [install-releases-directory]');
  console.log(JSON.stringify(releasesDirectory
    ? installReleaseDirectory(directory, releasesDirectory, expectedReleaseId!)
    : validateReleaseDirectory(directory, expectedReleaseId)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

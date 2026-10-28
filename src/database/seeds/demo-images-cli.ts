import { basename } from 'node:path';
import {
  analyzeDemoImageFolder,
  formatDemoImageReport,
  reportHasProblems,
} from './demo-image-files';
import {
  DEMO_IMAGES_FILE,
  serializeDemoImageManifest,
  writeFileAtomic,
  type DemoImageSlot,
} from './demo-image-manifest';
import {
  createCloudinaryClient,
  DemoImageAuthError,
  readCloudinaryCredentials,
  uploadDemoImages,
  type CloudinaryCredentials,
  type DemoImageUploadClient,
  type DemoImageUploadOutcome,
} from './demo-image-upload';
import { getDemoImageSlots } from './demo-seed';

const USAGE =
  'Usage: npm run images:upload -- --dir <image folder> [--dry-run]';

export interface DemoImagesCliDependencies {
  env: Record<string, string | undefined>;
  io: { log(line: string): void; error(line: string): void };
  createClient?: (credentials: CloudinaryCredentials) => DemoImageUploadClient;
  outputFile?: string;
  slots?: readonly DemoImageSlot[];
  sleep?: (milliseconds: number) => Promise<void>;
}

// Exit codes: 0 done, 1 problems (files, credentials, uploads), 2 bad usage.
export async function runDemoImagesCli(
  argv: readonly string[],
  dependencies: DemoImagesCliDependencies,
): Promise<number> {
  const { io } = dependencies;
  const options = parseArguments(argv);
  if ('error' in options) {
    io.error(`${options.error}\n${USAGE}`);
    return 2;
  }

  try {
    let credentials: CloudinaryCredentials | undefined;
    if (!options.dryRun) {
      credentials = readCloudinaryCredentials(dependencies.env);
    }

    const slots = dependencies.slots ?? getDemoImageSlots();
    const report = analyzeDemoImageFolder(options.dir, slots);
    for (const line of formatDemoImageReport(report, slots.length)) {
      io.log(line);
    }
    const hasProblems = reportHasProblems(report);

    if (options.dryRun) {
      io.log(
        hasProblems
          ? 'Dry run found problems (see above). Nothing was uploaded.'
          : 'Dry run passed. Nothing was uploaded; run again without --dry-run to upload.',
      );
      return hasProblems ? 1 : 0;
    }
    if (hasProblems || !credentials) {
      io.error(
        'Fix the problems above first (a --dry-run shows them). Nothing was uploaded.',
      );
      return 1;
    }

    const client = (dependencies.createClient ?? createCloudinaryClient)(
      credentials,
    );
    const secrets = [credentials.apiKey, credentials.apiSecret];
    let outcome: DemoImageUploadOutcome;
    try {
      outcome = await uploadDemoImages({
        report,
        client,
        secrets,
        sleep: dependencies.sleep,
      });
    } catch (error) {
      if (error instanceof DemoImageAuthError) {
        io.error(error.message);
        io.error(
          `Uploaded: ${error.uploaded}, Skipped: ${error.skipped}, Failed: ${error.failed}`,
        );
        return 1;
      }
      throw error;
    }

    for (const failure of outcome.failed) {
      io.error(`  failed: ${failure.fileName} - ${failure.reason}`);
    }
    const summary = `Uploaded: ${outcome.uploaded}, Skipped: ${outcome.skipped}, Failed: ${outcome.failed.length}`;
    if (outcome.failed.length > 0) {
      io.error(summary);
      io.error(
        'Some uploads failed, so the image list was NOT written. Run the same command again: re-uploads are safe.',
      );
      return 1;
    }

    const outputFile = dependencies.outputFile ?? DEMO_IMAGES_FILE;
    writeFileAtomic(outputFile, serializeDemoImageManifest(outcome.manifest));
    io.log(summary);
    io.log(`Wrote ${basename(outputFile)}. Commit it, then seed the database.`);
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : 'Unknown error');
    return 1;
  }
}

function parseArguments(
  argv: readonly string[],
): { dir: string; dryRun: boolean } | { error: string } {
  let dir: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--dir') {
      dir = argv[index + 1];
      index += 1;
    } else {
      return { error: `Unknown argument: ${argument}` };
    }
  }
  if (!dir || dir.startsWith('--')) {
    return { error: 'Missing --dir <image folder>' };
  }
  return { dir, dryRun };
}

import { testRuntimeEnvironment } from '../support/test-runtime-env';

// Only fill gaps so CI values and developer overrides keep winning.
for (const [key, value] of Object.entries(testRuntimeEnvironment)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

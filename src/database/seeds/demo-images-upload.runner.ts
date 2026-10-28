import { runDemoImagesCli } from './demo-images-cli';

// Credentials come only from the environment (never from a file in the repo).
void runDemoImagesCli(process.argv.slice(2), {
  env: process.env,
  io: console,
}).then((exitCode) => {
  process.exitCode = exitCode;
});

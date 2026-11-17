import { runPlaceholderCli } from './cli';

// Makes placeholder pictures only: no network, no database, no credentials.
void runPlaceholderCli(process.argv.slice(2), {
  env: process.env,
  io: console,
}).then((exitCode) => {
  process.exitCode = exitCode;
});

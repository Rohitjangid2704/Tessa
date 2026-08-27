const { writeSync } = require("node:fs");

const exitProcess = process.exit.bind(process);
process.exit = (code) => {
  writeSync(2, `exit-tracer: process.exit(${code === undefined ? "" : code}) called\n`);
  return exitProcess(code);
};

const PLAIN_ARGUMENT = /^[\w@%+=:,./-]+$/;

function quoteArgument(argument: string): string {
  if (PLAIN_ARGUMENT.test(argument)) {
    return argument;
  }
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

export function formatCommandLine(argv: readonly string[]): string {
  return argv.map(quoteArgument).join(" ");
}

export function describeExitCode(exitCode: number): string {
  return exitCode === 0 ? "Success" : "Failed";
}

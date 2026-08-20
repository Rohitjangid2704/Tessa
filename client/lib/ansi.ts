const ESCAPE = String.fromCharCode(0x1b);
const CONTROL_SEQUENCE_INTRODUCER = String.fromCharCode(0x9b);
const BELL = String.fromCharCode(0x07);
const STRING_TERMINATOR = String.fromCharCode(0x9c);
const OPERATING_SYSTEM_COMMAND_LIMIT = 4096;

const TERMINATOR = `(?:${BELL}|${ESCAPE}\\\\|${STRING_TERMINATOR})`;
const OPERATING_SYSTEM_COMMAND = `${ESCAPE}\\][^${BELL}${ESCAPE}${STRING_TERMINATOR}]{0,${OPERATING_SYSTEM_COMMAND_LIMIT}}${TERMINATOR}`;
const CONTROL_SEQUENCE = `[${ESCAPE}${CONTROL_SEQUENCE_INTRODUCER}][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]`;
const SEQUENCE_SOURCE = `${OPERATING_SYSTEM_COMMAND}|${CONTROL_SEQUENCE}`;

const SEQUENCES = new RegExp(SEQUENCE_SOURCE, "g");
const SEQUENCE_DETECTOR = new RegExp(SEQUENCE_SOURCE);
const LEFTOVER_ESCAPES = new RegExp(`[${ESCAPE}${CONTROL_SEQUENCE_INTRODUCER}]`, "g");

export function hasAnsi(text: string): boolean {
  return SEQUENCE_DETECTOR.test(text);
}

export function stripAnsi(text: string): string {
  return text.replace(SEQUENCES, "").replace(LEFTOVER_ESCAPES, "");
}

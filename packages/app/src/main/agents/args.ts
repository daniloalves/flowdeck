/**
 * Normalises a CLI argument list the way clap-style parsers read it, so checks never miss an
 * attached form: `--long=value` → `--long value`, `-xvalue` / `-x=value` → `-x value` (for
 * options that take a value), and combined boolean short flags `-ab` → `-a -b`.
 */
export function normalizeArgs(args: readonly string[], shortWithValue: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) out.push(arg.slice(0, eq), arg.slice(eq + 1));
      else out.push(arg);
      continue;
    }
    if (!/^-[A-Za-z]/.test(arg) || arg.length === 2) {
      out.push(arg);
      continue;
    }
    // -x... : walk the letters until one takes a value; the rest of the token is that value.
    for (let i = 1; i < arg.length; i++) {
      const flag = `-${arg[i]}`;
      if (shortWithValue.has(flag)) {
        out.push(flag);
        const rest = arg.slice(i + 1).replace(/^=/, '');
        if (rest) out.push(rest);
        break;
      }
      out.push(flag);
    }
  }
  return out;
}

/** Value following `names` in a normalised list (last one wins, like the CLIs), or undefined. */
export function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length - 1; i++) if (names.includes(args[i]!)) value = args[i + 1];
  return value;
}

/** All values given to a repeatable option (`-c a -c b`). */
export function optionValues(args: readonly string[], names: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (names.includes(args[i]!)) values.push(args[i + 1]!);
  return values;
}

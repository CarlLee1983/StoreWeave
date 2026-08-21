const ESC = String.fromCharCode(27);
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (text: string) => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);

export const green = wrap('32');
export const yellow = wrap('33');
export const red = wrap('31');
export const dim = wrap('2');
export const bold = wrap('1');

export function statusIcon(status: 'pass' | 'warn' | 'fail'): string {
  return status === 'pass' ? green('OK  ') : status === 'warn' ? yellow('WARN') : red('FAIL');
}

export function heading(text: string): void {
  process.stdout.write(`\n${bold(text)}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function fail(message: string): never {
  process.stderr.write(`${red('error')} ${message}\n`);
  process.exit(1);
}

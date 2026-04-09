import type { RuntimeFrameEvent } from './runtime-session-manager.js';

export type RuntimeTerminalProjection = {
  bodyRows: string[];
  statusRow: string;
};

function fitToColumns(input: string, cols: number): string {
  if (input.length >= cols) return input.slice(0, cols);
  return `${input}${' '.repeat(cols - input.length)}`;
}

export class RuntimeTerminalScreen {
  private lines: string[] = [];

  constructor(private status: string) {}

  setPlainOutput(output: string): void {
    this.lines = output.length > 0 ? output.split('\n') : [];
  }

  applyFrame(frame: RuntimeFrameEvent): void {
    this.setPlainOutput(frame.output);
  }

  project(cols: number, rows: number): RuntimeTerminalProjection {
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(2, Math.floor(rows));
    const bodyCount = Math.max(1, safeRows - 1);
    const visible = this.lines.slice(Math.max(0, this.lines.length - bodyCount));

    const bodyRows: string[] = [];
    for (let i = 0; i < bodyCount; i += 1) {
      bodyRows.push(fitToColumns(visible[i] || '', safeCols));
    }

    return {
      bodyRows,
      statusRow: fitToColumns(this.status, safeCols),
    };
  }
}

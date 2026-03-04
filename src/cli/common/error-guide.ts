import chalk from 'chalk';

export type CliErrorGuide = {
  what: string;
  why: string;
  howToSolve: string[];
  detail?: string;
};

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

export function buildCliErrorGuide(error: unknown): CliErrorGuide {
  const message = extractErrorMessage(error);

  if (message.includes('Runtime stream unavailable') || message.includes('Runtime stream is required')) {
    return {
      what: 'Runtime stream socket is unavailable.',
      why: 'The CLI could not connect to the daemon stream socket (`~/.discode/runtime.sock`). The daemon may be stopped, still starting, or using a different state directory.',
      howToSolve: [
        'Restart daemon: `discode daemon stop && discode daemon start && discode daemon status`',
        'Verify the stream socket exists: `ls -l ~/.discode/runtime.sock`',
        'If `DISCODE_STATE_DIR` is set, make sure both daemon and CLI use the same value.',
      ],
      detail: message,
    };
  }

  return {
    what: message,
    why: 'The command failed due to an unexpected runtime error.',
    howToSolve: [
      'Check daemon status: `discode daemon status`',
      'Inspect recent daemon logs: `discode logs -n 120`',
      'Retry after daemon restart: `discode daemon restart`',
    ],
  };
}

export function formatCliError(error: unknown, header: string = 'Error'): string {
  const guide = buildCliErrorGuide(error);
  const lines = [
    chalk.red(header),
    `What: ${guide.what}`,
    `Why: ${guide.why}`,
    'How to solve:',
    ...guide.howToSolve.map((step, index) => `${index + 1}. ${step}`),
  ];
  if (guide.detail && guide.detail !== guide.what) {
    lines.push(`Details: ${guide.detail}`);
  }
  return lines.join('\n');
}

export function printCliError(error: unknown, header: string = 'Error'): void {
  console.error(formatCliError(error, header));
}

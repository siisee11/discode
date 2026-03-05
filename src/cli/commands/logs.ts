import { existsSync } from 'fs';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { getDaemonLogFilePath } from '../../app/daemon-service.js';

export function logsCommand(options: { follow?: boolean; lines?: number }): void {
  const logFile = getDaemonLogFilePath();

  if (!existsSync(logFile)) {
    console.log(chalk.yellow('No daemon log found. Start daemon first: discode daemon start'));
    return;
  }

  const lines = options.lines ?? 50;
  const args = options.follow ? ['-f', '-n', String(lines), logFile] : ['-n', String(lines), logFile];

  const tail = spawn('tail', args, { stdio: 'inherit' });

  tail.on('error', (error) => {
    console.error(chalk.red(`Failed to read log: ${error.message}`));
    process.exit(1);
  });

  tail.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

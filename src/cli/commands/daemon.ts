import chalk from 'chalk';
import { ensureDaemonRunning, getDaemonStatus, stopDaemon } from '../../app/daemon-service.js';

export async function daemonCommand(action: string) {
  switch (action) {
    case 'start': {
      const result = await ensureDaemonRunning();
      if (result.alreadyRunning) {
        console.log(chalk.green(`✅ Daemon already running (port ${result.port})`));
        console.log(chalk.gray('   Backend: rust'));
        return;
      }
      if (result.ready) {
        console.log(chalk.green(`✅ Daemon started (port ${result.port})`));
      } else {
        console.log(chalk.yellow(`⚠️  Daemon may not be ready. Check logs: ${result.logFile}`));
      }
      if (!result.ready && result.fallbackReason) {
        console.log(chalk.yellow(`⚠️  ${result.fallbackReason}`));
      }
      console.log(chalk.gray('   Backend: rust'));
      break;
    }
    case 'restart': {
      const stopped = stopDaemon();
      if (stopped) {
        console.log(chalk.gray('🔄 Daemon stopped. Starting again...'));
      } else {
        console.log(chalk.gray('Daemon was not running. Starting fresh...'));
      }

      const result = await ensureDaemonRunning();
      if (result.ready) {
        console.log(chalk.green(`✅ Daemon restarted (port ${result.port})`));
      } else {
        console.log(chalk.yellow(`⚠️  Daemon may not be ready. Check logs: ${result.logFile}`));
      }
      if (!result.ready && result.fallbackReason) {
        console.log(chalk.yellow(`⚠️  ${result.fallbackReason}`));
      }
      console.log(chalk.gray('   Backend: rust'));
      break;
    }
    case 'stop': {
      if (stopDaemon()) {
        console.log(chalk.green('✅ Daemon stopped'));
      } else {
        console.log(chalk.gray('Daemon was not running'));
      }
      break;
    }
    case 'status': {
      const status = await getDaemonStatus();
      if (status.running) {
        console.log(chalk.green(`✅ Daemon running (port ${status.port})`));
      } else {
        console.log(chalk.gray('Daemon not running'));
      }
      console.log(chalk.gray(`   Log: ${status.logFile}`));
      console.log(chalk.gray(`   PID: ${status.pidFile}`));
      console.log(chalk.gray(
        `   Runtime Stream Protocol: ${status.runtimeStreamProtocolVersion ?? 'unknown'}`,
      ));
      console.log(chalk.gray('   Backend: rust'));
      break;
    }
    default:
      console.error(chalk.red(`Unknown action: ${action}`));
      console.log(chalk.gray('Available actions: start, restart, stop, status'));
      process.exit(1);
  }
}

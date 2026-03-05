/**
 * Legacy TypeScript daemon entry point retained for migration compatibility.
 */

import { main } from './index.js';

main().catch((error) => {
  console.error('Daemon fatal error:', error);
  process.exit(1);
});

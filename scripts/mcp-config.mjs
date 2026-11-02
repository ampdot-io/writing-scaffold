import { fileURLToPath } from 'node:url';

console.log(JSON.stringify({
  mcpServers: {
    'writing-scaffold': {
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    },
  },
}, null, 2));

#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig, setup } from './config.js';
import { buildServer } from './tools.js';

const cmd = process.argv[2];
if (cmd === 'setup') {
    await setup();
} else if (cmd && cmd !== 'serve') {
    console.error('Usage: snipeit-mcp [setup|serve]   (default: serve over stdio)');
    process.exit(2);
} else {
    let cfg;
    try {
        cfg = loadConfig();
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
    serveStdio(() => buildServer(cfg));
}

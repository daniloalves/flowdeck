import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppClient, resolveIdentity } from './client';
import { createServer } from './server';

async function main(): Promise<void> {
  const identity = resolveIdentity(process.argv.slice(2), process.env);
  const server = createServer(identity ? new AppClient(identity) : null);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout belongs to the MCP protocol; diagnostics go to stderr.
  process.stderr.write(`flowdeck-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

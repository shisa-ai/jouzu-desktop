import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A long saved conversation for the long session scenario of the user playbook (#20):
// `turns` turns, each a user question, a tool call, its result and a reply, so the
// app's first history page holds only the newest part of it. It is written into a
// throwaway data folder (`<dataDir>/state/sessions`), never a user's.
//
//   node e2e-runtime/long-session.mjs <dataDir> <workspace> [turns]
export function writeLongSession(dataDir, workspace, turns = 130) {
  const directory = join(dataDir, 'state', 'sessions');
  mkdirSync(directory, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const lines = [{ type: 'session', version: 3, id: 'long-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: workspace }];
  for (let turn = 1; turn <= turns; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString();
    const call = `call-${turn}`;
    lines.push(
      { type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text: `Long session question ${turn}` }] } },
      { type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'toolCall', id: call, name: 'ls', arguments: { path: '.' } }], stopReason: 'toolUse' } },
      { type: 'message', timestamp, message: { role: 'toolResult', toolCallId: call, toolName: 'ls', content: [{ type: 'text', text: 'notes.txt' }], isError: false } },
      { type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: `Long session answer ${turn}` }], stopReason: 'stop' } },
    );
  }
  const file = join(directory, '2026-01-01T00-00-00-000Z_long-session.jsonl');
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dataDir, workspace, turns] = process.argv.slice(2);
  if (!dataDir || !workspace) { console.error('usage: node e2e-runtime/long-session.mjs <dataDir> <workspace> [turns]'); process.exit(2); }
  console.log(writeLongSession(resolve(dataDir), resolve(workspace), Number(turns ?? 130)));
}

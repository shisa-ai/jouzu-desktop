import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Deterministic loopback provider for exercising the desktop's RPC path.
// It is test-only: no network, no credentials, no runtime patch.

/** Pixel sizes of the PNG images a request carries (from each image's header). */
function imageSizes(messages) {
  const sizes = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const url = part?.type === 'image_url' ? String(part.image_url?.url ?? '') : '';
      const data = /^data:image\/png;base64,(.+)$/u.exec(url)?.[1];
      if (!data) continue;
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR') sizes.push([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]);
    }
  }
  return sizes;
}

export function startFixtureServer(port = 0) {
  const requests = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 2_000_000) request.destroy(); });
    request.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const lastUser = [...messages].reverse().find(message => message.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
      // The system prompt is kept so a check can see what the runtime instructed (e.g. its language section).
      const system = messages.filter(message => message.role === 'system' || message.role === 'developer').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n');
      requests.push({ model: data.model, text, system, images: imageSizes(messages) });
      // A real provider refuses an image with a side of 10 px or less, with this text (#17).
      const tiny = imageSizes(messages).find(([width, height]) => Math.min(width, height) <= 10);
      if (tiny) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'invalid_parameter_error', type: 'invalid_request_error', message: `The image length and width do not meet the model restrictions. [height:${tiny[1]} or width:${tiny[0]} must be larger than 10]` } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant' });
      if (text.includes('SLOW')) {
        chunk({ content: 'waiting-for-steer' });
        setTimeout(() => {
          chunk({ content: 'slow finished' });
          chunk({}, 'stop');
          response.end('data: [DONE]\n\n');
        }, 2500);
        return;
      }
      if (text.includes('ABORT')) {
        chunk({ content: 'waiting-for-abort' });
        const timer = setInterval(() => { if (!response.destroyed) response.write(': keep-alive\n\n'); }, 1000);
        request.on('close', () => clearInterval(timer));
        return;
      }
      if (text.includes('TOOL') && !messages.some(message => message.role === 'tool')) {
        chunk({ tool_calls: [{ index: 0, id: 'fixture-call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: /TOOL:(\S+)/u.exec(text)?.[1] ?? process.env.JOUZU_FIXTURE_FILE ?? 'README.md' }) } }] });
        chunk({}, 'tool_calls');
        response.end('data: [DONE]\n\n');
        return;
      }
      // The user playbook's prompts get the answers a real model gives, so the playbook
      // can run on a throwaway home: a product for "What is A × B?", and a reply in
      // Japanese when the runtime instructs Japanese replies.
      const product = /What is (\d+) × (\d+)\?/.exec(text);
      const japanese = system.includes('Response language: Japanese (ja)');
      const answer = messages.some(message => message.role === 'tool') ? 'tool finished'
        : product ? String(Number(product[1]) * Number(product[2]))
        : japanese ? 'あかです。'
        : `fixture reply: ${text}`;
      chunk({ content: answer });
      chunk({}, 'stop');
      response.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startFixtureServer(Number(process.env.JOUZU_FIXTURE_PORT ?? 43123));
  console.log(port);
}

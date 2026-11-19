export default function (pi) {
  pi.registerProvider('matrix-fixture', {
    api: 'openai-completions',
    apiKey: 'fixture',
    baseUrl: process.env.MATRIX_BASE_URL,
    models: [{
      id: 'deterministic',
      name: 'Matrix deterministic',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 1024,
    }],
  });
}

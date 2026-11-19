// Image providers that the runtime's own model catalog knows about.
//
// The runtime lists image models (`type: "image"`) per provider and generates
// with them through its model registry, resolving the provider's credential
// itself. This tool never reads, refreshes or stores those credentials; adding
// a provider means giving the runtime a credential for it, or registering one
// the way the runtime documents (an extension or models.json).
//
// The registry is the runtime's `ModelRegistry`: `ctx.modelRegistry` inside a
// session, or one built from the same agent directory for the Tools page.

/** Every provider the runtime lists image models for, with whether it can be used now. */
export async function listRuntimeProviders(registry) {
  const ids = [...new Set(registry.getModelsOfType("image").map(model => model.provider))];
  const available = new Set((await registry.getAvailableOfType("image")).map(model => model.provider));
  return ids.map(id => ({ id, label: registry.getProviderDisplayName(id), available: available.has(id) }));
}

export function hasRuntimeProvider(registry, id) {
  return registry.getModelsOfType("image", id).length > 0;
}

/** The runtime's image API takes no size setting, so these models list none. */
export function listRuntimeModels(registry, id) {
  return registry.getModelsOfType("image", id).map(model => ({ id: model.id, sizes: [] }));
}

export async function generateWithRuntime(registry, { provider, model, prompt, signal }) {
  const models = registry.getModelsOfType("image", provider);
  const label = registry.getProviderDisplayName(provider);
  const chosen = model ? models.find(entry => entry.id === model) : models[0];
  if (!chosen) throw new Error(model ? `${label} has no image model ${model}.` : `${label} lists no image models.`);
  if (!(await registry.getAvailableOfType("image", provider)).length) {
    throw new Error(`No credential for ${label}. Add one under Model providers to generate images with it.`);
  }
  const result = await registry.generateImages(chosen, { input: [{ type: "text", text: prompt }] }, signal ? { signal } : undefined);
  if (result.stopReason !== "stop") throw new Error(result.errorMessage || `Image generation with ${label} failed.`);
  const images = result.output.filter(block => block.type === "image" && typeof block.data === "string");
  if (!images.length) throw new Error("The answer contained no image.");
  return { model: chosen.id, images: images.map(image => ({ data: image.data, mime: image.mimeType ?? "image/png" })) };
}

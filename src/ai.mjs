// Optional AI help for writing a first draft. Off unless the user sets it up, and every draft it writes still has to
// pass the linter and wait for approval. Works with Anthropic, any OpenAI-compatible endpoint, and local models (Ollama).

export const AI_PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  openai: { label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  ollama: { label: "Ollama (local, no key)", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
};

export function aiConfigFromInput(input) {
  const provider = AI_PROVIDERS[input.provider] ? input.provider : "";
  if (!provider) return null;
  const d = AI_PROVIDERS[provider];
  return { provider, baseUrl: String(input.baseUrl || d.baseUrl).trim().replace(/\/+$/, ""), model: String(input.model || d.model).trim() };
}

export async function call(cfg, system, prompt, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(cfg.provider === "ollama" ? 600000 : 120000); // a local model on a CPU can take minutes
  if (cfg.provider === "anthropic") {
    const r = await fetchImpl(`${cfg.baseUrl}/v1/messages`, { method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 800, system, messages: [{ role: "user", content: prompt }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `AI request failed (${r.status})`);
    return (j.content || []).map(c => c.text || "").join("").trim();
  }
  const r = await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: "POST", signal, headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], ...(cfg.provider === "ollama" ? { reasoning_effort: "none" } : {}) }) }); // thinking models are minutes slower with thinking on
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `AI request failed (${r.status})`);
  return String(j.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// the models a local Ollama has downloaded, so the settings page can offer them instead of a typed name
export async function ollamaModels(baseUrl, fetchImpl = fetch) {
  const root = String(baseUrl || "http://localhost:11434/v1").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const r = await fetchImpl(root + "/api/tags", { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error("Ollama answered " + r.status);
  return ((await r.json()).models || []).map(m => m.name);
}

import { config } from "./config.js";

function endpoint(key) {
  const model = encodeURIComponent(config.gemini.model);
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
}

export async function generateGeminiText(prompt, options = {}) {
  const keys = config.gemini.apiKeys;
  if (!keys.length) return "";

  let lastError = null;
  for (const key of keys) {
    try {
      const response = await fetch(endpoint(key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: options.temperature ?? config.gemini.temperature,
            maxOutputTokens: options.maxOutputTokens || 900
          }
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error?.message || `Gemini request failed: ${response.status}`);
      }
      const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
      if (text) return text;
    } catch (error) {
      lastError = error;
    }
  }

  if (options.throwOnError && lastError) throw lastError;
  return "";
}

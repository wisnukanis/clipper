import { config } from "./config.js";

const failedGeminiKeys = new Set();
const failedOpenAiModels = new Set();

function endpoint(key) {
  const model = encodeURIComponent(config.gemini.model);
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, ms || 25000));
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

function outputTextFromOpenAi(data) {
  if (data?.output_text) return String(data.output_text).trim();
  const texts = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.text) texts.push(part.text);
    }
  }
  return texts.join("").trim();
}

async function generateOpenAiText(prompt, options = {}) {
  if (!config.openai.apiKey) return "";
  const models = [...new Set([options.model, ...(config.openai.models || []), config.openai.model].filter(Boolean))];
  let lastError = null;

  for (const model of models) {
    if (failedOpenAiModels.has(model)) continue;
    try {
      return await generateOpenAiTextWithModel(prompt, { ...options, model });
    } catch (error) {
      lastError = error;
      failedOpenAiModels.add(model);
      console.warn(`OpenAI model ${model} gagal, coba fallback berikutnya: ${error.message}`);
    }
  }

  if (lastError) throw lastError;
  return "";
}

async function generateOpenAiTextWithModel(prompt, options = {}) {
  const body = {
    model: options.model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }]
      }
    ],
    max_output_tokens: Math.max(16, Number(options.maxOutputTokens || 900))
  };
  if (!String(body.model).startsWith("gpt-5")) {
    body.temperature = options.temperature ?? config.openai.temperature;
  }

  const timeout = timeoutSignal(options.timeoutMs || config.openai.requestTimeoutMs);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: timeout.signal,
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }).finally(timeout.clear);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI request failed: ${response.status}`);
  }
  return outputTextFromOpenAi(data);
}

export async function generateGeminiText(prompt, options = {}) {
  const keys = config.gemini.apiKeys;
  let lastError = null;

  for (const [index, key] of keys.entries()) {
    const keyId = `${config.gemini.model}:${index}:${key.slice(-8)}`;
    if (failedGeminiKeys.has(keyId)) continue;
    try {
      const timeout = timeoutSignal(options.timeoutMs || config.gemini.requestTimeoutMs);
      const response = await fetch(endpoint(key), {
        method: "POST",
        signal: timeout.signal,
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
      }).finally(timeout.clear);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error?.message || `Gemini request failed: ${response.status}`);
      }
      const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
      if (text) return text;
    } catch (error) {
      lastError = error;
      failedGeminiKeys.add(keyId);
      console.warn(`Gemini key ${index + 1}/${keys.length} gagal, dilewati untuk sisa run: ${error.message}`);
    }
  }

  if (options.throwOnError && lastError) throw lastError;
  return "";
}

export async function generateAiText(prompt, options = {}) {
  const provider = String(options.provider || config.ai.provider || "gemini").toLowerCase();

  if (provider === "openai") {
    try {
      const text = await generateOpenAiText(prompt, options);
      if (text) return text;
    } catch (error) {
      if (options.throwOnError) throw error;
      console.warn(`OpenAI AI provider gagal, fallback ke Gemini: ${error.message}`);
    }
    return generateGeminiText(prompt, options);
  }

  const geminiText = await generateGeminiText(prompt, options);
  if (geminiText) return geminiText;

  try {
    return await generateOpenAiText(prompt, options);
  } catch (error) {
    if (options.throwOnError) throw error;
    console.warn(`Gemini AI provider gagal, fallback OpenAI juga gagal: ${error.message}`);
    return "";
  }
}

import { config } from "./config.js";

const failedOpenAiModels = new Set();
const failedGeminiKeys = new Set();

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

function outputTextFromChatCompletion(data) {
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function openAiUrl(pathname) {
  return `${config.openai.baseUrl.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

function geminiUrl(model) {
  const safeModel = encodeURIComponent(model || config.gemini.model || "gemini-flash-latest");
  return `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent`;
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
  if (config.openai.baseUrl !== "https://api.openai.com/v1") {
    return generateOpenAiChatTextWithModel(prompt, options);
  }

  try {
    return await generateOpenAiResponseTextWithModel(prompt, options);
  } catch (error) {
    if (config.openai.baseUrl === "https://api.openai.com/v1") throw error;
    const status = Number(error.status || 0);
    if (![400, 404, 405].includes(status)) throw error;
    console.warn(`OpenAI-compatible /responses tidak tersedia, coba /chat/completions: ${error.message}`);
    return generateOpenAiChatTextWithModel(prompt, options);
  }
}

function outputTextFromGemini(data) {
  const parts = [];
  for (const candidate of data?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (part?.text) parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

async function generateGeminiText(prompt, options = {}) {
  const keys = config.gemini.apiKeys || [];
  if (!keys.length) return "";
  let lastError = null;

  for (const [index, key] of keys.entries()) {
    const keyId = String(index);
    if (failedGeminiKeys.has(keyId)) continue;
    try {
      return await generateGeminiTextWithKey(prompt, { ...options, apiKey: key });
    } catch (error) {
      lastError = error;
      failedGeminiKeys.add(keyId);
      console.warn(`Gemini key#${index + 1} gagal, coba fallback berikutnya: ${error.message}`);
    }
  }

  if (lastError) throw lastError;
  return "";
}

async function generateGeminiTextWithKey(prompt, options = {}) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: options.temperature ?? config.openai.temperature,
      maxOutputTokens: Math.max(200, Number(options.maxOutputTokens || 900))
    }
  };

  const timeout = timeoutSignal(options.timeoutMs || config.openai.requestTimeoutMs);
  const response = await fetch(geminiUrl(config.gemini.model), {
    method: "POST",
    signal: timeout.signal,
    headers: {
      "Content-Type": "application/json",
      "X-goog-api-key": options.apiKey
    },
    body: JSON.stringify(body)
  }).finally(timeout.clear);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || `Gemini request failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return outputTextFromGemini(data);
}

async function generateOpenAiResponseTextWithModel(prompt, options = {}) {
  const body = {
    model: options.model,
    input: config.openai.baseUrl === "https://api.openai.com/v1"
      ? [
          {
            role: "user",
            content: [{ type: "input_text", text: prompt }]
          }
        ]
      : prompt,
    max_output_tokens: Math.max(16, Number(options.maxOutputTokens || 900))
  };
  if (!String(body.model).startsWith("gpt-5")) {
    body.temperature = options.temperature ?? config.openai.temperature;
  }

  const timeout = timeoutSignal(options.timeoutMs || config.openai.requestTimeoutMs);
  const response = await fetch(openAiUrl("responses"), {
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
    const error = new Error(data?.error?.message || `OpenAI request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return outputTextFromOpenAi(data);
}

async function generateOpenAiChatTextWithModel(prompt, options = {}) {
  const body = {
    model: options.model,
    messages: [{ role: "user", content: prompt }],
  };
  const maxTokens = Math.max(16, Number(options.maxOutputTokens || 900));
  if (String(body.model).startsWith("gpt-5")) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
    body.temperature = options.temperature ?? config.openai.temperature;
  }

  const timeout = timeoutSignal(options.timeoutMs || config.openai.requestTimeoutMs);
  const response = await fetch(openAiUrl("chat/completions"), {
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
    const error = new Error(data?.error?.message || `OpenAI chat request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return outputTextFromChatCompletion(data);
}

export async function generateAiText(prompt, options = {}) {
  const provider = String(options.provider || config.ai.provider || "auto").toLowerCase();

  if (provider === "auto" || provider === "gemini") {
    try {
      const text = await generateGeminiText(prompt, options);
      if (text) return text;
      if (options.throwOnError && provider === "gemini") {
        throw new Error("Gemini merespons tanpa teks.");
      }
    } catch (error) {
      if (options.throwOnError && provider === "gemini") throw error;
      console.warn(`Gemini AI provider gagal: ${error.message}`);
    }
  }

  if (provider === "gemini") return "";

  try {
    const text = await generateOpenAiText(prompt, options);
    if (text) return text;
    if (options.throwOnError) throw new Error("OpenAI merespons tanpa teks.");
  } catch (error) {
    if (options.throwOnError) throw error;
    console.warn(`OpenAI AI provider gagal: ${error.message}`);
  }
  return "";
}

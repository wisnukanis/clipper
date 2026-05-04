import { config } from "./config.js";

function endpoint(key) {
  const model = encodeURIComponent(config.gemini.model);
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
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

  const body = {
    model: options.model || config.openai.model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }]
      }
    ],
    max_output_tokens: options.maxOutputTokens || 900
  };
  if (!String(body.model).startsWith("gpt-5")) {
    body.temperature = options.temperature ?? config.openai.temperature;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI request failed: ${response.status}`);
  }
  return outputTextFromOpenAi(data);
}

async function generateClodText(prompt, options = {}) {
  if (!config.clod.apiKey) return "";

  const response = await fetch(`${config.clod.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.clod.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.clod.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? config.clod.temperature,
      max_completion_tokens: options.maxOutputTokens || 900
    })
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `CLōD request failed: ${response.status}`);
  }

  return String(data?.choices?.[0]?.message?.content || "").trim();
}

export async function generateGeminiText(prompt, options = {}) {
  const keys = config.gemini.apiKeys;

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

  try {
    const clodText = await generateClodText(prompt, options);
    if (clodText) return clodText;
  } catch (error) {
    lastError = error;
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
  }
  return generateGeminiText(prompt, options);
}

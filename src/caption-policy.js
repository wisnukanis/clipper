const DEFAULT_MAX_CAPTION_LENGTH = 2200;
const SOURCE_CREDIT_NOTE = "Credit: highlight dari video sumber.";

export function buildSourceCreditBlock({ sourceUrl = "", sourceTitle = "" } = {}) {
  const url = normalizeLine(sourceUrl);
  if (!url) return "";

  const title = normalizeLine(sourceTitle);
  const lines = [];
  if (title) lines.push(`Sumber lengkap: ${title}`);
  lines.push(url);
  lines.push(SOURCE_CREDIT_NOTE);
  return lines.join("\n");
}

export function ensureCaptionSourceCredit(caption, {
  sourceUrl = "",
  sourceTitle = "",
  maxLength = DEFAULT_MAX_CAPTION_LENGTH
} = {}) {
  const url = normalizeLine(sourceUrl);
  const cleaned = normalizeCaption(caption);
  if (!url) return limitText(cleaned, maxLength);

  const hasSource = cleaned.includes(url);
  const hasCredit = /(credit|kredit|terima\s+kasih|sumber)/i.test(cleaned)
    && /(highlight|clip|klip|podcast|sumber)/i.test(cleaned);
  if (hasSource && hasCredit) return limitText(cleaned, maxLength);

  const { body, hashtags } = splitTrailingHashtags(cleaned);
  const creditLines = [];
  if (!hasSource) {
    const title = normalizeLine(sourceTitle);
    if (title) creditLines.push(`Sumber lengkap: ${title}`);
    creditLines.push(url);
  }
  if (!hasCredit) {
    creditLines.push(SOURCE_CREDIT_NOTE);
  }

  return fitRequiredCaption({
    body,
    required: creditLines.join("\n"),
    hashtags,
    maxLength
  });
}

function normalizeLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCaption(value) {
  return String(value || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitTrailingHashtags(value) {
  const paragraphs = normalizeCaption(value).split(/\n{2,}/);
  const last = paragraphs[paragraphs.length - 1] || "";
  if (!last || !isHashtagOnlyParagraph(last)) {
    return { body: normalizeCaption(value), hashtags: "" };
  }
  paragraphs.pop();
  return {
    body: normalizeCaption(paragraphs.join("\n\n")),
    hashtags: normalizeCaption(last)
  };
}

function isHashtagOnlyParagraph(value) {
  const tokens = String(value || "").split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => /^#[\p{L}\p{N}_]+$/u.test(token));
}

function fitRequiredCaption({ body, required, hashtags, maxLength }) {
  const suffix = [required, hashtags].filter(Boolean).join("\n\n");
  if (!suffix) return limitText(body, maxLength);
  if (!maxLength || maxLength <= 0) return [body, suffix].filter(Boolean).join("\n\n").trim();

  const separatorLength = body ? 2 : 0;
  const bodyLimit = Math.max(0, maxLength - suffix.length - separatorLength);
  const fittedBody = limitText(body, bodyLimit);
  return [fittedBody, suffix].filter(Boolean).join("\n\n").trim().slice(0, maxLength);
}

function limitText(value, maxLength) {
  const text = normalizeCaption(value);
  if (!maxLength || text.length <= maxLength) return text;
  const clipped = text.slice(0, Math.max(0, maxLength)).trim();
  const sentenceEnd = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf("?"), clipped.lastIndexOf("!"));
  if (sentenceEnd > 40) return clipped.slice(0, sentenceEnd + 1).trim();
  return clipped.replace(/\s+\S*$/, "").trim();
}

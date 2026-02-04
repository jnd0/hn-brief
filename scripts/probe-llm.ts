import { probeLLM } from "../shared/summarizer-core";

const apiKey = process.env.CEBRAS_API_KEY;
const apiUrl = process.env.CEBRAS_API_URL || "https://api.cerebras.ai/v1/chat/completions";
const model = process.env.CEBRAS_API_MODEL || "gpt-oss-120b";
const effortRaw = (process.env.CEBRAS_REASONING_EFFORT || '').trim().toLowerCase();
const reasoningEffort = effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high'
  ? (effortRaw as 'low' | 'medium' | 'high')
  : (model.startsWith('gpt-oss-') ? 'medium' : undefined);

if (!apiKey) {
  console.error("Missing CEBRAS_API_KEY");
  process.exit(1);
}

const result = await probeLLM(
  {
    apiKey,
    apiUrl,
    model,
    provider: "cebras",
    reasoningEffort
  },
  fetch
);

if (result.ok) {
  console.log(`OK - Cebras model responded (${model})`);
  process.exit(0);
}

console.error(`FAILED - Cebras probe error (${model}): ${result.error || "unknown"}`);
process.exit(2);

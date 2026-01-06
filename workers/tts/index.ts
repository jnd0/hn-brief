/// <reference types="@cloudflare/workers-types" />
import { Buffer } from 'node:buffer';

// ============================================================================
// TTS Worker - Generates speech from daily digest using Gemini TTS
// ============================================================================

interface Env {
    GEMINI_API_KEY: string;
    TTS_AUDIO: R2Bucket;
    SITE_ORIGIN: string; // e.g., "https://hn-brief.com"
}

const GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent";
const TTS_VOICE = "Charon"; // Informative, trustworthy voice for news digest

const HN_PROMPT = `
# AUDIO PROFILE: The HN Veteran
## "The Daily Brief"

### PERSONA
You are a senior staff engineer with 20 years of experience. You are reading a technical digest to your peers.
You are knowledgeable, precise, and slightly cynical but deeply interested in technology.
You pronounce technical acronyms correctly (e.g., SQL as "Sequel", GUI as "Gooey", SaaS as "Sass", LLM as "L-L-M").

### STYLE
* Tone: Professional but conversational among geeks. Intelligent, sharp.
* Pace: Efficient. We value our time.
* Dynamics: Clear articulation of technical terms.

### INSTRUCTION
Read the following text segment VERBATIM.
CRITICAL: Do not add intros, outros, greetings, or "signing off". Just read the text provided.
`;

// ============================================================================
// Worker Handlers
// ============================================================================

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === "OPTIONS") {
            return handleCors(env);
        }

        // Route: GET /tts/:date
        const match = url.pathname.match(/^\/tts\/(\d{4}-\d{2}-\d{2})$/);
        if (!match) {
            return corsResponse(new Response("Not found", { status: 404 }), env);
        }

        const date = match[1] as string;

        try {
            const audio = await getOrGenerateAudio(date, env);
            return corsResponse(new Response(audio, {
                headers: {
                    "Content-Type": "audio/mpeg",
                    "Cache-Control": "public, max-age=31536000", // 1 year (content-addressed)
                }
            }), env);
        } catch (error) {
            console.error("TTS error:", error);
            return corsResponse(new Response(
                JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            ), env);
        }
    }
};

// ============================================================================
// Core TTS Logic
// ============================================================================

async function getOrGenerateAudio(date: string, env: Env): Promise<Uint8Array | ArrayBuffer> {
    // 1. Fetch digest markdown
    const digestText = await fetchDigestText(date, env);
    if (!digestText) {
        throw new Error(`No digest found for ${date}`);
    }

    // 2. Compute content hash for cache key
    const contentHash = await hashContent(digestText);
    const cacheKey = `audio/${date}-${contentHash.slice(0, 8)}.mp3`;

    // 3. Check R2 cache
    const cached = await env.TTS_AUDIO.get(cacheKey);
    if (cached) {
        console.log(`Cache hit: ${cacheKey}`);
        return await cached.arrayBuffer();
    }

    console.log(`Cache miss: ${cacheKey} - generating audio`);

    // 4. Strip markdown formatting for cleaner speech
    const cleanText = stripMarkdown(digestText);

    // 5. Generate audio via Gemini TTS (MP3) - Parallelized
    const chunks = splitTextForTTS(cleanText);
    console.log(`Split digest into ${chunks.length} chunks for faster generation`);

    // Execute in parallel (limited if needed, but for < 10 chunks Promise.all is fine)
    const audioBuffers = await Promise.all(chunks.map((chunk, i) =>
        generateSpeech(chunk, env, i)
            .catch(err => {
                console.error(`Failed to generate chunk ${i}:`, err);
                throw err;
            })
    ));

    // Concatenate MP3 buffers
    const totalLength = audioBuffers.reduce((acc, buf) => acc + buf.length, 0);
    const combinedBuffer = new Uint8Array(totalLength);

    let offset = 0;
    for (const buf of audioBuffers) {
        combinedBuffer.set(buf, offset);
        offset += buf.length;
    }

    const mp3Data = combinedBuffer;

    // (WAV conversion removed)

    // 7. Store in R2
    await env.TTS_AUDIO.put(cacheKey, mp3Data);
    console.log(`Cached: ${cacheKey}`);

    return mp3Data;
}

async function fetchDigestText(date: string, env: Env): Promise<string | null> {
    const [year, month, day] = date.split("-");
    const digestUrl = `${env.SITE_ORIGIN}/summaries/${year}/${month}/${day}-digest.md`;

    const res = await fetch(digestUrl);
    if (!res.ok) return null;

    return await res.text();
}

async function hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function stripMarkdown(text: string): string {
    return text
        // Remove markdown header markers
        .replace(/^#{1,6}\s+/gm, "")
        // Remove bold/italic markers
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        // Remove links, keep text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        // Remove inline code
        .replace(/`([^`]+)`/g, "$1")
        // Remove horizontal rules
        .replace(/^---+$/gm, "")
        // Clean up extra whitespace
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// Split text into safe chunks for TTS (< 2000 chars, split at paragraph)
function splitTextForTTS(text: string, limit = 1500): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    // Split by paragraphs first
    const paragraphs = text.split(/\n\n+/);

    for (const para of paragraphs) {
        if ((currentChunk.length + para.length + 2) > limit) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = para;
        } else {
            currentChunk += (currentChunk ? "\n\n" : "") + para;
        }
    }

    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

// ============================================================================
// Gemini TTS API
// ============================================================================

async function generateSpeech(text: string, env: Env, chunkIndex?: number): Promise<Uint8Array> {
    const response = await fetch(GEMINI_TTS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: `${HN_PROMPT}\n\n${text}` }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: TTS_VOICE
                        }
                    }
                }
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini TTS failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
        candidates: Array<{
            content: {
                parts: Array<{
                    inlineData: { data: string; mimeType: string }
                }>
            }
        }>
    };

    const audioBase64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const mimeType = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType;
    console.log(`Gemini chunk mimeType: ${mimeType}`);

    if (!audioBase64) {
        throw new Error("No audio data in Gemini response");
    }

    // Decode Base64 to binary
    return Buffer.from(audioBase64, 'base64');
}

// ============================================================================
// CORS Helpers
// ============================================================================

function handleCors(env: Env): Response {
    return new Response(null, {
        headers: {
            "Access-Control-Allow-Origin": env.SITE_ORIGIN,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        }
    });
}

function corsResponse(response: Response, env: Env): Response {
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", env.SITE_ORIGIN);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

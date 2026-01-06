/// <reference types="@cloudflare/workers-types" />

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
                    "Content-Type": "audio/wav",
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

async function getOrGenerateAudio(date: string, env: Env): Promise<ArrayBuffer> {
    // 1. Fetch digest markdown
    const digestText = await fetchDigestText(date, env);
    if (!digestText) {
        throw new Error(`No digest found for ${date}`);
    }

    // 2. Compute content hash for cache key
    const contentHash = await hashContent(digestText);
    const cacheKey = `audio/${date}-${contentHash.slice(0, 8)}.wav`;

    // 3. Check R2 cache
    const cached = await env.TTS_AUDIO.get(cacheKey);
    if (cached) {
        console.log(`Cache hit: ${cacheKey}`);
        return await cached.arrayBuffer();
    }

    console.log(`Cache miss: ${cacheKey} - generating audio`);

    // 4. Strip markdown formatting for cleaner speech
    const cleanText = stripMarkdown(digestText);

    // 5. Generate audio via Gemini TTS
    const pcmData = await generateSpeech(cleanText, env);

    // 6. Convert PCM to WAV
    const wavData = pcmToWav(pcmData, 24000, 1, 16);

    // 7. Store in R2
    await env.TTS_AUDIO.put(cacheKey, wavData);
    console.log(`Cached: ${cacheKey}`);

    return wavData;
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

// ============================================================================
// Gemini TTS API
// ============================================================================

async function generateSpeech(text: string, env: Env): Promise<Uint8Array> {
    const response = await fetch(GEMINI_TTS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: `Read this news digest in an informative, clear tone:\n\n${text}` }]
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
    if (!audioBase64) {
        throw new Error("No audio data in Gemini response");
    }

    // Decode Base64 to binary
    const binaryString = atob(audioBase64);
    const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));

    return bytes;
}

// ============================================================================
// PCM to WAV Conversion
// ============================================================================

function pcmToWav(pcmData: Uint8Array, sampleRate: number, numChannels: number, bitsPerSample: number): ArrayBuffer {
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmData.length;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    // RIFF header
    writeString(view, 0, "RIFF");
    view.setUint32(4, totalSize - 8, true);
    writeString(view, 8, "WAVE");

    // fmt subchunk
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 = PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data subchunk
    writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);

    // PCM data
    const dataView = new Uint8Array(buffer, headerSize);
    dataView.set(pcmData);

    return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
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

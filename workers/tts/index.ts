/// <reference types="@cloudflare/workers-types" />

// ============================================================================
// TTS Worker - Generates speech from daily digest using Google Cloud TTS
// ============================================================================

interface Env {
    GOOGLE_CLOUD_API_KEY: string;
    TTS_AUDIO: R2Bucket;
    SITE_ORIGIN: string; // e.g., "https://hn-brief.com"
}


const GOOGLE_TTS_API_URL = "https://texttospeech.googleapis.com/v1beta1/text:synthesize";
const TTS_VOICE_NAME = "en-GB-Neural2-A";
const TTS_LANGUAGE_CODE = "en-GB";

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

    // 4. Clean text & optimization strategy
    // We pass raw markdown to splitter now, so we can convert to SSML per chunk.
    // However, splitting raw markdown is tricky if we split inside a tag.
    // Given the simple structure of the digest, we can split by paragraphs/sentences first.
    // Ideally, we strip complex links but keep basic formatting.
    // For safety, let's keep it simple: split the text first, THEN convert each chunk to SSML.
    // This risks enforcing a closing tag on a split boundary, but our regex-based converter
    // is stateless per chunk, so bold/italic crossing chunks might fail (render as plain text).
    // This is acceptable for now.

    // We do need to remove pure layout artifacts (like excessive "---") before splitting.
    const cleanText = prepareTextForTts(digestText);

    // 5. Chunking Strategy: ~500 chars, sentence-aligned.
    const CHUNK_SIZE_TARGET = 500;
    const chunks = splitTextForTTS(cleanText, CHUNK_SIZE_TARGET);
    console.log(`Split digest into ${chunks.length} chunks (target ~${CHUNK_SIZE_TARGET} chars). Execution strategy: Parallel Batches.`);

    // 6. Execution Strategy: Parallel Batches
    const BATCH_SIZE = 5;
    let audioBuffers: Uint8Array[] = new Array(chunks.length);

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, chunks.length);
        const batchIndices = Array.from({ length: batchEnd - i }, (_, k) => i + k);

        console.log(`Executing batch ${Math.ceil((i + 1) / BATCH_SIZE)}: Chunks ${i + 1}-${batchEnd}...`);

        await Promise.all(batchIndices.map(async (index) => {
            try {
                const chunk = chunks[index]!;
                // Convert chunk to SSML
                const ssmlChunk = markdownToSsml(chunk);
                const audio = await generateSpeech(ssmlChunk, env);
                audioBuffers[index] = audio;
            } catch (err) {
                console.error(`Failed to generate chunk ${index}:`, err);
                throw err;
            }
        }));
    }

    // 7. Concatenate MP3 buffers
    const totalLength = audioBuffers.reduce((acc, buf) => acc + buf.length, 0);
    const combinedBuffer = new Uint8Array(totalLength);

    let offset = 0;
    for (const buf of audioBuffers) {
        combinedBuffer.set(buf, offset);
        offset += buf.length;
    }

    // 8. Store in R2
    await env.TTS_AUDIO.put(cacheKey, combinedBuffer);
    console.log(`Cached: ${cacheKey} (Size: ${totalLength} bytes)`);

    return combinedBuffer;
}

// ============================================================================
// Google Cloud TTS API (Chirp 3 + SSML)
// ============================================================================

async function generateSpeech(ssmlChunk: string, env: Env): Promise<Uint8Array> {
    const url = `${GOOGLE_TTS_API_URL}?key=${env.GOOGLE_CLOUD_API_KEY}`;

    // Wrap the chunk in <speak> tags. The chunk itself is already safe SSML.
    const ssml = `<speak>${ssmlChunk}</speak>`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            input: { ssml: ssml },
            voice: {
                languageCode: TTS_LANGUAGE_CODE,
                name: TTS_VOICE_NAME
            },
            audioConfig: {
                audioEncoding: "MP3",
                speakingRate: 0.95,
                pitch: 0.0
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud TTS failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as { audioContent: string };

    if (!data.audioContent) {
        throw new Error("No audio content in Cloud TTS response");
    }

    return Buffer.from(data.audioContent, 'base64');
}

// ============================================================================
// Text Processing Helpers
// ============================================================================

function splitTextForTTS(text: string, limit = 500): string[] {
    const chunks: string[] = [];

    // Level 1: Split by newlines (Paragraphs, Headers, List items)
    // We treat each line as a primary atomic unit to preserve structure.
    const lines = text.split(/\n+/);

    let currentChunk = "";

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check if adding this line fits in the current chunk
        // (Add 1 for the newline separator we'd intuitively add between lines)
        if (currentChunk.length + trimmed.length + 1 <= limit) {
            currentChunk += (currentChunk ? "\n" : "") + trimmed;
        } else {
            // Case A: Current chunk has content. Push it and start fresh.
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = "";
            }

            // Case B: Check if the line strictly fits in an empty chunk
            if (trimmed.length <= limit) {
                currentChunk = trimmed;
            } else {
                // Level 2: Line itself is massive (larger than limit).
                // We MUST split this specific line by sentences to fit.
                // Match sentences ending in punctuation or end of string.
                const sentences = trimmed.match(/[^.!?]+[.!?]+(\s+|$)/g) || [trimmed];

                for (const sentence of sentences) {
                    if (currentChunk.length + sentence.length <= limit) {
                        currentChunk += sentence;
                    } else {
                        if (currentChunk) chunks.push(currentChunk.trim());
                        currentChunk = sentence;
                    }
                }
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
}

// Minimal sanitization before splitting
function prepareTextForTts(text: string): string {
    return text
        // Remove code blocks content? No, just the backticks usually.
        // Better to let markdownToSsml handle `code` as distinct text.
        // Remove horizontal rules
        .replace(/^---+$/gm, "")
        // Remove images
        .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
        // Remove links, keep text [text](url) -> text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        // Compress newlines
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Converts basic Markdown to SSML.
 * Handles:
 * - Special XML char escaping (MUST be first)
 * - **Bold** -> <emphasis level="strong">
 * - *Italic* -> <emphasis level="moderate">
 * - Headers (#) -> <break time="1s"/>
 * - Lists (-) -> <break time="500ms"/>
 */
function markdownToSsml(text: string): string {
    // 1. Escape XML characters first!
    let ssml = text.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });

    // 2. Convert Headers to pauses (Header 1-6)
    // Matches escaped "#" which resulted from text replacement?
    // No, # is safe char.
    // Pattern: Start of line, #+, space, content.
    // We add a break BEFORE the header content.
    ssml = ssml.replace(/^(#+)\s+(.+)$/gm, '<break time="600ms"/>$2<break time="300ms"/>');

    // 3. Convert Lists to pauses
    ssml = ssml.replace(/^[-*]\s+(.+)$/gm, '<break time="300ms"/>$1');

    // 4. Bold: **text** or __text__
    // Note: We use non-greedy matching.
    ssml = ssml.replace(/\*\*([^*]+)\*\*/g, '<emphasis level="strong">$1</emphasis>');
    ssml = ssml.replace(/__([^_]+)__/g, '<emphasis level="strong">$1</emphasis>');

    // 5. Italic: *text* or _text_
    ssml = ssml.replace(/\*([^*]+)\*/g, '<emphasis level="moderate">$1</emphasis>');
    ssml = ssml.replace(/_([^_]+)_/g, '<emphasis level="moderate">$1</emphasis>');

    // 6. Monospace `code` -> slightly reduced pitch/rate? Or just plain.
    // Let's mark it as moderate emphasis for clarity.
    ssml = ssml.replace(/`([^`]+)`/g, '<emphasis level="moderate">$1</emphasis>');

    // 7. Technical Acronyms (Spell-out)
    // We want these to be read as characters "A-I", "A-P-I"
    const acronyms = [
        "AI", "API", "LLM", "AGI", "ML", "NLP", "RAG", // AI
        "CPU", "GPU", "TPU", "NPU", "RAM", "ROM", "SSD", "HDD", "USB", // Hardware
        "AWS", "GCP", "AZURE", "S3", "EC2", "RDS", "VPC", "IAM", "K8S", "VM", // Cloud/Infra
        "HTML", "CSS", "JS", "TS", "JSX", "TSX", "SQL", "NOSQL", "JSON", "XML", "YAML", "CSV", // Langs/Formats
        "HTTP", "HTTPS", "TCP", "UDP", "IP", "DNS", "DHCP", "VPN", "SSH", "SSL", "TLS", "FTP", "SMTP", // Network
        "REST", "GRAPHQL", "RPC", "GRPC", "JWT", "OAUTH", "SSO", // API/Auth
        "CI", "CD", "IDE", "SDK", "CLI", "GUI", "OS", "IOS", "MACOS", "LINUX", // Dev
        "CEO", "CTO", "CFO", "COO", "CMO", "CPO", "VP", "SVP", "EVP", "GM", "PM", // Roles
        "IPO", "VC", "PE", "ARR", "MRR", "ROI", "KPI", "OKR", "DAU", "MAU", "YOY", "MOM", "QOQ", // Business
        "MVP", "POC", "SaaS", "PaaS", "IaaS", "B2B", "B2C", "D2C", // Models
        "UX", "UI", "CX", "QA", "SRE" // Disciplines
    ];
    // Regex boundary to ensure we only match whole words
    // Use a single regex for performance: \b(AI|API|...)\b
    const acronymRegex = new RegExp(`\\b(${acronyms.join("|")})\\b`, 'g');

    ssml = ssml.replace(acronymRegex, '<say-as interpret-as="characters">$1</say-as>');

    return ssml;
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

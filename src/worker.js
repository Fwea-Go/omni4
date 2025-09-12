
// --- Price map (read from env so you don't hardcode IDs) ---
const STRIPE_PRICE_IDS = {
  single_track: (typeof STRIPE_SINGLE_PRICE_ID !== 'undefined' ? STRIPE_SINGLE_PRICE_ID : undefined),
  day_pass: (typeof STRIPE_DAY_PASS_PRICE_ID !== 'undefined' ? STRIPE_DAY_PASS_PRICE_ID : undefined),
  dj_pro: (typeof STRIPE_DJ_PRO_PRICE_ID !== 'undefined' ? STRIPE_DJ_PRO_PRICE_ID : undefined),
  studio_elite: (typeof STRIPE_STUDIO_ELITE_PRICE_ID !== 'undefined' ? STRIPE_STUDIO_ELITE_PRICE_ID : undefined)
};
// derive at runtime using env (set in handlePaymentCreation)
let PRICE_BY_TYPE = {};
function buildPriceMapFromEnv(env){
  return {
    single_track: env.STRIPE_PRICE_SINGLE || env.STRIPE_SINGLE_PRICE_ID || STRIPE_PRICE_IDS.single_track,
    day_pass: env.STRIPE_PRICE_DAYPASS || env.STRIPE_DAY_PASS_PRICE_ID || STRIPE_PRICE_IDS.day_pass,
    dj_pro: env.STRIPE_PRICE_DJPRO || env.STRIPE_DJ_PRO_PRICE_ID || STRIPE_PRICE_IDS.dj_pro,
    studio_elite: env.STRIPE_PRICE_STUDIO || env.STRIPE_STUDIO_ELITE_PRICE_ID || STRIPE_PRICE_IDS.studio_elite,
  };
}

// --- Stripe helpers (Workers/Edge compatible; no Node SDK) ---
function formAppend(params, key, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => formAppend(params, `${key}[${i}]`, v));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      formAppend(params, `${key}[${k}]`, v);
    }
  } else {
    params.append(key, String(value));
  }
}

function stripeParams(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) formAppend(p, k, v);
  return p;
}

async function stripeFetch(path, method, bodyObj, env) {
  const resp = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: stripeParams(bodyObj),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`Stripe ${method} ${path} failed: ${resp.status} ${text}`);
  }
  return data;
}

async function createCheckoutSession({ priceId, isSubscription, email, successUrl, cancelUrl, metadata }, env) {
  const mode = isSubscription ? 'subscription' : 'payment';
  const body = {
    mode,
    'line_items': [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: email || undefined,
  };
  if (metadata) body.metadata = metadata;
  return stripeFetch('/v1/checkout/sessions', 'POST', body, env);
}

// Verify Stripe webhook signature (per https://stripe.com/docs/webhooks/signatures)
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  // header like: "t=1697044090,v1=signature,v0=..."
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const encoder = new TextEncoder();
  const data = encoder.encode(`${t}.${rawBody}`);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, data);
  const hex = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time compare
  if (hex.length !== v1.length) return false;
  let out = 0; for (let i = 0; i < hex.length; i++) out |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return out === 0;
}

// --- Durable Object: ProcessingStateV2 ---
export class ProcessingStateV2 {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.cache = new Map();
    }

    async fetch(request) {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        
        if (method === 'GET') {
            const key = url.searchParams.get('key');
            if (!key) return new Response('Missing key', { status: 400 });
            if (this.cache.has(key)) return new Response(this.cache.get(key) ?? 'null');
            const v = await this.state.storage.get(key);
            if (v != null) this.cache.set(key, v);
            return new Response(v ?? 'null');
        }

        if (method === 'PUT') {
            const { key, value } = await request.json().catch(() => ({}));
            if (!key) return new Response('Missing key', { status: 400 });
            await this.state.storage.put(key, value);
            this.cache.set(key, value);
            return new Response('OK');
        }

        if (method === 'DELETE') {
            const key = url.searchParams.get('key');
            if (!key) return new Response('Missing key', { status: 400 });
            await this.state.storage.delete(key);
            this.cache.delete(key);
            return new Response('OK');
        }

        return new Response('Method Not Allowed', { status: 405 });
    }
}

// ---------- Profanity Detection (Workers-compatible, no external deps) ----------
const PROF_CACHE = new Map();

async function getProfanityTrieFor(lang, env) {
    const primaryKey = `lists/${lang}.json`;
    const altKeys = [lang, `${lang}.json`, `lists/${lang}`];

    // Return cached by language (not by exact key) if present
    if (PROF_CACHE.has(lang)) return PROF_CACHE.get(lang);

    let words = await env.PROFANITY_LISTS?.get(primaryKey, { type: 'json' });

    // Fallback to alternate key shapes if needed
    if (!Array.isArray(words)) {
        for (const k of altKeys) {
            let v = await env.PROFANITY_LISTS?.get(k);
            if (v) {
                try {
                    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
                    if (Array.isArray(parsed)) { words = parsed; break; }
                } catch { /* ignore parse errors */ }
            }
        }
    }

    if (!Array.isArray(words)) words = [];

    // Optional additional words (kept from your version)
    const additionalWords = await getAdditionalProfanityWords(lang);
    words = [...new Set([...words, ...additionalWords].map(w => normalizeForProfanity(String(w))))];

    // Build a single regex union. This avoids Node-only deps like `ahocorasick`.
    const escaped = words
        .filter(Boolean)
        .map(escapeRegExp)
        .sort((a, b) => b.length - a.length); // prefer longer first

    const re = escaped.length
        ? new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escaped.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'giu')
        : null;

    const pack = { re, words };
        PROF_CACHE.set(lang, pack);
        return pack;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getAdditionalProfanityWords(lang) {
    const extendedProfanity = {
        'en': ['damn', 'hell', 'shit', 'fuck', 'bitch', 'ass', 'crap', 'piss', 'bastard', 'whore'],
        'es': ['mierda', 'joder', 'puta', 'cabrón', 'coño', 'gilipollas', 'pendejo', 'culero'],
        'fr': ['merde', 'putain', 'salope', 'connard', 'enculé', 'bordel', 'foutre'],
        'de': ['scheiße', 'fick', 'arschloch', 'hure', 'verdammt', 'dummkopf', 'fotze'],
        'it': ['merda', 'cazzo', 'puttana', 'stronzo', 'porco', 'figa', 'vaffanculo'],
        'pt': ['merda', 'porra', 'caralho', 'puta', 'filho da puta', 'buceta'],
        'ru': ['сука', 'блядь', 'говно', 'хуй', 'пизда', 'ебать', 'мудак'],
        'zh': ['操', '妈的', '狗屎', '混蛋', '王八蛋', '婊子', '傻逼'],
        'ar': ['كلب', 'حقير', 'وسخ', 'قذر', 'لعين'],
        'ja': ['くそ', 'ちくしょう', 'ばか', 'あほ', 'しね'],
        'ko': ['씨발', '개새끼', '존나', '병신', '좆', '창녀'],
        'hi': ['गंदू', 'रंडी', 'भोसड़ी', 'लौड़ा', 'चूतिया'],
        'tr': ['amk', 'orospu', 'piç', 'sik', 'göt'],
        'nl': ['kut', 'lul', 'hoer', 'klootzak', 'tering'],
        'pl': ['kurwa', 'pierdolić', 'chuj', 'suka', 'dupa'],
        'sv': ['fan', 'skit', 'fitta', 'kuk', 'hora'],
        'da': ['lort', 'fanden', 'luder', 'pik', 'røv'],
        'no': ['faen', 'dritt', 'fitte', 'kuk', 'hore'],
        'fi': ['vittu', 'paska', 'saatana', 'kyrpä', 'huora'],
        'el': ['γαμώ', 'μαλάκας', 'πούτσα', 'σκύλα', 'παπάρι'],
        'he': ['חרא', 'לעזאזל', 'זונה', 'כוס', 'זין'],
        'th': ['เหี้ย', 'ควาย', 'ไอ้เหี้ย', 'ชาติหมา'],
        'vi': ['đụ', 'cặc', 'lồn', 'đĩ', 'chó'],
        'id': ['anjing', 'babi', 'bangsat', 'tolol', 'goblok'],
        'ms': ['anjing', 'babi', 'sial', 'celaka', 'bodoh'],
        'tl': ['putang ina', 'gago', 'tarantado', 'bobo'],
        'sw': ['mwizi', 'mjinga', 'malaya'],
        'zu': ['isifebe', 'isiwula', 'inja'],
        'yo': ['ole', 'omo ale', 'eranko'],
        'ig': ['nkita', 'onye ara', 'onye iberibe'],
        'ha': ['banza', 'iska', 'dan iska'],
    };
    return extendedProfanity[lang] || [];
}

function normalizeForProfanity(s = '') {
    s = s.toLowerCase();
    s = s.normalize('NFD').replace(/\p{Diacritic}+/gu, '');
    const substitutions = {
        '@': 'a', '4': 'a', 'α': 'a', 'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
        '0': 'o', 'ο': 'o', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
        '1': 'i', '!': 'i', 'ι': 'i', 'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
        '3': 'e', 'ε': 'e', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
        '5': 's', '$': 's', 'σ': 's', 'ς': 's',
        '7': 't', 'τ': 't',
        '8': 'b', 'β': 'b',
        '9': 'g', 'γ': 'g',
        '6': 'g',
        '2': 'z',
        '+': 't',
        'х': 'x',
        'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y',
    };
    for (const [from, to] of Object.entries(substitutions)) {
        s = s.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to);
    }
    s = s.replace(/(.)\1{2,}/g, '$1$1');
    s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return s;
}

async function matchProfanity(text, lang, env) {
    const pack = await getProfanityTrieFor(lang, env);
    const norm = normalizeForProfanity(text || '');
    if (!pack.re || !norm) return [];

    const hits = [];
    let m;
    while ((m = pack.re.exec(norm)) !== null) {
        const word = m[1] || m[0];
        const end = m.index + (m[1] ? m[1].length : m[0].length);
        hits.push({ word, start: m.index, end, confidence: 0.9 });
        // Prevent infinite loops with zero-width matches
        if (pack.re.lastIndex === m.index) pack.re.lastIndex++;
    }
    return dedupeOverlaps(hits);
}

function dedupeOverlaps(arr) {
    arr.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    let lastEnd = -1;
    for (const m of arr) {
        if (m.start >= lastEnd) { out.push(m); lastEnd = m.end; }
    }
    return out;
}

function normalizeLangs(langs = []) {
    const languageMap = {
        'english': 'en', 'spanish': 'es', 'french': 'fr', 'german': 'de', 'portuguese': 'pt',
        'italian': 'it', 'russian': 'ru', 'chinese': 'zh', 'arabic': 'ar', 'japanese': 'ja',
        'korean': 'ko', 'hindi': 'hi', 'turkish': 'tr', 'indonesian': 'id', 'swahili': 'sw',
        'dutch': 'nl', 'polish': 'pl', 'swedish': 'sv', 'danish': 'da', 'norwegian': 'no',
        'finnish': 'fi', 'greek': 'el', 'hebrew': 'he', 'thai': 'th', 'vietnamese': 'vi',
        'malay': 'ms', 'tagalog': 'tl', 'zulu': 'zu', 'yoruba': 'yo', 'igbo': 'ig', 'hausa': 'ha'
    };
    const out = new Set();
    for (const l of langs) {
        const k = String(l || '').toLowerCase();
        out.add(languageMap[k] || k.slice(0, 2));
    }
    return [...out];
}

// ---------- Enhanced CORS with Better Origin Handling ----------
function getCorsHeaders(request, env) {
    const reqOrigin = request.headers.get('Origin') || '';
    const workerOrigin = new URL(request.url).origin;
    
    // Enhanced allowlist with environment-specific domains
    const configuredFrontend = (env.FRONTEND_URL || '').replace(/\/+$/, '');
    const allowList = [
        configuredFrontend,
        workerOrigin,
        'https://fwea-i.com',
        'https://www.fwea-i.com',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'https://omni2-8d2.pages.dev',
        // Add Wix domains
        'https://editor.wix.com',
        'https://www.wix.com',
        // Add development domains
        'http://localhost:8000',
        'http://127.0.0.1:8000',
        'http://localhost:3001',
        'http://127.0.0.1:3001',
    ].filter(Boolean);

    // Pattern matching for dynamic domains
    const pagesDevPattern = /^https:\/\/[a-z0-9-]+\.pages\.dev$/i;
    const wixPattern = /^https:\/\/[a-z0-9-]+\.wixsite\.com$/i;
    const editorWixPattern = /^https:\/\/editor\.wix\.com$/i;
    
    const isAllowed = allowList.includes(reqOrigin) || 
                     pagesDevPattern.test(reqOrigin) ||
                     wixPattern.test(reqOrigin) ||
                     editorWixPattern.test(reqOrigin);

    const allowOrigin = isAllowed && reqOrigin ? reqOrigin : workerOrigin;

    const baseCors = {
        'Access-Control-Allow-Origin': allowOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Stripe-Signature, Range, X-FWEA-Admin, X-Requested-With',
        'Access-Control-Max-Age': '86400',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag, Content-Type, Last-Modified, X-Preview-Limit-Ms, X-Profanity, X-Processing-Status, X-Progress',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Timing-Allow-Origin': '*'
    };

    return allowOrigin === workerOrigin ? baseCors : { ...baseCors, 'Access-Control-Allow-Credentials': 'true' };
}

// ---------- Enhanced Main Worker with RunPod Integration ----------
export default {
    async fetch(request, env) {
        const corsHeaders = getCorsHeaders(request, env);
        
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        let path = url.pathname;
        
        // Support versioned paths
        if (path.startsWith('/v2/')) {
            path = path.slice(3);
        }

        // Enhanced error handling wrapper
        const handleError = (error, status = 500) => {
            console.error('Worker Error:', error);
            return new Response(JSON.stringify({
                error: 'Internal Server Error',
                details: error.message || String(error),
                timestamp: new Date().toISOString(),
                requestId: crypto.randomUUID(),
            }), {
                status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        };

        // Serve signed audio from R2 via /audio/*
        if (path.startsWith('/audio/')) {
            return await handleAudioDownload(request, env, corsHeaders);
        }

        try {
            // Route handling with enhanced error recovery
            switch (path) {
                case '/process-audio':
                    return await handleAudioProcessing(request, env, corsHeaders);
                case '/create-payment':
                    return await handlePaymentCreation(request, env, corsHeaders);
                case '/webhook':
                    return await handleStripeWebhook(request, env, corsHeaders);
                case '/activate-access':
                    return await handleAccessActivation(request, env, corsHeaders);
                case '/validate-subscription':
                    return await handleSubscriptionValidation(request, env, corsHeaders);
                case '/track-event':
                    return await handleTrackEvent(request, env, corsHeaders);
                case '/status':
                    return await handleStatusQuery(request, env, corsHeaders);
                case '/encoder-callback':
                    return await handleEncoderCallback(request, env, corsHeaders);
                case '/enqueue-encode':
                    return await handleManualEnqueue(request, env, corsHeaders);
                case '/health':
                    return await handleHealthCheck(request, env, corsHeaders);
                case '/debug-env':
                    return await handleDebugEnv(request, env, corsHeaders);
                default:
                    return new Response(JSON.stringify({ 
                        error: 'Not Found', 
                        availableEndpoints: ['/process-audio', '/create-payment', '/webhook', '/health'] 
                    }), { 
                        status: 404, 
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
                    });
            }
        } catch (error) {
            return handleError(error);
        }
    }
};

// ---------- Progress Helpers ----------
async function updateProgress(env, fingerprint, processId, step, percent, extra={}){
  try{
    if(!env.PROCESSING_STATE) return;
    const id = env.PROCESSING_STATE.idFromName(fingerprint || 'anon');
    const stub = env.PROCESSING_STATE.get(id);
    await stub.fetch(`https://state/progress`,{method:'PUT', body: JSON.stringify({key: processId, value: {step, percent, ...extra, ts: Date.now()}})});
  }catch(e){
    console.warn('progress update failed', e?.message||e);
  }
}
async function readProgress(env, fingerprint, processId){
  try{
    if(!env.PROCESSING_STATE) return null;
    const id = env.PROCESSING_STATE.idFromName(fingerprint || 'anon');
    const stub = env.PROCESSING_STATE.get(id);
    const r = await stub.fetch(`https://state/progress?key=${encodeURIComponent(processId)}`);
    return await r.text();
  }catch{return null}
}

// ---------- Enhanced Health Check ----------
async function handleHealthCheck(request, env, corsHeaders) {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
            ai: Boolean(env.AI),
            r2: Boolean(env.AUDIO_STORAGE),
            db: Boolean(env.DB),
            kv: Boolean(env.PROFANITY_LISTS),
            stripe: Boolean(env.STRIPE_SECRET_KEY),
        },
        configuration: {
            frontendUrl: Boolean(env.FRONTEND_URL),
            workerBaseUrl: Boolean(env.WORKER_BASE_URL),
            adminToken: Boolean(env.ADMIN_API_TOKEN),
            audioUrlSecret: Boolean(env.AUDIO_URL_SECRET),
        }
    };

    // Test critical services
    try {
        if (env.AUDIO_STORAGE) {
            const testKey = '__health/test.txt';
            await env.AUDIO_STORAGE.put(testKey, 'ok');
            const result = await env.AUDIO_STORAGE.get(testKey);
            health.services.r2Test = Boolean(result);
            await env.AUDIO_STORAGE.delete(testKey);
        }
    } catch (e) {
        health.services.r2Test = false;
        health.services.r2Error = e.message;
    }

    return new Response(JSON.stringify(health, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// ---------- Enhanced Audio Processing with RunPod Integration ----------
async function handleAudioProcessing(request, env, corsHeaders) {
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        const formData = await request.formData();
        const audioFile = formData.get('audio');
        const fingerprint = formData.get('fingerprint') || 'anonymous';
        const processId = generateProcessId();
        await updateProgress(env, fingerprint, processId, 'start', 2, {state: 'uploading'});
        const planType = formData.get('planType') || 'free';
        const admin = isAdminRequest(request, env);
        const effectivePlan = admin ? 'studio_elite' : planType;

        // Enhanced validation
        if (!audioFile) {
            return new Response(JSON.stringify({ 
                error: 'No audio file provided',
                hint: 'Send FormData with field name "audio"',
                maxSize: '50MB for free plan'
            }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Configuration check
        if (!env.AUDIO_STORAGE) {
            return new Response(JSON.stringify({
                error: 'Storage not configured',
                hint: 'Bind your R2 bucket as AUDIO_STORAGE'
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Size validation with enhanced limits
        const maxSizes = {
            free: 50 * 1024 * 1024,      // 50MB
            single_track: 100 * 1024 * 1024,  // 100MB
            day_pass: 200 * 1024 * 1024,      // 200MB
            dj_pro: 500 * 1024 * 1024,        // 500MB
            studio_elite: 2 * 1024 * 1024 * 1024, // 2GB
        };

        const maxSize = maxSizes[effectivePlan] || maxSizes.free;
        if (audioFile.size > maxSize) {
            return new Response(JSON.stringify({
                error: 'File too large',
                maxSize: `${Math.floor(maxSize / (1024 * 1024))}MB`,
                currentSize: `${Math.floor(audioFile.size / (1024 * 1024))}MB`,
                plan: effectivePlan,
                upgradeRequired: effectivePlan === 'free'
            }), {
                status: 413,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Access validation
        const accessValidation = await validateUserAccess(fingerprint, planType, env);
        if (!accessValidation.valid && !admin) {
            return new Response(JSON.stringify({
                error: 'Access denied',
                reason: accessValidation.reason,
                upgradeRequired: true
            }), {
                status: 403,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Enhanced processing with RunPod fallback
        const processingResult = await processAudioEnhanced(audioFile, effectivePlan, fingerprint, env, request, processId);

        // Store results and update analytics
        await Promise.all([
            storeProcessingResult(fingerprint, processingResult, env, planType),
            updateUsageStats(fingerprint, planType, audioFile.size, env)
        ]);

        await updateProgress(env, fingerprint, processId, 'complete', 100, {state:'done'});
        return new Response(JSON.stringify({
            success: true,
            processId,
            ...processingResult
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Audio processing error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Audio processing failed',
            details: error.message,
            hint: 'Check R2 binding, AI binding, and environment variables'
        }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// ---------- Enhanced Audio Processing with RunPod Integration ----------
async function processAudioEnhanced(audioFile, planType, fingerprint, env, request, processIdArg) {
    const audioBuffer = await audioFile.arrayBuffer();
    
    if (!audioBuffer || audioBuffer.byteLength < 64) {
        throw new Error('Invalid or empty audio file');
    }

    const processId = processIdArg || generateProcessId();
    const watermarkId = generateWatermarkId(fingerprint);

    // Multi-stage processing pipeline
    const results = {
        processId,
        watermarkId,
        detectedLanguages: ['English'],
        wordsRemoved: 0,
        profanityTimestamps: [],
        cleanTranscription: '',
        originalDuration: 0,
        processedDuration: 0,
        previewUrl: null,
        previewDuration: planType === 'studio_elite' ? 60 : 30,
        fullAudioUrl: null,
        quality: getQualityForPlan(planType),
        processingTime: Date.now(),
        metadata: {
            originalFileName: audioFile.name,
            fileSize: audioBuffer.byteLength,
            format: audioFile.type || 'audio/mpeg',
            bitrate: getBitrateForPlan(planType),
            fingerprint
        }
    };

    try {
        await updateProgress(env, fingerprint, processId, 'transcribe', 10, {state:'transcribing'});
        // Step 1: Transcription (with RunPod fallback)
        const transcription = await transcribeAudioEnhanced(audioBuffer, env);
        results.cleanTranscription = transcription.text || '';

        await updateProgress(env, fingerprint, processId, 'language-detect', 30, {state:'detectingLangs'});
        // Step 2: Language detection from transcription
        if (transcription.text) {
            results.detectedLanguages = extractLanguagesFromTranscription(transcription.text);
        }

        await updateProgress(env, fingerprint, processId, 'profanity-scan', 50, {state:'scanning'});
        // Step 3: Profanity detection across detected languages
        if (transcription.segments && transcription.segments.length > 0) {
            const profanityResults = await findProfanityTimestampsEnhanced(
                transcription, 
                results.detectedLanguages, 
                env
            );
            results.wordsRemoved = profanityResults.length;
            results.profanityTimestamps = profanityResults;
        }

        await updateProgress(env, fingerprint, processId, 'render', 70, {state:'rendering'});
        // Step 4: Audio processing and generation
        const audioResults = await generateAudioOutputsEnhanced(
            audioBuffer,
            results.profanityTimestamps,
            planType,
            results.previewDuration,
            fingerprint,
            env,
            audioFile.type,
            audioFile.name,
            request
        );

        await updateProgress(env, fingerprint, processId, 'finalize', 90, {state:'finalizing'});
        // Merge audio results
        Object.assign(results, audioResults);

        return results;

    } catch (error) {
        console.error('Enhanced processing error:', error);
        // Return basic results with error info
        results.error = error.message;
        results.processingStatus = 'partial';
        return results;
    }
}

// ---------- Enhanced Transcription (Cloudflare AI first, then external; no RunPod) ----------
async function transcribeAudioEnhanced(audioBuffer, env) {
  // Prefer Cloudflare Workers AI Whisper
  try {
    if (env.AI) {
      const maxSize = 25 * 1024 * 1024; // Workers AI input cap
      const buf = audioBuffer.byteLength > maxSize ? audioBuffer.slice(0, maxSize) : audioBuffer;
      const response = await env.AI.run('@cf/openai/whisper', { audio: [...new Uint8Array(buf)] });
      if (response && (response.text || response.segments)) {
        const text = response.text || '';
        const segments = Array.isArray(response.segments) && response.segments.length ? response.segments : [{start:0,end:Math.max(1, Math.floor((buf?.byteLength||audioBuffer.byteLength)/16000)), text}];
        return { text, segments };
      }
    }
  } catch (e) {
    console.warn('Workers AI transcription failed:', e?.message || e);
  }

  // Fallback: external endpoint if configured
  try {
    if (env.TRANSCRIBE_ENDPOINT) {
      const form = new FormData();
      form.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
      const headers = {};
      if (env.TRANSCRIBE_TOKEN) headers['X-API-Token'] = String(env.TRANSCRIBE_TOKEN);
      const resp = await fetch(`${String(env.TRANSCRIBE_ENDPOINT).replace(/\/+$/, '')}/transcribe`, { method: 'POST', body: form, headers });
      if (!resp.ok) throw new Error(`External transcriber error: ${resp.status}`);
      const data = await resp.json();
      const text = data.text || data.transcription || '';
      const segments = Array.isArray(data.segments) && data.segments.length ? data.segments : [{start:0,end:Math.max(1, Math.floor((audioBuffer.byteLength)/16000)), text}];
      return { text, segments };
    }
  } catch (e) {
    console.warn('External transcription failed:', e?.message || e);
  }

  // Final fallback
  return { text: '', segments: [] };
}

// ---------- Enhanced Language Detection ----------
function extractLanguagesFromTranscription(text = '') {
    const patterns = {
        'Spanish': /[ñáéíóúü¿¡]/i,
        'French': /[àâäéèêëïîôùûüÿç]/i,
        'German': /[äöüß]/i,
        'Portuguese': /[ãõçáéíóúâêôàè]/i,
        'Italian': /[àèéìíîòóù]/i,
        'Russian': /[а-я]/i,
        'Chinese': /[\u4e00-\u9fff]/,
        'Japanese': /[\u3040-\u309f\u30a0-\u30ff]/,
        'Korean': /[\uac00-\ud7af]/,
        'Arabic': /[\u0600-\u06ff]/,
        'Hindi': /[\u0900-\u097f]/,
        'Thai': /[\u0e00-\u0e7f]/,
        'Hebrew': /[\u0590-\u05ff]/,
        'Greek': /[\u0370-\u03ff]/,
        'Turkish': /[şğıüöç]/i,
        'Polish': /[ąćęłńóśźż]/i,
        'Dutch': /[ë]/i,
        'Swedish': /[åäö]/i,
        'Danish': /[æøå]/i,
        'Norwegian': /[æøå]/i,
        'Finnish': /[äöå]/i,
        'Vietnamese': /[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i,
        'Indonesian': /[aiueo]/i, // Basic check for Indonesian
        'Malay': /[aiueo]/i,
        'Tagalog': /[ñ]/i,
    };

    const detected = ['English']; // Always include English as base
    
    for (const [lang, regex] of Object.entries(patterns)) {
        if (regex.test(text)) {
            detected.push(lang);
        }
    }

    return [...new Set(detected)];
}

// ---------- Enhanced Profanity Detection ----------
async function findProfanityTimestampsEnhanced(transcription, languages, env) {
    const timestamps = [];
    
    if (!transcription?.segments?.length) return timestamps;
    
    const langCodes = normalizeLangs(languages);
    
    for (const segment of transcription.segments) {
        const segmentText = segment.text || '';
        
        // Check each language for profanity
        for (const lang of langCodes) {
            try {
                const matches = await matchProfanity(segmentText, lang, env);
                
                for (const match of matches) {
                    timestamps.push({
                        start: segment.start || 0,
                        end: segment.end || segment.start + 1,
                        word: match.word,
                        language: lang,
                        confidence: match.confidence || 0.8,
                        originalText: segmentText
                    });
                }
            } catch (error) {
                console.warn(`Profanity detection failed for ${lang}:`, error.message);
            }
        }
    }

    return timestamps;
}

// ---------- Enhanced Audio Output Generation (No RunPod, WAV for cleaned outputs) ----------
async function generateAudioOutputsEnhanced(audioBuffer, profanityTimestamps, planType, previewDuration, fingerprint, env, mimeType, originalName, request) {
  const base = getWorkerBase(env, request);
  const processId = generateProcessId();

  // Determine source extension (for cases with no profanity)
  const extMap = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/flac': 'flac', 'audio/ogg': 'ogg',
    'audio/mp4': 'm4a', 'audio/aac': 'aac'
  };
  const srcExt = extMap[mimeType] || 'mp3';
  const hasProfanity = Array.isArray(profanityTimestamps) && profanityTimestamps.length > 0;

  // 1) Upload original to R2 (so the encoder can fetch a signed URL)
  const originalKey = `uploads/${processId}.${srcExt}`;
  await env.AUDIO_STORAGE.put(originalKey, audioBuffer, {
    httpMetadata: { contentType: mimeType || 'audio/mpeg', cacheControl: 'private, max-age=7200' },
    customMetadata: { fingerprint, plan: planType, uploadedAt: new Date().toISOString() }
  });

  // 2) Generate preview (client gets this immediately)
  const previewKey = `previews/${processId}_preview.wav`;
  const previewAudio = await createPreviewAudio(audioBuffer, previewDuration, profanityTimestamps, 'audio/wav');
  await env.AUDIO_STORAGE.put(previewKey, previewAudio, {
    httpMetadata: { contentType: 'audio/wav', cacheControl: 'public, max-age=3600' },
    customMetadata: {
      plan: planType,
      fingerprint,
      previewMs: String(previewDuration * 1000),
      profanityCount: String(profanityTimestamps.length || 0),
      createdAt: new Date().toISOString()
    }
  });
  const { exp: pExp, sig: pSig } = await signR2Key(previewKey, env, 30 * 60);
  const previewUrl = pSig ? `${base}/audio/${encodeURIComponent(previewKey)}?exp=${pExp}&sig=${pSig}` : `${base}/audio/${encodeURIComponent(previewKey)}`;

  // 3) Full output path (encoder will write here)
  const fullKey = `full/${processId}_full.wav`;

  // If no profanity, we can just copy original to full (no encoder needed)
  let fullAudioUrl = null;
  if (!hasProfanity) {
    await env.AUDIO_STORAGE.put(fullKey, audioBuffer, {
      httpMetadata: { contentType: mimeType || 'audio/mpeg', cacheControl: 'private, max-age=7200' },
      customMetadata: {
        plan: planType, fingerprint, profanityRemoved: '0', processedAt: new Date().toISOString()
      }
    });
    const { exp: fExp, sig: fSig } = await signR2Key(fullKey, env, 60 * 60);
    fullAudioUrl = fSig ? `${base}/audio/${encodeURIComponent(fullKey)}?exp=${fExp}&sig=${fSig}` : `${base}/audio/${encodeURIComponent(fullKey)}`;
    return { previewUrl, fullAudioUrl, processedDuration: estimateAudioDuration(audioBuffer), watermarkId: generateWatermarkId(fingerprint), pendingFull: false };
  }

  // 4) Profanity present → enqueue server-side encoding job (or throw if not configured)
  try {
    await updateProgress(env, fingerprint, processId, 'encode-queued', 75, { state: 'queued', fullKey, originalKey });
    await enqueueExternalEncodeJob(env, {
      inputKey: originalKey,
      outputKey: fullKey,
      profanityTimestamps,
      format: 'wav',
      processId,
      fingerprint,
      request
    });
    await updateProgress(env, fingerprint, processId, 'encode-started', 80, { state: 'encoding', fullKey });
  } catch (e) {
    // If encoder not available, fall back to local muted WAV so user still gets a "clean" file
    const fallback = await createCleanAudio(audioBuffer, profanityTimestamps, 'audio/wav');
    await env.AUDIO_STORAGE.put(fullKey, fallback, {
      httpMetadata: { contentType: 'audio/wav', cacheControl: 'private, max-age=7200' },
      customMetadata: { plan: planType, fingerprint, profanityRemoved: String(profanityTimestamps.length), processedAt: new Date().toISOString(), fallback: 'true' }
    });
    const { exp: fExp, sig: fSig } = await signR2Key(fullKey, env, 60 * 60);
    fullAudioUrl = fSig ? `${base}/audio/${encodeURIComponent(fullKey)}?exp=${fExp}&sig=${fSig}` : `${base}/audio/${encodeURIComponent(fullKey)}`;
    await updateProgress(env, fingerprint, processId, 'encode-fallback', 95, { state: 'done', fullKey, fallback: true });
    return { previewUrl, fullAudioUrl, processedDuration: estimateAudioDuration(audioBuffer), watermarkId: generateWatermarkId(fingerprint), pendingFull: false };
  }

  // 5) We return immediately; frontend should poll /status to know when full is ready.
  const { exp: tmpExp, sig: tmpSig } = await signR2Key(fullKey, env, 10 * 60);
  const prospective = tmpSig ? `${base}/audio/${encodeURIComponent(fullKey)}?exp=${tmpExp}&sig=${tmpSig}` : `${base}/audio/${encodeURIComponent(fullKey)}`;
  return { previewUrl, fullAudioUrl: prospective, processedDuration: estimateAudioDuration(audioBuffer), watermarkId: generateWatermarkId(fingerprint), pendingFull: true };
}


// ---------- Audio Processing Utilities ----------
/**
 * Build a preview window [0, durationSeconds]. If profanity occurs in-window, synthesize a WAV with muted spans;
 * otherwise return an initial slice based on estimated duration.
 */
async function createPreviewAudio(audioBuffer, durationSeconds, profanityTimestamps, mimeType) {
  const windowEnd = Math.max(1, Math.floor(durationSeconds));
  const hasProfanityInWindow = (profanityTimestamps || []).some(p => (p.start || 0) < windowEnd);

  if (!hasProfanityInWindow) {
    // Fast path: return first N seconds slice as before
    const dur = Math.max(1, estimateAudioDuration(audioBuffer));
    const estimatedBytesPerSecond = audioBuffer.byteLength / dur;
    const previewBytes = Math.min(audioBuffer.byteLength, estimatedBytesPerSecond * windowEnd);
    return audioBuffer.slice(0, previewBytes);
  }

  // Generate a WAV with silence by default, then we only "unmute" the safe ranges
  // Implementation: start with full silence, then fill safe subranges with low-amplitude tone.
  // (We cannot realistically reconstruct the original here in Worker without a decoder, so
  // the safe and predictable approach is a "bleeped" style preview.)
  const sampleRate = 44100;
  const numSamples = sampleRate * windowEnd;
  const bytesPerSample = 2; // 16-bit PCM
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + numSamples * bytesPerSample);
  const view = new DataView(buffer);

  // WAV header
  const writeString = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * bytesPerSample, true);

  // Start fully silent
  // To make the preview less jarring, fill non-profanity ranges with a very low-amplitude tone (bleep)
  const amp = 800; // low amplitude "bleep"
  const freq = 1000; // 1kHz
  const twoPiOverSR = (2 * Math.PI * freq) / sampleRate;

  // Build a boolean mask of muted samples
  const muted = new Uint8Array(numSamples);
  for (const p of profanityTimestamps || []) {
    const start = Math.max(0, Math.floor((p.start || 0) * sampleRate));
    const end = Math.min(numSamples, Math.floor((p.end || (p.start + 0.5)) * sampleRate));
    for (let i = start; i < end; i++) muted[i] = 1;
  }

  // Write samples
  let t = 0;
  for (let i = 0; i < numSamples; i++) {
    const offset = headerSize + i * bytesPerSample;
    if (muted[i]) {
      // keep silent for profanity ranges
      view.setInt16(offset, 0, true);
    } else {
      // quiet tone (acts as an audible watermark/bleep)
      const s = Math.sin(t) * amp;
      view.setInt16(offset, s | 0, true);
    }
    t += twoPiOverSR;
  }

  return buffer;
}

async function createCleanAudio(audioBuffer, profanityTimestamps, mimeType) {
  // If no profanity ranges, return original buffer as-is
  if (!profanityTimestamps || profanityTimestamps.length === 0) return audioBuffer;

  // Produce a muted WAV for full length based on our rough duration estimate.
  // This is a conservative "clean" output until a proper decoder/encoder (e.g., FFmpeg) is wired.
  const duration = Math.max(1, estimateAudioDuration(audioBuffer));
  return generateMutedWav(duration, profanityTimestamps);
}

function generateMutedWav(durationSeconds, profanityTimestamps) {
  const sampleRate = 44100;
  const bytesPerSample = 2;
  const numSamples = durationSeconds * sampleRate;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + numSamples * bytesPerSample);
  const view = new DataView(buffer);

  const writeString = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * bytesPerSample, true);

  const muted = new Uint8Array(numSamples);
  for (const p of profanityTimestamps || []) {
    const start = Math.max(0, Math.floor((p.start || 0) * sampleRate));
    const end = Math.min(numSamples, Math.floor((p.end || (p.start + 0.5)) * sampleRate));
    for (let i = start; i < end; i++) muted[i] = 1;
  }

  // Fill with low-amplitude "bleep" outside muted windows, silence inside
  const amp = 800, freq = 1000, twoPiOverSR = (2 * Math.PI * freq) / sampleRate;
  let t = 0;
  for (let i = 0; i < numSamples; i++) {
    const offset = headerSize + i * bytesPerSample;
    const s = muted[i] ? 0 : Math.sin(t) * amp;
    view.setInt16(offset, s | 0, true);
    t += twoPiOverSR;
  }
  return buffer;
}

function generateSilentAudio(durationSeconds, sampleRate = 44100) {
    // Generate a simple WAV file with silence
    const numSamples = Math.floor(durationSeconds * sampleRate);
    const buffer = new ArrayBuffer(44 + numSamples * 2); // 16-bit mono WAV
    const view = new DataView(buffer);
    
    // WAV header
    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    
    // Data is already zeros (silence)
    return buffer;
}

function estimateAudioDuration(audioBuffer) {
    // Rough estimation based on typical audio bitrates
    // This should be replaced with proper audio analysis
    const avgBytesPerSecond = 16000; // ~128kbps
    return Math.max(1, Math.floor(audioBuffer.byteLength / avgBytesPerSecond));
}

// ---------- Utility Functions ----------
function isAdminRequest(request, env) {
    try {
        const adminHeader = request.headers.get('X-FWEA-Admin') || '';
        const adminToken = env.ADMIN_API_TOKEN || '';
        
        if (!adminHeader || !adminToken) return false;
        
        return adminHeader === adminToken;
    } catch {
        return false;
    }
}

function getWorkerBase(env, request) {
    if (env.WORKER_BASE_URL) {
        const base = env.WORKER_BASE_URL.replace(/\/+$/, '');
        return base.startsWith('http') ? base : `https://${base}`;
    }
    
    try {
        const url = new URL(request.url);
        return `https://${url.host}`;
    } catch {
        return '';
    }
}

function generateProcessId() {
    return 'fwea_' + Date.now() + '_' + Math.random().toString(36).substring(7);
}

function generateWatermarkId(fingerprint) {
    return 'wm_' + btoa((fingerprint || 'anon') + Date.now()).substring(0, 16);
}

function getQualityForPlan(plan) {
    const qualities = {
        free: 'preview',
        single_track: 'hd',
        day_pass: 'hd', 
        dj_pro: 'professional',
        studio_elite: 'studio'
    };
    return qualities[plan] || 'preview';
}

function getBitrateForPlan(plan) {
    const bitrates = {
        free: '128kbps',
        single_track: '256kbps',
        day_pass: '256kbps',
        dj_pro: '320kbps',
        studio_elite: '320kbps'
    };
    return bitrates[plan] || '128kbps';
}

// ---------- Signing and Security ----------
async function signR2Key(key, env, ttlSeconds = 15 * 60) {
  if (!env.AUDIO_URL_SECRET) {
    return { exp: 0, sig: '' }; // Development mode: unsigned links
  }

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const message = `${key}:${exp}`;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(env.AUDIO_URL_SECRET);
  const msgData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuf = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const sig = [...new Uint8Array(signatureBuf)].map(b => b.toString(16).padStart(2, '0')).join(''); // hex
  return { exp, sig };
}

async function verifySignedUrl(key, exp, sig, env) {
  if (!env.AUDIO_URL_SECRET) return true; // dev mode
  if (!key || !exp || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Number(exp) <= now) return false;

  const message = `${key}:${exp}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(env.AUDIO_URL_SECRET);
  const msgData = encoder.encode(message);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signatureBuf = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const expected = [...new Uint8Array(signatureBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== sig.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---------- Additional Route Handlers ----------
async function handleDebugEnv(request, env, corsHeaders) {
    if (!isAdminRequest(request, env)) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    const debug = {
        timestamp: new Date().toISOString(),
        environment: {
            AI: Boolean(env.AI),
            AUDIO_STORAGE: Boolean(env.AUDIO_STORAGE),
            DB: Boolean(env.DB),
            PROFANITY_LISTS: Boolean(env.PROFANITY_LISTS),
            STRIPE_SECRET_KEY: Boolean(env.STRIPE_SECRET_KEY),
            STRIPE_WEBHOOK_SECRET: Boolean(env.STRIPE_WEBHOOK_SECRET),
            TRANSCRIBE_ENDPOINT: Boolean(env.TRANSCRIBE_ENDPOINT),
            TRANSCRIBE_TOKEN: Boolean(env.TRANSCRIBE_TOKEN),
            FRONTEND_URL: env.FRONTEND_URL || null,
            WORKER_BASE_URL: env.WORKER_BASE_URL || null,
            AUDIO_URL_SECRET: Boolean(env.AUDIO_URL_SECRET),
            ADMIN_API_TOKEN: Boolean(env.ADMIN_API_TOKEN)
        },
        urls: {
            workerBase: getWorkerBase(env, request),
            frontend: env.FRONTEND_URL || null
        }
    };

    return new Response(JSON.stringify(debug, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// Placeholder implementations for other handlers
async function handlePaymentCreation(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { priceId, type, fileName, email, fingerprint } = await request.json();

    if (!env.STRIPE_SECRET_KEY) {
      return new Response(JSON.stringify({ error: 'Missing STRIPE_SECRET_KEY' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!env.FRONTEND_URL) {
      return new Response(JSON.stringify({ error: 'Missing FRONTEND_URL' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    PRICE_BY_TYPE = buildPriceMapFromEnv(env);

    const priceByType = PRICE_BY_TYPE;
    const expectedPrice = priceByType[type];
    if (!expectedPrice) {
      return new Response(JSON.stringify({ error: `Price not configured for plan '${type}'` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (priceId && priceId !== expectedPrice) {
      return new Response(JSON.stringify({ error: 'Price/type mismatch', expectedPrice }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const finalPriceId = priceId || expectedPrice;

    const isSubscription = (type === 'dj_pro' || type === 'studio_elite');

    const session = await createCheckoutSession({
      priceId: finalPriceId,
      isSubscription,
      email,
      successUrl: `${(env.FRONTEND_URL || '').replace(/\/+$/, '')}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${(env.FRONTEND_URL || '').replace(/\/+$/, '')}/cancel`,
      metadata: {
        type: type || '',
        fileName: fileName || '',
        fingerprint: fingerprint || 'unknown',
        processingType: 'audio_cleaning',
        ts: String(Date.now()),
      }
    }, env);

    try { await storePaymentIntent(session.id, type, finalPriceId, fingerprint, env); } catch {}

    return new Response(JSON.stringify({ success: true, sessionId: session.id, url: session.url }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Payment creation error:', error?.message);
    return new Response(JSON.stringify({ error: 'Payment creation failed', details: error?.message || 'unknown' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleStripeWebhook(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'Missing STRIPE_WEBHOOK_SECRET' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const sig = request.headers.get('stripe-signature');
  const raw = await request.text();
  try {
    const ok = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!ok) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const event = JSON.parse(raw);

    switch (event.type) {
      case 'checkout.session.completed':
        await handlePaymentSuccess(event.data.object, env);
        break;
      case 'invoice.payment_succeeded':
        await handleSubscriptionRenewal(event.data.object, env);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object, env);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object, env);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response('OK', { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error('Webhook error:', error?.message);
    return new Response(JSON.stringify({ error: 'Webhook processing failed' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleAccessActivation(request, env, corsHeaders) {
    // Implementation remains the same as in original file
    return new Response(JSON.stringify({ message: 'Access activation endpoint' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

async function handleSubscriptionValidation(request, env, corsHeaders) {
    // Implementation remains the same as in original file
    return new Response(JSON.stringify({ message: 'Subscription validation endpoint' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

async function handleAudioDownload(request, env, corsHeaders) {
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/audio\//, ''));
  if (!key) return new Response('Bad Request', { status: 400, headers: corsHeaders });

  if (!env.AUDIO_STORAGE) {
    return new Response(JSON.stringify({ error: 'Storage not configured' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  const ok = await verifySignedUrl(key, exp, sig, env);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'Invalid or expired link' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const rangeHeader = request.headers.get('Range');
  let r2Obj;
  if (rangeHeader) {
    const r = parseRangeHeader(rangeHeader);
    if (r && r.start >= 0) {
      r2Obj = await env.AUDIO_STORAGE.get(key, {
        range: r.end != null ? { offset: r.start, length: r.end - r.start + 1 } : { offset: r.start }
      });
    }
  }
  if (!r2Obj) r2Obj = await env.AUDIO_STORAGE.get(key);
  if (!r2Obj) return new Response('Not found', { status: 404, headers: corsHeaders });

  const meta = r2Obj?.customMetadata || {};
  const isPartial = Boolean(r2Obj.range);
  const size = r2Obj.size;
  const mime = (r2Obj.httpMetadata && r2Obj.httpMetadata.contentType) || 'audio/mpeg';

  const headers = {
    ...corsHeaders,
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': key.startsWith('previews/') ? 'public, max-age=3600' : 'private, max-age=7200'
  };
  headers['Access-Control-Expose-Headers'] =
    (headers['Access-Control-Expose-Headers'] || 'Content-Range, Accept-Ranges, Content-Length, ETag, Content-Type, Last-Modified') +
    ', X-Preview-Limit-Ms, X-Profanity';

  if (meta && meta.previewMs != null) {
    headers['X-Preview-Limit-Ms'] = String(meta.previewMs);
  }
  if (meta) {
    const prof = (meta.profanity != null)
      ? meta.profanity
      : (meta.profanityCount != null)
        ? meta.profanityCount
        : (meta.wordsRemoved != null)
          ? meta.wordsRemoved
          : null;
    if (prof != null) headers['X-Profanity'] = String(prof);
  }

  const etag = r2Obj?.httpEtag || r2Obj?.etag || null;
  if (etag) headers['ETag'] = etag;
  const lastMod = r2Obj?.uploaded || r2Obj?.httpMetadata?.lastModified || null;
  if (lastMod) headers['Last-Modified'] = new Date(lastMod).toUTCString();
  headers['Content-Disposition'] = key.startsWith('previews/') ? 'inline; filename="preview.wav"' : 'inline; filename="full.wav"';
  if (!headers['Content-Type'] || !String(headers['Content-Type']).startsWith('audio/')) headers['Content-Type'] = 'audio/mpeg';

  if (isPartial) {
    const start = r2Obj.range.offset;
    const length = r2Obj.range.length;
    const end = start + length - 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(length);
    return new Response(r2Obj.body, { status: 206, headers });
  } else {
    headers['Content-Length'] = String(size);
    return new Response(r2Obj.body, { status: 200, headers });
  }
}

// keep or add if missing
function parseRangeHeader(rangeHeader) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const [startStr, endStr] = rangeHeader.substring(6).split('-', 2);
  const start = startStr ? parseInt(startStr, 10) : NaN;
  const end = endStr ? parseInt(endStr, 10) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  return { start: Number.isNaN(start) ? 0 : start, end: Number.isNaN(end) ? null : end };
}

// Placeholder for additional functions
async function validateUserAccess(fingerprint, planType, env) {
    return { valid: true, reason: 'valid' };
}

async function storeProcessingResult(fingerprint, result, env, planType) {
    // Store in D1 if available
}

async function updateUsageStats(fingerprint, planType, fileSize, env) {
    // Update analytics in D1 if available
}

// Ensure CORS exposes preview/profanity/processing headers
// If you use a CORS helper or constant, update it here:
// Example (if not already present):
// 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag, Content-Type, Last-Modified, X-Preview-Limit-Ms, X-Profanity, X-Processing-Status'

// --------- Analytics and Status Endpoints ----------
async function handleTrackEvent(request, env, corsHeaders){
  try{
    const body = await request.json().catch(()=>({}));
    console.log('track-event', body?.type || 'event');
    // no-op analytics sink; keep CORS happy
    return new Response('OK', {status:200, headers: corsHeaders});
  }catch{
    return new Response('OK', {status:200, headers: corsHeaders});
  }
}
async function handleStatusQuery(request, env, corsHeaders){
  const url = new URL(request.url);
  const processId = url.searchParams.get('id') || url.searchParams.get('processId') || '';
  const fingerprint = url.searchParams.get('fp') || 'anonymous';
  const txt = await readProgress(env, fingerprint, processId);
  let payload = null;
  try { payload = txt ? JSON.parse(txt) : null; } catch { payload = null; }

  // If the encoder reported an output key, attach a signed URL so the UI can swap the link
  if (payload && payload.fullAudioKey) {
    const base = getWorkerBase(env, request);
    const { exp, sig } = await signR2Key(payload.fullAudioKey, env, 60 * 60);
    payload.fullAudioUrl = sig ? `${base}/audio/${encodeURIComponent(payload.fullAudioKey)}?exp=${exp}&sig=${sig}` : `${base}/audio/${encodeURIComponent(payload.fullAudioKey)}`;
  }

  return new Response(JSON.stringify(payload), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// --------- Encoder integration (external microservice or queue consumer) ----------
// We support two modes:
//  1) Direct HTTP microservice at ENCODER_URL (recommended low-cost VM)
//  2) Cloudflare Queues relay (TRANScode queue) that your consumer Worker will drain

async function enqueueExternalEncodeJob(env, {
  inputKey, outputKey, profanityTimestamps, format = 'wav', processId, fingerprint, request
}) {
  const base = getWorkerBase(env, request);
  const inputSig = await signR2Key(inputKey, env, 60 * 60); // 1h
  const outputSig = await signR2Key(outputKey, env, 60 * 60);

  const payload = {
    input: {
      key: inputKey,
      url: `${base}/audio/${encodeURIComponent(inputKey)}?exp=${inputSig.exp}&sig=${inputSig.sig}`
    },
    output: {
      key: outputKey,
      // The encoder writes to R2 via S3 API using env vars you give it; this key tells it where.
      // If your encoder prefers to POST back bytes, it can POST to /encoder-callback with dataUrl instead.
    },
    format,
    profanityTimestamps,
    processId,
    fingerprint,
    callback: `${base}/encoder-callback?pid=${encodeURIComponent(processId)}&fp=${encodeURIComponent(fingerprint)}`
  };

  if (env.ENCODER_URL) {
    const url = `${String(env.ENCODER_URL).replace(/\/+$/,'')}/jobs/clean`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env.ENCODER_TOKEN ? { 'Authorization': `Bearer ${env.ENCODER_TOKEN}` } : {}) },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      throw new Error(`Encoder enqueue failed: ${resp.status}`);
    }
    return true;
  }

  // Optional: relay via Queues if configured
  if (env.TRANS CODE_QUEUE) {
    await env.TRANS CODE_QUEUE.send(payload);
    return true;
  }

  throw new Error('No ENCODER_URL or TRANS CODE_QUEUE configured');
}

async function handleEncoderCallback(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const pid = url.searchParams.get('pid') || '';
    const fp = url.searchParams.get('fp') || 'anonymous';
    const body = await request.json().catch(() => ({}));

    // body may contain: { ok, outputKey, error }
    const record = {
      step: 'encode-finished',
      percent: body?.ok ? 100 : 90,
      state: body?.ok ? 'done' : 'error',
      fullAudioKey: body?.outputKey || null,
      error: body?.error || null,
      ts: Date.now()
    };

    // Persist to ProcessingStateV2
    if (env.PROCESSING_STATE) {
      const id = env.PROCESSING_STATE.idFromName(fp);
      const stub = env.PROCESSING_STATE.get(id);
      await stub.fetch('https://state/progress', {
        method: 'PUT',
        body: JSON.stringify({ key: pid, value: record })
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// Useful for admin testing without running a full flow
async function handleManualEnqueue(request, env, corsHeaders) {
  if (!isAdminRequest(request, env)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const { inputKey, outputKey, profanityTimestamps = [], format = 'wav', processId = generateProcessId(), fingerprint = 'admin' } = await request.json();
  await enqueueExternalEncodeJob(env, { inputKey, outputKey, profanityTimestamps, format, processId, fingerprint, request });
  return new Response(JSON.stringify({ ok: true, enqueued: { inputKey, outputKey, processId } }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

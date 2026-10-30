/**
 * search-comete - llm.js
 * A small language model that runs on the visitor's own device (WebGPU, or
 * WebAssembly on the CPU), so there's no server, key or cost.
 *
 * Main model: LiquidAI LFM2.5-350M, downloaded once and cached by the
 * browser. Picked over Gemma 3 270M and SmolLM2 360M in a side-by-side test:
 * it follows the output format and answers in ~1-2 s. It is still a 350M
 * model - it can be wrong, and the UI says so. Everything factual (shared
 * references, co-citations...) comes from OpenAlex, not from here.
 */

// Picked per device, tested in headless Chromium:
//  - WebGPU with shader-f16 → LFM2.5-350M q4f16 (~255 MB)
//  - WebGPU without f16     → LFM2.5-350M q4    (~295 MB)
//  - no WebGPU (CPU/WASM)   → SmolLM2-360M q4   (~385 MB). LFM2.5's ONNX
//    exports use GatherBlockQuantized, which the WASM runtime lacks.
const LFM   = { id: 'onnx-community/LFM2.5-350M-ONNX', label: 'LFM2.5 350M' };
const SMOL  = { id: 'onnx-community/SmolLM2-360M-Instruct-ONNX', label: 'SmolLM2 360M' };

let _gen = null;
let _loading = null;
let _info = null;

export function llmReady() { return !!_gen; }
/** { label, device } of the loaded model, or null. */
export function llmInfo() { return _info; }

/** Load once. onProgress(fraction 0..1, loadedMB, totalMB) while downloading. */
export function loadLLM(onProgress) {
  if (_gen) return Promise.resolve(_gen);
  if (_loading) return _loading;
  _loading = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      files.forEach(([l, t]) => { loaded += l; total += t; });
      onProgress?.(loaded / total, loaded / 1048576, total / 1048576);
    };
    const load = async (model, device, dtype) => {
      _gen = await pipeline('text-generation', model.id, { device, dtype, progress_callback });
      _info = { label: model.label, device: device === 'webgpu' ? 'GPU' : 'CPU' };
    };
    const adapter = await _webgpuAdapter();
    if (adapter) {
      try {
        await load(LFM, 'webgpu', adapter.features.has('shader-f16') ? 'q4f16' : 'q4');
        return _gen;
      } catch (e) {
        console.warn('[llm] WebGPU failed, falling back to CPU:', e.message);
      }
    }
    await load(SMOL, 'wasm', 'q4');
    return _gen;
  })().catch(e => { _loading = null; throw e; });
  return _loading;
}

async function _webgpuAdapter() {
  try { return navigator.gpu ? await navigator.gpu.requestAdapter() : null; } catch { return null; }
}

async function _run(messages, maxTokens, onToken) {
  const gen = await loadLLM();
  const { TextStreamer } = await import('@huggingface/transformers');
  let text = '';
  const streamer = new TextStreamer(gen.tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: (chunk) => { text += chunk; onToken?.(text); },
  });
  const out = await gen(messages, { max_new_tokens: maxTokens, do_sample: false, repetition_penalty: 1.15, streamer });
  return (out[0].generated_text.at(-1).content || text).trim();
}

// One worked example keeps a 350M model on format far better than rules alone
const TOPIC_EXAMPLE_USER = 'Title: Deep Residual Learning for Image Recognition\nAbstract: Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.';
const TOPIC_EXAMPLE_REPLY = 'batch normalization\nvery deep convolutional networks\nimage classification benchmarks\nneural architecture search\nobject detection backbones';

/** 3-5 short search queries for where to go next from this paper. */
export async function suggestTopics(paper, onToken) {
  const text = await _run([
    { role: 'system', content: 'You list related research topics. Reply with exactly 5 lines. Each line is a search query of 2 to 5 words. No numbering, no explanations.' },
    { role: 'user', content: TOPIC_EXAMPLE_USER },
    { role: 'assistant', content: TOPIC_EXAMPLE_REPLY },
    { role: 'user', content: `Title: ${paper.title}\nAbstract: ${(paper.abstract || '').slice(0, 900)}` },
  ], 60, onToken);

  const seen = new Set();
  return text.split('\n')
    .map(l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').replace(/[*"`]/g, '').replace(/[.:;,]+$/, '').trim())
    .filter(l => l.length > 2 && l.split(/\s+/).length <= 6 && !/^(here|sure|topics?)\b/i.test(l))
    .filter(l => { const k = l.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 5);
}

/** A few sentences on how two papers relate, grounded in the computed facts. */
export async function explainPair(facts, onToken) {
  const { a, b } = facts;
  const lines = [
    `They share ${facts.sharedRefs} references.`,
    facts.aCitesB ? 'Paper A cites paper B.' : facts.bCitesA ? 'Paper B cites paper A.' : 'Neither paper cites the other.',
    facts.coCited != null ? `${facts.coCited} later papers cite both.` : null,
    facts.sharedTopics.length ? `Shared topics: ${facts.sharedTopics.join(', ')}.` : 'They share no OpenAlex topics.',
    facts.sharedKeywords.length ? `Shared keywords: ${facts.sharedKeywords.slice(0, 5).join(', ')}.` : null,
    facts.sameField === false ? 'They sit in different fields of the map.' : facts.sameField ? 'They sit in the same field of the map.' : null,
  ].filter(Boolean);

  const text = await _run([
    { role: 'system', content: 'You compare two research papers for a reader. Use only the facts and abstracts given. Write 2 or 3 plain sentences. Do not invent results.' },
    { role: 'user', content: `Paper A: ${a.title}\n${(a.abstract || '').slice(0, 600)}\n\nPaper B: ${b.title}\n${(b.abstract || '').slice(0, 600)}\n\nFacts:\n- ${lines.join('\n- ')}\n\nHow do these two papers relate, and is it worth reading them together?` },
  ], 110, onToken);

  // Keep it short: at most three sentences
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(0, 3).join(' ').trim();
}

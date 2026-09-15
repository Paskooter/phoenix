// answer-skill — answers general knowledge questions. Phoenix port of packages/answer-skill.
//
// Input: a SkillRequest (LISTEN_LAUNCH) whose result carries the asr text + nlu entities.
// Output: a SKILL_ACTION speaking the answer (buildSkillAction). If ETCO_answer_llmUrl is set,
// it asks an OpenAI-compatible chat endpoint (the phoenix design: LM Studio + Gemma); otherwise
// it returns an honest placeholder so the wire path is exercised without an LLM backend.

import { newMsgId, resolveLlmProvider, llmRequestHeaders, llmCompletionsUrl } from '@phoenix/contracts';
import { buildSkillAction } from './jcp.js';

const MAX_ANSWER_CHARS = 600;
// Endpoint resolution is shared (see @phoenix/contracts llmProvider): the
// historical ETCO_answer_llm* names still win, with PHOENIX_LLM_* as the
// deployment-wide fallback, plus an optional bearer token and extra headers.
// Resolved per call so a deployment can change it without a restart.
function llmProvider() {
  return resolveLlmProvider('answer', { defaultModel: 'gemma-3', defaultTimeoutMs: 12000 });
}

export async function answerSkill(request) {
  const data = request.data || {};
  const result = data.result || {};
  const asrText = (result.asr && result.asr.text) || '';
  const entities = (result.nlu && result.nlu.entities) || {};
  const question = (asrText || entities.person || entities.thing || entities.query || '').trim();
  const sessionId = (data.skill && data.skill.session && data.skill.session.id) || newMsgId();

  const answer = (await getAnswer(question)) || "I'm not sure about that one.";

  return buildSkillAction({
    skillId: 'answer-skill',
    esmlText: answer,
    asrText,
    sessionId,
    sessionData: { _answerSkill: { question: asrText } },
    mimId: 'AnswerReply',
    analytics: { 'answer-skill': [{ event: 'Skill Entry', properties: { initial_intent: 'answer', user_initiated: true } }] },
  });
}

async function getAnswer(question) {
  if (!question) return "I didn't catch a question.";
  const provider = llmProvider();
  if (!provider.url) {
    // No LLM backend wired — honest placeholder; the wire path is still fully exercised.
    return `You asked about ${question}. I don't have an answer source connected yet.`;
  }
  try {
    const res = await fetchJson(llmCompletionsUrl(provider), {
      model: provider.model,
      messages: [
        { role: 'system', content: 'You are Jibo, a friendly social robot. Answer in 1-2 short spoken sentences.' },
        { role: 'user', content: question },
      ],
      temperature: 0.3,
      max_tokens: 300,
      stream: false,
    }, provider.timeoutMs ?? 12000, llmRequestHeaders(provider));
    const msg = res && res.choices && res.choices[0] && res.choices[0].message;
    const text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
    return text ? trimToSentences(text, MAX_ANSWER_CHARS) : null;
  } catch {
    return null;
  }
}

function trimToSentences(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastStop > 0 ? cut.slice(0, lastStop + 1) : cut).trim();
}

async function fetchJson(url, body, timeoutMs, headers = { 'content-type': 'application/json' }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`llm ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

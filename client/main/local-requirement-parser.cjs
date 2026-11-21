'use strict';

// Local requirement parsing is a bounded, one-shot call. It never creates a
// conversation, loads workspace resources, or sends model data to the Hub.
const { create } = require('./app-ai-generate.cjs');

function localReference(value) {
  const model = String(value || '').trim();
  return model.startsWith('local:') ? model : '';
}

function requirementCompletion(choice) {
  if (['length', 'max_tokens', 'max_output_tokens'].includes(choice?.finish_reason))
    return { ok: false, code: 'APP_AI_OUTPUT_LIMIT', reason: '本地模型输出达到长度上限，未生成完整需求' };
  const message = choice?.message;
  if (choice?.finish_reason !== 'stop' || !message || (message.role != null && message.role !== 'assistant') ||
      message.refusal || message.function_call || (message.tool_calls != null &&
        (!Array.isArray(message.tool_calls) || message.tool_calls.length)))
    return { ok: false, code: 'APP_AI_INCOMPLETE_RESULT', reason: '本地模型未正常完成需求输出' };
  let text = message.content;
  if (Array.isArray(text)) {
    if (!text.every(part => part?.type === 'text' && typeof part.text === 'string'))
      return { ok: false, code: 'APP_AI_INCOMPLETE_RESULT', reason: '本地模型未正常完成需求输出' };
    text = text.map(part => part.text).join('');
  }
  return { text, finishReason: 'stop' };
}

function createLocalRequirementParser({ app, identityOf, fetchImpl = global.fetch,
  resolveModel, configuredModel } = {}) {
  const generate = create({ app, authenticatedIdentityOf: identityOf, fetchImpl, useModelOutputLimit: true,
    readCompletion: requirementCompletion,
    ...(resolveModel ? { resolveModel } : {}), ...(configuredModel ? { configuredModel } : {}) });
  return async raw => {
    const params = raw && typeof raw === 'object' ? raw : {};
    const model = localReference(params.model);
    if (!model) return { ok: false, code: 'APP_AI_LOCAL_MODEL_REQUIRED', reason: '本地需求解析只支持本地模型' };
    return generate({ appBridge: { appId: 'local-requirement-parser' }, view: null }, { ...params, model });
  };
}

module.exports = { createLocalRequirementParser, localReference };

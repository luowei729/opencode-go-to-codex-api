import {
  isAnthropicModel,
  resolveModel,
  buildUpstreamUrl,
  normalizeRole,
  convertInputToMessages,
  convertTools,
  convertRequestToChatCompletions,
  convertRequestToAnthropic,
  convertChatCompletionToResponse,
  convertAnthropicResponseToResponse,
  convertAnthropicToChatCompletion,
  createChatStreamConverter,
  createAnthropicStreamConverter,
  createAnthropicToChatStreamConverter,
  makeUpstreamRequest,
  DEFAULT_MODEL_MAP,
  ANTHROPIC_MODELS,
} from './proxy-logic.js';

import indexHtml from '../pages/index.html';

// Runtime default model - backed by D1 settings table
let runtimeDefaultModel = null;
let defaultModelLoaded = false;

// Runtime custom model map (overrides DEFAULT_MODEL_MAP) - backed by D1
const runtimeModelMap = {};
let modelMapLoaded = false;

// Runtime upstream URL - backed by D1
let runtimeUpstreamUrl = null;
let settingsLoaded = false;
const DEFAULT_UPSTREAM = 'https://opencode.ai/zen/go';

// Runtime password - backed by D1
let runtimePassword = null;
let passwordLoaded = false;
const DEFAULT_PASSWORD = 'abcd.1234';

// Runtime token limits - backed by D1 settings table
let runtimeMaxContextTokens = null;
let runtimeMaxOutputTokens = null;
let tokenLimitsLoaded = false;

// D1 lazy init flag
let dbInitialized = false;

async function ensureDbTable(env) {
  if (dbInitialized || !env.DB) return;
  try {
    await env.DB.exec('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, method TEXT, path TEXT, model TEXT, resolved_model TEXT, api TEXT, stream INTEGER, status INTEGER)');
    await env.DB.exec('CREATE TABLE IF NOT EXISTS model_map (from_model TEXT PRIMARY KEY, to_model TEXT NOT NULL)');
    await env.DB.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    dbInitialized = true;
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

async function loadModelMapFromDb(env) {
  if (!env.DB) return;
  try {
    await ensureDbTable(env);
    const result = await env.DB.prepare('SELECT * FROM model_map').all();
    // Seed D1 with DEFAULT_MODEL_MAP on first use
    if ((result.results || []).length === 0) {
      for (const [from, to] of Object.entries(DEFAULT_MODEL_MAP)) {
        await env.DB.prepare('INSERT OR REPLACE INTO model_map (from_model, to_model) VALUES (?, ?)').bind(from, to).run();
        runtimeModelMap[from] = to;
      }
    } else {
      for (const row of (result.results || [])) {
        runtimeModelMap[row.from_model] = row.to_model;
      }
    }
    modelMapLoaded = true;
  } catch (e) {
    console.error('Load model map error:', e.message);
  }
}

async function loadSettingsFromDb(env) {
  if (!env.DB || settingsLoaded) return;
  try {
    await ensureDbTable(env);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('upstream_url').first();
    if (row && row.value) runtimeUpstreamUrl = row.value;
    settingsLoaded = true;
  } catch (e) {
    console.error('Load settings error:', e.message);
  }
}

async function loadDefaultModelFromDb(env) {
  if (!env.DB || defaultModelLoaded) return;
  try {
    await ensureDbTable(env);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('default_model').first();
    runtimeDefaultModel = (row && row.value) ? row.value : null;
    defaultModelLoaded = true;
  } catch (e) {
    console.error('Load default model error:', e.message);
  }
}

async function loadTokenLimitsFromDb(env) {
  if (!env.DB || tokenLimitsLoaded) return;
  try {
    await ensureDbTable(env);
    const ctxRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('max_context_tokens').first();
    const outRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('max_output_tokens').first();
    runtimeMaxContextTokens = (ctxRow && ctxRow.value) ? parseInt(ctxRow.value) : null;
    runtimeMaxOutputTokens = (outRow && outRow.value) ? parseInt(outRow.value) : null;
    tokenLimitsLoaded = true;
  } catch (e) {
    console.error('Load token limits error:', e.message);
  }
}

async function loadPasswordFromDb(env) {
  if (!env.DB || passwordLoaded) return;
  try {
    await ensureDbTable(env);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('web_password').first();
    runtimePassword = (row && row.value) ? row.value : DEFAULT_PASSWORD;
    passwordLoaded = true;
  } catch (e) {
    console.error('Load password error:', e.message);
    runtimePassword = DEFAULT_PASSWORD;
  }
}

function getPassword() {
  return runtimePassword || DEFAULT_PASSWORD;
}

function checkAuth(request) {
  const pw = request.headers.get('x-admin-password');
  return pw === getPassword();
}

function getUpstreamUrl(env) {
  if (runtimeUpstreamUrl) return runtimeUpstreamUrl;
  return env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM;
}

function addLog(env, ctx, entry) {
  if (!env.DB) return;
  ctx.waitUntil((async () => {
    try {
      await ensureDbTable(env);
      await env.DB.prepare(
        'INSERT INTO logs (time, method, path, model, resolved_model, api, stream, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        new Date().toISOString(),
        entry.method, entry.path, entry.model, entry.resolvedModel,
        entry.api, entry.stream ? 1 : 0, entry.status
      ).run();
      // Keep only last 200 logs
      await env.DB.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)');
    } catch (e) {
      console.error('DB write error:', e.message);
    }
  })());
}

function resolveModelWithRuntime(modelName, env) {
  // 1. Forced model: always use it, bypass mapping entirely
  if (runtimeDefaultModel) {
    return runtimeDefaultModel.replace(/^opencode-go\//, '');
  }
  // 2. No forced model: use model mapping
  if (runtimeModelMap[modelName]) {
    return runtimeModelMap[modelName].replace(/^opencode-go\//, '');
  }
  // 3. No mapping found: use client model as-is
  return modelName.replace(/^opencode-go\//, '');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

// ---- Route Handlers ----

async function handleHealth() {
  return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
}

async function handleModels(authHeader) {
  try {
    const upstream = 'https://opencode.ai/zen/go';
    const token = authHeader?.replace('Bearer ', '');

    const response = await fetch(`${upstream}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return jsonResponse(data);
  } catch (err) {
    console.error('Error fetching models:', err.message);
    return jsonResponse({ error: { message: 'Failed to fetch models from upstream' } }, 502);
  }
}

async function handleGetDefaultModel(env) {
  // Always read fresh from D1 to ensure cross-isolate consistency
  if (env.DB) {
    try {
      await ensureDbTable(env);
      const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('default_model').first();
      runtimeDefaultModel = (row && row.value) ? row.value : null;
    } catch (e) {
      console.error('Load default model error:', e.message);
    }
  }
  return jsonResponse({
    runtimeDefault: runtimeDefaultModel,
    envDefault: env.DEFAULT_MODEL || null,
  });
}

async function handleSetDefaultModel(request, env) {
  if (!defaultModelLoaded) await loadDefaultModelFromDb(env);
  const body = await request.json();
  const { model } = body;
  if (model === null || model === '' || model === undefined) {
    runtimeDefaultModel = null;
    if (env.DB) {
      try {
        await ensureDbTable(env);
        await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('default_model').run();
      } catch (e) { console.error('Save default model error:', e.message); }
    }
    return jsonResponse({ success: true, model: null, message: '已取消强制模型，使用客户端传入的模型' });
  }
  runtimeDefaultModel = model;
  if (env.DB) {
    try {
      await ensureDbTable(env);
      await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('default_model', model).run();
    } catch (e) { console.error('Save default model error:', e.message); }
  }
  return jsonResponse({ success: true, model, message: `已强制使用模型: ${model}` });
}

async function handleResponses(request, env, ctx) {
  try {
    if (!modelMapLoaded) await loadModelMapFromDb(env);
    if (!settingsLoaded) await loadSettingsFromDb(env);
    if (!defaultModelLoaded) await loadDefaultModelFromDb(env);
    if (!tokenLimitsLoaded) await loadTokenLimitsFromDb(env);
    const upstreamBase = getUpstreamUrl(env);
    const token = request.headers.get('authorization')?.replace('Bearer ', '');

    if (!token) {
      return jsonResponse({ error: { message: 'No authentication token provided. Please send your OpenCode Go token via Authorization header.', type: 'authentication_error' } }, 401);
    }

    const reqBody = await request.json();
    const originalModel = reqBody?.model || 'unknown';
    const resolvedModel = resolveModelWithRuntime(originalModel, env);
    const isStream = reqBody?.stream === true;

    // Apply token limits if configured
    if (runtimeMaxOutputTokens && !reqBody.max_output_tokens) {
      reqBody.max_output_tokens = runtimeMaxOutputTokens;
    }

    const useAnthropic = isAnthropicModel(resolvedModel);

    let upstreamBody;
    let upstreamPath;

    if (useAnthropic) {
      upstreamBody = convertRequestToAnthropic(reqBody, resolvedModel);
      upstreamPath = '/v1/messages';
    } else {
      upstreamBody = convertRequestToChatCompletions(reqBody, resolvedModel);
      upstreamPath = '/v1/chat/completions';
    }

    const upstreamUrl = buildUpstreamUrl(upstreamBase, upstreamPath);
    console.log(`[Responses] -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, stream: ${isStream}, api: ${useAnthropic ? 'anthropic' : 'openai'})`);

    const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, token, useAnthropic);

    addLog(env, ctx, {
      method: 'POST',
      path: '/v1/responses',
      model: originalModel,
      resolvedModel,
      api: useAnthropic ? 'anthropic' : 'openai',
      stream: isStream,
      status: response.status,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
      try {
        return jsonResponse(JSON.parse(errorText), response.status);
      } catch {
        return jsonResponse({ error: { message: `Upstream error: ${response.status} ${errorText.substring(0, 200)}`, type: 'upstream_error' } }, response.status);
      }
    }

    if (isStream) {
      const converter = useAnthropic
        ? createAnthropicStreamConverter(originalModel)
        : createChatStreamConverter(originalModel);

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const transformed = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true });
          const converted = converter.process(text);
          if (converted) controller.enqueue(encoder.encode(converted));
        },
        flush(controller) {
          const remaining = converter.flush();
          if (remaining) controller.enqueue(encoder.encode(remaining));
        },
      }));

      return new Response(transformed, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...corsHeaders(),
        },
      });
    } else {
      const data = await response.text();
      try {
        const upstreamResp = JSON.parse(data);
        if (upstreamResp.error) {
          return jsonResponse(upstreamResp, response.status || 500);
        }
        if (useAnthropic) {
          return jsonResponse(convertAnthropicResponseToResponse(upstreamResp, originalModel));
        } else {
          return jsonResponse(convertChatCompletionToResponse(upstreamResp, originalModel));
        }
      } catch (e) {
        console.error('Response parse error:', e.message);
        return jsonResponse({ error: { message: 'Failed to parse upstream response', type: 'server_error' } }, 502);
      }
    }
  } catch (err) {
    console.error('Proxy handler error:', err.message);
    return jsonResponse({ error: { message: `Upstream error: ${err.message}`, type: 'proxy_error' } }, 502);
  }
}

async function handleChatCompletions(request, env, ctx) {
  try {
    if (!modelMapLoaded) await loadModelMapFromDb(env);
    if (!settingsLoaded) await loadSettingsFromDb(env);
    if (!defaultModelLoaded) await loadDefaultModelFromDb(env);
    if (!tokenLimitsLoaded) await loadTokenLimitsFromDb(env);
    const upstreamBase = getUpstreamUrl(env);
    const token = request.headers.get('authorization')?.replace('Bearer ', '');

    if (!token) {
      return jsonResponse({ error: { message: 'No auth token. Please send your OpenCode Go token via Authorization header.', type: 'authentication_error' } }, 401);
    }

    const reqBody = await request.json();
    const originalModel = reqBody?.model || 'gpt-4o';
    const resolvedModel = resolveModelWithRuntime(originalModel, env);
    reqBody.model = resolvedModel;

    // Apply token limits if configured
    if (runtimeMaxOutputTokens && !reqBody.max_tokens) {
      reqBody.max_tokens = runtimeMaxOutputTokens;
    }

    const useAnthropic = isAnthropicModel(resolvedModel);
    let upstreamBody;
    let upstreamPath;

    if (useAnthropic) {
      const pseudoResponsesBody = {
        model: resolvedModel,
        messages: reqBody.messages,
        stream: reqBody.stream || false,
        max_output_tokens: reqBody.max_tokens || 64000,
        temperature: reqBody.temperature,
        top_p: reqBody.top_p,
        stop: reqBody.stop,
        tools: reqBody.tools,
      };
      upstreamBody = convertRequestToAnthropic(pseudoResponsesBody, resolvedModel);
      upstreamPath = '/v1/messages';
    } else {
      upstreamBody = { ...reqBody };
      if (Array.isArray(upstreamBody.messages)) {
        upstreamBody.messages = upstreamBody.messages.map(m => ({
          ...m,
          role: normalizeRole(m.role),
        }));
      }
      if (upstreamBody.tools) {
        upstreamBody.tools = convertTools(upstreamBody.tools);
      }
      upstreamPath = '/v1/chat/completions';
    }

    const upstreamUrl = buildUpstreamUrl(upstreamBase, upstreamPath);
    const isStream = reqBody?.stream === true;

    console.log(`[Chat] -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, api: ${useAnthropic ? 'anthropic' : 'openai'})`);

    const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, token, useAnthropic);

    addLog(env, ctx, {
      method: 'POST',
      path: '/v1/chat/completions',
      model: originalModel,
      resolvedModel,
      api: useAnthropic ? 'anthropic' : 'openai',
      stream: isStream,
      status: response.status,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
      try {
        return jsonResponse(JSON.parse(errorText), response.status);
      } catch {
        return jsonResponse({ error: { message: `Upstream error: ${response.status}`, type: 'upstream_error' } }, response.status);
      }
    }

    if (isStream) {
      if (useAnthropic) {
        const converter = createAnthropicToChatStreamConverter(resolvedModel);
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        const transformed = response.body.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            const text = decoder.decode(chunk, { stream: true });
            const converted = converter.process(text);
            if (converted) controller.enqueue(encoder.encode(converted));
          },
          flush(controller) {
            const remaining = converter.flush();
            if (remaining) controller.enqueue(encoder.encode(remaining));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          },
        }));

        return new Response(transformed, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...corsHeaders(),
          },
        });
      } else {
        // Pass through OpenAI stream directly
        return new Response(response.body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...corsHeaders(),
          },
        });
      }
    } else {
      const data = await response.text();
      try {
        const upstreamResp = JSON.parse(data);
        if (useAnthropic) {
          return jsonResponse(convertAnthropicToChatCompletion(upstreamResp, resolvedModel));
        } else {
          return jsonResponse(upstreamResp);
        }
      } catch {
        return new Response(data, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
    }
  } catch (err) {
    console.error('Chat handler error:', err.message);
    return jsonResponse({ error: { message: err.message, type: 'proxy_error' } }, 502);
  }
}

// ---- Main Fetch Handler ----

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // API Routes
    if (path === '/health' && request.method === 'GET') {
      return handleHealth();
    }

    if (path === '/v1/models' && request.method === 'GET') {
      return handleModels(request.headers.get('authorization'));
    }

    // Auth: login (verify password)
    if (path === '/api/auth' && request.method === 'POST') {
      if (!passwordLoaded) await loadPasswordFromDb(env);
      const body = await request.json();
      if (body.password === getPassword()) {
        return jsonResponse({ success: true, message: '登录成功' });
      }
      return jsonResponse({ error: { message: '密码错误' } }, 401);
    }

    // Auth: change password
    if (path === '/api/auth/change' && request.method === 'POST') {
      if (!passwordLoaded) await loadPasswordFromDb(env);
      const body = await request.json();
      if (body.oldPassword !== getPassword()) {
        return jsonResponse({ error: { message: '当前密码错误' } }, 401);
      }
      if (!body.newPassword || body.newPassword.length < 4) {
        return jsonResponse({ error: { message: '新密码至少 4 位' } }, 400);
      }
      runtimePassword = body.newPassword;
      if (env.DB) {
        try {
          await ensureDbTable(env);
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('web_password', runtimePassword).run();
        } catch (e) { console.error('Save password error:', e.message); }
      }
      return jsonResponse({ success: true, message: '密码已修改' });
    }

    // Load password for protected routes
    if (!passwordLoaded) await loadPasswordFromDb(env);

    if (path === '/api/default-model' && request.method === 'GET') {
      return handleGetDefaultModel(env);
    }

    if (path === '/api/default-model' && request.method === 'POST') {
      if (!checkAuth(request)) return jsonResponse({ error: { message: '未授权，请输入密码' } }, 401);
      return handleSetDefaultModel(request, env);
    }

    if (path === '/api/logs' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ logs: [], total: 0, error: 'DB binding not found' });
      try {
        await ensureDbTable(env);
        const since = parseInt(url.searchParams.get('since') || '0');
        const total = await env.DB.prepare('SELECT COUNT(*) as cnt FROM logs').first('cnt');
        const result = since
          ? await env.DB.prepare('SELECT * FROM logs WHERE id > ? ORDER BY id ASC LIMIT 100').bind(since).all()
          : await env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 50').all();
        const logs = (result.results || []).map(r => ({
          id: r.id, time: r.time, method: r.method, path: r.path,
          model: r.model, resolvedModel: r.resolved_model,
          api: r.api, stream: !!r.stream, status: r.status,
        }));
        if (!since) logs.reverse();
        return jsonResponse({ logs, total });
      } catch (e) {
        console.error('Logs read error:', e.message);
        return jsonResponse({ logs: [], total: 0, error: e.message });
      }
    }

    if (path === '/api/logs' && request.method === 'DELETE') {
      if (!checkAuth(request)) return jsonResponse({ error: { message: '未授权，请输入密码' } }, 401);
      if (env.DB) {
        try {
          await ensureDbTable(env);
          await env.DB.exec('DELETE FROM logs');
        } catch (e) {
          console.error('Logs clear error:', e.message);
        }
      }
      return jsonResponse({ success: true, message: '日志已清空' });
    }

    if (path === '/api/model-map' && request.method === 'GET') {
      if (!modelMapLoaded && env.DB) await loadModelMapFromDb(env);
      return jsonResponse({
        modelMap: { ...runtimeModelMap },
        anthropicModels: [...ANTHROPIC_MODELS],
      });
    }

    if (path === '/api/model-map' && request.method === 'POST') {
      if (!checkAuth(request)) return jsonResponse({ error: { message: '未授权，请输入密码' } }, 401);
      const body = await request.json();
      const { from, to } = body;
      if (!from || !to) {
        return jsonResponse({ error: { message: 'from 和 to 字段必填' } }, 400);
      }
      runtimeModelMap[from] = to;
      if (env.DB) {
        try {
          await ensureDbTable(env);
          await env.DB.prepare('INSERT OR REPLACE INTO model_map (from_model, to_model) VALUES (?, ?)').bind(from, to).run();
        } catch (e) { console.error('Save model map error:', e.message); }
      }
      return jsonResponse({ success: true, message: `已添加映射: ${from} \u2192 ${to}`, modelMap: { ...runtimeModelMap } });
    }

    if (path === '/api/model-map' && request.method === 'DELETE') {
      if (!checkAuth(request)) return jsonResponse({ error: { message: '未授权，请输入密码' } }, 401);
      const body = await request.json();
      const { from } = body;
      if (!from) {
        return jsonResponse({ error: { message: 'from 字段必填' } }, 400);
      }
      delete runtimeModelMap[from];
      if (env.DB) {
        try {
          await ensureDbTable(env);
          await env.DB.prepare('DELETE FROM model_map WHERE from_model = ?').bind(from).run();
        } catch (e) { console.error('Delete model map error:', e.message); }
      }
      return jsonResponse({ success: true, message: `已删除映射: ${from}`, modelMap: { ...runtimeModelMap } });
    }

    if (path === '/api/upstream-url' && request.method === 'GET') {
      if (!settingsLoaded && env.DB) await loadSettingsFromDb(env);
      return jsonResponse({
        current: getUpstreamUrl(env),
        default: DEFAULT_UPSTREAM,
        custom: runtimeUpstreamUrl || null,
      });
    }

    if (path === '/api/upstream-url' && request.method === 'POST') {
      if (!checkAuth(request)) return jsonResponse({ error: { message: '未授权，请输入密码' } }, 401);
      const body = await request.json();
      const { url } = body;
      if (!url) {
        return jsonResponse({ error: { message: 'url 字段必填' } }, 400);
      }
      runtimeUpstreamUrl = url.replace(/\/+$/, '');
      if (env.DB) {
        try {
          await ensureDbTable(env);
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('upstream_url', runtimeUpstreamUrl).run();
        } catch (e) { console.error('Save upstream url error:', e.message); }
      }
      settingsLoaded = true;
      return jsonResponse({ success: true, message: `上游地址已设置为: ${runtimeUpstreamUrl}`, url: runtimeUpstreamUrl });
    }

    if (path === '/api/upstream-url' && request.method === 'DELETE') {
      if (!checkAuth(request)) return jsonResponse({ error: { message: '未授权，请输入密码' } }, 401);
      runtimeUpstreamUrl = null;
      settingsLoaded = true;
      if (env.DB) {
        try {
          await ensureDbTable(env);
          await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('upstream_url').run();
        } catch (e) { console.error('Delete upstream url error:', e.message); }
      }
      return jsonResponse({ success: true, message: '已恢复默认上游地址', url: env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM });
    }

    if (path === '/api/token-limits' && request.method === 'GET') {
      if (!tokenLimitsLoaded) await loadTokenLimitsFromDb(env);
      return jsonResponse({
        maxContextTokens: runtimeMaxContextTokens,
        maxOutputTokens: runtimeMaxOutputTokens,
      });
    }

    if (path === '/api/token-limits' && request.method === 'POST') {
      if (!checkAuth(request)) return jsonResponse({ error: { message: '未授权，请输入密码' } }, 401);
      const body = await request.json();
      const { maxContextTokens, maxOutputTokens } = body;
      if (maxContextTokens !== undefined) {
        runtimeMaxContextTokens = maxContextTokens ? parseInt(maxContextTokens) : null;
        if (env.DB) {
          try {
            await ensureDbTable(env);
            if (runtimeMaxContextTokens) {
              await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('max_context_tokens', String(runtimeMaxContextTokens)).run();
            } else {
              await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('max_context_tokens').run();
            }
          } catch (e) { console.error('Save max context tokens error:', e.message); }
        }
      }
      if (maxOutputTokens !== undefined) {
        runtimeMaxOutputTokens = maxOutputTokens ? parseInt(maxOutputTokens) : null;
        if (env.DB) {
          try {
            await ensureDbTable(env);
            if (runtimeMaxOutputTokens) {
              await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('max_output_tokens', String(runtimeMaxOutputTokens)).run();
            } else {
              await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('max_output_tokens').run();
            }
          } catch (e) { console.error('Save max output tokens error:', e.message); }
        }
      }
      return jsonResponse({
        success: true,
        message: 'Token 限制已更新',
        maxContextTokens: runtimeMaxContextTokens,
        maxOutputTokens: runtimeMaxOutputTokens,
      });
    }

    if (path === '/v1/responses' && request.method === 'POST') {
      return handleResponses(request, env, ctx);
    }

    if (path === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env, ctx);
    }

    // For /v1/* routes that don't match, return 404
    if (path.startsWith('/v1/')) {
      return jsonResponse({ error: { message: `Route ${request.method} ${path} not found` } }, 404);
    }

    // Serve index.html for root and other non-API routes
    if (path === '/' || path === '/index.html' || path === '/favicon.ico') {
      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }
      return new Response(indexHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
      });
    }

    return jsonResponse({ error: { message: `Route ${request.method} ${path} not found` } }, 404);
  },
};

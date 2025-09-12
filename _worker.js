/**
 * @file Cloudflare Worker for chat.z.ai API Proxy
 * @author (Your Name or Alias)
 * @version 1.1.0 (Fixed content duplication issue)
 *
 * @description
 * 这是一个部署在 Cloudflare Workers 上的代理脚本，旨在将符合 OpenAI API 格式的请求
 * 转换为 chat.z.ai 的 API 格式，并返回兼容 OpenAI 的响应。
 *
 * 主要功能:
 * 1.  **OpenAI API 兼容**: 提供 /v1/models 和 /v1/chat/completions 两个标准端点，
 *     可直接接入各种支持 OpenAI API 的客户端。
 * 2.  **模拟思考过程**: 将 chat.z.ai 特有的 "thinking" 阶段，巧妙地转换为 OpenAI
 *     的 `tool_calls` 格式。这使得在支持的客户端UI上，可以实时展示模型的思考步骤，
 *     极大地提升了用户体验。
 * 3.  **模型固定**: 所有传入的聊天请求，无论客户端指定何种模型，都会被强制代理到
 *     后端的 GLM-4.5 模型。
 * 4.  **双重认证模式**: 提供了灵活的认证机制，既支持为所有用户设置一个统一的访问密钥，
 *     也支持让用户直接使用自己的 chat.z.ai 令牌。
 * 5.  **流式与非流式支持**: 同时支持流式（server-sent events）和非流式（JSON）响应。
 * 6.  **内容去重**: 修复了上游API在从思考转为回答阶段时，会重复发送思考内容的问题。
 *
 * ---
 *
 * 环境变量设置 (Cloudflare Worker -> Settings -> Variables):
 *
 * ### 认证模式配置 (二选一)
 *
 * #### 模式一: 固定密钥模式 (推荐用于公开分享)
 *   - 设置 `DEFAULT_KEY` 和 `UPSTREAM_TOKEN` 这两个变量。
 *   - **DEFAULT_KEY**: 客户端访问此 Worker 时必须提供的 API Key。
 *     - 示例: `sk-my-custom-key-for-all-users`
 *   - **UPSTREAM_TOKEN**: Worker 用于访问上游 chat.z.ai 的固定令牌。
 *     - 示例: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (从 chat.z.ai 获取的真实令牌)
 *   - **工作流程**: 用户请求时 `Authorization` 头必须是 `Bearer sk-my-custom-key...`，
 *     Worker 验证通过后，会使用 `UPSTREAM_TOKEN` 去请求 chat.z.ai。
 *
 * #### 模式二: 动态令牌模式 (用于自用或授权用户)
 *   - **不要** 设置 `DEFAULT_KEY` 和 `UPSTREAM_TOKEN`。
 *   - **工作流程**: Worker 会直接将客户端请求头 `Authorization` 中的 Bearer Token
 *     透传给上游 chat.z.ai。用户需要自行提供有效的 chat.z.ai 令牌。
 *
 * ### 其他可选配置
 *
 *   - **UPSTREAM_URL**: (可选) chat.z.ai 的 API 地址。
 *     - 默认值: `https://chat.z.ai/api/chat/completions`
 *
 *   - **DEBUG_MODE**: (可选) 是否开启调试模式，在 Worker 日志中输出详细信息。
 *     - 默认值: `false`
 *     - 示例值: `true`
 *
 *   - **DEFAULT_STREAM**: (可选) 当客户端请求中未明确指定 `stream` 参数时，默认是否使用流式响应。
 *     - 默认值: `true`
 *     - 示例值: `false`
 *
 *   - **THINK_TAGS_MODE**: (可选) 处理思考标签的模式。为了正确模拟 `tool_calls`，
 *     此值应保持默认。
 *     - 默认值: `strip` (剥离 `<thinking>` 等标签)
 *
 */

// =================================================
// Cloudflare Worker for chat.z.ai
//
// 混合认证模式 + 模拟思考过程
// 1. 如果设置了 `DEFAULT_KEY` 和 `UPSTREAM_TOKEN` 环境变量:
//    - 客户端必须使用 `DEFAULT_KEY` 作为 API Key。
//    - Worker 使用 `UPSTREAM_TOKEN` 访问上游。
// 2. 如果未设置上述环境变量:
//    - 客户端提供的 API Key 将被直接用作访问上游的 Token。
//
// 特性:
// - 将上游的 "thinking" 阶段模拟成 OpenAI 的 tool_calls，在UI上显示为思考过程。
// - 所有模型请求都代理到 GLM-4.5。
// =================================================

// --- 配置 (环境变量，如果未设置则使用默认值) ---
const UPSTREAM_URL_DEFAULT = "https://chat.z.ai/api/chat/completions";
const DEBUG_MODE_DEFAULT = "false";
const DEFAULT_STREAM_DEFAULT = "true";
const THINK_TAGS_MODE_DEFAULT = "strip"; // 必须是 strip 才能正确提取思考文本

// --- 上游模型信息 (硬编码为GLM-4.5) ---
const UPSTREAM_MODEL_ID = "0727-360B-API";
const UPSTREAM_MODEL_NAME = "GLM-4.5";

// --- 伪装浏览器头部 ---
const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
    "Accept": "application/json, text/event-stream",
    "Accept-Language": "zh-CN,zh;q=0.9",  // 修复：添加权重参数
    "X-FE-Version": "prod-fe-1.0.70",
    "sec-ch-ua": "\"Not;A=Brand\";v=\"99\", \"Microsoft Edge\";v=\"139\", \"Chromium\";v=\"139\"",  // 新增：关键签名头部
    "sec-ch-ua-mobile": "?0",  // 新增：移动设备标识
    "sec-ch-ua-platform": "\"Windows\"",  // 新增：平台标识
    "Origin": "https://chat.z.ai",
};


export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return handleOptions();
        }

        const url = new URL(request.url);
        switch (url.pathname) {
            case '/v1/models':
                return handleModels(request);
            case '/v1/chat/completions':
                return handleChatCompletions(request, env);
            default:
                return new Response('Not Found', { status: 404 });
        }
    },
};

function handleOptions() {
    return new Response(null, { headers: corsHeaders() });
}

function handleModels(request) {
    const modelsResponse = {
        object: 'list',
        data: [{ id: 'glm-4.5', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'z.ai' }],
    };
    return new Response(JSON.stringify(modelsResponse), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
}

async function handleChatCompletions(request, env) {
    // 读取环境变量或使用默认值
    const UPSTREAM_URL = env.UPSTREAM_URL || UPSTREAM_URL_DEFAULT;
    const DEBUG_MODE = (env.DEBUG_MODE || DEBUG_MODE_DEFAULT) === "true";
    const DEFAULT_STREAM = (env.DEFAULT_STREAM || DEFAULT_STREAM_DEFAULT) === "true";
    const THINK_TAGS_MODE = env.THINK_TAGS_MODE || THINK_TAGS_MODE_DEFAULT;
    
    debugLog(DEBUG_MODE, "收到 chat completions 请求");

    const clientKey = request.headers.get('Authorization')?.substring(7);
    if (!clientKey) {
        return new Response('Missing Authorization header.', { status: 401, headers: corsHeaders() });
    }

    let upstreamToken;
    const { DEFAULT_KEY, UPSTREAM_TOKEN } = env;

    // --- 认证逻辑 ---
    if (DEFAULT_KEY && UPSTREAM_TOKEN) {
        debugLog(DEBUG_MODE, "检测到固定Key模式");
        if (clientKey !== DEFAULT_KEY) {
            debugLog(DEBUG_MODE, `认证失败: 客户端Key不匹配`);
            return new Response('Invalid API key.', { status: 401, headers: corsHeaders() });
        }
        upstreamToken = UPSTREAM_TOKEN;
        debugLog(DEBUG_MODE, `认证成功，使用固定的UPSTREAM_TOKEN`);
    } else {
        debugLog(DEBUG_MODE, "使用动态Token模式");
        upstreamToken = clientKey;
    }

    let openaiRequest;
    try {
        openaiRequest = await request.json();
    } catch (e) {
        return new Response('Invalid JSON.', { status: 400, headers: corsHeaders() });
    }
    
    const useStream = openaiRequest.stream === undefined ? DEFAULT_STREAM : openaiRequest.stream;
    const requestedModel = openaiRequest.model;
    debugLog(DEBUG_MODE, `请求模型: ${requestedModel}, 代理到: ${UPSTREAM_MODEL_NAME}, 流式: ${useStream}`);
    
    const chatID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const upstreamRequest = {
        stream: true, model: UPSTREAM_MODEL_ID,
        model_item: { id: UPSTREAM_MODEL_ID, name: UPSTREAM_MODEL_NAME, owned_by: "z.ai" },
        messages: openaiRequest.messages, params: {}, features: { "enable_thinking": true },
        chat_id: chatID, id: `${Date.now()}`,
    };
    
    const upstreamResponse_ = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: {
            ...BROWSER_HEADERS, 'Content-Type': 'application/json',
            'Authorization': `Bearer ${upstreamToken}`, 'Referer': `https://chat.z.ai/c/${chatID}`,
        },
        body: JSON.stringify(upstreamRequest),
    });
    
const upstreamResponse = await fetch(UPSTREAM_URL, {
    method: 'POST',
    headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${upstreamToken}`,
        'Referer': `https://chat.z.ai/c/${chatID}`,  // 保持这个动态 Referer
    },
    body: JSON.stringify(upstreamRequest),
});

    if (!upstreamResponse.ok) {
        const errorBody = await upstreamResponse.text();
        debugLog(DEBUG_MODE, `上游错误: ${upstreamResponse.status}, ${errorBody}`);
        return new Response(errorBody, { status: upstreamResponse.status, headers: corsHeaders() });
    }
    
    if (useStream) {
        const { readable, writable } = new TransformStream();
        streamUpstreamToOpenAI(upstreamResponse.body, writable, { DEBUG_MODE, THINK_TAGS_MODE, requestedModel });
        return new Response(readable, {
            headers: { ...corsHeaders(), 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        });
    } else {
        const finalContent = await aggregateStream(upstreamResponse.body, { DEBUG_MODE, THINK_TAGS_MODE });
        const nonStreamResponse = {
            id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{
                index: 0, message: { role: 'assistant', content: finalContent }, finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        return new Response(JSON.stringify(nonStreamResponse), {
            headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        });
    }
}

// =================================================================
// 核心流处理函数 - 修复版
// =================================================================
async function streamUpstreamToOpenAI(readableStream, writable, options) {
    const { DEBUG_MODE, THINK_TAGS_MODE, requestedModel } = options;
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    // 状态管理
    let streamState = 'init'; // 'init', 'thinking', 'answering'
    const toolCallId = `call_${Date.now()}`;

    // 发送初始 role chunk
    const firstChunk = {
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant' } }],
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
    
    const reader = readableStream.getReader();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.substring(6);
            if (!dataStr) continue;

            try {
                const upstreamData = JSON.parse(dataStr);
                const data = upstreamData.data || {};
                
                if (data.done || data.phase === 'done') {
                    // 通用结束处理
                    break; // 直接跳出循环，最后统一发送 [DONE]
                }

                const phase = data.phase;
                let content = data.delta_content || data.edit_content || '';
                
                // 状态机逻辑
                if (phase === 'thinking' && content) {
                    if (streamState === 'init') {
                        // 首次进入 thinking 状态，发送 tool_calls 起始块
                        streamState = 'thinking';
                        const startToolCallChunk = {
                            id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                            model: requestedModel,
                            choices: [{
                                index: 0, delta: {
                                    tool_calls: [{
                                        index: 0, id: toolCallId, type: 'function',
                                        function: { name: 'thought_process', arguments: '' }
                                    }]
                                }
                            }]
                        };
                        await writer.write(encoder.encode(`data: ${JSON.stringify(startToolCallChunk)}\n\n`));
                        debugLog(DEBUG_MODE, "模拟思考开始: 发送 tool_calls 起始块");
                    }

                    // 持续发送 thinking 内容
                    const thoughtText = transformThinking(content, "strip");
                    if (thoughtText) {
                        const thoughtChunk = {
                            id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                            model: requestedModel,
                            choices: [{
                                index: 0, delta: {
                                    tool_calls: [{
                                        index: 0, type: 'function',
                                        function: { arguments: thoughtText }
                                    }]
                                }
                            }]
                        };
                        await writer.write(encoder.encode(`data: ${JSON.stringify(thoughtChunk)}\n\n`));
                    }
                } else if (phase === 'answer' && content) {
                    if (streamState !== 'answering') {
                        streamState = 'answering';
                        debugLog(DEBUG_MODE, "进入回答阶段");
                    }
                    
                    // <<< FIX START >>>
                    // 核心修复逻辑：处理从 thinking 到 answer 的过渡块，它包含了重复的思考过程。
                    // 我们通过查找 '</details>' 标签来定位并只取真正的回答部分。
                    let processedContent = content;
                    const detailsEndTag = '</details>';
                    const detailsEndIndex = processedContent.indexOf(detailsEndTag);
                    
                    if (detailsEndIndex !== -1) {
                        // 如果找到了 'details' 结束标签，说明这是那个特殊的过渡块
                        // 我们只取标签之后的内容
                        processedContent = processedContent.substring(detailsEndIndex + detailsEndTag.length);
                    }
                    // <<< FIX END >>>

                    const answerText = transformThinking(processedContent, "strip");
                    if (answerText) {
                        const answerChunk = {
                            id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                            model: requestedModel,
                            choices: [{ index: 0, delta: { content: answerText } }]
                        };
                        await writer.write(encoder.encode(`data: ${JSON.stringify(answerChunk)}\n\n`));
                    }
                }

            } catch (e) {
                debugLog(DEBUG_MODE, `SSE解析失败: ${e}, data: ${dataStr}`);
            }
        }
    }
    
    // 发送最终的 finish_reason chunk
    const endChunk = {
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));

    // 确保流在任何情况下都正确关闭
    await writer.write(encoder.encode('data: [DONE]\n\n'));
    await writer.close();
}


// --- 辅助函数 ---

async function aggregateStream(readableStream, options) {
    const { DEBUG_MODE, THINK_TAGS_MODE } = options;
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let hasCleanedFirstAnswerChunk = false; // 状态标志，确保只清理一次

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.substring(6);
            if (!dataStr) continue;
            try {
                const upstreamData = JSON.parse(dataStr);
                if (upstreamData.data?.phase === 'answer') {
                    let content = upstreamData.data?.delta_content || upstreamData.data?.edit_content || '';
                    
                    // <<< FIX START >>>
                    // 为非流式响应添加同样的修复逻辑
                    if (!hasCleanedFirstAnswerChunk) {
                        const detailsEndTag = '</details>';
                        const detailsEndIndex = content.indexOf(detailsEndTag);
                        if (detailsEndIndex !== -1) {
                            content = content.substring(detailsEndIndex + detailsEndTag.length);
                            hasCleanedFirstAnswerChunk = true; // 标记已清理
                        }
                    }
                    // <<< FIX END >>>

                    if (content) {
                       fullContent += transformThinking(content, "strip");
                    }
                }
                if (upstreamData.data?.done || upstreamData.data?.phase === 'done') {
                    // 清理最终结果中可能残留的未剥离的标签
                    return transformThinking(fullContent, "strip");
                }
            } catch (e) { /* 忽略解析错误 */ }
        }
    }
    // 清理最终结果中可能残留的未剥离的标签
    return transformThinking(fullContent, "strip");
}

function transformThinking(s, mode) {
    if (!s) return "";
    s = s.replace(/<summary>.*?<\/summary>/gs, '').replace(/<\/thinking>|<Full>|<\/Full>/g, '').trim();
    if (mode === "strip") {
        s = s.replace(/<details[^>]*>|<\/details>/g, '');
    }
    s = s.startsWith('> ') ? s.substring(2) : s;
    s = s.replace(/\n> /g, '\n');
    return s.trim();
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
}

function debugLog(isDebug, message) {
    if (isDebug) console.log(`[DEBUG] ${new Date().toISOString()}: ${message}`);
}

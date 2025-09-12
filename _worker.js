/**
 * @file Cloudflare Worker for chat.z.ai API Proxy
 * @author (Your Name or Alias)
 * @version 1.1.2 (Fixed upstream request body structure)
 *
 * @description
 * ... (Description remains the same) ...
 */

// =================================================
// Cloudflare Worker for chat.z.ai
// ... (Comments remain the same) ...
// =================================================

// --- 配置 (环境变量，如果未设置则使用默认值) ---
const UPSTREAM_URL_DEFAULT = "https://chat.z.ai/api/chat/completions";
const DEBUG_MODE_DEFAULT = "false";
const DEFAULT_STREAM_DEFAULT = "true";
const THINK_TAGS_MODE_DEFAULT = "strip"; 

// --- 上游模型信息 (硬编码为GLM-4.5) ---
const UPSTREAM_MODEL_ID = "0727-360B-API";
const UPSTREAM_MODEL_NAME = "GLM-4.5";

// --- 伪装浏览器头部 (包含了上次修正的sec-ch-*头部) ---
const SEC_CH_UA = "\"Not;A=Brand\";v=\"99\", \"Microsoft Edge\";v=\"139\", \"Chromium\";v=\"139\"";
const SEC_CH_UA_MOB = "?0";
const SEC_CH_UA_PLAT = "\"Windows\"";

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
    "Accept": "application/json, text/event-stream",
    "Accept-Language": "zh-CN",
    "X-FE-Version": "prod-fe-1.0.70",
    "Origin": "https://chat.z.ai",
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": SEC_CH_UA_MOB,
    "sec-ch-ua-platform": SEC_CH_UA_PLAT,
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
                // --- 核心处理逻辑 ---
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
                
                // <<< 这里是核心修正点：替换了整个 upstreamRequest 对象的构造逻辑 >>>
                const chatID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
                const msgID = `${Date.now()}`;

                const upstreamRequest = {
                    stream: true,
                    chat_id: chatID,
                    id: msgID,
                    model: UPSTREAM_MODEL_ID,
                    messages: openaiRequest.messages,
                    params: {
                        top_p: 0.95,
                        temperature: 0.6,
                        max_tokens: 80000
                    },
                    features: {
                        enable_thinking: true,
                        image_generation: false,
                        web_search: false,
                        auto_web_search: false,
                        preview_mode: false
                    },
                    background_tasks: {
                        title_generation: false,
                        tags_generation: false
                    },
                    mcp_servers: [],
                    model_item: {
                        id: UPSTREAM_MODEL_ID,
                        name: UPSTREAM_MODEL_NAME,
                        owned_by: "openai",
                        openai: {
                            id: UPSTREAM_MODEL_ID,
                            name: UPSTREAM_MODEL_ID,
                            owned_by: "openai",
                            openai: { id: UPSTREAM_MODEL_ID },
                            urlIdx: 1
                        },
                        urlIdx: 1,
                        info: {
                            id: UPSTREAM_MODEL_ID,
                            user_id: "api-user",
                            base_model_id: null,
                            name: UPSTREAM_MODEL_NAME,
                            params: { top_p: 0.95, temperature: 0.6 },
                            meta: {
                                profile_image_url: "/static/favicon.png",
                                description: "Most advanced model, proficient in coding and tool use",
                                capabilities: {
                                    vision: false, citations: false, preview_mode: false,
                                    web_search: false, language_detection: false, restore_n_source: false,
                                    mcp: true, file_qa: true, returnFc: true, returnThink: true, think: true
                                }
                            }
                        }
                    },
                    tool_servers: [],
                    variables: {
                        "{{USER_NAME}}": `Guest-${Date.now()}`,
                        "{{USER_LOCATION}}": "Unknown",
                        "{{CURRENT_DATETIME}}": new Date().toLocaleString('zh-CN'),
                        "{{CURRENT_DATE}}": new Date().toLocaleDateString('zh-CN'),
                        "{{CURRENT_TIME}}": new Date().toLocaleTimeString('zh-CN'),
                        "{{CURRENT_WEEKDAY}}": new Date().toLocaleDateString('zh-CN', { weekday: 'long' }),
                        "{{CURRENT_TIMEZONE}}": "Asia/Shanghai",
                        "{{USER_LANGUAGE}}": "zh-CN"
                    }
                };
    
                const upstreamResponse = await fetch(UPSTREAM_URL, {
                    method: 'POST',
                    headers: {
                        ...BROWSER_HEADERS, 'Content-Type': 'application/json',
                        'Authorization': `Bearer ${upstreamToken}`, 'Referer': `https://chat.z.ai/c/${chatID}`,
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

// ... (后面的 streamUpstreamToOpenAI, aggregateStream, 和其他辅助函数保持不变) ...
async function streamUpstreamToOpenAI(readableStream, writable, options) {
    const { DEBUG_MODE, THINK_TAGS_MODE, requestedModel } = options;
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    let streamState = 'init'; 
    const toolCallId = `call_${Date.now()}`;

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
                    break;
                }

                const phase = data.phase;
                let content = data.delta_content || data.edit_content || '';
                
                if (phase === 'thinking' && content) {
                    if (streamState === 'init') {
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
                    
                    let processedContent = content;
                    const detailsEndTag = '</details>';
                    const detailsEndIndex = processedContent.indexOf(detailsEndTag);
                    
                    if (detailsEndIndex !== -1) {
                        processedContent = processedContent.substring(detailsEndIndex + detailsEndTag.length);
                    }

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
    
    const endChunk = {
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));

    await writer.write(encoder.encode('data: [DONE]\n\n'));
    await writer.close();
}


async function aggregateStream(readableStream, options) {
    const { DEBUG_MODE, THINK_TAGS_MODE } = options;
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let hasCleanedFirstAnswerChunk = false; 

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
                    
                    if (!hasCleanedFirstAnswerChunk) {
                        const detailsEndTag = '</details>';
                        const detailsEndIndex = content.indexOf(detailsEndTag);
                        if (detailsEndIndex !== -1) {
                            content = content.substring(detailsEndIndex + detailsEndTag.length);
                            hasCleanedFirstAnswerChunk = true;
                        }
                    }

                    if (content) {
                       fullContent += transformThinking(content, "strip");
                    }
                }
                if (upstreamData.data?.done || upstreamData.data?.phase === 'done') {
                    return transformThinking(fullContent, "strip");
                }
            } catch (e) { /* 忽略解析错误 */ }
        }
    }
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

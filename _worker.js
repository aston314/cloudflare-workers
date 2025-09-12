/**
 * @file Cloudflare Worker for chat.z.ai API Proxy - FIXED VERSION
 * @version 1.1.1 (Fixed Missing signature header issue)
 */


// --- 配置 ---
const UPSTREAM_URL_DEFAULT = "https://chat.z.ai/api/chat/completions";
const DEBUG_MODE_DEFAULT = "false";
const DEFAULT_STREAM_DEFAULT = "true";
const THINK_TAGS_MODE_DEFAULT = "strip";
const ANON_TOKEN_ENABLED = true; // 关键：启用匿名token

// --- 上游模型信息 ---
const UPSTREAM_MODEL_ID = "0727-360B-API";
const UPSTREAM_MODEL_NAME = "GLM-4.5";

// --- 完整的浏览器头部 ---
const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
    "Accept": "application/json, text/event-stream",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "X-FE-Version": "prod-fe-1.0.70",
    "sec-ch-ua": "\"Not;A=Brand\";v=\"99\", \"Microsoft Edge\";v=\"139\", \"Chromium\";v=\"139\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "Origin": "https://chat.z.ai",
};

// --- 关键：添加匿名token获取功能 ---
async function getAnonymousToken() {
    try {
        const response = await fetch("https://chat.z.ai/api/v1/auths/", {
            method: "GET",
            headers: {
                ...BROWSER_HEADERS,
                "Referer": "https://chat.z.ai/"
            }
        });
        
        if (!response.ok) {
            throw new Error(`Anonymous token request failed with status ${response.status}`);
        }
        
        const data = await response.json();
        if (!data.token) {
            throw new Error("Anonymous token is empty");
        }
        
        return data.token;
    } catch (error) {
        console.log("获取匿名token失败:", error);
        throw error;
    }
}

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

    // --- 修复后的认证逻辑 ---
    if (DEFAULT_KEY && UPSTREAM_TOKEN) {
        debugLog(DEBUG_MODE, "检测到固定Key模式");
        if (clientKey !== DEFAULT_KEY) {
            debugLog(DEBUG_MODE, `认证失败: 客户端Key不匹配`);
            return new Response('Invalid API key.', { status: 401, headers: corsHeaders() });
        }
        upstreamToken = UPSTREAM_TOKEN;
        debugLog(DEBUG_MODE, `使用固定的UPSTREAM_TOKEN`);
    } else {
        debugLog(DEBUG_MODE, "使用动态Token模式，尝试获取匿名token");
        // 关键修复：优先使用匿名token
        if (ANON_TOKEN_ENABLED) {
            try {
                upstreamToken = await getAnonymousToken();
                debugLog(DEBUG_MODE, "匿名token获取成功");
            } catch (error) {
                debugLog(DEBUG_MODE, "匿名token获取失败，使用用户提供的token");
                upstreamToken = clientKey;
            }
        } else {
            upstreamToken = clientKey;
        }
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
    
    // --- 关键修复：使用第一个代码的请求格式 ---
    const upstreamRequest = {
        stream: true,
        chat_id: chatID,
        id: `${Date.now()}`,
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
        }
        // 移除了 model_item 字段
    };
    
    const upstreamResponse = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${upstreamToken}`,
            'Referer': `https://chat.z.ai/c/${chatID}`,
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

// --- 其他函数保持不变 ---
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
            } catch (e) {}
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

/**
 * ST preset keys, derived from ST 1.19.0's `settingsToUpdate` map
 * (public/scripts/openai.js:305-409). The two lists below are generated from
 * that table: TUNING_KEYS = every entry whose 4th flag (isConnection) is
 * false and that maps a real sampler/preset setting; CONNECTION_KEYS = every
 * entry whose 4th flag is true. Kept explicit (not read from ST at runtime)
 * so the plugin and tests can use them without a browser.
 *
 * The plugin never stores or compiles a CONNECTION_KEYS key (roadmap item 19).
 */

/** @type {string[]} Keys that describe generation/tuning behaviour — the tunings layer. */
export const TUNING_KEYS = [
    'temperature',              // preset key: temp_openai
    'frequency_penalty',        // freq_pen_openai
    'presence_penalty',         // pres_pen_openai
    'top_p',                    // top_p_openai
    'top_k',                    // top_k_openai
    'top_a',                    // top_a_openai
    'min_p',                    // min_p_openai
    'repetition_penalty',       // repetition_penalty_openai
    'openai_max_context',
    'openai_max_tokens',
    'max_context_unlocked',
    'stream_openai',
    'seed',
    'n',
    'reasoning_effort',
    'verbosity',
    'show_thoughts',
    'squash_system_messages',
    'continue_prefill',
    'function_calling',
    'enable_web_search',
    'request_images',
];

/** @type {string[]} Keys that describe a connection — never stored, never compiled. */
export const CONNECTION_KEYS = [
    'chat_completion_source',
    'group_models',
    'sort_models',
    'openai_model',
    'claude_model',
    'openrouter_model',
    'openrouter_use_fallback',
    'openrouter_providers',
    'openrouter_quantizations',
    'openrouter_allow_fallbacks',
    'openrouter_middleout',
    'ai21_model',
    'mistralai_model',
    'cohere_model',
    'perplexity_model',
    'groq_model',
    'chutes_model',
    'siliconflow_model',
    'siliconflow_endpoint',
    'minimax_model',
    'minimax_endpoint',
    'electronhub_model',
    'nanogpt_model',
    'nanogpt_provider',
    'nanogpt_payg_override',
    'deepseek_model',
    'aimlapi_model',
    'xai_model',
    'pollinations_model',
    'pollinations_endpoint',
    'moonshot_model',
    'fireworks_model',
    'cometapi_model',
    'custom_model',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'custom_prompt_post_processing',
    'google_model',
    'vertexai_model',
    'zai_model',
    'zai_endpoint',
    'workers_ai_model',
    'workers_ai_account_id',
    'reverse_proxy',
    'show_external_models',
    'proxy_password',
    'vertexai_auth_mode',
    'vertexai_region',
    'vertexai_express_project_id',
    'bypass_status_check',
    'azure_base_url',
    'azure_deployment_name',
    'azure_api_version',
    'azure_openai_model',
];

/**
 * Every key ST presets carry besides prompts/prompt_order (i.e. the value
 * side of settingsToUpdate minus the modeled prompt fields). Used by compile
 * to pick the base and by the panel diff to classify unknown keys.
 * @type {Set<string>}
 */
export const PRESET_SETTING_KEYS = new Set([...TUNING_KEYS, ...CONNECTION_KEYS, 'extensions']);

/** @param {string} key */
export function isConnectionKey(key) {
    return CONNECTION_KEYS.includes(key);
}

/** @param {string} key */
export function isTuningKey(key) {
    return TUNING_KEYS.includes(key);
}

/**
 * The prompt-manager fields ST stores per prompt. `identifier`, `name`,
 * `content`, `role`, `enabled` are modeled explicitly; everything else
 * (injection_position, injection_depth, marker, system_prompt, …) rides in
 * `fields` verbatim.
 * @type {string[]}
 */
export const MODELED_PROMPT_KEYS = ['identifier', 'name', 'content', 'role', 'enabled'];

/** ST's fixed marker identifiers (openai.js chatCompletionDefaultPrompts). */
export const ST_MARKER_IDS = [
    'worldInfoBefore',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'personaDescription',
    'scenario',
    'dialogueExamples',
    'chatHistory',
];

/** @param {string} identifier */
export function isStMarkerIdentifier(identifier) {
    return ST_MARKER_IDS.includes(identifier);
}

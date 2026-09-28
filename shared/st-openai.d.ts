/**
 * Ambient declaration for ST's own public/scripts/openai.js as seen from the
 * extension (ext/st.js imports it relatively as `../openai.js` when mounted
 * under public/scripts/extensions/third-party/st-preset-manager/). Only the
 * exports the extension consumes are declared; tsc --checkJs never resolves
 * ST's own tree.
 */
declare module '*/openai.js' {
    /** Resolves when the currently pending preset application completes (openai.js:5015). */
    export function getPresetApplicationPromise(): Promise<void>;
    /** Build the settingsToUpdate view of an oai_settings object (openai.js:4582). */
    export function getChatCompletionPreset(settings: unknown): Record<string, unknown>;
}

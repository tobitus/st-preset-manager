/**
 * Import/Export tab pure logic (Phase 3): turn a picked or dropped file into
 * a `POST /presets` body, and a preset name + format into a download file
 * name. Browser-safe: NO imports — this module is loaded directly by the
 * extension (ext/tabs/io.js imports it via `../../shared/io.js`) as well as
 * by node:test.
 */

export const NATIVE_FORMAT = 'st-preset-manager/library';

/**
 * @param {string} fileName original file name (used for the ST import's
 *   name/sourceRef, and for the error message)
 * @param {string} text raw file contents
 * @param {{ replace?: boolean }} [opts]
 * @returns {{ body?: any, error?: string }} a `POST /presets` body, or an
 *   error to show without calling the server. A non-preset JSON value is
 *   NOT rejected here — it is sent to the server as `{st}` so the plugin's
 *   recognizer answers the 400.
 */
export function importBodyFromFile(fileName, text, { replace } = {}) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { error: `${fileName}: not valid JSON (${/** @type {Error} */ (e).message})` };
    }
    const isNative = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && parsed.format === NATIVE_FORMAT;
    const body = isNative
        ? { native: parsed }
        : { st: parsed, name: fileName.replace(/\.[^/.]+$/, ''), sourceRef: `upload:${fileName}` };
    if (replace) body.replace = true;
    return { body };
}

/**
 * @param {string} name preset name (ST names an imported preset after its
 *   file name, so the `st` export file must be exactly `<name>.json`)
 * @param {'st'|'native'} format
 * @returns {string} a safe download file name
 */
export function exportFileName(name, format) {
    // eslint-disable-next-line no-control-regex
    const safe = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    return format === 'native' ? `${safe}.pm-library.json` : `${safe}.json`;
}

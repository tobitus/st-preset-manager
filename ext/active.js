/**
 * "What is SillyTavern running" labels: the window header line and the
 * per-tab not-active notice, both derived from GET /slot's `desired`
 * ({presetId, loadoutId}) where a null loadoutId means the document's
 * active loadout. Names are returned raw; callers set them via textContent.
 */

/**
 * @param {any[]} items GET /library items
 * @param {{presetId?: string|null, loadoutId?: string|null}|null|undefined} desired GET /slot desired
 * @returns {{ presetId: string|null, text: string }}
 */
export function activeLabel(items, desired) {
    const presetId = desired?.presetId;
    if (!presetId) return { presetId: null, text: 'Active in SillyTavern: none' };
    const item = items.find((i) => i.id === presetId);
    if (!item) return { presetId, text: 'Active in SillyTavern: ' + presetId };
    const lid = desired?.loadoutId ?? item.activeLoadoutId;
    const lname = item.loadouts?.find((/** @type {any} */ l) => l.id === lid)?.name;
    return {
        presetId,
        text: lname === undefined
            ? `Active in SillyTavern: ${item.name}`
            : `Active in SillyTavern: ${item.name} \u00b7 ${lname}`,
    };
}

/**
 * @param {string} presetId the tab's preset
 * @param {any} doc its GET /presets/:id doc
 * @param {{presetId?: string|null, loadoutId?: string|null}|null|undefined} desired
 * @returns {string|null}
 */
export function activeNotice(presetId, doc, desired) {
    if (desired?.presetId !== presetId) return 'Not active in SillyTavern';
    const lid = desired.loadoutId ?? doc?.activeLoadoutId;
    if (lid === doc?.activeLoadoutId) return null;
    return `Active in SillyTavern with loadout ${doc?.loadouts?.[lid]?.name ?? lid}`;
}

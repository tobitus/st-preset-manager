/**
 * Diff tab (Phase 5, PLAN §1.8): one page — a top 2-column table (ONE scroll
 * container) showing rows in left order with 'moved from #n' badges, and a
 * bottom line diff of whichever pair is selected (a clicked row, or the pair
 * from the pickers when both sides chose a single block). Pickers let each
 * side choose any open or library preset, any revision of it, and
 * optionally a single block — comparing two whole presets or two single
 * blocks. One generation counter (`gen`) is invalidated by every picker
 * change (preset, rev, or block, either side) and by every Compare; a
 * pending row diff also has its own row generation (`rowGen`), so a row
 * click cancels only a stale row request, never an in-flight Compare, while
 * a new Compare or picker change cancels both. Headers are rendered from
 * the exact selection captured when the request was issued, not from the
 * live selects, so a picker change mid-flight can't relabel a result that
 * belongs to the previous selection.
 */
import { api } from '../st.js';
import { blockOrder } from '../../shared/compare.js';

/** @param {unknown} err @returns {string} */
function errText(err) {
    return /** @type {any} */ (err)?.body?.error ?? (err instanceof Error ? err.message : String(err));
}

/** @param {string} value @param {string} text @returns {HTMLOptionElement} */
function makeOption(value, text) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    return opt;
}

/** @param {string} status @returns {string} */
function stateText(status) {
    if (status === 'only-left') return 'only A';
    if (status === 'only-right') return 'only B';
    return status;
}

/**
 * @typedef {{
 *   presetSelect: HTMLSelectElement,
 *   revSelect: HTMLSelectElement,
 *   blockSelect: HTMLSelectElement,
 *   doc: any,
 *   loadedPresetId: string,
 *   seq: number,
 * }} Side
 */

/**
 * @param {HTMLElement} pane .pm-pane[data-pane="diff"]
 * @param {import('../bridge.js').Bridge} _bridge unused — kept for tab-module signature parity
 * @param {{ openIds: () => string[] }} deps
 * @returns {{ refresh(): Promise<void>, destroy(): void }}
 */
export function createDiffTab(pane, _bridge, { openIds }) {
    let destroyed = false;

    pane.innerHTML = `
        <div class="pm-diff">
            <div class="pm-diff-pickers">
                <div class="pm-diff-side" data-side="a">
                    <span class="pm-diff-side-label">A</span>
                    <select class="pm-diff-preset text_pole"></select>
                    <select class="pm-diff-rev text_pole"></select>
                    <select class="pm-diff-block text_pole"></select>
                </div>
                <div class="pm-diff-side" data-side="b">
                    <span class="pm-diff-side-label">B</span>
                    <select class="pm-diff-preset text_pole"></select>
                    <select class="pm-diff-rev text_pole"></select>
                    <select class="pm-diff-block text_pole"></select>
                </div>
                <button type="button" class="pm-diff-go menu_button">Compare</button>
                <span class="pm-diff-status"></span>
            </div>
            <div class="pm-diff-top">
                <table class="pm-diff-table">
                    <thead><tr><th class="pm-diff-head-left"></th><th class="pm-diff-head-mid"></th><th class="pm-diff-head-right"></th></tr></thead>
                    <tbody class="pm-diff-rows"></tbody>
                    <tbody class="pm-diff-settings"></tbody>
                </table>
            </div>
            <div class="pm-diff-bottom">
                <div class="pm-diff-bottom-head"></div>
                <div class="pm-diff-hunks"></div>
            </div>
        </div>`;

    const statusEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-diff-status'));
    const goBtn = /** @type {HTMLButtonElement} */ (pane.querySelector('.pm-diff-go'));
    const headLeft = /** @type {HTMLElement} */ (pane.querySelector('.pm-diff-head-left'));
    const headMid = /** @type {HTMLElement} */ (pane.querySelector('.pm-diff-head-mid'));
    const headRight = /** @type {HTMLElement} */ (pane.querySelector('.pm-diff-head-right'));
    const rowsBody = /** @type {HTMLElement} */ (pane.querySelector('.pm-diff-rows'));
    const settingsBody = /** @type {HTMLElement} */ (pane.querySelector('.pm-diff-settings'));
    const bottomHead = /** @type {HTMLElement} */ (pane.querySelector('.pm-diff-bottom-head'));
    const hunksEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-diff-hunks'));

    /** @param {'a'|'b'} name @returns {Side} */
    function makeSide(name) {
        const el = /** @type {HTMLElement} */ (pane.querySelector(`.pm-diff-side[data-side="${name}"]`));
        return {
            presetSelect: /** @type {HTMLSelectElement} */ (el.querySelector('.pm-diff-preset')),
            revSelect: /** @type {HTMLSelectElement} */ (el.querySelector('.pm-diff-rev')),
            blockSelect: /** @type {HTMLSelectElement} */ (el.querySelector('.pm-diff-block')),
            doc: null,
            loadedPresetId: '',
            seq: 0,
        };
    }
    const sideA = makeSide('a');
    const sideB = makeSide('b');
    const sides = [sideA, sideB];

    let /** @type {{id: string, name: string}[]} */ libraryItems = [];
    /** @typedef {{ presetId: string, rev: string, blockId: string, name: string }} SideSel */
    /** @type {{ a: SideSel, b: SideSel }|null} */
    let lastCompare = null;
    let gen = 0;
    let rowGen = 0;

    /** Bump the shared generation, invalidating any pending Compare and any pending row request. @returns {number} the new generation */
    function invalidate() {
        return ++gen;
    }

    /** @param {string} text */
    function setError(text) {
        statusEl.classList.add('pm-error');
        statusEl.textContent = text;
    }
    /** @param {string} text */
    function setStatus(text) {
        statusEl.classList.remove('pm-error');
        statusEl.textContent = text;
    }

    /** Rebuild a side's preset <select> (Open + Library groups), keeping the current choice if it still exists. @param {Side} side */
    function fillPresetSelect(side) {
        const current = side.presetSelect.value;
        side.presetSelect.replaceChildren();
        const openList = openIds().filter((id) => libraryItems.some((it) => it.id === id));
        if (openList.length) {
            const grp = document.createElement('optgroup');
            grp.label = 'Open';
            for (const id of openList) {
                const item = /** @type {{id: string, name: string}} */ (libraryItems.find((it) => it.id === id));
                grp.appendChild(makeOption(id, item.name));
            }
            side.presetSelect.appendChild(grp);
        }
        const libGrp = document.createElement('optgroup');
        libGrp.label = 'Library';
        for (const item of libraryItems) {
            libGrp.appendChild(makeOption(item.id, item.name));
        }
        side.presetSelect.appendChild(libGrp);
        const values = Array.from(side.presetSelect.options).map((o) => o.value);
        if (current && values.includes(current)) {
            side.presetSelect.value = current;
        } else if (side === sideA) {
            side.presetSelect.value = libraryItems[0]?.id ?? '';
        } else {
            side.presetSelect.value = sideA.presetSelect.value;
        }
    }

    /** Reload a side's revision list from the API. @param {Side} side @param {number} seq @param {string} [keepRev] value to reselect if still present, else "current" */
    async function loadRevisions(side, seq, keepRev = '') {
        const presetId = side.presetSelect.value;
        side.revSelect.replaceChildren(makeOption('', 'current'));
        if (!presetId) return;
        let revs;
        try {
            revs = await api('GET', `/presets/${presetId}/revisions`);
        } catch (err) {
            if (!destroyed && seq === side.seq) setError(errText(err));
            return;
        }
        if (destroyed || seq !== side.seq) return;
        for (const r of [...revs].reverse()) {
            const label = `#${r.rev} · ${new Date(r.at).toLocaleString()}${r.label ? ` · ${r.label}` : ''}`;
            side.revSelect.appendChild(makeOption(String(r.rev), label));
        }
        const values = Array.from(side.revSelect.options).map((o) => o.value);
        if (keepRev && values.includes(keepRev)) side.revSelect.value = keepRev;
    }

    /** Rebuild a side's block <select> from side.doc, keeping the selected identifier if still present. @param {Side} side */
    function fillBlockOptions(side) {
        const current = side.blockSelect.value;
        side.blockSelect.replaceChildren(makeOption('', '— whole preset —'));
        const doc = side.doc;
        if (doc) {
            const placed = blockOrder(doc);
            const placedIds = new Set(placed.map((p) => p.identifier));
            for (const p of placed) {
                const block = doc.blocks?.[p.identifier];
                side.blockSelect.appendChild(makeOption(p.identifier, `#${p.pos} ${block?.name ?? p.identifier}`));
            }
            for (const [id, block] of Object.entries(doc.blocks ?? {})) {
                if (placedIds.has(id)) continue;
                side.blockSelect.appendChild(makeOption(id, `(unplaced) ${/** @type {any} */ (block)?.name ?? id}`));
            }
        }
        const values = Array.from(side.blockSelect.options).map((o) => o.value);
        side.blockSelect.value = values.includes(current) ? current : '';
    }

    /** Reload a side's doc + block options for its current preset+rev. @param {Side} side @param {number} seq */
    async function loadDoc(side, seq) {
        const presetId = side.presetSelect.value;
        const rev = side.revSelect.value;
        if (!presetId) {
            side.doc = null;
            fillBlockOptions(side);
            return;
        }
        let doc;
        try {
            doc = rev ? (await api('GET', `/presets/${presetId}/revisions/${rev}`)).doc : await api('GET', `/presets/${presetId}`);
        } catch (err) {
            if (!destroyed && seq === side.seq) setError(errText(err));
            return;
        }
        if (destroyed || seq !== side.seq) return;
        side.doc = doc;
        fillBlockOptions(side);
    }

    /** Full reload chain for a side whose preset changed: revisions then doc/blocks. @param {Side} side @param {string} [keepRev] value to reselect if still present, else "current" */
    async function reloadSidePreset(side, keepRev = '') {
        const seq = ++side.seq;
        await loadRevisions(side, seq, keepRev);
        if (destroyed || seq !== side.seq) return;
        await loadDoc(side, seq);
    }

    /** Reload chain for a side whose rev changed: doc/blocks only. @param {Side} side */
    async function reloadSideRev(side) {
        const seq = ++side.seq;
        await loadDoc(side, seq);
    }

    sideA.presetSelect.addEventListener('change', () => {
        invalidate();
        sideA.loadedPresetId = sideA.presetSelect.value;
        void reloadSidePreset(sideA);
    });
    sideB.presetSelect.addEventListener('change', () => {
        invalidate();
        sideB.loadedPresetId = sideB.presetSelect.value;
        void reloadSidePreset(sideB);
    });
    sideA.revSelect.addEventListener('change', () => { invalidate(); void reloadSideRev(sideA); });
    sideB.revSelect.addEventListener('change', () => { invalidate(); void reloadSideRev(sideB); });
    sideA.blockSelect.addEventListener('change', () => invalidate());
    sideB.blockSelect.addEventListener('change', () => invalidate());

    /** @param {{a: SideSel, b: SideSel}} sel */
    function renderHeaders(sel) {
        headLeft.textContent = sel.a.rev ? `${sel.a.name} @#${sel.a.rev}` : sel.a.name;
        headMid.textContent = 'status';
        headRight.textContent = sel.b.rev ? `${sel.b.name} @#${sel.b.rev}` : sel.b.name;
    }

    /** @param {Side} side @param {string} identifier @returns {{identifier: string, name: string, pos?: number}} */
    function blockInfo(side, identifier) {
        const doc = side.doc;
        const block = doc?.blocks?.[identifier];
        const placed = doc ? blockOrder(doc).find((p) => p.identifier === identifier) : undefined;
        return { identifier, name: block?.name ?? identifier, pos: placed?.pos };
    }

    /** @param {{status: string, left?: any, right?: any, fields?: any[], movedFrom?: number}} row @param {number} index @returns {HTMLTableRowElement} */
    function buildRowEl(row, index) {
        const tr = document.createElement('tr');
        tr.className = 'pm-diff-row';
        tr.dataset.status = row.status;
        tr.dataset.row = String(index);
        tr.dataset.left = row.left?.identifier ?? '';
        tr.dataset.right = row.right?.identifier ?? '';

        const tdLeft = document.createElement('td');
        tdLeft.className = 'pm-diff-left';
        if (row.left) {
            if (row.left.pos !== undefined) {
                const pos = document.createElement('span');
                pos.className = 'pm-diff-pos';
                pos.textContent = `#${row.left.pos}`;
                tdLeft.append(pos, ' ');
            }
            const name = document.createElement('span');
            name.className = 'pm-diff-name';
            name.textContent = row.left.name;
            tdLeft.appendChild(name);
        } else {
            tdLeft.classList.add('pm-diff-empty');
        }

        const tdMid = document.createElement('td');
        tdMid.className = 'pm-diff-mid';
        const state = document.createElement('span');
        state.className = 'pm-diff-state';
        state.textContent = stateText(row.status);
        tdMid.appendChild(state);
        if (row.status === 'changed' && row.fields?.length) {
            tdMid.title = row.fields.map((f) => f.key).join(', ');
        }

        const tdRight = document.createElement('td');
        tdRight.className = 'pm-diff-right';
        if (row.right) {
            if (row.right.pos !== undefined) {
                const pos = document.createElement('span');
                pos.className = 'pm-diff-pos';
                pos.textContent = `#${row.right.pos}`;
                tdRight.append(pos, ' ');
            }
            const name = document.createElement('span');
            name.className = 'pm-diff-name';
            name.textContent = row.right.name;
            tdRight.appendChild(name);
            if (row.movedFrom !== undefined) {
                const badge = document.createElement('span');
                badge.className = 'pm-diff-moved';
                badge.textContent = `moved from #${row.movedFrom}`;
                tdRight.appendChild(badge);
            }
        } else {
            tdRight.classList.add('pm-diff-empty');
        }

        tr.append(tdLeft, tdMid, tdRight);
        return tr;
    }

    /** @param {{key: string, a?: any, b?: any}} s @returns {HTMLTableRowElement} */
    function buildSettingRowEl(s) {
        const tr = document.createElement('tr');
        tr.className = 'pm-diff-setting';
        tr.dataset.key = s.key;
        const tdLeft = document.createElement('td');
        tdLeft.className = 'pm-diff-left';
        tdLeft.textContent = 'a' in s ? `${s.key} = ${JSON.stringify(s.a)}` : `${s.key} (absent)`;
        const tdMid = document.createElement('td');
        tdMid.className = 'pm-diff-mid';
        tdMid.textContent = 'setting';
        const tdRight = document.createElement('td');
        tdRight.className = 'pm-diff-right';
        tdRight.textContent = 'b' in s ? `${s.key} = ${JSON.stringify(s.b)}` : `${s.key} (absent)`;
        tr.append(tdLeft, tdMid, tdRight);
        return tr;
    }

    /** @param {any} result full /diff response @param {{a: SideSel, b: SideSel}} sel */
    function renderTable(result, sel) {
        renderHeaders(sel);
        rowsBody.replaceChildren(...result.rows.map((/** @type {any} */ row, /** @type {number} */ i) => buildRowEl(row, i)));
        settingsBody.replaceChildren(...result.settings.map((/** @type {any} */ s) => buildSettingRowEl(s)));
    }

    /** @param {string} status @param {{identifier: string, name: string, pos?: number}} left @param {{identifier: string, name: string, pos?: number}} right @param {{a: SideSel, b: SideSel}} sel */
    function renderBlockPairTable(status, left, right, sel) {
        renderHeaders(sel);
        const tr = buildRowEl({ status, left, right }, 0);
        tr.classList.add('pm-diff-selected');
        rowsBody.replaceChildren(tr);
        settingsBody.replaceChildren();
    }

    /** @param {any} result /diff/blocks response */
    function renderBottom(result) {
        const identicalSuffix = result.hunks.length === 0 ? ' — identical' : '';
        bottomHead.textContent = `${result.a.name} ⇄ ${result.b.name}${identicalSuffix}`;
        hunksEl.replaceChildren();
        if (result.hunks.length === 0) {
            const div = document.createElement('div');
            div.className = 'pm-diff-identical';
            div.textContent = 'No differences.';
            hunksEl.appendChild(div);
            return;
        }
        for (const hunk of result.hunks) {
            const hDiv = document.createElement('div');
            hDiv.className = 'pm-diff-hunk';
            const head = document.createElement('div');
            head.className = 'pm-diff-hunk-head';
            head.textContent = `@@ -${hunk.aStart},${hunk.aLines} +${hunk.bStart},${hunk.bLines} @@`;
            hDiv.appendChild(head);
            for (const line of hunk.lines) {
                const lDiv = document.createElement('div');
                const kind = line.op === ' ' ? 'pm-diff-ctx' : line.op === '-' ? 'pm-diff-del' : 'pm-diff-add';
                lDiv.className = `pm-diff-line ${kind}`;
                const opSpan = document.createElement('span');
                opSpan.className = 'pm-diff-op';
                opSpan.textContent = line.op;
                const textSpan = document.createElement('span');
                textSpan.className = 'pm-diff-text';
                textSpan.textContent = line.text;
                lDiv.append(opSpan, textSpan);
                hDiv.appendChild(lDiv);
            }
            hunksEl.appendChild(hDiv);
        }
    }

    async function doCompare() {
        const my = invalidate();
        const aBlockId = sideA.blockSelect.value;
        const bBlockId = sideB.blockSelect.value;
        if (Boolean(aBlockId) !== Boolean(bBlockId)) {
            setError('Pick a block on both sides, or on neither.');
            return;
        }
        /** @type {{a: SideSel, b: SideSel}} */
        const sel = {
            a: { presetId: sideA.presetSelect.value, rev: sideA.revSelect.value, blockId: aBlockId, name: sideA.presetSelect.selectedOptions[0]?.textContent ?? '' },
            b: { presetId: sideB.presetSelect.value, rev: sideB.revSelect.value, blockId: bBlockId, name: sideB.presetSelect.selectedOptions[0]?.textContent ?? '' },
        };
        try {
            if (aBlockId && bBlockId) {
                const left = blockInfo(sideA, aBlockId);
                const right = blockInfo(sideB, bBlockId);
                const a = { presetId: sel.a.presetId, identifier: aBlockId, ...(sel.a.rev ? { rev: Number(sel.a.rev) } : {}) };
                const b = { presetId: sel.b.presetId, identifier: bBlockId, ...(sel.b.rev ? { rev: Number(sel.b.rev) } : {}) };
                const result = await api('POST', '/diff/blocks', { a, b });
                if (destroyed || my !== gen) return;
                const status = result.hunks.length ? 'changed' : 'same';
                renderBlockPairTable(status, left, right, sel);
                renderBottom(result);
                lastCompare = null;
                setStatus('');
            } else {
                const a = { presetId: sel.a.presetId, ...(sel.a.rev ? { rev: Number(sel.a.rev) } : {}) };
                const b = { presetId: sel.b.presetId, ...(sel.b.rev ? { rev: Number(sel.b.rev) } : {}) };
                const result = await api('POST', '/diff', { a, b });
                if (destroyed || my !== gen) return;
                renderTable(result, sel);
                hunksEl.replaceChildren();
                bottomHead.textContent = 'Click a row to see its line diff.';
                lastCompare = sel;
                const prefix = result.identical ? 'identical · ' : '';
                setStatus(`${prefix}${result.rows.length} rows · ${result.counts.changed} changed · ${result.counts.moved} moved · ${result.counts['only-left']} only A · ${result.counts['only-right']} only B · ${result.settings.length} settings differ`);
            }
        } catch (err) {
            if (destroyed || my !== gen) return;
            setError(errText(err));
        }
    }
    goBtn.addEventListener('click', () => void doCompare());

    /** @param {HTMLElement} tr */
    async function loadBottomForRow(tr) {
        if (!lastCompare) return;
        const my = { g: gen, r: ++rowGen };
        const leftId = tr.dataset.left ?? '';
        const rightId = tr.dataset.right ?? '';
        const a = leftId
            ? { presetId: lastCompare.a.presetId, identifier: leftId, ...(lastCompare.a.rev ? { rev: Number(lastCompare.a.rev) } : {}) }
            : { text: '' };
        const b = rightId
            ? { presetId: lastCompare.b.presetId, identifier: rightId, ...(lastCompare.b.rev ? { rev: Number(lastCompare.b.rev) } : {}) }
            : { text: '' };
        try {
            const result = await api('POST', '/diff/blocks', { a, b });
            if (destroyed || my.g !== gen || my.r !== rowGen) return;
            renderBottom(result);
        } catch (err) {
            if (destroyed || my.g !== gen || my.r !== rowGen) return;
            setError(errText(err));
        }
    }

    rowsBody.addEventListener('click', (ev) => {
        const tr = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (ev.target).closest('.pm-diff-row'));
        if (!tr || !rowsBody.contains(tr)) return;
        for (const r of Array.from(rowsBody.querySelectorAll('.pm-diff-row'))) r.classList.remove('pm-diff-selected');
        tr.classList.add('pm-diff-selected');
        void loadBottomForRow(tr);
    });

    async function refresh() {
        let items;
        try {
            items = await api('GET', '/library');
        } catch (err) {
            if (!destroyed) setError(errText(err));
            return;
        }
        if (destroyed) return;
        libraryItems = [.../** @type {{id: string, name: string}[]} */ (items)].sort((x, y) => x.name.localeCompare(y.name));
        fillPresetSelect(sideA);
        fillPresetSelect(sideB);
        await Promise.all(sides.map((side) => {
            const keep = side.presetSelect.value === side.loadedPresetId ? side.revSelect.value : '';
            side.loadedPresetId = side.presetSelect.value;
            return reloadSidePreset(side, keep);
        }));
    }

    return {
        refresh,
        destroy() {
            destroyed = true;
        },
    };
}

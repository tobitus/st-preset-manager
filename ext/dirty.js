/**
 * The one rule for a text field whose save can be in flight while the user
 * keeps typing, shared by the preset notes (Presets tab) and the shelf notes
 * (Shelf tab): a save clears the dirty flag only when nothing was typed and
 * nothing reset the field since the text it saved was taken.
 */

/**
 * @typedef {object} EditGuard
 * @property {boolean} dirty
 * @property {() => void} edited
 * @property {() => void} reset
 * @property {() => number} token
 * @property {(tok: number) => void} saved
 */

/**
 * @returns {EditGuard}
 */
export function createEditGuard() {
    let dirty = false;
    let rev = 0;
    return {
        get dirty() {
            return dirty;
        },
        edited() {
            dirty = true;
            rev += 1;
        },
        reset() {
            dirty = false;
            rev += 1;
        },
        token() {
            return rev;
        },
        saved(tok) {
            if (rev === tok) {
                dirty = false;
            }
        },
    };
}

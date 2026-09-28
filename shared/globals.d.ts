// Global type declarations for the ST host environment.
// ST attaches `user` (src/users.js setUserDataMiddleware) and our plugin
// attaches `pm` to every express request. `SillyTavern` is a browser global
// installed by ST's script.js.

/**
 * The plugin handle every request carries (plugin/index.js middleware).
 * Defined structurally here so the ambient declaration stays dependency-free.
 */
interface PmHandle {
    store: {
        root: string;
        rev: number;
        /** Global rev at the last desired-slot change (preset/loadout swap) */
        slotChangedRev: number;
        state: Record<string, unknown>;
        models: Record<string, unknown>;
        index: Map<string, unknown>;
        init(): Promise<void>;
        listLibrary(tag?: string): unknown[];
        getPreset(id: string): unknown;
        importPreset(body: unknown): Promise<unknown>;
        savePreset(doc: Record<string, unknown>, opts?: { label?: string }): Promise<unknown>;
        deletePreset(id: string): Promise<void>;
        listRevisions(presetId: string): { rev: number; at: string; label: string | null }[];
        getRevision(presetId: string, rev: number): unknown;
        mutateState(fn: (st: Record<string, unknown>) => void): Promise<unknown>;
        mutateModels(fn: (reg: Record<string, unknown>) => unknown): Promise<unknown>;
        /** slot preset doc without taking the queue (null instead of 404) */
        getDocNow(id: string): Record<string, unknown> | null;
        /** save body WITHOUT taking the queue (call only inside enqueue) */
        _savePresetNow(doc: Record<string, unknown>, opts?: { label?: string }): Promise<unknown>;
        /** state mutation body WITHOUT taking the queue (call only inside enqueue) */
        _mutateStateNow(fn: (st: Record<string, unknown>) => void): Promise<unknown>;
        /** models mutation body WITHOUT taking the queue (call only inside enqueue) */
        _mutateModelsNow(fn: (reg: Record<string, unknown>) => unknown): Promise<unknown>;
        /** bump the global rev (call only inside enqueue); skipWrite leaves the state.json write to the caller */
        _bumpRev(opts?: { skipWrite?: boolean }): Promise<void>;
        shelfAdd(body: Record<string, unknown>): Promise<unknown>;
        shelfList(): unknown[];
        shelfRemove(id: string): Promise<void>;
        rescan(): Promise<void>;
        enqueue<T>(fn: () => T): Promise<T>;
        /** mark the desired slot changed at rev+1 (call inside mutateState) */
        _markSlotChanged(): void;
    };
    hub: {
        clientCount: number;
        add(clientId: string, res: unknown, hello: unknown): void;
        broadcast(payload: unknown, origin?: string | null): void;
        onClientsChanged: (() => void) | null;
    };
    ready: Promise<void> | null;
    settingsFile?: string;
}

declare global {
    // eslint-disable-next-line no-var
    var SillyTavern: { getContext: () => unknown } | undefined;

    namespace Express {
        interface Request {
            /** ST user record (setUserDataMiddleware) */
            user?: {
                directories: {
                    root: string;
                    openAI_Settings: string;
                    [key: string]: unknown;
                };
                [key: string]: unknown;
            };
            /** preset-manager plugin handle (plugin/index.js middleware) */
            pm?: PmHandle;
        }
    }
}

export {};

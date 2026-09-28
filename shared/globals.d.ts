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
        shelfAdd(body: Record<string, unknown>): Promise<unknown>;
        shelfList(): unknown[];
        shelfRemove(id: string): Promise<void>;
        rescan(): Promise<void>;
        enqueue(fn: () => unknown): Promise<unknown>;
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

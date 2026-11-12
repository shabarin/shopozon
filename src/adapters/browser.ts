import type { KeyValueStore } from '../storage/backend.ts';

/** Minimal WebExtensions surface shared by Chrome and Firefox. */
export interface ExtensionTab {
  id?: number;
  url?: string;
  active?: boolean;
  currentWindow?: boolean;
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export interface ExtensionApi {
  runtime: {
    id: string;
    onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: { id?: string; url?: string; tab?: ExtensionTab },
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    onInstalled: { addListener(callback: () => void): void };
    onStartup: { addListener(callback: () => void): void };
    sendMessage(message: unknown): Promise<unknown>;
    getURL(path: string): string;
    getManifest(): { version?: string };
  };
  storage: {
    local: {
      get(keys: string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    };
    onChanged: {
      addListener(
        callback: (changes: Record<string, StorageChange>, areaName: string) => void,
      ): void;
    };
  };
  tabs: {
    query(query: { url?: string[]; active?: boolean; currentWindow?: boolean }): Promise<ExtensionTab[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  action: {
    setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
  };
}

declare const browser: ExtensionApi | undefined;
declare const chrome: ExtensionApi | undefined;

function resolveApi(): ExtensionApi {
  if (typeof browser !== 'undefined' && browser?.runtime?.id) return browser;
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) return chrome;
  throw new Error('WebExtensions API is unavailable');
}

export const ext: ExtensionApi = resolveApi();
export const isFirefox = typeof browser !== 'undefined' && Boolean(browser?.runtime?.id);

export class BrowserStorage implements KeyValueStore {
  async get(keys?: string[] | null): Promise<Record<string, unknown>> {
    return ext.storage.local.get(keys ?? null);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await ext.storage.local.set(items);
  }

  async remove(keys: string | string[]): Promise<void> {
    await ext.storage.local.remove(keys);
  }

  async clear(): Promise<void> {
    await ext.storage.local.clear();
  }
}

export async function queryTabs(query: {
  url?: string[];
  active?: boolean;
  currentWindow?: boolean;
}): Promise<ExtensionTab[]> {
  try {
    return await ext.tabs.query(query);
  } catch {
    return [];
  }
}

export async function sendTabMessage(tabId: number, message: unknown): Promise<boolean> {
  try {
    await ext.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    // The tab may be loading, not an Ozon page, or have no content script.
    return false;
  }
}

export async function setBadge(text: string): Promise<void> {
  try {
    await ext.action.setBadgeText({ text });
    await ext.action.setBadgeBackgroundColor({ color: '#005bff' });
  } catch {
    // Badge failure must never break collection.
  }
}

export function runtimeSendMessage<T = unknown>(message: unknown): Promise<T> {
  return ext.runtime.sendMessage(message) as Promise<T>;
}

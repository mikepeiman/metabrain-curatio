import { storage } from '#imports';
import type { MetaItem, UUID } from '../types';

export interface MetabrainData {
    items: Record<UUID, MetaItem>;
    rootSessionId: UUID;
}

const STORAGE_KEY = 'local:metabrain_data';

export const metabrainStorage = {
    async save(data: MetabrainData): Promise<void> {
        await storage.setItem(STORAGE_KEY, data);
    },

    async load(): Promise<MetabrainData | null> {
        return await storage.getItem<MetabrainData>(STORAGE_KEY);
    },

    async clear(): Promise<void> {
        await storage.removeItem(STORAGE_KEY);
    }
};

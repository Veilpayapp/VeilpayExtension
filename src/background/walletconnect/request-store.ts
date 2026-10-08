const STORAGE_KEY = 'veilpay:wc:pendingRequest';

export interface PendingWcRequest {
  topic: string;
  requestId: number;
  chainId: string;
  request: {
    method: string;
    params: unknown[];
  };
  createdAt: number;
}

export async function setPendingWcRequest(request: Omit<PendingWcRequest, 'createdAt'>): Promise<void> {
  const record = { ...request, createdAt: Date.now() };
  await chrome.storage.session.set({ [STORAGE_KEY]: record });
}

export async function getPendingWcRequest(): Promise<PendingWcRequest | null> {
  const data = await chrome.storage.session.get(STORAGE_KEY);
  const value = data[STORAGE_KEY];
  if (!value || typeof value !== 'object') return null;
  return value as PendingWcRequest;
}

export async function clearPendingWcRequest(): Promise<void> {
  await chrome.storage.session.remove(STORAGE_KEY);
}

export async function clearPendingWcRequestForTopic(topic: string): Promise<void> {
  const current = await getPendingWcRequest();
  if (current !== null && current.topic === topic) {
    await chrome.storage.session.remove(STORAGE_KEY);
  }
}

/** Validates the required fields of a pending request before it is trusted. */
export function isPendingWcRequest(value: unknown): value is PendingWcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.topic === 'string' &&
    typeof record.requestId === 'number' &&
    typeof record.chainId === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.request === 'object' &&
    record.request !== null &&
    typeof (record.request as Record<string, unknown>).method === 'string' &&
    Array.isArray((record.request as Record<string, unknown>).params)
  );
}
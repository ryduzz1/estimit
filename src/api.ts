import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import type { Identification, NeedMoreDetail, ResearchResult, ValuationResult } from './valuation';

const API_URL = (process.env.EXPO_PUBLIC_ESTIMIT_API_URL ?? 'https://server.tailc264d2.ts.net:8443').replace(/\/$/, '');
const INSTALLATION_TOKEN_KEY = 'estimit.installation-token.v1';
let installationToken: string | null = null;

export class ValuationApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ValuationApiError';
  }
}

export type ScanOutcome =
  | { kind: 'valuation'; result: ValuationResult }
  | { kind: 'research'; result: ResearchResult }
  | { kind: 'followup'; detail: NeedMoreDetail };

async function registerInstallation() {
  const response = await expoFetch(`${API_URL}/v1/installations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: Platform.OS, appVersion: '1.0.0' }),
  });
  const payload = await response.json().catch(() => null) as { token?: unknown } | null;
  if (!response.ok || typeof payload?.token !== 'string') {
    throw new ValuationApiError('This version of Estimit could not register with the service.', response.status);
  }
  installationToken = payload.token;
  // Keychain persistence should improve later launches, never block the scan that just
  // registered successfully. Some development/re-signed builds can temporarily reject writes.
  await SecureStore.setItemAsync(INSTALLATION_TOKEN_KEY, payload.token).catch(() => undefined);
  return payload.token;
}

async function getInstallationToken() {
  installationToken ??= await SecureStore.getItemAsync(INSTALLATION_TOKEN_KEY).catch(() => null);
  return installationToken ?? registerInstallation();
}

async function clearInstallationToken() {
  installationToken = null;
  await SecureStore.deleteItemAsync(INSTALLATION_TOKEN_KEY).catch(() => undefined);
}

export async function requestValuation(uri: string, hints?: string): Promise<ScanOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const send = async (token: string) => {
      // Expo's native File implementation streams the local camera asset correctly on
      // iOS. Create a new multipart body for each attempt because request bodies are
      // single-use and an expired installation token may require one authenticated retry.
      const form = new FormData();
      form.append('image', new File(uri));
      if (hints) form.append('hints', hints);

      return expoFetch(`${API_URL}/v1/valuations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal: controller.signal,
      });
    };
    let response = await send(await getInstallationToken());
    if (response.status === 401) {
      await clearInstallationToken();
      response = await send(await registerInstallation());
    }
    const payload = await response.json().catch(() => null) as ValuationResult | ResearchResult | NeedMoreDetail | { error?: string } | null;

    if (response.status === 422 && payload && 'error' in payload && payload.error === 'insufficient_identification') {
      return { kind: 'followup', detail: payload as NeedMoreDetail };
    }
    if (!response.ok) {
      const code = payload && 'error' in payload ? payload.error : undefined;
      if (response.status === 429) throw new ValuationApiError('Too many scans were submitted. Wait a moment and try again.', 429);
      throw new ValuationApiError(code === 'unauthorized' ? 'This device is not authorized to use Estimit.' : 'The valuation service could not complete this scan.', response.status);
    }
    if (payload && 'status' in payload && payload.status === 'research_only') return { kind: 'research', result: payload as ResearchResult };
    return { kind: 'valuation', result: payload as ValuationResult };
  } catch (error) {
    if (error instanceof ValuationApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ValuationApiError('The scan took too long. Check your connection and try again.');
    console.error('[Estimit API] Scan upload failed', error);
    throw new ValuationApiError('The scan could not be sent. Please try it once more.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function refineIdentity(identification: Identification): Promise<Extract<ScanOutcome, { kind: 'valuation' | 'research' }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const send = (token: string) => expoFetch(`${API_URL}/v1/valuations/refine`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identification }),
      signal: controller.signal,
    });
    let response = await send(await getInstallationToken());
    if (response.status === 401) {
      await clearInstallationToken();
      response = await send(await registerInstallation());
    }
    const payload = await response.json().catch(() => null) as ValuationResult | ResearchResult | { error?: string } | null;
    if (!response.ok || !payload || !('item' in payload)) {
      throw new ValuationApiError('Estimit could not update this item match.', response.status);
    }
    return payload && 'status' in payload && payload.status === 'research_only'
      ? { kind: 'research', result: payload }
      : { kind: 'valuation', result: payload as ValuationResult };
  } catch (error) {
    if (error instanceof ValuationApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ValuationApiError('Updating the item took too long. Try again.');
    throw new ValuationApiError('Estimit could not update this item match.');
  } finally {
    clearTimeout(timeout);
  }
}

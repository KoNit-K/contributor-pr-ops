import { beforeAll, afterAll, afterEach, expect, vi } from 'vitest';
import { Socket } from 'node:net';

let attempts = 0;
const denied = () => { attempts++; throw new Error('Unexpected business network request in offline tests'); };
beforeAll(() => {
  vi.stubGlobal('fetch', denied);
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(denied);
});
afterEach(() => { expect(attempts, 'Offline tests must not attempt network access').toBe(0); attempts = 0; });
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

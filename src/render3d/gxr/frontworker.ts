/* GX renderer: the entry of a front-half worker thread (frontpool.ts). */
import { PoolConfig, workerMain } from "./frontpool";

(self as unknown as { onmessage: (e: MessageEvent<{ sab: SharedArrayBuffer; cfg: PoolConfig; memSab: SharedArrayBuffer }>) => void }).onmessage = (e) => workerMain(e.data.sab, e.data.cfg, e.data.memSab);

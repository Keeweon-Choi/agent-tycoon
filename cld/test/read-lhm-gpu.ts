/**
 * T-0021: the GPU readings this host's LibreHardwareMonitor gives the engine
 * without nvidia-smi (T-0030's reader, one GET of /data.json, read only).
 *
 *   npx tsx cld/test/read-lhm-gpu.ts <lhm port>
 */
import { hwPlatform } from '../../server/src/cld/hw/hwSource.js';
import { LhmReader } from '../../server/src/cld/hw/lhm.js';

async function main() {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port)) throw new Error('usage: read-lhm-gpu.ts <lhm port>');
  const r = await new LhmReader(port, hwPlatform() === 'wsl').read();
  const gpu = r && {
    gpuUtil: r.gpuUtil,
    vramUsedMib: r.vramUsedMib,
    vramTotalMib: r.vramTotalMib,
    gpuTempC: r.gpuTempC,
    gpuHotspotC: r.gpuHotspotC,
    gpuPowerW: r.gpuPowerW,
  };
  console.log(
    JSON.stringify({ at: new Date().toISOString(), platform: hwPlatform(), gpu }, null, 2),
  );
}

void main();

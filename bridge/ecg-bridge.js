#!/usr/bin/env node
//
// Aetheria Polar H10 ECG Bridge
//
// Native BLE → WebSocket bridge for Polar H10 ECG streaming.
// Solves the Windows Web Bluetooth limitation where the H10 drops
// the connection after accepting the ECG start command.
//
// Usage:
//   cd bridge
//   npm install
//   npm start
//
// The browser app connects to ws://localhost:8765 to receive
// ECG, HR, and R-R data.

const noble = require('@stoprocent/noble');
const { WebSocketServer } = require('ws');

// ============================================================================
// Config
// ============================================================================
const WS_PORT = 8765;
const PMD_SERVICE    = 'fb005c8002e7f3871cad8acd2d8df0c8';
const PMD_CTRL       = 'fb005c8102e7f3871cad8acd2d8df0c8';
const PMD_DATA       = 'fb005c8202e7f3871cad8acd2d8df0c8';
const HR_SERVICE     = '180d';
const HR_MEASUREMENT = '2a37';

const ECG_START_CMD = Buffer.from([
  0x02, 0x00,
  0x00, 0x01, 0x82, 0x00,
  0x01, 0x01, 0x0E, 0x00
]);

// ============================================================================
// State
// ============================================================================
let wsClients = new Set();
let h10Peripheral = null;
let ecgActive = false;
let ecgSampleCount = 0;

// ============================================================================
// WebSocket server
// ============================================================================
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('listening', () => {
  console.log(`[WS] WebSocket server listening on ws://localhost:${WS_PORT}`);
});

wss.on('connection', (ws) => {
  console.log('[WS] Browser connected');
  wsClients.add(ws);
  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('[WS] Browser disconnected');
  });
  ws.on('error', () => wsClients.delete(ws));

  // Send current status
  broadcast({ type: 'status', status: ecgActive ? 'streaming' : 'scanning' });
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === 1) { // OPEN
      ws.send(msg);
    }
  }
}

// ============================================================================
// BLE: Scan for Polar H10
// ============================================================================
console.log('[BLE] Waiting for Bluetooth adapter...');

noble.on('stateChange', (state) => {
  console.log(`[BLE] Adapter state: ${state}`);
  if (state === 'poweredOn') {
    console.log('[BLE] Scanning for Polar H10 (all devices, no filter)...');
    // Scan with no service filter and allow duplicates to catch everything
    noble.startScanning([], true);
  } else {
    noble.stopScanning();
  }
});

const seenDevices = new Set();
noble.on('discover', async (peripheral) => {
  const name = peripheral.advertisement.localName || '';
  const id = peripheral.id || peripheral.uuid || '';

  // Log each unique device once so we can see what's out there
  if (name && !seenDevices.has(id)) {
    seenDevices.add(id);
    console.log(`[BLE] Discovered: "${name}" (${id}) RSSI:${peripheral.rssi}`);
  }

  // Match Polar H10 by name (case-insensitive, flexible prefix)
  if (!name.toLowerCase().startsWith('polar h10') && !name.toLowerCase().startsWith('polar h')) return;

  console.log(`[BLE] *** FOUND Polar H10: ${name} (${id}) ***`);
  noble.stopScanning();
  h10Peripheral = peripheral;

  peripheral.on('disconnect', () => {
    console.log('[BLE] H10 disconnected');
    ecgActive = false;
    broadcast({ type: 'status', status: 'disconnected' });

    // Auto-reconnect
    setTimeout(() => {
      console.log('[BLE] Reconnecting...');
      connectAndSetup(peripheral);
    }, 2000);
  });

  await connectAndSetup(peripheral);
});

// ============================================================================
// BLE: Connect and setup (HR + ECG)
// ============================================================================
async function connectAndSetup(peripheral) {
  try {
    console.log('[BLE] Connecting...');
    await connectPeripheral(peripheral);
    console.log('[BLE] Connected');

    console.log('[BLE] Discovering services...');
    const { services, characteristics } = await discoverAll(peripheral);

    // Setup Heart Rate
    const hrChar = characteristics.find(c => c.uuid === HR_MEASUREMENT);
    if (hrChar) {
      hrChar.on('data', (data) => onHeartRate(data));
      await subscribeChar(hrChar);
      console.log('[BLE] HR notifications active');
    }

    // Setup PMD (ECG) — STRICT ORDER: ctrl first, then data, then write
    const pmdCtrl = characteristics.find(c => c.uuid === PMD_CTRL);
    const pmdData = characteristics.find(c => c.uuid === PMD_DATA);

    if (!pmdCtrl || !pmdData) {
      console.log('[BLE] PMD service not found — HR only');
      broadcast({ type: 'status', status: 'streaming_hr_only' });
      return;
    }

    // 1. Subscribe to PMD control (for F0 response)
    let ecgStartResolve = null;
    pmdCtrl.on('data', (data) => {
      const hex = data.toString('hex');
      console.log(`[BLE] PMD ctrl: ${hex}`);
      // F0 02 00 00 = ECG start success
      if (data[0] === 0xF0 && data[1] === 0x02 && data[2] === 0x00 && data[3] === 0x00) {
        ecgActive = true;
        console.log('[BLE] ECG start confirmed!');
        if (ecgStartResolve) ecgStartResolve(true);
      }
    });
    await subscribeChar(pmdCtrl);
    console.log('[BLE] PMD ctrl subscribed');

    // 2. Subscribe to PMD data (ECG frames)
    pmdData.on('data', (data) => onEcgFrame(data));
    await subscribeChar(pmdData);
    console.log('[BLE] PMD data subscribed');

    // 3. Send ECG start command
    console.log('[BLE] Sending ECG start...');
    await writeChar(pmdCtrl, ECG_START_CMD);

    // Wait for F0 response
    const success = await new Promise((resolve) => {
      ecgStartResolve = resolve;
      setTimeout(() => resolve(false), 3000);
    });

    if (success) {
      console.log('[BLE] ECG STREAMING!');
      broadcast({ type: 'status', status: 'streaming' });
    } else {
      console.log('[BLE] ECG start timeout');
      broadcast({ type: 'status', status: 'streaming_hr_only' });
    }

  } catch (err) {
    console.error('[BLE] Setup failed:', err.message);
    broadcast({ type: 'status', status: 'error', error: err.message });
  }
}

// ============================================================================
// BLE: ECG frame parser
// ============================================================================
function onEcgFrame(data) {
  if (data[0] !== 0x00) return; // Not ECG

  const headerBytes = 10;
  const sampleBytes = 3;
  const sampleCount = Math.floor((data.length - headerBytes) / sampleBytes);
  const samples = new Array(sampleCount);

  let off = headerBytes;
  for (let i = 0; i < sampleCount; i++) {
    let v = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16);
    if (v & 0x800000) v |= 0xFF000000;
    samples[i] = v | 0; // signed 24-bit microvolts
    off += sampleBytes;
  }

  ecgSampleCount += sampleCount;

  // Broadcast to all WebSocket clients
  broadcast({
    type: 'ecg',
    samples,
    count: ecgSampleCount
  });

  // Log periodically
  if (ecgSampleCount % 1300 === 0) { // ~every 10 seconds
    console.log(`[ECG] ${ecgSampleCount} samples streamed`);
  }
}

// ============================================================================
// BLE: Heart rate parser
// ============================================================================
function onHeartRate(data) {
  const flags = data[0];
  let off = 1;
  let hr;
  if (flags & 0x01) { hr = data.readUInt16LE(off); off += 2; }
  else { hr = data[off]; off += 1; }

  const contact = (flags & 0x06) === 0x06;
  if (flags & 0x08) off += 2;

  const rrList = [];
  if (flags & 0x10) {
    while (off + 1 < data.length) {
      rrList.push((data.readUInt16LE(off) / 1024) * 1000);
      off += 2;
    }
  }

  broadcast({
    type: 'hr',
    hr,
    rr: rrList,
    contact
  });
}

// ============================================================================
// Noble helpers (promisified)
// ============================================================================
function connectPeripheral(p) {
  return new Promise((resolve, reject) => {
    p.connect((err) => err ? reject(err) : resolve());
  });
}

function discoverAll(p) {
  return new Promise((resolve, reject) => {
    p.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
      if (err) reject(err);
      else resolve({ services, characteristics });
    });
  });
}

function subscribeChar(char) {
  return new Promise((resolve, reject) => {
    char.subscribe((err) => err ? reject(err) : resolve());
  });
}

function writeChar(char, data) {
  return new Promise((resolve, reject) => {
    char.write(data, false, (err) => err ? reject(err) : resolve());
  });
}

// ============================================================================
// Graceful shutdown
// ============================================================================
process.on('SIGINT', async () => {
  console.log('\n[BLE] Shutting down...');
  if (h10Peripheral) {
    try {
      const { characteristics } = await discoverAll(h10Peripheral);
      const pmdCtrl = characteristics.find(c => c.uuid === PMD_CTRL);
      if (pmdCtrl) {
        await writeChar(pmdCtrl, Buffer.from([0x03, 0x00])); // Stop ECG
      }
    } catch (_) {}
    h10Peripheral.disconnect();
  }
  wss.close();
  process.exit(0);
});

console.log('[Bridge] Aetheria Polar H10 ECG Bridge');
console.log('[Bridge] Waiting for Bluetooth adapter and H10...');

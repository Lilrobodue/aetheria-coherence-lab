#!/usr/bin/env python3
"""
Aetheria Polar H10 ECG Bridge (Python + bleak)

Native BLE -> WebSocket bridge for Polar H10 ECG streaming on Windows.
bleak uses a different WinRT codepath than noble and may handle the
connection parameter update the H10 requests for ECG streaming.

Usage:
    python ecg-bridge.py

The browser connects to ws://localhost:8765 for ECG + HR + R-R data.
"""

import asyncio
import json
import struct
import signal
import sys
from bleak import BleakScanner, BleakClient
from websockets.asyncio.server import serve

# ============================================================================
# Config
# ============================================================================
WS_PORT = 8765
H10_NAME_PREFIX = "Polar H10"

PMD_SERVICE   = "fb005c80-02e7-f387-1cad-8acd2d8df0c8"
PMD_CTRL_UUID = "fb005c81-02e7-f387-1cad-8acd2d8df0c8"
PMD_DATA_UUID = "fb005c82-02e7-f387-1cad-8acd2d8df0c8"

HR_MEASUREMENT_UUID = "00002a37-0000-1000-8000-00805f9b34fb"

ECG_START_CMD = bytes([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00])

# ============================================================================
# State
# ============================================================================
ws_clients: set = set()
ecg_sample_count = 0
ecg_active = False
running = True

# ============================================================================
# WebSocket
# ============================================================================
def broadcast(obj):
    msg = json.dumps(obj)
    for ws in list(ws_clients):
        try:
            ws.send_nowait(msg)
        except Exception:
            pass

async def ws_handler(websocket):
    ws_clients.add(websocket)
    print(f"[WS] Browser connected ({len(ws_clients)} clients)")
    status = "streaming" if ecg_active else "scanning"
    await websocket.send(json.dumps({"type": "status", "status": status}))
    try:
        async for _ in websocket:
            pass  # We don't expect messages from browser
    finally:
        ws_clients.discard(websocket)
        print(f"[WS] Browser disconnected ({len(ws_clients)} clients)")

# ============================================================================
# ECG frame parser
# ============================================================================
def parse_ecg_frame(data: bytearray) -> list[int]:
    if data[0] != 0x00:
        return []
    header_bytes = 10
    sample_bytes = 3
    sample_count = (len(data) - header_bytes) // sample_bytes
    samples = []
    off = header_bytes
    for _ in range(sample_count):
        v = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16)
        if v & 0x800000:
            v |= 0xFF000000
        samples.append(v & 0xFFFFFFFF if v >= 0 else v | 0)
        off += sample_bytes
    # Sign extend properly
    result = []
    for s in samples:
        if s >= 0x80000000:
            s -= 0x100000000
        result.append(s)
    return result

# ============================================================================
# Heart rate parser
# ============================================================================
def parse_heart_rate(data: bytearray):
    flags = data[0]
    off = 1
    if flags & 0x01:
        hr = struct.unpack_from('<H', data, off)[0]
        off += 2
    else:
        hr = data[off]
        off += 1

    contact = (flags & 0x06) == 0x06
    if flags & 0x08:
        off += 2

    rr_list = []
    if flags & 0x10:
        while off + 1 < len(data):
            rr_raw = struct.unpack_from('<H', data, off)[0]
            rr_list.append((rr_raw / 1024) * 1000)
            off += 2

    return hr, rr_list, contact

# ============================================================================
# BLE connection and streaming
# ============================================================================
async def connect_and_stream():
    global ecg_sample_count, ecg_active, running

    while running:
        # Scan for H10
        print(f"[BLE] Scanning for {H10_NAME_PREFIX}...")
        broadcast({"type": "status", "status": "scanning"})

        device = None
        while device is None and running:
            devices = await BleakScanner.discover(timeout=5.0)
            for d in devices:
                name = d.name or ""
                if name.startswith(H10_NAME_PREFIX):
                    device = d
                    print(f"[BLE] Found: {d.name} ({d.address})")
                    break
            if device is None:
                print("[BLE] H10 not found, scanning again...")

        if not running:
            break

        # Connect
        ecg_active = False
        ecg_event = asyncio.Event()

        def on_disconnect(client):
            global ecg_active
            print("[BLE] H10 disconnected")
            ecg_active = False
            broadcast({"type": "status", "status": "disconnected"})

        def on_ecg_data(sender, data):
            global ecg_sample_count, ecg_active
            samples = parse_ecg_frame(bytearray(data))
            if not samples:
                return
            ecg_sample_count += len(samples)
            broadcast({"type": "ecg", "samples": samples, "count": ecg_sample_count})
            if ecg_sample_count % 1300 == 0:
                print(f"[ECG] {ecg_sample_count} samples streamed")

        def on_pmd_ctrl(sender, data):
            global ecg_active
            hex_str = data.hex()
            print(f"[BLE] PMD ctrl: {hex_str}")
            if len(data) >= 4 and data[0] == 0xF0 and data[1] == 0x02 and data[2] == 0x00 and data[3] == 0x00:
                ecg_active = True
                ecg_event.set()
                print("[BLE] ECG start confirmed!")

        def on_hr(sender, data):
            hr, rr_list, contact = parse_heart_rate(bytearray(data))
            broadcast({"type": "hr", "hr": hr, "rr": rr_list, "contact": contact})

        try:
            print(f"[BLE] Connecting to {device.name}...")
            async with BleakClient(device.address, disconnected_callback=on_disconnect) as client:
                print(f"[BLE] Connected! MTU={client.mtu_size}")

                # Subscribe to HR
                await client.start_notify(HR_MEASUREMENT_UUID, on_hr)
                print("[BLE] HR notifications active")

                # STRICT ORDER: PMD ctrl first, then PMD data, then write start
                await client.start_notify(PMD_CTRL_UUID, on_pmd_ctrl)
                print("[BLE] PMD ctrl subscribed")

                await client.start_notify(PMD_DATA_UUID, on_ecg_data)
                print("[BLE] PMD data subscribed")

                # Send ECG start
                print("[BLE] Sending ECG start...")
                await client.write_gatt_char(PMD_CTRL_UUID, ECG_START_CMD, response=True)

                # Wait for F0 response
                try:
                    await asyncio.wait_for(ecg_event.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    print("[BLE] ECG start timeout")

                if ecg_active:
                    print("[BLE] ECG STREAMING!")
                    broadcast({"type": "status", "status": "streaming"})
                else:
                    print("[BLE] ECG failed, HR-only")
                    broadcast({"type": "status", "status": "streaming_hr_only"})

                # Stay connected while streaming
                while client.is_connected and running:
                    await asyncio.sleep(1)

        except Exception as e:
            print(f"[BLE] Error: {e}")

        if running:
            print("[BLE] Will reconnect in 3 seconds...")
            await asyncio.sleep(3)

# ============================================================================
# Main
# ============================================================================
async def main():
    global running

    # Start WebSocket server
    print(f"[WS] Starting WebSocket server on ws://localhost:{WS_PORT}")
    ws_server = await serve(ws_handler, "localhost", WS_PORT)
    print(f"[WS] Listening on ws://localhost:{WS_PORT}")
    print("[Bridge] Aetheria Polar H10 ECG Bridge (Python + bleak)")

    # Handle Ctrl+C
    def shutdown(*args):
        global running
        running = False
        print("\n[Bridge] Shutting down...")

    signal.signal(signal.SIGINT, shutdown)

    # Start BLE connection loop
    try:
        await connect_and_stream()
    finally:
        ws_server.close()
        await ws_server.wait_closed()

if __name__ == "__main__":
    asyncio.run(main())

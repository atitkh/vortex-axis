#pragma once

// Shared client core for VorteX Axis devices. For now this holds only what
// every board needs to agree on. Wi-Fi setup, pairing, the socket and settings
// sync are added here as they are built.

/** Version of the client protocol this core speaks. See protocol/src/version.ts. */
#define AXIS_PROTOCOL_VERSION 1

/** Firmware version, without a leading "v". Reported to Axis on connect. */
#define AXIS_FIRMWARE_VERSION "0.1.0"

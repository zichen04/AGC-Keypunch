"use strict";

import {
  ERASABLE_BANK_COUNT, ERASABLE_BANK_SIZE,
  FIXED_BANK_COUNT, FIXED_BANK_SIZE
} from "./isa.js";

// The UI and CPU share this instance. assemble() resets it before loading a deck.
export const machine = {
  erasableMemory: new Uint16Array(ERASABLE_BANK_COUNT * ERASABLE_BANK_SIZE),
  fixedMemory: new Uint16Array(FIXED_BANK_COUNT * FIXED_BANK_SIZE),
  program: [],
  symbolTable: new Map(),
  addressTable: [],
  sourceLines: [],
  registers: { A: 0, L: 0, Q: null, Z: 0, EBANK: 0, FBANK: 0 },
  entryPoint: null,
  errors: [],
  warnings: [],
  status: "idle",
  message: "Assemble a deck to begin.",
  steps: 0,
  overflow: 0,
  pendingIndex: null,
  lastInstruction: null
};

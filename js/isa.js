"use strict";

// This is the simulator's custom 16-bit format, not the real AGC encoding.
export const ERASABLE_BANK_SIZE = 256;
export const FIXED_BANK_SIZE = 1024;
export const ERASABLE_BANK_COUNT = 8;
export const FIXED_BANK_COUNT = 36;
export const MAX_ADDRESS_TABLE_SIZE = 4096; // 12-bit address-table ID

// CAF shares opcode 3 with XCH; the target region distinguishes them.
export const OPCODE_BITS = {
  TC: 0, CCS: 1, INDEX: 2, XCH: 3, CAF: 3, CS: 4,
  TS: 5, AD: 6, MASK: 7, SU: 8, MP: 9, DV: 10
};

export const OPCODE_NAMES = [
  "TC", "CCS", "INDEX", "XCH", "CS", "TS",
  "AD", "MASK", "SU", "MP", "DV"
];

export const INSTRUCTION_SET = {
  TC:    { cls:'basic',     desc:'Jump to fixed-memory target; save the next address in Q. TC Q returns to Q.' },
  CCS:   { cls:'basic',     desc:'Compare an erasable word; A becomes diminished absolute value. Skip 0/1/2/3 instructions for positive/+0/negative/-0.' },
  INDEX: { cls:'basic',     desc:'Add the signed operand value to the next instruction’s 12-bit address-table ID.' },
  XCH:   { cls:'basic',     desc:'Exchange A with an erasable-memory word.' },
  CS:    { cls:'basic',     desc:'Load A with the 15-bit ones’ complement of a memory word.' },
  TS:    { cls:'basic',     desc:'Store A in erasable memory; on overflow, skip one instruction and set A to +1 or -1.' },
  AD:    { cls:'basic',     desc:'Add a memory word to A with ones’ complement end-around carry.' },
  MASK:  { cls:'basic',     desc:'Bitwise AND of A and a memory word.' },
  SU:    { cls:'extracode', desc:'Subtract a memory word from A. Directly encoded here; no EXTEND required.' },
  MP:    { cls:'extracode', desc:'Multiply A by a memory word; low 14-bit part goes in A, high part in L.' },
  DV:    { cls:'extracode', desc:'Divide A by a memory word; integer quotient goes in A, remainder in L.' }
};

export const ASSEMBLER_FEATURES = {
  ERASE: { cls:'directive', desc:'Reserve one word of erasable memory. This is handled by the assembler, not executed by the CPU.' },
  OCT:   { cls:'directive', desc:'Place an octal numeric constant in memory. This is handled by the assembler, not executed by the CPU.' },
  CAF:   { cls:'pseudo',    desc:'Load A from fixed memory. Shares the XCH opcode value; fixed target distinguishes it.' }
};

export function erasableIndex(bankNum, bankOffset) {
  return bankNum * ERASABLE_BANK_SIZE + bankOffset;
}

export function fixedIndex(bankNum, bankOffset) {
  return bankNum * FIXED_BANK_SIZE + bankOffset;
}

export function formatLocation(location) {
  const offsetWidth = location.region === "E" ? 3 : 4;
  return `${location.region}${location.bankNum}:${String(location.bankOffset).padStart(offsetWidth, "0")}`;
}

export function encodeNum(val) {
  if (!Number.isInteger(val) || val < -16383 || val > 16383) {
    throw new RangeError("Value must be an integer between -16383 and 16383");
  }

  if (Object.is(val, -0)) return 0x7FFF;
  return val < 0 ? (~Math.abs(val)) & 0x7FFF : val;
}

export function decodeNum(uint16) {
  const word = uint16 & 0x7FFF;
  if (word === 0x7FFF) return -0;

  const isNegative = (word & 0x4000) !== 0;
  return isNegative ? -((~word) & 0x7FFF) : word;
}

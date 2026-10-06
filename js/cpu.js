"use strict";

import { machine } from "./machine.js";
import { DecodeIns } from "./assembler.js";
import {
    FIXED_BANK_SIZE, erasableIndex, fixedIndex, encodeNum, decodeNum
} from "./isa.js";

/* -------------------------------------------------------------------------
   Execution. These are the simulator's simplified AGC-like behaviors.
   A and L hold 15-bit ones'-complement words; Z and Q hold flat fixed-memory
   addresses. Instruction words use the custom 4-bit/12-bit table-ID format.
   ------------------------------------------------------------------------- */

function readWord(target) {
    if (target.region === "E") {
        machine.registers.EBANK = target.bankNum;
        return machine.erasableMemory[erasableIndex(target.bankNum, target.bankOffset)];
    }

    if (target.region === "F") {
        machine.registers.FBANK = target.bankNum;
        return machine.fixedMemory[fixedIndex(target.bankNum, target.bankOffset)];
    }

    throw new Error("This instruction needs a memory operand");
}

function writeWord(target, word) {
    if (target.region !== "E") {
        throw new Error("Cannot write to fixed memory");
    }

    machine.registers.EBANK = target.bankNum;
    machine.erasableMemory[erasableIndex(target.bankNum, target.bankOffset)] = word & 0x7FFF;
}

// End-around carry implements addition of two 15-bit ones'-complement words.
function addWords(first, second) {
    let sum = (first & 0x7FFF) + (second & 0x7FFF);
    sum = (sum & 0x7FFF) + (sum >>> 15);
    return sum & 0x7FFF;
}

function executeTC(target) {
    const nextInstruction = machine.registers.Z;
    const destination = target.region === "Q"
        ? machine.registers.Q
        : fixedIndex(target.bankNum, target.bankOffset);

    if (destination === null || !machine.program[destination]) {
        throw new Error("TC target is not an executable instruction");
    }

    machine.registers.Q = nextInstruction;
    machine.registers.Z = destination;
    machine.registers.FBANK = Math.floor(destination / FIXED_BANK_SIZE);
}

function executeCCS(target) {
    const word = readWord(target);
    const value = decodeNum(word);
    const diminished = Math.max(Math.abs(value) - 1, 0);

    machine.registers.A = encodeNum(diminished);
    machine.overflow = 0;

    if (word === 0) {
        machine.registers.Z += 1; // +0: skip one instruction
    } else if (word === 0x7FFF) {
        machine.registers.Z += 3; // -0: skip three instructions
    } else if (value < 0) {
        machine.registers.Z += 2; // negative: skip two instructions
    }
    // Positive: continue with the very next instruction.
}

function executeINDEX(target) {
    machine.pendingIndex = decodeNum(readWord(target));
}

function executeXCH(target) {
    const oldValue = readWord(target);
    writeWord(target, machine.registers.A);
    machine.registers.A = oldValue;
    machine.overflow = 0;
}

function executeCAF(target) {
    machine.registers.A = readWord(target);
    machine.overflow = 0;
}

function executeCS(target) {
    machine.registers.A = (~readWord(target)) & 0x7FFF;
    machine.overflow = 0;
}

function executeTS(target) {
    writeWord(target, machine.registers.A);

    if (machine.overflow !== 0) {
        machine.registers.A = encodeNum(machine.overflow);
        machine.registers.Z += 1; // simplified skip-on-overflow
        machine.overflow = 0;
    }
}

function executeAD(target) {
    const operand = readWord(target);
    const signedSum = decodeNum(machine.registers.A) + decodeNum(operand);
    machine.registers.A = addWords(machine.registers.A, operand);
    machine.overflow = signedSum > 16383 ? 1 : signedSum < -16383 ? -1 : 0;
}

function executeMASK(target) {
    machine.registers.A &= readWord(target);
    machine.overflow = 0;
}

function executeSU(target) {
    const operand = readWord(target);
    const signedDifference = decodeNum(machine.registers.A) - decodeNum(operand);
    machine.registers.A = addWords(machine.registers.A, (~operand) & 0x7FFF);
    machine.overflow = signedDifference > 16383 ? 1 : signedDifference < -16383 ? -1 : 0;
}

function executeMP(target) {
    const product = decodeNum(machine.registers.A) * decodeNum(readWord(target));
    const sign = product < 0 ? -1 : 1;
    const magnitude = Math.abs(product);

    // Low and high 14-bit portions are visible in A and L respectively.
    machine.registers.A = encodeNum(sign * (magnitude % 16384));
    machine.registers.L = encodeNum(sign * Math.floor(magnitude / 16384));
    machine.overflow = 0;
}

function executeDV(target) {
    const divisor = decodeNum(readWord(target));

    if (divisor === 0) {
        throw new Error("Division by zero");
    }

    const dividend = decodeNum(machine.registers.A);
    machine.registers.A = encodeNum(Math.trunc(dividend / divisor));
    machine.registers.L = encodeNum(dividend % divisor);
    machine.overflow = 0;
}

const EXECUTE_INSTRUCTION = {
    TC: executeTC,
    CCS: executeCCS,
    INDEX: executeINDEX,
    XCH: executeXCH,
    CAF: executeCAF,
    CS: executeCS,
    TS: executeTS,
    AD: executeAD,
    MASK: executeMASK,
    SU: executeSU,
    MP: executeMP,
    DV: executeDV
};

export function stepMachine() {
    if (!["ready", "paused", "running"].includes(machine.status)) {
        return false;
    }

    const currentAddress = machine.registers.Z;
    const source = machine.program[currentAddress];

    if (!source) {
        machine.status = "finished";
        machine.message = "Execution reached the end of the assembled program.";
        return false;
    }

    try {
        machine.registers.FBANK = Math.floor(currentAddress / FIXED_BANK_SIZE);
        const storedWord = machine.fixedMemory[currentAddress];
        let effectiveWord = storedWord;

        if (machine.pendingIndex !== null) {
            const newID = (storedWord & 0x0FFF) + machine.pendingIndex;
            machine.pendingIndex = null;

            if (newID < 0 || newID >= machine.addressTable.length) {
                throw new Error(`INDEX produced invalid address-table ID ${newID}`);
            }

            effectiveWord = (storedWord & 0xF000) | newID;
        }

        const instruction = DecodeIns(effectiveWord);
        machine.registers.Z = currentAddress + 1;
        EXECUTE_INSTRUCTION[instruction.opcode](instruction.target);

        machine.steps++;
        machine.lastInstruction = {
            address: currentAddress,
            opcode: instruction.opcode,
            operand: source.operand,
            cardNumber: source.cardNumber,
            target: instruction.target
        };

        if (!machine.program[machine.registers.Z]) {
            machine.status = "finished";
            machine.message = "Execution reached the end of the assembled program.";
        } else if (machine.status !== "running") {
            machine.status = "paused";
            machine.message = "Paused after one instruction.";
        }

        return true;
    } catch (error) {
        machine.status = "error";
        machine.message = `Card ${source.cardNumber}: ${error.message}`;
        return false;
    }
}

export function runMachine(maxSteps = 10000) {
    if (!["ready", "paused"].includes(machine.status)) {
        return machine.status;
    }

    machine.status = "running";
    let count = 0;

    while (machine.status === "running" && count < maxSteps) {
        stepMachine();
        count++;
    }

    if (machine.status === "running") {
        machine.status = "paused";
        machine.message = `Paused after ${maxSteps} steps; the program may contain a loop.`;
    }

    return machine.status;
}

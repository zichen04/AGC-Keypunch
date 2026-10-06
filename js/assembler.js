"use strict";

import { machine } from "./machine.js";
import {
    ERASABLE_BANK_SIZE, FIXED_BANK_SIZE,
    ERASABLE_BANK_COUNT, FIXED_BANK_COUNT, MAX_ADDRESS_TABLE_SIZE,
    OPCODE_BITS, OPCODE_NAMES, erasableIndex, fixedIndex,
    formatLocation, encodeNum
} from "./isa.js";

/**
 * @typedef {Object} Card
 * @property {number} id
 * @property {number} number
 * @property {string} label
 * @property {string} opcode
 * @property {string} operand
 * @property {string} comment
 */

const symbolTable = machine.symbolTable;
const addressIDByLocation = new Map();

function locationKey(location) {
    return `${location.region}:${location.bankNum}:${location.bankOffset}`;
}

function addLineError(line, message) {
    line.error = line.error ? `${line.error}; ${message}` : message;
    machine.errors.push(`Card ${line.cardNumber}: ${message}`);
}

function resetAssembly() {
    machine.erasableMemory.fill(0);
    machine.fixedMemory.fill(0);
    machine.program = [];
    machine.sourceLines = [];
    machine.addressTable = [];
    machine.entryPoint = null;
    machine.errors = [];
    machine.warnings = [];

    machine.registers.A = 0;
    machine.registers.L = 0;
    machine.registers.Q = null;
    machine.registers.Z = 0;
    machine.registers.EBANK = 0;
    machine.registers.FBANK = 0;
    machine.status = "idle";
    machine.message = "Assemble a deck to begin.";
    machine.steps = 0;
    machine.overflow = 0;
    machine.pendingIndex = null;
    machine.lastInstruction = null;

    symbolTable.clear();
    addressIDByLocation.clear();
}

function getAddressTableID(location) {
    const key = locationKey(location);

    if (addressIDByLocation.has(key)) {
        return addressIDByLocation.get(key);
    }

    if (machine.addressTable.length >= MAX_ADDRESS_TABLE_SIZE) {
        throw new RangeError("Cannot exceed 4096 unique operand locations");
    }

    const addressTableID = machine.addressTable.length;
    machine.addressTable.push({ ...location });
    addressIDByLocation.set(key, addressTableID);

    return addressTableID;
}

/**
 * Encode an opcode and its resolved operand.
 * The upper 4 bits hold the opcode. The lower 12 bits hold an ID into
 * machine.addressTable.
 */
export function encodeIns(card) {
    const opcodeBits = OPCODE_BITS[card.opcode];

    if (opcodeBits === undefined) {
        throw new Error(`Unknown opcode "${card.opcode}"`);
    }

    if (!card.operand) {
        throw new Error(`${card.opcode} requires an operand`);
    }

    // Q is a special target: TC Q returns to the address saved by TC.
    const target = card.opcode === "TC" && card.operand === "Q"
        ? { region: "Q", bankNum: 0, bankOffset: 0 }
        : symbolTable.get(card.operand);

    if (!target) {
        throw new Error(`Unknown operand label "${card.operand}"`);
    }

    if (card.opcode === "CAF" && target.region !== "F") {
        throw new Error("CAF requires a fixed-memory operand");
    }

    if (card.opcode === "XCH" && target.region !== "E") {
        throw new Error("XCH requires an erasable-memory operand");
    }

    if (card.opcode === "TS" && target.region !== "E") {
        throw new Error("TS requires an erasable-memory operand");
    }

    if (card.opcode === "TC" && target.region !== "F" && target.region !== "Q") {
        throw new Error("TC requires a fixed-memory instruction target");
    }

    if (card.opcode === "CCS" && target.region !== "E") {
        throw new Error("CCS requires an erasable-memory operand");
    }

    const addressTableID = getAddressTableID(target);
    return (opcodeBits << 12) | addressTableID;
}

export function DecodeIns(binary) {
    const opcodeBits = (binary >>> 12) & 0xF;
    const addressTableID = binary & 0x0FFF;
    const target = machine.addressTable[addressTableID];

    if (!target) {
        throw new Error(`Address-table ID ${addressTableID} does not exist`);
    }

    let opcode = OPCODE_NAMES[opcodeBits];

    if (opcodeBits === 3 && target.region === "F") {
        opcode = "CAF";
    }

    if (!opcode) {
        throw new Error(`Unknown encoded opcode ${opcodeBits}`);
    }

    return {
        opcode,
        opcodeBits,
        addressTableID,
        target
    };
}

function encodeOctal(octalText) {
    if (!/^-?[0-7]+$/.test(octalText)) {
        throw new Error(`Invalid octal value "${octalText}"`);
    }

    const isNegative = octalText.startsWith("-");
    const digits = isNegative ? octalText.slice(1) : octalText;
    const value = parseInt(digits, 8);

    if (isNegative) {
        return encodeNum(-value);
    }

    if (value > 0x7FFF) {
        throw new RangeError("OCT value cannot exceed 77777");
    }

    return value;
}

/**
 * Assemble the HTML card list in two passes.
 * @param {Card[]} cardList
 */
export function assemble(cardList) {
    if (!Array.isArray(cardList)) {
        throw new TypeError("assemble() expected an array of cards");
    }

    resetAssembly();

    let eOffset = 0;
    let fOffset = 0;
    let eBank = 0;
    let fBank = 0;
    let firstInstruction = null;
    let startInstruction = null;

    /* PASS 1: assign locations and build the symbol table. */
    for (const card of cardList) {
        const line = {
            cardNumber: card.number,
            label: (card.label || "").trim().toUpperCase(),
            opcode: (card.opcode || "").trim().toUpperCase(),
            operand: (card.operand || "").trim().toUpperCase(),
            comment: (card.comment || "").trim(),
            region: null,
            bankNum: null,
            bankOffset: null,
            error: null
        };

        machine.sourceLines.push(line);

        // Blank/comment-only cards do not occupy memory.
        if (!line.opcode) {
            continue;
        }

        if (line.opcode === "ERASE") {
            if (eBank >= ERASABLE_BANK_COUNT) {
                addLineError(line, "Cannot exceed 8 banks of 256 words in erasable memory");
                continue;
            }

            line.region = "E";
            line.bankNum = eBank;
            line.bankOffset = eOffset;

            eOffset++;
            if (eOffset === ERASABLE_BANK_SIZE) {
                eOffset = 0;
                eBank++;
            }
        } else {
            if (fBank >= FIXED_BANK_COUNT) {
                addLineError(line, "Cannot exceed 36 banks of 1024 words in fixed memory");
                continue;
            }

            line.region = "F";
            line.bankNum = fBank;
            line.bankOffset = fOffset;

            fOffset++;
            if (fOffset === FIXED_BANK_SIZE) {
                fOffset = 0;
                fBank++;
            }
        }

        if (line.label) {
            if (symbolTable.has(line.label)) {
                addLineError(line, `Duplicate label "${line.label}"`);
            } else {
                symbolTable.set(line.label, {
                    region: line.region,
                    bankNum: line.bankNum,
                    bankOffset: line.bankOffset
                });
            }
        }

        if (OPCODE_BITS[line.opcode] !== undefined) {
            const location = {
                region: line.region,
                bankNum: line.bankNum,
                bankOffset: line.bankOffset
            };

            if (firstInstruction === null) {
                firstInstruction = location;
            }

            if (line.label === "START") {
                startInstruction = location;
            }
        }
    }

    machine.entryPoint = startInstruction || firstInstruction;

    if (machine.entryPoint === null) {
        machine.errors.push("Program does not contain an executable instruction");
    }

    /* PASS 2: resolve operands, build the address table, and write memory. */
    for (const line of machine.sourceLines) {
        if (line.region === null) {
            continue;
        }

        if (line.opcode === "ERASE") {
            if (line.operand) {
                addLineError(line, "ERASE does not take an operand");
            }

            const memoryIndex = erasableIndex(line.bankNum, line.bankOffset);
            machine.erasableMemory[memoryIndex] = 0;
            continue;
        }

        const memoryIndex = fixedIndex(line.bankNum, line.bankOffset);

        if (line.opcode === "OCT") {
            try {
                machine.fixedMemory[memoryIndex] = encodeOctal(line.operand);
            } catch (error) {
                addLineError(line, error.message);
            }

            continue;
        }

        try {
            const encodedWord = encodeIns(line);
            const addressTableID = encodedWord & 0x0FFF;

            machine.fixedMemory[memoryIndex] = encodedWord;
            machine.program[memoryIndex] = {
                ...line,
                encodedWord,
                addressTableID
            };
        } catch (error) {
            addLineError(line, error.message);
        }
    }

    if (machine.entryPoint !== null) {
        machine.registers.FBANK = machine.entryPoint.bankNum;
        machine.registers.Z = fixedIndex(
            machine.entryPoint.bankNum,
            machine.entryPoint.bankOffset
        );
    }

    if (machine.errors.length === 0) {
        machine.status = "ready";
        machine.message = "Ready to step or run.";
    } else {
        machine.status = "error";
        machine.message = `${machine.errors.length} assembly error(s).`;
    }

    // Keep the return shape expected by renderListing() in the HTML.
    const listingSymbolTable = {};
    for (const [label, location] of symbolTable) {
        listingSymbolTable[label] = formatLocation(location);
    }

    return {
        program: machine.sourceLines
            .filter(line => line.region !== null)
            .map(line => ({
                address: formatLocation(line),
                cardNumber: line.cardNumber,
                label: line.label,
                opcode: line.opcode,
                operand: line.operand,
                comment: line.comment,
                error: line.error
            })),
        symbolTable: listingSymbolTable,
        dangling: [],
        errors: machine.errors,
        addressTable: machine.addressTable
    };
}

"use strict";

import { machine } from "./machine.js";
import { assemble } from "./assembler.js";
import { stepMachine } from "./cpu.js";
import {
  FIXED_BANK_SIZE, OPCODE_NAMES, INSTRUCTION_SET, ASSEMBLER_FEATURES,
  erasableIndex, fixedIndex, formatLocation, decodeNum
} from "./isa.js";

/* =========================================================================
   CARD GEOMETRY  (all units are SVG user-space units, shared by every card)
   ========================================================================= */
const COLS        = 80;
const PITCH        = 16;     // horizontal distance between column centers
const MARGIN_L      = 70;
const MARGIN_R      = 70;
const CARD_W        = MARGIN_L + COLS * PITCH + MARGIN_R;      // 1420
const ROWS          = ['12','11','0','1','2','3','4','5','6','7','8','9']; // top->bottom
const ROW_PITCH      = 40;
const TOP_PAD        = 22;
const PRINT_LINE_H    = 34;
const GAP_PRINT_ROWS   = 12;
const ROWS_TOP_Y      = TOP_PAD + PRINT_LINE_H + GAP_PRINT_ROWS; // 68
const BOTTOM_PAD      = 26;
const CARD_H        = ROWS_TOP_Y + ROWS.length * ROW_PITCH + BOTTOM_PAD; // 574
const CORNER_CUT      = 30;
const HOLE_W        = 8;
const HOLE_H        = 22;

function colX(i){ return MARGIN_L + (i - 0.5) * PITCH; }
function rowY(r){ return ROWS_TOP_Y + (r + 0.5) * ROW_PITCH; }

const opCodeSet = new Set([...OPCODE_NAMES, ...Object.keys(ASSEMBLER_FEATURES)]);
const labelSet = new Set([]);

/* =========================================================================
   FIELD LAYOUT — columns 1-80 split into label / blank / opcode / operand / comment
   ========================================================================= */
const FIELDS = {
  label:   { start: 1,  len: 8  },
  blank:   { start: 9,  len: 1  },
  opcode:  { start: 10, len: 6  },
  operand: { start: 16, len: 9  },
  comment: { start: 25, len: 56 }
};

function pad(str, len){
  str = (str || '').toString().toUpperCase().slice(0, len);
  while (str.length < len) str += ' ';
  return str;
}

function buildLine80(fields){
  return pad(fields.label, 8) + ' ' + pad(fields.opcode, 6) + pad(fields.operand, 9) + pad(fields.comment, 56);
}

/* =========================================================================
   HOLLERITH / IBM 029 PUNCH ENCODING
   Rules (from the reference chart):
     digits 0-9        -> single punch in that digit row, no zone
     A-I                -> zone 12 + digit 1-9
     J-R                -> zone 11 + digit 1-9
     S-Z                -> zone 0  + digit 2-9
     space              -> no punch
     & - / and a handful of punctuation marks use the standard 029 code-plate
     combinations. Anything not recognised punches nothing (renders blank).
   ========================================================================= */
const SPECIAL_PUNCHES = {
  '&': ['12'],
  '-': ['11'],
  '/': ['0','1'],
  ',': ['0','3','8'],
  '%': ['0','4','8'],
  '_': ['0','5','8'],
  '>': ['0','6','8'],
  '?': ['0','7','8'],
  ':': ['2','8'],
  '#': ['3','8'],
  '@': ['4','8'],
  "'": ['5','8'],
  '=': ['6','8'],
  '"': ['7','8'],
  '.': ['12','3','8'],
  '<': ['12','4','8'],
  '(': ['12','5','8'],
  '+': ['12','6','8'],
  '|': ['12','7','8'],
  '!': ['11','2','8'],
  '$': ['11','3','8'],
  '*': ['11','4','8'],
  ')': ['11','5','8'],
  ';': ['11','6','8'],
  '\u00AC': ['11','7','8'] // logical-not, rarely typed but historically on the 029 plate
};

function getPunchRows(ch){
  if (!ch || ch === ' ') return [];
  ch = ch.toUpperCase();
  if (ch >= '0' && ch <= '9') return [ch];
  if (ch >= 'A' && ch <= 'I') return ['12', String('ABCDEFGHI'.indexOf(ch) + 1)];
  if (ch >= 'J' && ch <= 'R') return ['11', String('JKLMNOPQR'.indexOf(ch) + 1)];
  if (ch >= 'S' && ch <= 'Z') return ['0', String('STUVWXYZ'.indexOf(ch) + 2)];
  return SPECIAL_PUNCHES[ch] || [];
}

// characters we accept from the keyboard (uppercased); everything else is dropped
const ALLOWED_CHARS = /[A-Z0-9 &\-\/,%_>?:#@'"=.<(+|!$*);]/;
function sanitize(raw, maxLen){
  let out = '';
  raw = (raw || '').toUpperCase();
  for (const ch of raw){
    if (ALLOWED_CHARS.test(ch)) out += ch;
    if (out.length >= maxLen) break;
  }
  return out;
}

function escapeXML(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* =========================================================================
   SVG BUILDING
   ========================================================================= */
function buildCardBaseMarkup(){
  let s = '';
  s += `<path class="card-outline" d="M ${CORNER_CUT} 0 L ${CARD_W} 0 L ${CARD_W} ${CARD_H} L 0 ${CARD_H} L 0 ${CORNER_CUT} Z"/>`;
  s += `<line class="card-rule" x1="${MARGIN_L - 24}" y1="${ROWS_TOP_Y - 8}" x2="${CARD_W - MARGIN_R + 24}" y2="${ROWS_TOP_Y - 8}"/>`;
  ROWS.forEach((label, r) => {
    const y = rowY(r) + 5;
    s += `<text class="row-label" x="${MARGIN_L - 14}" y="${y}" text-anchor="end">${label}</text>`;
    s += `<text class="row-label" x="${CARD_W - MARGIN_R + 14}" y="${y}" text-anchor="start">${label}</text>`;
    if (r >= 2){ // rows '0' through '9' get a faint pre-printed guide digit in every column
      for (let i = 1; i <= COLS; i++){
        s += `<text class="guide-digit" x="${colX(i)}" y="${y}" text-anchor="middle">${label}</text>`;
      }
    }
  });
  return s;
}

function buildCardSVG(line80){
  let tspans = '';
  for (let i = 1; i <= 80; i++){
    const ch = line80[i-1] || ' ';
    tspans += `<tspan x="${colX(i)}">${escapeXML(ch)}</tspan>`;
  }
  let holes = '';
  for (let i = 1; i <= 80; i++){
    const ch = line80[i-1] || ' ';
    getPunchRows(ch).forEach(rowLabel => {
      const r = ROWS.indexOf(rowLabel);
      const x = colX(i), y = rowY(r);
      holes += `<rect class="punch-hole" x="${(x - HOLE_W/2).toFixed(1)}" y="${(y - HOLE_H/2).toFixed(1)}" width="${HOLE_W}" height="${HOLE_H}" rx="2"/>`;
    });
  }
  return `<svg viewBox="0 0 ${CARD_W} ${CARD_H}" class="punch-card-svg" xmlns="http://www.w3.org/2000/svg">
    <use href="#cardBase"></use>
    <text class="print-line" y="${TOP_PAD + PRINT_LINE_H*0.72}">${tspans}</text>
    <g class="holes">${holes}</g>
  </svg>`;
}

function prettyLine(card){
  const parts = [];
  if (card.label.trim())   parts.push(card.label.trim());
  if (card.opcode.trim())  parts.push(card.opcode.trim());
  if (card.operand.trim()) parts.push(card.operand.trim());
  let line = parts.join('  ');
  if (card.comment.trim()) line += (line ? '    ' : '') + card.comment.trim();
  return line || '\u00A0';
}

/* =========================================================================
   APP STATE
   ========================================================================= */
let cards = [];       // {id, number, label, opcode, operand, comment}
let editingId = null;
let nextId = 1;

// Native confirm()/alert() dialogs are unreliable inside sandboxed preview
// frames (they can be silently blocked), so every "are you sure?" and error
// message in this app is rendered inline instead. This little state object
// tracks which inline prompt, if any, is currently showing.
const ui = {
  pendingDeleteId: null, // card id currently showing an inline delete-confirm
  pendingClearDeck: false,
  pendingSeed: false,
  statusMsg: ''
};
function clearTransientUi(){
  ui.pendingDeleteId = null;
  ui.pendingClearDeck = false;
  ui.pendingSeed = false;
}

function blankFields(){ return { label:'', opcode:'', operand:'', comment:'' }; }

function renumber(){ cards.forEach((c, i) => c.number = i + 1); }

function addOrUpdateCard(fields){
  if (editingId){
    const c = cards.find(c => c.id === editingId);
    if (c) Object.assign(c, fields);
    editingId = null;
  } else {
    cards.push(Object.assign({ id: nextId++, number: cards.length + 1 }, fields));
  }
  renumber();
  saveDeck();
  renderDeck();
}

function setCardNumber(id, rawNumber){
  let n = parseInt(rawNumber, 10);
  const idx = cards.findIndex(c => c.id === id);
  if (idx === -1 || isNaN(n)) { renderDeck(); return; }
  const [card] = cards.splice(idx, 1);
  n = Math.max(1, Math.min(n, cards.length + 1));
  cards.splice(n - 1, 0, card);
  renumber();
  saveDeck();
  renderDeck();
}

function deleteCard(id){
  const card = cards.find(c => c.id === id);
  if (card && card.label) labelSet.delete(card.label);
  cards = cards.filter(c => c.id !== id);
  if (editingId === id) exitEditMode();
  clearTransientUi();
  renumber();
  saveDeck();
  renderDeck();
}

function loadCardIntoForm(card){
  editingId = card.id;
  els.inLabel.value = card.label;
  els.inOpcode.value = card.opcode;
  els.inOperand.value = card.operand;
  els.inComment.value = card.comment;
  els.editingNum.textContent = card.number;
  els.editBanner.classList.add('show');
  els.btnPunch.textContent = '⏎ Update Card';
  updatePreview();
  els.inLabel.focus();
  renderDeck();
}

function exitEditMode(){
  editingId = null;
  els.editBanner.classList.remove('show');
  els.btnPunch.textContent = '⏎ Punch Card';
}

/* =========================================================================
   DOM WIRING
   ========================================================================= */
const els = {};

function currentFormFields(){
  return {
    label:   sanitize(els.inLabel.value, 8),
    opcode:  sanitize(els.inOpcode.value, 6),
    operand: sanitize(els.inOperand.value, 9),
    comment: sanitize(els.inComment.value, 56)
  };
}

function updatePreview(){
  const f = currentFormFields();
  els.previewTile.innerHTML = buildCardSVG(buildLine80(f));
}

function wireFormInput(el, maxLen){
  el.addEventListener('input', () => {
    const clean = sanitize(el.value, maxLen);
    if (el.value !== clean) el.value = clean;
    updatePreview();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); els.btnPunch.click(); }
  });
}

function cardSlotHTML(card){
  const svg = buildCardSVG(buildLine80(card));
  const plain = prettyLine(card);
  const actions = (ui.pendingDeleteId === card.id)
    ? `<div class="card-slot-confirm">Delete?
         <button class="icon-btn danger" title="Confirm delete" data-role="delete-confirm" data-id="${card.id}">✓</button>
         <button class="icon-btn" title="Cancel" data-role="delete-cancel" data-id="${card.id}">✕</button>
       </div>`
    : `<div class="card-slot-actions">
         <button class="icon-btn" title="Edit" data-role="edit" data-id="${card.id}">✎</button>
         <button class="icon-btn danger" title="Delete" data-role="delete" data-id="${card.id}">✕</button>
       </div>`;
  return `
  <div class="card-slot ${card.id === editingId ? 'editing' : ''}" data-id="${card.id}">
    <div class="card-slot-top">
      <div class="card-num-badge"><span>#</span><input type="number" min="1" class="card-num-input" value="${card.number}" data-role="num" data-id="${card.id}"></div>
      ${actions}
    </div>
    <div class="card-plain-text">${escapeXML(plain)}</div>
    <div class="card-tile">${svg}</div>
  </div>`;
}

function deckStatusHTML(){
  if (ui.pendingClearDeck){
    return `<div class="confirm-bar">Clear all ${cards.length} card${cards.length===1?'':'s'}? This can't be undone.
      <button class="btn btn-sm btn-danger" data-role="clear-confirm">Confirm clear</button>
      <button class="btn btn-sm btn-ghost" data-role="clear-cancel">Cancel</button></div>`;
  }
  if (ui.pendingSeed){
    return `<div class="confirm-bar">This replaces your current deck with the example deck.
      <button class="btn btn-sm btn-primary" data-role="seed-confirm">Replace deck</button>
      <button class="btn btn-sm btn-ghost" data-role="seed-cancel">Cancel</button></div>`;
  }
  if (ui.statusMsg){
    return `<div class="confirm-bar"><span class="status-msg">${escapeXML(ui.statusMsg)}</span>
      <button class="btn btn-sm btn-ghost" data-role="status-dismiss">Dismiss</button></div>`;
  }
  return '';
}

function renderDeck(){
  els.deckCountLabel.textContent = `(${cards.length} card${cards.length===1?'':'s'})`;
  els.deckStatusArea.innerHTML = deckStatusHTML();
  if (!cards.length){
    els.deckGrid.innerHTML = `<div class="empty-deck">No cards yet — punch your first line above, or load the example deck.</div>`;
    return;
  }
  els.deckGrid.innerHTML = cards.map(cardSlotHTML).join('');
}

function renderHero(){
  const line = pad('Welcome to the Apollo Guidance Computer Programming Simulator', 0); // will center manually below
  const text = 'Welcome to the Apollo Guidance Computer Programming Simulator';
  const startCol = Math.floor((80 - text.length) / 2) + 1;
  let line80 = ' '.repeat(80).split('');
  for (let i = 0; i < text.length; i++) line80[startCol - 1 + i] = text[i];
  els.heroCard.innerHTML = buildCardSVG(line80.join(''));
}

function renderIsaTable(){
  const tbody = els.isaTable.querySelector('tbody');
  const entries = { ...INSTRUCTION_SET, ...ASSEMBLER_FEATURES };
  tbody.innerHTML = Object.keys(entries).map(op => {
    const info = entries[op];
    return `<tr><td class="isa-op">${op}</td><td><span class="isa-tag ${info.cls}">${info.cls}</span></td><td>${info.desc}</td></tr>`;
  }).join('');
}

function renderListing(result){
  const { program, symbolTable, dangling, errors } = result;
  let out = '';
  program.forEach(instr => {
    const addr = String(instr.address).padStart(5,'0');
    const lab = (instr.label || '').padEnd(8,' ');
    const op = (instr.opcode || '').padEnd(6,' ');
    const oper = (instr.operand || '').padEnd(9,' ');
    if (instr.error){
      out += `<span class="addr">${addr}</span>  <span class="lab">${escapeXML(lab)}</span><span class="op">${escapeXML(op)}</span>${escapeXML(oper)} <span class="err">! ${instr.error}</span>\n`;
    } else {
      out += `<span class="addr">${addr}</span>  <span class="lab">${escapeXML(lab)}</span><span class="op">${escapeXML(op)}</span>${escapeXML(oper)} ${instr.comment ? '; ' + escapeXML(instr.comment) : ''}\n`;
    }
  });
  out += `\n-- symbol table (${Object.keys(symbolTable).length}) --\n`;
  Object.keys(symbolTable).forEach(sym => {
    out += `${escapeXML(sym.padEnd(10,' '))} = ${escapeXML(String(symbolTable[sym]).padStart(5,'0'))}\n`;
  });
  if (dangling.length){
    out += `\n-- labels with no following instruction --\n${dangling.join(', ')}\n`;
  }
  if (errors.length){
    out += `\n-- errors --\n${errors.map(escapeXML).join('\n')}\n`;
  }
  return out || '(empty deck)';
}

function displayWord(word){
  const value = decodeNum(word);
  const decimal = Object.is(value, -0) ? '-0' : String(value);
  return `${decimal} (oct ${word.toString(8).padStart(5, '0')})`;
}

function displayPC(index){
  if (index === null) return '—';
  const bank = Math.floor(index / FIXED_BANK_SIZE);
  const offset = index % FIXED_BANK_SIZE;
  return `F${bank}:${String(offset).padStart(4, '0')}`;
}

function renderMachineState(){
  if (!els.simStatus) return;

  els.simStatus.textContent = `${machine.status.toUpperCase()} — ${machine.message}`;
  els.btnStep.disabled = !['ready', 'paused'].includes(machine.status);
  els.btnRun.disabled = !['ready', 'paused', 'running'].includes(machine.status);
  els.btnRun.textContent = machine.status === 'running' ? 'Pause Ⅱ' : 'Run ▸';
  els.btnReset.disabled = machine.status === 'idle';

  const r = machine.registers;
  const next = machine.program[r.Z];
  const last = machine.lastInstruction;
  els.registerOut.textContent = [
    `A       ${displayWord(r.A)}`,
    `L       ${displayWord(r.L)}`,
    `Q       ${displayPC(r.Q)}`,
    `Z       ${displayPC(r.Z)}`,
    `EBANK   ${r.EBANK}`,
    `FBANK   ${r.FBANK}`,
    `Overflow ${machine.overflow > 0 ? '+1' : machine.overflow < 0 ? '-1' : '0'}`,
    `INDEX   ${machine.pendingIndex === null ? 'none' : machine.pendingIndex}`,
    `Steps   ${machine.steps}`,
    `Last    ${last ? `#${last.cardNumber} ${last.opcode} ${last.operand}` : '—'}`,
    `Next    ${next ? `#${next.cardNumber} ${next.opcode} ${next.operand}` : '—'}`
  ].join('\n');

  const dataLines = machine.sourceLines.filter(line =>
    line.label && line.region && ['ERASE', 'OCT'].includes(line.opcode)
  );
  els.memoryOut.textContent = dataLines.length ? dataLines.map(line => {
    const index = line.region === 'E'
      ? erasableIndex(line.bankNum, line.bankOffset)
      : fixedIndex(line.bankNum, line.bankOffset);
    const word = line.region === 'E'
      ? machine.erasableMemory[index]
      : machine.fixedMemory[index];
    return `${line.label.padEnd(8)} ${formatLocation(line)}  ${displayWord(word)}`;
  }).join('\n') : 'No named ERASE or OCT words.';
}

let runToken = 0;
function startRun(){
  if (!['ready', 'paused'].includes(machine.status)) return;

  const token = ++runToken;
  let remaining = 10000;
  machine.status = 'running';
  machine.message = 'Executing instructions…';
  renderMachineState();

  function batch(){
    if (token !== runToken || machine.status !== 'running') return;

    for (let count = 0; count < 200 && remaining > 0 && machine.status === 'running'; count++){
      stepMachine();
      remaining--;
    }

    if (machine.status === 'running' && remaining === 0){
      machine.status = 'paused';
      machine.message = 'Paused after 10,000 steps; the program may contain a loop.';
    }

    renderMachineState();
    if (machine.status === 'running') setTimeout(batch, 0);
  }

  setTimeout(batch, 0);
}

/* =========================================================================
   PERSISTENCE (browser localStorage on GitHub Pages)
   ========================================================================= */
const STORAGE_KEY = 'agc-keypunch-deck-v1';
let saveTimer = null;
function saveDeck(){
  if (['ready', 'paused', 'running', 'finished', 'error'].includes(machine.status)){
    runToken++;
    machine.status = 'stale';
    machine.message = 'Deck changed. Assemble it again before running.';
    renderMachineState();
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const savedDeck = JSON.stringify({ cards, nextId });
    if (window.storage) {
      window.storage.set(STORAGE_KEY, savedDeck).catch(() => {});
    } else {
      try { window.localStorage.setItem(STORAGE_KEY, savedDeck); }
      catch (error) { /* private browsing may disable storage */ }
    }
  }, 250);
}
async function loadDeck(){
  try{
    const savedDeck = window.storage
      ? (await window.storage.get(STORAGE_KEY))?.value
      : window.localStorage.getItem(STORAGE_KEY);
    if (savedDeck){
      const data = JSON.parse(savedDeck);
      if (Array.isArray(data.cards)){
        cards = data.cards;
        nextId = data.nextId || (cards.reduce((m,c)=>Math.max(m,c.id),0) + 1);
        labelSet.clear();
        cards.forEach(card => { if (card.label) labelSet.add(card.label); });
        return true;
      }
    }
  } catch(e){ /* no stored deck yet */ }
  return false;
}

const EXAMPLE_DECK = [
  { label:'COUNT', opcode:'ERASE', operand:'',      comment:'RESERVE ERASABLE STORAGE' },
  { label:'VALUE', opcode:'OCT',   operand:'25',    comment:'OCTAL CONSTANT' },
  { label:'START', opcode:'CAF',   operand:'VALUE', comment:'LOAD VALUE INTO A' },
  { label:'',      opcode:'TS',    operand:'COUNT', comment:'STORE A INTO COUNT' }
];
function seedExampleDeck(){
  cards = EXAMPLE_DECK.map(f => Object.assign({ id: nextId++ }, f));
  labelSet.clear();
  cards.forEach(card => { if (card.label) labelSet.add(card.label); });
  renumber();
  saveDeck();
  renderDeck();
}

/* =========================================================================
   INIT
   ========================================================================= */
function init(){
  els.inLabel      = document.getElementById('inLabel');
  els.inOpcode     = document.getElementById('inOpcode');
  els.inOperand    = document.getElementById('inOperand');
  els.inComment    = document.getElementById('inComment');
  els.btnPunch     = document.getElementById('btnPunch');
  els.btnClearForm = document.getElementById('btnClearForm');
  els.editBanner   = document.getElementById('editBanner');
  els.editingNum   = document.getElementById('editingNum');
  els.cancelEdit   = document.getElementById('cancelEdit');
  els.previewTile  = document.getElementById('previewTile');
  els.deckGrid     = document.getElementById('deckGrid');
  els.deckStatusArea = document.getElementById('deckStatusArea');
  els.deckCountLabel = document.getElementById('deckCountLabel');
  els.btnExport    = document.getElementById('btnExport');
  els.btnImport    = document.getElementById('btnImport');
  els.fileImport   = document.getElementById('fileImport');
  els.btnSeed      = document.getElementById('btnSeed');
  els.btnClearDeck = document.getElementById('btnClearDeck');
  els.heroCard     = document.getElementById('heroCard');
  els.isaTable     = document.getElementById('isaTable');
  els.btnAssemble  = document.getElementById('btnAssemble');
  els.btnStep      = document.getElementById('btnStep');
  els.btnRun       = document.getElementById('btnRun');
  els.btnReset     = document.getElementById('btnReset');
  els.listingOut   = document.getElementById('listingOut');
  els.simStatus    = document.getElementById('simStatus');
  els.registerOut  = document.getElementById('registerOut');
  els.memoryOut    = document.getElementById('memoryOut');

  document.getElementById('cardBase').innerHTML = buildCardBaseMarkup();
  document.getElementById('cardBase').setAttribute('viewBox', `0 0 ${CARD_W} ${CARD_H}`);

  wireFormInput(els.inLabel, 8);
  wireFormInput(els.inOpcode, 6);
  wireFormInput(els.inOperand, 9);
  wireFormInput(els.inComment, 56);

  els.btnPunch.addEventListener('click', () => {
    const f = currentFormFields();
    if ((!f.label && !f.opcode && !f.operand && !f.comment) || !opCodeSet.has(f.opcode) || labelSet.has(f.label)) return;
    addOrUpdateCard(f);
    labelSet.add(f.label);
    exitEditMode();
    els.inLabel.value = els.inOpcode.value = els.inOperand.value = els.inComment.value = '';
    updatePreview();
    els.inLabel.focus();
  });

  els.btnClearForm.addEventListener('click', () => {
    els.inLabel.value = els.inOpcode.value = els.inOperand.value = els.inComment.value = '';
    updatePreview();
  });

  els.cancelEdit.addEventListener('click', () => {
    exitEditMode();
    els.inLabel.value = els.inOpcode.value = els.inOperand.value = els.inComment.value = '';
    updatePreview();
    renderDeck();
  });

  els.deckGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    if (btn.dataset.role === 'delete'){
      ui.pendingDeleteId = id;
      renderDeck();
    } else if (btn.dataset.role === 'delete-confirm'){
      deleteCard(id);
    } else if (btn.dataset.role === 'delete-cancel'){
      ui.pendingDeleteId = null;
      renderDeck();
    } else if (btn.dataset.role === 'edit'){
      const card = cards.find(c => c.id === id);
      if (card) loadCardIntoForm(card);
    }
  });
  els.deckGrid.addEventListener('change', (e) => {
    const inp = e.target.closest('[data-role="num"]');
    if (!inp) return;
    setCardNumber(parseInt(inp.dataset.id, 10), inp.value);
  });

  els.btnClearDeck.addEventListener('click', () => {
    if (!cards.length) return;
    clearTransientUi();
    ui.pendingClearDeck = true;
    renderDeck();
  });

  els.btnSeed.addEventListener('click', () => {
    if (cards.length){
      clearTransientUi();
      ui.pendingSeed = true;
      renderDeck();
    } else {
      seedExampleDeck();
    }
  });

  els.deckStatusArea.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    if (btn.dataset.role === 'clear-confirm'){
      labelSet.clear();
      cards = [];
      exitEditMode();
      clearTransientUi();
      saveDeck();
      renderDeck();
    } else if (btn.dataset.role === 'clear-cancel'){
      clearTransientUi();
      renderDeck();
    } else if (btn.dataset.role === 'seed-confirm'){
      clearTransientUi();
      seedExampleDeck();
    } else if (btn.dataset.role === 'seed-cancel'){
      clearTransientUi();
      renderDeck();
    } else if (btn.dataset.role === 'status-dismiss'){
      ui.statusMsg = '';
      renderDeck();
    }
  });

  els.btnExport.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(cards, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'agc-deck.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
  els.btnImport.addEventListener('click', () => els.fileImport.click());
  els.fileImport.addEventListener('change', () => {
    const file = els.fileImport.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const data = JSON.parse(reader.result);
        if (Array.isArray(data)){
          cards = data.map(f => Object.assign({ id: nextId++ }, blankFields(), f));
          labelSet.clear();
          cards.forEach(c => { if (c.label) labelSet.add(c.label); });
          renumber();
          clearTransientUi();
          saveDeck();
          renderDeck();
        } else {
          throw new Error('not an array');
        }
      } catch(e){
        clearTransientUi();
        ui.statusMsg = 'That file did not look like a valid deck export.';
        renderDeck();
      }
    };
    reader.readAsText(file);
    els.fileImport.value = '';
  });

  els.btnAssemble.addEventListener('click', () => {
    runToken++;
    const result = assemble(cards);
    els.listingOut.innerHTML = renderListing(result);
    renderMachineState();
  });

  els.btnStep.addEventListener('click', () => {
    stepMachine();
    renderMachineState();
  });

  els.btnRun.addEventListener('click', () => {
    if (machine.status === 'running'){
      runToken++;
      machine.status = 'paused';
      machine.message = 'Paused by user.';
      renderMachineState();
    } else {
      startRun();
    }
  });

  els.btnReset.addEventListener('click', () => {
    runToken++;
    const result = assemble(cards);
    els.listingOut.innerHTML = renderListing(result);
    renderMachineState();
  });

  renderIsaTable();
  renderHero();
  updatePreview();
  renderMachineState();

  loadDeck().then(had => {
    if (!had && !cards.length) seedExampleDeck();
    renderDeck();
  });
}

document.addEventListener('DOMContentLoaded', init);

# AGC Keypunch Simulator

AGC-inspired assembly simulator that I built for fun :3 
Punch one assembly line per card, assemble the deck, then step or run it while watching the registers and named memory.

The site runs entirely in the browser. It needs no backend, framework, build step, or npm dependencies. Decks are saved in the current browser's storage; they are not synced between devices.

## Project structure

```text
index.html              Page structure and entry point
style.css               Site styles and embedded punch-card font
js/isa.js               Instruction definitions, word conversion, bank constants
js/machine.js           Shared registers and memory
js/assembler.js         Two-pass assembly, labels, address table
js/cpu.js               Instruction behavior, step and run
js/ui.js                Punch cards, buttons, deck storage, state display
```

## To Run locally

ES modules need an HTTP server; opening `index.html` with a `file://` URL may fail. From this directory, run a local static server such as `py -m http.server 8000`, then open `http://localhost:8000/`. Run `npm test` to execute the tests (Node.js required).


## Accuracy note

This is not a cycle-accurate Apollo Guidance Computer emulator. It uses a custom 4-bit opcode plus 12-bit address-table ID, automatic bank switching, and simplified arithmetic and `INDEX` behavior. These choices make the assembly process and machine state easier to explore.

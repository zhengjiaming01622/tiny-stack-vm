// Tiny stack VM for make.fun's tiny-stack-vm-01: a complete interpreter
// for the kit's tiny stack ISA, following ISA.md rule by rule.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Immediate length (IMM -1 = not an opcode), pops and pushes per opcode.
const IMM = new Int8Array(256).fill(-1);
const POPS = new Int8Array(256);
const PUSHES = new Int8Array(256);
function def(op: number, imm: number, pops: number, pushes: number) {
  IMM[op] = imm;
  POPS[op] = pops;
  PUSHES[op] = pushes;
}
def(0x00, 0, 0, 0); // HALT
def(0x01, 1, 0, 1); // PUSH8
def(0x02, 4, 0, 1); // PUSH32
def(0x03, 0, 1, 0); // POP
def(0x04, 0, 1, 2); // DUP
def(0x05, 0, 2, 2); // SWAP
def(0x06, 0, 2, 3); // OVER
def(0x07, 0, 3, 3); // ROT
for (const op of [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x18, 0x19, 0x1a, 0x1c, 0x1d, 0x1e, 0x20, 0x21, 0x22]) def(op, 0, 2, 1);
def(0x17, 0, 1, 1); // NEG
def(0x1b, 0, 1, 1); // NOT
def(0x30, 2, 0, 0); // JMP
def(0x31, 2, 1, 0); // JZ
def(0x32, 2, 1, 0); // JNZ
def(0x33, 2, 0, 0); // CALL
def(0x34, 0, 0, 0); // RET
def(0x40, 0, 1, 1); // LOAD
def(0x41, 0, 2, 0); // STORE
def(0x50, 0, 1, 0); // PRINT
def(0x51, 0, 1, 0); // PUTC
def(0x52, 0, 0, 1); // IN
def(0x53, 0, 1, 0); // EXIT

const encoder = new TextEncoder();

function run(program: Uint8Array, input: Uint8Array): { out: Uint8Array; code: number } {
  const stack = new Int32Array(256);
  let sp = 0;
  const calls = new Int32Array(64);
  let csp = 0;
  const memory = new Int32Array(256);
  const out = new Uint8Array(65536);
  let outLen = 0;
  let inPos = 0;
  let pc = 0;
  let steps = 0;
  const finish = (code: number) => ({ out: out.slice(0, outLen), code });

  for (;;) {
    // One step, in ISA.md's order: step limit, pc bounds, opcode,
    // immediate fit, stack needs, then the instruction's own traps.
    if (steps === 1000000) return finish(10);
    if (pc < 0 || pc >= program.length) return finish(9);
    const op = program[pc];
    const imm = IMM[op];
    if (imm < 0) return finish(5);
    if (imm > 0 && pc + imm >= program.length) return finish(9);
    steps++;
    if (sp < POPS[op]) return finish(2);
    if (sp - POPS[op] + PUSHES[op] > 256) return finish(3);
    const next = pc + 1 + imm;

    switch (op) {
      case 0x00: // HALT
        return finish(0);
      case 0x01: // PUSH8
        stack[sp++] = (program[pc + 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32
        stack[sp++] = program[pc + 1] | (program[pc + 2] << 8) | (program[pc + 3] << 16) | (program[pc + 4] << 24);
        break;
      case 0x03: // POP
        sp--;
        break;
      case 0x04: // DUP
        stack[sp] = stack[sp - 1];
        sp++;
        break;
      case 0x05: { // SWAP
        const top = stack[sp - 1];
        stack[sp - 1] = stack[sp - 2];
        stack[sp - 2] = top;
        break;
      }
      case 0x06: // OVER
        stack[sp] = stack[sp - 2];
        sp++;
        break;
      case 0x07: { // ROT: ( a b c -- b c a )
        const a = stack[sp - 3];
        stack[sp - 3] = stack[sp - 2];
        stack[sp - 2] = stack[sp - 1];
        stack[sp - 1] = a;
        break;
      }
      case 0x17: // NEG, wrapping
        stack[sp - 1] = (-stack[sp - 1]) | 0;
        break;
      case 0x1b: // NOT
        stack[sp - 1] = ~stack[sp - 1];
        break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = stack[sp - 1];
        const a = stack[sp - 2];
        let r = 0;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) { // DIV
          if (b === 0) return finish(4);
          r = a === -2147483648 && b === -1 ? a : Math.trunc(a / b) | 0;
        } else if (op === 0x14) { // MOD
          if (b === 0) return finish(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) { // DIVU
          if (b === 0) return finish(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) { // MODU
          if (b === 0) return finish(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        sp--;
        stack[sp - 1] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((program[pc + 1] | (program[pc + 2] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (op !== 0x30) {
          const v = stack[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        pc = take ? next + rel : next;
        continue;
      }
      case 0x33: // CALL
        if (csp === 64) return finish(7);
        calls[csp++] = next;
        pc = program[pc + 1] | (program[pc + 2] << 8);
        continue;
      case 0x34: // RET
        if (csp === 0) return finish(8);
        pc = calls[--csp];
        continue;
      case 0x40: { // LOAD
        const addr = stack[sp - 1];
        if (addr < 0 || addr > 255) return finish(6);
        stack[sp - 1] = memory[addr];
        break;
      }
      case 0x41: { // STORE
        const addr = stack[sp - 1];
        if (addr < 0 || addr > 255) return finish(6);
        memory[addr] = stack[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: { // PRINT
        const bytes = encoder.encode(String(stack[sp - 1]));
        if (outLen + bytes.length > 65536) return finish(11);
        sp--;
        out.set(bytes, outLen);
        outLen += bytes.length;
        break;
      }
      case 0x51: // PUTC
        if (outLen + 1 > 65536) return finish(11);
        out[outLen++] = stack[--sp] & 255;
        break;
      case 0x52: // IN
        stack[sp++] = inPos < input.length ? input[inPos++] : -1;
        break;
      case 0x53: // EXIT
        return finish(stack[--sp] & 255);
    }
    pc = next;
  }
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(inputDir).sort()) {
  const program = new Uint8Array(readFileSync(join(inputDir, id, 'program.bin')));
  const input = new Uint8Array(readFileSync(join(inputDir, id, 'input.bin')));
  const result = run(program, input);
  mkdirSync(join(outputDir, id), { recursive: true });
  writeFileSync(join(outputDir, id, 'stdout.bin'), result.out);
  writeFileSync(join(outputDir, id, 'exit.txt'), `${result.code}\n`);
}

import { contains, isWordCodePoint } from "./class.js";
import { type Instruction, OP, type Program } from "./compile.js";
import { REGEX_VISITS_PER_STEP } from "./limits.js";

/** Threads at one input position: a sparse set of program addresses, cleared in O(1). */
type ThreadList = { dense: Uint32Array; sparse: Uint32Array; size: number };

const newList = (capacity: number): ThreadList => ({
  dense: new Uint32Array(capacity),
  sparse: new Uint32Array(capacity),
  size: 0,
});

const has = (list: ThreadList, address: number): boolean => {
  const at = list.sparse[address] as number;
  return at < list.size && list.dense[at] === address;
};

const add = (list: ThreadList, address: number): void => {
  list.sparse[address] = list.size;
  list.dense[list.size] = address;
  list.size += 1;
};

const atBoundary = (text: readonly number[], at: number): boolean => {
  const before = at > 0 && isWordCodePoint(text[at - 1] as number);
  const after = at < text.length && isWordCodePoint(text[at] as number);
  return before !== after;
};

const assertionHolds = (instruction: Instruction, text: readonly number[], at: number): boolean => {
  if (instruction.type === "start") return at === 0;
  if (instruction.type === "end") return at === text.length;
  return atBoundary(text, at) === (instruction.type === "boundary");
};

/**
 * Follows the empty moves from `address` at input position `at`, adding every instruction reached
 * to `list`. `true` when the match instruction is reached. Iterative: a program can be a long chain.
 */
const follow = (
  code: readonly Instruction[],
  state: { list: ThreadList; stack: Uint32Array },
  text: readonly number[],
  start: { address: number; at: number },
): boolean => {
  const { list, stack } = state;
  let top = 0;
  stack[top++] = start.address;
  while (top > 0) {
    const address = stack[--top] as number;
    if (has(list, address)) continue;
    add(list, address);
    const instruction = code[address] as Instruction;
    if (instruction.op === OP.match) return true;
    if (instruction.op === OP.jump) stack[top++] = instruction.x;
    if (instruction.op === OP.split) {
      stack[top++] = instruction.y;
      stack[top++] = instruction.x;
    }
    if (instruction.op === OP.assert && assertionHolds(instruction, text, start.at)) {
      stack[top++] = address + 1;
    }
  }
  return false;
};

/**
 * Whether `program` matches anywhere in `input`: an unanchored search over code points, as
 * `RegExp(source, "u").test(input)`. Thompson/Pike simulation: every live thread advances one
 * code point at a time, so the work is at most (code points + 1) x program size, whatever the pattern.
 */
export const matchesProgram = (program: Program, input: string): boolean => {
  const { code } = program;
  const text = Array.from(input, (char) => char.codePointAt(0) as number);
  const stack = new Uint32Array(code.length * 2 + 2);
  let current = newList(code.length);
  let next = newList(code.length);
  for (let at = 0; at <= text.length; at += 1) {
    const threads = { list: current, stack };
    if (follow(code, threads, text, { address: 0, at })) return true;
    if (at === text.length) return false;
    next.size = 0;
    for (let index = 0; index < current.size; index += 1) {
      const address = current.dense[index] as number;
      const instruction = code[address] as Instruction;
      if (instruction.op !== OP.set || !contains(instruction.ranges, text[at] as number)) continue;
      if (follow(code, { list: next, stack }, text, { address: address + 1, at: at + 1 })) {
        return true;
      }
    }
    [current, next] = [next, current];
  }
  return false;
};

/** Step-budget units for matching `length` code units: the instruction visits it can take, at most. */
export const matchCost = (program: Program, length: number): number =>
  Math.max(1, Math.ceil(((length + 1) * program.code.length) / REGEX_VISITS_PER_STEP));

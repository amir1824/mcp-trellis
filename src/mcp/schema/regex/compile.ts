import type { Ranges } from "./class.js";
import { MAX_REGEX_PROGRAM_SIZE } from "./limits.js";
import { type AssertKind, type Node, RegexError } from "./parse.js";

export const OP = { set: 0, split: 1, jump: 2, assert: 3, match: 4 } as const;

/** One step of the matcher; `x` and `y` are program addresses (a jump uses `x`, a split both). */
export type Instruction = {
  op: number;
  x: number;
  y: number;
  ranges: Ranges;
  type: AssertKind;
};

export type Program = { code: readonly Instruction[] };

const NO_RANGES: Ranges = [];

const push = (code: Instruction[], partial: Partial<Instruction> & { op: number }): number => {
  if (code.length >= MAX_REGEX_PROGRAM_SIZE) {
    throw new RegexError(`pattern needs more than ${MAX_REGEX_PROGRAM_SIZE} instructions`);
  }
  code.push({ x: 0, y: 0, ranges: NO_RANGES, type: "start", ...partial });
  return code.length - 1;
};

const emit = (code: Instruction[], node: Node): void => {
  if (node.kind === "set") {
    push(code, { op: OP.set, ranges: node.ranges });
  } else if (node.kind === "assert") {
    push(code, { op: OP.assert, type: node.type });
  } else if (node.kind === "cat") {
    for (const item of node.items) emit(code, item);
  } else if (node.kind === "alt") {
    emitAlternation(code, node.branches);
  } else {
    emitRepeat(code, node);
  }
};

const emitAlternation = (code: Instruction[], branches: readonly Node[]): void => {
  const exits: number[] = [];
  branches.forEach((branch, index) => {
    if (index === branches.length - 1) {
      emit(code, branch);
      return;
    }
    const split = push(code, { op: OP.split });
    (code[split] as Instruction).x = code.length;
    emit(code, branch);
    exits.push(push(code, { op: OP.jump }));
    (code[split] as Instruction).y = code.length;
  });
  for (const exit of exits) (code[exit] as Instruction).x = code.length;
};

/** `body{min,max}`: `min` copies, then a loop (unbounded) or `max - min` nested optional copies. */
const emitRepeat = (
  code: Instruction[],
  { min, max, body }: Extract<Node, { kind: "repeat" }>,
): void => {
  const unbounded = max === Number.POSITIVE_INFINITY;
  const mandatory = unbounded && min > 0 ? min - 1 : min;
  for (let copy = 0; copy < mandatory; copy += 1) {
    const before = code.length;
    emit(code, body);
    if (code.length === before) break;
  }
  if (unbounded) {
    const start = code.length;
    if (min > 0) {
      emit(code, body);
      const back = push(code, { op: OP.split, x: start });
      (code[back] as Instruction).y = code.length;
      return;
    }
    const split = push(code, { op: OP.split });
    (code[split] as Instruction).x = code.length;
    emit(code, body);
    push(code, { op: OP.jump, x: start });
    (code[split] as Instruction).y = code.length;
    return;
  }
  const splits: number[] = [];
  for (let copy = min; copy < max; copy += 1) {
    const split = push(code, { op: OP.split });
    (code[split] as Instruction).x = code.length;
    splits.push(split);
    emit(code, body);
  }
  for (const split of splits) (code[split] as Instruction).y = code.length;
};

/** The program for a syntax tree; throws `RegexError` once it grows past `MAX_REGEX_PROGRAM_SIZE`. */
export const compileRegex = (tree: Node): Program => {
  const code: Instruction[] = [];
  emit(code, tree);
  push(code, { op: OP.match });
  return { code };
};

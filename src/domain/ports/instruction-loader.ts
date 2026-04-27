import type { InstructionDefinition } from "../instruction.js";

export interface InstructionLoader {
  loadById(instructionId: string): Promise<InstructionDefinition>;
}

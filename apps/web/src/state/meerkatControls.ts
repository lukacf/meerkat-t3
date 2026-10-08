import { createMeerkatControlAtoms } from "@t3tools/client-runtime/state/meerkatControls";
import { connectionAtomRuntime } from "../connection/runtime";
export const meerkatControlsEnvironment = createMeerkatControlAtoms(connectionAtomRuntime);

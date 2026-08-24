import { z } from "zod";
import { isTargetId } from "./current-target";

export function targetIdParam() {
  return z.preprocess((raw) => {
    const value: unknown = Array.isArray(raw) ? raw[0] : undefined;
    return isTargetId(value) ? value : undefined;
  }, z.string().optional());
}

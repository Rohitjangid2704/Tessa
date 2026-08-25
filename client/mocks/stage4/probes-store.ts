import type { Probe } from "@/lib/api/types";
import { buildProbeBank } from "../fixtures/probe-bank";

export class ProbesStore {
  probes: Probe[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    this.probes = buildProbeBank();
  }
}

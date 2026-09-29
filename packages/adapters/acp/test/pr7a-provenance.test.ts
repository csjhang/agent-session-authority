import { describe, expect, it } from "vitest";
import { acp_events_to_history, MockAcpPeer } from "../src/index.js";

describe("ACP history: adapter-assigned generation is marked derived", () => {
  it("the header generation.observe marks runtime_generation as derived (the adapter assigns it)", () => {
    const history = acp_events_to_history(new MockAcpPeer().run_fixture_scenario(), { issuer_id: "acp_adapter_live" });
    const header = history[0]!;
    expect(header.op).toBe("generation.observe");
    expect(header.attrs?.field_provenance).toMatchObject({ runtime_generation: "derived" });
  });
});

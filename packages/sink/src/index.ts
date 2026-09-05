/** Week-1 stub — full mock effect sink arrives in week 2. */
export interface SinkStub {
  readonly name: "effect_sink_stub";
  accept(_effect_id: string, _action_digest: string): { accepted: false; reason: string };
}

export function create_sink_stub(): SinkStub {
  return {
    name: "effect_sink_stub",
    accept() {
      return { accepted: false, reason: "sink stub: not implemented in week 1" };
    },
  };
}

/** Week-1 stub adapter for acp. No live target SDK dependency. */
export interface AdapterStub {
  readonly target: "acp";
  readonly status: "stub";
  collect_history(): never;
}

export function create_adapter(): AdapterStub {
  return {
    target: "acp",
    status: "stub",
    collect_history() {
      throw new Error("acp adapter stub: not implemented in week 1");
    },
  };
}

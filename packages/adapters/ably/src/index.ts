/** Week-1 stub adapter for ably. No live target SDK dependency. */
export interface AdapterStub {
  readonly target: "ably";
  readonly status: "stub";
  collect_history(): never;
}

export function create_adapter(): AdapterStub {
  return {
    target: "ably",
    status: "stub",
    collect_history() {
      throw new Error("ably adapter stub: not implemented in week 1");
    },
  };
}

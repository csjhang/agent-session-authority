/** Week-1 stub adapter for ahp. No live target SDK dependency. */
export interface AdapterStub {
  readonly target: "ahp";
  readonly status: "stub";
  collect_history(): never;
}

export function create_adapter(): AdapterStub {
  return {
    target: "ahp",
    status: "stub",
    collect_history() {
      throw new Error("ahp adapter stub: not implemented in week 1");
    },
  };
}

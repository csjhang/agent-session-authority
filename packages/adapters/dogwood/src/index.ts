/** Week-1 stub adapter for dogwood. No live target SDK dependency. */
export interface AdapterStub {
  readonly target: "dogwood";
  readonly status: "stub";
  collect_history(): never;
}

export function create_adapter(): AdapterStub {
  return {
    target: "dogwood",
    status: "stub",
    collect_history() {
      throw new Error("dogwood adapter stub: not implemented in week 1");
    },
  };
}

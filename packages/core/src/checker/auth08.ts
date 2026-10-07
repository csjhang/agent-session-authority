/** AUTH-08 public surface — correlate + decide (PR-11d hygiene split). */
export {
  AUTH08_NT_SETUP,
  classify_bypass_attempt,
  classify_committed_receipt,
  count_asked,
  count_never_asked,
  count_unmappable,
  examine_committed_receipts,
  type ExaminedReceipt,
  type ReceiptAskClass,
} from "./auth08_correlate.js";
export { check_auth08 } from "./auth08_decide.js";

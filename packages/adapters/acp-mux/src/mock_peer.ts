/** Mock acp-mux peer — observation attach + pending permission re-issue (RFD #533). */
export type AcpMuxPeerEvent =
 | {type:"session_new";sessionId:string;primaryClientId:string}
 | {type:"permission_request";sessionId:string;requestId:string;toolName:string;input:Record<string,unknown>;pending:true}
 | {type:"observer_attach";sessionId:string;observerClientId:string;historyPolicy:"full"|"pending_only"|"none"}
 | {type:"pending_permission_reissue";sessionId:string;requestId:string;observerClientId:string;note:string}
 | {type:"permission_response";sessionId:string;requestId:string;decision:"allow"|"deny";responderClientId:string;firstWins:boolean}
 | {type:"permission_resolved";sessionId:string;requestId:string;toClientId:string}
 | {type:"session_detach";sessionId:string;clientId:string}
 | {type:"session_closed";sessionId:string;reason?:string};
export interface MockAcpMuxPeerOptions{sessionId?:string}
export class MockAcpMuxPeer{readonly sessionId:string;private readonly events:AcpMuxPeerEvent[]=[];constructor(o:MockAcpMuxPeerOptions={}){this.sessionId=o.sessionId??"acp-mux-fixture-session-1";}run_fixture_scenario():AcpMuxPeerEvent[]{const p="client-primary",o="client-observer",r="perm-pending-1";this.push({type:"session_new",sessionId:this.sessionId,primaryClientId:p});this.push({type:"permission_request",sessionId:this.sessionId,requestId:r,toolName:"Write",input:{path:"repo/mux.ts",content:"attach"},pending:true});this.push({type:"observer_attach",sessionId:this.sessionId,observerClientId:o,historyPolicy:"pending_only"});this.push({type:"pending_permission_reissue",sessionId:this.sessionId,requestId:r,observerClientId:o,note:"RFD #533 / acp-mux: re-issue pending permissions on observation attach; no fencing/lease/digest/generation"});this.push({type:"permission_response",sessionId:this.sessionId,requestId:r,decision:"allow",responderClientId:o,firstWins:true});this.push({type:"permission_resolved",sessionId:this.sessionId,requestId:r,toClientId:p});this.push({type:"session_detach",sessionId:this.sessionId,clientId:o});this.push({type:"session_closed",sessionId:this.sessionId,reason:"fixture_done"});return[...this.events];}private push(e:AcpMuxPeerEvent){this.events.push(e)}get_events(){return this.events;}}

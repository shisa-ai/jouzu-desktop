import { describe, it, expect } from "vitest";
import { artifactPolicyFor, artifactPreset, catalogChangeSummary, parseControlState } from "./control-state";
const valid = {schemaVersion:1,profile:null,account:{signedIn:false},credentials:[],customProviders:[],providers:[]};
describe("configuration response boundary", () => {
 it("accepts a sign-out advisory and rejects unknown revocation values", () => {
   expect(parseControlState({...valid,account:{signedIn:false,revocation:"unconfirmed"}}).account.revocation).toBe("unconfirmed");
   expect(()=>parseControlState({...valid,account:{signedIn:false,revocation:"maybe"}})).toThrow();
   expect(parseControlState({...valid,account:{signedIn:true,providers:["shisa","catalog:a:b:c"]}}).account.providers).toEqual(["shisa","catalog:a:b:c"]);
   expect(()=>parseControlState({...valid,account:{signedIn:true,providers:[1]}})).toThrow();
 });
 it("accepts complete empty state", () => expect(parseControlState(valid).customProviders).toEqual([]));
 it("carries provider auth capabilities without rejecting older rows", () => {
   const state = {...valid,providers:[{id:"openai-codex",name:"OpenAI Codex",oauth:true,oauthName:"OpenAI (ChatGPT Plus/Pro)",apiKey:false}]};
   expect(parseControlState(state).providers[0].oauth).toBe(true);
   expect(parseControlState({...valid,providers:[{id:"openai",name:"OpenAI"}]}).providers[0].oauth).toBeUndefined();
   expect(()=>parseControlState({...state,providers:[{id:"x",name:"X",oauth:"yes"}]})).toThrow();
 });
 it("rejects the old response that crashed connection rendering", () => {
   const {customProviders, ...old} = valid;
   expect(() => parseControlState(old)).toThrow("incompatible");
 });
 it("rejects missing arrays, malformed rows and invalid versions", () => {
   for (const key of ["credentials","providers","customProviders"]) {
     expect(() => parseControlState({...valid,[key]:undefined})).toThrow();
     expect(() => parseControlState({...valid,[key]:[null]})).toThrow();
   }
   expect(() => parseControlState({...valid,schemaVersion:2})).toThrow();
   expect(() => parseControlState({...valid,providers:[{id:"",name:"bad"}]})).toThrow();
 });
 it("summarizes a held revision from the runtime's own counts only", () => {
   expect(catalogChangeSummary({ activeCount: 12, candidateCount: 0, added: 0, removed: 12 })).toBe("This revision has 0 models; 12 in use now. 12 removed");
   expect(catalogChangeSummary({ activeCount: 1, candidateCount: 2, added: 1, removed: 0 })).toBe("This revision has 2 models; 1 in use now. 1 added");
   expect(catalogChangeSummary(undefined)).toBe("");
   expect(catalogChangeSummary({ activeCount: "12" })).toBe("");
 });
 it("carries Jouzu's language settings and rejects malformed ones", () => {
   const policy = {comments:"preserve",documentation:"project",commits:"project",reviews:"project"};
   const language = {status:"ok",uiLocale:{requested:"ja",effective:"ja",source:"config"},responseLanguage:{requested:"zh-Hans",effective:"zh-Hans",source:"config"},artifactPolicy:{requested:{},effective:policy,source:"builtin"}};
   expect(parseControlState({...valid,language}).language?.responseLanguage.effective).toBe("zh-Hans");
   expect(parseControlState(valid).language).toBeUndefined();
   expect(()=>parseControlState({...valid,language:{...language,uiLocale:null}})).toThrow();
   expect(()=>parseControlState({...valid,language:{...language,artifactPolicy:{source:"config",effective:{...policy,commits:"fr"}}}})).toThrow();
 });
});
describe("artifact language presets", () => {
 it("match Jouzu's Settings presets and never collapse a custom mix", () => {
   expect(artifactPreset(artifactPolicyFor("default"))).toBe("default");
   expect(artifactPreset(artifactPolicyFor("ja"))).toBe("ja");
   expect(artifactPolicyFor("en")).toEqual({comments:"en",documentation:"en",commits:"en",reviews:"en"});
   expect(artifactPreset({comments:"en",documentation:"project",commits:"ja",reviews:"project"})).toBe("custom");
 });
});

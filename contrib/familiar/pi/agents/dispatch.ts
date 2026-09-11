export const dispatchDescription="Dispatch using a harness and model advertised by golemd capabilities. Select exactly one workspace variant: {project} for an advertised project or {repo, ref?} for a repository clone.";
export const dispatchWorkspaceDescription="Exactly one workspace variant: project name, or repository clone source with an optional ref.";
export const dispatchRefDescription="Optional git ref for repo workspaces only.";

export function buildDispatchParameters(Type:any){return Type.Object({
 prompt:Type.String(),
 harness:Type.String(),
 model:Type.String(),
 worktree:Type.String(),
 workspace:Type.Union([
  Type.Object({project:Type.String({minLength:1})},{additionalProperties:false}),
  Type.Object({
   repo:Type.String({minLength:1}),
   ref:Type.Optional(Type.String({minLength:1,description:dispatchRefDescription})),
  },{additionalProperties:false}),
 ],{description:dispatchWorkspaceDescription}),
 key:Type.Optional(Type.String()),
},{additionalProperties:false})}

type WorkspaceSelector=
 |{project:string}
 |{repo:string;ref?:string|null};
export function dispatchWorkspace(selector:WorkspaceSelector,worktree:string){
 if("project" in selector){
  if(!selector.project)throw new Error("project must be a non-empty string");
  return{project:selector.project,worktree};
 }
 if(!selector.repo)throw new Error("repo must be a non-empty string");
 return{repo:selector.repo,...(selector.ref===undefined||selector.ref===null?{}:{ref:selector.ref}),worktree};
}

// Stored calls from pre-union sessions are prepared before validation. This is
// compatibility for resumed history, not part of the public schema.
export function prepareDispatchArguments(p:any){
 if(p?.workspace!==undefined||!p||typeof p!=="object")return p;
 const hasProject=p.project!==undefined&&p.project!==null;
 const hasRepo=p.repo!==undefined&&p.repo!==null;
 if(hasProject===hasRepo||(hasProject&&p.ref!==undefined&&p.ref!==null))return p;
 const {project,repo,ref,...rest}=p;
 return{
  ...rest,
  workspace:hasProject
   ?{project}
   :{repo,...(ref===undefined||ref===null?{}:{ref})},
 };
}

export const dispatchDescription="Dispatch using a harness and model advertised by golemd capabilities. Select exactly one workspace: provide project and omit repo, or provide repo and omit project. Never send both fields or placeholders/empty strings. ref is only for repo workspaces.";
export const dispatchProjectDescription="Existing project name advertised by agents_capabilities. Use project or repo, never both. Omit project entirely when using repo; do not send an empty string.";
export const dispatchRepoDescription="Repository clone source. Use repo or project, never both. Omit repo entirely when using project; do not send an empty string.";
export const dispatchRefDescription="Optional git ref for a repo workspace only; omit it when using project.";

// Keep the public schema flat: Pi documents Type.Union/Type.Literal as
// incompatible with Google's tool API. Runtime validation below owns the XOR.
export function buildDispatchParameters(Type:any){return Type.Object({
 prompt:Type.String(),
 harness:Type.String(),
 model:Type.String(),
 worktree:Type.String(),
 project:Type.Optional(Type.String({minLength:1,description:dispatchProjectDescription})),
 repo:Type.Optional(Type.String({minLength:1,description:dispatchRepoDescription})),
 ref:Type.Optional(Type.String({description:dispatchRefDescription})),
 key:Type.Optional(Type.String()),
})}

type DispatchWorkspaceArgs={project?:string;repo?:string;ref?:string;worktree:string};
export function dispatchWorkspace(p:DispatchWorkspaceArgs){
 const hasProject=p.project!==undefined;
 const hasRepo=p.repo!==undefined;
 if(hasProject===hasRepo)throw new Error("provide exactly one of project or repo; omit the other field entirely");
 if(hasProject){if(!p.project)throw new Error("project must be a non-empty string");return{project:p.project,worktree:p.worktree}}
 if(!p.repo)throw new Error("repo must be a non-empty string");
 return{repo:p.repo,ref:p.ref,worktree:p.worktree};
}

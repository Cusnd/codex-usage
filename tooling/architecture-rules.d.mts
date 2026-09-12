export type ModuleBoundary = {id:string;runtime:string;paths:string[];dependencies:string[];public:string[]};
export function moduleOwner(modules:ModuleBoundary[],file:string):ModuleBoundary|undefined;
export function dependencyViolations(modules:ModuleBoundary[],edge:{from:string;to:string;line:number;typeOnly?:boolean}):string[];
export function ignoredSourceFiles(root:string,files:string[]):string[];

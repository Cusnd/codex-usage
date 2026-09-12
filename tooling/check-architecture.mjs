import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { moduleOwner, dependencyViolations, ignoredSourceFiles } from './architecture-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = relative => fs.readdirSync(path.join(root, relative), {withFileTypes:true})
  .flatMap(entry => entry.isDirectory() ? walk(relative+'/'+entry.name) : [relative+'/'+entry.name]);
const files = ['apps','modules'].flatMap(walk).filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'));
const edges = [], unresolved = [], modeReferences = [], externalImports = [];
for (const file of files) {
  const body=fs.readFileSync(path.join(root,file),'utf8'), source=ts.createSourceFile(file,body,ts.ScriptTarget.Latest,true);
  if (file.startsWith('modules/web/') && /import\.meta\.env|\b(?:cloudMode|exampleMode|installCloudDataSource|setCloudClock)\b/.test(body)) modeReferences.push(file);
  const visit = node => {
    let specifier, typeOnly=false;
    if ((ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier=node.moduleSpecifier.text;
      if (ts.isImportDeclaration(node)) {
        const c=node.importClause,b=c?.namedBindings;
        typeOnly=!!c?.isTypeOnly||!!(c&&!c.name&&b&&ts.isNamedImports(b)&&b.elements.length&&b.elements.every(x=>x.isTypeOnly));
      } else typeOnly=!!node.isTypeOnly||!!(node.exportClause&&ts.isNamedExports(node.exportClause)&&node.exportClause.elements.length&&node.exportClause.elements.every(x=>x.isTypeOnly));
    } else if (ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])) specifier=node.arguments[0].text;
    else if (ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal)) {specifier=node.argument.literal.text;typeOnly=true;}
    if(specifier && !specifier.startsWith('.')) externalImports.push({file,specifier,typeOnly});
    if(specifier?.startsWith('.')) {
      const base=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
      const target=[base,base.replace(/\.js$/,'.ts'),base.replace(/\.js$/,'.tsx'),base+'.ts',base+'.tsx',base+'/index.ts'].find(x=>fs.existsSync(path.join(root,x)));
      if (!target) unresolved.push({file,specifier});
      else if(files.includes(target))edges.push({from:file,to:target,typeOnly,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1});
    }
    ts.forEachChild(node,visit);
  };visit(source);
}
function cycles(includeTypes, nodes=files, dependencies=edges) {
  const graph=new Map(nodes.map(f=>[f,dependencies.filter(e=>e.from===f&&(includeTypes||!e.typeOnly)).map(e=>e.to)]));
  let seq=0;const stack=[],active=new Set(),indices=new Map(),low=new Map(),found=[];
  function visit(f){indices.set(f,seq);low.set(f,seq++);stack.push(f);active.add(f);
    for(const next of graph.get(f)){if(!indices.has(next)){visit(next);low.set(f,Math.min(low.get(f),low.get(next)));}else if(active.has(next))low.set(f,Math.min(low.get(f),indices.get(next)));}
    if(low.get(f)===indices.get(f)){const component=[];let item;do{item=stack.pop();active.delete(item);component.push(item);}while(item!==f);if(component.length>1)found.push(component);}
  }for(const f of nodes)if(!indices.has(f))visit(f);return found;
}
const violations=ignoredSourceFiles(root,files).map(file=>`${file}: production source matches Git ignore rules`), moduleCycles=[];
const manifestFile=path.join(root,'modules.json');
if(fs.existsSync(manifestFile)) {
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const owner=f=>moduleOwner(manifest.modules,f);
  // Different files can create a circular module dependency without forming a file cycle.
  moduleCycles.push(...cycles(true,manifest.modules.map(m=>m.id),edges
    .map(e=>({from:owner(e.from)?.id,to:owner(e.to)?.id}))
    .filter(e=>e.from&&e.to&&e.from!==e.to)));
  for(const file of files)if(!owner(file))violations.push(`Unowned source: ${file}`);
  for(const edge of edges)violations.push(...dependencyViolations(manifest.modules,edge));
  for(const {file,specifier} of externalImports){const module=owner(file);
    if(module?.runtime!=='node'&&(specifier.startsWith('node:')||builtinModules.includes(specifier)))violations.push(`${file}: Node builtin ${specifier} in ${module?.runtime}`);
    if(file.startsWith('modules/sync/browser/')&&/^(react|react-dom|react-router-dom|@tanstack\/)/.test(specifier))violations.push(`${file}: synchronization cannot depend on a UI framework`);
  }
  for(const module of manifest.modules)for(const entry of module.public)if(!files.includes(entry)||owner(entry)?.id!==module.id)violations.push(`${module.id}: invalid public entry ${entry}`);
} else violations.push('Missing modules.json ownership manifest');
const report={files:files.length,lines:files.reduce((sum,f)=>sum+fs.readFileSync(path.join(root,f),'utf8').split('\n').length,0),runtimeCycles:cycles(false),typeInclusiveCycles:cycles(true),moduleCycles,modeReferences,unresolved,violations,edges};
const out=process.argv.indexOf('--json');if(out!==-1)fs.writeFileSync(process.argv[out+1],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,edges:undefined},null,2));
if(report.runtimeCycles.length||report.typeInclusiveCycles.length||moduleCycles.length||modeReferences.length||unresolved.length||violations.length)process.exitCode=1;

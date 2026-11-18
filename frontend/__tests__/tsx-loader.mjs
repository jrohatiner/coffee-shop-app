import fs from 'node:fs'
import Module, { registerHooks } from 'node:module'
import ts from 'typescript'

function compileTs(filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  })
  return outputText
}

for (const ext of ['.ts', '.tsx']) {
  Module._extensions[ext] = function (mod, filename) {
    mod._compile(compileTs(filename), filename)
  }
}

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') || url.endsWith('.tsx')) {
      return {
        format: 'commonjs',
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

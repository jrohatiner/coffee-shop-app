const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const compileTs = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  })
  mod._compile(outputText, filename)
}

const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if ((request.startsWith('./') || request.startsWith('../')) && parent?.filename) {
    const baseDir = path.dirname(parent.filename)
    const candidateBase = path.resolve(baseDir, request)
    for (const ext of ['.ts', '.tsx']) {
      if (fs.existsSync(candidateBase + ext)) {
        return candidateBase + ext
      }
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

Module._extensions['.ts'] = compileTs
Module._extensions['.tsx'] = compileTs

const testsDir = path.resolve(__dirname, '..', '__tests__')
const testFiles = fs
  .readdirSync(testsDir)
  .filter((file) => file.endsWith('.test.ts') || file.endsWith('.test.tsx'))
  .sort()
  .map((file) => path.join(testsDir, file))
  .filter((fullPath) => fs.readFileSync(fullPath, 'utf8').includes('node:test'))

for (const file of testFiles) {
  require(file)
}

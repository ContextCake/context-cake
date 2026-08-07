// Module resolve hook: answers `electron` with the stub above. Registered by a
// test before it imports any main-process module.
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') {
    return { url: process.env.CC_TEST_ELECTRON_STUB, shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}

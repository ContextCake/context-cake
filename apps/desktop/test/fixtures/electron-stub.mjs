// Stands in for the `electron` module so main-process helpers that only need
// `app.getPath('userData')` can be exercised under plain `node --test`.
export const app = {
  getPath: () => process.env.CC_TEST_USER_DATA,
  isPackaged: false,
}
export default { app }

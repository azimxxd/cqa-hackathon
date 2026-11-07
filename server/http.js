export const fail = (status, message) =>
  Object.assign(new Error(message), { status });
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
export function positiveId(value, name = "id") {
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw fail(400, `Invalid ${name}`);
  return Number(value);
}

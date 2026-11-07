// Thin Dynamics 365 adapter: when hosted as a web resource, read context from parent.Xrm.
// Outside Dynamics everything here is a no-op.
export function getXrm() {
  try {
    return window.Xrm || window.parent?.Xrm || null;
  } catch {
    return null;
  }
}

export function isInDynamics() {
  return getXrm() !== null;
}
